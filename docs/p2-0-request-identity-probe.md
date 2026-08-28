# P2-0 Request Identity Probe

## 目的

P2-0 只用于观察 ChatGPT Web 通过 OpenAI Secure MCP Tunnel 调用 ChatGPT-DSH 时的请求身份与 MCP Session 行为，不改变现有 MCP / DSH Session 语义。

核心问题：ChatGPT 的多次 Tool Call 是否复用同一个 MCP Session；如果不复用，是否存在跨 Tool Call、跨消息稳定且能够区分 ChatGPT Conversation 的请求身份。

## 真机链路

```text
ChatGPT Web
↓
ChatGPT-DSH Connector
↓
OpenAI Secure MCP Tunnel
↓
tunnel-client
↓
http://127.0.0.1:3210/mcp
↓
ChatGPT-DSH
↓
DSH Tool Runtime
```

P1-B 已真机验证：`tools/list`、`read`、`write` 均可以从 ChatGPT Web 到达本地 DSH Runtime。

## 已发现问题

DSH `edit` 依赖同一 DSH Session 中的 `read` observation。

真机中即使先 `read` 再 `edit`，`edit` 仍可能得到：

```text
edit requires reading ... first
```

原因不是 Tool 本身失效，而是 ChatGPT 的不同 Tool Call 不保证复用同一个 MCP Session；P1-A 当时又是一 MCP Session 对应一个临时 DSH ExecutionScope，因此 observation 无法跨 MCP Session 延续。

## P2-0 诊断实验

通过：

```text
CHATGPT_DSH_DIAGNOSTIC_REQUESTS=1
```

开启只读诊断日志。

诊断默认关闭；开启后记录请求中的 MCP / ExecutionScope 生命周期信息，并对认证类 header 严格脱敏。诊断不提前消费已建立 MCP Session 的 request body，也不改变 session routing / lifecycle。

当前实现进一步对稳定上游伪身份字段 `x-openai-session` / `x-openai-subject` 只记录短 SHA-256 fingerprint，不记录原始值。

## 真机测试

### Test A：同一条 ChatGPT 回复内连续两次 Tool Call

结果：

```text
Tool Call #1 → MCP Session A → exec-1
Tool Call #2 → MCP Session B → exec-2
```

结论：同一条 ChatGPT 回复中的多个 Tool Call 也不保证复用同一个 MCP Session。

观察到：

- `Mcp-Session-Id`：变化；仅代表 MCP transport session。
- ExecutionScope diagnostic id：变化；与当时临时 DSH Session 一一对应。
- `x-openai-pod-uid`：变化；属于基础设施实例信息，不适合作为会话身份。
- `traceparent`：同一 assistant turn 内 trace-id 稳定，但 span-id 变化。
- `x-request-id`：同一 assistant turn 内主 ID 稳定，但请求后缀变化。
- `x-openai-session`：两次 Tool Call 完全稳定。
- `x-openai-subject`：两次 Tool Call 完全稳定。

### Test B：同一 ChatGPT Conversation 的下一条消息

结果：

- 新消息创建了新的 MCP Session 与新的 ExecutionScope。
- `traceparent` 的 trace-id 变化。
- `x-request-id` 主 ID 变化。
- `x-openai-session` 保持不变。
- `x-openai-subject` 保持不变。

结论：`x-openai-session` 的稳定范围高于单次 assistant turn，至少能跨同一个 ChatGPT Conversation 的多条消息保持稳定。

### Test C：新建 ChatGPT Conversation

结果：

- `x-openai-session` 发生变化。
- `x-openai-subject` 保持不变。

结论：在当前 ChatGPT Web + Secure MCP Tunnel 真机链路中：

```text
x-openai-session → 表现为 Conversation / session scoped identity
x-openai-subject → 表现为 subject / account scoped identity
```

这些结论来自当前真实链路的实测行为，不应视为 OpenAI 的永久公开契约。

## P2-0 结论

P2-0 调查目标完成：

1. `Mcp-Session-Id` 不能作为 ChatGPT Conversation 的长期状态键。
2. DSH observation / cwd / 后续状态不应该绑定 MCP transport session。
3. `x-openai-session` 是当前最强的 Conversation-scoped Bridge Identity 候选。
4. `x-openai-subject` 可作为更上层的 subject namespace，与 `x-openai-session` 组合隔离不同用户与不同 Conversation。
5. 这两个 header 是当前真机观察到的 OpenAI 请求字段，不属于 MCP 标准，也不应视为永久公开契约。

## P2-A 设计方向

下一阶段引入独立的 identity resolver 与 Bridge Session 层，而不是在核心逻辑中直接硬编码 OpenAI header：

```text
HTTP Request
↓
RequestIdentityResolver
↓
BridgeIdentity
↓
BridgeSessionStore
↓
Stable DSH ExecutionScope
```

OpenAI adapter 根据：

```text
x-openai-subject + x-openai-session
```

解析出 opaque Bridge Identity；核心 Bridge Session 层不依赖具体 header 名称。

同时保留 generic MCP fallback：如果请求中没有可用的稳定 Bridge Identity，则继续使用 P1-A 的“一 MCP Session → 一临时 DSH Session”行为，避免 ChatGPT-DSH 被绑定为只支持 OpenAI Secure MCP Tunnel。

## 后续验证结果

P2-A 已在 ChatGPT Web 真机通过 `read → edit → read-back` 验收：三次 Connector 调用分别使用不同 MCP Session，但复用同一个 Bridge Session / DSH ExecutionScope，`edit` 成功且 observation continuity 生效。

## 阶段状态

```text
P0     Closed
P1-A   Closed
P1-B   Closed — Remote MCP exposure + ChatGPT Web real-device validation
P2-0   Closed — Request Identity Probe
P2-A   Closed — Stable Bridge Session
P2-B   Next   — Workspace binding
```
