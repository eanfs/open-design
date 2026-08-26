# RFC：OpenDesign 与 DeepSeek Harness 的插件职责边界

**状态：** 草案（架构评估；本文档不交付行为变更）
**源码快照：** OpenDesign `0dc31fef636c0f3e0e388a5e4d191d94a725e011`；DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

[English](./deepseek-harness-plugin-boundary.md) | 简体中文

## 摘要

OpenDesign 可以把更多 agent 可见行为迁移为 DeepSeek Harness（DSH）插件，但不应把完整产品改造成一个 DSH 插件。OpenDesign 应继续作为产品控制面，持有项目、产物、已安装内容、信任、权限、凭据、持久工作流和 Studio 状态的真源。DSH 应继续作为 agent 执行面，负责模型调用、工具、会话、上下文压缩、沙箱执行、subagent 和前台工作流。

这是对已有集成的扩展，不是新增运行时选项。OpenDesign 已经发布 `@open-design/dsh-runtime`，把它安装为 `open-design` DSH profile 组合包，并为每次运行启动一个短生命周期 `dsh --profile open-design --stdio` 进程。推荐方向是把该组合包演进为一组小型能力插件，同时保持 daemon API 是唯一产品状态接口。

## 问题

OpenDesign 是一个完整的设计 agent 产品。其[架构](../architecture.md)包含浏览器与 Electron 客户端、Express daemon、基于 SQLite 的项目与对话状态、内容注册表、插件安装与信任、预览与导出服务、GenUI 持久化和 agent 运行时适配器。把所有职责封装进一个 Cordis 插件，只会改变模块容器，不会降低产品状态、安全或生命周期的复杂度。

OpenDesign 也包含可复用的 agent 可见行为：skill、设计系统上下文、craft 指导、模型与工具执行、产物交付和运行时事件投影。这些职责适合 DSH 扩展点，但 [OpenDesign 插件](../plugins-spec.zh-CN.md)与 Cordis 插件是不同产物。OpenDesign 插件主要是可移植 `SKILL.md`、可选 `open-design.json` manifest 和内容目录；Cordis 插件是注册服务、工具、事件与生命周期 effect 的可执行代码。

该集成需要为每项状态变化指定明确所有者。缺少这一划分时，OpenDesign 与 DSH 可能同时成为项目状态、权限、工作流进度、凭据或模型可见上下文的权威，使重试和冷恢复产生歧义。

## 已有 DSH 集成

[`@open-design/dsh-runtime`](../../packages/dsh-runtime/README.md) 已经是真实 DSH 组合包。其 [`cordis.patch.yml`](../../packages/dsh-runtime/cordis.patch.yml)向用户 profile 添加 OpenDesign 启动与协议插件，同时让凭据、设置、工具、会话和模型提供方继续由用户的 DSH 组合持有。

Daemon 的 [`deepseek-harness` 运行时定义](../../apps/daemon/src/runtimes/defs/deepseek-harness.ts)启动 `dsh --profile open-design --stdio`。[DSH profile 会话适配器](../../apps/daemon/src/agent-protocol/dsh-profile/session.ts)发送提示词、工作目录、模型选择、推理选择与恢复标识，然后把 DSH JSONL 消息投影到共用 OpenDesign agent 事件流。运行时插件创建或恢复 DSH 会话，并产生文本、推理、工具、用量、取消和终止结果。

因此，该桥接是 DSH 运行时适配器和组合包，而不是把 OpenDesign 转换为插件。所检查源码仍有一个具体缺口：daemon 向 profile 发送空的 `mcp_servers` 列表，OpenDesign 插件声明的 MCP 配置尚未参与 DSH 运行时组合。

## 建议

### 所有权

OpenDesign 继续作为产品控制面和真源。它持有用户、项目、对话、已安装内容、插件信任与能力授权、OAuth 记录、不可变应用插件快照、产物元数据与版本、预览与导出状态、持久流水线进度，以及涉及路径、网络目的地、凭据或用户选择目录的安全决策。

DSH 继续作为 agent 执行面。它持有 agent 构造、模型调用、模型可见工具、会话事件、上下文压缩、shell 与文件系统提供方、沙箱执行、subagent、前台工作流和运行时遥测。OpenDesign 输入只要进入模型请求，就必须先成为可重建的 DSH 会话状态。

OpenDesign Web、Electron 和 CLI 客户端继续调用 daemon，而不直接调用 DSH Web Host。daemon 验证请求，解析不可变内容与权限输入，启动 DSH，并把 DSH 事件投影回 OpenDesign 协议。

| OpenDesign 持有 | DSH 插件持有 |
| --- | --- |
| 项目、对话和产物记录 | Agent、模型、工具和会话执行 |
| Marketplace 安装和插件信任 | Skill 发现与模型可见 skill 加载 |
| 能力授权和凭据引用 | 执行已解析的单次运行工具策略 |
| 应用插件快照和设计目录 | 从快照派生并写入日志的提示词与 pre-step 上下文 |
| 持久流水线和 devloop 状态 | 前台 subagent 与工作流执行 |
| Studio、预览、GenUI 持久化和导出 | 工具展示元数据和生成文件位置 |
| OAuth token、路径策略、SSRF 策略和审计 | 产品签发运行权限所允许的提供方调用 |

### 插件族

OpenDesign 应把已有组合包演进为一组小型插件，不让一个插件导入 daemon 内部实现：

| 角色 | 职责 |
| --- | --- |
| OpenDesign Service Definition | 定义品牌化项目、目录快照、产物和运行权限标识，以及提供方无关的请求与结果 |
| OpenDesign daemon Service Provider | 调用经过认证的本地 HTTP 或 stdio 接口，绝不直接打开 OpenDesign SQLite 数据库 |
| OpenDesign 工具 Consumer | 基于 Service Definition 注册项目、目录、产物、预览和导出工具 |
| OpenDesign 上下文 Consumer | 解析一个不可变应用插件快照，把其中的 skill、设计系统指令、craft 指导和参考资料贡献给有日志记录的模型上下文 |
| OpenDesign 策略 Consumer | 把产品签发的运行权限映射为 DSH 工具、文件系统、shell、MCP、网络和审批可用性，且不扩大授权 |
| OpenDesign 事件投影器 | 把 DSH 会话和运行时事件转换为 OpenDesign SSE 或 AG-UI，同时保留用于冷恢复的 DSH 会话标识 |
| OpenDesign 组合包 | 在 `open-design` profile 下组合提供方、消费方、运行时适配器和用户选择的 DSH 提供方 |

Service Definition、Service Provider 与 Consumer 三种角色构成完整能力 seam。初始实现可以共享包，但公开类型不能导入 OpenDesign 持久化类、Next.js 组件或 Electron API。OpenDesign 应持有其命名与发布节奏，因为这些插件适配的是 OpenDesign 产品协议。

### 内容映射

OpenDesign `SKILL.md` 正文可以通过提供方无关的 [`ctx.skills`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/skill/skill/README.zh.md) 注册表进入 DSH。OpenDesign skill 提供方应保留调用策略，并且只暴露应用插件快照选择的内容，而不是 daemon 可见的所有已安装 skill。

`open-design.json`、设计系统、模板、craft、asset、流水线和 GenUI 声明需要显式适配器。提示词与参考内容成为有日志记录的 DSH 上下文。MCP 声明只有经过 OpenDesign 信任与能力评估后才成为已解析提供方配置。流水线声明继续作为持久 OpenDesign 状态，并可把 DSH 前台工作流作为单次 attempt 调用。GenUI 声明继续作为 OpenDesign UI 状态，而不是可执行 Host 或 Client Cordis 代码。

产物工具应返回稳定 OpenDesign 产物标识，并声明渲染意图和 `locations`。文件仍可写入项目工作目录，但产物注册、版本选择、预览就绪和导出完成继续作为 daemon 操作，不能从 DSH 会话推断。

## 运行时顺序

1. OpenDesign daemon 验证用户身份，并解析项目、运行时、应用插件快照、能力授权、模型选择和恢复标识。
2. daemon 启动或连接 OpenDesign DSH 组合包，发送不透明产品标识和不可变快照标识；OAuth secret 不进入模型可见上下文。
3. 提供方从 daemon 获取已授权快照和项目能力，上下文 Consumer 把每项模型可见指令和参考资料追加到 DSH 会话日志。
4. agent 通过提供方无关的 Service Definition 调用 OpenDesign 工具。daemon 在修改产品状态前再次验证运行权限。
5. DSH 记录模型、工具、用量和终止事件。事件投影器把它们转换给 OpenDesign，但不创建第二份权威执行记录。
6. daemon 持久化产品结果，把 OpenDesign attempt、产物与对话关联到后续冷恢复使用的 DSH 会话标识。

## 交付顺序

### 1. 完成已有桥接

传递已解析 MCP 配置，不再使用始终为空的列表，并证明一次 OpenDesign 运行仍映射到一个可冷恢复 DSH 会话。该增量不改变产品所有权。

### 2. 增加目录与上下文提供方

增加只读目录与应用插件快照提供方以及上下文 Consumer。证明所选 `SKILL.md`、设计系统、craft 和参考内容对模型可见，并可从 DSH 会话日志重建。

### 3. 增加项目与产物工具

通过 daemon API 暴露项目与产物操作，并提供明确渲染意图和生成文件位置。OpenDesign 继续负责预览、产物版本和导出状态。

### 4. 映射策略与 MCP 提供方

把 OpenDesign 能力授权和审批映射到 DSH 工具可用性与 MCP 提供方。缺失或陈旧运行权限必须在外部 effect 前失败，DSH 插件不能获得超过 daemon 签发范围的权限。

### 5. 后续再评估持久编排

在 DSH 具备持久后台任务提供方和可恢复工作流执行前，持久流水线调度继续留在 OpenDesign。在所检查 DSH revision 中，[`jobs-local`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/README.zh.md) 记录随进程消失，[工作流引擎](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow/README.zh.md)也没有 journal 或恢复能力。

丰富交互也继续留在 OpenDesign，因为 [`ctx.userQuestions`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-questions/README.zh.md)当前只覆盖选项和自定义文本，不覆盖文件选择器、diff 预览、OAuth 或持久 GenUI surface。[`ctx.storageDomain`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/storage/storage-domain/README.zh.md)只有单进程变化可见性，并且没有跨表事务或二级索引，因此不能替代 OpenDesign 关系型产品状态。

## 考虑过的替代方案

### 把全部 OpenDesign 转换为一个 DSH 插件

该方案不能给任何进程提供清晰状态边界，还要求 DSH 进程内后台任务、前台工作流、基础问题和领域存储替代当前没有实现的持久产品服务。

### 只保留已有 JSONL 桥接

该方案不新增包，但 OpenDesign skill、MCP 声明、不可变插件快照和能力授权仍处于 DSH 原生扩展点之外。提示词暂存保持重复，模型也不能通过提供方无关服务访问 OpenDesign 能力。

### 构建独立 DSH 原生 OpenDesign Client

轻量 DSH Client 可以展示聊天和生成文件，但复刻 Studio、marketplace、预览沙箱、GenUI 持久化、项目历史和导出体验会产生第二个产品。未来可把这种 Client 作为更窄界面增加，但不把它作为迁移目标。

### 让 DSH 插件直接读取 OpenDesign SQLite

直接数据库访问会把插件耦合到私有 schema、绕过 daemon 授权与审计，并产生竞争写入方。daemon API 继续作为唯一产品状态接口。

## 验收标准

- OpenDesign daemon 继续作为项目、插件、权限、凭据、产物、GenUI 和持久流水线状态的唯一写入方。
- 一次 OpenDesign 运行具有一个 DSH 会话标识；该标识跨短生命周期运行时进程保留，并与产品 attempt 一起存储。
- 发送给模型的每项 OpenDesign 指令、skill、参考资料和设计上下文都可从 DSH 会话事件重建。
- DSH 工具使用提供方无关的 OpenDesign 服务，绝不导入或打开 daemon SQLite 实现。
- OpenDesign 运行权限不透明、受作用域限制、由 daemon 重新验证，并且 Cordis 插件不能扩大它。
- 可信且已授权的插件声明 MCP 配置进入 DSH profile；不可信或未授权声明在提供方启动前失败。
- 产物工具声明渲染意图和位置，产物标识、版本、预览和导出状态仍由 daemon 持有。
- 持久 OpenDesign 工作不依赖进程内后台任务、不可恢复工作流运行或单进程存储通知。
- 单元覆盖验证提供方与策略失败，真实可运行示例验证组装后的 profile，无密钥快照覆盖模型可见上下文和工具结果。
- OpenDesign 运行时协议在引入其他进程拓扑前记录版本、取消、冷恢复、终止状态和失败所有权。

## 风险

- **两条事件流可能漂移。** DSH 持有执行历史，OpenDesign 持有产品历史。稳定的 run、attempt、session、tool-call 和产物标识必须关联两者，但不能把投影视为第二个真源。
- **上下文可能记录过晚。** 在会话事件路径之外获取 OpenDesign 内容，即使第一次模型请求成功，也会违反回放和恢复保证。
- **权限转换可能扩大授权。** 默认值、缺失能力名或提供方特有选项必须快速失败，不能启用范围更大的 DSH 工具或 MCP 提供方。
- **短生命周期进程限制后台工作。** 运行时进程可能在前台结果后退出，因此 OpenDesign 必须继续持有持久调度和外部提供方 job id。
- **适配器增长可能复制 daemon。** 服务方法必须暴露产品操作，不能在 DSH 插件内重新实现持久化、策略、预览、marketplace 或 OAuth 逻辑。
- **协议可以独立变化。** 由于 OpenDesign 与 DSH 独立发布，组合包与 daemon 需要显式兼容协议版本和快速失败协商。
