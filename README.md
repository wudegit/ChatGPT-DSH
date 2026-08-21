# ChatGPT-DSH

## 定位

ChatGPT-DSH 是运行在 DeepSeek Harness（DSH）Cordis Runtime 内部的**薄 Bridge Plugin**，面向 ChatGPT 将 DSH 的本地工具通过 MCP 暴露出去。

> **ChatGPT 是脑子，DSH 是 Runtime 和工具总线，ChatGPT-DSH 只负责把两者接起来。**

> **项目状态：Experimental / P0。** 当前仓库用于验证 DSH Tool Registry → MCP Tool Registry 的最小链路。DSH 仍处于快速迭代阶段，后续版本可能需要适配上游 breaking changes。

本项目是独立的社区实验项目，**不是 OpenAI、DeepSeek 或 Model Context Protocol 官方项目，也不代表这些项目的官方立场或支持关系。**

ChatGPT-DSH **不是**：

- 不是第二套 Harness；
- 不是文件 MCP / 第二套文件、Shell 工具实现；
- 不是 Long-Term Memory 系统；
- 不是 ChatGPT Conversation Archive / Backup；
- 不是 Sandbox 实现；
- 不是旧 coding-tools MCP 的延续；
- 不维护独立 workspace / allowed-folder 配置。

## P0 范围（已完成）

P0 只做最小 Tool Bridge：

```text
MCP Client
    ↓
ChatGPT-DSH Bridge
    ↓
ctx.tools.schemas()   （tools/list）
ctx.tools.execute()   （tools/call）
    ↓
DSH 原生 Tool
```

- 传输：**stdio MCP**（无网络、无认证）。
- 插件形态：普通 Cordis 插件，`inject: ['tools']`，运行在现有 DSH Runtime 内。
- 工具暴露：allowlist 固定为 `read` / `write` / `edit`（DSH 原生 fs 工具）。
- DSH 是 Tool 的唯一 Source of Truth；本仓库不重新定义、不重新实现任何工具。

P0 **不包含**：Streamable HTTP、OAuth / Bearer Auth、FRP / Tunnel 管理、CLI start/stop、ChatGPT 网页真机接入、Bridge Session、Subagent 委派、Memory、Archive、Tampermonkey、Tool Profile 完整系统、自动 Tool Name 重写、复杂配置系统。

## Sandbox 与安全机制

ChatGPT-DSH 没有实现 Sandbox，**但不代表**通过 ChatGPT-DSH 调用工具时没有 Sandbox。

实际关系：

```text
MCP
    ↓
ChatGPT-DSH（只做 Schema / Result 适配）
    ↓
ctx.tools.execute()
    ↓
DSH Sandbox / Tool Policy（原生生效）
```

已实际验证（P0）：

```text
workspace 内写入          → 成功
workspace 外写入          → DSH workspace-write sandbox 拒绝
```

拦截来自 DSH Tool Runtime（`ctx.tools.execute()` 内部），不是 ChatGPT-DSH 自己做的路径判断。ChatGPT-DSH 只做 Tool Allowlist，真正的文件访问边界交给 DSH Sandbox（与总体计划 §7 一致）。

`fs-observation-policy`（DSH 原生"先读后写"门禁）保持 DSH 默认启用状态，未被 Bridge 关闭。

## 适配的 DSH 版本

- 上游源码验证 commit：`b150a551b8`（release/dsh-0.1.1-rc.2）
- P0 实机验证运行时：`dsh@0.1.1-rc.1`；与上述 rc.2 源码中的 `ctx.tools.schemas()` / `ctx.tools.execute()` 签名一致
- MCP SDK：`@modelcontextprotocol/sdk@^1.30.0`（本仓库 `node_modules` 内）

## 依赖安装

```sh
npm install
```

## 如何加载插件

DSH 通过 `--patch` overlay 加载外部插件。仓库提供可提交的示例文件：

```text
cordis.patch.example.yml
```

首次使用时复制为本地配置：

```text
cordis.patch.example.yml
    ↓ copy
cordis.patch.yml
```

然后把其中的：

```text
file:///ABSOLUTE/PATH/TO/ChatGPT-DSH/src/index.ts
```

替换为当前机器上的真实绝对 `file://` URL。`cordis.patch.yml` 已加入 `.gitignore`，不会进入版本库。

该 overlay 会：

1. 启用 web profile 默认禁用的 `tool-fs`（read/write/edit）与 `tool-fs-search`；
2. 插入本插件 `src/index.ts`。

除此之外不修改 DSH 任何默认策略（observation policy、sandbox、approval 均保持 DSH 原生默认）。

## 如何启动

确保 `dsh` 已安装并可从 PATH 访问，然后在 ChatGPT-DSH 仓库目录下，把 MCP Client 指向：

```text
command: dsh
args: [web, --patch, <ABSOLUTE_PATH_TO_REPO>/cordis.patch.yml, --no-open]
cwd: <ABSOLUTE_PATH_TO_REPO>
```

说明：

- 如果某个 MCP Client 在 Windows 上不能直接 spawn `dsh` 命令 shim，可将 `command` 替换为该机器实际可执行的 Node / DSH 入口；不要照抄其他机器的全局 npm 路径；
- **P0 的 cwd 只是临时进程工作目录**（MCP Client spawn DSH 时的启动 cwd），不是正式 workspace 设计。正式模型是 `DSH Bridge Session → SessionHeader.cwd → workspace`（P2，见下）；
- `--no-open` 禁止启动时打开浏览器；
- 插件仅在 `process.stdin` 非 TTY（即被 MCP Client 以管道 spawn）时启动 bridge，直接运行 `dsh web` 不受影响。

### P0 与 P2 的 workspace 区别

```text
P0:
MCP Client / DSH 启动 cwd
    ↓
临时 workspace（验证用）

P2:
ChatGPT Conversation
    ↓
DSH Bridge Session
    ↓
SessionHeader.cwd
    ↓
正式 workspace
```

最终原则（总体计划 §4）：

> **Workspace belongs to DSH Session, not ChatGPT-DSH configuration.**

因此本仓库不维护 `workspace config` / `allowed_folder` / `root_path` / workspace persistence / path mapping。

## 用 MCP Inspector 测试

**方式一：Inspector Web UI**（推荐人工验证）

```sh
npx @modelcontextprotocol/inspector
```

Inspector 界面 Transport Type 选 `STDIO`，填写上方 command / args / cwd，点 Connect。之后：

1. **tools/list**：应看到 `read`、`write`、`edit` 三个工具及各自 JSON Schema；
2. **read**：调用 `read`，`{"file_path": "README.md", "limit": 10}`；
3. **write**：调用 `write`，`{"file_path": "p0-mcp-test.txt", "content": "ChatGPT-DSH P0 MCP bridge test"}`，然后 `read` 确认内容；
4. **error**：调用不存在的工具名（如 `no_such_tool`）或非法参数，应收到错误结果，Server 不崩溃；
5. **sandbox**：调用 `write` 写 workspace 外路径（如 `../p0-outside-test.txt`），应被 DSH Sandbox 拒绝；
6. **shutdown**：断开连接后进程在数秒内退出，无残留 Node 进程。

**方式二：Inspector CLI**（可脚本化；注意参数约定：target 在 `--` 之前，选项在 `--` 之后）

```sh
npx @modelcontextprotocol/inspector --cli dsh web --patch "<ABSOLUTE_PATH_TO_REPO>/cordis.patch.yml" --no-open -- --transport stdio --cwd "<ABSOLUTE_PATH_TO_REPO>" --method tools/list --format json

npx @modelcontextprotocol/inspector --cli dsh web --patch "<ABSOLUTE_PATH_TO_REPO>/cordis.patch.yml" --no-open -- --transport stdio --cwd "<ABSOLUTE_PATH_TO_REPO>" --method tools/call --tool-name read --tool-args-json '{"file_path":"README.md","limit":3}' --format json
```

**注意**：`@modelcontextprotocol/sdk@1.29+` 的 stdio 帧格式为 **newline-delimited JSON（每行一个 JSON-RPC 消息）**，不再是旧版 `Content-Length` 帧；任何使用 SDK 1.29+ 的 MCP Client 均可直连，手写帧格式客户端需按 NDJSON 发送。

## 当前已验证 Tool

| MCP 工具名 | DSH 工具名 | 参数 | 说明 |
|---|---|---|---|
| `read` | `read` | `file_path` (必填), `offset`, `limit` | 读取 UTF-8 文本文件，返回带行号内容 |
| `write` | `write` | `file_path` (必填), `content` (必填) | 创建或整体替换文本文件 |
| `edit` | `edit` | `file_path` (必填), `old_string` (必填), `new_string` (必填) | 字符串替换 |

## 映射关系

- **DSH ToolSchema → MCP Tool**：`name` / `description` 直接透传；`parameters` 已是标准 JSON Schema（`{type: 'object', properties, required}`），直接作为 MCP `inputSchema`，无字段重命名。
- **DSH Tool Result → MCP CallToolResult**：成功时优先使用 DSH 已渲染的 `content`（text block），无内容时回退 `JSON.stringify(value)`；失败时返回 `{content: [{type: 'text', text: error.message}], isError: true}`。

## 已知限制（P0 实测）

- 每次 `tools/call` 使用独立的 `AbortController`，无超时策略、无 AbortSignal 传播、无审批桥接（P0 按要求不实现）；
- 非 text 的 DSH content block（image/audio 等）以 JSON 文本形式返回；
- allowlist 是插件内常量，非配置化；
- 验证基于全局 `dsh@0.1.1-rc.1`（见"适配的 DSH 版本"），与源码 `0.1.1-rc.2` 的 API 签名一致但未做逐包差异审计；
- 插件仅在 `process.stdin` 非 TTY 时启动 bridge，因此 `dsh web` 手动运行时 MCP 服务不生效（属预期）；
- **当前 stdio transport 断开时会终止宿主 DSH 进程**（`process.exit(0)`，代码中标注为 P0 STDIO TEST ONLY）。这是 P0 Inspector 一次性验证的临时生命周期策略；正式 HTTP Bridge 不得沿用；
- **console.log/info/warn/debug 被重定向到 stderr**（代码中标注为 P0 STDIO-ONLY workaround）。这是 stdio transport 的协议保护措施（MCP stdout 只能承载协议帧）；P1 切换 HTTP Transport 后应删除，不发展成长期 Logging 设施。

## P1 / P2 前需要解决的问题（不实现，仅记录）

**P1：**

- Streamable HTTP Transport（stdio 断开即退出的策略届时删除）；
- 最小认证（OAuth / Bearer）；
- ChatGPT 网页真机接入（MCP over 公网；具体公网入口 / Tunnel 由部署者自行选择，ChatGPT-DSH 不负责管理）。

**P2：**

- Bridge Session（ChatGPT Conversation → DSH Bridge Session 映射）；
- `SessionHeader.cwd` 继承（正式 workspace 来源）；
- 正式 Sandbox / Approval 链对接（sandbox-policy / fs-sandbox，默认 workspace-write）；
- Tool Allowlist / Core Profile、Tool Name Collision 检测、MCP Tool Annotation、超时 / Cancel、结果大小限制。

## 相关项目

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- Model Context Protocol: https://modelcontextprotocol.io/

## License

MIT. See `LICENSE`.