# OpenDesign 代码架构与 DeepSeek Harness 插件机制调研

> 状态：当前实现调研，不定义新的产品或协议行为
>
> 调研日期：2026-08-26
>
> OpenDesign 快照：`8815d2ee6532b5e4227f6d22bdbcf62f7d3d4787`
>
> 上游范围：DeepSeek Harness 官方仓库 `master` 分支在调研日期可见的实现与文档；上游仍处于预发布迭代，结论可能随版本变化

## 1. 摘要

OpenDesign 是一个以本地 daemon 为控制平面的多包工作区。Web、Electron 和 `od` CLI 是交互入口；daemon 统一负责项目状态、HTTP/SSE 契约、Agent 发现与启动、插件、文件监视和产物服务；真正的模型推理和工具循环由被启动的 Agent CLI 或运行时完成。

DeepSeek Harness（下文简称 DSH）不是通过 OpenDesign 自身的内容插件协议接入。它使用一条独立的运行时扩展链路：OpenDesign 发布 `@open-design/dsh-runtime` npm 包，由 `dsh plugin` 安装进名为 `open-design` 的 DSH Profile；该包通过 `dsh.bundle.patch` 向 Cordis 服务图插入启动参数解析器和 JSONL 适配器。运行时每次执行仍由官方 Harness Agent Loop 完成，OpenDesign 只负责宿主协议与产品控制面。

最重要的边界是：

| 层 | 所有者 | 主要职责 |
| --- | --- | --- |
| 产品控制面 | OpenDesign daemon | 身份与配置、项目和会话映射、安装与兼容性探测、进程生命周期、协议校验、取消、产物交付 |
| 运行时组合 | DSH Profile + Cordis | 加载 Bundle patch、解析依赖注入、激活和释放插件服务 |
| Agent 执行面 | DeepSeek Harness | 模型/provider、凭据、Agent Loop、工具执行、Harness session 持久化 |
| 内容扩展面 | OpenDesign plugin/skill | `SKILL.md`、manifest、素材、工作流和运行上下文，不替换 Harness 内核 |

因此，`@open-design/dsh-runtime` 更准确的定位是 **DSH Profile Bundle 和宿主适配器**，而不是新的 Agent Loop，也不是 OpenDesign Marketplace 中的内容插件。

## 2. 研究范围与证据等级

本文只描述已经存在的代码路径，并把未来设计建议留给 [DeepSeek Harness 插件边界 RFC](./rfc-drafts/deepseek-harness-plugin-boundary.zh-CN.md)。历史规格或草案不作为当前行为的唯一证据。

结论采用三类证据：

- **当前代码确认**：可从本仓库所列源文件直接验证。
- **上游官方确认**：来自 DeepSeek Harness 官方仓库的源码或参考文档；它们描述调研时的 `master`，存在版本漂移风险。
- **未完成实机验证**：当前环境没有可执行的 `dsh`，所以没有覆盖真实 provider 登录、Profile 安装和模型调用；相关边界在第 10 节单列。

相关项目文档：

- [OpenDesign 总体架构](./architecture.md)
- [Agent adapter 设计](./agent-adapters.md)
- [DSH Profile adapter 规格](../specs/current/deepseek-harness-profile-adapter.md)
- [DSH 一键安装说明](./deepseek-harness-one-click-install.zh-CN.md)
- [OpenDesign 插件规格](./plugins-spec.zh-CN.md)

## 3. OpenDesign 总体代码架构

### 3.1 仓库分层

OpenDesign 是 pnpm monorepo，核心目录的责任如下：

| 目录 | 角色 | 与 DSH 集成的关系 |
| --- | --- | --- |
| `apps/web` | Next.js Web UI | 展示 Agent 可用性、安装入口、聊天流和文件预览 |
| `apps/daemon` | 本地特权 daemon 与 `od` CLI | DSH 发现、安装、启动、JSONL 协议、会话续接与取消的控制面 |
| `apps/desktop` | Electron 开发桌面壳 | 通过 sidecar IPC 发现 Web 地址 |
| `apps/packaged` | 打包后的 Electron 入口 | 启动 packaged sidecars，提供 `od://` 入口 |
| `packages/contracts` | 纯 TypeScript 的 Web/daemon DTO | 约束 UI、CLI 和 HTTP 使用同一数据形状 |
| `packages/dsh-runtime` | OD 拥有的 DSH Profile Bundle | 把 Harness session 事件映射成 OD JSONL 帧 |
| `packages/plugin-runtime` | OpenDesign 内容插件解析器 | 与 DSH Bundle 是不同扩展机制 |
| `packages/sidecar*`、`packages/platform` | 进程和 sidecar 基础设施 | 为 daemon、web 和桌面壳提供通用生命周期原语 |
| `tools/dev`、`tools/pack` | 开发和打包控制面 | `tools/pack` 构建并校验 DSH companion tarball |

### 3.2 运行时拓扑

```text
┌───────────────────────────────────────────────────────────────┐
│ Web UI / Electron / od CLI                                    │
└──────────────────────────────┬────────────────────────────────┘
                               │ shared HTTP DTO + SSE
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ OpenDesign daemon                                             │
│ API · project state · runtime registry · session guard        │
│ companion install · process lifecycle · protocol validation   │
└──────────────────────────────┬────────────────────────────────┘
                               │ spawn: dsh --profile open-design --stdio
                               │ stdin/stdout: strict JSONL
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ DSH Profile: open-design                                      │
│ dsh-base composition + @open-design/dsh-runtime patch         │
└──────────────────────────────┬────────────────────────────────┘
                               │ Cordis services
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Official DeepSeek Harness Agent Loop                          │
│ provider/model · tools · session persistence · credentials    │
└──────────────────────────────┬────────────────────────────────┘
                               │ filesystem writes
                               ▼
┌───────────────────────────────────────────────────────────────┐
│ Project workspace → daemon watcher → preview/export           │
└───────────────────────────────────────────────────────────────┘
```

这条链路保留了两个关键事实：

1. daemon 是 OpenDesign 产品行为的单一真相源，UI 和 CLI 都不能绕过它建立另一套 DSH 接口。
2. DSH 子进程写出的设计文件仍是普通工作区文件，沿用 OpenDesign 既有的文件监视、预览和导出链路，不需要在 DSH 协议中复制一套 artifact 上传协议。

## 4. 两种“插件”不能混为一谈

### 4.1 OpenDesign plugin/skill

OpenDesign 插件是面向用户任务和内容编排的扩展单元。可运行形态以 `SKILL.md` 或兼容的 `.claude-plugin/plugin.json` 为行为入口，`open-design.json` 补充展示、能力、输入、资产和 provenance 等元数据。它由 daemon 的插件系统与 `packages/plugin-runtime` 解析，再进入项目创建或 run 上下文。

它回答的问题是：**“用户希望 Agent 按什么方法、素材和流程完成任务？”**

### 4.2 DSH plugin/Profile Bundle

DSH 插件命令操作的是 Profile 中的 npm 依赖。依赖若在 `package.json` 声明：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

DSH 就会把它识别为 Bundle，并将 patch 加入 Profile 的 Cordis 配置组合。它回答的问题是：**“Harness 进程启动时应加载哪些服务和运行时适配器？”**

### 4.3 边界对照

| 维度 | OpenDesign plugin/skill | DSH Profile Bundle |
| --- | --- | --- |
| 载体 | `SKILL.md`、`open-design.json`、资产 | npm 包、`package.json`、`cordis.patch.yml` |
| 生效对象 | 用户任务上下文和产品工作流 | Cordis 运行时服务图 |
| 安装/发现方 | OpenDesign daemon | `dsh plugin` 与 DSH Profile |
| 典型能力 | brief、模板、设计规则、素材、声明式能力 | 注入服务、替换配置、增加宿主协议 |
| 是否拥有 Agent Loop | 否 | Bundle 本身也否；Loop 仍由 Harness 服务提供 |

## 5. DSH Profile 与 Cordis 插件机制

### 5.1 Profile 是可组合的运行时实例

根据 DSH 官方 CLI 和 boot 文档，`dsh plugin --profile <name> <args...>` 会：

1. 在需要时初始化 Profile。
2. 将后续参数转交给 Profile 目录中的包管理器。
3. 扫描 Profile 依赖，找出声明 `dsh.bundle.patch` 的包。
4. 把这些 Bundle 记录到 Profile 的有序 `dsh.profile.bundles` 中。
5. 在下次启动时重新组合 Cordis 配置。

调研时的配置层顺序为：

```text
Bundle patches（按 profile 中的顺序）
  → Profile 自身 cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → CLI --patch
```

后应用的层对同一条目有更高优先级。一个按 `id` 命中的 `config` 替换应视为整块配置替换，而不是任意深度合并；因此 patch 一个上游服务时，需要关注上游新增字段是否被本地 patch 意外丢弃。

### 5.2 Cordis 的加载与依赖注入

Cordis loader 条目主要由 `id`、`name`、`config`、`inject` 和 `disabled` 描述：

- loader 根据 `name` 导入模块。
- 插件声明需要的服务；只有依赖满足时，其 Fiber 才会激活。
- 插件注册的副作用跟随 Fiber 生命周期释放，因此支持配置重载和插件卸载。
- Bundle patch 的价值是改变“加载哪些插件、提供哪些服务、服务之间怎样连接”，而不是直接实现所有业务逻辑。

这也是 OpenDesign 适配器拆成 startup 与 runtime 两个插件的原因：startup 先把命令行模式提供为服务，runtime 再通过 `inject` 明确依赖该服务以及 Harness 自身的 Agent、LLM 和 session 服务。

上游一手资料：

- [DSH CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)
- [DSH app-boot README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)
- [`dsh plugin` source](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts)
- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Official base Bundle patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml)

## 6. `@open-design/dsh-runtime` 怎样接入 Harness

### 6.1 Bundle 声明

[`packages/dsh-runtime/package.json`](../packages/dsh-runtime/package.json) 声明 `dsh.bundle.patch: ./cordis.patch.yml`。这使该包既是普通 npm 依赖，也是 DSH 能识别的 Profile Bundle。

[`packages/dsh-runtime/cordis.patch.yml`](../packages/dsh-runtime/cordis.patch.yml) 当前只做三件事：

1. 替换 `system-prompt` 的 persona，使其明确处于 OpenDesign 任务上下文。
2. 禁用 `hmr`，避免一次性 stdio Profile 受开发态文件观察器影响。
3. 插入 `@open-design/dsh-runtime/startup` 和 `@open-design/dsh-runtime`；后者注入前者提供的 `openDesignStartup` 服务。

OpenDesign 没有复制 `dsh-base` 的 provider、凭据、工具和 session 配置。用户的 Harness 安装继续拥有这些配置。

### 6.2 startup 插件

[`packages/dsh-runtime/src/startup.ts`](../packages/dsh-runtime/src/startup.ts) 使用官方 `dsh-cmdline` 和 Commander 解析三种互斥模式：

| 模式 | 用途 |
| --- | --- |
| `--probe` | 输出 Profile 身份和兼容能力后退出 |
| `--models` | 输出 Harness 当前可用的 provider/model/reasoning catalog 后退出 |
| `--stdio` | 通过 stdin/stdout 为一个 OpenDesign run 提供 JSONL 服务 |

必须且只能选择一个模式。解析结果作为 `openDesignStartup` 服务提供给 Cordis 上下文，而不是在模块顶层直接分叉整个进程。

### 6.3 runtime 插件

[`packages/dsh-runtime/src/index.ts`](../packages/dsh-runtime/src/index.ts) 注入：

```text
openDesignStartup
agentDefaultModel
agents
llm
sessions
sessionPersistence
```

在 `--stdio` 模式中，它：

1. 输出 `ready` 身份帧。
2. 读取一个 `execute` 命令，并允许同一 request 的 `cancel` 命令在执行中到达。
3. 根据请求选择默认模型或指定的 provider/model/reasoning effort。
4. 使用 `ctx.agents.create()` 新建 Harness session，或用 `ctx.agents.resume()` 恢复已有 session。
5. 在任何内容事件前输出 `session` 帧。
6. 监听 `session/event`，映射文本、思考、工具和 usage 事件。
7. 等待 Agent 空闲并调用 `ctx.sessions.flush()`。
8. 输出唯一的终态 `result`，随后退出一次性 Profile 进程。

这段代码没有实现规划、模型请求或工具循环；它消费 Harness 暴露的服务。因此它是 **Host Adapter**，而不是 Fork 或重写的 Harness Agent。

## 7. 安装、发现与兼容性探测

### 7.1 安装包如何产生

[`tools/pack/src/resources/index.ts`](../tools/pack/src/resources/index.ts) 将 `@open-design/dsh-runtime` 打成一个确定的 `.tgz`，要求输出目录中恰好只有一个 tarball，并生成带包名、版本、文件名和 SHA-256 的 manifest。

这里打包的是 OpenDesign 拥有的薄适配层，不是 DSH 本身。OpenDesign 不负责替用户安装或升级 `dsh`。

### 7.2 UI 与 CLI 共用同一 daemon 能力

Web 安装入口和 `od agent setup deepseek-harness --json` 最终都调用 daemon 的本地 companion 安装路由。daemon 中的 [`agent-companion-setup.ts`](../apps/daemon/src/agent-companion-setup.ts) 执行以下步骤：

1. 读取 packaged 或开发态 companion manifest。
2. 校验包名、版本、文件名和 SHA-256 格式。
3. 对 tarball 重新计算 SHA-256，拒绝不一致内容。
4. 将 tarball 复制到 `open-design` Profile 内的 `.open-design/<sha256>.tgz`。
5. 调用：

   ```text
   dsh plugin --profile open-design add .open-design/<sha256>.tgz
   ```

6. 重新执行 Agent 发现和兼容性探测，确认安装结果。

使用 Profile 相对路径不是偶然实现细节：`dsh plugin` 在 Profile 目录中运行包管理器，相对 spec 同时规避了上游 Windows shell forwarder 对绝对路径的拆分问题。

### 7.3 发现分三层

[`apps/daemon/src/runtimes/defs/deepseek-harness.ts`](../apps/daemon/src/runtimes/defs/deepseek-harness.ts) 定义了 DSH runtime：

1. `dsh --version`：确认 CLI 存在并解析版本。
2. Profile 预检：先确认 `<DSH_HOME>/profiles/open-design/package.json` 存在，再执行 probe；这是为了避免某些 RC 版本在 probe 时自动初始化缺失 Profile 的副作用。
3. `dsh --profile open-design --probe`：校验严格的身份、协议版本和 capabilities。
4. `dsh --profile open-design --models`：读取实际模型目录和 reasoning options，供 UI/CLI 展示。

只有 `dsh` 可执行并不代表 OpenDesign 集成可用；Profile Bundle、协议身份和能力也必须同时匹配。

## 8. 一次 run 的 JSONL 协议

### 8.1 时序

```text
daemon                         dsh Profile                    Harness Agent
  │ spawn --stdio                  │                               │
  │◀──────── ready ────────────────│                               │
  │──────── execute ──────────────▶│                               │
  │                                │──── create/resume ───────────▶│
  │◀──────── session ──────────────│                               │
  │                                │──── followup(prompt) ────────▶│
  │◀─ thinking/text/tool/usage ────│◀──── session/event ───────────│
  │                                │──── sessions.flush() ────────▶│
  │◀──────── result ───────────────│                               │
  │             process exits      │                               │
```

daemon 发出的 `execute` 包含 request id、cwd、prompt，以及可选的 resume session、model 和 reasoning effort。当前实现固定传递 `mcp_servers: []`。

### 8.2 事件映射

| Harness session event | OD Profile frame | OpenDesign 中的用途 |
| --- | --- | --- |
| `assistant/chunk` + `reasoning-delta` | `thinking` | 展示推理增量 |
| `assistant/chunk` + `text-delta` | `text` | 展示回答增量 |
| `tool/call` | `tool_call` | 展示工具开始与参数 |
| `tool/result` | `tool_result` | 展示工具结果和错误状态 |
| `assistant/message.usage` | `usage` | 记录 provider、model 和 token usage |
| session 创建/恢复完成 | `session` | 捕获可持久化的 Harness session id |
| `turn/end` 或运行失败 | `result` | 唯一终态：completed/cancelled/failed |

### 8.3 daemon 端是严格协议消费者

[`apps/daemon/src/agent-protocol/dsh-profile/stream.ts`](../apps/daemon/src/agent-protocol/dsh-profile/stream.ts) 和 [`session.ts`](../apps/daemon/src/agent-protocol/dsh-profile/session.ts) 把 stdout 视为纯协议通道，而不是可容忍的人类日志：

- 单帧默认上限为 1 MiB。
- 非法 JSON、未知/非法 frame 会使 run 失败。
- 每个 frame 必须属于当前 request。
- 内容必须出现在 `session` 之后。
- resume 时返回的 session id 必须与请求完全一致。
- `result` 的 session id 不能变化，且终态必须与 host 的取消状态一致。
- 子进程退出前必须产生 terminal `result`。

严格校验使协议错误尽早暴露，避免把损坏的 stdout 当作正常设计内容或把另一个 request 的事件串入当前会话。

## 9. 会话续接、取消与产物交付

### 9.1 冷续接

OpenDesign 每次 run 都启动新的 `dsh --profile open-design --stdio` 进程，但 Harness session 可以跨进程持久化。daemon 将捕获到的 session id 记录到 `(conversation, agent)` 对应的会话状态中。

[`apps/daemon/src/agent-session-resume.ts`](../apps/daemon/src/agent-session-resume.ts) 在续接前检查：

- Agent/model 是否仍一致。
- project cwd 是否仍一致。
- conversation 的已完成消息游标是否与该 session 保存时一致。
- 稳定指令块是否发生变化，决定是否需要重发。

健康续接只发送当前新增 turn 和必要的稳定上下文；如果 guard 失效，daemon 启动新 session 并用完整 transcript 重新播种。如果 DSH 明确返回 `resume_rejected`，daemon 会清除失效 handle，并按完整 transcript 自动重试，而不是永远重试同一个坏 session id。

### 9.2 取消

取消分为协议与进程两层：

1. daemon 先发送 request-scoped `cancel` frame。
2. Profile 中的 `AbortController` 和 `agent.cancel({ kind: 'user' })` 终止 Harness turn。
3. daemon 的通用进程树清理负责兜底，防止子进程残留。

如果取消发生在子进程启动与 `execute` 激活之间，runtime 会先锁存取消意图，待 request 建立后立即重放。已创建的 durable session handle 不因一次被中断的 turn 自动丢失，后续 turn 仍可尝试冷续接。

### 9.3 产物交付

DSH 在传入的 project cwd 中运行。Agent 工具写出的 HTML、图片、文档或其他文件由 OpenDesign 已有 watcher 发现，再进入预览和导出路径。DSH Profile 协议只承载运行事件与会话身份，不复制文件内容。

## 10. 当前能力、缺口与风险

### 10.1 已实现

- 固定 tarball + SHA-256 完整性校验的一键 companion 安装。
- Profile 存在性预检、严格 probe 与版本兼容策略。
- Harness 模型目录和 reasoning effort 探测。
- thinking、text、tool call/result、usage 和 terminal result 的结构化流。
- request-scoped 取消以及握手期取消锁存。
- 跨进程 Harness session 冷续接、身份 guard 和失效后的 transcript reseed。
- UI 与 `od` CLI 通过同一 daemon API 暴露安装和运行能力。

### 10.2 明确缺口

| 缺口 | 当前事实 | 影响 |
| --- | --- | --- |
| MCP 注入 | daemon 当前发送 `mcp_servers: []`，runtime 也未应用该字段 | OpenDesign 配置的 MCP 尚未沿此桥传入 Harness |
| Harness 凭据管理 | 仍由用户的 Harness 安装拥有 | OD 不读取、不迁移、也不保存 provider key；这是边界而非安装失败 |
| Todo/Subagent 投影 | 协议没有专用事件类型 | 只能通过现有通用 text/tool 表面观察，不能获得专属 UI 语义 |
| 实机 E2E | 当前调研环境没有 `dsh` | 尚未验证真实登录、Profile install、provider/model 调用和文件生成全链路 |

### 10.3 漂移风险

1. **上游预发布版本**：DSH 仍在 RC 版本线，CLI、peer dependency 和 Cordis 配置形状可能变化。probe 与 peer ranges 是必要防线，不能只检查二进制存在。
2. **patch 整块替换**：当前 `system-prompt.config` patch 只写 `persona`。若上游未来在同一 config 增加必要字段，整块替换语义可能将其丢弃，应在升级上游时复查最终组合结果。
3. **版本真相重复**：runtime 内的 `PLUGIN_VERSION = '0.1.0'` 与 `package.json` 版本分别维护，未来升级时可能产生协议身份漂移，适合收敛为构建期单一来源。
4. **协议与日志隔离**：stdout 必须保持纯 JSONL。任何上游或本地插件向 stdout 写普通日志都会成为致命协议错误；日志只能走 stderr 或 Cordis logger 的安全出口。

## 11. 验证记录与未验证边界

在同一 OpenDesign 代码快照上已执行：

```text
pnpm --filter @open-design/dsh-runtime test
结果：1 个测试文件，12 个测试通过

pnpm --filter @open-design/daemon exec vitest run \
  tests/agent-protocol/dsh-profile.test.ts \
  tests/agent-companion-setup.test.ts \
  tests/runtimes/deepseek-harness-windows.test.ts
结果：3 个测试文件，40 个测试通过，1 个 Windows-only 测试跳过
```

测试环境提示 `shells/terminal` 期望 Node `24.18.0`，实际为 Node `24.15.0`；pnpm 为 `10.33.2`。上述目标测试通过，但该提示意味着完整仓库验证仍应在项目指定 Node 版本上重跑。

本次调研没有完成真实 DSH smoke test，因为环境中没有 `dsh` 可执行文件。因此以下结论仍需在集成环境补证：

- `dsh plugin --profile open-design add ...` 的真实安装/修复行为。
- provider 登录状态和 `--models` 的真实输出。
- 一次真实模型 run、工具调用、文件写入、取消和下一 turn 冷续接。
- macOS、Linux/WSL2 和 Windows packaged 环境中的 Profile 路径与进程清理。

## 12. 推荐阅读路径

希望从代码快速建立完整心智模型时，建议按以下顺序阅读：

1. [`packages/dsh-runtime/package.json`](../packages/dsh-runtime/package.json)：确认它为何会被识别为 Bundle。
2. [`packages/dsh-runtime/cordis.patch.yml`](../packages/dsh-runtime/cordis.patch.yml)：观察它怎样改变 DSH 服务图。
3. [`packages/dsh-runtime/src/startup.ts`](../packages/dsh-runtime/src/startup.ts)：理解三种启动模式。
4. [`packages/dsh-runtime/src/index.ts`](../packages/dsh-runtime/src/index.ts)：理解 Harness session 到 OD frame 的映射。
5. [`apps/daemon/src/runtimes/defs/deepseek-harness.ts`](../apps/daemon/src/runtimes/defs/deepseek-harness.ts)：理解发现、probe、models 和 spawn 参数。
6. [`apps/daemon/src/agent-protocol/dsh-profile/session.ts`](../apps/daemon/src/agent-protocol/dsh-profile/session.ts)：理解宿主侧的严格状态机。
7. [`apps/daemon/src/agent-companion-setup.ts`](../apps/daemon/src/agent-companion-setup.ts)：理解一键安装和完整性验证。
8. [`apps/daemon/src/agent-session-resume.ts`](../apps/daemon/src/agent-session-resume.ts)：理解会话身份和 fallback。
9. [插件边界 RFC](./rfc-drafts/deepseek-harness-plugin-boundary.zh-CN.md)：在掌握当前实现后，再阅读未来的插件家族与责任边界建议。

## 13. 结论

当前集成采用的是一条边界清晰的“控制面 + Profile Bundle + 官方 Agent Loop”架构：OpenDesign 保持产品状态和宿主安全规则，DSH 保持模型、工具、凭据与 session 执行权，`@open-design/dsh-runtime` 只在二者之间建立可安装、可探测、可恢复、可取消的严格 JSONL 桥。

后续扩展时，最需要守住的不是某个具体类或函数，而是三条架构不变量：

1. 新能力仍由 UI 和 `od` CLI 共同经过 daemon 暴露。
2. OpenDesign 内容插件与 DSH 运行时 Bundle 保持概念和权限边界。
3. DSH 上游升级必须同时验证 Bundle 最终配置、严格协议、session 续接和真实 provider smoke，而不能只通过 TypeScript 编译或单元测试判断兼容。
