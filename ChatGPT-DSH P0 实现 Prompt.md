# ChatGPT-DSH P0：最小 MCP Tool Bridge 实现任务

你现在需要在 `ChatGPT-DSH` 仓库中实现 **P0：最小 DSH MCP Tool Bridge 技术验证**。

本阶段的目标非常单一：

> 验证 DeepSeek Harness 中已经注册的 Tool，可以通过 MCP Server 被外部 MCP Client 枚举和调用。

不要扩展需求，不要提前实现后续阶段。

---

# 一、先阅读并确认当前 DSH 实现

本机已有 DeepSeek Harness 源码：

```text
<DSH_REPO>
```

ChatGPT-DSH 仓库：

```text
<CHATGPT_DSH_REPO>
```

其中 `<DSH_REPO>` 和 `<CHATGPT_DSH_REPO>` 分别代表当前机器上的实际仓库路径，不要把个人绝对路径写入公开仓库。

开始编码前，先阅读当前 DSH 源码和文档，确认实际 API，不要根据旧文档猜测。

重点确认：

```text
docs/cookbook/adding-a-package.md
docs/user/develop/basic/tool.md
packages/core/tools/
packages/mcp/mcp-client/
packages/host/
docs/cordis-primer.md
```

重点查清：

1. 当前 Cordis 插件标准入口形式。
2. `ctx.tools.schemas()` 当前真实签名和返回结构。
3. `ctx.tools.execute()` 当前真实签名。
4. Tool Schema 的 name / description / input schema 结构。
5. Tool Result / Error 的真实返回结构。
6. 当前仓库中 `@modelcontextprotocol/sdk` 的实际版本和使用方式。
7. DSH 本地开发插件如何从外部仓库加载。

如果计划文档中的 API 与当前源码不一致，以 **当前 DSH 源码** 为准。

---

# 二、本阶段只实现什么

只实现以下链路：

```text
MCP Client
    ↓
tools/list
    ↓
ChatGPT-DSH MCP Bridge
    ↓
ctx.tools.schemas()

MCP Client
    ↓
tools/call
    ↓
ChatGPT-DSH MCP Bridge
    ↓
ctx.tools.execute()
```

最终要求：

```text
MCP Inspector
    ↓
ChatGPT-DSH
    ↓
DeepSeek Harness
    ↓
DSH 原生 Tool
```

可以正常调用至少一个读取工具和一个写入工具。

---

# 三、明确禁止实现的内容

P0 不允许实现以下内容：

- HTTP Streamable MCP。
- OAuth。
- Bearer Auth。
- FRP。
- Cloudflare Tunnel。
- 自动下载 frpc/cloudflared。
- CLI start/stop/status。
- ChatGPT 网页真机连接。
- Agent Mode。
- BridgeAgent。
- Subagent。
- Codex。
- DSV4F delegation。
- Memory。
- Session Persistence 适配。
- Session Query。
- Compaction。
- Tampermonkey。
- Workspace 自研沙箱。
- GUI。
- 多租户。
- Tool Profile 完整系统。
- readOnlyHint 完整映射。
- 自动 Tool Name 重写体系。
- 复杂配置系统。

如果实现 P0 时某个基础能力不是必须的，不要加。

避免：

> “以后可能有用，所以先抽象出来。”

---

# 四、优先使用 stdio MCP

P0 优先使用 **stdio transport**。

原因：

- 不涉及网络。
- 不涉及认证。
- 不涉及公网。
- MCP Inspector 最容易验证。
- 可以把问题限定在 Tool Bridge 本身。

如果当前 MCP SDK 的 stdio Server 实现方式发生变化，请按照当前 SDK 官方接口实现。

不要为了 P0 自己写 JSON-RPC parser。

优先直接复用 MCP SDK。

---

# 五、插件结构

保持结构尽量小。

建议起步：

```text
ChatGPT-DSH/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── tools-bridge.ts
└── README.md
```

如果实际实现只需要一个文件，也可以更少。

不要为了“架构完整”预建：

```text
auth/
agent/
memory/
tunnel/
workspace/
cli/
```

这些目录。

---

# 六、DSH Plugin 入口

实现一个正常的 Cordis / DSH Plugin。

职责：

```text
plugin load
    ↓
获取 ctx.tools
    ↓
创建 MCP Server
    ↓
枚举允许暴露的测试 Tool
    ↓
启动 stdio transport
```

插件卸载时正确释放 MCP Server / transport。

不要重新创建一个独立 DSH Runtime。

该插件应该运行在现有 DSH Cordis Runtime 中，并直接复用：

```text
ctx.tools
```

---

# 七、Tool Schema Bridge

从：

```ts
ctx.tools.schemas()
```

获取当前注册工具。

转换为 MCP `tools/list` 所需要的结构：

```text
name
description
inputSchema
```

本阶段只处理最基本兼容字段。

要求：

- 不重新定义 DSH Tool Schema。
- 不手写每一个文件工具。
- 不复制 `read_file` / `write_file` 实现。
- DSH 是 Tool Source of Truth。
- MCP 层只是 Adapter。

如果 DSH schema 与 MCP JSON Schema 存在格式差异，只实现 P0 必需的最小转换，并在 README 记录。

---

# 八、Tool Call Bridge

收到 MCP：

```text
tools/call
```

之后调用 DSH 当前真实 API：

```ts
ctx.tools.execute(...)
```

参数严格按照当前源码要求构造。

需要处理：

- tool name。
- arguments。
- call id。
- 正常返回。
- Tool Error。

P0 不要求实现：

- timeout policy。
- AbortSignal 完整传播。
- approval bridge。
- sandbox policy。
- background job。

除非 DSH API 本身调用时强制需要。

---

# 九、Tool Result 转换

目标是：

DSH Tool 正常返回时，MCP Inspector 能看到可读结果。

至少支持：

```text
string / text
JSON-like structured result
error
```

不要在 P0 为 image/audio/resource 等复杂类型投入大量工作。

如果当前 DSH Tool Result 有 canonical result 类型，请优先按照其真实结构做最小映射。

遇到暂时无法映射的结果类型：

- 返回 JSON 文本。
- README 记录限制。

不要提前做复杂 abstraction。

---

# 十、Tool 暴露范围

P0 不做完整安全策略。

但不要直接把所有危险内部工具全部开放。

最简单方式即可，例如：

- 配置一个明确的测试 allowlist；
- 或仅选择确定安全、用于验证的 2~5 个工具。

优先包含：

```text
文件列表 / 搜索类
文件读取类
文件写入 / patch 类
```

具体工具名以当前 DSH 实际注册结果为准。

不要假定一定叫：

```text
read_file
write_file
```

先实际查看 `ctx.tools.schemas()`。

本阶段验证目标不是“全部 Tool 自动开放”，而是：

> 证明 DSH Tool Registry → MCP Tool Registry 可以成立。

---

# 十一、DSH Tool Mode

检查当前 DSH `tools.mode`。

如果当前：

```text
code mode
```

会导致普通 Tool 无法直接执行，请明确记录，并为 P0 测试配置使用：

```text
native
```

或当前 DSH 支持直接调用普通工具的对应模式。

不要修改 DSH 核心源码规避 Tool Runtime 的正常限制。

---

# 十二、测试方式

使用 MCP Inspector 进行验证。

至少验证：

## Test 1：tools/list

确认 Inspector 能看到由：

```text
ctx.tools.schemas()
```

映射出来的 DSH Tool。

## Test 2：读取

通过 MCP 调用 DSH 原生读取工具。

读取 ChatGPT-DSH 工作区中的一个测试文件。

## Test 3：写入

通过 MCP 调用 DSH 原生写入 / patch 工具。

创建：

```text
p0-mcp-test.txt
```

内容类似：

```text
ChatGPT-DSH P0 MCP bridge test
```

然后重新读取确认内容正确。

测试完成后删除测试文件。

## Test 4：错误

故意：

- 调用不存在的 Tool；
- 或提供非法参数。

确认 MCP Client 能收到合理错误，而不是 Server 崩溃。

## Test 5：生命周期

关闭 MCP Inspector / DSH 后：

- 进程能正常退出；
- 没有残留 Node 子进程；
- 没有挂起 stdio。

---

# 十三、README 只记录 P0 必需内容

README 包括：

1. 项目当前定位。
2. P0 范围。
3. 当前适配的 DSH commit / version。
4. 安装依赖。
5. 如何加载插件。
6. 如何启动。
7. 如何用 MCP Inspector 测试。
8. 当前已验证 Tool。
9. 已知限制。

不要写未来完整产品文档。

---

# 十四、不要修改 DeepSeek Harness 核心源码

原则：

```text
ChatGPT-DSH = 外部插件
```

除非发现 DSH 当前存在明确 Bug，并且不修改就完全无法完成 P0。

如果遇到这种情况：

不要直接改 DSH。

先：

1. 记录具体源码位置。
2. 说明为什么插件层无法解决。
3. 给出最小修改建议。
4. 停止扩大修改范围。

---

# 十五、代码质量要求

保持简单。

优先：

```text
可运行
可验证
代码少
依赖少
```

而不是：

```text
高度抽象
面向未来
配置复杂
架构完整
```

不要提前加入：

- interface factory。
- provider factory。
- repository pattern。
- service locator。
- 大量 DTO。
- 自定义事件总线。
- 不必要 dependency injection。

DSH / Cordis 本身已经提供了插件和依赖体系。

---

# 十六、完成后输出审计报告

任务完成后不要只说“完成”。

请输出：

## 1. 实际修改文件

列出所有新增 / 修改文件。

## 2. 实际使用的 DSH API

明确写出：

```text
ctx.tools.schemas(...)
ctx.tools.execute(...)
```

当前真实签名或调用方式。

如果与原计划不同，说明差异。

## 3. MCP 映射关系

说明：

```text
DSH ToolSchema
→
MCP Tool
```

以及：

```text
DSH Tool Result
→
MCP Tool Result
```

如何转换。

## 4. 验证结果

逐项报告：

```text
tools/list       PASS / FAIL
read             PASS / FAIL
write            PASS / FAIL
error handling   PASS / FAIL
shutdown         PASS / FAIL
```

## 5. 当前限制

仅列真实发现的问题。

## 6. P1 前需要解决的问题

不要实现，只列出来。

---

# 十七、最终验收标准

满足以下全部条件，P0 才算完成：

- ChatGPT-DSH 可以作为 DSH 插件加载。
- 插件直接复用 DSH `ctx.tools`。
- MCP Inspector 能连接。
- `tools/list` 能看到至少一个 DSH 原生 Tool。
- MCP 能调用 DSH 原生读取工具。
- MCP 能调用 DSH 原生写入或 patch 工具。
- 错误不会导致 MCP Server 崩溃。
- 插件关闭后无残留进程。
- 没有重新实现文件系统工具。
- 没有实现 P1 以后的功能。
- 没有修改 DSH 核心源码。

如果以上目标已经完成，请停止。

不要继续实现 HTTP、OAuth、ChatGPT 真机接入或 Subagent。

等待下一阶段指令。