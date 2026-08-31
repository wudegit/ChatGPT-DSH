# P2-C4 External Execution / Open Turn Contract Audit

## 1. Executive Summary / 审计目标与结论

本轮只审计，不修改 Bridge 核心代码、不提交、不推送。目标是确认 ChatGPT-DSH 能否在保持“ChatGPT 是唯一 Main Agent、DSH 只是工具执行底座”的前提下，把每次外部 MCP Tool Call 放进合法的 DSH Turn，从而让 DSH 原生 Approval、Sandbox、审计和持久化语义完整生效。

**结论：C — 当前安装的 DSH `0.1.1-rc.1` 没有可供外部调用方使用的、受支持的 Turn 执行 API。**

当前 Bridge 调用的是公开的 `ctx.tools.execute()`。它是受支持的同进程 Tool Runtime 管线入口，但不是“外部 Turn 事务”：它不创建 `turn/start` / `step/start`，也不负责耐久 `tool/call` / `tool/result`、终止原因、flush、并发序列化或 crash repair。DSH 的完整 Turn 所有权目前只存在于包内的标准 Agent Loop；公开 `Session.append()` 只是底层事件原语，不是公开的 Turn transaction API。

因此本轮不应实现手工 `session.append(turn/start...)`、伪造 Agent、或通过标准 Agent 触发一次空模型循环等 workaround。最小安全结论是：保持当前 `workspace-write` fail-closed 基线，向 DSH 上游请求/等待正式 External Execution API，并在 API 出现后做版本门控与契约测试。

## 2. Evidence / Source Locations / 审计范围与证据基线

- 仓库：`D:\work\openSource\ChatGPT-DSH`
- 分支：`main`，审计开始时与 `origin/main` 对齐
- HEAD：`ccd82c8 feat: add core read search profile`
- DSH：`dsh --version` = `0.1.1-rc.1`
- 已安装 DSH 源码根（下文记为 `<dsh-ai>`）：`D:\program\nodejs\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
- 初始验证：`npm run typecheck` 通过；`npm test` 通过，共 45 个测试
- 审计开始时唯一已有未跟踪文件：`docs/p2-c1-tool-security-audit-temp.md`；本轮未修改它

主要证据来源：

- Bridge：`src/execution-scope.ts`、`src/tools-bridge.ts`、`src/http-server.ts`、`src/bridge-session.ts`
- DSH Agent Loop：`<dsh-ai>\dsh-agent-loop\lib\index.js` 与 README
- DSH Session：`<dsh-ai>\dsh-session\lib\types\invariant.js`、`repair.js`、README
- DSH Persistence：`<dsh-ai>\dsh-session-persistence\lib\index.js` 与 README
- DSH Approval：`<dsh-ai>\dsh-user-approval\lib\index.js`、`invariant.js` 与 README
- DSH Tool Runtime：`<dsh-ai>\dsh-tools\lib\index.js`、类型声明与 README
- DSH Sandbox：`<dsh-ai>\dsh-sandbox\lib\index.js`、`<dsh-ai>\dsh-sandbox-policy\lib\index.js`
- DSH Web Approval responder：`<dsh-ai>\dsh-host-apiproxy\lib\index.js`
- MCP SDK：项目安装的 `@modelcontextprotocol/sdk` `1.30.0`

本审计对“是否存在受支持 API”的判断限定于当前已安装版本及其随包文档。已安装源码足以证明当前运行时的能力边界，因此未以未经验证的上游 `main` 替代本机版本证据，也不宣称某个尚未核实的上游版本已经补齐该能力。

## 3. Current Bridge Execution Model / 当前 Bridge 执行路径

当前路径如下：

```text
ChatGPT MCP tools/call
  -> MCP protocol server
  -> Bridge stable/fallback ExecutionScope
  -> ctx.tools.execute({ callId, name, arguments, signal, agent })
  -> DSH Tool Runtime policy / dispatch / live result pipeline
```

具体事实：

- `src/execution-scope.ts:64-82` 通过 `sessions.prepare()`、`enter()`、`announce()` 创建并进入一个 DSH Session，然后向 Tool Runtime 提供最小结构对象 `{ id, session }`。
- `src/tools-bridge.ts:159-164` 在每个 MCP `tools/call` 中直接调用 `tools.execute(...)`。
- `src/http-server.ts:254-298` 让 MCP session 获取 stable Bridge Session 的 ExecutionScope；同一 ChatGPT identity 的多次调用可复用同一个 DSH Session。
- `src/bridge-session.ts:122-126` 的并发保证只覆盖“同一 identity 只创建一个 ExecutionScope”，不序列化该 scope 上的 Tool Call。
- `src/tools-bridge.ts:134` 只声明 MCP `tools` capability；当前没有 MCP elicitation/sampling capability 或审批 challenge/response 接线。

缺失的标准 Turn 链为：

```text
turn/start
  -> step/start
  -> durable tool/call
  -> policy / approval / sandbox / tool body
  -> durable tool/result
  -> step/end
  -> turn/end
```

因此 Stable Bridge Session 已解决会话身份和 observation state 的跨 MCP session 复用，但没有解决 Turn 所有权。

## 4. Standard Agent Loop Turn Lifecycle / DSH Turn 的归属、创建与关闭

DSH 当前有公开的 Agent / AgentLoop 服务与程序化创建入口（例如 `ctx.agents.create()` / `ctx.agents.resume()`），但**没有公开的 non-LLM external `runTurn` / `runTool` 事务 API**。标准 Turn 的具体驱动生命周期目前仍由 Agent Loop 内部控制；其默认具体实现是包内 `ReactLoopAgent`：

- `<dsh-ai>\dsh-agent-loop\lib\index.js:515-605` 的 `turn()` 打开并关闭 Turn。
- `turn/start` 在约 `:523` 写入；每一步的 `step/start` / `step/end` 在约 `:548-562` 写入；`turn/end` 在 `finally` 中约 `:590-599` 写入。
- `<dsh-ai>\dsh-agent-loop\lib\index.js:477-490` 的 `kick()` 反复调用 `turn()`，并维护 Agent running/idle phase。
- `<dsh-ai>\dsh-agent-loop\lib\index.js:444-459` 通过 `withInitiator(this, ...)` 设置实际发起 Agent 的因果上下文。
- README 明确说明 `ReactLoopAgent` 是包内实现，只公开插件/服务/配置，而非可供外部构造或调用的 driver。

实际调用链是：

```text
agent.followup()/steer()
  -> wakeDriver()
  -> withInitiator(agent, kick)
  -> kick()
  -> turn(): append turn/start
  -> pre-step hooks / buildRequest()
  -> provider + model LLM call
  -> extract assistant tool calls
  -> executeToolCalls()
  -> internal scheduler + ctx.tools pipeline
  -> append durable tool/call and tool/result
  -> append step/end
  -> finally append turn/end
```

责任归属：Agent Loop 创建和关闭 Turn，并拥有 `try/finally`；Loop 的内部 scheduler 负责 durable tool audit 的顺序；每次 Turn 的 controller/Agent cancel 负责取消；Tool Runtime policy 触发 ApprovalService，ApprovalService 负责 asked/decided pair，而 Loop 负责让该 pair 始终处在其 Turn 生命周期中。

Turn 正常与异常关闭语义：

- 正常完成可记录 `completed`；达到模型输出限制可记录 `max-tokens`；前置策略阻断可记录 `blocked`。
- 普通异常记录 `error`。
- 取消记录 `aborted`，其原因继续携带 user、parent、disposed 等取消来源；因此 dispose 并不是遗漏关闭，而是以 aborted + disposed cause 表达。
- 进程崩溃来不及执行 `finally` 时，持久化 cold-load 通过 repair 追加缺失的 `tool/result`、`step/end`、`turn/end`，最终 Turn 原因为 `interrupted`。证据见 `<dsh-ai>\dsh-session\lib\types\repair.js` 与 `<dsh-ai>\dsh-session-persistence\README.md`。

标准 Agent Loop 不只是“顺手写几条日志”，而是 Turn controller：它同时拥有取消信号、步骤推进、Tool Call 调度、耐久事件提交顺序和所有出口的终止原因。这些职责不能由 Bridge 只追加两个 Turn 事件等价替代。

## 5. DSH Turn Semantics / Turn identity 与 Session 不变量

DSH 没有独立的 Turn UUID；Turn identity 是 Session 内严格递增的整数 `turn`：

- `<dsh-ai>\dsh-session\lib\types\invariant.js:33-42`：`turn/start` 要求当前没有 open Turn，并且 turn number 等于 `nextTurn`。
- `:44-53`：`turn/end` 必须匹配当前 open Turn，且不能在 step 尚未关闭时结束；成功后递增 `nextTurn`。
- `:55-73`：Step 同样在 Turn 内严格顺序打开/关闭。
- `:83-104`：耐久 `tool/call` / `tool/result` 必须属于当前同一个 turn/step，result 必须匹配先前 call id（repair 合成事件除外）。

关系不变量由 companion invariant 实现提供；是否在某个具体 profile 中挂载该 companion，不改变 DSH 文档化的事件契约。绕过它只能让错误日志更晚暴露，不能把并发或嵌套 Turn 变成受支持行为。

结论：一个 Session 同时只能有一个 open Turn；Turn 不可嵌套。Stable Bridge Session 可以包含许多连续 Turn，但不能让两个独立 MCP 调用在同一 Session 上同时各自打开 Turn。

事件格式本身不携带“创建者是哪个 Agent Loop”的身份，因此底层 `Session.append()` 技术上能写入这些事件；但当前已安装版本只有标准 Agent Loop 被文档和实现赋予完整生产 Turn owner 职责。不存在“任何外部调用方只要按名字 append 就获得官方 Turn 语义”的契约。

## 6. Approval 为什么必须位于 open Turn

`<dsh-ai>\dsh-user-approval\lib\index.js:62-68` 的 `hasOpenTurn()` 从 Session 尾部反向扫描：最先遇到 `turn/start` 返回 true，最先遇到 `turn/end` 返回 false，完全没有 Turn marker 也返回 false。`request()` 在约 `:144-159` 明确执行：

1. 从 `request.agent.session` 获取 Session；
2. 若没有 open Turn，立即抛出错误；
3. 追加 `approval/asked`；
4. 等待 answerer；
5. 追加匹配的 `approval/decided`。

即使不挂载可选的完整 Session invariant，这个 open-Turn 前置条件也由 ApprovalService 自身执行。`<dsh-ai>\dsh-user-approval\lib\invariant.js:214-233` 进一步规定 asked/decided 必须在 open Turn 中、审批 id 唯一、decision 必须匹配 pending request。

Turn 包围审批对的必要性不是 UI 偏好，而是耐久执行边界：

- 审批必须能归因到一次明确执行，并与对应 tool call、step、取消信号和最终 Turn outcome 一起重放。
- 进程在 asked 之后崩溃时，open Turn 是 persistence repair 识别“未完整执行尾部”的权威边界；它可以被标记为 interrupted，而不是在两个已完成 Turn 之间留下没有执行归属的审批记录。
- answerer 的临时 UI 状态不是 durable commit；真正可审计的是 Session 中、某个 Turn 内的 asked/decided 事件。
- 将事件手工放到 Turn 外，或者只为了通过 `hasOpenTurn()` 伪造一个 start，会破坏后续 step/tool/result/turn-end 的顺序、取消和恢复语义。

Approval 当前只授予 `allowed-once`，没有永久授权语义；`rejected`、`cancelled`、`unavailable` 都应在 Tool body 执行前 fail closed。

## 7. `ctx.tools.execute()` 的正式边界

`ctx.tools.execute(exec)` 是公开 API，证据见 `<dsh-ai>\dsh-tools\README.md` 和类型声明中的 `ToolRuntime.execute`。其实现 `<dsh-ai>\dsh-tools\lib\index.js:2999-3001` 进入完整的 Tool Runtime policy/dispatch/result 管线，因此当前 Bridge 直接使用它并非私有 API 调用。

但它只承诺 Tool Runtime 管线，不承诺一个耐久 Agent Turn：

- `execute()` 的输入允许 `agent?: Agent`；注释说明 agent 通常由 Agent Loop 设置，但 agentless direct execution 也是类型允许的调用形态。
- policy、scoped tool visibility、sandbox 与 Approval 会使用 `exec.agent`；没有 agent 时需要 Approval 的操作会 fail closed。
- Tool Runtime 发出的 `tools/result` 是进程内 live event，不等于 Session 中耐久的 `tool/result`。DSH Tools README 明确区分二者。
- 标准 Agent Loop 才在 `<dsh-ai>\dsh-agent-loop\lib\index.js:292-317` 追加耐久 `tool/call` / `tool/result`，并在内部 scheduler 中控制准备、body 并发和按模型顺序提交结果。
- `ctx.tools.execute()` 自身不创建 turn/step、不写 durable call/result、不 flush Session，也没有 per-Session FIFO。

所以准确表述是：**Tool Runtime 支持直接程序化执行工具；DSH 当前不支持把该直接执行自动提升为完整外部 Turn。**

## 8. Full Agent、最小 actor 与实际字段使用

Bridge 当前的 `{ id, session }` 是 TypeScript 结构兼容层，不是完整 DSH Agent。审计到的实际消费如下：

| 消费点 | 实际依赖 | 最小 actor 当前表现 |
| --- | --- | --- |
| ApprovalService | `agent.session`；Agent 还作为 scope key | 足以通过结构访问，但不是正式 Agent 生命周期 |
| host-apiproxy approval answerer | `agent.session.id/events`；按 Agent scope 注册 answerer | 当前字段可访问；scope identity 必须稳定 |
| sandbox-policy / fs sandbox | `agent.session.header.cwd/id/events` | 当前 stable Session 可提供 workspace |
| fs observation policy | `agent.session` | 当前可维持跨调用 read-before-edit state |
| spill owner | `agent.session.header.id` | 当前可绑定同一 Session 的 spill state |
| tool-call timeout policy | Agent 对象作为 scoped tool lookup key | 不直接要求其它成员，但要求 scope identity 正确 |
| scoped tools / guards / restrictions / waterfalls | Agent 对象作为 scope target | 伪 Agent 没有标准 Agent preset-local scope，行为依赖当前 profile 偶然组合 |
| cancel / phase / inbox / followup / steer | 标准 Agent/Loop 生命周期 | 最小 actor 完全不具备；Bridge 只自建 AbortController |

对当前 core profile 而言，最小 actor 并不会立刻阻止 read/write/edit/glob/grep，因为主要路径实际需要 Session 和 scope key。但是它仍是 accidental structural compatibility：不能据此推导它具备正式 Agent 的 tool composition、turn ownership、cancel、phase 或 replay 契约。

创建一个公开的完整 Agent 也不能解决问题：`ctx.agents.create/resume` 得到的是标准 Agent；只有 `followup/steer` 等驱动它时才会打开 Turn，而驱动后会进入 LLM Agent Loop。这会把 DSH 变成第二个 Main Agent，并产生模型调用，违反本项目架构目标。`agent.runMaintenance()` 被明确设计为 idle 时的非 Turn maintenance，也不能承载 Approval。

自行实现完整 Agent/driver 理论上可满足接口，但等于 Bridge 复制并拥有 DSH Loop 的 Turn、scheduler、cancel 和 repair 语义，属于本审计明确排除的自实现事务层。

## 9. DSH Web Approval responder 的实际行为

当前 DSH Web profile 的官方 answerer 位于 `<dsh-ai>\dsh-host-apiproxy\lib\index.js:1906-1963`：

- 收到 Approval request 后，从 `req.agent.session.events` 找到匹配的 `approval/asked`。
- 建立 pending request，向所有 Web mux queue 广播 `approval/requested`。
- Web `/api/respond` 在约 `:3747-3760` 校验 rpc/session/approval id 和 outcome 后完成 Promise。
- 新 mux 客户端连接时会重放 pending approvals（约 `:3544-3556`）。
- 完成后广播 `approval/resolved`。

关键边界：没有活跃 Web mux client 时，这个 answerer 仍会认领请求并保持 Promise pending，而不是立即返回 `unavailable`。稍后浏览器重连仍可看到并回答；若始终没有 responder，则必须依靠调用取消、provider teardown 或显式超时结束。

当前 Bridge 的 AbortController 在 `tools.execute()` 返回后的 `finally` 才 abort，且没有把 MCP request cancellation/超时完整接入。因此一旦合法 Turn 使 Approval 真正到达 Web answerer，但用户没有打开 DSH Web，MCP Tool Call 有无限等待风险。这是未来方案必须显式解决的生命周期问题。

Web pending UI 状态是进程内状态，不跨 Host restart 持久化；耐久审计仍来自 Session 事件。

## 10. ChatGPT Tool Confirmation 与 DSH Approval 的兼容性

需要区分两个不同的确认域：

- ChatGPT/MCP Tool Confirmation（若客户端基于 tool annotations 或策略显示）发生在发送 `tools/call` 之前，属于客户端授权。
- DSH Approval 发生在 Tool Runtime policy 阶段，必须在 open DSH Turn 内产生 `approval/asked` / `approval/decided`，属于执行端授权和审计。

兼容性判断：

### A. 两边都确认

协议上可以共存，但会产生双重确认。ChatGPT 的一次确认不能自动成为 DSH 的 `allowed-once`；DSH Web 仍需独立回答。当前可实现的官方 responder 是 DSH Web，但要求用户切换/打开对应 UI，且无客户端时会 pending。

### B. 让 ChatGPT/MCP 成为 DSH Approval responder

当前不兼容。项目使用的 MCP SDK `1.30.0` 提供 `Server.elicitInput()`，但它只有在客户端声明相应 elicitation capability 时才可调用；当前 Bridge 只声明 tools capability，未实现 elicitation adapter，也没有证据证明当前 Secure MCP Tunnel / ChatGPT connector 会作为该 elicitation responder。

未来可以设计正式 challenge/response adapter（MCP elicitation 或另一个明确协议）：在同一 DSH Turn 尚未关闭时，把 `approval/asked` 映射给客户端，并把显式响应映射成 DSH ApprovalOutcome。不能仅凭“ChatGPT 之前显示过 Tool Confirmation”推断一次 DSH `allowed-once`，否则 DSH 审计日志缺少真正 responder 的结果。

### C. DSH Web 独立作为第二确认面

这是当前安装版已有的官方 answerer，但用户体验是第二次确认，且 MCP 请求会等待 Web UI。若采用此路线，必须增加可取消、有限时的等待，并清楚显示哪个 DSH Session/Tool Call 正在请求确认。

## 11. One-Shot Elevation Required Chain / Sandbox escalation 与一次性授权链

理想的一次性 elevation 链为：

```text
MCP Tool Call
  -> external Turn/Step 已打开
  -> Tool Runtime policy 判定需要更宽 sandbox mode
  -> dsh-sandbox approveEscalation()
  -> ApprovalService.request(agent, tool, callId, reason, signal)
  -> approval/asked
  -> responder 返回 allowed-once
  -> approval/decided
  -> 仅本次 call 使用显式 approved sandbox mode
  -> tool body
  -> durable tool/result + step/end + turn/end
```

`<dsh-ai>\dsh-sandbox\lib\index.js:92-110` 只有在请求 mode 严格宽于当前 mode 时才发起审批；没有 Approval service 或 agent 会 fail closed；只有 `allowed-once` 才继续执行。`<dsh-ai>\dsh-sandbox-policy\lib\index.js:138-143` 让这次显式批准的 mode 覆盖 session/default policy，但只属于本次 resolve/call。下一次调用未显式批准时重新回到默认 `workspace-write`，不会悄悄变成永久 elevation。

| 链路步骤 | 当前状态 | 合理责任方 |
| --- | --- | --- |
| MCP 收到 `tools/call` 与 escalation 参数 | Bridge 已有 Tool Call；尚未开放该参数/工具面 | ChatGPT-DSH 只做协议映射与校验 |
| 建立 external Turn/Step | 缺失 | **DSH 应提供正式 executor**；Bridge 不应模拟 Loop |
| 调用 Tool Runtime | 已有 `ctx.tools.execute()` | DSH Tool Runtime，Bridge 调入口 |
| sandbox 判定请求 mode 更宽 | DSH 已有 | DSH sandbox/sandbox-policy |
| `approval/asked`、等待、`approval/decided` | DSH 已有，但要求合法 open Turn | DSH ApprovalService + 被选定 responder |
| MCP/ChatGPT 或 DSH Web 呈现确认 | Web responder 已有；MCP responder 缺失 | responder adapter/UI；不得由 Bridge 推断批准 |
| 仅本 call 应用 `allowed-once` | DSH 已有 | DSH sandbox policy |
| 执行 body 并写 durable tool/result | body 已有，durable external audit 缺失 | DSH external executor |
| 关闭 Step/Turn、传播 cancel、flush | 缺失 | DSH external executor；Bridge 传播 MCP cancel |

当前 Bridge 尚无合法 Turn，因此不能到达完整链。当前 `read/glob/grep` 不涉及 elevation；`write/edit` 默认仍运行在 `workspace-write` 下，但其 DSH schema 已支持调用方显式传入 `sandbox_permissions` + `justification` 请求更宽权限。一旦发起这种 escalation，当前会在 Approval 的 open-Turn 前置条件处 fail closed。未请求 elevation 时，workspace 外 mutation 仍会在 `workspace-write` 下直接拒绝，因此现有基线仍然安全可用。

## 12. External / Programmatic Execution APIs 与 Session Turn APIs / 搜索结果

对当前安装包的公开导出、类型声明、README 和实现进行了定向检索，结论如下：

| 候选接口 | 是否存在 | 是否满足外部 Turn 契约 |
| --- | --- | --- |
| `ctx.tools.execute(exec)` | 是，公开 | 否；只有 Tool Runtime 管线 |
| `ctx.agents.create/resume` | 是，公开 | 否；创建标准 LLM Agent，本身不执行 Turn |
| `agent.followup/steer` | 是，公开 | 会打开 Turn，但进入标准 LLM Loop，不是被动工具执行 shell |
| `agent.runMaintenance()` | 是，公开 | 否；明确为非 Turn maintenance |
| `ctx.agents.withInitiator()` | 是，公开 | 否；只做因果/作用域归因，不打开 Turn |
| `Session.append()` | 是，公开原语 | 否；没有 transaction、自动关闭、scheduler、cancel 或 repair ownership |
| `session.startTurn/endTurn/runTurn` | 未发现 | 不可用 |
| `ctx.execution.runTool/runTurn` | 未发现 | 不可用 |
| 可公开构造的 `ReactLoopAgent` driver | 未发现 | 实现为包内私有具体类 |

这意味着“能拼出事件”与“官方支持外部 Turn”不是同一件事。当前版本没有一项公开 API 同时拥有：per-call Turn/Step、真实 execution owner、durable tool audit、Approval、取消、异常关闭、flush 和同 Session 并发控制。

## 13. Stable Bridge Session vs Turn Lifetime / MCP Tool Call 应如何映射 Turn

在上游提供正式 API 后，推荐语义是：

- **Stable Bridge Session / DSH Session = ChatGPT conversation 级状态容器。**
- **每次独立 MCP Tool Call = 一个 DSH Turn。**
- 一个 Tool Call 的单个工具执行通常对应该 Turn 内的一个 Step。

原因：一次 MCP Tool Call 有独立的参数、call id、Approval、Sandbox 决策、取消、结果和失败边界，正好对应一个外部工作单元。它不应与 transport session 生命周期绑定：真机已经证明同一 conversation 的连续调用可能使用不同 MCP sessions。也不应把整个 conversation 作为一个超长 Turn：那会破坏顺序、恢复、取消和持久化边界，并且让所有后续调用都处于同一个长期 open Turn。

不推荐：

- 每个 MCP transport session 一个 Turn：transport session 不是稳定业务身份。
- 整个 ChatGPT conversation 一个 Turn：Turn 无法及时 commit/repair，且无法合法并发。
- 多个独立 Tool Call 共用一个 Step/Turn：会混淆各自审批和结果归因。

## 14. Concurrency / Serialization / 同一 Bridge Session 的并发约束

当前 `BridgeSessionStore` 只保证同一 identity 的并发 acquire 复用一个 in-flight `Promise<BridgeSession>`；它不包含 Tool Call 执行队列。因而两个 MCP requests 可以同时对同一个 DSH Session 调用 `ctx.tools.execute()`。

当前无 Turn 的 core tool direct execution 可在 Tool Runtime 中重叠，但这不是完整 Session 事务，可能产生 observation/read-edit 时序竞争，也没有耐久 call order。若未来直接在每个请求里打开 Turn，情况会更严重：第二个 `turn/start` 会与第一个 open Turn 冲突；即使关闭 invariant companion 让事件暂时写入，也会破坏 Session reload/repair 契约。

标准 Agent Loop 自己允许同一个 Step 内的多个模型 Tool Calls 做受控并发：policy/audit 按模型顺序提交，只有满足条件的 body 重叠；Approval invariant 也允许同一 Turn 中不同 id 的多个 pending approvals。这不等于允许两个独立外部 Turn 并发。

因此，只要采用“一次 MCP Tool Call = 一个 Turn”，同一 Stable Bridge Session 必须有 FIFO/互斥执行队列：

- 最佳归属：上游 DSH External Execution API，由拥有 Turn/scheduler/cancel 的层统一序列化。
- 若上游 API 明确要求调用方序列化：队列应属于 Bridge 的 per-Bridge-Session ExecutionScope，而不是 MCP transport session，也不是只负责 identity 映射的 store acquisition 临界区。
- 等待队列的调用必须可被 MCP cancellation 取消；正在执行的调用必须把 cancellation 传播到 DSH Turn controller。
- 不应在本 API 尚不存在时先实现一个手工队列并配合伪造事件，因为队列只能解决 nesting，不能补齐 Turn ownership。

## 15. Supported Integration Options / 可选方案评估

| 方案 | 结论 | 主要原因 |
| --- | --- | --- |
| A. 使用官方 External Turn/Execution API | 当前不可用；目标方案 | 当前版本未发现该 API；若上游提供，这是唯一推荐接入点 |
| B. 为每次调用创建/复用完整标准 Agent | 不适合 | 驱动 Turn 会进入 LLM Agent Loop，使 DSH 成为第二 Main Agent；仅创建 Agent 又不会开 Turn |
| C. 使用公开 Session Turn transaction | 当前不可用 | 只有通用 `append()`，没有 begin/run/end transaction |
| D. Bridge 手工追加 turn/step/tool events | Do Not Use | 复制私有 loop 语义，极易破坏取消、失败关闭、scheduler、flush、repair 和版本兼容 |
| E. 保持 workspace-write fail-closed，等待/请求/升级正式 API | **推荐** | 不扩大权限，不伪造审计，并保留当前已验证的安全基线 |

最终选择：**E，且将 A 作为后续解锁条件。**

## 16. Recommended Architecture / 推荐架构

推荐架构是：继续保留当前 Stable Bridge Session、RequestIdentity、Workspace Binding 和 MCP session 解耦；只在 Stable Bridge Session 内引入由 DSH 正式 External Execution API 提供的 per-call Turn boundary。ChatGPT 继续是唯一决策 Agent；DSH external executor 只作为 Tool Runtime、Session、Sandbox、Approval 与审计 owner，不发起 LLM 决策。

## 17. Recommended P2-C4B Implementation Scope / 推荐的最小步骤

由于缺少必需的正式 seam，P2-C4B 不应是 Bridge 代码实现，而应是 **Upstream Contract / Compatibility Gate**：

1. 向 DSH 上游提交一个最小外部执行契约需求，建议形态为 `ctx.execution.runTool(...)` 或等价 API；名称由上游决定，不能由 Bridge 假定。
2. 契约必须明确由谁拥有并保证：
   - 每次调用的 `turn/start`、`step/start`、durable `tool/call` / `tool/result`、`step/end`、`turn/end`；
   - completed/blocked/error/aborted/interrupted 等结束语义；
   - 真实 Agent/execution owner 或受支持的 external actor，而非结构伪造；
   - Approval scope 与 responder routing；
   - cancellation/timeout；
   - Session flush、cold-load repair；
   - 同一 Session 的调用串行化，或明确要求调用方如何串行化。
3. API 落地后，在 Bridge 加精确的 DSH 版本/feature detection gate；不满足时继续维持当前 fail-closed 能力，不做 fallback event fabrication。
4. 先写 characterization tests：正常成功、policy blocked、rejected/unavailable、allowed-once elevation、MCP cancellation、tool throw、Host dispose、crash-tail/reload、同 Session 两个并发调用。
5. 只有上述契约验证通过，才进入后续实现和 DSH Web vs MCP/ChatGPT responder UX 选择。

这一步足够小、可验证，也不会把临时私有协议固化到 Bridge。它不是“延期优化”，而是 P2-C4 正确性的前置依赖。

## 18. Blockers / 当前安全姿态、剩余风险与验收判定

在不实现伪 Turn 的情况下：

- core `read/write/edit/glob/grep` 继续通过 DSH Tool Runtime 执行。
- 默认 `workspace-write` 下，workspace 外 mutation 继续 fail closed。
- `read/glob/grep` 不涉及 elevation；`write/edit` 默认也不会扩大权限，但调用方可以通过 DSH 原生 `sandbox_permissions` + `justification` 显式请求 escalation。当前由于没有合法 open Turn，这类请求会在 Approval 前置条件处 fail closed，不会出现“审批缺失却继续执行”的 fail-open。
- P2-C1 已记录的 read/search capability 边界仍然存在：`workspace-write` 是写入 containment，不应被误述为所有读取都限制在 workspace；本轮不扩大该范围。

剩余风险：

- 当前 direct execution 没有耐久 Turn/tool audit。
- 同一 Stable Bridge Session 的 Tool Calls 尚未串行化，存在 observation state 时序竞争。
- 当前 Bridge 的 cancellation 没有完整传播到可能长期 pending 的 DSH Approval。
- 最小 actor 依赖结构兼容和当前 scope composition，不是稳定的上游契约。

这些风险都应在正式 External Execution API 接入时一并关闭，而不是分别以局部 workaround 掩盖。

本轮验收结论：

- 已回答当前 Bridge 是否位于合法 DSH Turn：**否**。
- 已确认 Approval 的硬前置：**必须存在 open Turn，并以 Agent Session 归属 asked/decided**。
- 已确认标准 Turn owner：**包内 Agent Loop**。
- 已确认 `ctx.tools.execute()`：**公开 direct Tool Runtime API，但非 external Turn API**。
- 已确认当前版本外部执行 seam：**不存在受支持的完整契约**。
- 已确认 ChatGPT confirmation 与 DSH Approval：**不同授权域；当前不能互相推断或代答**。
- 已确认并发模型：**一个 Session 一个 open Turn；未来 per-call Turn 必须按 Stable Bridge Session 串行化**。
- 已拒绝手工事件、伪 Agent、空 LLM Turn 等 hack。
- 已给出最小后续步骤：**先取得上游 External Execution contract，并以 feature gate + characterization tests 接入**。

最终结论保持为：**C — 当前 DSH 版本不具备受支持的外部 Open Turn Contract；P2-C4 不应进入实现。**
