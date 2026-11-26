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
  clientExeCandidates,
  deriveAtRestKey,
  deriveAtRestKeyId,
  envelopeKeyId,
  findClientExe,
  normalizePayload,
  openEncryptedField,
  resolveAuthPath,
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

// ── 目录整形：v3 驼峰字段 + 不覆盖合并 ─────────────────────────────────

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
