# P2-C1 Tool Security Boundary Audit

审计日期：2026-08-31  
审计对象：ChatGPT-DSH `main@6f8951d`、本机实际安装的 `@deepseek-ai/dsh@0.1.1-rc.1`  
性质：Audit / Design only；未修改核心代码，未扩大 allowlist，未提交。

路径约定：

- `<repo>` = `D:\work\openSource\ChatGPT-DSH`
- `<dsh>` = `D:\program\nodejs\node_global\node_modules\@deepseek-ai\dsh`
- `<dsh-ai>` = `<dsh>\node_modules\@deepseek-ai`

## 1. Executive Summary

结论边界如下：

```text
ChatGPT / MCP client
  └─ 用户意图确认、远端调用入口
ChatGPT-DSH
  └─ 认证、Tool Exposure/Profile、schema/result/metadata adapter
DSH Tool Runtime
  └─ 参数校验、policy pipeline、能力调用、sandbox、approval、审计
OS / Windows ACL runner
  └─ 实际受限进程与文件写入强制
```

最重要的结论：

1. 当前 Bridge 的安全职责划分正确：它调用 `ctx.tools.schemas()` / `ctx.tools.execute()`，没有复制文件或 Shell runtime。文件路径边界、Shell 写入约束与提权必须继续由 DSH 负责。
2. 当前实际 MCP `tools/list` 只有 `read`、`write`、`edit`；`write/edit` 的 `sandbox_permissions` 与 `justification` 已随 DSH `parameters` 原样进入 MCP `inputSchema`，不存在“Bridge 丢失提权参数”的问题。
3. 文件 `write/edit` 经过 `dsh-fs-sandbox`，默认 `workspace-write` 的 root 已是 `SessionHeader.cwd`；这一链路成立。文件读取在所有模式下都不受 root 限制。
4. Windows 上正确的 Shell capability 是 `dsh-pwsh-sandbox`，不是 `dsh-pwsh-local`。当前 web host 已绑定 sandbox-aware `ctx.shell`，但 web surface 把全局 `tool-pwsh` 禁用了，项目 patch 也没有重新启用它，所以 Bridge 当前不能直接发现/暴露 `pwsh`。
5. 当前 Windows ACL backend 在宿主机可启动，但明确报告 `enforcement: 'partial'`。普通 NTFS 路径的 workspace 内写入成功、workspace 外写入被拒；读取、网络、进程可见性并不隔离，Everyone ACL、硬链接、非 ACL 卷等仍是已知缺口。
6. 当前 Approval 的实测 blocker 是 DSH Session 没有 open turn。Bridge 的 `{ id, session }` actor 能把 session/cwd/observation 送入工具，但显式 escalation 在 `ApprovalService.request()` 处以 `outside an open turn` fail closed。
7. 当前安装版本的正式 TypeScript API 把 `ToolExecutionInput.agent` 声明为完整 `Agent`；Bridge 的 minimal actor 只是运行时结构兼容，不是上游类型契约。不能把“当前部分路径恰好只读取 session”提升为长期兼容保证。
8. `glob/grep` 是 `dsh-tool-fs-search` 提供的固定 ripgrep argv 工具，但它们直接走未隔离的 `ctx.subprocess`，不注入 `ctx.fs`，也不经过 fs-sandbox。它们是只读效果工具，不是 workspace read-boundary 工具。
9. DSH 没有原生 Git Tool/package。Git 应通过 sandbox-aware `pwsh` 使用，Bridge 不应自建 Git wrapper；在原生 Git capability 出现前，Git 不能获得比 Shell 更窄的强制边界。
10. DSH `ToolSchema` 只有 `name/description/parameters`。当前 Bridge 只映射这三项；MCP SDK 1.30.0 支持 `annotations` hints，但当前 SDK Tool schema 没有 `securitySchemes` 字段。Annotation 必须由 Bridge profile 明确映射，且只能作为客户端提示，不能替代 DSH enforcement。

Blocker 判定：

- **阻塞 Shell / 文件提权正式开放**：minimal execution scope 没有 DSH open-turn 生命周期，无法进入 Approval audit pair。
- **阻塞直接开放 `pwsh`**：web global registry 中 `tool-pwsh` 当前 disabled，且 Approval blocker 尚未解决。
- **阻塞把 Windows sandbox 宣称为完整 OS 隔离**：当前 enforcement 固定是 `partial`。
- **不是 blocker、但必须显式接受的风险**：read/glob/grep 可读取 workspace 外宿主可读数据。

## 2. Current ChatGPT-DSH Security Model

当前调用链：

```text
MCP tools/list
  → ctx.tools.schemas()
  → Bridge allowlist
  → MCP Tool

MCP tools/call
  → Bridge allowlist
  → ctx.tools.execute({ callId, name, arguments, signal, agent })
  → DSH tools/pre-execute / guards / tools/execute / tools/post-execute
  → DSH Tool implementation
  → DSH capability (ctx.fs / ctx.shell / ctx.subprocess)
  → sandbox / approval（按具体 capability）
```

Bridge 当前负责：

- localhost HTTP MCP + Bearer Token；
- 静态 Tool allowlist；
- DSH schema/result 到 MCP 的适配；
- Stable Bridge Session 与 DSH execution session 生命周期；
- 把 Host cwd 写入 `SessionHeader.cwd`。

DSH 当前负责：

- Tool Registry、参数校验、执行流水线；
- fs-observation-policy；
- fs-sandbox 与 Shell process sandbox；
- sandbox mode/workspace root 解析；
- escalation 的严格扩权检查、Approval、审计与 fail-closed；
- 子进程输出、timeout/cancel 的底层机制。

不应在 Bridge 中增加：

- 第二套路径/allowed-folder/workspace root；
- Shell 命令字符串黑名单；
- 自研文件或 Shell sandbox；
- 自研 Approval 状态机；
- 为 Git 复制 subprocess runtime。

当前配置事实：

- `<repo>\src\index.ts:40`：`ALLOWED_TOOLS = ['read', 'write', 'edit']`。
- `<repo>\src\tools-bridge.ts:145-154`：`schemas()` 后 allowlist，再映射到 MCP。
- `<repo>\src\tools-bridge.ts:169-175`：所有调用进入 `tools.execute()`，带当前 execution actor。
- `<repo>\src\execution-scope.ts:68-83`：`prepare → enter → announce`，actor 为 `{ id, session }`。
- `<repo>\src\index.ts:46-74`：启动时捕获一次 `process.cwd()`，写入所有 execution session。

## 3. DSH Tool Inventory

### 3.1 当前 profile 的真实组合

`dsh web` 由 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` 组成：

- Base 在 Windows 启用 `pwsh-sandbox`/`tool-pwsh`，禁用 bash twin；见 `<dsh-ai>\dsh-base\cordis.patch.yml:163-216`。
- Base 启用 `fs-observation-policy`、`tool-fs`、`tool-fs-search`；见同文件 `:221-230`。
- Base 的 provider 是 `fs-sandbox`，不是 bare `fs-local`；见同文件 `:441-444`。
- Web surface 随后把全局 `tool-pwsh`、`tool-fs`、`tool-fs-search` 禁用，让普通 Web Agent 从 preset scope 提供工具；见 `<dsh-ai>\dsh-web-app\cordis.patch.yml:300-340`。
- 项目 `<repo>\cordis.patch.yml:12-18` 只重新启用 `tool-fs` 与 `tool-fs-search`，没有重新启用 `tool-pwsh`。

### 3.2 相关 Tool 清单

| 实际 Tool 名称 | 来源 | 当前 global DSH registry | 当前 MCP 暴露 | Capability / sandbox 事实 |
|---|---|---:|---:|---|
| `read` | `@deepseek-ai/dsh-tool-fs` | 是 | 是 | 走 `ctx.fs`；相对路径默认 `SessionHeader.cwd`；读取不受 fs-sandbox root 限制 |
| `write` | `@deepseek-ai/dsh-tool-fs` | 是 | 是 | 走 `ctx.fs.writeText`；`dsh-fs-sandbox` 约束 mutation；支持 one-shot escalation schema |
| `edit` | `@deepseek-ai/dsh-tool-fs` | 是 | 是 | 同上；另受 fs-observation-policy 的 read-before-edit/CAS 约束 |
| `read_image` | `@deepseek-ai/dsh-tool-fs`（有 attachments 时条件注册） | 源码/组合推断为可注册；本轮未做 live MCP 暴露验证 | 否 | 读取能力；不受写 sandbox root 限制 |
| `glob` | `@deepseek-ai/dsh-tool-fs-search` | 项目 patch 已启用 | 否 | 固定 `ripgrep` argv，直接走 unconfined `ctx.subprocess`，不是 `ctx.fs`；结果超限时可写 DSH 管理的 spill artifact |
| `grep` | `@deepseek-ai/dsh-tool-fs-search` | 项目 patch 已启用 | 否 | 同上 |
| `pwsh` | `@deepseek-ai/dsh-tool-pwsh` | web global scope 禁用；标准 Agent preset 可在其自身 scope 注册 | 否 | 若在当前 host composition 重新启用，会消费 sandbox-aware `ctx.shell` |
| `bash` | `@deepseek-ai/dsh-tool-bash` | Windows 平台禁用 | 否 | POSIX twin；当前机器不是有效 Shell Tool |
| list / directory-list | 无模型向 Tool | 否 | 否 | `ctx.fs.listDir` 是 capability 方法，但当前没有独立 Tool schema；`glob` 明确只返回文件、不列目录 |
| patch / apply_patch | 无相关 DSH Tool | 否 | 否 | 不应凭名称假设存在 |
| Git Tool | 未安装任何 `dsh-tool-git`/Git capability | 否 | 否 | 未来走 sandbox-aware `pwsh` 或等待 DSH 原生能力 |

实际 MCP `tools/list`（2026-08-31、本机独立审计实例）返回且只返回：

```text
read
write  (+ sandbox_permissions, justification)
edit   (+ sandbox_permissions, justification)
```

证据：

- `read` 注册：`<dsh-ai>\dsh-tool-fs\lib\index.js:326-432`。
- `write` 注册与执行：同文件 `:597-674`。
- `edit` 注册与执行：同文件 `:742-825`。
- fs tool suite apply：同文件 `:1168-1210`。
- `glob` 注册与执行：`<dsh-ai>\dsh-tool-fs-search\lib\index.js:764-844`。
- `grep` 注册与执行：同文件 `:1073-1155`。
- search 结果超限时可调用 `ctx.spillStore.saveText()` 保存完整格式化结果：同文件 `:268-305, :851, :1166`。
- search suite 明确注入 `subprocess` 而非 `fs`：同文件 `:1195-1213`。
- `pwsh` Tool schema/execute：`<dsh-ai>\dsh-tool-pwsh\lib\index.js:192-405`。

## 4. Filesystem Security

### 4.1 cwd 与 path resolution

`dsh-tool-fs` 的 `sessionCwd()` 读取 `exec.agent?.session.header.cwd`；非 agent 调用才把 fallback 留给 provider。见 `<dsh-ai>\dsh-tool-fs\lib\index.js:223-258`。

当前 Bridge 在 session 创建时将 Host cwd 写入 header：

```text
process.cwd() at plugin startup
  → sessions.prepare(id, { meta: { cwd } })
  → SessionHeader.cwd
  → tool-fs sessionCwd()
  → sandboxPolicy.resolve({ session }).workspaceRoot
```

因此 P2-B 已经天然满足：

```text
Bridge Session cwd → DSH Sandbox workspaceRoot
```

### 4.2 read

`read` 经 `ctx.fs.resolve/stat/readText|streamText`，会记录 `fs/observed`，但不会请求 sandbox policy。`dsh-fs-sandbox` 明确“Reads pass through untouched: every mode permits reading”；见 `<dsh-ai>\dsh-fs-sandbox\lib\index.js:67-95`。

所以：

- `read-only` 不是“只能读取 workspace”；
- `workspace-write` 不是“workspace 外不可读”；
- absolute path 和 `..` 可读取任何宿主账号本来可读的文件；
- Bridge 当前没有也不应偷偷补第二套 read path filter；若产品需要 read containment，应推动/选择 DSH 原生 read-confined capability。

### 4.3 write / edit

`write/edit` 每次调用：

1. 从 `ctx.sandboxPolicy` 解析 standing policy；
2. 用 policy workspace root 解析 target；
3. 经过 observation intent；
4. 把完整 per-call policy 交给 `ctx.fs.writeText/editText`；
5. `dsh-fs-sandbox.checkedTarget()` 在 mutation 前重新 canonicalize 并做 containment。

证据：

- write policy/capability 调用：`<dsh-ai>\dsh-tool-fs\lib\index.js:653-667`。
- edit policy/capability 调用：同文件 `:802-820`。
- fs sandbox 只围栏两种 mutation：`<dsh-ai>\dsh-fs-sandbox\lib\index.js:107-169`。
- `read-only` 全部拒绝；`workspace-write` 仅允许 `writableRoots(policy)`；`danger-full-access` 不围栏：同文件 `:157-169`。
- writable roots 是 workspace + platform temp：`<dsh-ai>\dsh-sandbox\lib\index.js:145-160`。

### 4.4 fs-observation-policy

Observation owner 是 `actor?.agent?.session`；当前 minimal actor 可满足这一点。未读直接 edit 失败，已读文件按 version CAS，未观察 write 只能 create-if-absent。见 `<dsh-ai>\dsh-fs-observation-policy\lib\index.js:15-74`。

### 4.5 filesystem escalation

当 confining filesystem provider 存在时，`write/edit` schema 动态增加：

```text
sandbox_permissions: workspace-write | danger-full-access
justification: non-empty string
```

执行时先校验参数配对，再要求严格变宽，再走 `ctx.approval`，批准后只把更宽 mode 盖到本次调用。见 `<dsh-ai>\dsh-tool-fs\lib\index.js:1077-1143`。

## 5. Shell Security

### 5.1 八个必答问题

1. **哪个是 sandbox-aware shell capability？**  
   Windows 是 `@deepseek-ai/dsh-pwsh-sandbox` 提供的 `SandboxPwshExecutor`（注册为 `ctx.shell`）；`@deepseek-ai/dsh-pwsh-local` 是它继承的无约束本地执行器，不应单独用于 Core Profile。

2. **当前 dsh web profile 默认绑定哪个？**  
   Base 在 win32 启用 `pwsh-sandbox`、禁用 `bash-sandbox`，所以 host capability 是 sandbox-aware。Web surface 另行把全局 model-facing `tool-pwsh` disabled。

3. **Bridge 如果直接暴露 `pwsh`，走 local 还是 sandbox？**  
   仅在当前 composition 中重新启用 `tool-pwsh` 时，它注入到的是现有 `ctx.shell = SandboxPwshExecutor`，最终走 sandbox backend；不得另挂 `pwsh-local`。当前状态因 `tool-pwsh` 未注册到 global scope，单纯扩大 Bridge allowlist 也不会得到 schema。

4. **Shell 默认 cwd 从哪里取得？**  
   `workdir` 显式值优先；相对 workdir 相对于 `SessionHeader.cwd`；未提供时使用 `SessionHeader.cwd`；再缺失才由 executor config/process cwd fallback。见 `<dsh-ai>\dsh-tool-pwsh\lib\index.js:146-155,360-375` 与 `<dsh-ai>\dsh-pwsh-local\lib\index.js:243-262`。

5. **Shell sandbox workspace root 是否来自 `SessionHeader.cwd`？**  
   是。Tool 调用 `sandboxPolicy.resolve({ session })`，service 在 `:138-144` 使用 `session?.header.cwd ?? configuredRoot`。

6. **workspace-write 下，Shell workspace 外写入会否拒绝？**  
   普通 NTFS 边界会拒绝，但只能按 partial enforcement 承诺。本轮宿主实测：独立随机临时 workspace 内 `Set-Content` exit 0 且文件存在；同级 workspace 外 `Set-Content` 返回 Access Denied/exit 1，目标不存在；临时目录已清理。

7. **danger-full-access 如何进入？**  
   Tool 的 `sandbox_permissions: 'danger-full-access'` + `justification` 经 Approval 成功后，只覆盖一次 call 的 policy；executor 在该 mode 直接走 local execution。DSH 另外有 session mode/preset 全局切换机制，但 Bridge Core Profile 不应暴露或模拟该切换。

8. **当前 Windows enforcement？**  
   Backend 可用且是 `partial`。宿主环境运行 DSH 自带 read-only runner probe 成功（exit 0）；`sandbox-local` 把 `windows-acl` 静态标记为 partial。沙箱内嵌套探针曾因受限令牌嵌套报 Win32 87，这不是宿主可用性结论，宿主复测已排除。

### 5.2 真实调用链

```text
pwsh Tool
  → resolveSandboxPolicy(exec.agent.session)
  → optional approveEscalation()
  → ctx.shell.resolve/run
  → SandboxPwshExecutor
  → ctx.sandbox.confine(exact pwsh argv, policy)
  → dsh-sandbox-local
  → dsh-sandbox-windows-acl runner
  → pwsh -NoLogo -NoProfile -NonInteractive -Command <command>
```

关键证据：

- Tool 的 cwd/policy/Approval：`<dsh-ai>\dsh-tool-pwsh\lib\index.js:192-226,360-405`。
- Sandbox executor：`<dsh-ai>\dsh-pwsh-sandbox\lib\index.js:95-181`。
- `danger-full-access` 绕过 confinement：同文件 `:151-160`。
- local executor exact argv 与 fallback cwd：`<dsh-ai>\dsh-pwsh-local\lib\index.js:243-301`。
- 本机 PowerShell 实际解析第一候选为 `C:\Program Files\PowerShell\7\pwsh.exe`，版本 7.6.4；候选顺序见同文件 `:17-65`。

禁止在 Bridge 扫描 PowerShell 字符串。DSH 把完整 command 作为 `-Command` 的一个 argv 交给 PowerShell，安全边界是 capability + OS runner，不是关键词过滤。

## 6. Git Capability

当前 `@deepseek-ai` 安装树没有 `dsh-tool-git`、Git service 或 Git capability；全包搜索没有注册任何 `git` tool schema。

推荐答案是 **A：通过 sandbox-aware Shell 暴露**，不是 Bridge 自己包装：

```text
git status / git diff / git log
  → pwsh Tool
  → pwsh-sandbox
  → SessionHeader.cwd
  → Windows ACL file-effect boundary
```

限制：

- “只读 Git 子命令”不是当前 DSH 的独立安全 principal；它们仍是 Shell command。
- Git 可读取 config、调用 pager/external diff、刷新 index，具体副作用受用户配置和 Git 行为影响，不能仅凭 command 字符串宣称绝对只读。
- 当前 `GIT_PAGER=cat` 由 pwsh-local 环境提供，能避免交互 pager，但不把 Git 变成独立 capability。
- 在 DSH 原生 Git Tool 出现前，Core Profile 应把 Git 放在 `pwsh` 的 gated 面内；可以做验收场景，但不应制造 `git_status/git_diff` Bridge wrapper。

## 7. Sandbox Policy

实际 mode 闭集来自 `<dsh-ai>\dsh-sandbox-policy\lib\index.js:25-30`：

| Mode | Filesystem Tool | sandbox-aware Shell | 读取 | 网络/进程/OS 隔离 |
|---|---|---|---|---|
| `read-only` | `write/edit` 全拒绝；read 仍允许 | 受限 runner，无显式 writable root；Windows pwsh 通常为 ConstrainedLanguage | 不限制 | 不限制网络/进程可见性，不是完整 OS 隔离 |
| `workspace-write` | workspace + DSH 定义的 temp roots 可写 | workspace + session private temp 可写；其他普通 ACL 路径拒绝 | 不限制 | 同上；Windows pwsh 通常保持 FullLanguage |
| `danger-full-access` | 不做 fs mutation containment | executor 直接走 local | 不限制 | 无 DSH confinement |

Mode 只描述 file effects。正式类型明确写明 network 和 process visibility 在 vocabulary 外：`<dsh-ai>\dsh-sandbox\lib\types\index.d.ts:13-18`。

其他边界：

- **child process**：允许创建；Windows 子进程通常继承 restricted token/file-effect restriction。受限孙进程用 named-pipe stdio 捕获输出存在已知 EPERM 限制；inherit/ignore 与 PowerShell 自己的 pipeline 可用。
- **environment**：不是 sandbox mode 的隔离轴。`dsh-subprocess-local` 从 parent env 移除名称包含 `KEY/PASSWORD/SECRET/TOKEN` 与 ambient `DSH_*`，再合并显式 env；这是凭据启发式清理，不是完整 secret boundary。
- **filesystem read**：所有 mode 都允许；不能用“workspace-write”推导 read containment。
- **process visibility / network**：Windows ACL backend 不限制。

### 7.1 workspaceRoot 优先级

`SandboxPolicyService.resolve()` 的真实顺序：

```text
approved per-call mode
  > session sandbox/mode event
  > deployment default mode

SessionHeader.cwd
  > configured workspaceRoot
  > process.cwd()（配置构造 fallback）
```

见 `<dsh-ai>\dsh-sandbox-policy\lib\index.js:101-144`。

Base 默认配置：

```text
mode = DSH_PERMISSION_MODE ?? 'workspace-write'
workspaceRoot = process.cwd()
approval = danger-full-access ? never : ask
```

见 `<dsh-ai>\dsh-base\cordis.patch.yml:166-205`。本轮审计环境未设置 `DSH_PERMISSION_MODE`，因此实际默认是 `workspace-write`。

## 8. Windows Enforcement

### 8.1 判定

```text
OS: Windows build 26200
PowerShell: 7.6.4
runner: dsh-sandbox-windows-acl
runner usability: PASS（宿主 read-only probe exit 0）
enforcement: partial
```

`partial` 的准确含义：有实际 backend 在运行并约束普通 ACL 文件写入，但不能治理全部承诺的 file effects；要求绝对边界的调用方不得当成 full。类型定义见 `<dsh-ai>\dsh-sandbox\lib\types\index.d.ts:41-46`。

### 8.2 可靠边界

- runner 不能启动时 fail closed 为 `SANDBOX_UNAVAILABLE`，不会静默降级到 local；见 `<dsh-ai>\dsh-sandbox\lib\index.js:170-199` 与 `<dsh-ai>\dsh-pwsh-sandbox\lib\index.js:165-181`。
- 对普通、由 ACL 管辖的 NTFS 路径，workspace capability SID 允许 workspace 写入，其他路径拒绝。
- workspace-write 的 temp 是 per-session private directory；read-only 没有 temp write grant。
- workspace root 来自当前 session policy，不由 PowerShell command 自行决定。

### 8.3 非完整保证

- 读取、网络、进程可见性不受限制。
- Restricted token 必须保留 Everyone；外部对象若直接授予 Everyone 写权限，仍可能可写。
- NTFS hard link 让 workspace 内路径与外部对象共享同一文件对象，是 path/ACL 模型缺口。
- 非 ACL/FAT 类目标可能保持可写；不应把 sandbox 用于不受支持的卷。
- console isolation 不可用；受限 child 共享 host console。
- workspace ACE 是真实目录上的常驻授权/缓存；session private temp ACE 才在 dispose 时撤销。
- read-only pwsh 的 ConstrainedLanguage 和 workspace-write 的 FullLanguage 是 PowerShell 启动行为，不等于 read/network/process 隔离。

源码边界见 `<dsh-ai>\dsh-sandbox-windows-acl\lib\types\index.d.ts:1-40`；更完整的 Everyone/hard-link/named-pipe/FAT 说明见该 package 的 `README.zh.md:55-105`。

### 8.4 对目标使用场景的影响

对于“用户自己的开发机 + 自己选择的项目”：

- `workspace-write` 对防止普通误写到其他 NTFS 目录有实际价值，本轮实测成立；
- 它不是针对恶意本机代码或 hostile repository 的强隔离，不应承诺可安全运行任意不可信脚本；
- Shell 默认仍应 gated，network operations 默认不暴露；
- UI/文档应显示 Windows partial，而不是只显示“sandbox on”。

## 9. Approval Pipeline

### 9.1 显式 sandbox escalation

```text
Tool args: sandbox_permissions + justification
  → validateEscalationArgs()
  → standing sandboxPolicy.resolve(session)
  → requested mode must be strictly wider
  → ctx.get('approval') must exist
  → exec.agent must exist
  → approval.request({ agent, toolName, callId, reason, signal })
  → session must currently have open turn
  → append approval/asked
  → approval/request waterfall answerer
  → append approval/decided
  → only allowed-once returns requested mode
  → one Tool call executes with overlaid mode
```

证据：

- 严格扩权表与 fail-closed outcome：`<dsh-ai>\dsh-sandbox\lib\index.js:23-111`。
- Approval open-turn/audit pair：`<dsh-ai>\dsh-user-approval\lib\index.js:55-69,127-160`。
- 默认 `ask/never` policy 与 missing answerer fail closed：同文件 `:162-201`。
- Web answerer把 pending request 推到 client mux：`<dsh-ai>\dsh-host-apiproxy\lib\index.js:1906-1963`。
- Generic `tools/pre-execute → ask` 也走同一 Approval service：`<dsh-ai>\dsh-tools\lib\index.js:3094-3128,3292-3353`。

### 9.2 九个必答问题

1. **workspace-write 被拒后如何请求提权？**  
   原 Tool 精确重试一次，加最窄的 `sandbox_permissions` 与 `justification`；Tool body 在任何文件/Shell action 前请求 Approval。

2. **参数如何参与？**  
   二者必须成对出现，justification 非空；目标必须比当前 mode 严格更宽。它们不是 session 配置，而是本次 call 的请求。

3. **Approval API/Service 在哪里？**  
   `@deepseek-ai/dsh-user-approval` 的 `ctx.approval` / `ApprovalService.request()`。

4. **capability 从哪里取得 responder？**  
   Tool layer 用 `ctx.get('approval')`；Approval service 通过 `approval/request` waterfall 找 answerer。web profile 的 answerer在 `dsh-host-apiproxy`。

5. **是否要求完整 DSH Agent？**  
   上游类型契约要求 `Agent`；当前运行时代码的 escalation/默认 Web answerer主要读取 `agent.session`，scope routing 把 agent object 当 opaque key。但这不足以承诺所有 answerer/plugin 都兼容 minimal actor。

6. **当前 actor 能否直接进入 Approval？**  
   不能完成。它能到达 `ApprovalService.request()`，但 session 没有 open turn，实测在 audit append 前 fail closed。

7. **最小需要补什么 context？**  
   首先是 DSH 支持的、durable 的 open-turn execution boundary，使 `approval/asked + approval/decided` 被 turn 包围；其次必须明确上游是否支持 external/minimal actor。不能直接伪造 turn event 或假装实现完整 Agent。若 DSH 没有正式 external tool-call turn API，应使用完整 Agent/execution API或推动上游增加窄接口。

8. **没有 responder 是否 fail closed？**  
   是：无 approval service、无 agent、policy=`never`、无 answerer、answerer throw/非法 outcome、cancel、reject 都不会执行更宽权限动作。

9. **danger-full-access 是否应一次性？**  
   是。Bridge 应只接受 DSH Tool 原生 per-call escalation，不暴露 session global sandbox-mode switch。

### 9.3 本轮 live 验证

使用独立 MCP session，对项目 workspace 外明确命名且原本不存在的目标执行：

1. 普通 `write`：返回 `[sandbox: file access denied under workspace-write mode]`。
2. 同一 `write` + `sandbox_permissions='danger-full-access'` + justification：返回 `approval.request() outside an open turn...`。
3. 目标文件最终不存在。

这同时证明：

- sandbox 参数已从 MCP 到 DSH execute；
- Approval 发生在 mutation 前；
- 当前缺失 open turn 时 fail closed；
- blocker 不是 Bridge schema 丢字段。

## 10. Minimal Agent Compatibility

当前 Bridge actor：

```ts
{ id: session.id, session }
```

已证明兼容：

- `fs-observation-policy` 的 session-keyed state；
- `sandboxPolicy.resolve({ session })`；
- filesystem read/write/edit；
- Stable Bridge Session 下的 observation continuity。

未满足/未承诺：

- DSH open turn；
- 正式 `Agent` API 的 `options/inbox/status/ctx/cancel/whenIdle/...`；
- Agent preset scope 中注册的 Tool（例如 web standard preset 的 `pwsh`）；
- 完整 Agent Loop 的 tool/call、tool/result 与 turn audit 生命周期。

正式类型证据：

- `ToolExecutionInput.agent?: Agent`：`<dsh-ai>\dsh-tools\lib\types\index.d.ts:196-219`。
- 完整 `Agent` 成员：`<dsh-ai>\dsh-agent\lib\types\runtime-types.d.ts:59-132`。
- Bridge 自己只声明 `{id, session}`：`<repo>\src\tools-bridge.ts:35-39`。

准确结论：

> 当前 minimal actor 对 fs/sandbox 是已验证的运行时结构兼容；对 Approval 它能路由到 service，但因没有 open turn 失败。默认 Web answerer当前只需要 session id/events，因此“完整 Agent 的所有字段”不是这次实测失败的直接原因；然而上游公开类型仍要求完整 Agent，所以必须把外部执行上下文作为 P2-C 的显式兼容层处理，不能依赖偶然的字段最小集。

## 11. MCP Tool Metadata

### 11.1 当前实际映射

`<repo>\src\tools-bridge.ts:145-154` 当前只输出：

```text
DSH name        → MCP name
DSH description → MCP description
DSH parameters  → MCP inputSchema
```

没有输出：

```text
annotations
readOnlyHint
destructiveHint
idempotentHint
openWorldHint
outputSchema
execution
_meta
securitySchemes
```

### 11.2 DSH 与 SDK 能力

- DSH `ToolSchema` 实际只有 `name/description/parameters`：`<dsh-ai>\dsh-llm\lib\types\types.d.ts:318-330`。
- `ctx.tools.schemas()` 也只投影这三项：`<dsh-ai>\dsh-tools\lib\index.js:2901-2931`。
- MCP SDK 1.30.0 支持 `annotations` 的 `title/readOnlyHint/destructiveHint/idempotentHint/openWorldHint`：`<repo>\node_modules\@modelcontextprotocol\sdk\dist\esm\types.js:1162-1211`。
- SDK Tool schema 另支持 `outputSchema/execution/_meta`：同文件 `:1227-1273`。
- 当前安装 SDK 中没有 `securitySchemes` Tool 字段（源码精确搜索无命中），因此不能“直接透传”；当前 Bearer auth 是 HTTP transport/server policy，不是 Tool metadata。

### 11.3 推荐 adapter mapping

DSH 没有这些 hints，因此必须由 ChatGPT-DSH 的明确 Core Profile 维护，不应从 description 猜测：

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | 说明 |
|---|---:|---:|---:|---:|---|
| `read`, `read_image` | true | false | true | false | 不修改环境，但可读 workspace 外本机数据 |
| `glob`, `grep` | true | false | true | false | 目标语义是固定本地 search；不是 read containment。结果超限时的 DSH-managed spill 属于 transport artifact；若 client 对 `readOnlyHint` 采用“零内部写入”的严格解释，则应省略该 hint |
| `write` | false | true | false | false | 可覆盖现有文件；重复写仍会执行实际 mutation |
| `edit` | false | true | false | false | literal replace 非幂等 |
| `pwsh` | false | true | false | true | 任意 command 可访问进程/网络/外部实体；annotation 不能表达每条 command 的实际副作用 |

注意：MCP annotations 是 hint，不是授权。即使 ChatGPT 显示确认，DSH sandbox/Approval 仍必须独立执行。

## 12. Recommended Core Tool Profile

### 12.1 Safe default（只读效果；不代表 workspace read containment）

| Tool | 来源 | sandbox-aware | 默认 mode | Approval | 是否适合暴露 |
|---|---|---|---|---|---|
| `read` | `dsh-tool-fs` | 仅 mutation provider 有 sandbox；read 本身不围栏 | N/A（mode 不限制 read） | 否 | 已暴露；仅在接受“可读宿主账号可读路径”后视为 safe default |
| `read_image` | `dsh-tool-fs` | 同 `read` | N/A | 否 | 可选；先做 live schema/result/大小验证 |
| `glob` | `dsh-tool-fs-search` | 否，固定 argv unconfined subprocess | N/A | 否 | 可暴露为 read-only discovery，但必须记录 absolute path/read scope 风险 |
| `grep` | `dsh-tool-fs-search` | 否，固定 argv unconfined subprocess | N/A | 否 | 同上；应先补 annotation 与 result/timeout 验收 |

`list` 当前不存在，不能加入 profile。若仅需找文件，使用实际 `glob`；不要把它描述为目录 listing。

### 12.2 Workspace-write

| Tool | 来源 | sandbox-aware | 默认 mode | Approval | 是否适合暴露 |
|---|---|---|---|---|---|
| `write` | `dsh-tool-fs` + `dsh-fs-sandbox` | 是 | `workspace-write` | workspace 内否；one-shot 扩权是 | 当前适合 workspace 内使用；扩权在 Approval blocker 修复前不可用 |
| `edit` | 同上 + fs-observation-policy | 是 | `workspace-write` | 同上 | 当前适合；保留 read-before-edit |

`patch/apply_patch` 当前不存在，不加入。

### 12.3 Sensitive / gated

| Tool / capability | 来源 | sandbox-aware | 默认 mode | Approval | 是否适合暴露 |
|---|---|---|---|---|---|
| `pwsh` foreground | `dsh-tool-pwsh` + `dsh-pwsh-sandbox` | 是，Windows partial | `workspace-write` | 只有显式 escalation 需要 DSH Approval；另建议 ChatGPT confirmation | 当前不开放；先解决 registry scope、Approval、cancel/result limit |
| `pwsh` background | 同上 + jobs | 是，但生命周期更长 | `workspace-write` | 同上 | Core 第一阶段禁用；等待 cancel/job ownership 独立验收 |
| Git status/diff/log | 无独立 Tool，经 `pwsh` | 继承 Shell | `workspace-write` | 继承 Shell | 作为 gated Shell 场景验收，不创建 Bridge wrapper |
| Git commit/push | 经 `pwsh` | commit 受文件边界；push 的 network 不受 sandbox mode 限制 | `workspace-write` | 仅文件扩权不足以覆盖远端副作用；需 ChatGPT confirmation/产品 policy | 默认不暴露为独立能力 |
| `danger-full-access` | 不是 Tool，是 per-call mode | 绕过 confinement | N/A | 必须 `allowed-once` | 只允许原生 one-shot escalation；不暴露 session switch |
| network operations | 通常经 Shell/未来原生 Tool | Windows sandbox 不限制 network | N/A | DSH file Approval 不能代替 network consent | 默认不暴露；需要独立产品 policy/metadata |

## 13. Recommended P2-C Stage Breakdown

每阶段应独立测试、验收、commit：

### P2-C1 Security Audit（本轮）

- 固化真实 tool/sandbox/approval/metadata 结论；
- 输出本临时文档；
- 不改代码。

验收：基线 checks、源码证据、live schema、Approval fail-closed、Windows runner probe/临时 workspace test。

### P2-C2 MCP Metadata + Registry Contract

- 为现有 `read/write/edit` 增加显式 profile-owned annotations；
- 增加 DSH schema 缺失、Tool name collision、allowlist 不存在项的 fail-fast/test；
- 明确当前 SDK 无 `securitySchemes`，不伪造字段。

验收：MCP `tools/list` 精确快照；read/write/edit hints 正确。

### P2-C3 Core Read/Search Profile

- 在接受 read-scope 风险后加入实际 `glob/grep`；
- 不新增 list wrapper；
- 验证 session cwd、absolute path 行为、timeout、raw/result cap 与取消。

验收：workspace 内 glob/grep；read-only metadata；超量/timeout/cancel 不泄漏或挂起。

### P2-C4 Approval-Compatible Execution Context

- 研究并接入 DSH 正式支持的 external tool-call turn/execution API；
- 若上游没有，先形成 upstream contract，不手写 `turn/start/end`；
- 证明 `approval/asked`/`approval/decided` 被同一 open turn 包围；
- 证明 Web answerer、reject、unavailable、cancel 全部 fail closed。

验收：一次无副作用模拟 ask + 一次被拒 escalation；session log audit pair 完整。

### P2-C5 Filesystem One-Shot Elevation

- 在 P2-C4 后验证 `write/edit` escalation；
- 只允许精确重试、严格更宽、allowed-once；
- 不提供 session global mode 切换。

验收：普通拒绝 → approve once → 单次执行；下一次恢复 standing mode；reject/unavailable 不写入。

### P2-C6 Timeout / Cancel / Result Limits

- 把 MCP cancellation 接入 DSH caller-owned `AbortSignal`；
- 增加 Bridge result size policy；
- 验证 DSH tool timeout 与 Bridge/MCP 生命周期一致。

验收：read/search/Shell 前置的通用安全基础；每种 cancel path 不遗留进程/session。

### P2-C7 Sandbox-Aware Foreground PowerShell

- 只重新启用 DSH 原生 global `tool-pwsh`，继续使用 `pwsh-sandbox`；
- Core 第一阶段 `enableRunInBackground: false`；
- 加入 allowlist/annotations/ChatGPT confirmation；
- UI 明示 Windows `partial`；绝不扫描 command string。

验收：默认 cwd、workspace 内写成功、外写拒绝、runner unavailable fail closed、one-shot escalation、network 不受 mode 限制的文档/测试事实。

### P2-C8 Git via Shell Acceptance

- 不新增 Git wrapper；
- 以 `pwsh` 场景验收 `git status/diff/log`；
- 单独记录 Git config/external process/index refresh 风险；
- `commit/push` 仍保持 sensitive，不进入默认 profile。

验收：目标 repo cwd 正确，输出受限，未误改仓库；后续如 DSH 提供原生 Git Tool，再重审 profile。

## 14. Blockers / Risks

### Blocking

1. **Approval turn blocker**：当前 escalation 实测永远在 mutation 前因无 open turn 失败；修复前不能宣称支持 DSH Approval/elevation。
2. **Shell registry scope blocker**：`tool-pwsh` 在 web global scope disabled；只改 Bridge allowlist 不会产生 Tool。
3. **Typed actor compatibility blocker**：上游 API 要求完整 `Agent`，minimal actor 是未正式化的结构兼容；必须得到正式 external execution contract。

### Non-blocking but material

1. Windows enforcement 是 partial，不是 full。
2. 所有文件 read 不受 workspace root 限制。
3. `glob/grep` 不经过 fs/shell sandbox；搜索目标效果是固定 argv 的只读 subprocess，但超限结果可产生 DSH-managed spill artifact。
4. Windows sandbox 不限制网络、进程可见性；Shell 可调用外部程序。
5. MCP annotations 当前缺失；它们只能改善 client UX，不能承担安全 enforcement。
6. 当前 Bridge `AbortController` 在请求结束 finally 才 abort，尚未证明 MCP cancel 会中止正在运行的 DSH Tool。
7. `securitySchemes` 不在当前 SDK Tool schema，认证仍是 endpoint-level Bearer policy。
8. Background Shell 会扩大生命周期、job ownership、cancel 与输出风险，不应随 foreground 一起开放。

## 15. Evidence / Source Locations

### Repository

- `<repo>\package.json:19-29`：typecheck/test 与依赖版本。
- `<repo>\cordis.patch.yml:1-23`：只重新启用 fs/fs-search，插入 Bridge。
- `<repo>\src\index.ts:36-75`：inject、allowlist、workspace cwd、execution scope factory。
- `<repo>\src\tools-bridge.ts:27-76,134-197`：最小 DSH types、schema/result adapter、execute path。
- `<repo>\src\execution-scope.ts:36-87`：prepare/enter/announce 与 `{id, session}` actor。
- `<repo>\src\http-server.ts`：MCP/Bridge session 生命周期与 actor 传递。
- `<repo>\src\bridge-session.ts:54-69,128-269`：Stable Bridge Session ownership/cleanup。
- `<repo>\README.md:183-221,352-384`：既有 sandbox 验收与后续限制。
- `<repo>\docs\ChatGPT-DSH 总体大纲与下一步开发计划.md:247-306,471-499,590-619`：Tool/Sandbox/职责原则。

### Installed DSH 0.1.1-rc.1

- `<dsh-ai>\dsh-base\cordis.patch.yml:163-230,425-444`：host sandbox/approval/tool/fs composition。
- `<dsh-ai>\dsh-web-app\cordis.patch.yml:300-340`：web global tool disabling。
- `<dsh-ai>\dsh-tool-fs\lib\index.js:223-258,326-432,597-674,742-825,1060-1210`。
- `<dsh-ai>\dsh-fs-sandbox\lib\index.js:67-169`。
- `<dsh-ai>\dsh-fs-observation-policy\lib\index.js:15-95`。
- `<dsh-ai>\dsh-tool-fs-search\lib\index.js:128-185,764-860,1073-1170,1195-1265`。
- `<dsh-ai>\dsh-sandbox-policy\lib\index.js:25-55,78-154`。
- `<dsh-ai>\dsh-sandbox\lib\index.js:23-111,113-199`。
- `<dsh-ai>\dsh-tool-pwsh\lib\index.js:110-155,192-405`。
- `<dsh-ai>\dsh-pwsh-sandbox\lib\index.js:95-220`。
- `<dsh-ai>\dsh-pwsh-local\lib\index.js:17-65,193-351`。
- `<dsh-ai>\dsh-sandbox-local\lib\index.js:136-190,288-371,471-507`。
- `<dsh-ai>\dsh-sandbox-windows-acl\lib\types\index.d.ts:1-40`。
- `<dsh-ai>\dsh-user-approval\lib\index.js:22-201`。
- `<dsh-ai>\dsh-host-apiproxy\lib\index.js:1298-1310,1906-1963`。
- `<dsh-ai>\dsh-tools\lib\index.js:2901-2931,2985-3045,3094-3185,3292-3353`。
- `<dsh-ai>\dsh-tools\lib\types\index.d.ts:196-219,673-690`。
- `<dsh-ai>\dsh-agent\lib\types\runtime-types.d.ts:59-132`。
- `<dsh-ai>\dsh-llm\lib\types\types.d.ts:318-330`。

### Checks actually run

```text
git status                         PASS: clean before audit
git log -3 --oneline               recorded
npm run typecheck                  PASS
npm test                           PASS: 41/41
dsh --version                      0.1.1-rc.1
live MCP tools/list                PASS: read/write/edit only
live fs standing-policy denial     PASS: outside target rejected
live fs escalation attempt         PASS: failed closed at missing open turn; no file created
Windows ACL host read-only probe   PASS: exit 0
Windows ACL temp workspace test    PASS: inside write yes; outside write denied; cleaned
```

审计期间没有执行 commit/push，没有修改核心代码，没有遗留 sandbox 临时测试文件。
