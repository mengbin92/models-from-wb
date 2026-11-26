/**
 * adapter 单元测试（node:test）。
 * 覆盖：usage 映射（桶自洽）、finish 归因、错误分类、wire 工具表、模型元数据，
 *       以及对着一个假桥跑完整 stream() 的集成用例（验证 StreamChunk 顺序契约）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  CODE,
  WorkBuddyAdapter,
  classifyError,
  mapFinishReason,
  mapUsage,
  stripCostSuffix,
  toModelInfo,
  toWireTools,
} from '../plugin/lib/adapter.mjs';

// ── usage 映射 ────────────────────────────────────────────────────────

test('mapUsage: 桶之和等于 totalTokens', () => {
  const usage = mapUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.totalTokens, 120);
});

test('mapUsage: inputTokens 是未命中缓存的输入（不是 prompt_tokens）', () => {
  // 本机实测形状：prompt_tokens=1456 = cached 1280 + miss 176
  const usage = mapUsage({
    prompt_tokens: 1456,
    completion_tokens: 50,
    total_tokens: 1506,
    prompt_cache_miss_tokens: 176,
    prompt_tokens_details: { cached_tokens: 1280 },
  });
  assert.equal(usage.inputTokens, 176);
  assert.equal(usage.cacheReadTokens, 1280);
  assert.equal(usage.totalTokens, 1506);
});

test('mapUsage: 缺 prompt 时按恒等式从 total 反推 input（不制造零点声明）', () => {
  const usage = mapUsage({ completion_tokens: 10, total_tokens: 1050 });
  assert.equal(usage.inputTokens, 1040);
  assert.equal(usage.totalTokens, 1050);
});

test('mapUsage: 恒 0 的占位不挡真实缓存值（取同义字段最大）', () => {
  const usage = mapUsage({
    prompt_tokens: 500, completion_tokens: 5, total_tokens: 505, cached_tokens: 0,
    prompt_tokens_details: { cached_tokens: 480 },
  });
  assert.equal(usage.cacheReadTokens, 480);
  assert.equal(usage.inputTokens, 20);
});

test('mapUsage: reasoning tokens 单列', () => {
  const usage = mapUsage({ prompt_tokens: 1, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 8 } });
  assert.equal(usage.reasoningTokens, 8);
});

test('mapUsage: 空/坏输入返回 null', () => {
  assert.equal(mapUsage(null), null);
  assert.equal(mapUsage('x'), null);
});

// ── finish 归因 ───────────────────────────────────────────────────────

test('mapFinishReason: stop 但无内容 = 空回复错误（不是成功）', () => {
  const reason = mapFinishReason('stop', false, false);
  assert.equal(reason.kind, 'error');
  assert.equal(reason.failure.code, CODE.EMPTY);
});

test('mapFinishReason: 常见映射', () => {
  assert.deepEqual(mapFinishReason('tool_calls', true, true), { kind: 'tool-calls' });
  assert.deepEqual(mapFinishReason('length', false, true), { kind: 'max-tokens' });
  assert.deepEqual(mapFinishReason('stop', false, true), { kind: 'stop' });
  assert.equal(mapFinishReason('content_filter', false, true).kind, 'error');
  // stop + 见过 tool call → tool-calls
  assert.deepEqual(mapFinishReason('stop', true, true), { kind: 'tool-calls' });
});

// ── 错误分类 ──────────────────────────────────────────────────────────

test('classifyError: 上游业务码 → dsh 失败码', () => {
  assert.equal(classifyError('usage exceeds frequency limit', 400), CODE.QUOTA);
  assert.equal(classifyError('积分已耗尽', 400), CODE.QUOTA);
  assert.equal(classifyError('模型排队中', 400), CODE.MODEL_QUEUE);
  assert.equal(classifyError('输入内容过长', 400), CODE.CONTEXT);
  assert.equal(classifyError('service info not found', 400), CODE.MODEL_NOT_FOUND);
  assert.equal(classifyError('负载较低的模型', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('rate limit', 429), CODE.RATE_LIMIT);
  assert.equal(classifyError('unauthorized', 401), CODE.AUTH);
  assert.equal(classifyError('forbidden', 403), CODE.AUTH);
  assert.equal(classifyError('model_param_invalid', 400), CODE.INVALID);
  assert.equal(classifyError('boom', 500), CODE.SERVER);
  assert.equal(classifyError('request timed out', 0), CODE.TIMEOUT);
  assert.equal(classifyError('upstream stream interrupted before completion', 0), CODE.TRANSPORT);
  assert.equal(classifyError('fetch failed', 0), CODE.TRANSPORT);
  assert.equal(classifyError('mystery', 0), 'PROVIDER_ERROR');
});

test('classifyError: 额度优先于 429（避免白重试）', () => {
  // 6004 是账号级用量上限，归 RATE_LIMIT 会让 dsh 退避重试再报同一个错
  assert.equal(classifyError('6004 usage exceeds frequency limit', 429), CODE.QUOTA);
});

// ── wire 工具表 ───────────────────────────────────────────────────────

test('toWireTools: 去重 + toolHistory 动态新增 + 缺 parameters 补默认空 schema', () => {
  const tools = toWireTools({
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }, { name: 'bash' }],
    toolHistory: { updates: [{ additions: [{ name: 'read', description: 'read file' }] }] },
  });
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.function.name), ['bash', 'read']);
  // 缺 parameters 时补上游要求的空 schema（而不是发 undefined）
  assert.deepEqual(tools[1].function.parameters, { type: 'object', properties: {} });
});

test('toWireTools: 无名工具被忽略', () => {
  assert.deepEqual(toWireTools({ tools: [{ description: 'x' }, null] }), []);
});

// ── 模型元数据 ────────────────────────────────────────────────────────

test('toModelInfo: 名字带归一化倍率、描述带容量/多模态/倍率', () => {
  const info = toModelInfo({
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    credits: 'x0.11 credits',
    context_window: 128000,
    max_output_tokens: 8192,
    supports_images: true,
    supports_reasoning: true,
  });
  // "x0.11 credits" 归一化成 "×0.11"（不再把上游原始字符串怼进名字）
  assert.equal(info.name, 'DeepSeek-V4.1-Flash · ×0.11');
  assert.match(info.description, /上下文 128K/);
  assert.match(info.description, /图片/);
  assert.match(info.description, /推理/);
  assert.match(info.description, /积分 ×0.11/);
  assert.deepEqual(info.inputModalities, ['text', 'image']);
});

test('toModelInfo: 免费标「免费」、未知倍率不标', () => {
  assert.match(toModelInfo({ id: 'a', name: 'A', credits: 'x0.00' }).name, /· 免费/);
  assert.equal(toModelInfo({ id: 'b', name: 'B' }).name, 'B');
});

test('toModelInfo: 桥名已带倍率后缀时不得重复拼接（回归：×0.23 · ×0.23）', () => {
  // 桥的 /v1/models 在 name 里带后缀（第三方客户端只认 name）；适配器若再拼一次，
  // 选择器会显示「GLM-4.6 · ×0.23 · ×0.23」，被用户误读成 0.23×0.23。
  const info = toModelInfo({
    id: 'glm-4.6',
    name: 'GLM-4.6 · ×0.23',          // 桥给的原样名字
    credits: 'x0.23 credits',
    context_window: 128000,
  });
  assert.equal(info.name, 'GLM-4.6 · ×0.23');
  assert.equal(info.name.match(/×0\.23/g).length, 1, '倍率只能出现一次');
  // 免费后缀同样不重复
  const free = toModelInfo({ id: 'hy4flash-free', name: 'Hy4 flash · 免费', credits: 'x0.00' });
  assert.equal(free.name, 'Hy4 flash · 免费');
});

test('stripCostSuffix: 只剥末尾的倍率后缀', () => {
  assert.equal(stripCostSuffix('GLM-4.6 · ×0.23'), 'GLM-4.6');
  assert.equal(stripCostSuffix('Hy4 flash · 免费'), 'Hy4 flash');
  assert.equal(stripCostSuffix('GLM-4.6'), 'GLM-4.6');
  assert.equal(stripCostSuffix(''), '');
  assert.equal(stripCostSuffix(undefined), '');
  // 名字中间的同形态文本不动
  assert.equal(stripCostSuffix('模型 · ×1 特别版'), '模型 · ×1 特别版');
});

// ── 集成：对着假桥跑 stream() ─────────────────────────────────────────

/** 起一个一次性 SSE 假桥，返回 baseUrl 与关闭函数。 */
function startFakeBridge(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

const textFrames = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] },
  { choices: [{ index: 0, delta: { content: '，世界' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
];

test('integration: stream() 产出合规的 StreamChunk 序列', async (t) => {
  let seenBody = null;
  const bridge = await startFakeBridge((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [textFrames[0] && { id: 'm1', name: 'M1', credits: 'x0.1 credits' }] }));
      return;
    }
    // /v1/chat/completions
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse(textFrames));
    });
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', displayName: 'WorkBuddy', baseUrl: bridge.baseUrl });

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'workbuddy',
    model: 'm1',
    system: 'be nice',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk);
  }

  // 顺序契约：block-start → text-delta* → block-end → usage → finish
  const types = chunks.map((c) => c.type);
  assert.equal(types[0], 'block-start');
  assert.equal(types.at(-1), 'finish');
  assert.equal(types.at(-2), 'usage');
  assert.equal(types.filter((x) => x === 'block-start').length, 1);
  assert.equal(types.filter((x) => x === 'text-delta').length, 2);
  assert.equal(types.filter((x) => x === 'block-end').length, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(chunks.at(-2).usage.totalTokens, 14);
  // 文本聚合
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, '你好，世界');
  assert.equal(chunks.at(-3).block.text, '你好，世界');
  // system 被放进 messages 首条；stream 强制为 true
  assert.equal(seenBody.messages[0].role, 'system');
  assert.equal(seenBody.stream, true);
});

test('integration: stream() 流内错误帧 → error finish（不当成成功）', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200); res.end('{"data":[]}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse([
      { choices: [{ index: 0, delta: { content: '半截' } }] },
      { error: { message: 'upstream login expired', code: 401 } },
    ]));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk);
  }
  const last = chunks.at(-1);
  assert.equal(last.type, 'finish');
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure.code, CODE.AUTH);
  // 已吐内容仍被收尾
  assert.ok(chunks.some((c) => c.type === 'block-end'));
});

test('integration: stream() 桥 4xx → error finish 带归因', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200); res.end('{"data":[]}'); return; }
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'too many requests', code: '429' } }));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })) {
    chunks.push(chunk);
  }
  const last = chunks.at(-1);
  assert.equal(last.reason.kind, 'error');
  assert.equal(last.reason.failure.code, CODE.RATE_LIMIT);
  assert.match(last.reason.failure.message, /下一步|稍等/);
});

test('integration: stream() 工具调用块', async (t) => {
  const toolFrames = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"cmd"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ];
  const bridge = await startFakeBridge((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200); res.end('{"data":[]}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse(toolFrames));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'm1',
    messages: [{ role: 'user', content: 'ls' }],
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(end.block.name, 'bash');
  assert.equal(end.block.arguments, '{"cmd":"ls"}');
  assert.equal(end.block.id, 'call_1');
});

test('integration: listModels 过滤非对话模型', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'deepseek-v4.1-flash', name: 'DS', credits: 'x0.11 credits', context_window: 128000 },
      { id: 'hunyuan-image-alpha', name: 'IMG' },
      { id: 'text-embedding-3', name: 'EMB' },
    ] }));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const models = await adapter.listModels('workbuddy');
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4.1-flash']);
  assert.equal(models[0].provider, 'workbuddy');
});

test('integration: listModels 免费优先、倍率升序、未知排最后', async (t) => {
  // 上游目录顺序故意打乱：贵的在前、未知的中间、免费的最后
  const bridge = await startFakeBridge((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'kimi-k3', name: 'Kimi-K3', credits: 'x1.62 credits' },
      { id: 'glm-5.3', name: 'GLM-5.3 · ×0.69', credits: 'x0.69 credits' },
      { id: 'mystery', name: 'Mystery' },
      { id: 'hy4flash-free', name: 'Hy4 flash · 免费', credits: 'x0.00' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.08 credits' },
    ] }));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const models = await adapter.listModels('workbuddy');
  assert.deepEqual(models.map((m) => m.id), [
    'hy4flash-free',   // 免费第一
    'glm-5.3-flash',   // ×0.08
    'glm-5.3',         // ×0.69
    'kimi-k3',         // ×1.62
    'mystery',         // 倍率未知，排最后
  ]);
  // 排序不污染桥目录缓存（缓存保持上游原序）
  const again = await adapter.listModels('workbuddy');
  assert.deepEqual(again.map((m) => m.id), models.map((m) => m.id));
  assert.equal(adapter.catalogCache.models[0].id, 'kimi-k3', '缓存应保持上游原序');
});

test('integration: 目录失败时 resolveModel 退回最小元数据（不误报模型不存在）', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    res.writeHead(503);
    res.end('down');
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const resolved = await adapter.resolveModel('workbuddy', 'anything');
  // 仍带保守容量： compaction 拿不到 contextWindow 会拒绝切模型
  assert.deepEqual(resolved, {
    provider: 'workbuddy',
    id: 'anything',
    name: 'anything',
    context: { contextWindow: 32768 },
  });
});

test('integration: resolveModel 报真实上下文容量（切模型不再被 compaction 拒）', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'hy4flash-free', name: 'Hy4 flash · 免费', credits: 'x0.00', context_window: 960000, max_output_tokens: 64000 },
      ] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse(textFrames));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const resolved = await adapter.resolveModel('workbuddy', 'hy4flash-free');
  assert.equal(resolved.context.contextWindow, 960000);
  assert.equal(resolved.defaultMaxTokens, 64000);
  assert.match(resolved.description, /上下文 960K/);
  assert.match(resolved.description, /输出 64K/);
});

test('integration: resolveModel 目录缺容量时给保守下限（不裸奔）', async (t) => {
  const bridge = await startFakeBridge((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mystery', name: 'Mystery' }] }));
  });
  t.after(() => bridge.close());

  const adapter = new WorkBuddyAdapter({ provider: 'workbuddy', baseUrl: bridge.baseUrl });
  const resolved = await adapter.resolveModel('workbuddy', 'mystery');
  assert.equal(resolved.context.contextWindow, 32768, '未知容量 → 保守下限，杜绝 no context capacity');
});
