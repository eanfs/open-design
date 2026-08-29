# Aurora Agent Web 基于 OpenDesign 与 DSH 的最小 SaaS 产品设计

## 状态

本设计替代此前将 Aurora 产品策略下沉到 OpenDesign Daemon、Run、媒体持久化和 DSH 启动层的方案。

核心原则只有一条：**Aurora 组合并部署 OpenDesign，不把 Aurora 实现成 OpenDesign 内部的第二种产品模式。**

## 目标

以现有 OpenDesign Web 和工作区作为创作产品，以现有 DeepSeek Harness（DSH）适配器作为部署中唯一可用的 Agent Runtime，增加 Aurora 品牌、订阅付费、租户部署和三个首发内容资源，形成浏览器 SaaS：

```text
选择技能
  -> 登录或购买额度
  -> 进入现有 OpenDesign Project
  -> 使用现有 Run / SSE / Files / Preview
  -> 继续修改并下载
```

## 首发范围

### 允许新增或修改

1. **Web 展示**
   - Aurora 品牌、标题、主题和文案；
   - 在现有首页目录中突出首发技能；
   - 登录、套餐、额度、充值和账单入口；
   - 19 个现有 Web locale 的类型化文案。
2. **订阅付费**
   - Aurora 自有账号会话；
   - Stripe 订阅、充值和 Billing Portal；
   - 服务端套餐目录、额度钱包和不可变账本；
   - 在付费 Run 进入 OpenDesign 前完成认证、额度预占和幂等处理。
3. **部署**
   - 租户到独立 OpenDesign 实例的路由；
   - 每实例独立数据、凭证和 DSH 状态；
   - 部署中只安装和配置 DSH；
   - 容器或 Pod 层的文件、网络、资源和密钥隔离。
4. **新增内容**
   - `design-templates/poster/`；
   - `design-templates/xhs-image/`；
   - `skills/xhs-copy/`。

### 明确不修改

- 不向 OpenDesign Daemon 增加 `aurora` product profile、运行时策略或 Aurora 路由分支；
- 不修改 OpenDesign Run 创建、SSE、状态、重试、恢复或幂等实现；
- 不修改媒体任务表、Run 事件持久化或公共聊天契约来承载商业计费证据；
- 不修改 `packages/dsh-runtime`、现有 DSH profile 或 Daemon 的进程启动路径；
- 不建立第二套 Project、Conversation、文件、预览、Automation、协作或任务模型；
- 不修改、重命名、隐藏或覆盖现有技能和 design template；
- 不创建平行的 Aurora Home、Studio 或 Project workspace；
- 不让普通 OpenDesign 构建知道 Aurora 的品牌、订阅或租户策略。

## 复用的 OpenDesign 能力

| Aurora 需要的能力 | 直接复用的 OpenDesign 所有者 |
|---|---|
| 技能和模板目录 | 现有 skills/design-templates scanner 与 Web catalog |
| 草稿、附件和创建 Project | 现有 `EntryShell` / `HomeView` / Project 创建流程 |
| 对话和修改 | 现有 Project / Conversation 工作区 |
| Agent 执行 | 现有 `POST /api/runs` 与 DSH 适配器 |
| 断线恢复和幂等 | 现有 `clientRequestId`、Run 状态和重连逻辑 |
| 实时过程 | 现有 Run SSE |
| 图片等媒体能力 | 现有 `od media generate` 和工具令牌路径 |
| 文件、预览和下载 | 现有 Project files、preview 和 result package |
| Automation 与协作 | 保持 OpenDesign 当前行为，不增加 Aurora 分支 |

Aurora 不重新声明这些协议，也不为它们增加 Aurora 专属 DTO。

## 最小架构

```text
浏览器
  Aurora Web 展示层
  - 品牌与首发技能排序
  - 登录、套餐、额度和账单入口
  - 复用现有 OpenDesign 首页和工作区
        |
        v
Aurora 网关与付费控制面
  - 会话与 Stripe
  - 套餐、钱包和账本
  - 付费 Run 预占
  - 强制 agentId = deepseek-harness
        |
        v
部署入口
  - 认证后选择租户实例
  - 不透明转发 OpenDesign 路径和 SSE
        |
        v
未修改的租户 OpenDesign 实例
  - 现有 Project / Conversation / Run / Files / Preview
  - 现有 DSH adapter
        |
        v
部署中唯一安装的 DSH 与平台供应商代理
```

## Web 展示

Aurora 继续渲染 OpenDesign 现有首页和 Project 工作区。

最小 Web 改造为：

- 在一个顶层 composition root 选择 Aurora 品牌和商业 chrome；
- 通过数据配置把 `poster`、`xhs-image`、`xhs-copy` 排在目录前部；
- 复用现有搜索、草稿、附件和 `onCreateProject` 流程；
- 不为三个技能建立硬编码的平行表单；缺失信息由技能说明和现有 inline question-form 流程处理；
- 通过顶层可见性配置隐藏客户不需要的 Runtime、BYOK 和桌面入口，不向共享叶组件扩散 Aurora 业务状态；
- 套餐、额度和账单 UI 只展示控制面返回的数据；
- 产品名和套餐名保持服务端或产品身份提供的原值。

所有新增用户文案使用现有扁平 `Dict`、`useT()` 和 19-locale parity 机制。不得在组件中硬编码中文/英文 fallback，也不得修改 i18n 基础设施。

## DSH-only 策略

DSH-only 是 Aurora 网关和部署策略，不是 OpenDesign 产品模式：

1. Aurora 部署只安装并配置 `deepseek-harness`；
2. 网关在转发付费 `POST /api/runs` 时固定 `agentId: 'deepseek-harness'`，拒绝冲突值；
3. Aurora Web 不向客户提供 Runtime 选择入口；
4. 租户 OpenDesign Daemon 保持原有 Agent 目录、Run admission 和启动逻辑；
5. DSH 不可用时，网关或现有 OpenDesign 错误直接失败，不回退其他 Runtime。

部署健康检查复用现有 `/api/health` 和 `/api/agents`。不向健康响应增加 `productProfile`。

## 订阅与额度

### 套餐

首发使用 `Creator`、`Pro`、`Studio`，支持月付、年付、充值和服务端促销配置。所有套餐可使用全部已上线技能，差异只在额度和并发。

正式价格不写入 Web 或技能文件，只存在于版本化服务端套餐目录。

### 简化计费

首发对所有付费 OpenDesign Run 使用**一项版本化固定额度价格**，不按 `skillId`、无技能/多技能形状或供应商用量分支计价，也不把用量归一化写入 OpenDesign：

- 控制面保存一个当前 `pricingVersion` 和统一 Run 价格；
- Web 可以展示控制面返回的价格，但不能计算价格；
- 网关要求付费 Run body 携带非空 `clientRequestId`，缺失时在预占前拒绝；
- `POST /api/runs` 到达网关时，控制面按 `clientRequestId` 原子预占固定额度；
- 显式非 DSH 的 `agentId` 被拒绝；省略或已为 DSH 时，网关以 `deepseek-harness` 转发其余未修改的 body；
- OpenDesign 返回 `runId` 后，控制面记录关联；如果创建响应丢失或网络结果不确定，保留预占并用完全相同的 body 和 `clientRequestId` 重试，由 OpenDesign 现有幂等机制恢复同一个 Run，而不是创建新请求；
- `succeeded` 结算固定额度；`failed` 或 `canceled` 释放/退款；非终态或 upstream 不可用时继续保留预占并重试查询；
- 不按 token、媒体 task 或 OpenDesign 内部事件收费；未来若需要供应商精细计量，只能在 Aurora 自有供应商代理中增加，不修改 OpenDesign Run/media 状态。

`clientRequestId` 是唯一逻辑幂等标识。控制面用唯一 RunCharge 记录防止重复预占，OpenDesign 继续用其现有幂等逻辑处理重复 Run 请求；不增加第二个浏览器请求 ID、幂等 header 或通用响应缓存表。

### 商业数据边界

控制面只保存账号、Stripe 引用、套餐、钱包、账本、RunCharge 和租户路由。它不保存 Project、Conversation、提示词、文件、预览或 DSH 会话。

账本是额度事实来源，钱包是事务内更新的物化视图。完整账本重建属于测试和离线审计，不在每次余额事务中扫描全部历史。

## 路由与部署

租户隔离由部署层负责：

- 每个租户使用独立 OpenDesign 实例和独立持久化存储；
- Daemon 数据继续遵守根 `AGENTS.md` 的 data directory contract；本文不定义第二数据根或具体路径；
- 入口根据认证会话选择实例，浏览器不能提交权威上游 URL；
- 部署只向目标实例提供 DSH、平台凭证和必要的供应商网络出口；
- 容器/Pod 设置 CPU、内存、进程、时长、存储和网络上限；
- 平台供应商密钥不进入浏览器、Project 文件或聊天内容。

部署入口负责 OpenDesign 路径的不透明转发，不在控制面应用代码中逐条重写 `/api`、SSE、artifact、frame、preview 或 download 语义。控制面应用只拥有 `/api/aurora/*` 和付费 `POST /api/runs` admission。

## 三个首发内容资源

### `poster`

标准 design template，输出可校对文字层的 `poster.svg` 和必要清单；可通过现有 `od media generate` 生成无关键文字的背景。

### `xhs-image`

标准 design template，输出五张 3:4 SVG、项目内 gallery 和清单；地点等事实只能来自用户输入。

### `xhs-copy`

标准 skill，输出 `xhs-copy.md` 和结构化 JSON；按 `skills/AGENTS.md` 使用现有 `od.mode: utility`，不增加新的 mode 或协议语义。

三个目录只添加标准 `SKILL.md`、示例和 references。现有 scanner、catalog、example route、Project 文件和结果包保持不变。

## 最小验收

### Web

- 默认 OpenDesign 展示保持不变；
- Aurora 展示正确品牌、首发技能排序和商业入口；
- 19 个 locale 的 key 和 placeholder 保持一致；
- 首页仍使用现有目录、草稿、附件和 Project 创建流程；
- Project 工作区、SSE、文件、预览和下载无 Aurora 分叉。

### 商业控制面

- 登录、Stripe checkout、订阅/充值发放和钱包查询可用；
- 重复 `clientRequestId` 不重复预占或创建逻辑 Run；
- 余额不足时 `POST /api/runs` 不到达 OpenDesign；
- 成功、未创建和技术失败场景按固定价格结算或释放；
- 控制面不保存创作内容。

### 部署

- 两个测试租户路由到不同 OpenDesign 实例和存储；
- Aurora 请求只能使用部署中配置的 DSH；
- 实例、凭证和网络互相隔离；
- OpenDesign Daemon、DSH runtime 和公共 Run/media contracts 没有 Aurora 专属改动。

### 内容

- 三个新 ID 由现有 catalog 自动发现；
- 现有技能和模板没有被修改或隐藏；
- 输出契约和 baked examples 通过现有通用资源检查；
- 至多保留一个使用现有工具链的通用生成 smoke，不为 Aurora 建 fake DSH 协议或 Daemon 专属测试。

## 完成定义

Aurora 首发完成时：

1. 用户在浏览器中看到 Aurora 品牌和现有 OpenDesign 创作体验；
2. 用户可订阅、充值并用固定额度价格创建 DSH Run；
3. OpenDesign Project、Run、SSE、文件、预览、Automation、协作和 DSH adapter 保持原实现；
4. 三个新增内容资源通过现有扩展协议交付；
5. 租户隔离、凭证、资源和 DSH-only 由部署与网关保证；
6. 仓库中不存在 Aurora Daemon profile、Run usage evidence、媒体迁移、专属 DSH launcher 或平行 Workspace。
