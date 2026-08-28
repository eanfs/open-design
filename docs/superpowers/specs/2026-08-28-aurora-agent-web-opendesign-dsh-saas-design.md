# Aurora Agent Web 基于 OpenDesign 与 DSH 的独立 SaaS 产品设计

## 状态

本设计已于 2026-08-28 获得用户批准。本文只定义产品与系统设计；具体实现仍须按已批准的实施计划执行。

## 目标

将 OpenDesign 作为 Aurora Agent Web 的完整产品底座，以 DSH 作为唯一 Agent Runtime，形成一个独立运营、独立品牌、独立订阅和独立计费的浏览器 SaaS 产品。

产品面向全球中文内容创作者和个体运营者。用户从技能目录选择目标，通过简短需求开始创作，在 OpenDesign 工作区内继续对话修改、管理文件、预览并下载成果。

Aurora Agent Web 首发必须形成以下可销售闭环：

1. 用户浏览技能目录并选择技能；
2. 进入现有 OpenDesign Project 工作区；
3. 登录并完成余额校验；
4. 通过 DSH 执行 Run；
5. 实时查看过程和结果；
6. 继续修改、预览和下载；
7. 通过 Aurora 自有订阅或充值继续使用。

## 已确认的产品决策

- 产品名称为 `Aurora Agent Web`。
- 产品只以托管浏览器 SaaS 的形式对外销售，不发布桌面端或面向客户的 CLI 产品。
- 当前 OpenDesign Web、Daemon、Project、Conversation、Run/SSE、文件、预览、Design System、Library 和原有成品技能全部保留。
- OpenDesign 原有成品技能继续公开展示，不隐藏，也不删除。
- Aurora Agent Web 只启用 DSH 作为 Agent Runtime；其他 Runtime 的源码保留，以减少与 OpenDesign 上游的分叉，但在 Aurora 构建和部署中禁用。
- 原 Aurora Agent Web 的页面、组件、API、任务模型、路由逻辑和产品设计全部废弃。
- 外部 Aurora 仓库 `lib/skill-runtime.ts` 只作为 16 个技能的产品语义来源；不复制、不导入、不调用其中的 TypeScript 代码。
- 16 个新增技能全部重新编写为 OpenDesign 原生技能。
- 首发新增 `poster`、`xhs-image`、`xhs-copy`；其余 13 个技能逐个完成、验证后再上线。
- 订阅机制参考 OpenDesign 当前方式：月付、年付、周期积分、充值积分、年付折扣和可配置促销价，但 Aurora 使用自己的品牌、套餐和价格。
- 所有付费套餐可以使用全部已上线技能，套餐之间只通过积分额度、并发和服务优先级区分。
- 平台统一提供模型和媒体供应商能力；首发不提供 BYOK。
- 未登录用户可以浏览技能和填写需求，但创建 Run 前必须登录且具备正余额或有效额度。

## 非目标

- 不继续演进或迁移原 Aurora Agent Web 前端。
- 不复用原 Aurora 的 `SkillRuntime`、技能目录数组、`routeSkill`、`providerEnvironment`、任务队列或 API。
- 不创建第二套 Project、Conversation、文件、预览或 Task 服务。
- 不把 OpenDesign Daemon 直接重写为共享 SQLite 和共享文件系统的多租户服务。
- 不在首发阶段提供 BYOK、桌面应用或客户侧 CLI。
- 不在首发阶段一次性实现 16 个新增技能。
- 不按套餐锁定技能，也不复制 OpenDesign 的部署数量限制。
- 不在完成供应商成本压测前写死正式价格。

## 方案比较

### 方案 A：继续使用原 Aurora Agent Web，再接入 OpenDesign

优点是可以保留现有页面外观。缺点是需要维护两套前端、项目模型、任务模型和 API 语义；原 Aurora 任务接口并没有形成完整执行闭环，后续仍需重新实现文件、预览、会话和版本能力。

本方案与“所有功能以 OpenDesign 为底座进行最小二次开发”的目标冲突，因此不采用。

### 方案 B：OpenDesign 私有受控分叉，加独立商业控制面

OpenDesign 继续承担创作工作区和 Agent 执行面；Aurora 只增加品牌、技能、DSH 单运行时策略、登录订阅、积分账本和托管隔离层。

该方案最大限度复用现有能力，同时将支付、多租户和成本控制放在清晰的外部边界，是本设计采用的方案。

### 方案 C：将 OpenDesign Daemon 改造成原生共享多租户云后端

该方案长期资源利用率可能更高，但需要重构本地 SQLite、项目文件系统、运行时目录、凭证和进程模型。改动面大，安全和数据迁移风险高，不适合首发。

## 总体架构

系统分为商业控制面和创作执行面：

```text
浏览器中的 Aurora Agent Web
        |
        v
Aurora 网关与商业控制面
  - 账号与登录
  - Stripe 订阅和充值
  - 套餐权益与积分钱包
  - Run 额度预占和结算
  - 租户实例路由
        |
        v
租户隔离的 OpenDesign 实例
  - Project / Conversation
  - Skills / Design System / Library
  - Run / SSE
  - Files / Preview / Result Package
        |
        v
短生命周期的隔离 DSH Worker
  - OpenDesign 原有技能
  - Aurora 新增技能
  - 受控模型与媒体工具
```

### 商业控制面职责

商业控制面是 Aurora 自有服务，负责：

- 账号、会话和租户身份；
- Stripe Customer、Subscription、Invoice 和充值订单；
- 套餐目录、币种、周期、折扣和促销配置；
- 积分钱包、不可变账本和 Run 计费状态；
- 租户到 OpenDesign 实例的路由；
- Run 创建前的服务端权限和余额校验；
- 对账、退款、成本和毛利监控。

商业控制面不复制 Project、Conversation、文件、预览或技能执行状态。

### OpenDesign 执行面职责

OpenDesign 保持现有职责：

- 管理 Project、Conversation、消息和历史；
- 加载并展示原有技能与 Aurora 新增技能；
- 组合技能、对话、项目文件和 Design System 上下文；
- 创建、取消、恢复和查询 Run；
- 通过 SSE 返回文本、工具、进度、用量和完成事件；
- 保存生成文件、预览内容和结果包；
- 调用唯一启用的 DSH Runtime。

### 浏览器产品与 CLI 边界

Aurora 只向客户提供浏览器产品，但不删除 OpenDesign 仓库中的 `od` CLI。新增技能使用现有技能和 Run 协议，因此内部 CLI 仍可通过相同 API 执行这些技能，不需要新增一套 UI 专用核心能力。

商业订阅和充值属于 Aurora 外部控制面，不加入 OpenDesign 核心 API。若实现过程中必须增加新的 OpenDesign 用户能力，则仍需遵守仓库的 Web/CLI 双轨约束；首发设计应优先避免这种新增。

## 托管和租户隔离

首发采用租户隔离的 OpenDesign 实例，而不是共享 Daemon 数据库。

- 每个租户拥有独立的 OpenDesign 数据根、Project 文件、SQLite、凭证空间和 DSH 会话空间。
- 所有 Daemon 数据继续从启动时解析的 `OD_DATA_DIR` 或其派生常量获得，不引入第二个数据根，也不在文档中固化具体文件系统路径。
- 网关根据已认证租户选择目标 OpenDesign 实例，浏览器不能自行指定租户实例地址。
- 初期可以按活跃租户启动和回收实例；实例池、预热和冷启动优化属于后续运维优化，不改变租户数据边界。
- OpenDesign Web 可以共享构建产物，但项目 API、Run、文件、预览和 SSE 都必须路由到正确租户实例。
- 供应商密钥由平台保管，以运行期临时凭证或受控工具代理提供给 DSH，不写入 Project，也不暴露到浏览器。

## OpenDesign API 复用

Aurora 不建立新的公开 Task API。创作流程复用 OpenDesign 当前接口语义，主要包括：

- `POST /api/runs`：创建 Run；
- `GET /api/runs/:id/events`：订阅 Run SSE；
- `GET /api/runs/:id`：查询 Run 状态；
- `POST /api/runs/:id/cancel`：取消 Run；
- `GET /api/runs/:id/result-package`：取得结果包；
- 现有 Project 和 Conversation 接口：创建项目、读取会话和消息；
- 现有文件、上传、预览 URL 和作用域预览接口。

网关以同源方式透明转发这些路径。在 `POST /api/runs` 进入 OpenDesign 前执行认证、额度预占和幂等校验；SSE 和其他读取接口不改变 OpenDesign 的事件和响应形状。

现有聊天交互可以继续使用 OpenDesign 已有路径，但它不是新建 Aurora 任务模型的理由。计费实体始终关联 OpenDesign `runId`。

## 技能目录与迁移规则

### 可见技能目录

Aurora Agent Web 的技能目录由两部分组成：

1. OpenDesign 当前已有并可运行的成品技能；
2. 根据外部 `skill-runtime.ts` 产品语义重新编写的 Aurora 技能。

OpenDesign 原有成品技能保持公开。Aurora 新技能只有完成实现、成本校准、安全审查和端到端验收后才上线。

### 16 个 Aurora 技能

完整产品范围为：

- `poster`
- `xhs-image`
- `product-image`
- `text-image`
- `image-edit`
- `id-photo`
- `image-video`
- `text-video`
- `video-captions`
- `avatar-video`
- `xhs-copy`
- `resume`
- `document-summary`
- `transcription`
- `ppt`
- `excel`

首发只开放：

- `poster`
- `xhs-image`
- `xhs-copy`

### 原生技能定义

每个新技能作为标准 OpenDesign 技能存在，并至少描述：

- 稳定的技能 ID、名称、说明和使用场景；
- 用户输入和可选项目素材；
- DSH 执行步骤与完成条件；
- 允许使用的模型、媒体或文档工具；
- 最大工具调用次数、运行时长和消费上限；
- 费用估算规则；
- 输出文件类型、命名和验收要求。

具体字段和前置元数据必须遵守 OpenDesign 当前技能协议，不发明平行的 `SkillRuntime` 类型。

## DSH 单运行时设计

### 产品策略

- Aurora 构建不显示 Runtime 选择器。
- 部署侧运行时允许列表只包含 `deepseek-harness`。
- OpenDesign 原有技能和 Aurora 新技能全部通过 DSH 运行。
- 其他 Runtime 的源码和上游同步能力保留，但不能被 Aurora 请求选择或自动回退启用。
- 运行时不可用时明确失败，不静默切换到其他 Agent Runtime。

### 每次 Run 的执行流程

1. OpenDesign 读取已选择技能、对话、Project 文件和 Design System。
2. Daemon 组合当前 Run 输入并交给 DSH 适配器。
3. 调度层为该 Run 启动短生命周期的隔离 DSH Worker。
4. Worker 恢复当前租户、Project、Conversation 对应的 DSH 会话，或创建新会话。
5. DSH 通过明确允许的工具调用模型和媒体供应商。
6. 生成内容写回当前 Project；运行事件继续映射为 OpenDesign SSE。
7. Run 结束后保存最终状态和用量，销毁 Worker，保留受控会话状态供后续修改。

### 隔离和权限

DSH 的工具可见性配置不是安全边界。托管环境必须通过 Worker 隔离层强制执行：

- 只挂载当前租户和当前 Project 所需的数据；
- 禁止访问宿主机其他目录、其他租户数据和共享临时目录；
- 默认禁止任意网络访问，只允许明确的供应商或内部工具代理；
- 供应商凭证按 Run 注入并在结束时撤销；
- 对进程、CPU、内存、存储、时长、工具次数和并发设置硬上限；
- 禁用人工审批等待，超出策略时以结构化错误结束；
- 记录工具、用量和计费审计事件，但不记录密钥和敏感用户内容。

## 供应商工具和用量归一化

DSH 是唯一 Agent Runtime，但图片、视频、语音和文档处理仍可能由不同供应商完成。所有供应商调用必须经过平台控制的工具适配层。

工具适配层负责：

- 输入校验和内容大小限制；
- 供应商选择和凭证注入；
- 超时、重试和取消；
- 在调用前检查剩余 Run 预算；
- 返回结构化产物位置，而不是将大文件塞入聊天文本；
- 生成可结算的标准化用量记录。

标准化用量至少包含 `runId`、工具或模型、计量单位、数量、供应商成本、Aurora 零售积分和幂等标识。供应商原始用量不可直接作为用户账单；商业控制面根据版本化价格表计算应扣积分。

## 订阅与积分设计

### 套餐结构

首发计划使用 `Creator`、`Pro`、`Studio` 三个 Aurora 套餐名称，并支持：

- 月付和年付；
- 年付折扣；
- 可配置的首期或促销价格；
- 每周期发放的订阅积分；
- 独立购买的充值积分；
- 套餐并发数和服务优先级。

所有套餐都能使用全部已上线技能。套餐不通过技能锁定制造差异，也不复制 OpenDesign 的部署数量限制。

面向全球中文用户，商业控制面支持以 USD 和 SGD 展示或结算，Stripe 是首发支付渠道。币种、税费和 Stripe Price 必须由服务端套餐目录决定，不能由客户端请求覆盖。

### 积分规则

- 订阅积分按计费周期发放并优先消费，在周期结束时重置；充值积分不随订阅周期重置。
- 充值积分与订阅积分分账记录，并在订阅积分之后消费。
- 每笔余额变化都写入不可变账本，不能只更新余额数字。
- 未登录用户和非正余额用户不能创建付费 Run。
- Run 前向用户展示预计积分范围；最终按实际标准化用量结算。
- 用户不能在没有可用余额的情况下自动产生后付费欠款。

具体价格、积分额度、折扣比例和三项首发技能的费率，在供应商成本压测和目标毛利验证后配置，不作为首发代码常量。

## 商业控制面最小数据模型

### Account

保存用户身份、租户归属和认证状态，不保存 OpenDesign Project 内容。

### Subscription

保存套餐、计费周期、Stripe 引用、有效期和状态。Stripe Webhook 是支付状态变化的权威输入，Webhook 处理必须幂等。

### CreditWallet

提供快速余额视图。余额必须可由账本重建，不能成为唯一财务事实。

### CreditLedger

记录周期发放、充值、预占、结算、释放、退款和人工调整。每条记录包含原因、币种或积分单位、关联对象、幂等键和时间。

### RunCharge

将商业计费状态关联到 OpenDesign `runId`，至少包含估算、预占、实际结算、退款、最终状态和用量摘要。

### TenantRoute

记录租户对应的 OpenDesign 实例或调度标识。它不允许客户端直接选择，也不复制实例内部项目数据。

## Run 计费流程

1. 浏览器提交 Run，并携带客户端生成的幂等键。
2. 网关验证账号、订阅状态、租户路由和技能可用性。
3. 商业控制面根据技能和请求计算预计消费及最大允许消费。
4. 在事务中创建 `RunCharge` 并预占积分。
5. 预占成功后转发 `POST /api/runs` 到目标 OpenDesign 实例。
6. OpenDesign 返回 `runId` 后，将其原子关联到 `RunCharge`。
7. 网关透明转发 SSE；浏览器体验保持 OpenDesign 原状。
8. 完成、失败或取消后，根据标准化用量结算实际积分并释放剩余预占。
9. 对账任务扫描未终结的 `RunCharge`，查询 OpenDesign Run 状态并补做结算。

同一个幂等键不能重复创建 OpenDesign Run、重复预占或重复结算。工具适配层还必须在每次高成本供应商调用前检查 Run 剩余预算，避免实际消费突破允许上限。

## 用户体验

首发不增加独立任务中心，也不创建第二套 Studio。最短路径为：

```text
技能目录
  -> 选择技能
  -> 自动创建或进入 Project
  -> 填写简短需求
  -> 登录和余额校验
  -> DSH Run
  -> OpenDesign 工作区实时查看
  -> 对话修改、预览和下载
```

必要界面改造仅包括：

- OpenDesign Web 更名并换肤为 Aurora Agent Web；
- 首页技能目录同时展示 OpenDesign 原有技能和已上线 Aurora 技能；
- 结果导向的技能卡片和简短起始表单；
- 登录、套餐、余额、充值和升级入口；
- Run 前预计费用以及余额不足提示；
- 账单和积分流水的最小查看入口。

点击技能后直接进入现有 Project 和 Conversation 工作区。聊天追问、历史、素材、Design System、文件、预览和下载继续使用 OpenDesign 现有界面。

## 错误处理

### 创建 Run 失败

如果 OpenDesign 未成功创建 Run，商业控制面立即释放全部预占。若网络状态不确定，则先使用幂等键和 OpenDesign 状态查询确认，不能直接重试创建。

### DSH 失败或用户取消

只结算已经发生且具备标准化用量证据的供应商消费，其余预占释放。错误通过现有 Run/SSE 状态呈现，不创建 Aurora 私有任务状态。

### 浏览器断开

Run 在服务端继续执行。用户重新打开 Project 后从 OpenDesign Run 状态恢复；结算不依赖浏览器保持连接。

### DSH 不可用

明确返回 DSH Runtime 不可用或容量不足，不回退到其他 Runtime。未创建有效 Run 时释放预占；已产生用量时进入正常对账流程。

### 商业控制面暂时不可用

新的付费 Run 失败关闭，避免无授权消费。已经运行的任务继续由 OpenDesign 和 DSH 收尾，恢复后通过对账结算。项目浏览、文件读取和历史查看在安全可行时不受影响。

### 余额不足

前端显示硬阻断和充值或升级入口，服务端仍执行最终校验。接近低余额阈值时可以软提醒，但不能用前端状态替代服务端账本。

## 安全与隐私

- 所有租户身份由网关从认证会话推导，不接受客户端声明的租户 ID 作为权威输入。
- Project、文件、SQLite、DSH 会话和凭证按租户隔离。
- 预览和结果包 URL 必须保留租户授权校验，不能暴露实例内部路径。
- Stripe Webhook 必须验签、幂等并防止乱序状态覆盖。
- 供应商密钥不进入浏览器、聊天内容、Project 文件或日志。
- 用户提示词和上传文件视为不可信输入，不能扩大 DSH 工具、网络或文件权限。
- 计费账本、供应商成本和退款操作保留审计记录。
- 管理员人工调账需要独立权限、原因和双向账本记录，不能直接改余额。

## 首发与后续阶段

### 阶段 0：底座准备

- 建立 OpenDesign 私有受控分叉和上游同步策略；
- 完成 Aurora 品牌替换；
- 将 Aurora 部署运行时固定为 DSH；
- 验证 OpenDesign 原有技能在 DSH 下的兼容性；
- 建立租户实例、数据根和 Worker 隔离基线。

### 阶段 1：可销售 MVP

- 上线账号、Stripe、Creator/Pro/Studio 套餐和积分钱包；
- 实现 Run 预占、结算、退款和对账；
- 上线 `poster`、`xhs-image`、`xhs-copy`；
- 完成浏览器端生成、修改、预览、下载闭环；
- 完成三项技能的供应商成本和目标毛利压测。

### 阶段 2：技能扩展

按照需求和毛利逐个实现剩余 13 个技能。每个技能独立完成工具权限、费用、产物、失败恢复和端到端验收后再加入可见目录。

## 测试与验收

### 产品闭环

- 用户能从技能目录进入工作区并完成生成、修改、预览和下载。
- 刷新或断线后能恢复 Project、Conversation 和 Run 状态。
- OpenDesign 原有技能保持可见且可通过 DSH 运行。
- 首发三个 Aurora 技能按各自输出契约产生项目文件。

### Runtime

- Aurora UI、API 请求和部署配置都不能选择或启动非 DSH Runtime。
- DSH 不可用时明确失败，且不会静默回退。
- Worker 超时、资源上限、取消和清理均有自动测试。
- 会话只在正确租户、Project 和 Conversation 内恢复。

### 计费

- 余额不足不能创建 Run。
- Run 创建失败释放全部预占。
- 成功、部分失败、取消和断连场景按实际用量结算。
- 重复请求、重复 Webhook 和重复完成事件不会重复扣费。
- 账本能够重建钱包余额，未终结记录可以由对账任务收敛。

### 隔离和安全

- 两个租户不能读取对方的项目、文件、会话、DSH 状态或供应商凭证。
- 恶意提示词不能扩大 Worker 的挂载、网络、工具和预算权限。
- 预览、下载和 SSE 都验证正确租户。
- 日志和错误响应不包含供应商密钥或支付敏感数据。

### 回归和仓库约束

- 生产代码不导入或调用原 Aurora Agent Web 仓库。
- 新技能符合 OpenDesign 技能协议和技能测试要求。
- Web、Daemon、contracts、DSH Runtime 和相关端到端测试通过。
- 新增 OpenDesign 核心用户能力时同时满足 Web/CLI 双轨约束；首发尽量只复用现有接口。
- `OD_DATA_DIR` 继续是 Daemon 数据根的唯一真相来源。

## 运营指标

首发至少监控：

- Run 成功率、取消率和各错误类型；
- 首次生成耗时和完整运行耗时；
- 各技能供应商成本、零售积分、退款和毛利；
- DSH Worker 启动失败、超时和资源超限；
- 从选择技能到首次成功结果的转化率；
- 订阅转化、充值率和周期积分消耗率。

## 待定但不阻塞架构的事项

- Creator、Pro、Studio 的正式月付和年付价格；
- 每档周期积分、并发数和服务优先级；
- USD 与 SGD 的展示和结算组合；
- 三项首发技能的供应商与零售费率；
- 实例预热、休眠和回收参数。

这些参数必须在供应商成本、目标毛利和真实运行耗时完成验证后配置，不应成为写死在 Web 客户端中的常量。

## 完成定义

Aurora Agent Web 只有同时满足以下条件才达到首发完成：

1. 用户可购买 Aurora 自有订阅或充值积分；
2. 用户可在浏览器中运行 OpenDesign 原有技能和三个新增技能；
3. 所有技能只通过 DSH 执行；
4. 生成内容进入 OpenDesign Project，并可继续修改、预览和下载；
5. 计费、退款、幂等和对账形成闭环；
6. 租户数据、运行时和供应商凭证通过隔离验收；
7. 生产构建不依赖原 Aurora Agent Web 的任何设计或代码。
