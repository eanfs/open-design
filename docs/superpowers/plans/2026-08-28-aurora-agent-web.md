# Aurora Agent Web 最小实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 OpenDesign Daemon、Run/media 持久化、DSH runtime 和现有创作功能的前提下，增加 Aurora Web 展示、外部订阅付费控制面、租户部署配置和三个新增内容资源。

**Architecture:** Aurora 是 OpenDesign 外层组合。Web 复用现有首页和工作区；付费控制面拦截付费 Run 并固定 DSH；部署入口路由到未修改的租户 OpenDesign 实例；技能和模板通过现有 scanner 自动发现。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## 不可突破的边界

### 允许的改动

- `apps/web` 中的顶层品牌、商业展示、首发技能排序和 i18n；
- 新增 `apps/aurora-control-plane` 及独立的纯 TypeScript `packages/aurora-contracts`；
- `deploy/aurora` 下的租户实例、入口、DSH-only 和资源隔离配置；
- `skills/xhs-copy`、`design-templates/poster`、`design-templates/xhs-image` 新目录；
- 与这些所有者直接对应的 focused tests 和一个系统 smoke。

### 禁止的改动

- `apps/daemon/src/**`；
- `packages/dsh-runtime/**`；
- `packages/contracts/**` 和所有现有 Run/media DTO；
- OpenDesign Run、SSE、媒体表、Project、Conversation、文件、预览、Automation 或协作实现；
- `apps/web/src/providers/daemon.ts` 的 Run 请求协议；
- 现有 skill/design-template 目录；
- Aurora 专属 Daemon 测试、fake DSH 协议或新 CI scheduling identity。

如果实现步骤需要突破上述边界，停止并回到设计，而不是增加例外。

## 最小文件范围

### Web 展示

Create:

- `apps/web/src/product/presentation.ts`
- `apps/web/src/product/aurora/config.ts`
- `apps/web/src/product/aurora/api.ts`
- `apps/web/src/product/aurora/state.ts`
- `apps/web/src/components/aurora/AuroraCommerceBar.tsx`
- `apps/web/src/components/aurora/AuroraCommerceBar.module.css`
- `apps/web/src/components/aurora/AuroraPlansDialog.tsx`
- `apps/web/src/components/aurora/AuroraPlansDialog.module.css`
- `apps/web/src/components/aurora/AuroraLedgerDrawer.tsx`
- `apps/web/src/components/aurora/AuroraLedgerDrawer.module.css`
- `apps/web/src/components/aurora/AuroraFeaturedStarts.tsx`
- `apps/web/src/components/aurora/AuroraFeaturedStarts.module.css`
- 对应的 `apps/web/tests/product/` 和 `apps/web/tests/components/aurora/` focused tests

Modify:

- `apps/web/app/layout.tsx`
- `apps/web/src/App.tsx` — 只挂载顶层 Aurora chrome/state 和通用展示能力
- `apps/web/src/components/EntryView.tsx` — 只注入品牌和 featured ordering，保留现有 EntryShell/HomeView
- `apps/web/src/components/ProjectView.tsx` — 只在 composition 层省略 Runtime 展示，不改变 Run admission/dispatch
- `apps/web/src/components/AvatarMenu.tsx` — 只消费通用展示能力过滤入口
- `apps/web/src/components/SettingsDialog.tsx` — 只消费通用展示能力过滤导航/深链
- `apps/web/src/i18n/types.ts`
- 现有全部 19 个 `apps/web/src/i18n/locales/*.ts`
- `apps/web/tests/i18n/locales.test.ts`

### 商业控制面

Create:

- `apps/aurora-control-plane/**`
- `packages/aurora-contracts/package.json`
- `packages/aurora-contracts/tsconfig.json`
- `packages/aurora-contracts/src/index.ts`
- `packages/aurora-contracts/tests/contracts.test.ts`

Modify:

- `package.json` / `pnpm-lock.yaml` — 仅新增 workspace 所需依赖；不得增加 root runtime dependency

### 部署

Create:

- `deploy/aurora/README.md`
- `deploy/aurora/` 下的入口、实例、存储、资源限制和密钥配置
- `e2e/tests/aurora-deployment-contract.test.ts`

### 新增内容

Create:

- `design-templates/poster/**`
- `design-templates/xhs-image/**`
- `skills/xhs-copy/**`
- 一个 content-owned acceptance spec

## Task 1: 锁定最小边界

- [ ] 记录 Aurora 仅允许 Web、commerce、deployment 和 additive content 四类改动。
- [ ] 确认默认 OpenDesign 构建没有 Aurora 环境变量时保持现有标题、首页、Runtime、BYOK、Project 和 Run 行为。

## Task 2: 配置租户部署和 DSH-only

**Owner:** `deploy/aurora/**`

- [ ] 为每个测试租户启动独立的未修改 OpenDesign Web/Daemon 实例，实例数据仍遵守根 `AGENTS.md` 的 daemon data directory contract。
- [ ] 在 Aurora 镜像或部署清单中只安装并配置 `deepseek-harness`；不要修改 Agent registry、`/api/agents` 或 Daemon health DTO。
- [ ] 通过现有 `/api/health` 验证实例存活，通过现有 `/api/agents` 验证 DSH 可用。
- [ ] 在容器/Pod 层配置独立持久化存储、`DSH_HOME`、供应商凭证、网络出口、CPU、内存、进程、时长和存储限制。
- [ ] 入口根据已认证的控制面结果选择租户 upstream；浏览器不能提交权威 upstream URL。
- [ ] 对 `/api/*`、SSE、artifact、frame、preview 和 download 使用基础设施级不透明转发，不在控制面应用中复制这些协议。
- [ ] 添加双租户部署测试，证明实例、数据、凭证和网络不交叉。

## Task 3: 实现最小订阅付费控制面

**Owner:** `apps/aurora-control-plane/**` and `packages/aurora-contracts/**`

### API

- [ ] 在 `@open-design/aurora-contracts` 定义最小 DTO：session、plans、wallet、ledger、checkout、top-up、portal 和结构化 commerce error。该包保持纯 TypeScript/Zod，不依赖 Express、Node process/filesystem、浏览器 API 或 OpenDesign Daemon；额度使用十进制字符串，套餐/价格/Stripe Price 由服务端拥有。
- [ ] 实现 OIDC session、logout 和同源状态变更保护；浏览器不接收 OIDC token。
- [ ] 实现服务端套餐目录和 Stripe checkout/portal/webhook；Webhook 验签并按 Stripe event id 幂等。
- [ ] 实现不可变额度账本和事务内更新的钱包物化视图。全量重建只在测试和离线审计运行，不放在每次余额事务热路径。

### 付费 Run

- [ ] 配置一个版本化的统一 Run 固定额度价格，覆盖有技能、无技能和多技能的现有 Run body；不在 OpenDesign 技能文件或 Web 中写价格。
- [ ] 在入口拦截现有 `POST /api/runs`。要求请求体携带非空 `clientRequestId`，并将它作为唯一逻辑幂等标识；不增加第二个 ID 或 `Idempotency-Key` header。
- [ ] 在一个数据库事务中认证、检查额度、创建唯一 RunCharge 并预占固定价格。
- [ ] 显式非 DSH 的 `agentId` 返回冲突错误；省略或已为 DSH 时，以 `deepseek-harness` 转发其余未修改的 Run body 和原有响应形状。
- [ ] OpenDesign 返回 `runId` 后记录关联。重复请求或创建响应丢失时保留预占，用完全相同的 body 和 `clientRequestId` 重试，让 OpenDesign 现有 `createOrReuse` 恢复同一个 Run；不得因网络结果不确定直接退款或生成新 ID。
- [ ] 使用现有 Run status 完成最小 reconciliation：`succeeded` 结算固定价格；`failed`/`canceled` 释放或退款；非终态和 upstream 暂时不可用继续保留预占并重试。不要读取或修改 OpenDesign token/media usage evidence。
- [ ] 余额不足返回结构化 402；认证失败返回 401；请求或 Agent 冲突返回 409。不得依赖浏览器预检保证授权。

### 测试

- [ ] 使用 fake OIDC、fake Stripe 和隔离 PostgreSQL 覆盖 session、checkout、重复 Webhook、账本并发、余额不足、缺失/重复 `clientRequestId`、丢失创建响应恢复，以及 `succeeded`/`failed`/`canceled` 结算。
- [ ] 测试只连接控制面 HTTP 和正常 OpenDesign HTTP surface，不直接修改钱包或 Project 文件。

## Task 4: 在现有 Web 中增加 Aurora 展示

**Owner:** `apps/web`

- [ ] 在一个 Web-only build config 中解析 Aurora 品牌；默认值仍是 OpenDesign，未知值在构建时失败。
- [ ] 修改顶层 composition root 以挂载 Aurora 商业状态和 chrome，不向 Daemon、contracts 或 DSH 传递 product profile。
- [ ] 保留完整 `EntryShell` / `HomeView`。`AuroraFeaturedStarts` 只提供三个 ID 的 featured ordering 和展示文案，点击后继续使用现有目录、草稿、附件和 Project 创建路径。
- [ ] 不创建 `AuroraHomeView`、第二套 catalog search 或三个硬编码表单；技能需要澄清时使用现有技能说明和 inline question-form。
- [ ] 在首页和 Project 外层显示额度、套餐、充值和账单入口；套餐值只渲染服务端响应。
- [ ] 不修改 `ProjectView` Run admission 或 `providers/daemon.ts`。网关 401/402/409 通过现有错误路径显示，Aurora chrome 提供登录/充值入口。
- [ ] 在一个通用 Web-only `WebPresentationCapabilities` 中声明 `showRuntimeControls`、`showByokControls` 和 `showDesktopEntrypoints`；默认 OpenDesign 全部为 `true`，Aurora 全部为 `false`。由 `App` 顶层解析一次，并由最接近的现有 composition owner 省略对应子树；不得在共享叶组件中编写 `if (aurora)` 业务分支。
- [ ] 测试默认 OpenDesign 继续显示全部入口，Aurora 必须隐藏 Runtime picker、BYOK/provider 设置和桌面下载入口；隐藏不是可选优化。部署中只有 DSH 仍是执行层最终约束。

### i18n

- [ ] 在 `Dict` 中添加扁平 `aurora.*` key，并由 19 个现有 locale 显式提供值；不得用 `...en`、`as Dict` 或组件 fallback 补齐。
- [ ] 商业 shell 通过 `useT()` 读取文案；产品名、套餐名、价格、币种和额度保持产品身份或服务端原值。
- [ ] 扩展 `locales.test.ts` 验证 key parity、显式声明和 placeholder parity。

### Web 验证

- [ ] focused tests 覆盖默认 OpenDesign、Aurora 品牌、featured ordering、商业入口和至少一个非英文 locale。
- [ ] 复用现有 Project/Run/SSE/files/preview/download 测试，不复制整条工作区测试矩阵。

## Task 5: 添加三个标准内容资源

**Owner:** `design-templates/poster`, `design-templates/xhs-image`, `skills/xhs-copy`

- [ ] `poster` 使用标准 design-template frontmatter，输出可校对文字层的 `poster.svg` 和清单；可选背景只通过现有 `od media generate`。
- [ ] `xhs-image` 使用标准 design-template frontmatter，输出五张 SVG、项目内 gallery 和清单；不伪造地点或事实。
- [ ] `xhs-copy` 按 `skills/AGENTS.md` 使用现有 `od.mode: utility`，输出 Markdown 和 JSON；不增加新的 mode 或协议语义，不调用媒体工具。
- [ ] 三个资源不得读取或引用外部 Aurora 仓库代码；外部 `skill-runtime.ts` 只提供产品语义。
- [ ] 不修改 `image-poster`、`social-carousel`、`ecommerce-image-workflow` 或其他现有目录。
- [ ] 使用现有 scanner/protocol/example/guard 检查；新增测试只验证内容自身的 frontmatter、输出和安全规则。
- [ ] 至多保留一个使用现有 OpenDesign mock/工具链的通用生成 smoke；不新增 Aurora Daemon suite 或 fake DSH 协议。

## Task 6: 关闭最小验收

- [ ] 运行新增控制面 package tests、contracts tests 和 Web focused tests。
- [ ] 运行现有 Web typecheck/build，一次默认配置、一次 Aurora Web 配置。
- [ ] 运行现有通用 skill/design-template 校验和 baked example 检查。
- [ ] 运行双租户 deployment contract test。
- [ ] 运行一个 sale-to-result smoke：登录 → 获得额度 → 选择技能 → 原样创建 OpenDesign Run → SSE/result package → 固定价格结算。
- [ ] 使用现有 workspace/unit/E2E lanes；未知或新增路径保持 conservative full plan。没有运行时数据证明前不创建 Aurora 专属 CI workload 或 UI shard。
- [ ] 运行 `pnpm guard`、`pnpm typecheck` 和 `git diff --check`。
- [ ] 扫描最终 diff，确认没有 Daemon、DSH runtime、Run/media persistence、现有内容目录或第二套 Workspace 实现变更。

## Completion Evidence

- 默认 OpenDesign 无行为变化；
- Aurora 只增加品牌/商业展示、外部付费服务、部署配置和三个内容目录；
- DSH-only 由网关和部署保证；
- 付费只依赖固定价格、`clientRequestId`、`runId` 和现有终态；
- 现有 Project、Conversation、Run、SSE、文件、预览、Automation、协作和 DSH adapter 完整复用；
- 实施 diff 不包含 `apps/daemon/src/**` 或 `packages/dsh-runtime/**`。
