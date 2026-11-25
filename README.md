# models-from-wb

在 **DeepSeek Harness** 里使用本机 **WorkBuddy** 桌面端已登录的模型能力
（DeepSeek / GLM / Kimi / MiniMax / 混元 / Step / MiMo…）。

参照 [Ianzhyh/workbuddy-to-dsh](https://github.com/Ianzhyh/workbuddy-to-dsh) 设计的
**精简重写**：只做「桥 + 最小 dsh 插件」，零依赖、单文件桥、可读可改。

```
dsh 模型选择器 ──▶ 插件适配器（dsh 词汇 ↔ OpenAI 词汇）
                     │  HTTP 127.0.0.1:8790/v1
                     ▼
                 本地桥（凭据解密 + 上游身份头 + SSE 直通）
                     │
                     ▼
              copilot.tencent.com（WorkBuddy 上游网关）
```

| 路径 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计文档：WorkBuddy 授权认证机制（实测）、上游契约、架构、与参考项目的差异 |
| [`plugin/`](plugin/) | dsh bundle：`lib/index.js`（宿主端）、`lib/adapter.mjs`（LLM 适配器）、`bridge/wb-bridge.mjs`（本地桥） |
| [`test/`](test/) | node:test 单元 + 集成测试（57 例，含真机凭据解密） |

## 快速开始

### dsh desktop（Electron 应用）

直接用应用窗口即可（它内部就是带认证的 Web GUI，无需浏览器）：

1. 确认 WorkBuddy 桌面端已登录（凭据在
   `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`）；
2. 插件已安装并启用（dsh 设置 → 插件 → `models-from-wb`）；桥会自动拉起
   （`127.0.0.1:8790`，只监听回环）；
3. 模型选择器里选 `WorkBuddy` 分组的模型，直接对话——**免费模型排最前，其余按
   积分倍率升序，倍率未知的排最后**（选择器不自己排序，顺序由适配器决定）；
4. 积分：`/workbuddy credits` 看余额，`/workbuddy models` 看全部模型与倍率。

### dsh web（浏览器）

浏览器打开 Web GUI **必须用带 token 的 URL**——dsh 的 web 服务器有浏览器会话认证，
裸 URL（如 `http://127.0.0.1:端口`）会返回 `401 dsh web authentication required`，
这是设计使然，不是故障。正确 URL 由 `dsh web` 启动时打印：

```sh
# 用 app 自带的 CLI（或把 .../runtime/cli/bin 加进 PATH 后直接用 dsh）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile web
# 启动后打印：dsh web: http://127.0.0.1:<端口>/?token=<令牌>
# —— 整个 URL（含 ?token=...）复制到浏览器；带 token 访问一次后服务器会发 cookie
```

插件已装进 **web profile**（与 desktop profile 各自独立安装，互不影响）；
两个宿主的插件**共用一个桥**（`127.0.0.1:8790`，先到先拉、后到探活复用），
同时启动时的端口竞争有专门处理（占用者是健康桥就安静退出）。

不装 dsh 也能单独用桥（任何支持自定义 Base URL 的客户端均可）：

```sh
node plugin/bridge/wb-bridge.mjs        # 默认 127.0.0.1:8790
curl http://127.0.0.1:8790/v1/models
```

不装 dsh 也能单独用桥（任何支持自定义 Base URL 的客户端均可）：

```sh
node plugin/bridge/wb-bridge.mjs        # 默认 127.0.0.1:8790
curl http://127.0.0.1:8790/v1/models
```

## 开发

```sh
node --test "test/*.test.mjs"   # 跑测试
```

## 边界与风险

非官方路径：依赖 WorkBuddy 未公开的上游协议与登录文件格式，**可用性无保证**；
只驱动本机已登录的自己的账号；请确认符合 WorkBuddy 服务条款。
详见 [docs/DESIGN.md](docs/DESIGN.md) §6。
