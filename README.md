# ChatGPT-DSH

## 定位

ChatGPT-DSH 是运行在 DeepSeek Harness（DSH）Cordis Runtime 内部的**薄 Bridge Plugin**，面向 ChatGPT 将 DSH 的本地工具通过 MCP 暴露出去。

> **ChatGPT 是脑子，DSH 是 Runtime 和工具总线，ChatGPT-DSH 只负责把两者接起来。**

> **项目状态：Experimental / P2-B 第一阶段已完成。** P0、P1-A、P1-B、P2-0、P2-A、P2-B 第一阶段均已完成；P2-A 已通过 OpenAI Secure MCP Tunnel + ChatGPT Web 真机 `read → edit → read-back` 验收。P2-B 第一阶段（Workspace Binding：DSH Host cwd → `SessionHeader.cwd`）已通过目标 workspace 真机 `read → write → read-back → ../ 越界写入拒绝` 验收；动态多 Workspace 仍不在本轮范围。DSH 仍处于快速迭代阶段，后续版本可能需要适配上游 breaking changes。

本项目是独立的社区实验项目，**不是 OpenAI、DeepSeek 或 Model Context Protocol 官方项目，也不代表这些项目的官方立场或支持关系。**

ChatGPT-DSH **不是**：

- 不是第二套 Harness；
- 不是文件 MCP / 第二套文件、Shell 工具实现；
- 不是 Long-Term Memory 系统；
- 不是 ChatGPT Conversation Archive / Backup；
- 不是 Sandbox 实现；
- 不是旧 coding-tools MCP 的延续；
- 不维护独立 workspace / allowed-folder 配置。

## 当前状态：P2-B 第一阶段（Workspace Binding，已完成）

### P2-A（Stable Bridge Session，已完成，行为保持不变）

P2-A 在 P1-A 之上引入 **Stable Bridge Session**：把 DSH 状态从 MCP transport session 生命周期中解耦出来。

```text
ChatGPT Conversation
        │
        ├─ MCP Session A
        ├─ MCP Session B
        └─ MCP Session C
                │
                ▼
        Stable Bridge Session（BridgeSessionStore）
                │
                ▼
        Stable DSH ExecutionScope
                │
                ▼
        Stable DSH Session
```

- **Identity 来源**：当前 Secure MCP Tunnel 真机观察到 `x-openai-subject` + `x-openai-session` 两个 header。两者都存在且非空时，解析为 opaque BridgeIdentity（`sha256(subject \0 session)`），**这是 provider adapter 的实现细节，不是 MCP 标准契约**；核心 Bridge Session 层只持有 opaque identity，不依赖具体 header 名称。
- **会话复用**：同一 ChatGPT Conversation 的多次 Tool Call 即使每次都创建新 MCP Session（真机已确认），也会命中同一个 Bridge Session / DSH ExecutionScope，因此 `read → edit` 的 observation 状态可以跨 MCP Session 延续。**P2-A 真机验收已通过**：`read → edit → read-back` 三次 Connector 调用使用了三个不同 MCP Session，但均命中同一 Bridge Session / ExecutionScope，`edit` 成功且未再触发 `edit requires reading first`。
- **解耦语义**：MCP DELETE 只释放 Bridge Session lease，**不** dispose 稳定 scope；Bridge Session 通过 lease + idle timeout 管理生命周期（默认 1 小时无 lease 后清理）。MCP Session 生命周期 ≠ Bridge Session 生命周期。
- **两层 idle 生命周期**：ChatGPT 真机**不保证发送 MCP DELETE**，因此 MCP Session 自带 stale cleanup（默认 5 分钟无请求即关闭，释放 Bridge lease / 销毁 fallback scope），Bridge Session 再按自身 idle（默认 1 小时）回收稳定 DSH scope。即使客户端从不 DELETE，也不会永久泄漏：

  ```text
  MCP idle（默认 5 min）→ 关闭 stale MCP Session → Bridge lease -1
  Bridge idle（默认 1 h）→ lease=0 且超时 → dispose 稳定 DSH ExecutionScope
  ```
- **Generic fallback 保留**：请求没有稳定 Bridge Identity（例如 MCP Inspector、本地 HTTP MCP Client、其他未来 Client）时，继续使用 P1-A 行为——每个 MCP Session 一个临时 DSH ExecutionScope，DELETE 即销毁，互不串扰。
- **并发安全**：同一 identity 并发 `initialize` 只会创建一个 ExecutionScope（`Map<key, Promise<BridgeSession>>`）；shutdown 时所有 Bridge Session 恰好 dispose 一次，无 DSH Session leak、无 double detach。
- **workspace（P2-B 第一阶段已完成）**：P2-A 本身不设置 `SessionHeader.cwd`；P2-B 第一阶段把 DSH Host cwd 写入每个 Execution Session 的 `SessionHeader.cwd`，DSH fs/search/sandbox 由原生继承该 workspace（见下），并已通过 ChatGPT Web 真机 workspace + sandbox 验收。

### P2-B 第一阶段（Workspace Binding，已完成）

```text
P2-B 第一阶段：
Implementation Complete
Real-device Acceptance PASS
```

2026-08-29 已从独立目标 workspace `D:\work\ChatGPT-DSH-P2B-Test` 启动 DSH，并通过 OpenAI Secure MCP Tunnel + ChatGPT Web 完成以下真机链路：

```text
从目标 workspace 启动 DSH
    ↓
ChatGPT 相对路径 read/write
    ↓
确认实际落入 SessionHeader.cwd 对应 workspace
    ↓
尝试 workspace 外写入
    ↓
DSH workspace-write sandbox 拒绝
```

实际验收结果：

- 相对路径 `read("README.md")` 被解析为 `D:\work\ChatGPT-DSH-P2B-Test\README.md`（文件不存在，但解析路径证明 workspace binding 已生效）；
- `write("p2b-workspace-binding-acceptance.txt")` 创建于目标 workspace；
- `read-back` 成功读取同一文件并得到一致内容；
- `write("../p2b-outside-workspace-should-fail.txt")` 被 DSH 原生 `workspace-write` sandbox 拒绝，返回 `sandbox: file access denied under workspace-write mode`。

P2-B 第一阶段把 **DSH Host cwd** 正式写入每个 DSH Execution Session 的 `SessionHeader.cwd`，把 P1-A/P2-A 时期"未设置 cwd、由 DSH fallback 到启动 cwd"的**隐式行为**变成明确的 Workspace Binding：

```text
DSH Host cwd（插件启动时捕获一次 process.cwd()）
    ↓
createExecutionScope → sessions.prepare(id, { meta: { cwd } })
    ↓
SessionHeader.cwd（创建时不可变 metadata）
    ↓
DSH read/write/edit/search（dsh-tool-fs / dsh-tool-fs-search）
DSH sandbox-policy（workspaceRoot）
```

- **捕获一次**：插件启动时读取一次 `process.cwd()` 作为 Host workspace，不随每次 Bridge Session 创建重新读取可能变化的 `process.cwd()`；语义为一个运行中的 DSH Runtime → 一个固定 Host workspace → 该 Runtime 创建的所有 Bridge Execution Session 共享同一个 `SessionHeader.cwd`。
- **原生 API**：通过 DSH 原生 `sessions.prepare(id, { meta: { cwd } })` 写入（cwd 必须为绝对路径，DSH 侧校验），`SessionHeader` 创建后不可修改；不自行维护第二份 cwd 状态，不修改 read/write/edit/search 实现，不实现自研路径沙箱。
- **覆盖所有 Execution Session**：Stable Bridge Session（P2-A identity 复用）与 generic fallback 临时 scope 都注入同一 Host cwd——所有由 ChatGPT-DSH 创建的 Execution Session 都有明确 workspace。
- **P2-A 行为不变**：BridgeSessionStore / lease / MCP stale cleanup / Bridge idle cleanup / OpenAI identity resolver / generic fallback 均未改动；同一 ChatGPT Conversation 复用同一 DSH Session，自然持有同一个 `SessionHeader.cwd`。
- **范围**：当前仍是 **one DSH Runtime → one Host workspace**；动态多 Workspace、`workspace_bind` MCP Tool、ChatGPT 内切换项目、allowed_folder、workspace 配置文件、`CHATGPT_DSH_WORKSPACE` 环境变量等均不在本轮范围。

旧行为 → 新行为：

```text
旧（P1-A / P2-A）：SessionHeader.cwd 未设置
    → DSH fs/sandbox fallback 到 DSH 启动 cwd

新（P2-B 第一阶段）：DSH Host cwd
    → 创建 Bridge Execution Session 时写入 SessionHeader.cwd
    → DSH fs/search/sandbox 原生继承该 workspace
```

### P1-A 历史（本机 Streamable HTTP MCP 闭环，已并入 P2-A）

P1-A 实现**本机 Streamable HTTP MCP 闭环**：

```text
MCP Inspector / HTTP MCP Client
        ↓  http://127.0.0.1:3210/mcp  （Authorization: Bearer <token>）
ChatGPT-DSH Plugin
        ↓
ctx.tools.schemas()   （tools/list）
ctx.tools.execute()   （tools/call）
        ↓
DSH Tool Runtime
        ↓
DSH Sandbox / Policy
```

- 传输：**Streamable HTTP**（MCP SDK 官方 `StreamableHTTPServerTransport`），默认只监听 `127.0.0.1:3210/mcp`；
- 认证：最小 **Bearer Token**（`CHATGPT_DSH_TOKEN`，缺失则拒绝启动并输出明确 ERROR 日志；错误/缺失 token 一律 401，不调用任何 DSH Tool）；
- 生命周期：HTTP 服务随插件加载启动、长期运行；MCP Client 可反复连接/断开而不影响 DSH 进程；插件卸载时正常关闭 listener 与全部 MCP session；
- 健康检查：`GET /health` → `{"status":"ok"}`（无认证、不返回任何敏感信息）；
- MCP session：SDK 官方 stateful 模式（每 client session 独立 transport + protocol server，SDK 管理 session id）；只有合法的无 session id `initialize` 才会创建新 session，未知 session id 返回 404、无 session 的非 initialize 请求返回 400，失败的 initialize 立即清理；
- **DSH execution context**：每个 MCP protocol session **拥有**一个临时 DSH execution session（`ctx.sessions` 的 `prepare → enter → announce`；`ExecutionScope.dispose` → `detach`）。它作为最小 agent 传给 `ctx.tools.execute()`，使 DSH 原生 Tool Policy（`fs-observation-policy` 的观察状态、sandbox 解析）在 Bridge 调用上真正生效：`read → edit` 已实测通过。生命周期：

  ```text
  MCP Session 创建 → ExecutionScope 创建 → DSH execution Session 创建（prepare/enter/announce）
  工具调用 → 复用同一 ExecutionScope.agent.session
  MCP DELETE / server shutdown → ExecutionScope.dispose → DSH Session detach（session/disposed）
  ```

  这是执行上下文接线（execution context plumbing），**不是** P2 的 Bridge Session / ChatGPT Conversation 映射；P1-A 时期 session header 不带 cwd，fs/sandbox 以 DSH 启动 cwd 为 workspace（P2-B 第一阶段起已改为写入 Host cwd，见上）。

- **minimal agent 限制**：传给 `ctx.tools.execute()` 的 execution actor 只是 `{ id, session }`。它足够支撑当前 allowlist（read/write/edit）下的 Tool Policy（observation、sandbox、checkpoint），但**不是完整 DSH Agent**——完整 Agent / Approval / Agent Loop 语义不在 P1-A 承诺范围内。

配置（环境变量）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHATGPT_DSH_TOKEN` | （必填，无默认） | Bearer Token；未配置则 MCP Server 不启动，控制台明确输出 `CHATGPT_DSH_TOKEN is required`（DSH 本身继续运行） |
| `CHATGPT_DSH_HOST` | `127.0.0.1` | 监听地址；P1-A 只支持本机 |
| `CHATGPT_DSH_PORT` | `3210` | 监听端口 |
| `CHATGPT_DSH_DIAGNOSTIC_REQUESTS` | `off` | 实验性（P2-0）：`1` / `true` 开启每请求身份诊断日志；默认关闭，不改 session 语义，认证类 header 一律 redacted |
| `CHATGPT_DSH_MCP_SESSION_IDLE_MS` | `300000` | MCP transport/protocol session 空闲超时（毫秒）；ChatGPT 不保证发送 MCP DELETE，超时后主动关闭 stale MCP Session 并释放其 Bridge lease / fallback scope；非正整数回退默认值 |
| `CHATGPT_DSH_BRIDGE_SESSION_IDLE_MS` | `3600000` | P2-A：Bridge Session（稳定 DSH ExecutionScope）无活跃 lease 的空闲超时（毫秒）；非正整数自动回退默认值，不影响启动 |

### P2-0 实验性 Request Identity 诊断（仅观察）

`CHATGPT_DSH_DIAGNOSTIC_REQUESTS=1` 开启每请求身份特征诊断日志（P2 identity investigation only）：

- default off（未设置 / 空 / `0` / `false` 均关闭）
- does not change session semantics（不改变 MCP / DSH session 生命周期）
- redacts sensitive authentication headers（`Authorization` / `Cookie` / `x-api-key` 等名称统一输出为 `<redacted-header>`，值绝不输出）
- fingerprints stable upstream pseudonymous ids：`x-openai-session` / `x-openai-subject` 只输出 `sha256:<16 hex>` 短指纹，保留跨请求相等性比较能力，但不记录原始值

开启后每条 `/mcp` 请求输出一行 `[chatgpt-dsh][diag]` 前缀的 JSON 日志（timestamp / seq / HTTP method / path / Mcp-Session-Id / 可安全获得的 MCP method / session routing / header 名称列表 / identity 候选值），并输出 MCP Session 与 ExecutionScope 生命周期事件（`MCP_SESSION_CREATE` / `MCP_SESSION_INITIALIZED` / `MCP_SESSION_REUSE` / `MCP_SESSION_DELETE` / `MCP_SESSION_CLOSE` / `EXECUTION_SCOPE_CREATE` / `EXECUTION_SCOPE_DISPOSE`）。该诊断能力用于调查和验收；Bridge Session 路由由独立的 `RequestIdentityResolver` 负责，不依赖 diagnostics 输出。

## P0 历史（stdio，已由 P1-A 取代）

P0 验证了最小 Tool Bridge 链路成立：stdio MCP → `ctx.tools.schemas()` / `ctx.tools.execute()` → DSH 原生 Tool。P1-A 已删除 P0 的两个 stdio 临时机制：

- ~~`process.exit(0)`（transport close 时退出进程）~~ — 已删除；HTTP Client 断开不影响 DSH 进程；
- ~~console → stderr monkey patch~~ — 已删除；日志回归 DSH / Cordis 原生输出。

P0 的 stdio transport 不再提供（不保留双 transport，避免维护两套入口）。

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

已实际验证（P0 / P1-A）：

```text
workspace 内写入          → 成功
workspace 外写入          → DSH workspace-write sandbox 拒绝
```

拦截来自 DSH Tool Runtime（`ctx.tools.execute()` 内部），不是 ChatGPT-DSH 自己做的路径判断。ChatGPT-DSH 只做 Tool Allowlist，真正的文件访问边界交给 DSH Sandbox（与总体计划 §7 一致）。

`fs-observation-policy`（DSH 原生"先读后写"门禁）保持 DSH 默认启用状态，未被 Bridge 关闭。已实测（P1-A）：

```text
新 session 对未读文件直接 edit   → 被拒（edit requires reading ... first）
read 之后 edit                   → 成功
write 创建的文件                 → 已观察，可直接 edit
```

Bridge 不自行记录"读过哪些文件"，观察状态完全由 DSH 按 `agent.session` 维护。

## 适配的 DSH 版本

- 上游源码验证 commit：`b150a551b8`（release/dsh-0.1.1-rc.2）
- P0/P1-A 实机验证运行时：`dsh@0.1.1-rc.1`；与上述 rc.2 源码中的 `ctx.tools.schemas()` / `ctx.tools.execute()` 签名一致
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

设置 token 并启动 DSH（长驻进程）：

```sh
# PowerShell
$env:CHATGPT_DSH_TOKEN = "your-local-secret"
dsh web --patch D:/path/to/ChatGPT-DSH/cordis.patch.yml --no-open

# bash
CHATGPT_DSH_TOKEN=your-local-secret dsh web --patch /path/to/ChatGPT-DSH/cordis.patch.yml --no-open
```

启动日志应出现：

```text
HTTP MCP Server listening on http://127.0.0.1:3210/mcp
```

说明：

- 插件在插件加载时立即启动 HTTP listener，与 DSH 进程同生命周期；`dsh web` 手动运行也会启动（不再有 stdio TTY 判断）；
- `--no-open` 禁止启动时打开浏览器；
- **P2-B 第一阶段已完成并通过真机验收**：插件启动时捕获一次 DSH Host cwd，并写入每个 Execution Session 的 `SessionHeader.cwd`，DSH fs/search/sandbox 原生继承该 workspace（见下）。P1-A/P2-A 时期 `SessionHeader.cwd` 未设置、由 DSH fallback 到启动 cwd 的隐式行为已结束；
- 需要换端口时：`CHATGPT_DSH_PORT=3333`；端口被占用时插件启动失败并报告错误（DSH 进程不受影响）。

P2-B 真机验收时，可使用专用启动脚本。它会加载仓库根目录 `.env.local` 中的 `CHATGPT_DSH_TOKEN` / `CONTROL_PLANE_API_KEY` 等环境变量，同时保持目标目录为 DSH 的真实 `process.cwd()`，避免普通 `start-dev.ps1` 将 cwd 切回源码仓库：

```powershell
.\scripts\start-p2b-acceptance.ps1 -Diagnostics

# 或指定其他目标 workspace
.\scripts\start-p2b-acceptance.ps1 -Workspace 'D:\work\Some-Workspace' -Diagnostics
```

### P1-A 与 P2 的 workspace 区别

```text
P1-A（历史）:
SessionHeader.cwd 未设置
    ↓
DSH fs/sandbox fallback 到 DSH 启动 cwd（临时 workspace）

P2-B 第一阶段（当前）:
DSH Host cwd（插件启动时捕获一次）
    ↓
创建 Bridge Execution Session 时写入 SessionHeader.cwd
    ↓
DSH fs/search/sandbox 原生继承该 workspace

P2-B 后续（规划中，不在本轮范围）:
ChatGPT 内切换项目 / 动态多 Workspace
    ↓
每 Bridge Session 独立 SessionHeader.cwd
```

最终原则（总体计划 §4）：

> **Workspace belongs to DSH Session, not ChatGPT-DSH configuration.**

因此本仓库不维护 `workspace config` / `allowed_folder` / `root_path` / workspace persistence / path mapping。

## 用 MCP Inspector 测试

**方式一：Inspector Web UI**（推荐人工验证）

1. 按上文启动 DSH（带 `CHATGPT_DSH_TOKEN`）；
2. `npx @modelcontextprotocol/inspector`，Transport Type 选 `HTTP`，URL 填 `http://127.0.0.1:3210/mcp`，Headers 填 `Authorization: Bearer your-local-secret`；
3. 点 Connect，之后：

   1. **tools/list**：应看到 `read`、`write`、`edit` 三个工具及各自 JSON Schema；
   2. **read**：调用 `read`，`{"file_path": "README.md", "limit": 10}`；
   3. **write**：调用 `write`，`{"file_path": "p1-http-test.txt", "content": "ChatGPT-DSH P1-A HTTP bridge test"}`，然后 `read` 确认内容（测试后删除）；
   4. **error**：调用不存在的工具名（如 `no_such_tool`）或非法参数，应收到错误结果，Server 不崩溃；
   5. **sandbox**：调用 `write` 写 workspace 外路径（如 `../p1-outside-test.txt`），应被 DSH Sandbox 拒绝；
   6. **reconnect**：断开后重新 Connect，仍能 `tools/list`（DSH 进程保持运行）。

**方式二：Inspector CLI**

```sh
CHATGPT_DSH_TOKEN=your-local-secret dsh web --patch <ABSOLUTE_PATH_TO_REPO>/cordis.patch.yml --no-open &
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://127.0.0.1:3210/mcp --header "Authorization: Bearer your-local-secret" --method tools/list --format json
```

**认证快速验证（不带/带错误 token 均应 401）：**

```sh
curl -i -X POST http://127.0.0.1:3210/mcp -H "Content-Type: application/json" -d '{}'
curl -i -X POST http://127.0.0.1:3210/mcp -H "Authorization: Bearer wrong-secret" -H "Content-Type: application/json" -d '{}'
```

## 当前已验证 Tool

| MCP 工具名 | DSH 工具名 | 参数 | 说明 |
|---|---|---|---|
| `read` | `read` | `file_path` (必填), `offset`, `limit` | 读取 UTF-8 文本文件，返回带行号内容 |
| `write` | `write` | `file_path` (必填), `content` (必填) | 创建或整体替换文本文件 |
| `edit` | `edit` | `file_path` (必填), `old_string` (必填), `new_string` (必填) | 字符串替换 |

## 映射关系

- **DSH ToolSchema → MCP Tool**：`name` / `description` 直接透传；`parameters` 已是标准 JSON Schema（`{type: 'object', properties, required}`），直接作为 MCP `inputSchema`，无字段重命名。
- **DSH Tool Result → MCP CallToolResult**：成功时优先使用 DSH 已渲染的 `content`（text block），无内容时回退 `JSON.stringify(value)`；失败时返回 `{content: [{type: 'text', text: error.message}], isError: true}`。

## 已知限制（P1-A / P2-A 实测）

- 每次 `tools/call` 使用独立的 `AbortController`，无超时策略、无 AbortSignal 传播、无审批桥接（按要求不实现）；
- 非 text 的 DSH content block（image/audio 等）以 JSON 文本形式返回；
- allowlist 是插件内常量，非配置化；
- MCP Session 默认 5 分钟无请求后 stale cleanup（`CHATGPT_DSH_MCP_SESSION_IDLE_MS`），即使客户端不发送 MCP DELETE 也会自动关闭并释放其 Bridge lease / fallback scope；插件卸载时统一释放剩余 session；
- 无 Bridge Identity 的请求仍按 P1-A 生命周期语义：每个 MCP session 对应一个临时 DSH execution session，随 `ExecutionScope.dispose`（MCP DELETE / stale cleanup / server close / 插件卸载）**detach 出 session store**；P2-B 起该临时 session 同样携带 Host cwd 的 `SessionHeader.cwd`；
- 有 Bridge Identity 的请求（P2-A）：Stable Bridge Session 在 lease 归零后继续 idle 默认 1 小时（`CHATGPT_DSH_BRIDGE_SESSION_IDLE_MS`），然后 dispose 稳定 DSH ExecutionScope；随插件卸载 / server close 统一 dispose；**无跨 DSH 进程恢复、无长期数据库持久化**（不在 P2-A 范围）；
- `x-openai-subject` / `x-openai-session` 是当前真机观察到的 provider adapter 输入，不是 MCP 标准契约；若 OpenAI 链路变化导致 identity 解析失效，会自然回退到 generic per-MCP-session 行为；
- 验证基于全局 `dsh@0.1.1-rc.1`（见"适配的 DSH 版本"），与源码 `0.1.1-rc.2` 的 API 签名一致但未做逐包差异审计；
- Bearer Token 为 P1-A 本机最小认证技术验证；公网场景（P1-B）需要重新评估认证方案（TLS、OAuth 或反代层认证）。

## 后续阶段需要解决的问题（不实现，仅记录）

**P2-B（workspace binding）：**

- ✅ 第一阶段（已完成，真机验收 PASS）：`SessionHeader.cwd` = DSH Host cwd（插件启动时捕获一次 `process.cwd()`，经 `prepare(id, { meta: { cwd } })` 写入）；DSH fs / fs-search / sandbox-policy 原生继承该 workspace；P2-A Stable Bridge Session 与 generic fallback 均生效，identity / lease / lifecycle 设计未改动；已完成目标 workspace 启动 → 相对路径 read/write → read-back → workspace 外写入被 sandbox 拒绝的真实链路验收；
- ⬜ 动态多 Workspace：ChatGPT 内切换项目 / `workspace_bind` MCP Tool / Bridge Session 独立 workspace / workspace 持久化——不在本轮范围，当前仍是 one DSH Runtime → one Host workspace；
- ⬜ 正式 Sandbox / Approval 链对接（sandbox-policy / fs-sandbox，默认 workspace-write）；
- ⬜ Tool Allowlist / Core Profile、Tool Name Collision 检测、MCP Tool Annotation、超时 / Cancel、结果大小限制。

## 相关项目

- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- Model Context Protocol: https://modelcontextprotocol.io/

## License

MIT. See `LICENSE`.

## P2-0 真机结论

P2-0 已确认 ChatGPT 的不同 Tool Call 不保证复用同一 MCP Session；当前真机中 `x-openai-session` 表现为 Conversation scoped identity，`x-openai-subject` 表现为 subject scoped identity。详细实验与 P2-A 设计约束见 `docs/p2-0-request-identity-probe.md`。
