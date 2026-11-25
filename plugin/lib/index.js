/**
 * models-from-wb —— dsh 插件宿主端。
 *
 * 做三件事：
 *   1. 保证本地桥（bridge/wb-bridge.mjs）在跑：探测 127.0.0.1:<port>/health，
 *      没活就拉起一个 detached 进程（桥活过 dsh 重启，与其它 OpenAI 客户端共用）；
 *   2. 用 `ctx.llm.registerAdapter(['workbuddy'], adapter)` 注册原生模型路由 ——
 *      模型直接出现在 dsh 的模型选择器里，不写任何配置文件；
 *   3. 预热模型目录，让首次打开选择器不必等一次上游往返。
 *
 * 这个文件刻意**不 import 任何 `@deepseek-ai/*` 包**：profile 的 node_modules
 * 里解析不到它们，而 llm 服务的注册路径也不要求适配器继承 LlmAdapter
 * （只调用 providerInfo / providerRetryPolicy，没有 instanceof 检查）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkBuddyAdapter, compareModelsForPicker, creditLabel, stripCostSuffix } from './adapter.mjs';

export const name = 'models-from-wb';
/** 硬依赖 llm：没有它就没有「原生路由」这件事。 */
export const inject = ['llm'];

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_SCRIPT = join(PLUGIN_DIR, 'bridge', 'wb-bridge.mjs');

const DEFAULTS = {
  provider: 'workbuddy',
  displayName: 'WorkBuddy',
  host: '127.0.0.1',
  port: 8790,
  /** 插件加载时自动把桥拉起来（关掉则只在第一次模型调用时按需拉） */
  autoStart: true,
  readyTimeoutMs: 20_000,
  log: true,
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 等某个可选服务就绪后再注册（服务可能比本插件晚挂载）。
 * cordis 的 `ctx.inject(names, cb)` 是标准做法；不在时退回即时 get。
 */
const useService = (ctx, serviceName, fn) => {
  if (typeof ctx.inject === 'function') {
    ctx.inject([serviceName], (scope) => {
      const service = scope?.[serviceName] ?? scope?.get?.(serviceName);
      if (service) fn(service, scope);
    });
    return;
  }
  const service = ctx.get(serviceName);
  if (service) fn(service, ctx);
};

/** 打一次桥的 GET，超时 8s。 */
async function bridgeGet(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text)?.error?.message || text; } catch { /* 原文 */ }
    throw new Error(`bridge ${path} ${res.status}: ${String(detail).slice(0, 200)}`);
  }
  return JSON.parse(text);
}

/** "2026-11-24 20:22:01" → ms；解析不了返回 0。 */
function parseCreditsExpiry(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ''));
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

/**
 * 余额报告：按套餐名聚合（签到裂变包会拆成几十条，逐条列没法读），
 * 到期近的排前面，7 天内到期的标 ⚠️。
 */
export function formatCreditsReport(credits, { now = Date.now() } = {}) {
  if (!credits || typeof credits.total !== 'number') return '积分余额读取失败：返回格式不认识。';
  const byName = new Map();
  for (const p of credits.packages || []) {
    const key = String(p.name || '(未命名套餐)');
    const prev = byName.get(key) || {
      name: key, remain: 0, size: 0, monthly: false, expiresAt: 0,
    };
    prev.remain += Number(p.remain) || 0;
    prev.size += Number(p.size) || 0;
    prev.monthly = prev.monthly || p.monthly === true;
    const exp = parseCreditsExpiry(p.expiresAt);
    if (exp && (!prev.expiresAt || exp < prev.expiresAt)) prev.expiresAt = exp;
    byName.set(key, prev);
  }
  const groups = [...byName.values()].sort((a, b) => {
    if (a.expiresAt && b.expiresAt && a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
    if (a.expiresAt && !b.expiresAt) return -1;
    if (!a.expiresAt && b.expiresAt) return 1;
    return b.remain - a.remain;
  });
  const soonMs = 7 * 24 * 3600 * 1000;
  const lines = [`WorkBuddy 积分余额：${credits.total}`];
  if (groups.length) {
    lines.push('', '套餐余量（到期近的在前）：');
    for (const g of groups.slice(0, 8)) {
      const parts = [`· ${g.name}：余 ${g.remain}`];
      if (g.size > 0) parts[0] += ` / ${g.size}`;
      parts.push(g.monthly ? '月度包' : '一次性包');
      if (g.expiresAt) {
        const days = Math.ceil((g.expiresAt - now) / 86_400_000);
        const when = new Date(g.expiresAt).toISOString().slice(0, 10);
        parts.push(days <= 7 ? `⚠️ ${when} 到期（剩 ${days} 天）` : `${when} 到期`);
      }
      lines.push(parts.join(' · '));
    }
    if (groups.length > 8) lines.push(`……等 ${groups.length} 个套餐`);
  }
  return lines.join('\n');
}

/** 模型清单报告：与模型选择器同一套排序（免费优先、倍率升序、未知排最后）。 */
export function formatModelsReport(catalog) {
  const rows = (catalog || [])
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .slice()
    .sort(compareModelsForPicker)
    .map((m) => {
      const credit = creditLabel(m);
      const ctx = Number(m.context_window) || 0;
      // 桥的 name 已带倍率后缀（选择器要逐字渲染），报告里再列一次倍率会重复
      return {
        id: m.id,
        name: stripCostSuffix(m.name || m.id),
        cost: credit.text || '倍率未知',
        ctx,
      };
    });
  if (!rows.length) return '模型目录为空（桥可能没就绪）。';
  const lines = [`WorkBuddy 可用模型（${rows.length} 个，免费优先、倍率升序）：`];
  for (const r of rows.slice(0, 40)) {
    const bits = [`${r.id}`, r.name, r.cost];
    if (r.ctx > 0) bits.push(`上下文 ${Math.round(r.ctx / 1000)}K`);
    lines.push(`· ${bits.join(' · ')}`);
  }
  if (rows.length > 40) lines.push(`……等 ${rows.length} 个模型`);
  return lines.join('\n');
}

/** 桥进程管理：探测 / 拉起 / 等待就绪。 */
class BridgeSupervisor {
  /**
   * @param {object} options
   * @param {string} options.scriptPath 桥脚本绝对路径
   * @param {string} options.host
   * @param {number} options.port
   * @param {(message: string, detail?: unknown) => void} options.log
   */
  constructor(options) {
    this.scriptPath = options.scriptPath;
    this.host = options.host;
    this.port = options.port;
    this.log = options.log || (() => {});
    this.spawnedPid = null;
    this.lastStartError = '';
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  /** `GET /health`；桥未运行时返回 null（不抛）。 */
  async probe(signal) {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * 拉起桥进程。宿主是 Electron（DSH Desktop）时 process.execPath 是 Electron
   * 二进制，必须带 ELECTRON_RUN_AS_NODE=1 才会以 node 模式跑脚本，否则会弹一个
   * 空窗口。detached + unref：桥要活过 dsh 的重启。
   */
  start() {
    if (!existsSync(this.scriptPath)) {
      this.lastStartError = `找不到桥脚本：${this.scriptPath}`;
      return { ok: false, error: this.lastStartError };
    }
    const isElectronHost = Boolean(process.versions?.electron);
    const child = spawn(process.execPath, [this.scriptPath], {
      env: {
        ...process.env,
        ...(isElectronHost ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        WB_HOST: this.host,
        WB_PORT: String(this.port),
        WB_LOG: '1',
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // error 监听必须在任何早退之前挂上：spawn 失败不抛异常，而是异步 emit
    // 'error'，没有监听者会变成未捕获异常，在 dsh 宿主里可能带走整个进程。
    let brokenSpawnError = '';
    child.on('error', (error) => {
      brokenSpawnError = String(error?.message || error);
      this.lastStartError = brokenSpawnError;
      if (this.spawnedPid === child.pid) this.spawnedPid = null;
      this.log('bridge spawn error', brokenSpawnError);
    });
    if (!child.pid) {
      this.spawnedPid = null;
      return { ok: false, error: brokenSpawnError || 'spawn 没有返回 pid（原因见日志）' };
    }
    this.spawnedPid = child.pid;
    child.unref();
    return { ok: true, pid: child.pid };
  }

  /**
   * 保证桥在跑：活着就复用；否则拉起并等到 /health 就绪。
   * @returns {Promise<{ok: boolean, reused?: boolean, health?: object, error?: string}>}
   */
  async ensure({ readyTimeoutMs = 20_000 } = {}) {
    const health = await this.probe();
    if (health && health.ok === true) {
      return { ok: true, reused: true, health };
    }
    const started = this.start();
    if (!started.ok) return { ok: false, error: started.error };
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      await sleep(250);
      const h = await this.probe();
      if (h && h.ok === true) return { ok: true, reused: false, health: h };
      lastError = this.lastStartError || lastError;
    }
    return { ok: false, error: `桥已拉起但在 ${Math.round(readyTimeoutMs / 1000)} 秒内没有就绪：${lastError}` };
  }
}

/**
 * 图片附件 → data URL。
 *
 * ⚠️ `ref` 必须**原样**传给 `attachments.readImage(ref)`：dsh 的
 * `@deepseek-ai/dsh-attachment-local` 会用它做元数据核对
 * （mediaType / bytes / width / height），缺字段每次读图都抛
 * ATTACHMENT_CORRUPT，被调用方的 .catch 吞掉后模型完全看不到图、且全程不报错。
 */
function makeImageResolver(ctx, log) {
  return async (ref) => {
    if (!ref?.attachmentId) return null;
    const attachments = ctx.get('attachments');
    if (!attachments) {
      log('图片附件：dsh 没有挂载 attachments 服务，无法读取图片', String(ref.attachmentId).slice(0, 24));
      return null;
    }
    let stored;
    try {
      stored = await attachments.readImage(ref);
    } catch (error) {
      log('图片附件读取失败', `${error?.code || ''} ${error?.message || error}`.trim());
      return null;
    }
    const bytes = stored?.data ?? stored?.bytes ?? stored?.buffer;
    if (!bytes) return null;
    const mediaType = stored?.ref?.mediaType || ref.mediaType || 'image/png';
    return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const log = (...args) => { if (config.log) ctx.logger?.info?.('[models-from-wb]', ...args); };

  const supervisor = new BridgeSupervisor({
    scriptPath: BRIDGE_SCRIPT,
    host: config.host,
    port: config.port,
    log: (message, detail) => log(message, detail),
  });

  /**
   * 打桥前的「保证在跑」。桥刚确认活着的一小段时间内直接复用结论 ——
   * 省掉每次对话前那次串行的 /health 探测（本机回环也要 2-3ms，且在请求
   * 关键路径上）。被用户杀掉后最多 5 秒内下一次调用会自动把它拉回来。
   */
  let bridgeAliveAt = 0;
  const ensureReady = async () => {
    if (config.autoStart && Date.now() - bridgeAliveAt < 5000) return;
    const result = await supervisor.ensure({ readyTimeoutMs: config.readyTimeoutMs });
    if (!result.ok) throw new Error(result.error || '桥未就绪');
    bridgeAliveAt = Date.now();
  };

  const adapter = new WorkBuddyAdapter({
    provider: config.provider,
    displayName: config.displayName,
    baseUrl: supervisor.baseUrl,
    resolveImage: makeImageResolver(ctx, log),
    ensureReady,
    log: (message, detail) => log(message, detail),
  });

  // ── 注册原生 LLM 路由 ───────────────────────────────────────────────
  const llm = ctx.llm;
  let adapterHandle = null;

  const registerRoute = () => {
    adapterHandle = llm.registerAdapter([config.provider], adapter);
    log(`已注册模型路由：provider=${config.provider}（${config.displayName}）`);
    return adapterHandle;
  };

  try {
    registerRoute();
  } catch (error) {
    // 撞名的典型原因是上一个插件实例还没退完（热重载窗口）。退避重试几次；
    // 仍失败就把错误留给大家看得见，不静默半激活。
    log(`注册 provider "${config.provider}" 失败：`, error?.message || error);
    void (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await sleep(500);
        try {
          registerRoute();
          adapter.catalog({ refresh: true }).catch(() => {});
          return;
        } catch (retryError) {
          log(`注册重试 ${attempt + 1}/6 失败：`, retryError?.message || retryError);
        }
      }
    })();
  }

  // ── 桥生命周期 ──────────────────────────────────────────────────────
  if (config.autoStart) {
    void (async () => {
      try {
        const result = await supervisor.ensure({ readyTimeoutMs: config.readyTimeoutMs });
        if (result.ok) {
          // 预热目录：冷启动时桥要去上游抓目录，放后台，首次对话通常已就位
          adapter.catalog({ refresh: result.reused !== true }).catch(() => {});
          log(`桥已就绪：${supervisor.baseUrl}/v1${result.reused ? '（复用已有实例）' : ''}`);
        } else {
          log(`桥未能就绪：${result.error}`);
        }
      } catch (error) {
        log('自动启动桥失败', error?.message || error);
      }
    })();
  }

  // ── 工具与斜杠命令：积分余额 / 模型倍率 ────────────────────────────
  //
  // 模型倍率已经随目录进入模型选择器（name 后缀 + 详情 description）；
  // 余额是账号级信息，选择器放不下，这里给两个入口：
  //   · 工具 workbuddy_credits —— agent 能自己回答「积分还剩多少」；
  //   · 斜杠命令 /workbuddy credits|models —— 人直接打，立刻看到。
  const creditsTool = {
    name: 'workbuddy_credits',
    description: '查看 WorkBuddy 账号的积分余额与各套餐余量（含 7 天内到期提醒）。只读，不消耗积分。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'true = 强制重新向上游读取（默认用桥内约 30 秒的缓存）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      const refresh = args?.refresh === true;
      const credits = await bridgeGet(supervisor.baseUrl, `/v1/credits${refresh ? '?refresh=1' : ''}`);
      return formatCreditsReport(credits);
    },
  };

  useService(ctx, 'tools', (tools) => {
    try {
      tools.register(creditsTool);
      log('已注册工具 workbuddy_credits');
    } catch (error) {
      log('注册工具 workbuddy_credits 失败', error?.message || error);
    }
  });

  useService(ctx, 'commands', (commands) => {
    try {
      commands.register({
        name: 'workbuddy',
        description: 'WorkBuddy 中转：credits = 积分余额与套餐余量；models = 可用模型与积分倍率',
        input: { hint: 'credits | models' },
        async handler({ rawInput }) {
          const arg = String(rawInput || '').trim().split(/\s+/)[0] || 'credits';
          try {
            await ensureReady();
            if (arg === 'models' || arg === 'model') {
              const catalog = await bridgeGet(supervisor.baseUrl, '/v1/models');
              const data = Array.isArray(catalog?.data) ? catalog.data : [];
              return { kind: 'success', text: formatModelsReport(data) };
            }
            if (arg === 'credits' || arg === 'credit' || arg === 'quota') {
              const credits = await bridgeGet(supervisor.baseUrl, '/v1/credits');
              return { kind: 'success', text: formatCreditsReport(credits) };
            }
            return {
              kind: 'error',
              text: `不认识的子命令「${arg}」。可用：credits（积分余额）、models（模型与倍率）。`,
            };
          } catch (error) {
            return { kind: 'error', text: `WorkBuddy 查询失败：${error?.message || error}` };
          }
        },
      });
      log('已注册斜杠命令 /workbuddy（credits | models）');
    } catch (error) {
      log('注册斜杠命令 /workbuddy 失败', error?.message || error);
    }
  });

  return { supervisor, adapter, config };
}

export default { name, inject, apply, DEFAULTS };
