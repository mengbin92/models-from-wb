/**
 * workbuddy 的 dsh LLM 适配器。
 *
 * 只做「dsh 词汇 ↔ OpenAI Chat Completions 词汇」的双向翻译，真正的凭据与
 * 上游转发在本地桥（../bridge/wb-bridge.mjs）。上游本来就讲 OpenAI 协议，
 * 所以这里不做协议转换。
 *
 * 契约来源（已对照本机 dsh 安装的 @deepseek-ai/dsh-llm，非推测）：
 *   - `llm.registerAdapter(providers, adapter)` 只调用
 *     `adapter.providerInfo(provider)` 与 `adapter.providerRetryPolicy(provider)`，
 *     **没有 instanceof 检查** —— 适配器可以是普通对象，插件不必 import
 *     `@deepseek-ai/dsh-llm`（profile 的 node_modules 里也解析不到它）。
 *     但 `imageRequestPricing` / `imageRequestTarget` 会被**无判空**调用
 *     （compact 重建历史时走图片计价），必须存在。
 *   - StreamChunk 顺序：block-start → *-delta → block-end，末尾 usage → finish。
 *   - 派发失败必须以 finish 块收尾（kind:'error'），绝不向调用方抛。
 *   - TokenUsage 桶之和必须等于 totalTokens，否则 token-meter 丢弃整次测量。
 */

/** 失败码：取自 dsh 的 LLM_FAILURE_CODES 子集（本路由会产生的）。 */
export const CODE = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA_EXCEEDED',
  INVALID: 'INVALID_REQUEST',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  ABORTED: 'ABORTED',
  EMPTY: 'EMPTY_RESPONSE',
  CONTEXT: 'CONTEXT_WINDOW_EXCEEDED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_QUEUE: 'MODEL_QUEUE',
};

/** 失败时给用户一句"下一步做什么"（dsh 只展示 message，错误码本身不解释）。 */
const HINTS = {
  [CODE.AUTH]: 'WorkBuddy 登录态失效：确认桌面端已登录，或重启桥后重试。',
  [CODE.QUOTA]: '积分/额度不足：换一个模型，或在 WorkBuddy 客户端里签到领取每日积分。',
  [CODE.RATE_LIMIT]: '触发上游频率限制：稍等再试，或换一个模型。',
  [CODE.CONTEXT]: '上下文超出该模型上限：压缩对话，或换上下文更大的模型。',
  [CODE.INVALID]: '上游拒绝了请求参数：换个模型，或恢复默认参数后重试。',
  [CODE.TRANSPORT]: '本地桥连接异常：确认桥进程还活着（GET /health）。',
  [CODE.SERVER]: '上游模型服务暂时不可用：稍后重试，或换一个模型。',
  [CODE.TIMEOUT]: '上游响应超时：稍后重试，或换一个模型。',
  [CODE.MODEL_QUEUE]: '模型排队中：稍后重新发送，或换一个模型。',
  [CODE.MODEL_NOT_FOUND]: '上游没有这个模型：刷新模型目录或换模型；不要反复重试。',
};

/** 上游错误文本 → dsh 失败码。 */
export function classifyError(message, status) {
  const text = String(message || '');
  if (/\b6004\b|\b6008\b|\b14018\b|usage exceeds frequency limit|使用量已超出频率限制|积分(?:已)?耗尽|quota (?:exhausted|exceeded)|insufficient/i.test(text)) return CODE.QUOTA;
  if (status === 402) return CODE.QUOTA;
  if (/\b6020\b|\b6021\b|\b6022\b|模型排队|queue (?:full|waiting)/i.test(text)) return CODE.MODEL_QUEUE;
  if (/\b11115\b|prompt (?:is )?too long|context[_ ]?length[_ ]?exceeded|too many tokens|输入内容过长/i.test(text)) return CODE.CONTEXT;
  if (/\b11102\b|\b11158\b|service info not found|not allowed for user type/i.test(text)) return CODE.MODEL_NOT_FOUND;
  if (/\b14003\b|负载较低的模型|less busy model/i.test(text)) return CODE.RATE_LIMIT;
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(text)) return CODE.RATE_LIMIT;
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(text)) return CODE.AUTH;
  if (/\b11133\b|model_param_invalid|invalid_reasoning_effort/i.test(text)) return CODE.INVALID;
  if (status === 400 || status === 422 || /\b(?:400|422)\b|invalid.?request/i.test(text)) return CODE.INVALID;
  if (status >= 500 || /\b5\d\d\b|\b11134\b/i.test(text)) return CODE.SERVER;
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(text)) return CODE.TIMEOUT;
  if (/stream (?:interrupted|ended before)|interrupted before completion/i.test(text)) return CODE.TRANSPORT;
  if (/fetch failed|ECONN|socket|network|terminated|prematurely/i.test(text)) return CODE.TRANSPORT;
  return 'PROVIDER_ERROR';
}

function hintFor(code, detail) {
  return HINTS[code] || '';
}

// ── usage 映射 ────────────────────────────────────────────────────────

/** 同义字段取最大有限值（上游会同时下发真实值与恒 0 的占位）。 */
function maxAlias(values) {
  let best = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/**
 * OpenAI usage → dsh TokenUsage。
 *
 * `inputTokens` 是**未命中缓存的输入**（dsh-token-meter 的投影：
 * `uncachedInputTokens: usage.inputTokens`）。上游的 prompt_tokens 是**含缓存**
 * 的全部输入，直接映射会把命中率压到 50% 以下。上游只给 total 不给 prompt 时，
 * 按恒等式从 total 反推 input——桶之和必须自洽，否则整次测量被丢弃。
 */
export function mapUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hasPrompt = raw.prompt_tokens != null || raw.input_tokens != null;
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  const cacheRead = maxAlias([
    raw.prompt_tokens_details?.cached_tokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_tokens,
    raw.cached_tokens,
  ]);
  const cacheWrite = maxAlias([
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.prompt_cache_write_tokens,
  ]);
  const totalRaw = Number(raw.total_tokens ?? 0) || 0;
  let input;
  if (!hasPrompt && totalRaw > 0) {
    input = Math.max(0, totalRaw - output - cacheRead - cacheWrite);
  } else {
    const miss = Number(raw.prompt_cache_miss_tokens);
    const missOk = Number.isFinite(miss) && miss >= 0 && miss + cacheRead + cacheWrite === promptTokens;
    input = missOk ? miss : Math.max(0, promptTokens - cacheRead - cacheWrite);
  }
  const total = totalRaw || input + output + cacheRead + cacheWrite;
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens ?? 0) || 0;
  const usage = { inputTokens: input, outputTokens: output, totalTokens: total };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  if (reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

/** OpenAI finish_reason → dsh FinishReason。 */
export function mapFinishReason(reason, sawToolCall, sawContent) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'error', failure: { message: '上游以 content_filter 结束本次回复', code: CODE.INVALID } };
    case 'stop':
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawContent) return { kind: 'error', failure: { message: '上游回复结束但没有任何内容', code: CODE.EMPTY } };
      return { kind: 'stop' };
    default:
      if (sawToolCall) return { kind: 'tool-calls' };
      if (!sawContent) return { kind: 'error', failure: { message: '上游回复结束但没有任何内容', code: CODE.EMPTY } };
      return { kind: 'stop' };
  }
}

// ── dsh 消息 → OpenAI wire ────────────────────────────────────────────

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}

/**
 * 一条 dsh 消息 → 一条 OpenAI wire 消息。
 * developer → system（上游不认 developer 角色，400 code 11128）。
 */
async function toWireMessage(message, resolveImage) {
  const role = message.role === 'developer' ? 'system' : message.role;
  const blocks = Array.isArray(message.content) ? message.content : [];

  if (role === 'tool') {
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text') parts.push(block.text || '');
    }
    return {
      role: 'tool',
      tool_call_id: String(message.toolCallId || ''),
      content: parts.join('') || '(no output)',
    };
  }

  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];
    const imageRefs = [];
    for (const block of blocks) {
      if (block?.type === 'text') textParts.push(block.text || '');
      else if (block?.type === 'tool-call') {
        toolCalls.push({
          id: String(block.id || ''),
          type: 'function',
          function: { name: String(block.name || ''), arguments: String(block.arguments ?? '{}') },
        });
      } else if (block?.type === 'image' && block.offloaded !== true) {
        imageRefs.push(block.attachment);
      }
    }
    const imageParts = (await Promise.all(imageRefs.map((ref) => resolveImage(ref).catch(() => null))))
      .filter(Boolean)
      .map((url) => ({ type: 'image_url', image_url: { url } }));
    const text = textParts.join('');
    if (imageParts.length) {
      const out = { role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), ...imageParts] };
      if (toolCalls.length) out.tool_calls = toolCalls;
      return out;
    }
    const out = { role: 'assistant', content: text || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return out;
  }

  // system / user：带图片时走多段内容
  const hasImage = blocks.some((b) => b?.type === 'image' && b.offloaded !== true);
  if (!hasImage) return { role, content: textOf(blocks) };
  const parts = (await Promise.all(blocks.map(async (block) => {
    if (block?.type === 'text' && block.text) return { type: 'text', text: block.text };
    if (block?.type === 'image') {
      const url = await resolveImage(block.attachment).catch(() => null);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片：无法读取该附件]' };
    }
    return null;
  }))).filter(Boolean);
  if (!parts.length) parts.push({ type: 'text', text: '' });
  return { role, content: parts };
}

/**
 * wire 层净化：剔掉上游一定会拒绝的消息。
 *   - 空助手轮（content 为空且无 tool_calls）→ 有的上游直接 400；
 *   - 孤儿 tool 结果（没有对应 assistant.tool_calls 声明）→ OpenAI schema 要求
 *     每个 tool 消息必须对得上 tool_call_id。
 */
function sanitizeWire(messages) {
  const kept = [];
  const declared = new Set();
  for (const m of messages) {
    if (m.role === 'assistant') {
      const c = m.content;
      const hasText = (typeof c === 'string' && c.length > 0)
        || (Array.isArray(c) && c.some((p) => (p?.type === 'text' && p.text?.length) || p?.type === 'image_url'));
      const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (!hasText && !hasCalls) continue;
      if (hasCalls) for (const call of m.tool_calls) declared.add(String(call.id));
      kept.push(m);
      continue;
    }
    if (m.role === 'tool') {
      if (!declared.has(String(m.tool_call_id))) continue;
      kept.push(m);
      continue;
    }
    kept.push(m);
  }
  return kept;
}

/** dsh 工具表 → OpenAI tools（toolHistory 里的动态新增一并带上）。 */
export function toWireTools(options) {
  const byName = new Map();
  const add = (tool) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || byName.has(tool.name)) return;
    byName.set(tool.name, {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
      },
    });
  };
  for (const tool of options.tools || []) add(tool);
  for (const update of options.toolHistory?.updates || []) {
    for (const tool of update.additions || []) add(tool);
  }
  return [...byName.values()];
}

// ── SSE → StreamChunk ────────────────────────────────────────────────

/**
 * SSE 增量解析器：块索引按出现顺序分配，每个块先 block-start、期间发增量、
 * 收尾时 block-end 携带完整内容。
 */
class StreamTranslator {
  constructor() {
    this.nextIndex = 0;
    this.text = null;
    this.reasoning = null;
    this.tools = new Map(); // wire tool index → { index, id, name, args }
    this.order = [];
    this.usage = null;
    this.finishReason = undefined;
    this.sawToolCall = false;
    this.error = null;
  }

  get sawContent() {
    return this.text !== null || this.reasoning !== null || this.sawToolCall;
  }

  /** 解析一行 `data: {...}`；返回本次新增的块数组。 */
  pushLine(line) {
    const out = [];
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('data:')) return out;
    const body = trimmed.slice(5).trim();
    if (!body || body === '[DONE]') return out;
    let frame;
    try { frame = JSON.parse(body); } catch { return out; }
    if (frame.usage) this.usage = frame.usage;
    // 流内错误帧（没有 choices）必须先于 choices 判断接住，否则断流会被
    // 当成正常 stop——用户看到半截回答、dsh 认为成功。
    if (frame.error && typeof frame.error === 'object') {
      const err = frame.error;
      const message = (typeof err.message === 'string' && err.message)
        || (typeof frame.message === 'string' && frame.message)
        || '上游在流中途报错';
      const rawCode = err.code ?? frame.code;
      this.error = {
        message: rawCode != null && String(rawCode) ? `${message}（code ${rawCode}）` : message,
      };
      return out;
    }
    const choice = frame.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
      if (!this.reasoning) {
        this.reasoning = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'reasoning', index: this.reasoning.index });
        out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' });
      }
      this.reasoning.text += delta.reasoning_content;
      out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: delta.reasoning_content });
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      if (!this.text) {
        this.text = { index: this.nextIndex++, text: '' };
        this.order.push({ kind: 'text', index: this.text.index });
        out.push({ type: 'block-start', index: this.text.index, blockType: 'text' });
      }
      this.text.text += delta.content;
      out.push({ type: 'text-delta', index: this.text.index, text: delta.content });
    }

    for (const call of delta.tool_calls || []) {
      const wireIndex = Number.isInteger(call.index) ? call.index : 0;
      let entry = this.tools.get(wireIndex);
      if (!entry) {
        entry = { index: this.nextIndex++, id: '', name: '', args: '' };
        this.tools.set(wireIndex, entry);
        this.sawToolCall = true;
        this.order.push({ kind: 'tool-call', index: entry.index });
        out.push({ type: 'block-start', index: entry.index, blockType: 'tool-call' });
      }
      if (call.id) entry.id = String(call.id);
      if (!entry.id) entry.id = `call_${wireIndex}`;
      if (call.function?.name) entry.name += String(call.function.name);
      const argsDelta = call.function?.arguments;
      if (typeof argsDelta === 'string' && argsDelta.length) {
        entry.args += argsDelta;
        out.push({
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          ...(entry.name ? { name: entry.name } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  /** 收尾：按开启顺序补 block-end，再补 usage 与 finish。 */
  finish() {
    const out = [];
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) {
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      } else if (kind === 'reasoning' && this.reasoning) {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      } else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          out.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' },
          });
        }
      }
    }
    const usage = mapUsage(this.usage);
    if (usage) out.push({ type: 'usage', usage });
    if (this.error) {
      out.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: this.error.message, code: classifyError(this.error.message) } },
      });
      return out;
    }
    out.push({ type: 'finish', reason: mapFinishReason(this.finishReason, this.sawToolCall, this.sawContent) });
    return out;
  }

  /** 流中断时已开块的收尾（内容保留，这一轮按失败结束）。 */
  closeOpenBlocks() {
    const out = [];
    for (const { kind, index } of this.order) {
      if (kind === 'text' && this.text) {
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text.text } });
      } else if (kind === 'reasoning' && this.reasoning) {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning.text } });
      } else if (kind === 'tool-call') {
        for (const entry of this.tools.values()) {
          if (entry.index !== index) continue;
          out.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args || '{}' },
          });
        }
      }
    }
    return out;
  }
}

// ── 模型目录 → dsh 元数据 ─────────────────────────────────────────────

const NON_CHAT_RE = /embedding|rerank|moderation|tts|whisper|image|video|default-model|^default$|enhance-/i;

/**
 * 目录没给上下文容量时，`resolveModel` 用的**保守**下限。
 *
 * dsh 的 compaction-basic 拿不到 contextWindow 就拒绝切模型
 * （"no context capacity … configure contextWindow on that adapter model"）。
 * 给一个下限好过什么都不给：低估容量只会让 dsh 更早压缩（安全方向），
 * 高估会把超长请求发给上游、换一个 400。真实容量永远优先。
 */
export const FALLBACK_CONTEXT_WINDOW = 32_768;

/** token 容量 → 短文本：1_000_000 → 1M，128_000 → 128K，8_192 → 8192。 */
function shortCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) {
    const m = Math.round(value / 100_000) / 10;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/**
 * 积分倍率数值；`null` = 上游没给（**未知，不是 0**）。
 * 免费判定只认显式事实：数值 0、`x0.00`、或 `free:true`。
 */
export function creditValue(m) {
  const raw = m?.credits;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const hit = /x\s*([0-9]*\.?[0-9]+)/i.exec(raw);
    if (!hit) return null;
    const n = Number(hit[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 积分倍率归一化。
 *
 * ⚠️ **不能写 `Number(credits) === 0` 判免费**：上游把「没给倍率」表示成缺失，
 * 而 `Number(null) === 0` —— 那会把「不知道多少钱」标成「免费」，是对用户的
 * 钱包撒谎。免费只认两种显式事实：`free === true`，或 credits 是**数值**且为 0。
 *
 * @param {object} m 桥目录的一项
 * @returns {{ text: string, known: boolean, free: boolean }}
 *   text = '×0.11' | '免费' | ''（未知）；known = 上游是否给了倍率
 */
export function creditLabel(m) {
  const n = creditValue(m);
  if (n === null) {
    return m?.free === true
      ? { text: '免费', known: true, free: true }
      : { text: '', known: false, free: false };
  }
  if (n === 0) return { text: '免费', known: true, free: true };
  return { text: `×${n}`, known: true, free: false };
}

/**
 * 模型选择器排序：**免费优先，其次倍率升序，未知倍率排最后**。
 *
 * 为什么值得排：目录是上游顺序（合并 /v3/config 与 /v2 的结果），免费档和
 * ×1.62 的贵模型混在一起，用户每次选模型都要从头翻。免费模型对「先试试这个
 * 模型好不好用」的决策最省成本，排前面；同组内保持目录原序（V8 的 sort 稳定），
 * 不引入第二套随意性。
 *
 * @param {object} a 桥目录的一项
 * @param {object} b 桥目录的一项
 */
export function compareModelsForPicker(a, b) {
  const va = creditValue(a);
  const vb = creditValue(b);
  const freeA = va === 0 || a?.free === true;
  const freeB = vb === 0 || b?.free === true;
  if (freeA !== freeB) return freeA ? -1 : 1;
  // 未知倍率（null）排最后：知道价格的模型比不知道的更好决策
  if (va === null && vb !== null) return 1;
  if (vb === null && va !== null) return -1;
  if (va !== null && vb !== null && va !== vb) return va - vb;
  return 0;
}

/**
 * 剥掉模型名末尾的倍率后缀。
 *
 * 桥的 `/v1/models` 已经在 `name` 里带了后缀（`GLM-4.6 · ×0.23`）——第三方
 * 客户端（Cherry Studio 等）只认 name，那是它们唯一能看到倍率的地方。适配器
 * 拿到的目录条目因此**已含后缀**，若不剥掉就再拼一次，选择器里会出现
 * `GLM-4.6 · ×0.23 · ×0.23`——用户会误读成 0.23×0.23（真实事故，见 issue 截图）。
 */
export function stripCostSuffix(name) {
  return String(name || '').replace(/\s·\s(×[\d.]+|免费)$/, '');
}

/** 桥目录的一项 → dsh LlmModelInfo。倍率同时进 name 后缀与 description。 */
export function toModelInfo(m) {
  const bits = [];
  const ctx = Number(m.context_window) || 0;
  const out = Number(m.max_output_tokens) || 0;
  if (ctx > 0) bits.push(`上下文 ${shortCount(ctx)}`);
  if (out > 0) bits.push(`输出 ${shortCount(out)}`);
  if (m.supports_images === true) bits.push('图片');
  if (m.supports_reasoning === true) bits.push('推理');
  const credit = creditLabel(m);
  // 倍率进 description：选择器行只逐字渲染 name，模型详情页才看得到 description
  if (credit.text) bits.push(`积分 ${credit.text}`);
  return {
    id: String(m.id),
    // 先剥掉桥名里的后缀再拼，保证倍率在整个名字里只出现一次
    name: `${stripCostSuffix(m.name || m.id)}${credit.text ? ` · ${credit.text}` : ''}`,
    ...(bits.length ? { description: bits.join(' · ') } : {}),
    inputModalities: m.supports_images === true ? ['text', 'image'] : ['text'],
  };
}

// ── 适配器 ────────────────────────────────────────────────────────────

export class WorkBuddyAdapter {
  /**
   * @param {object} options
   * @param {string} options.provider provider 路由名
   * @param {string} options.displayName 模型选择器里显示的名字
   * @param {string} options.baseUrl 桥的地址（http://127.0.0.1:8790）
   * @param {(ref: object) => Promise<string|null>} [options.resolveImage]
   * @param {() => Promise<void>} [options.ensureReady] 打桥前保证桥在跑（挂了自动拉）
   * @param {(message: string, detail?: unknown) => void} [options.log]
   * @param {number} [options.catalogTtlMs] 目录缓存时长（默认 60s）
   */
  constructor(options) {
    this.provider = options.provider;
    this.displayName = options.displayName || 'WorkBuddy';
    this.baseUrl = String(options.baseUrl || 'http://127.0.0.1:8790').replace(/\/+$/, '');
    this.resolveImage = options.resolveImage || (async () => null);
    this.ensureReady = options.ensureReady || null;
    this.log = options.log || (() => {});
    this.catalogTtlMs = Number(options.catalogTtlMs) > 0 ? Number(options.catalogTtlMs) : 60_000;
    this.catalogCache = { at: 0, models: [] };
    this.catalogInflight = null;
    this.catalogError = '';
  }

  /** 注册时同步调用：不能有 I/O。 */
  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  /**
   * 必须存在（dsh 对方法不判空）：compact 重建历史时会调用它做图片计价。
   * 返回 undefined = 不声明计价，token-meter 退回中性估算。
   */
  imageRequestPricing() {
    return undefined;
  }

  /** 同上，必须存在：原样透传（桥按原图转发）。 */
  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width, height: image?.height, maxBytes: image?.bytes };
  }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: [CODE.RATE_LIMIT, CODE.SERVER, CODE.TRANSPORT, CODE.TIMEOUT],
      initialDelayMs: 600,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
    };
  }

  /** 打一次桥的目录请求。 */
  async #fetchCatalog({ refresh = false, signal } = {}) {
    const res = await fetch(`${this.baseUrl}/v1/models${refresh ? '?refresh=1' : ''}`, { signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`bridge /v1/models ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = await res.json().catch(() => null);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    this.catalogCache = { at: Date.now(), models: data };
    this.catalogError = '';
    return data;
  }

  /**
   * 拉目录：新鲜 → 直接返回；过期 → 先返回旧的、后台换新；冷启动 → 阻塞一次。
   */
  async catalog({ refresh = false, signal } = {}) {
    if (refresh) {
      if (this.catalogInflight) return this.catalogInflight;
      this.catalogInflight = this.#fetchCatalog({ refresh: true, signal })
        .finally(() => { this.catalogInflight = null; });
      return this.catalogInflight;
    }
    if (this.catalogCache.models.length) {
      if (Date.now() - this.catalogCache.at < this.catalogTtlMs) return this.catalogCache.models;
      this.#fetchCatalog({ signal }).catch(() => {}); // 后台换新，不等
      return this.catalogCache.models;
    }
    if (this.catalogInflight) return this.catalogInflight;
    this.catalogInflight = this.#fetchCatalog({ signal })
      .finally(() => { this.catalogInflight = null; });
    return this.catalogInflight;
  }

  /** 模型选择器看到的目录：免费优先、倍率升序、未知排最后。 */
  async listModels(provider = this.provider) {
    const catalog = await this.catalog();
    return catalog
      .filter((m) => m && typeof m.id === 'string' && m.id && !NON_CHAT_RE.test(m.id))
      // 拷贝一份再排：catalogCache 是共享缓存，原地 sort 会把顺序污染给
      // 后续读者（面板/工具看到的也应是排好的，但缓存本身保持上游原序）
      .slice()
      .sort(compareModelsForPicker)
      .map((m) => ({ provider, ...toModelInfo(m) }));
  }

  /** 单个模型的精确元数据。目录失败时退回最小元数据（调用由 stream 决定）。 */
  async resolveModel(provider, model, signal) {
    let catalog;
    try {
      catalog = await this.catalog({ signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.log('resolveModel catalog failed; using minimal model info', String(error?.message || error));
      // 目录失败也不能没有容量： compaction 会因「无上下文容量」拒绝切模型
      return { provider, id: model, name: model, context: { contextWindow: FALLBACK_CONTEXT_WINDOW } };
    }
    const hit = catalog.find((m) => m && m.id === model);
    if (!hit) {
      return { provider, id: model, name: model, context: { contextWindow: FALLBACK_CONTEXT_WINDOW } };
    }
    const info = toModelInfo(hit);
    const ctx = Number(hit.context_window) || 0;
    const maxTokens = Number(hit.max_output_tokens) || 0;
    return {
      provider,
      id: model,
      name: info.name,
      ...(info.description ? { description: info.description } : {}),
      // 容量**必须**给：缺了 compaction 直接拒绝切模型（见 FALLBACK 注释）
      context: { contextWindow: ctx > 0 ? ctx : FALLBACK_CONTEXT_WINDOW },
      ...(maxTokens > 0 ? { defaultMaxTokens: maxTokens } : {}),
      inputModalities: info.inputModalities,
    };
  }

  /** one-generation 绑定：解析与派发之间不让配置变化串味。 */
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  /**
   * 真正的流式调用。所有失败都以 finish 块收尾，绝不向调用方抛。
   * @param {object} options dsh GenerateOptions
   */
  async *stream(options) {
    const model = String(options.model || '');
    const signal = options.signal;
    if (!model) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '未指定模型', code: CODE.INVALID } } };
      return;
    }

    // ── 组装 OpenAI 请求 ──────────────────────────────────────────────
    let payload;
    try {
      const messages = [];
      if (typeof options.system === 'string' && options.system.length) {
        messages.push({ role: 'system', content: options.system });
      }
      const converted = await Promise.all(
        (options.messages || []).map((m) => toWireMessage(m, (ref) => this.resolveImage(ref))),
      );
      messages.push(...converted);
      payload = { model, messages: sanitizeWire(messages), stream: true };
      const tools = toWireTools(options);
      if (tools.length) payload.tools = tools;
      if (typeof options.temperature === 'number') payload.temperature = options.temperature;
      if (typeof options.maxTokens === 'number' && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
      if (Array.isArray(options.stop) && options.stop.length) payload.stop = options.stop;
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `请求组装失败：${error?.message || error}`, code: CODE.INVALID } } };
      return;
    }

    // ── 打桥 ─────────────────────────────────────────────────────────
    // 桥是 detached 长驻进程，但仍可能被用户/系统杀掉：调用前给一次「拉起」机会，
    // 失败按 TRANSPORT 收尾（下一次调用还会再试）。
    if (this.ensureReady) {
      try {
        await this.ensureReady();
      } catch (error) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `本地桥不可用：${error?.message || error} —— ${HINTS[CODE.TRANSPORT]}`,
              code: CODE.TRANSPORT,
            },
          },
        };
        return;
      }
    }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const aborted = signal?.aborted === true;
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : { kind: 'error', failure: { message: `本地桥连接失败：${error?.message || error} —— ${HINTS[CODE.TRANSPORT]}`, code: CODE.TRANSPORT } },
      };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      let codeLabel = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.msg || parsed?.message || text;
        const raw = parsed?.error?.code ?? parsed?.code;
        codeLabel = raw == null ? '' : String(raw);
      } catch { /* 非 JSON 错误体，保留原文 */ }
      const failureCode = signal?.aborted ? CODE.ABORTED : classifyError(`${detail} ${codeLabel}`, res.status);
      const hint = hintFor(failureCode, detail);
      yield {
        type: 'finish',
        reason: {
          kind: signal?.aborted ? 'aborted' : 'error',
          failure: {
            message: `上游 ${res.status}：${String(detail || '').slice(0, 400)}${codeLabel ? `（code ${codeLabel}）` : ''}${hint ? ` —— ${hint}` : ''}`,
            code: failureCode,
            ...(res.status ? { status: res.status } : {}),
          },
        },
      };
      return;
    }

    // ── 逐帧转译并即时 yield ──────────────────────────────────────────
    const translator = new StreamTranslator();
    const decoder = new TextDecoder();
    let tail = '';
    let reader = null;
    try {
      // 取 reader 必须在 try 内：响应体不合形状时也不能向调用方抛
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        tail += decoder.decode(value, { stream: true });
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) {
          for (const chunk of translator.pushLine(line)) yield chunk;
        }
        if (tail.length > 200_000) tail = tail.slice(-8192);
      }
      if (tail.trim()) {
        for (const chunk of translator.pushLine(tail)) yield chunk;
      }
      for (const chunk of translator.finish()) yield chunk;
    } catch (error) {
      for (const chunk of translator.closeOpenBlocks()) yield chunk;
      const aborted = signal?.aborted === true;
      this.log('stream interrupted', error?.message || error);
      yield {
        type: 'finish',
        reason: aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: CODE.ABORTED } }
          : { kind: 'error', failure: { message: `流中断：${error?.message || error} —— 上游连接提前结束，可重试或换模型。`, code: CODE.TRANSPORT } },
      };
    } finally {
      // 消费方提前退出时上游响应体还开着：主动收掉，别让 socket 泄漏
      if (reader) await reader.cancel().catch(() => {});
    }
  }
}
