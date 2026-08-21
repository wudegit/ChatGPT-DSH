# ChatGPT-DSH 总体大纲与下一步开发计划

## 1. 项目定位

ChatGPT-DSH 不重新实现一套 Harness，也不再承担独立长期记忆或 ChatGPT 原文备份职责。

项目定位：

> **ChatGPT-DSH 是一个运行在 DeepSeek Harness 中、面向 ChatGPT 的 Bridge Plugin。它把 DSH 已有的本地工具、Sandbox、Session 和 Subagent 能力通过 MCP 暴露给 ChatGPT，使 ChatGPT 成为上层总控 Agent。**

核心原则：

- ChatGPT 是唯一总控 Agent。
- DSH 是本地 Runtime / Harness。
- ChatGPT-DSH 是薄 Bridge Plugin，不成为第二套 Harness。
- Codex、DSV4F 等是被 ChatGPT 派发任务的执行 Agent。
- 文件、Shell、Git、Sandbox、Session 等能力优先直接复用 DSH。
- 工作目录属于 DSH Session，不属于 ChatGPT-DSH 独立配置。
- ChatGPT 的长期记忆继续使用 ChatGPT 自身 Memory。
- ChatGPT 原始会话备份独立于本项目，可使用第三方工具定期完成。
- V1 只验证核心链路，不提前建设不确定的外围能力。

---

## 2. 最终目标架构

```text
                    用户
                     │
                     ▼
                  ChatGPT
            总控 / 决策 / 拆解 / 验收
                     │
                     │ MCP
                     ▼
          ┌─────────────────────────┐
          │ ChatGPT-DSH Bridge      │
          │ Plugin                  │
          │                         │
          │ MCP Transport           │
          │ Auth                    │
          │ Tool Exposure           │
          │ Bridge Session Mapping  │
          │ Subagent Delegation     │
          └────────────┬────────────┘
                       │
                       ▼
                DeepSeek Harness
                       │
       ┌───────────────┼────────────────┐
       │               │                │
       ▼               ▼                ▼
 Local Tools        Sandbox          Subagents
 fs/search          workspace        Codex
 shell/git          policy           DSV4F
 patch/code         fs/shell         Claude...
       │
       ▼
    Session
 cwd / identity / persistence / query / compaction
```

ChatGPT-DSH 不包含：

```text
Long-Term Memory System
Conversation Archive / Backup
独立文件访问根目录配置
自研 Sandbox
第二套文件 / Shell MCP
```

---

## 3. 各层职责

### 3.1 ChatGPT

负责：

- 理解用户真实需求。
- 做架构和方案判断。
- 拆分任务。
- 判断任务是直接调用工具还是派给 Subagent。
- 调用 DSH 本地工具读取、修改和验证项目。
- 将复杂编码任务派给 Codex。
- 将低成本分析、整理等任务派给 DSV4F。
- 查看 Git Diff、测试结果并做最终验收。
- 使用 ChatGPT 自身 Memory 保持长期连续性。
- 当单个 ChatGPT 会话过长时，按需要生成 handoff/checkpoint 后开启新会话。

不负责：

- 自己实现本地 Agent Runtime。
- 自己实现文件系统或 Shell Runtime。
- 自己维护复杂 Sandbox。
- 自己维护 Codex / DSV4F 进程实现细节。

### 3.2 ChatGPT-DSH Bridge Plugin

负责：

- MCP Transport。
- 认证。
- 把允许的 DSH Tool Schema 暴露给 ChatGPT。
- 把 MCP `tools/call` 转换为 DSH Tool 执行。
- 把 ChatGPT 会话映射到对应的 DSH Bridge Session。
- 继承 Bridge Session 的 `cwd`、identity 和 sandbox policy。
- 暴露面向 ChatGPT 的 Subagent 委派工具。
- 做必要的结果格式转换、超时、取消和大小限制。

不负责重新实现：

- 文件系统。
- 文件搜索。
- Shell。
- Git。
- Code Runtime。
- Sandbox。
- Session Persistence。
- Session Query。
- Compaction。
- Session Reference。
- Long-Term Memory。
- ChatGPT 原文备份。
- Codex Runtime。
- DSV4F Runtime。

### 3.3 DeepSeek Harness

负责提供真正的运行能力：

```text
ctx.tools
ctx.subagents
Session
SessionPersistence
SessionQuery
Compaction
SessionReference
Sandbox Policy
fs-sandbox
shell sandbox
```

ChatGPT-DSH 的原则是：

> **适配 DSH，而不是复制 DSH。**

---

## 4. Workspace / cwd 模型

旧 coding-tools MCP 使用客户端单独配置一个允许访问的文件夹。

ChatGPT-DSH 不再保留这套目录配置。

新的唯一工作目录来源：

```text
DSH SessionHeader.cwd
```

例如：

```text
Bridge Session A
cwd = D:\Projects\Eat
```

那么该 Session 下的：

```text
read_file
search
write / patch
shell
git
delegate_codex
delegate_dsv4f
```

都以 `D:\Projects\Eat` 为当前工作区。

统一原则：

```text
Session.cwd
   │
   ├── fs 路径基准
   ├── shell 默认 workdir
   ├── sandbox workspace root
   ├── AGENTS.md / 项目上下文查找起点
   └── subagent 默认工作目录
```

因此：

> **Workspace belongs to DSH Session, not ChatGPT-DSH configuration.**

不再自行维护：

- `allowed_folder`。
- 独立 workspace 配置。
- 重复的路径映射。
- 第二套 workspace persistence。

如果需要切换到另一个工程，优先创建或切换对应的 DSH Bridge Session，而不是修改插件全局目录。

---

## 5. Bridge Session 的定位

Bridge Session 保留，但职责大幅收窄。

它不是 Memory Session，也不是 ChatGPT 原文镜像。

主要承担：

```text
ChatGPT Conversation
        ↓
DSH Bridge Session
        │
        ├── session identity
        ├── cwd
        ├── sandbox policy
        └── 当前 DSH 执行上下文
```

它解决的是：

- 当前 ChatGPT 会话到底在操作哪个本地项目。
- DSH Tool Call 应该使用哪个 cwd。
- 当前 Session 应采用什么 sandbox policy。
- Subagent 从哪里继承工作目录和父 Session 身份。

Bridge Session 不承担：

- ChatGPT 长期记忆。
- ChatGPT 原始聊天备份。
- 全局项目知识库。
- 向量检索。

---

## 6. Local Tools

直接使用 DSH Tool Registry：

```text
ctx.tools.schemas()
ctx.tools.execute()
```

包括后续启用的：

- 文件读取。
- 文件搜索。
- 文件修改。
- Shell。
- Git。
- Code Runtime。
- 其他 DSH 插件工具。

ChatGPT-DSH 只负责：

- 哪些工具暴露给 ChatGPT。
- MCP Tool Name 映射。
- Schema / Result 转换。
- Annotation。
- 超时与取消。

不再维护旧 coding-tools MCP。

---

## 7. Sandbox

Sandbox 直接走 DSH 原生实现。

优先复用：

```text
sandbox-policy
fs-sandbox
pwsh-sandbox
bash-sandbox
```

默认推荐：

```text
sandbox = workspace-write
workspace root = SessionHeader.cwd
```

原则：

- 文件读写和 Shell 尽量走 DSH sandbox-aware capability。
- 不通过扫描命令字符串的方式自研“伪沙箱”。
- 普通第三方 MCP Tool 不因为接入 DSH 就自动获得 DSH Sandbox。
- 如果某项能力需要 Sandbox，应优先调用 DSH 原生受控工具，而不是绕过 DSH 直接执行宿主机操作。
- `danger-full-access` 只在明确需要时启用。

ChatGPT-DSH 可以做 Tool Allowlist，但真正的文件访问边界应交给 DSH Sandbox。

---

## 8. Subagent Delegation

直接复用 DSH：

```text
ctx.subagents
```

第一批面向 ChatGPT 暴露：

```text
delegate_codex
```

未来可继续扩展：

```text
delegate_claude
...
```

任务分工原则：

```text
ChatGPT
    ├── 小修改 / 检查
    │      ↓
    │   DSH Local Tools
    │
    ├── 复杂编码
    │      ↓
    │   Codex
    │
    └── 低成本分析 / 阅读 / 整理
           ↓
        DSV4F
```

所有 Subagent 默认继承当前 Bridge Session 的 workspace/cwd。

---

## 9. Session、Compaction 与长期记忆的边界

DSH Session 系统仍然需要保留，因为它属于 DSH Runtime 的基础能力。

### 9.1 DSH Session

DSH Session 保存 DSH 自己发生的执行过程：

- Agent 对话。
- Tool Call。
- Tool Result。
- Codex / DSV4F 子会话。
- Parent / Child Session 关系。

它是 DSH 内部的事实记录和恢复基础设施。

### 9.2 SessionQuery / SessionReference

用于：

- 查找以前的 DSH 执行记录。
- 恢复某次子代理任务的原始细节。
- 引用其他 DSH Session 的相关上下文。

这属于“查历史”，不是独立 Long-Term Memory。

### 9.3 Compaction

用于 DSH Session 过长时压缩当前上下文，使 DSH Agent / Subagent 可以继续工作。

Compaction 是上下文管理，不是跨 Session 长期记忆。

### 9.4 ChatGPT Long-Term Memory

ChatGPT-DSH 不再实现独立 Long-Term Memory。

原因：

- ChatGPT 是唯一总控 Agent。
- ChatGPT 自身已经提供 Memory。
- 再维护一套 user/project/global Memory 会形成两个相互竞争的“长期认知层”。
- 当前需求中没有证据表明必须复制一份 ChatGPT Memory。

如果以后实际使用证明 ChatGPT Memory 不够，再独立评估：

- DSH Memory Plugin。
- Memorix / Engram 等 MCP Memory Provider。
- 从历史备份离线重新提取长期记忆。

但它们不进入当前 ChatGPT-DSH 核心设计。

---

## 10. ChatGPT 长会话处理

ChatGPT 单个会话过长的问题，不通过 ChatGPT-DSH 自建 Long-Term Memory 解决。

优先方案：

```text
长 ChatGPT Session
        ↓
生成 Handoff / Checkpoint
        ↓
开启新的 ChatGPT Session
        ↓
ChatGPT Memory + Project Context + Handoff
        ↓
继续工作
```

Handoff 可以包含：

```text
Goal
Decisions
Current State
Key Context
Files / Modules
Open Issues
Next Actions
```

是否把 Handoff 做成 ChatGPT-DSH Tool，等核心链路稳定后再决定。

它属于“Session 迁移辅助”，不是长期记忆系统。

---

## 11. ChatGPT 原文备份

ChatGPT 原始聊天备份明确移出 ChatGPT-DSH 项目。

原因：

- Archive 是数据备份问题，不是 Harness Runtime 能力。
- 与 DSH Local Tools / Sandbox / Subagent 没有强耦合。
- 可以独立选择成熟第三方工具。
- 更换备份工具不应影响 ChatGPT-DSH。

目标只需要保证第三方备份方案最终能够保存：

- 完整 Conversation 原始数据。
- 普通 Chat 和 Project Chat。
- 必要的 conversation/message metadata。
- 开放、可迁移的本地格式。

当前可独立评估 ChatGPT-Exporter 等现成项目。

ChatGPT-DSH 不实现：

- Tampermonkey Transcript Capture。
- Transcript Receiver。
- Conversation Archive。
- 增量备份协议。
- 附件归档。

---

## 12. 安全原则

安全边界优先建立在 DSH Runtime，而不是 Bridge Plugin 自己实现。

ChatGPT-DSH 负责：

- Tool Allowlist。
- Tool Profile。
- MCP Tool Annotation。
- 最小认证。
- Secret 脱敏。
- 结果大小限制。
- 超时 / Abort / Cancel。

DSH 负责：

- Workspace cwd。
- 文件系统访问边界。
- Shell Sandbox。
- Sandbox Policy。
- 实际 Tool Runtime。

默认建议：

```text
cwd     = Bridge Session cwd
sandbox = workspace-write
network tools = 默认不暴露
```

---

## 13. 开发阶段划分

### P0：最小 DSH MCP Tool Bridge

目标：

> 证明 ChatGPT-DSH 插件能够直接读取 DSH Tool Registry 并执行 DSH 原生工具。

只实现：

```text
DSH Plugin
+
ctx.tools.schemas()
+
ctx.tools.execute()
```

先不做：

- OAuth 完整实现。
- FRP 自动管理。
- Subagent。
- Long-Term Memory。
- Archive。
- CLI / GUI。

验证：

```text
MCP Inspector
↓
tools/list
↓
DSH read/list
↓
DSH write/patch
```

重点确认：

- 调用的确实是 DSH Tool Registry 中的工具。
- 没有复制旧 coding-tools MCP 实现。
- 工具工作目录来自 DSH 当前 Session/cwd 或 P0 临时测试上下文。

---

## 14. P1：ChatGPT 真机闭环

加入：

- Streamable HTTP `/mcp`。
- 最小认证。
- MCP Tool Schema 转换。
- Tool Result 转换。

公网继续使用已经验证过的现有 FRP / Cloudflare 链路。

暂时不让插件管理 FRP。

验证目标：

```text
ChatGPT Web
↓
MCP
↓
ChatGPT-DSH Plugin
↓
DSH Runtime
↓
本地工程
```

ChatGPT 能通过 DSH：

- 列文件。
- 搜索文件。
- 读文件。
- 创建 / 修改测试文件。
- 查看 Git 状态 / Diff。
- 执行安全 Shell 命令。

这一步完成后，项目第一核心价值成立。

---

## 15. P2：Bridge Session + Workspace + Sandbox

目标：

> 让 ChatGPT 的工具调用稳定落在一个明确的 DSH Session / Workspace 中。

实现：

- ChatGPT Conversation → Bridge Session 映射。
- Bridge Session identity。
- `SessionHeader.cwd` 继承。
- DSH Sandbox Policy 对接。
- workspace-write 验证。
- Tool Allowlist / Core Profile。
- Tool Name Collision 检测。
- MCP Tool Annotation。
- 超时 / Cancel。
- 结果大小限制。

验证：

```text
Bridge Session
cwd = Project A
↓
read/write/shell/git
↓
全部基于 Project A
↓
workspace 外写入被 Sandbox 拒绝
```

这一步完成后，不再需要任何独立 workspace/folder 配置。

---

## 16. P3：Codex Subagent Bridge

目标：

```text
ChatGPT
↓
ChatGPT-DSH
↓
DSH Subagent
↓
Codex
```

第一阶段只接 Codex。

实现：

- `delegate_codex`。
- cwd/workspace 从 Bridge Session 继承。
- Parent / Child Session 关系。
- Task Prompt。
- Result Summary。
- Cancel。
- 前台 one-shot 生命周期。

暂不优先做：

- 后台长期任务。
- 可恢复的复杂 job 系统。
- 多 Codex 并行调度。

验证一个真实任务：

```text
ChatGPT 阅读代码
↓
判断需要 Codex
↓
delegate_codex
↓
Codex 在当前 workspace 修改
↓
ChatGPT 查看 git diff
↓
ChatGPT 验收
```

这是整个项目第二个关键里程碑。

---

## 17. P4：加入 DSV4F

Codex 链路稳定后增加：

```text
delegate_dsv4f
```

主要承担：

- 文件批量分析。
- 搜索。
- 文档整理。
- 代码粗审。
- 大量机械性阅读。
- 不值得消耗 Codex 的简单任务。

最终形成：

```text
ChatGPT = 总控
DSH     = Runtime / Tool Bus
Tools   = 无模型本地动作
Codex   = 重型编码执行 Agent
DSV4F   = 低成本执行 Agent
```

---

## 18. P5：DSH Session 能力验证与可选 Handoff

在核心 Tool Bridge 和 Subagent 稳定后，再验证：

```text
SessionPersistence
SessionQuery
Compaction
SessionReference
```

重点验证：

- Bridge Session 是否能正常持久化和查询。
- Codex / DSV4F Child Session 是否能完整保存。
- Parent / Child Session 是否正确。
- Session Search 是否能找回过去执行任务。
- Event Read 是否能恢复原始工具执行细节。
- Compaction 是否能用于 DSH 自己的长 Session。

如果实际需要，再增加少量 ChatGPT 可调用的历史工具：

```text
session_search
session_read
session_reference
```

以及可选：

```text
create_handoff
```

这些工具用于查 DSH 执行历史或辅助 ChatGPT 跨长会话迁移，不发展为独立 Long-Term Memory 系统。

---

## 19. 暂时明确不做的东西

当前阶段不进入 ChatGPT-DSH 核心：

- 独立 Long-Term Memory。
- Memorix / Engram 接入。
- Embedding / 向量数据库。
- Knowledge Graph。
- Memory Consolidation。
- 自动 Memory 提炼。
- ChatGPT Conversation Archive。
- Tampermonkey Transcript Capture。
- 自研 ChatGPT 备份工具。
- 旧 coding-tools MCP。
- 独立 allowed-folder / workspace 配置。
- 自研文件系统 Sandbox。
- 自研 Shell Sandbox。
- Gateway 自动下载 / 管理 frpc。
- Gateway 自动管理 Cloudflare Tunnel。
- GUI。
- 完整 CLI 管理平台。
- 多租户。
- 自动 Agent 路由。
- 多 Codex 并行。
- ChatGPT Desktop 特殊适配。

如果以后确实需要，再作为独立问题重新评估。

---

## 20. 下一步实际开发任务

当前仍然只做一件事：

> **完成 P0：最小 DSH MCP Tool Bridge。**

具体顺序：

1. 保持 ChatGPT-DSH 为 DSH Plugin。
2. 确认当前 DSH 插件加载方式和生命周期。
3. 获取 `ctx.tools`。
4. 调用 `ctx.tools.schemas()`。
5. 选择 2~3 个 DSH 原生安全测试工具暴露到 MCP。
6. 实现 `tools/call → ctx.tools.execute()`。
7. 使用 MCP Inspector 验证。
8. 测试 list / read / write 或 patch。
9. 确认没有调用旧 coding-tools MCP。
10. 确认没有重新实现文件读写能力。
11. P0 通过后再进入 HTTP / ChatGPT 真机链路。

---

## 21. P0 验收标准

以下全部满足才进入 P1：

- DSH 可以正常加载 ChatGPT-DSH 插件。
- MCP Inspector 能正常连接。
- `tools/list` 能看到允许暴露的 DSH 工具。
- 能通过 MCP 调用 DSH 读取文件。
- 能通过 MCP 调用 DSH 创建或修改测试文件。
- 工具错误可以正常转换成 MCP Error。
- 停止插件后没有残留进程。
- 没有重新实现任何 DSH 已有文件 / Shell 工具。
- 没有接回旧 coding-tools MCP。
- P0 没有引入 Memory、Archive 或独立 workspace 配置。

---

## 22. 当前最重要的设计原则

后续每个需求先依次问：

```text
1. DSH 已经有这个能力了吗？
        │
        ├─ 有 → 直接复用
        │
        └─ 没有
             ↓
2. 这是 ChatGPT-DSH Bridge 必须承担的吗？
        │
        ├─ 是 → 做最薄适配
        │
        └─ 不是 → 移出项目
```

最终保持：

```text
薄 ChatGPT-DSH Bridge
+
厚 DSH Runtime
+
ChatGPT 自身 Memory / 主控能力
```

而不是重新长成：

```text
第二套 Harness
+
第二套 Memory
+
第二套 Backup
+
第二套 Workspace Runtime
```

一句话总结：

> **ChatGPT 是脑子，DSH 是 Runtime 和工具总线，ChatGPT-DSH 只负责把两者接起来。**
