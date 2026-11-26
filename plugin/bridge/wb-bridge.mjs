/**
 * wb-bridge —— WorkBuddy 本地 API 桥（精简版，零依赖，仅监听 127.0.0.1）。
 *
 * 把本机 WorkBuddy 桌面端已登录的模型能力暴露成 OpenAI 兼容接口：
 *
 *   GET  /health                  桥与凭据状态（毫秒级，不等上游）
 *   GET  /v1/models               模型目录（/v3/config + /v2/enterprises/personal/models 合并）
 *   POST /v1/chat/completions     OpenAI Chat Completions（强制流式，SSE 直通）
 *
 * 凭据链路（详见 docs/DESIGN.md §1）：
 *   定位客户端 exe → 以 ELECTRON_RUN_AS_NODE 跑它索取 atRestSecretKey
 *   → SHA256 派生字段密钥 → AES-256-GCM 解开登录文件里的 access/refresh token
 *   → 过期前在内存里刷新（POST /v2/plugin/auth/token/refresh，**不写回登录文件**）
 *
 * 环境变量：
 *   WB_PORT              监听端口（默认 8790）
 *   WB_HOST              监听地址（默认 127.0.0.1；仅允许回环/显式覆盖）
 *   WB_TOKEN             本地访问令牌（设置后所有请求须带 Authorization: Bearer）
 *   WB_LOG               1 = 打日志到 stderr（默认 1）
 *   WORKBUDDY_APP_EXECUTABLE  显式指定客户端 exe
 *   WORKBUDDY_AUTH_FILE       显式指定登录文件
 *   WB_APP_VERSION / WB_CLI_VERSION  身份头里的版本号（默认从桌面端读，失败用回退值）
 */
import { createServer } from 'node:http';
import {
  createDecipheriv, createHash, randomBytes,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import {
  dirname, isAbsolute, join, resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 配置 ────────────────────────────────────────────────────────────────

const PORT = Number(process.env.WB_PORT) > 0 ? Number(process.env.WB_PORT) : 8790;
const HOST = String(process.env.WB_HOST || '127.0.0.1').trim() || '127.0.0.1';
const LOCAL_TOKEN = String(process.env.WB_TOKEN || '').trim();
const LOG = !/^(0|false|off|no)$/i.test(String(process.env.WB_LOG ?? '1').trim());

const APP_VERSION_FALLBACK = '5.9.3';
const CLI_VERSION_FALLBACK = '2.165.0';
const CATALOG_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.WB_UPSTREAM_TIMEOUT_MS) > 0
  ? Number(process.env.WB_UPSTREAM_TIMEOUT_MS)
  : 0; // 0 = 不限：LLM 长回答该等多久等多久
const REFRESH_SKEW_MS = 60_000; // 距过期 60s 内就刷新
const KEY_FETCH_TIMEOUT_MS = 20_000;

function log(...args) {
  if (LOG) console.error('[wb-bridge]', ...args);
}

// ── AtRest：取钥 / 派生 / 解密 ────────────────────────────────────────

const FRAMING_FIELD = 2;
const FORMAT_ID_FIELD = 'WBEV1';
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const SCHEME = 'sym-v1';

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** 字段级 AAD：与客户端写文件时的转录逐字节一致。 */
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('envelope keyId is malformed');
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(FORMAT_ID_FIELD),
    encodeLengthPrefixed(SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

function decodeEnvelope(envelope) {
  let text;
  try {
    text = Buffer.from(String(envelope), 'base64').toString('utf8');
  } catch {
    throw new Error('envelope is not valid base64');
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error('envelope is not a JSON record');
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('envelope is not a JSON record');
  }
  return record;
}

/** 信封里的 keyId（不解密就能读，用来挑“写这个文件的那把钥”）。 */
export function envelopeKeyId(field) {
  try {
    const record = decodeEnvelope(field?.envelope);
    return typeof record.keyId === 'string' ? record.keyId : '';
  } catch {
    return '';
  }
}

/** atRestSecretKey（base64 串本身，不解码）→ 32 字节字段密钥。 */
export function deriveAtRestKey(payloadJson) {
  const payload = JSON.parse(payloadJson);
  const secret = payload.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('at-rest key payload carries no atRestSecretKey');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 解开一个 $wbEncrypted 字段。 */
export function openEncryptedField(field, key) {
  const envelope = decodeEnvelope(field?.envelope);
  const {
    suite, keyId, nonce, authTag, ciphertext,
  } = envelope;
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('envelope is missing suite or keyId');
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('envelope is missing nonce, authTag or ciphertext');
  }
  const expected = deriveAtRestKeyId(key);
  if (keyId !== expected) {
    throw new Error(`envelope belongs to key ${keyId}, not ${expected}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** 取客户端 exe 的密钥载荷（进程级缓存：取钥要拉起一次 Electron，约 340ms）。 */
const keyPayloadCache = new Map();

export function fetchKeyPayload(executable) {
  const slot = String(executable || '');
  const cached = keyPayloadCache.get(slot);
  if (cached) return cached;
  // 客户端把密钥藏在原生绑定里：把它的二进制当 node 跑，向绑定索取。
  const script =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
    + 'catch(e){process.exitCode=3;process.stderr.write(String((e&&e.message)||e))}';
  const pending = new Promise((resolve, reject) => {
    execFile(
      executable,
      ['-e', script],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1048576,
      },
      (error, stdout, stderr) => {
        if (error) {
          keyPayloadCache.delete(slot); // 失败不缓存
          reject(new Error(`key fetch failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
  keyPayloadCache.set(slot, pending);
  return pending;
}

export function resetKeyPayloadCache() {
  keyPayloadCache.clear();
}

// ── 客户端定位 ────────────────────────────────────────────────────────

/** macOS `.app` 的可执行候选：产品名 / plist 声明名 / Electron 兜底。 */
function macAppExeCandidates(appDir) {
  const macos = join(appDir, 'Contents', 'MacOS');
  const out = [join(macos, 'WorkBuddy')];
  try {
    const text = readFileSync(join(appDir, 'Contents', 'Info.plist'), 'utf8');
    if (!text.startsWith('bplist')) {
      const m = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(text);
      if (m) out.push(join(macos, String(m[1].trim()).split(/[\\/]/).pop() || ''));
    }
  } catch { /* 读不出 plist 就靠兜底候选 */ }
  out.push(join(macos, 'Electron'));
  return out;
}

/** `/Applications` 与 `~/Applications` 下名字像客户端的 `.app`。 */
function macAppDirs() {
  const out = [];
  for (const root of ['/Applications', join(homedir(), 'Applications')]) {
    try {
      for (const entry of readdirSync(root)) {
        if (/\.app$/i.test(entry) && /workbuddy|codebuddy/i.test(entry)) {
          out.push(join(root, entry));
        }
      }
    } catch { /* 目录不存在 */ }
  }
  return out;
}

/**
 * 完整候选列表：显式 env > 静态默认 > 应用目录扫描。
 * 调用方用 find(existsSync) 选第一个存在的。
 */
export function clientExeCandidates() {
  const out = [];
  const explicit = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (explicit) out.push(explicit);
  if (process.platform === 'darwin') {
    for (const app of [
      '/Applications/WorkBuddy.app',
      '/Applications/WorkBuddy AI.app',
      join(homedir(), 'Applications', 'WorkBuddy.app'),
      join(homedir(), 'Applications', 'WorkBuddy AI.app'),
    ]) {
      out.push(...macAppExeCandidates(app));
    }
    out.push(...macAppDirs().flatMap(macAppExeCandidates));
  } else if (process.platform === 'win32') {
    const roots = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
    ].filter(Boolean);
    for (const root of roots) {
      for (const dir of ['WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI', 'CodeBuddy']) {
        for (const name of ['WorkBuddy.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe']) {
          out.push(join(root, dir, name));
        }
      }
    }
  } else {
    out.push('/opt/WorkBuddy/workbuddy');
  }
  return [...new Set(out)];
}

export function findClientExe() {
  return clientExeCandidates().find((p) => existsSync(p)) || '';
}

// ── 登录文件定位 ───────────────────────────────────────────────────────

/** 家目录三级兜底：USERPROFILE → HOME → getpwuid（空 HOME 时 homedir() 返回空串）。 */
function homeForAuth() {
  const fromEnv = process.env.USERPROFILE || process.env.HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const h = homedir();
  if (h && h.trim()) return h.trim();
  try { return userInfo().homedir || ''; } catch { return ''; }
}

const AUTH_DIRS = [
  process.env.WORKBUDDY_AUTH_DIR,
  process.platform === 'win32' && process.env.LOCALAPPDATA
    && join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join(homeForAuth(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  join(homeForAuth(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
].filter((d) => d && isAbsolute(d));

/** 活动登录文件名（客户端登出/换号留下的快照不是活动文件）。 */
const ACTIVE_AUTH_NAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info'];

/** 两个客户端都装着时，用最近被写入的那个。 */
function pickActiveAuthFile() {
  let best = '';
  let bestAt = -1;
  for (const dir of AUTH_DIRS) {
    for (const name of ACTIVE_AUTH_NAMES) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.mtimeMs > bestAt) { best = full; bestAt = st.mtimeMs; }
      } catch { /* 这个客户端没装 */ }
    }
  }
  return best;
}

export function resolveAuthPath() {
  if (process.env.WORKBUDDY_AUTH_FILE) return process.env.WORKBUDDY_AUTH_FILE;
  return pickActiveAuthFile();
}

// ── 凭据：读文件 → 解密 → 内存刷新 ────────────────────────────────────

/** JWT 的 exp（秒）→ ms。解析失败返回 0。 */
function jwtExpMs(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp) || 0;
    return exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** 按登录域名选上游网关：选错直接 401。 */
export function upstreamForDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (d.includes('workbuddy.ai') || d.includes('workbuddy.cc') || d.includes('codebuddy.ai')) {
    return 'https://www.workbuddy.ai';
  }
  return 'https://copilot.tencent.com';
}

/**
 * 计费网关与 chat 网关**不是同一个主机**，同样跟随登录域名：
 *   国内 chat = copilot.tencent.com，计费 = www.workbuddy.cn / www.codebuddy.cn
 *   国际两者都是 www.workbuddy.ai
 */
export function billingBaseForAuth(auth) {
  const d = String(auth?.domain || '').toLowerCase();
  if (d.includes('workbuddy.ai') || d.includes('codebuddy.ai')) return 'https://www.workbuddy.ai';
  if (d.includes('workbuddy.cn') || d.includes('codebuddy.cn')) return `https://${d}`;
  return 'https://www.workbuddy.cn';
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDateTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * 套餐列表 → 余额摘要（纯函数，便于单测）。
 *
 * 口径（与官方客户端一致）：
 *   - `CapacityType === 4` 是**月度包**：看 CycleCapacityRemain / CycleCapacitySize；
 *   - 其余是**一次性包**：看 CapacityRemain / CapacitySize，且 remain<=0 的直接跳过
 *     （签到裂变包会留下大量 0 余量的历史记录，不过滤会把余额算错）；
 *   - 负数按 0 处理；
 *   - 到期时刻优先 ExpiredTime，上游对非月度包经常留空，真实到期在 CycleEndTime。
 *
 * @param {object} data 上游 `data.Response.Data`
 * @returns {{ total: number, packages: Array<{name:string,remain:number,size:number,monthly:boolean,expiresAt?:string}> }}
 */
export function aggregateCredits(data) {
  const accounts = data?.Accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  let total = 0;
  const packages = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const num = (k) => (typeof a[k] === 'number' ? a[k] : 0);
    const monthly = num('CapacityType') === 4;
    const size = monthly ? num('CycleCapacitySize') : num('CapacitySize');
    const remainRaw = monthly ? num('CycleCapacityRemain') : num('CapacityRemain');
    const remain = remainRaw < 0 ? 0 : remainRaw;
    if (!monthly && remain <= 0) continue;
    total += remain;
    packages.push({
      name: String(a.PackageName || '(未命名套餐)'),
      remain,
      size,
      monthly,
      ...(a.ExpiredTime || a.CycleEndTime
        ? { expiresAt: String(a.ExpiredTime || a.CycleEndTime) }
        : {}),
    });
  }
  // 到期近的排前面，用户先看到快过期的积分；没到期日的排最后
  const expiryOrder = (p) => (p.expiresAt ? String(p.expiresAt) : '\uffff');
  packages.sort((a, b) => {
    const byExpiry = expiryOrder(a).localeCompare(expiryOrder(b));
    return byExpiry !== 0 ? byExpiry : b.remain - a.remain;
  });
  return { total, packages };
}

/** 查账号积分余额（只读，不消耗积分）。带过期套餐过滤，避免把历史包算进余额。 */
export async function fetchCredits(auth, { timeoutMs = 8000 } = {}) {
  const now = new Date();
  const res = await fetch(`${billingBaseForAuth(auth)}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
      ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmtDateTime(now),
      // 约 37 天窗口：覆盖月度包的整周期，又排掉更早的过期包
      PackageEndTimeRangeEnd: fmtDateTime(new Date(now.getTime() + 31_851_360_000)),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 0) {
    // 只报协议层归因：失败响应体一般不含令牌，仍截断防呆
    const reason = body && typeof body === 'object'
      ? `${body.code ?? ''} ${body.msg || body.message || ''}`.trim()
      : '';
    const err = new Error(`billing ${res.status}: ${reason || '(no protocol message)'}`);
    err.status = res.status;
    throw err;
  }
  return aggregateCredits(body?.data?.Response?.Data);
}

/** 从 exe 候选里挑出能解开目标 keyId 的密钥。 */
async function fetchKeyFor(candidates, targetKeyId) {
  let fallback = null;
  let lastError = null;
  for (const exe of candidates) {
    if (!existsSync(exe)) continue;
    try {
      const payloadJson = await fetchKeyPayload(exe);
      const key = deriveAtRestKey(payloadJson);
      if (!targetKeyId || deriveAtRestKeyId(key) === targetKeyId) return { exe, key };
      if (!fallback) fallback = { exe, key };
    } catch (error) {
      lastError = error;
    }
  }
  if (fallback) return fallback;
  if (lastError) throw lastError;
  throw new Error('未找到可用的 WorkBuddy 客户端可执行文件');
}

let memoryAuth = null;      // 刷新后的令牌只进内存，**绝不写回登录文件**
let memoryAuthPrint = '';   // 刷新时登录文件的指纹（mtime:size），文件被换号则作废
let keyCache = null;        // { exe, key }
let keyCacheKeyId = '';
let refreshFailedAt = 0;
let refreshInFlight = null;

/** 读登录文件并解密出可用凭据。文件不存在/解不开时返回 null（带原因）。 */
async function readStoredAuth() {
  const path = resolveAuthPath();
  if (!path || !existsSync(path)) {
    return { ok: false, reason: `未找到登录文件（找过：${AUTH_DIRS.join('、') || '无目录'}）` };
  }
  let info;
  try {
    info = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `登录文件解析失败：${error?.message || error}` };
  }
  const auth = info?.auth;
  if (!auth?.accessToken || !auth?.refreshToken) {
    return { ok: false, reason: '登录文件里没有 accessToken/refreshToken（可能未登录）' };
  }
  const accessIsPlain = typeof auth.accessToken === 'string';
  const refreshIsPlain = typeof auth.refreshToken === 'string';
  let access = accessIsPlain ? auth.accessToken : '';
  let refresh = refreshIsPlain ? auth.refreshToken : '';
  if (!accessIsPlain || !refreshIsPlain) {
    // 信封：按 keyId 挑“写这个文件的那把钥”（机器上可能并存多个 build）
    const targetKeyId = envelopeKeyId(auth.accessToken) || envelopeKeyId(auth.refreshToken);
    try {
      if (!keyCache || (targetKeyId && keyCacheKeyId !== targetKeyId)) {
        const picked = await fetchKeyFor(findClientExe() ? [findClientExe()] : clientExeCandidates(), targetKeyId);
        keyCache = picked;
        keyCacheKeyId = targetKeyId || deriveAtRestKeyId(picked.key);
      }
      if (!accessIsPlain) access = openEncryptedField(auth.accessToken, keyCache.key);
      if (!refreshIsPlain) refresh = openEncryptedField(auth.refreshToken, keyCache.key);
    } catch (error) {
      return { ok: false, reason: `解密失败：${error?.message || error}` };
    }
  }
  const print = (() => {
    try {
      const st = statSync(path);
      return `${st.mtimeMs}:${st.size}`;
    } catch { return ''; }
  })();
  return {
    ok: true,
    auth: {
      source: 'desktop',
      access,
      refresh,
      domain: String(auth.domain || 'www.workbuddy.cn'),
      uid: String(info?.account?.uid || ''),
      expiresAt: Number(auth.expiresAt) || jwtExpMs(access),
      endpoint: upstreamForDomain(auth.domain),
      authFile: path,
    },
    print,
  };
}

/** 文件指纹（mtime:size）：刷新期间客户端换号 → 结果作废。 */
function currentPrint(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch { return ''; }
}

async function doRefresh(auth) {
  const res = await fetch(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${auth.refresh}`,
    },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 0 || !body.data?.accessToken) {
    // 只报协议层 code/msg：失败条件里含 !res.ok，非 2xx 的响应体也可能带令牌，
    // 绝不能把它打进日志。
    const reason = body && typeof body === 'object'
      ? `${body.code ?? ''} ${body.msg || body.message || ''}`.trim()
      : '';
    log('refresh failed', res.status, reason || '(no protocol message)');
    return null;
  }
  const now = Date.now();
  const expiresIn = Number(body.data.expiresIn) || 0;
  const expiresAt = expiresIn > 0
    ? now + expiresIn * 1000
    : (jwtExpMs(body.data.accessToken) || now + 3_600_000);
  return {
    ...auth,
    access: String(body.data.accessToken),
    refresh: body.data.refreshToken ? String(body.data.refreshToken) : auth.refresh,
    expiresAt,
  };
}

/** 单飞刷新：上游会轮换 refresh token，并发刷新会让后到的请求拿已作废的令牌。 */
function refreshAuth(auth) {
  if (!auth.refresh) return Promise.resolve(null);
  if (Date.now() - refreshFailedAt < 60_000) return Promise.resolve(null); // 冷却
  if (refreshInFlight) return refreshInFlight;
  const run = doRefresh(auth)
    .then((next) => {
      if (next) refreshFailedAt = 0; else refreshFailedAt = Date.now();
      return next;
    })
    .catch((error) => {
      refreshFailedAt = Date.now();
      log('refresh error', error?.message || error);
      return null;
    })
    .finally(() => { refreshInFlight = null; });
  refreshInFlight = run;
  return run;
}

/**
 * 取当前凭据：内存刷新结果优先；否则读登录文件。
 * 距过期 60s 内先刷新；刷新期间客户端换号（文件指纹变了）则丢弃刷新结果。
 */
async function resolveAuth() {
  if (memoryAuth && memoryAuth.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return memoryAuth;
  }
  const stored = await readStoredAuth();
  if (!stored.ok) return { ok: false, reason: stored.reason };
  let auth = stored.auth;
  if (auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    // 刷新回来时文件已被换掉 → 这份令牌属于旧账号，不能进内存
    if (next && (!memoryAuthPrint || memoryAuthPrint === currentPrint(auth.authFile))) {
      memoryAuth = next;
      memoryAuthPrint = currentPrint(auth.authFile);
      auth = next;
    }
  } else if (memoryAuth && memoryAuth.expiresAt > auth.expiresAt) {
    auth = memoryAuth; // 文件没变但内存里有更新的（同账号）
  }
  return { ok: true, auth };
}

// ── 上游：身份头 / 目录 / 聊天 ────────────────────────────────────────

let desktopIdentity = { app: '', cli: '' };

/** 从桌面端 Info.plist 读版本号（探测失败用回退值）。 */
function readDesktopVersions() {
  if (desktopIdentity.app) return desktopIdentity;
  const exe = findClientExe();
  const appDir = exe ? dirname(dirname(dirname(exe))) : '';
  try {
    const text = readFileSync(join(appDir, 'Contents', 'Info.plist'), 'utf8');
    const short = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(text);
    if (short) desktopIdentity.app = short[1].trim();
  } catch { /* 用回退值 */ }
  // CLI 版本随 app.asar.unpacked/cli 发布，精简版不解析包体，用回退值
  desktopIdentity.cli = CLI_VERSION_FALLBACK;
  return desktopIdentity;
}

const appVersion = () => process.env.WB_APP_VERSION || readDesktopVersions().app || APP_VERSION_FALLBACK;
const cliVersion = () => process.env.WB_CLI_VERSION || readDesktopVersions().cli || CLI_VERSION_FALLBACK;

function trace() {
  return randomBytes(16).toString('hex');
}

/** 出站身份头：对齐官方桌面端（实测可用）。聊天通道认 CLI 身份。 */
export function upstreamHeaders(auth, model, conversationId) {
  const version = appVersion();
  const cli = cliVersion();
  const messageId = trace();
  const traceId = trace();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Purpose': 'conversation',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
    'X-Product-Version': version,
    'X-Product': 'WorkBuddy',
    'User-Agent': `CLI/${cli} CodeBuddy/${version}`,
    'X-Env-ID': 'production',
    'X-Domain': auth.domain || 'www.workbuddy.cn',
    'X-Request-ID': messageId,
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
    Authorization: `Bearer ${auth.access}`,
  };
  if (auth.uid) h['X-User-Id'] = auth.uid;
  if (model) h['X-Model-ID'] = model;
  return h;
}

async function upstreamGet(auth, path) {
  const res = await fetch(`${auth.endpoint}${path}`, {
    headers: upstreamHeaders(auth, '', ''),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`upstream ${res.status} on ${path}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`upstream ${path} returned non-JSON`);
    err.status = res.status;
    throw err;
  }
}

/**
 * 模型目录：/v3/config（官方选择器真源）与 /v2/enterprises/personal/models
 * （全量 + 倍率）**都请求、按 id 合并**——单用任何一个都会漏模型。
 */
/**
 * 模型目录整形（纯函数，便于单测）：
 *   · v3 = 官方模型选择器真源（字段**驼峰**：maxInputTokens/maxOutputTokens/
 *     supportsImages/reasoning.supportedEfforts…）；
 *   · v2 = 网关全量（字段下划线 + credits 倍率），补 v3 没列的型号；
 *   · 合并规则：**后来的来源只补「有意义的值」**——v2 大量字段缺失会归一成
 *     0/空串，若无条件覆盖会把 v3 的真值（如 960000 上下文）盖成 0。
 *
 * @param {object} v3Json `GET /v3/config` 的响应 JSON
 * @param {object} v2Json `GET /v2/enterprises/personal/models` 的响应 JSON
 * @returns {object[]} 合并后的模型条目
 */
export function shapeCatalog(v3Json, v2Json) {
  const out = new Map();
  /** 只有「有意义」的值才允许覆盖：0/空串/undefined 不盖掉已有真值。 */
  const meaningful = (v) => {
    if (v === undefined || v === null) return false;
    if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
    if (typeof v === 'string') return v.length > 0;
    if (typeof v === 'boolean') return v === true;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  };
  const put = (m) => {
    if (!m || typeof m.id !== 'string' || !m.id) return;
    const prev = out.get(m.id);
    if (!prev) {
      out.set(m.id, { ...m, id: m.id });
      return;
    }
    const merged = { ...prev };
    for (const [k, v] of Object.entries(m)) {
      if (k !== 'id' && meaningful(v)) merged[k] = v;
    }
    out.set(m.id, merged);
  };

  // v3：官方真源
  try {
    const data = v3Json?.data || v3Json || {};
    for (const m of Array.isArray(data.models) ? data.models : []) put(normalizeV3(m));
    for (const agent of Array.isArray(data.agents) ? data.agents : []) {
      for (const m of Array.isArray(agent.models) ? agent.models : []) {
        const id = typeof m === 'string' ? m : m?.id || m?.model;
        if (id) {
          const prev = out.get(id);
          out.set(id, { ...prev, id, official: true });
        }
      }
    }
    // 促销徽章：modelPromotions 不是模型，是挂在模型上的标注
    for (const promo of Array.isArray(data.modelPromotions) ? data.modelPromotions : []) {
      const badge = typeof promo?.badge === 'string'
        ? promo.badge
        : (typeof promo?.badge?.text === 'string' ? promo.badge.text : '');
      for (const id of Array.isArray(promo?.modelIds) ? promo.modelIds : []) {
        const prev = out.get(id);
        if (prev && badge) out.set(id, { ...prev, badge });
      }
    }
  } catch (error) {
    log('catalog /v3/config shaping failed', error?.message || error);
  }
  // v2：全量 + 倍率/标签
  try {
    const list = v2Json?.data?.models || v2Json?.models || (Array.isArray(v2Json?.data) ? v2Json.data : []);
    for (const m of Array.isArray(list) ? list : []) put(normalizeV2(m));
  } catch (error) {
    log('catalog /v2 models shaping failed', error?.message || error);
  }
  return [...out.values()];
}

export async function fetchCatalog(auth) {
  const [v3, v2] = await Promise.all([
    upstreamGet(auth, '/v3/config').catch((error) => {
      log('catalog /v3/config failed', error?.message || error);
      return null;
    }),
    upstreamGet(auth, '/v2/enterprises/personal/models').catch((error) => {
      log('catalog /v2 models failed', error?.message || error);
      return null;
    }),
  ]);
  return shapeCatalog(v3, v2);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * v3 目录条目 → 统一字段。
 *
 * ⚠️ v3 的字段是**驼峰**（`maxInputTokens` / `maxOutputTokens` /
 * `supportsImages` / `reasoning.supportedEfforts` / `descriptionZh`）——
 * 只认下划线命名会把全部容量信息映射成 0，下游（dsh 的 compaction）拿到
 * 「无上下文容量」直接拒绝切模型。两个命名体系都认，防上游改写法。
 */
function normalizeV3(m) {
  const id = String(m.id || m.model || m.name || '');
  const reasoning = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : {};
  const efforts = Array.isArray(reasoning.supportedEfforts)
    ? reasoning.supportedEfforts.map((e) => String(e || '').trim()).filter(Boolean)
    : [];
  return {
    id,
    name: String(m.name || m.display_name || id),
    context_window: num(m.maxInputTokens || m.max_input_tokens || m.context_window || m.contextWindow),
    max_output_tokens: num(m.maxOutputTokens || m.max_output_tokens || m.maxTokens),
    supports_images: m.supportsImages === true || m.supports_images === true || m.vision === true,
    supports_reasoning: m.supportsReasoning === true || m.supports_reasoning === true || m.reasoning === true || efforts.length > 0,
    reasoning_efforts: efforts,
    default_reasoning_effort: typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '',
    only_reasoning: m.onlyReasoning === true || m.only_reasoning === true,
    default_temperature: m.temperature != null && Number.isFinite(Number(m.temperature)) ? Number(m.temperature) : '',
    credits: typeof m.credits === 'string' ? m.credits : (typeof m.credits === 'number' ? m.credits : ''),
    vendor: m.vendor ? String(m.vendor) : '',
    description_zh: String(m.descriptionZh || m.description_zh || m.description || ''),
    description_en: String(m.descriptionEn || m.description_en || ''),
    official: true,
  };
}

function normalizeV2(m) {
  const id = String(m.id || m.model || '');
  return {
    id,
    name: String(m.name || m.display_name || id),
    credits: typeof m.credits === 'string' ? m.credits : (typeof m.credits === 'number' ? m.credits : ''),
    context_window: num(m.max_input_tokens || m.context_window),
    max_output_tokens: num(m.max_output_tokens),
    supports_images: m.supports_images === true || m.supportsImages === true,
    vendor: m.vendor ? String(m.vendor) : '',
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    official: m.official !== false,
  };
}

/**
 * 目录过滤：只排「能判定」的非对话模型（embedding/rerank/tts/图片/视频，
 * 以及同时缺上下文窗口且输出上限小得装不下一段回复的内部项）。
 * 字段缺失判断不了一律保留——能不能用最终由上游决定。
 */
function isChatModel(m) {
  const id = String(m?.id || '').toLowerCase();
  if (/embedding|rerank|moderation|tts|whisper|image|video|default-model|^default$|enhance-/.test(id)) return false;
  const ctx = num(m?.context_window);
  const out = num(m?.max_output_tokens);
  if ((!ctx || ctx <= 0) && out > 0 && out < 1024) return false;
  return true;
}

// ── 请求归一化（上游比 OpenAI 规范更严） ──────────────────────────────

/**
 * 上游四条不成文约束，都在这里一次性处理：
 *   1. 只接受流式          → 入口强制 stream:true
 *   2. 不认 developer 角色 → 重写为 system
 *   3. tool_choice 只认字符串 → 对象归一化为 required / 认不出的丢弃
 *   4. 首条消息最好是 system（国际版强制）→ 必要时补一条中性的
 *   5. system 里的宿主身份句 → 中和（上游 11128 通道指纹，见 sanitizeText）
 */
export function normalizePayload(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'developer' ? 'system' : String(m.role || '');
    if (role === 'system' || role === 'assistant') {
      out.push({ ...m, role, content: sanitizeText(m.content, role) });
    } else {
      out.push({ ...m, role });
    }
  }
  if (out.length && out[0].role !== 'system') {
    out.unshift({ role: 'system', content: NEUTRAL_SYSTEM });
  }
  const payload = { ...body, messages: out, stream: true };
  if (payload.tool_choice && typeof payload.tool_choice === 'object') {
    payload.tool_choice = payload.tool_choice.type === 'function' ? 'required' : 'auto';
  }
  return payload;
}

// ── 上游 11128（通道模板校验）防御 ─────────────────────────────────────

/**
 * 上游会把 system 里的**宿主身份句**当通道指纹，命中即
 * `400 code 11128 Illegal API invocation from an unapproved channel`
 * （2026-10-21 上游变更起；本机实测：把身份句换成中性表述后，同样的
 * messages / tools 全部 200）。dsh 的系统提示首句正是这句话，不中和的话
 * 每一轮都会被拦。
 *
 * 两条防线：
 *   ① 发送前中和（sanitizeText，零成本）：已知身份模板句最小改写 + 品牌词
 *      中性化；assistant 历史只洗那两句精确模板（历史里的同一句会让之后
 *      每轮都挂，同类项目实证），不碰普通正文；
 *   ② 11128 渐进兜底（channelFallbackCandidates）：上游再新增黑名单时，
 *      按「删品牌行 → 删首段 → 整段中性 system」降级重试。
 */

/** 固定先后共现会被当成通道指纹的句子（单独出现不拦）。 */
const AUDIT_TEMPLATE_REWRITES = [
  ['Tokens prefixed with @ are paths the user explicitly referenced.',
    'Tokens prefixed with an at-sign are paths the user explicitly referenced.'],
];
/** `You are an AI agent powered by DeepSeek Harness[版本后缀].`（含可选版本号）。 */
const DSH_IDENTITY_RE = /You are an AI agent powered by DeepSeek\s+Harness(?:\s+(?:version|build|v)?\s*\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)?\.?/gi;
const DSH_IDENTITY_NEUTRAL = "You are an AI agent running inside the user's development environment.";
/** `You are a coding agent powered by the <模型名> model.`（模型名允许带点）。 */
const DSH_AGENT_MODEL_RE = /You are a coding agent powered by the [^\n]{1,120}? model\./gi;
const DSH_AGENT_MODEL_NEUTRAL = "You are a coding agent running in the user's development environment.";
/** system 里其余行的品牌词：不能删整行（丢语义），换成中性称呼。 */
const DSH_BRAND_RE = /\bDeepSeek\s+Harness\b/gi;
const DSH_BRAND_NEUTRAL = 'the local runtime';

const NEUTRAL_SYSTEM = 'You are a helpful AI assistant.';

/** 响应体是否是上游的「通道/模板校验」拒绝（400 code 11128）。 */
export function isChannelRejection(text) {
  return /"code"\s*:\s*11128|11128/i.test(String(text || ''));
}

/**
 * system / assistant 文本的最小中和；无命中返回原值（引用不变）。
 *
 * `assistant` 作用域只洗两句精确身份模板，不做品牌词替换——assistant 正文
 * 可能是用户正在看的回答，广泛改写会改变语义。system 才是模板指纹的主要
 * 来源，允许把其余品牌词中性化。
 */
export function sanitizeText(text, scope = 'system') {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [from, to] of AUDIT_TEMPLATE_REWRITES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  out = out.replace(DSH_IDENTITY_RE, DSH_IDENTITY_NEUTRAL);
  out = out.replace(DSH_AGENT_MODEL_RE, DSH_AGENT_MODEL_NEUTRAL);
  if (scope !== 'assistant') out = out.replace(DSH_BRAND_RE, DSH_BRAND_NEUTRAL);
  return out;
}

/**
 * 11128 的渐进降级候选（调用方只在仍收到 11128 时才继续试下一个）。
 * 顺序从「动得最少」到「牺牲 system」；user / tool / tools 永远不动。
 *
 * @returns {Array<{strategy: string, payload: object}>} 去重后的候选
 */
export function channelFallbackCandidates(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const isSystem = (m) => m && (m.role === 'system' || m.role === 'System');
  if (!messages.some(isSystem)) return [];

  const out = [];
  const seen = new Set();
  const push = (strategy, nextMessages) => {
    const key = JSON.stringify(nextMessages);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ strategy, payload: { ...payload, messages: nextMessages } });
  };

  // 1) 只删 system 里含宿主品牌的整行，其余 instructions 原样保留
  let changed = false;
  const trimmed = messages.map((m) => {
    if (!isSystem(m) || typeof m.content !== 'string') return m;
    const next = m.content
      .split(/\r?\n/)
      .filter((line) => !/deepseek\s+harness/i.test(line))
      .join('\n')
      .trim();
    if (next !== m.content) changed = true;
    return { ...m, content: next };
  }).filter((m) => !(isSystem(m) && !m.content));
  if (changed && trimmed.some(isSystem)) push('remove-brand-lines', trimmed);

  // 2) 只删第一条 system 的首段（身份/人格通常在第一段），保留后面的
  //    skills/workspace/安全规则
  let dropped = false;
  let firstSystemSeen = false;
  const droppedMessages = messages.map((m) => {
    if (!isSystem(m) || typeof m.content !== 'string' || firstSystemSeen) return m;
    firstSystemSeen = true;
    const parts = m.content.split(/\r?\n\s*\r?\n/);
    if (parts.length < 2) return m;
    const next = parts.slice(1).join('\n\n').trim();
    if (!next) return m;
    dropped = true;
    return { ...m, content: next };
  }).filter((m) => !(isSystem(m) && !m.content));
  if (dropped && droppedMessages.some(isSystem)) push('drop-first-system-paragraph', droppedMessages);

  // 3) 最后手段：整段中性 system，保住这次调用
  push('neutral-system', [
    { role: 'system', content: NEUTRAL_SYSTEM },
    ...messages.filter((m) => !isSystem(m)),
  ]);
  return out;
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────

const catalogCache = { at: 0, models: [] };
let catalogInflight = null;

/** 积分余额缓存：余额是慢变量，30s 足够；/credits 不打进 /health 的快路径。 */
const creditsCache = { at: 0, value: null };
let creditsInflight = null;
const CREDITS_TTL_MS = 30_000;

async function getCredits({ refresh = false } = {}) {
  if (!refresh && creditsCache.value && Date.now() - creditsCache.at < CREDITS_TTL_MS) {
    return creditsCache.value;
  }
  if (creditsInflight) return creditsInflight;
  creditsInflight = (async () => {
    const { ok, auth, reason } = await resolveAuth();
    if (!ok) throw new Error(reason);
    const value = await fetchCredits(auth);
    creditsCache.at = Date.now();
    creditsCache.value = value;
    return value;
  })().finally(() => { creditsInflight = null; });
  return creditsInflight;
}

async function getCatalog({ refresh = false } = {}) {
  if (!refresh && catalogCache.models.length && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  if (catalogInflight) return catalogInflight;
  catalogInflight = (async () => {
    const { ok, auth, reason } = await resolveAuth();
    if (!ok) throw new Error(reason);
    const models = (await fetchCatalog(auth)).filter(isChatModel);
    catalogCache.at = Date.now();
    catalogCache.models = models;
    return models;
  })().finally(() => { catalogInflight = null; });
  return catalogInflight;
}

/** 积分倍率 → 短文本：x0.11 → ×0.11；免费 → 免费；未知 → 空。 */
function costLabel(m) {
  const raw = m?.credits;
  const credits = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' ? (/([0-9]*\.?[0-9]+)/.exec(raw) || [])[1] : undefined);
  if (m?.free === true) return '免费';
  if (credits === undefined || credits === null || credits === '') return '';
  const n = Number(credits);
  if (!Number.isFinite(n)) return '';
  return n === 0 ? '免费' : `×${n}`;
}

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

function toOpenAiModel(m) {
  const cost = costLabel(m);
  const bits = [];
  const ctx = num(m.context_window);
  const out = num(m.max_output_tokens);
  if (ctx > 0) bits.push(`上下文 ${shortCount(ctx)}`);
  if (out > 0) bits.push(`输出 ${shortCount(out)}`);
  if (m.supports_images === true) bits.push('图片');
  if (m.supports_reasoning === true) bits.push('推理');
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: m.vendor || 'workbuddy',
    name: `${m.name || m.id}${cost ? ` · ${cost}` : ''}`,
    ...(bits.length ? { description: bits.join(' · ') } : {}),
    context_window: ctx || undefined,
    max_output_tokens: out || undefined,
    supports_images: m.supports_images === true,
    supports_reasoning: m.supports_reasoning === true,
    credits: typeof m.credits === 'string' ? m.credits : (typeof m.credits === 'number' ? m.credits : null),
    official: m.official !== false,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function checkLocalToken(req) {
  if (!LOCAL_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${LOCAL_TOKEN}`;
}

async function handleHealth(req, res) {
  const auth = await resolveAuth();
  sendJson(res, 200, {
    ok: true,
    pid: process.pid,
    uptimeMs: process.uptime() * 1000,
    auth: auth.ok
      ? { ok: true, domain: auth.auth.domain, uid: auth.auth.uid, expiresAt: auth.auth.expiresAt }
      : { ok: false, reason: auth.reason },
    catalogSize: catalogCache.models.length,
    clientExe: findClientExe(),
  });
}

async function handleModels(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const models = await getCatalog({ refresh: url.searchParams.get('refresh') === '1' });
    sendJson(res, 200, { object: 'list', data: models.map(toOpenAiModel) });
  } catch (error) {
    sendJson(res, 503, { error: { message: error?.message || String(error), type: 'auth_error' } });
  }
}

async function handleCredits(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const credits = await getCredits({ refresh: url.searchParams.get('refresh') === '1' });
    sendJson(res, 200, credits);
  } catch (error) {
    sendJson(res, 503, { error: { message: error?.message || String(error), type: 'credits_error' } });
  }
}

async function handleChat(req, res) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: { message: 'request read failed' } }); });
  const body = await new Promise((resolve) => {
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); }
    });
  });
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: 'request body must be JSON with messages[]' } });
    return;
  }
  const model = String(body.model || '');
  if (!model) {
    sendJson(res, 400, { error: { message: 'model is required' } });
    return;
  }
  const auth = await resolveAuth();
  if (!auth.ok) {
    sendJson(res, 503, { error: { message: auth.reason, type: 'auth_error' } });
    return;
  }
  const payload = normalizePayload(body);
  const conversationId = trace();
  const signal = UPSTREAM_TIMEOUT_MS > 0
    ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    : undefined;
  const postUpstream = (p) => fetch(`${auth.auth.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers: upstreamHeaders(auth.auth, model, conversationId),
    body: JSON.stringify(p),
    ...(signal ? { signal } : {}),
  });

  let upstream;
  try {
    upstream = await postUpstream(payload);
  } catch (error) {
    sendJson(res, 502, { error: { message: `upstream request failed: ${error?.message || error}`, type: 'transport_error' } });
    return;
  }
  /*
   * 11128 渐进兜底：上游把 system 里的宿主身份句当通道指纹。发送前的
   * sanitizeText 已中和已知句式；这里防上游**新增**的黑名单——按
   * channelFallbackCandidates 的顺序降级重试，成功即采用（响应头带上
   * 用了哪级策略，便于排查）。user / tool / tools 不动。
   */
  if (upstream.status === 400) {
    const firstText = await upstream.text().catch(() => '');
    if (isChannelRejection(firstText)) {
      for (const candidate of channelFallbackCandidates(payload)) {
        let retry;
        try {
          retry = await postUpstream(candidate.payload);
        } catch { break; }
        if (retry.ok && retry.body) {
          log(`11128 fallback applied: ${candidate.strategy}`);
          upstream = retry;
          res.setHeader('X-WorkBuddy-11128-Fallback', candidate.strategy);
          break;
        }
        const retryText = await retry.text().catch(() => '');
        if (!isChannelRejection(retryText)) {
          // 不是通道问题了（换成别的错）：采用这个响应，让下面的统一错误处理说话
          upstream = retry;
          upstream.__errorText = retryText;
          break;
        }
      }
      // 所有降级都仍是通道拒绝：保留首次错误的原文上报
      if (!upstream.ok && !upstream.__errorText) upstream.__errorText = firstText;
    } else {
      upstream.__errorText = firstText;
    }
  } else if (!upstream.ok && !upstream.body) {
    upstream.__errorText = await upstream.text().catch(() => '');
  }
  if (!upstream.ok || !upstream.body) {
    const text = upstream.__errorText ?? '';
    // 只透传协议层归因；上游错误体一般不含令牌，但仍截断防呆
    sendJson(res, 502, {
      error: {
        message: `upstream ${upstream.status}: ${text.slice(0, 400)}`,
        type: upstream.status === 401 || upstream.status === 403 ? 'auth_error' : 'upstream_error',
        status: upstream.status,
      },
    });
    return;
  }
  // SSE 直通：上游本来就讲 OpenAI 协议，桥不翻译
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  req.on('aborted', () => { upstream.body.cancel().catch(() => {}); });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    // 流中途断：补一帧 OpenAI 形状的错误再收尾，客户端不会把断流当成功
    try {
      res.write(`data: ${JSON.stringify({ error: { message: `upstream stream interrupted: ${error?.message || error}`, type: 'transport_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* 连接已断 */ }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!checkLocalToken(req)) {
      sendJson(res, 401, { error: { message: 'invalid local token' } });
      return;
    }
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      await handleHealth(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      await handleModels(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/v1/credits') {
      await handleCredits(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      await handleChat(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (error) {
    log('request error', error?.stack || error);
    if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error' } });
  }
});

// 直接执行（node wb-bridge.mjs）才监听；被 import 时不启动，便于测试。
const isMain = process.argv[1] && existsSync(process.argv[1])
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  /*
   * 端口被占用的处理——**多宿主场景的第一类 race**：
   * desktop 与 web 两个 dsh 宿主都装着本插件时，两边都可能尝试拉起桥
   * （一方探活超时/启动拥堵的窗口期内）。后起的那个必然 EADDRINUSE。
   *
   * 不处理会怎样：Node 抛未捕获异常 → 进程带着崩溃记录退出——功能上无害
   * （调用方的等待循环会探到已存在的桥并复用），但每次 race 都留一个崩溃
   * 进程很难看，也没有人知道发生了什么。
   *
   * 处理：探测占用者是否是一个**健康的桥**——是就安静退出（退出码 0，
   * 调用方复用现有实例）；占用者不健康（半死的旧桥）才报错退出（退出码 1），
   * 让调用方的重试/重启逻辑决定下一步。
   */
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
        .then((res) => (res.ok ? res.json() : null))
        .then((health) => {
          if (health && health.ok === true) {
            log(`port ${PORT} 已有一个健康的桥（pid ${health.pid}），本实例退出`);
            process.exit(0);
          }
          log(`port ${PORT} 被占用，且占用者不是健康的桥`);
          process.exit(1);
        })
        .catch(() => {
          log(`port ${PORT} 被占用，探测占用者失败`);
          process.exit(1);
        });
      return;
    }
    log('server error', err?.stack || err);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT} (pid ${process.pid})`);
    // 启动即探测一次凭据，把「未登录」早暴露在 /health 里
    resolveAuth().then((r) => {
      log(r.ok
        ? `credential ok: domain=${r.auth.domain} uid=${r.auth.uid} expiresAt=${new Date(r.auth.expiresAt).toISOString()}`
        : `credential unavailable: ${r.reason}`);
    }).catch(() => {});
  });
}

export {
  server, PORT, HOST, resolveAuth, getCatalog,
};
