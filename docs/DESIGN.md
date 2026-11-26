# models-from-wb — 在 DSH 中使用 WorkBuddy 模型能力：设计与实现

> 参照项目：[Ianzhyh/workbuddy-to-dsh](https://github.com/Ianzhyh/workbuddy-to-dsh)（MIT）。
> 本项目是它的**精简重写**：只保留「把本机 WorkBuddy 已登录模型接进 dsh」这一件事，
> 去掉多账号池、插件登录、控制台、签到、图片/视频生成、中英面板等重型能力。
> 设计结论均在本机（macOS 15 / WorkBuddy 5.9.x / dsh desktop）实测验证过。

---

## 一、WorkBuddy 的授权认证方式（实测结论）

### 1.1 凭据存放：登录文件 + AtRest 信封

WorkBuddy 桌面端（腾讯，Electron 应用，bundle id `com.tencent.workbuddy.mac`）把登录态写在
一个 JSON 文件里，**按平台不同**：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| Linux | `~/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

国内版文件名是 `workbuddy-desktop.info`，国际版是 `workbuddy-desktop-ai.info`。
客户端登出/换号会留下 `workbuddy-desktop.<时间戳>.info` 快照（非活动文件）。

文件结构（本机实测脱敏）：

```jsonc
{
  "auth": {
    "accessToken":  { "$wbEncrypted": 1, "envelope": "<base64, 2784 字符>" },
    "refreshToken": { "$wbEncrypted": 1, "envelope": "<base64, 2788 字符>" },
    "tokenType": "Bearer",
    "domain": "www.workbuddy.cn",
    "expiresAt": 1798000477302,
    "refreshExpiresAt": 1798173276302
  },
  "account": { "uid": "<uuid>", "uin": "<数字账号>", "type": "personal", … },
  "accounts": [ … ], "allAccounts": [ … ]
}
```

自 **5.6.0** 起，敏感字段不再是明文，而是 AES-256-GCM 信封：

```
envelope = base64( JSON { suite, keyId, nonce, authTag, ciphertext } )
```

### 1.2 密钥从哪来：客户端自己的 Electron 原生绑定

**密钥不落盘。** 它来自客户端构建期常量 `atRestSecretKey`，只通过客户端自己的
Electron 原生绑定暴露。做法是把客户端可执行文件当普通 Node 跑一遍
（`ELECTRON_RUN_AS_NODE=1`），向它的原生绑定索取：

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/WorkBuddy.app/Contents/MacOS/Electron" -e \
  "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
```

返回（结构示意，值为脱敏样例）：

```json
{ "version": 1,
  "atRestSecretKey": "<base64，44 字符>",
  "atRestDeveloperPublicKey": { "alg": "RSA-OAEP-256", "id": "<hex>", "key": "<PEM base64>" } }
```

派生与解密（与客户端同口径，本机实测解出 JWT）：

```
key   = SHA256( atRestSecretKey 字符串本身 )        # 哈希 base64 串，不是解码后的字节
keyId = SHA256( key ).hex.slice(0, 16)             # 与信封 keyId 比对，不符即报错
plain = AES-256-GCM(key, nonce, authTag, ciphertext, AAD)
```

AAD 按固定转录拼接，写错一位 tag 校验就失败：

```
"WB-AAD\0" | 0x01 | len("WBEV1") | len("sym-v1") | uint32BE(suite) | len(keyId) | 0x02 | 0x00 | 0x00
len(s) = uint32BE(utf8 字节长度) + utf8 字节
```

本机实测结果：accessToken / refreshToken 均为 RS256 JWT（约 1.5K 字符），
信封里的昵称、手机号等字段同样可解开。

### 1.3 客户端可执行文件定位（macOS 优先）

Electron 应用的可执行文件名由 plist 声明，不一定等于产品名（腾讯 5.8.x 的包里
`Contents/MacOS/` 下只有 `Electron`）。探测顺序：

1. `WORKBUDDY_APP_EXECUTABLE` 环境变量（显式覆盖）；
2. 静态候选：`/Applications/WorkBuddy.app`、`~/Applications/WorkBuddy.app` 等，
   每个 `.app` 取 `Contents/MacOS/{WorkBuddy, plist声明名, Electron}`；
3. 扫描 `/Applications`、`~/Applications` 下名字含 `workbuddy`/`codebuddy` 的 `.app`。

### 1.4 令牌刷新（不写回登录文件）

```
POST {endpoint}/v2/plugin/auth/token/refresh
Authorization: Bearer <refreshToken>
→ { code: 0, data: { accessToken, refreshToken, expiresIn, … } }
```

**刷新结果只留在桥的内存里，绝不写回登录文件** —— 登录文件是加密存储，
写明文会破坏客户端凭据、迫使用户重新登录。

---

## 二、上游 API 契约（本机实测）

### 2.1 双网关：按登录域名选，选错直接 401

| 登录域名 | chat 网关 |
|---|---|
| `www.workbuddy.cn` / `www.codebuddy.cn`（国内） | `https://copilot.tencent.com` |
| `workbuddy.ai` / `workbuddy.cc`（国际） | `https://www.workbuddy.ai` |

### 2.2 聊天：OpenAI 协议 + 四条不成文约束

`POST {网关}/v2/chat/completions`，请求体就是 OpenAI Chat Completions。
上游比规范更严，直接转发会被 400：

| 约束 | 上游响应 | 桥的处理 |
|---|---|---|
| 只接受流式（`stream:true`） | `400 code 11101` | 非流式请求内部转流式再聚合 |
| 不识别 `developer` 角色 | `400 code 11128` | 重写为 `system` |
| `tool_choice` 只认字符串 | `400 code 11101` | 对象形式归一化为 `required`/丢弃 |
| 校验调用方身份 | `400 code 11128` | 请求头伪装成官方客户端 |

身份头（对齐官方桌面端，实测可用）：

```
Authorization: Bearer <accessToken>
User-Agent: CLI/2.165.0 CodeBuddy/5.9.3        # 聊天通道认 CLI 身份
X-IDE-Type / X-IDE-Name: WorkBuddy
X-IDE-Version / X-Product-Version: 5.9.3
X-Product: WorkBuddy
X-Agent-Purpose: conversation
X-CodeBuddy-Request: 1
X-Env-ID: production
X-Domain: www.workbuddy.cn
X-User-Id: <account.uid>
X-Request-ID / X-Conversation-ID / X-Request-Trace-Id / b3 等追踪头
```

### 2.3 模型目录：两个端点合并

| 端点 | 内容 |
|---|---|
| `GET /v3/config` | 官方模型选择器真源：`data.models` + `data.agents[].models` |
| `GET /v2/enterprises/personal/models` | 网关全量（带 `credits` 倍率、厂商标签） |

单用任何一个都会漏模型（实测国际版能调通 `deepseek-v4.1-flash` 但它不在任何目录里）。
本机账号实测 **37 个模型**：GLM-5.4/5.3/5.2、DeepSeek-V4-Flash/V4.1-Flash/V4-Pro/V3.2、
Kimi-K3/K2.5、MiniMax-M2.5/M3.1-Flash、Hunyuan-2.0-Thinking、Step-5-Preview、
MiMo-V2.6-Pro 等；`hy4flash-free` 为 `x0.00` 免费档。

**倍率展示规则**：`×0.11` = 每次调用扣 0.11 倍积分；「免费」只认上游显式
`x0.00` / `free:true`；「未知倍率」不标免费——把未知当免费是对用户的钱包撒谎。
倍率同时进模型名后缀（选择器逐字渲染 name）与模型详情 description。

**两个实测踩过的坑**（2026-11-26 修复，commit `修复切模型被 compaction 拒绝`）：

1. **v3 的字段是驼峰**（`maxInputTokens` / `maxOutputTokens` / `supportsImages` /
   `descriptionZh` / `reasoning.supportedEfforts`），v2 才是下划线。只认一种命名
   会把容量信息全部映射成 0——下游症状是 dsh 切模型时报
   `no context capacity … configure contextWindow`，与凭据/网络毫无关系，极难误判。
2. **合并不能无条件覆盖**：v2 条目大量字段缺失、归一成 0/空串，`{...v3, ...v2}`
   会把 v3 的 960000 上下文盖成 0。合并规则改为「后来的来源只补有意义的值」。

**上下文容量必须始终给**：dsh 的 compaction-basic 拿不到 `contextWindow` 就拒绝
切模型。适配器因此总是返回容量——真实值优先，目录缺失（少数路由别名型号）时给
保守下限 32K：低估只会让 dsh 更早压缩（安全方向），高估会把超长请求发给上游、
换一个 400。

### 2.4 计费：余额查询（只读，不消耗积分）

计费网关与 chat 网关**不是同一个主机**，跟随登录域名：

| 账号 / 区域 | chat | 计费 |
|---|---|---|
| 国内（`www.workbuddy.cn`） | `copilot.tencent.com` | `www.workbuddy.cn` |
| 国际（`www.workbuddy.ai`） | `www.workbuddy.ai` | `www.workbuddy.ai` |

`POST /v2/billing/meter/get-user-resource`，响应 `data.Response.Data.Accounts[]`
（套餐列表）。聚合口径：

- `CapacityType === 4` 是**月度包**：看 `CycleCapacityRemain` / `CycleCapacitySize`；
- 其余是**一次性包**：看 `CapacityRemain` / `CapacitySize`，且 `remain <= 0` 跳过
  （签到裂变包会留下大量 0 余量历史记录，不过滤会把余额算错）；
- 负数按 0；到期时刻 `ExpiredTime` 优先，上游对非月度包经常留空，真实到期在
  `CycleEndTime`；
- 请求体带过期过滤（`Status:[0,3]` + `PackageEndTimeRange` 约 37 天窗口），
  只返回有效套餐。

本机实测：过滤掉 0 余量的历史签到记录后，剩余有效套餐的余额加总与官方客户端
展示的积分余额一致（个人账号常见形态：若干「裂变包」+ 少量权益包）。

---

## 三、整体架构

```
┌─────────────────────────────────────────────┐
│ DeepSeek Harness（模型选择器 / 对话）        │
└───────────────┬─────────────────────────────┘
                │ ctx.llm.stream({ provider:'workbuddy', … })
                ▼
┌─────────────────────────────────────────────┐
│ dsh 插件（plugin/，cordis bundle）           │
│  lib/index.js   拉起桥进程 + 注册路由         │
│  lib/adapter.mjs  dsh 词汇 ↔ OpenAI 词汇     │
└───────────────┬─────────────────────────────┘
                │ HTTP 127.0.0.1:8790/v1
                ▼
┌─────────────────────────────────────────────┐
│ 本地桥（plugin/bridge/wb-bridge.mjs）        │
│  ① 定位客户端 exe → 取 AtRest 密钥 → 解密    │
│  ② 过期前内存刷新（不写回文件）              │
│  ③ 注入官方身份头                            │
│  ④ 非流式→流式、developer→system 等归一化    │
└───────────────┬─────────────────────────────┘
                │ POST /v2/chat/completions（SSE 直通）
                ▼
        copilot.tencent.com（APISIX 网关）
```

**分工原则：桥管「凭据 + 上游」，适配器管「dsh 词汇」。**
上游本来就讲 OpenAI 协议，所以两边都不做协议转换，只各补各的缺口。

---

## 四、模块划分与职责

### 4.1 `plugin/bridge/wb-bridge.mjs`（本地桥，单文件零依赖）

只监听 `127.0.0.1`，端口默认 8790（`WB_PORT` 覆盖）。

| 路由 | 说明 |
|---|---|
| `GET /health` | 桥存活 + 凭据状态（毫秒级，不等上游） |
| `GET /v1/models` | 合并 `/v3/config` + `/v2/enterprises/personal/models`，60s 缓存 |
| `POST /v1/chat/completions` | OpenAI 兼容；强制流式转发，SSE 直通 |
| `GET /v1/credits` | 积分余额（§2.4 聚合），30s 缓存，`?refresh=1` 强制刷新 |

内部模块（同文件内分区）：

- `findClientExe()` — §1.3 的定位算法
- `atRest` — §1.2 的取钥/派生/解密（按 exe 缓存密钥 payload）
- `resolveAuth()` — 读登录文件 → 解密 → 必要时刷新（单飞 + 冷却）
- `upstreamHeaders()` — §2.2 身份头
- `normalizePayload()` — developer→system、tool_choice 归一化、首条消息补 system
- `aggregateCredits()` — 余额聚合纯函数（月度/一次性口径，§2.4）
- 路由与错误映射（上游 4xx/5xx → 带归因的 502，**绝不在响应里泄露令牌**）

### 4.2 `plugin/lib/adapter.mjs`（dsh LLM 适配器）

普通对象（不 import 任何 `@deepseek-ai/*` 包——profile 的 node_modules 里解析不到，
且 dsh 的 `registerAdapter` 只调用 `providerInfo`/`providerRetryPolicy`，无 instanceof 检查）：

| 方法 | 行为 |
|---|---|
| `providerInfo(provider)` | `{ id, name: 'WorkBuddy' }`（注册时同步调用，不能有 I/O） |
| `providerRetryPolicy()` | normal 模式、最多 2 次重试，只重试限流/5xx/传输/超时 |
| `listModels(provider)` | 桥目录 → `LlmModelInfo[]`（id/name/description/inputModalities） |
| `resolveModel(provider, model)` | 上下文窗口、输出上限、推理档位 |
| `prepareCall` / `stream(options)` | 组 OpenAI 请求 → 打桥 → SSE 逐帧转 `StreamChunk` |

`StreamChunk` 顺序契约：`block-start → *-delta → block-end`，末尾 `usage → finish`；
**任何失败都以 `finish` 块收尾**（`kind:'error'`），绝不向调用方抛。
`TokenUsage` 桶必须自洽：`totalTokens = input + output + cacheRead + cacheWrite`。

错误分类：上游 401/403→AUTH、6004/14018/402→QUOTA、429/6003→RATE_LIMIT、
11115/上下文→CONTEXT_WINDOW_EXCEEDED、11133/400→INVALID_REQUEST、5xx→SERVER、
流中断→TRANSPORT，其余 PROVIDER_ERROR。

### 4.3 `plugin/lib/index.js`（宿主端）

```
export const name = 'workbuddy';
export const inject = ['llm'];
export function apply(ctx, config) { … }
```

1. **桥生命周期**：启动时探测 `127.0.0.1:8790/health`，没活就 `spawn` 一个 detached 进程
   （`ELECTRON_RUN_AS_NODE=1` 确保用 node 模式跑，宿主是 Electron）；桥被杀死后，
   下一次模型调用/命令会自动把它拉回来（`ensureReady`，5 秒 TTL 缓存探活结论）。
2. **注册路由**：`ctx.llm.registerAdapter(['workbuddy'], adapter)`，失败退避重试。
3. **积分入口**：工具 `workbuddy_credits`（agent 可调）+ 斜杠命令
   `/workbuddy credits|models`（人直接打）。契约按本机 dsh 0.2.2-rc.5 核对：
   工具是普通对象 `{name, description, parameters(JSON Schema), output:{schema, render}, execute}`，
   `register` 只校验 `output.render` 与 `output.schema`；命令 `{name, description,
   input:{hint}, handler({rawInput})→{kind,text}}`。均不 import `@deepseek-ai/*`。

### 4.4 多宿主：desktop 与 web 共用一个桥

插件可以同时装进多个 profile（`desktop` 桌面应用 / `web` 浏览器 CLI，安装互相独立）。
两个宿主都加载插件时：

```
desktop 宿主 ──探活 8790──┐
                          ├─▶ 一个桥进程（先到先拉，后到探活复用）
web 宿主     ──探活 8790──┘
```

- **探活复用**：`ensure()` 先 `GET /health`，活着就直接用，不重复拉；
- **端口竞争**：若两边同时拉（一方探活超时的窗口期），后起者 `EADDRINUSE` ——
  此时探测占用者是否是健康桥：是则安静退出（0，调用方复用现有实例），
  否则报错退出（1）。不留崩溃进程，也不假装成功；
- **按需重拉**：桥被杀死后，下一次模型调用/命令会自动把它拉回来
  （`ensureReady`，5 秒 TTL 缓存探活结论）。

浏览器访问 Web GUI 需要**带 token 的 URL**（dsh 的浏览器会话认证，每次启动
打印）；裸 URL 返回 401 是设计行为。桌面应用窗口内部即带认证，无需浏览器。

### 4.5 bundle 元数据

`plugin/package.json`（`dsh.bundle.patch` 指向 `cordis.patch.yml`）+ `cordis.patch.yml`
（insert 一条 Loader 行：`id: models-from-wb`，`name: models-from-wb`）+
`icon.svg` + `locale/{en,zh}.json`。

---

## 五、与参考项目的差异（精简点）

| 能力 | 参考项目 | 本项目 |
|---|---|---|
| 凭据来源 | 桌面端 + 插件内浏览器登录（设备码） | 只用桌面端已登录态 |
| 账号 | 多账号切换/快照/合并/自动切号 | 单账号（当前活动登录文件） |
| 桥功能 | chat + 搜索 + 图片 + 视频 + 签到 + 限流统计 + 用量账本 | chat + 模型目录 + 积分余额 + /health |
| 积分/倍率展示 | 聊天页胶囊 + 每轮成本 + 趋势图 + 设置页 9 标签 + 网页控制台 | 选择器倍率后缀 + `/workbuddy credits\|models` + `workbuddy_credits` 工具 |
| 协议 | OpenAI + Anthropic + Responses 三套 | 仅 OpenAI Chat Completions |
| 平台 | Windows 实测优先 | macOS 优先（Windows 路径保留） |

参考项目的成熟度远高于本精简版（16k 行桥 + 1500 行适配器 + 上百测试）。
**要功能全就用现成插件**（`github:Ianzhyh/workbuddy-to-dsh`）；要可读、可改、可学习，
用本项目。

---

## 六、风险与边界（诚实声明）

1. **非官方路径**：依赖 WorkBuddy 未公开的上游协议与登录文件格式，上游随时可能改协议或
   收紧风控，**可用性无保证、不承诺兼容性**。把它当「随时可能失效的互操作性实现」。
2. **只驱动自己的账号**：只读本机已登录凭据，消耗该账号自身配额。请勿用于多账号池化、
   代他人调用、转售/托管——最容易触发上游风控，殃及所有用户。
3. **请确认符合 WorkBuddy 服务条款**；条款不允许就不要用。
4. **密钥获取要跑一次客户端二进制**（约 340ms，进程内缓存）：这是客户端自己设计的
   暴露方式，但确实依赖客户端原生绑定名称 `electron_browser_workbuddy_storage` 不变。
5. **凭据只进内存**：解密结果与刷新令牌不落盘（日志也绝不打印令牌）。
