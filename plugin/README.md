# models-from-wb

把本机 **WorkBuddy** 桌面端已登录的模型（DeepSeek / GLM / Kimi / MiniMax / 混元等）
经一个本地桥接进 **DeepSeek Harness**：桌面端登录后，模型选择器里直接多出
`workbuddy` 一路，不需要任何 API Key、Base URL 或配置文件。

## 前置条件

1. 本机装有 WorkBuddy 桌面端**并且已登录**（macOS：`/Applications/WorkBuddy.app`；
   Windows：默认安装目录）。
2. Node.js ≥ 18（桥是零依赖的单文件脚本）。
3. dsh ≥ 1.8.0（插件登录/原生路由所需的运行时能力；本插件只用 `registerAdapter`）。

## 安装

插件是一个普通 dsh bundle，**每个 profile 独立安装**（desktop 桌面应用与 web
浏览器 CLI 是两个 profile，装互不影响）：

| 用法 | 安装方式 |
|---|---|
| dsh desktop | 设置 → 插件 → 添加插件，填本仓库 `plugin/` 目录的绝对路径；重启一次 dsh |
| dsh web | `dsh plugin --profile web add <plugin 目录绝对路径>`，然后重启 web 实例 |

两个宿主的插件**共用一个桥**（`127.0.0.1:8790`，先到先拉、后到探活复用），
同时启动时的端口竞争有专门处理（占用者是健康桥就安静退出）。

## 使用

1. 确认 WorkBuddy 桌面端已登录；
2. 在 dsh 的模型选择器里选 `WorkBuddy` 分组的任一模型。**免费模型排最前，其余按
   积分倍率升序，倍率未知的排最后**（dsh 的选择器不自己排序，顺序由适配器的
   `listModels` 决定；同组内保持上游目录原序）。倍率同时写在模型名后缀
   （`DeepSeek-V4.1-Flash · ×0.11`，免费标「免费」）和模型详情的描述里；
3. 直接对话。

### 积分余额与模型倍率

| 入口 | 用法 | 内容 |
|---|---|---|
| 斜杠命令 | 对话框输入 `/workbuddy credits` | 积分总余额、各套餐余量（同名聚合、到期近的在前、7 天内到期 ⚠️ 警告） |
| 斜杠命令 | 对话框输入 `/workbuddy models` | 可用模型清单：免费优先、倍率升序，带上下文档位 |
| 工具 | 让 agent「看看还剩多少积分」 | `workbuddy_credits` 工具，只读，不消耗积分 |
| HTTP | `GET /v1/credits` | 桥的直接接口（30 秒缓存，`?refresh=1` 强制刷新） |

> 倍率口径：`×0.11` = 每次调用扣 0.11 倍积分；「免费」只在上游明确
> `x0.00` 或 `free:true` 时标注——「未知倍率」不会冒充免费。
> 余额口径：月度包（`CapacityType=4`）看 `CycleCapacityRemain`，一次性包看
> `CapacityRemain` 且跳过 0 余量的历史记录；计费网关跟随登录域名
> （国内 `www.workbuddy.cn`，与 chat 网关 `copilot.tencent.com` 不是同一主机）。

## 架构

```
dsh 模型选择器 ──ctx.llm.stream({provider:'workbuddy'})──▶ 插件适配器
   ◀── StreamChunk ── 本地桥 127.0.0.1:8790/v1 ◀── SSE 直通 ── copilot.tencent.com
```

- `lib/index.js`：拉起并看守桥进程、注册 `workbuddy` 路由；
- `lib/adapter.mjs`：dsh 词汇 ↔ OpenAI Chat Completions 词汇的双向翻译；
- `bridge/wb-bridge.mjs`：凭据（AtRest 解密 + 内存刷新）+ 上游转发，可独立运行。

## 独立使用桥（不装 dsh 也行）

```sh
node bridge/wb-bridge.mjs          # 默认 127.0.0.1:8790
WB_PORT=9000 node bridge/wb-bridge.mjs
curl http://127.0.0.1:8790/v1/models
curl -N http://127.0.0.1:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy4flash-free","messages":[{"role":"user","content":"hi"}]}'
```

任何支持自定义 Base URL 的客户端（Cherry Studio / Chatbox / opencode…）把
Base URL 设成 `http://127.0.0.1:8790/v1` 即可直连。

## 环境变量

| 变量 | 说明 |
|---|---|
| `WB_PORT` / `WB_HOST` | 桥监听端口 / 地址（默认 8790 / 127.0.0.1） |
| `WB_TOKEN` | 设置后本地请求须带 `Authorization: Bearer <token>` |
| `WORKBUDDY_APP_EXECUTABLE` | 显式指定客户端可执行文件 |
| `WORKBUDDY_AUTH_FILE` | 显式指定登录文件 |
| `WB_APP_VERSION` / `WB_CLI_VERSION` | 身份头版本号（默认读桌面端，失败用回退值） |
| `WB_UPSTREAM_TIMEOUT_MS` | 上游超时（默认 0 = 不限，长回答该等多久等多久） |
## 边界与风险（请先读）

- **非官方路径**：依赖 WorkBuddy 未公开的上游协议与登录文件格式，上游随时可能
  改协议或收紧风控，**可用性无保证、不承诺兼容性**。
- **只驱动自己的账号**：只读本机已登录凭据，消耗该账号自身配额。请勿用于多账号
  池化、代他人调用或转售/托管。
- **请确认符合 WorkBuddy 服务条款**；条款不允许就不要用。
- **凭据只进内存**：解密与刷新结果不落盘，日志绝不打印令牌。
- 完整设计（认证机制、上游契约、与参考项目的差异）见仓库 `docs/DESIGN.md`。
