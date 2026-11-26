/**
 * wb-bridge 单元测试（node:test，无网络依赖）。
 * 覆盖：AtRest 信封加解密（roundtrip）、密钥派生、域名→网关、请求归一化、
 *       客户端定位、登录文件定位、目录过滤。
 * 真机集成用例（有登录文件 + 客户端时才跑）放在文件末尾。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  channelFallbackCandidates,
  clientExeCandidates,
  deriveAtRestKey,
  deriveAtRestKeyId,
  envelopeKeyId,
  findClientExe,
  isChannelRejection,
  normalizePayload,
  openEncryptedField,
  resolveAuthPath,
  sanitizeText,
  shapeCatalog,
  upstreamForDomain,
} from '../plugin/bridge/wb-bridge.mjs';

// ── AtRest 信封 ────────────────────────────────────────────────────────

/** 测试侧的同款信封封装（验证桥的 AAD 转录与客户端一致）。 */
function sealField(plain, key, { suite = 1 } = {}) {
  const keyId = deriveAtRestKeyId(key);
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    (() => { const b = Buffer.from('WBEV1', 'utf8'); const p = Buffer.alloc(4); p.writeUInt32BE(b.length); return Buffer.concat([p, b]); })(),
    (() => { const b = Buffer.from('sym-v1', 'utf8'); const p = Buffer.alloc(4); p.writeUInt32BE(b.length); return Buffer.concat([p, b]); })(),
    (() => { const p = Buffer.alloc(4); p.writeUInt32BE(suite); return p; })(),
    (() => { const b = Buffer.from(keyId, 'utf8'); const p = Buffer.alloc(4); p.writeUInt32BE(b.length); return Buffer.concat([p, b]); })(),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
  return { $wbEncrypted: 1, envelope: Buffer.from(envelope, 'utf8').toString('base64') };
}

test('deriveAtRestKey: SHA256(base64 字符串本身)', () => {
  // 测试用假密钥（形状与真实载荷一致即可，绝不使用真实 atRestSecretKey）
  const secret = 'TESTtestTESTtestTESTtestTESTtestTESTtestTESTtest=';
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: secret }));
  assert.equal(key.length, 32);
  assert.deepEqual(key, createHash('sha256').update(secret, 'utf8').digest());
});

test('deriveAtRestKey: 载荷缺少 atRestSecretKey 时报错', () => {
  assert.throws(() => deriveAtRestKey(JSON.stringify({ version: 1 })), /atRestSecretKey/);
});

test('deriveAtRestKeyId: SHA256(key).hex 前 16 位', () => {
  const key = createHash('sha256').update('x').digest();
  assert.equal(deriveAtRestKeyId(key), createHash('sha256').update(key).digest('hex').slice(0, 16));
});

test('openEncryptedField: roundtrip（中文 + 长 JWT 形状）', () => {
  const key = createHash('sha256').update('secret-key').digest();
  const plain = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1Njc4OTAifQ.测试用户.13800000000';
  const field = sealField(plain, key);
  assert.equal(openEncryptedField(field, key), plain);
  // keyId 与信封对得上
  assert.equal(envelopeKeyId(field), deriveAtRestKeyId(key));
});

test('openEncryptedField: 用错钥匙报「信封属于另一把钥」', () => {
  const key = createHash('sha256').update('a').digest();
  const other = createHash('sha256').update('b').digest();
  const field = sealField('token', key);
  assert.throws(() => openEncryptedField(field, other), /belongs to key/);
});

test('openEncryptedField: 篡改一个密文字节 → tag 校验失败', () => {
  const key = createHash('sha256').update('a').digest();
  const field = sealField('token', key);
  const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  envelope.ciphertext = bytes.toString('base64');
  const tampered = { ...field, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') };
  assert.throws(() => openEncryptedField(tampered, key));
});

test('envelopeKeyId: 非信封返回空串', () => {
  assert.equal(envelopeKeyId({ $wbEncrypted: 1 }), '');
  assert.equal(envelopeKeyId(undefined), '');
});

// ── 域名 → 网关 ────────────────────────────────────────────────────────

test('upstreamForDomain: 国内/国际映射（选错直接 401）', () => {
  assert.equal(upstreamForDomain('www.workbuddy.cn'), 'https://copilot.tencent.com');
  assert.equal(upstreamForDomain('www.codebuddy.cn'), 'https://copilot.tencent.com');
  assert.equal(upstreamForDomain('www.workbuddy.ai'), 'https://www.workbuddy.ai');
  assert.equal(upstreamForDomain('workbuddy.cc'), 'https://www.workbuddy.ai');
  assert.equal(upstreamForDomain('www.codebuddy.ai'), 'https://www.workbuddy.ai');
  assert.equal(upstreamForDomain(''), 'https://copilot.tencent.com');
});

// ── 请求归一化（上游比 OpenAI 规范更严） ──────────────────────────────

test('normalizePayload: developer → system', () => {
  const out = normalizePayload({
    messages: [{ role: 'developer', content: 'be terse' }, { role: 'user', content: 'hi' }],
  });
  assert.equal(out.messages[0].role, 'system');
});

test('normalizePayload: 强制 stream:true（上游只接受流式）', () => {
  assert.equal(normalizePayload({ messages: [], stream: false }).stream, true);
  assert.equal(normalizePayload({ messages: [] }).stream, true);
});

test('normalizePayload: tool_choice 对象 → 字符串', () => {
  const required = normalizePayload({
    messages: [], tool_choice: { type: 'function', function: { name: 'x' } },
  });
  assert.equal(required.tool_choice, 'required');
  const other = normalizePayload({ messages: [], tool_choice: { type: 'weird' } });
  assert.equal(other.tool_choice, 'auto');
  const str = normalizePayload({ messages: [], tool_choice: 'auto' });
  assert.equal(str.tool_choice, 'auto');
});

test('normalizePayload: 首条非 system 时补中性 system（国际版强制）', () => {
  const out = normalizePayload({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages.length, 2);
  const kept = normalizePayload({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] });
  assert.equal(kept.messages.length, 2);
  assert.equal(kept.messages[0].content, 's');
});

// ── 定位 ──────────────────────────────────────────────────────────────

test('clientExeCandidates: 含静态候选（macOS）', () => {
  const list = clientExeCandidates();
  assert.ok(list.length > 0);
  assert.ok(list.every((p) => typeof p === 'string' && p.length > 0));
  if (process.platform === 'darwin') {
    assert.ok(list.some((p) => p.includes('/Applications/WorkBuddy.app/Contents/MacOS/')));
  }
});

test('resolveAuthPath: env 覆盖优先', () => {
  const prev = process.env.WORKBUDDY_AUTH_FILE;
  process.env.WORKBUDDY_AUTH_FILE = '/tmp/fake-workbuddy.info';
  try {
    assert.equal(resolveAuthPath(), '/tmp/fake-workbuddy.info');
  } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_AUTH_FILE;
    else process.env.WORKBUDDY_AUTH_FILE = prev;
  }
});

test('resolveAuthPath: 无 env 时给出本机真实路径或空串（都不报错）', () => {
  const prev = process.env.WORKBUDDY_AUTH_FILE;
  delete process.env.WORKBUDDY_AUTH_FILE;
  try {
    const p = resolveAuthPath();
    assert.ok(typeof p === 'string');
  } finally {
    if (prev !== undefined) process.env.WORKBUDDY_AUTH_FILE = prev;
  }
});

// ── 11128 通道指纹防御 ─────────────────────────────────────────────────

test('sanitizeText: dsh 身份句被中和（根因：上游 400 code 11128）', () => {
  // 本机实测：system 含此句 → 400 11128；换成中性表述后同 messages/tools 全 200
  const out = sanitizeText("You are an AI agent powered by DeepSeek Harness. Be concise.");
  assert.ok(!/powered by DeepSeek\s+Harness/i.test(out), '身份句必须被中和');
  assert.match(out, /running inside the user's development environment/);
  assert.match(out, /Be concise/, '其余指令保留');
});

test('sanitizeText: 带版本后缀的身份句也中和', () => {
  const out = sanitizeText('You are an AI agent powered by DeepSeek Harness v0.2.2-rc.5.');
  assert.ok(!/powered by DeepSeek/i.test(out));
});

test('sanitizeText: 模型自述句与 system 品牌词', () => {
  assert.match(
    sanitizeText('You are a coding agent powered by the cn-deepseek-v4.1-flash-0.11x model.'),
    /running in the user's development environment/,
  );
  // system 里其余行的品牌词 → 中性称呼（不删行，保留该行指令）。
  // 注意：中性词自带 "the"，原句 "names the DeepSeek Harness" 会变成
  // "names the the local runtime"——读着别扭但语义无损，且只影响发给模型的
  // 系统提示（用户在界面上看到的回答不含它）。参考项目同款取舍。
  const branded = sanitizeText('Be terse.\nThe runtime context names the DeepSeek Harness implementation checkout.');
  assert.ok(!/DeepSeek\s+Harness/i.test(branded));
  assert.match(branded, /The runtime context names the the local runtime implementation checkout\./);
  assert.match(branded, /^Be terse\./, '其余行原样保留');
});

test('sanitizeText: assistant 作用域只洗身份模板，不碰普通正文', () => {
  // assistant 正文可能是用户正在看的回答：品牌词不替换，只洗两句精确模板
  const out = sanitizeText(
    '我刚才查了 DeepSeek Harness 的文档。\nYou are an AI agent powered by DeepSeek Harness.',
    'assistant',
  );
  assert.match(out, /我刚才查了 DeepSeek Harness 的文档/, 'assistant 普通正文里的品牌词不动');
  assert.ok(!/powered by DeepSeek/i.test(out), 'assistant 里的身份模板句仍要洗');
});

test('sanitizeText: 无命中返回原值', () => {
  const text = 'You are a helpful assistant.';
  assert.equal(sanitizeText(text), text);
  assert.equal(sanitizeText('', 'system'), '');
  assert.equal(sanitizeText(undefined), undefined);
  // 非字符串（图片段数组等）原样返回
  const arr = [{ type: 'text', text: 'x' }];
  assert.equal(sanitizeText(arr), arr);
});

test('normalizePayload: system 与 assistant 历史都过中和', () => {
  const payload = normalizePayload({
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'You are an AI agent powered by DeepSeek Harness.' },
    ],
  });
  assert.ok(!/powered by DeepSeek/i.test(payload.messages[0].content));
  assert.ok(!/powered by DeepSeek/i.test(payload.messages[2].content));
  // user 内容永不动
  assert.equal(payload.messages[1].content, 'hi');
});

test('isChannelRejection: 识别 11128 响应体', () => {
  assert.ok(isChannelRejection('{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}'));
  assert.ok(isChannelRejection('code 11128 first message is not system'));
  assert.ok(!isChannelRejection('{"code":11133,"msg":"model_param_invalid"}'));
  assert.ok(!isChannelRejection(''));
});

test('channelFallbackCandidates: 渐进顺序 + 不动 user/tools', () => {
  const payload = {
    model: 'm',
    tools: [{ type: 'function', function: { name: 'bash' } }],
    messages: [
      { role: 'system', content: '身份段一。\n\nThe DeepSeek Harness runtime rules here.' },
      { role: 'user', content: '帮我看看 DeepSeek Harness 怎么装' },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  };
  const candidates = channelFallbackCandidates(payload);
  const strategies = candidates.map((c) => c.strategy);
  // 删品牌行（system 第二段含品牌）→ 删首段 → 中性 system
  assert.deepEqual(strategies, ['remove-brand-lines', 'drop-first-system-paragraph', 'neutral-system']);
  for (const c of candidates) {
    // user / tool 永远不动
    assert.equal(c.payload.messages.find((m) => m.role === 'user').content, '帮我看看 DeepSeek Harness 怎么装');
    assert.ok(c.payload.messages.some((m) => m.role === 'tool'));
    // tools 不动
    assert.deepEqual(c.payload.tools, payload.tools);
  }
  // 最后一级把 system 整段换成中性
  const neutral = candidates.at(-1);
  assert.equal(neutral.payload.messages[0].content, 'You are a helpful AI assistant.');
  assert.equal(neutral.payload.messages.length, 3);
});

test('channelFallbackCandidates: 无 system / 无命中时不给候选（中性兜底除外）', () => {
  assert.deepEqual(channelFallbackCandidates({ messages: [{ role: 'user', content: 'hi' }] }), []);
  // 干净的单段 system：只有最后的中性兜底
  const clean = channelFallbackCandidates({ messages: [{ role: 'system', content: 'Be terse.' }] });
  assert.deepEqual(clean.map((c) => c.strategy), ['neutral-system']);
  assert.deepEqual(channelFallbackCandidates({}), []);
  assert.deepEqual(channelFallbackCandidates(null), []);
});

test('shapeCatalog: v3 的驼峰容量字段必须被映射（下划线写法全是 0）', () => {
  // 真实事故：v3 用 maxInputTokens/maxOutputTokens（驼峰），只认下划线会把
  // 容量映射成 0，dsh 侧表现为「no context capacity」拒绝切模型。
  const [m] = shapeCatalog({
    data: {
      models: [{
        id: 'hy4flash-free',
        name: 'Hy4 flash',
        maxInputTokens: 960000,
        maxOutputTokens: 64000,
        supportsImages: true,
        supportsReasoning: true,
        credits: 'x0.00 credits',
        descriptionZh: '更轻量的日常主力模型',
        temperature: 0.9,
        reasoning: { supportedEfforts: ['high'], defaultEffort: 'high' },
      }],
    },
  }, null);
  assert.equal(m.context_window, 960000);
  assert.equal(m.max_output_tokens, 64000);
  assert.equal(m.supports_images, true);
  assert.equal(m.supports_reasoning, true);
  assert.equal(m.credits, 'x0.00 credits');
  assert.equal(m.description_zh, '更轻量的日常主力模型');
  assert.deepEqual(m.reasoning_efforts, ['high']);
  assert.equal(m.default_reasoning_effort, 'high');
  assert.equal(m.default_temperature, 0.9);
  assert.equal(m.official, true);
});

test('shapeCatalog: v2 的 0/空值不得覆盖 v3 的真值', () => {
  // v2 大量字段缺失会归一成 0；无条件覆盖会把 960000 盖成 0
  const [m] = shapeCatalog({
    data: { models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200000, maxOutputTokens: 128000, supportsImages: true }] },
  }, {
    data: { models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69 credits', context_window: 0, max_output_tokens: 0, supports_images: false }] },
  });
  assert.equal(m.context_window, 200000, 'v3 的真容量不能被 v2 的 0 盖掉');
  assert.equal(m.max_output_tokens, 128000);
  assert.equal(m.supports_images, true);
  assert.equal(m.credits, 'x0.69 credits', 'v2 有的字段（倍率）要补上');
});

test('shapeCatalog: v2 独有的型号照样进目录', () => {
  const out = shapeCatalog({ data: { models: [] } }, {
    data: { models: [{ id: 'minimax-m2.7', name: 'MiniMax-M2.7', credits: 'x0.2 credits' }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'minimax-m2.7');
  assert.equal(out[0].credits, 'x0.2 credits');
});

test('shapeCatalog: 两端都失败/空数据不炸', () => {
  assert.deepEqual(shapeCatalog(null, null), []);
  assert.deepEqual(shapeCatalog({}, {}), []);
  assert.deepEqual(shapeCatalog({ data: {} }, { data: { models: 'x' } }), []);
});

// ── 真机集成（有登录文件 + 客户端才跑；CI/未登录机器上自动跳过） ──────

const liveAuthPath = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const liveExe = '/Applications/WorkBuddy.app/Contents/MacOS/Electron';

test('integration: 解密本机登录文件（需要已登录的桌面端）', { skip: !existsSync(liveAuthPath) || !existsSync(liveExe) }, async (t) => {
  const { fetchKeyPayload, resolveAuth } = await import('../plugin/bridge/wb-bridge.mjs');
  const key = deriveAtRestKey(await fetchKeyPayload(liveExe));
  const result = await resolveAuth();
  assert.equal(result.ok, true, 'resolveAuth 应成功（桌面端已登录）');
  assert.match(result.auth.access, /^eyJ/); // JWT 形状
  assert.ok(result.auth.refresh.length > 0);
  assert.ok(result.auth.expiresAt > Date.now(), '令牌不应已过期');
  assert.ok(['https://copilot.tencent.com', 'https://www.workbuddy.ai'].includes(result.auth.endpoint));
});
