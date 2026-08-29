# Aurora Agent Web 最小实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 OpenDesign Daemon、Run/media 持久化、DSH runtime 和现有创作功能的前提下，增加 Aurora Web 展示、外部订阅付费控制面、租户部署配置和三个新增内容资源。

**Architecture:** Aurora 是 OpenDesign 外层组合。Web 复用现有首页和工作区；独立控制面拥有 OIDC、Stripe、钱包、账本、Run admission 和租户路由；部署入口把已认证请求不透明转发到未修改的租户 OpenDesign 实例并固定 DSH；技能和模板通过现有 scanner 自动发现。

**Tech Stack:** Node.js 24、TypeScript 5.9、Express 5.2.1、Zod 3.25.76、PostgreSQL、`pg` 8.23.0、Stripe SDK 22.6.0、`openid-client` 6.8.7、`http-proxy` 1.18.1、`@testcontainers/postgresql` 12.1.0、Next.js 16、React 18、Vitest、Docker Compose。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## 全局约束

- Aurora 只允许修改 Web presentation、外部 commerce control plane、`deploy/aurora` 和三个新增内容目录。
- 不修改 `apps/daemon/src/**`、`packages/dsh-runtime/**`、`packages/contracts/**`、现有 Run/media DTO 或 `apps/web/src/providers/daemon.ts`。
- 不修改 OpenDesign Run、SSE、Project、Conversation、文件、预览、Automation、协作、媒体持久化或现有 skill/design-template 目录。
- 默认 OpenDesign 构建无 Aurora 配置时，标题、首页、Runtime、BYOK、Project 和 Run 行为保持不变。
- Aurora Web 使用构建期 `NEXT_PUBLIC_OD_PRESENTATION=aurora`；未设置表示 `opendesign`，任何其他值在构建时失败。
- DSH-only 由网关和部署保证；租户 OpenDesign Daemon 保持原有 Agent registry、health DTO、Run admission 和启动逻辑。
- `clientRequestId` 是付费 Run 的唯一逻辑幂等标识；不增加第二个请求 ID 或 `Idempotency-Key` header。
- 所有付费 Run 使用一项版本化固定额度价格；不读取 OpenDesign token/media evidence 计费。
- 浏览器不接收 OIDC token、供应商凭证、Stripe Price、权威 upstream URL 或额度计算逻辑。
- 新增用户文案使用扁平 `aurora.*` key，并由全部 19 个 locale 显式声明；不使用 `...en`、`as Dict` 或组件 fallback。
- 新增测试使用现有 workspace/unit/E2E lanes；不创建 Aurora 专属 Daemon suite、fake DSH protocol、CI scheduling identity 或 UI shard。

---

### Task 1: 锁定最小边界

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`
- Read: `docs/code-review-guidelines.md`

**Interfaces:**
- Consumes: PR #3 的 Aurora 外层组合边界和本计划“全局约束”。
- Produces: 后续所有任务共同使用的允许路径、禁止路径和默认 OpenDesign 基线。

- [ ] **Step 1: 记录允许与禁止范围**

在 Parent Story #5 和执行 PR 描述中逐项引用“全局约束”，明确只有 Web、commerce、deployment 和 additive content 四类改动；任何任务需要越界时停止并回到设计。

- [ ] **Step 2: 记录默认构建基线**

记录默认 OpenDesign 必须继续显示 Runtime、BYOK/provider 和桌面入口，并继续使用现有 Project、Run、SSE、files、preview 和 download 流程。

- [ ] **Step 3: 运行基线检查**

Run:
```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test
```
Expected: 两条命令均 PASS；此任务不修改产品代码。

- [ ] **Step 4: 提交检查点**

此任务无仓库文件改动，不创建空提交；在 ticket 中附上两条基线命令结果后进入 `S4-Done`。

---

### Task 2: 建立 Aurora contracts 与控制面骨架

**Files:**
- Create: `packages/aurora-contracts/package.json`
- Create: `packages/aurora-contracts/tsconfig.json`
- Create: `packages/aurora-contracts/src/index.ts`
- Create: `packages/aurora-contracts/tests/contracts.test.ts`
- Create: `apps/aurora-control-plane/package.json`
- Create: `apps/aurora-control-plane/tsconfig.json`
- Create: `apps/aurora-control-plane/src/config.ts`
- Create: `apps/aurora-control-plane/src/db.ts`
- Create: `apps/aurora-control-plane/src/app.ts`
- Create: `apps/aurora-control-plane/src/server.ts`
- Create: `apps/aurora-control-plane/tests/app.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 的边界。
- Produces: `AuroraSessionDto`、`AuroraPlanDto`、`AuroraWalletDto`、`AuroraLedgerEntryDto`、checkout/top-up/portal DTO、`AuroraCommerceErrorDto`，以及 `createAuroraApp(deps)` 和 PostgreSQL transaction helper。

- [ ] **Step 1: 写 contracts 红测**

在 `contracts.test.ts` 覆盖十进制额度字符串、服务端套餐字段和结构化错误：
```ts
expect(AuroraWalletSchema.parse({ availableCredits: '12.50', reservedCredits: '2.00' }))
  .toEqual({ availableCredits: '12.50', reservedCredits: '2.00' });
expect(() => AuroraWalletSchema.parse({ availableCredits: 12.5, reservedCredits: '0' }))
  .toThrow();
```

- [ ] **Step 2: 运行 contracts 红测**

Run:
```bash
pnpm --filter @open-design/aurora-contracts test
```
Expected: FAIL，因为 package 和 schemas 尚不存在。

- [ ] **Step 3: 创建纯 TypeScript/Zod contracts**

`src/index.ts` 至少导出以下决策形状；不得导入 Express、Node、浏览器 API、SQLite、Daemon internals 或 sidecar packages：
```ts
import { z } from 'zod';

export const CreditAmountSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const AuroraSessionSchema = z.object({ authenticated: z.boolean(), accountId: z.string().nullable() });
export const AuroraPlanSchema = z.object({ id: z.string(), name: z.string(), billingInterval: z.enum(['month', 'year', 'top-up']), displayPrice: z.string(), currency: z.string(), credits: CreditAmountSchema });
export const AuroraWalletSchema = z.object({ availableCredits: CreditAmountSchema, reservedCredits: CreditAmountSchema });
export const AuroraLedgerEntrySchema = z.object({ id: z.string(), amount: CreditAmountSchema, direction: z.enum(['credit', 'debit']), createdAt: z.string() });
export const AuroraCommerceErrorSchema = z.object({ code: z.string(), message: z.string(), status: z.union([z.literal(401), z.literal(402), z.literal(409)]) });
```
同时定义 plans、ledger、checkout、top-up、portal 的 request/response schemas 和导出类型。

- [ ] **Step 4: 创建控制面 package 骨架**

固定依赖版本：`express@5.2.1`、`zod@3.25.76`、`pg@8.23.0`、`stripe@22.6.0`、`openid-client@6.8.7`、`http-proxy@1.18.1`；测试依赖使用 `@testcontainers/postgresql@12.1.0`、Vitest 和对应类型包。`createAuroraApp` 只接收依赖，不在模块加载时读环境或连接数据库：
```ts
export interface AuroraAppDeps {
  db: AuroraDatabase;
  config: AuroraConfig;
}
export function createAuroraApp(deps: AuroraAppDeps): Express {
  const app = express();
  app.get('/api/aurora/health', (_req, res) => res.json({ ok: true }));
  return app;
}
```

- [ ] **Step 5: 安装 workspace links 并运行测试**

Run:
```bash
pnpm install
pnpm --filter @open-design/aurora-contracts test
pnpm --filter @open-design/aurora-control-plane test
pnpm --filter @open-design/aurora-contracts typecheck
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: 全部 PASS；root `package.json` 没有新增 runtime dependency。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml packages/aurora-contracts apps/aurora-control-plane
git commit -m "feat(aurora): add contracts and control plane foundation"
```

---

### Task 3: 实现 OIDC session 与同源保护

**Files:**
- Create: `apps/aurora-control-plane/src/migrations/001-auth.sql`
- Create: `apps/aurora-control-plane/src/auth/oidc.ts`
- Create: `apps/aurora-control-plane/src/auth/session-store.ts`
- Create: `apps/aurora-control-plane/src/auth/origin-guard.ts`
- Create: `apps/aurora-control-plane/src/routes/session.ts`
- Create: `apps/aurora-control-plane/tests/session.test.ts`
- Modify: `apps/aurora-control-plane/src/app.ts`
- Modify: `apps/aurora-control-plane/src/config.ts`

**Interfaces:**
- Consumes: Task 2 的 app factory、database helper 和 session DTO。
- Produces: `GET /api/aurora/session`、`GET /api/aurora/login`、`GET /api/aurora/callback`、`POST /api/aurora/logout`、`requireAuroraSession` 和 `requireSameOriginMutation`。

- [ ] **Step 1: 写 session 与 CSRF 红测**

使用 fake OIDC server 覆盖 PKCE/state/nonce callback、浏览器不接收 token、`__Host-aurora_session` cookie、logout 和跨 Origin POST 拒绝：
```ts
expect(callback.headers['set-cookie']).toContainEqual(expect.stringContaining('__Host-aurora_session='));
expect(callback.body).not.toHaveProperty('access_token');
expect(crossOriginLogout.status).toBe(403);
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- session.test.ts
```
Expected: FAIL，因为 session routes 和 guards 尚不存在。

- [ ] **Step 3: 实现服务端 OIDC session**

使用 `openid-client` 完成 discovery、Authorization Code + PKCE、state 和 nonce；token 只保存在 PostgreSQL session 记录中。cookie 固定为 `Secure; HttpOnly; SameSite=Lax; Path=/`，名称为 `__Host-aurora_session`：
```ts
export type AuroraPrincipal = { accountId: string; tenantId: string };
export interface AuroraSessionStore {
  create(principal: AuroraPrincipal, oidcTokens: StoredOidcTokens): Promise<string>;
  get(sessionId: string): Promise<AuroraPrincipal | null>;
  delete(sessionId: string): Promise<void>;
}
```

- [ ] **Step 4: 实现同源 mutation guard 与 logout**

对所有 `/api/aurora/*` 状态变更和付费 `POST /api/runs` 校验 `Origin` 与配置的 public origin 完全一致；不依赖 CORS preflight。logout 删除数据库 session 并过期 cookie。

- [ ] **Step 5: 运行 session 测试与 package 检查**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- session.test.ts
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/aurora-control-plane
git commit -m "feat(aurora): add oidc sessions"
```

---

### Task 4: 实现服务端套餐与 Stripe 生命周期

**Files:**
- Create: `apps/aurora-control-plane/src/migrations/002-commerce.sql`
- Create: `apps/aurora-control-plane/src/commerce/catalog.ts`
- Create: `apps/aurora-control-plane/src/commerce/stripe.ts`
- Create: `apps/aurora-control-plane/src/routes/commerce.ts`
- Create: `apps/aurora-control-plane/tests/commerce.test.ts`
- Modify: `apps/aurora-control-plane/src/app.ts`
- Modify: `apps/aurora-control-plane/src/config.ts`

**Interfaces:**
- Consumes: Task 2 DTO、Task 3 authenticated session 和 same-origin guard。
- Produces: `GET /api/aurora/plans`、`POST /api/aurora/checkout`、`POST /api/aurora/top-up`、`POST /api/aurora/portal`、`POST /api/aurora/webhooks/stripe` 和版本化 server-owned catalog。

- [ ] **Step 1: 写套餐与 Stripe 红测**

覆盖 Creator/Pro/Studio 月付年付、充值、portal、浏览器不能提交 Price、webhook signature 和 Stripe event id 幂等：
```ts
expect(await postCheckout({ body: { priceId: 'attacker-price' } })).toMatchObject({ status: 409 });
expect(await deliverStripeEventTwice('evt_same')).toMatchObject({ appliedEvents: 1 });
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- commerce.test.ts
```
Expected: FAIL，因为 commerce routes 尚不存在。

- [ ] **Step 3: 实现版本化服务端 catalog**

catalog 只从服务端配置读取 plan、billing interval、Stripe Price、credits 和 promotion；Web 响应可返回展示值但不返回计算规则：
```ts
export interface ServerPlan {
  id: 'creator' | 'pro' | 'studio';
  interval: 'month' | 'year' | 'top-up';
  stripePriceId: string;
  credits: string;
  pricingVersion: string;
}
```

- [ ] **Step 4: 实现 Stripe routes 与 webhook 幂等**

checkout/top-up/portal 从 authenticated account 和服务端 catalog 构造 Stripe 请求。webhook 在事务中先插入唯一 `stripe_event_id`，重复事件返回 200 且不重复写入商业状态。

- [ ] **Step 5: 运行测试**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- commerce.test.ts
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/aurora-control-plane
git commit -m "feat(aurora): add stripe commerce"
```

---

### Task 5: 实现不可变账本与钱包视图

**Files:**
- Create: `apps/aurora-control-plane/src/migrations/003-ledger.sql`
- Create: `apps/aurora-control-plane/src/commerce/ledger.ts`
- Create: `apps/aurora-control-plane/src/routes/wallet.ts`
- Create: `apps/aurora-control-plane/tests/ledger.test.ts`
- Modify: `apps/aurora-control-plane/src/app.ts`

**Interfaces:**
- Consumes: Task 2 database transaction helper 和 wallet/ledger DTO。
- Produces: immutable `ledger_entries`、transactionally updated `wallets`、`GET /api/aurora/wallet`、`GET /api/aurora/ledger`、`reserveCredits`、`settleReservation`、`releaseReservation`。

- [ ] **Step 1: 写 PostgreSQL 并发红测**

通过 `@testcontainers/postgresql` 启动独立 PostgreSQL，覆盖并发预占、余额不足、重复 reservation key、不可变 ledger 和离线重建：
```ts
const results = await Promise.allSettled([
  ledger.reserveCredits(accountId, 'run:req-1', '8.00'),
  ledger.reserveCredits(accountId, 'run:req-2', '8.00'),
]);
expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- ledger.test.ts
```
Expected: FAIL，因为 ledger schema 和 service 尚不存在。

- [ ] **Step 3: 实现账本事实源与钱包物化视图**

所有写入在一个数据库事务中锁定 wallet row、追加 immutable ledger entry 并更新 wallet；正常余额事务不得扫描历史：
```ts
export interface LedgerService {
  reserveCredits(accountId: string, reservationKey: string, amount: string): Promise<void>;
  settleReservation(reservationKey: string): Promise<void>;
  releaseReservation(reservationKey: string): Promise<void>;
}
```
完整重建只导出给测试和离线审计。

- [ ] **Step 4: 暴露只读 wallet/ledger routes**

routes 要求 authenticated session，只返回 Task 2 DTO；不返回数据库内部行、Stripe secret 或计算逻辑。

- [ ] **Step 5: 运行测试**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- ledger.test.ts
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/aurora-control-plane
git commit -m "feat(aurora): add credit ledger"
```

---

### Task 6: 实现付费 Run 预占与幂等 admission

**Files:**
- Create: `apps/aurora-control-plane/src/migrations/004-run-charges.sql`
- Create: `apps/aurora-control-plane/src/runs/admission.ts`
- Create: `apps/aurora-control-plane/src/runs/upstream.ts`
- Create: `apps/aurora-control-plane/src/routes/runs.ts`
- Create: `apps/aurora-control-plane/tests/run-admission.test.ts`
- Modify: `apps/aurora-control-plane/src/app.ts`

**Interfaces:**
- Consumes: Task 3 session/origin guards、Task 5 ledger、现有 OpenDesign `POST /api/runs` body 和 `clientRequestId`。
- Produces: 唯一 RunCharge、固定价格预占、DSH-only admission、原样 upstream body/response 转发和 lost-response retry。

- [ ] **Step 1: 写 Run admission 红测**

使用 fake OpenDesign HTTP upstream 覆盖有技能、无技能、多技能、缺失/重复 `clientRequestId`、余额不足、显式非 DSH `agentId`、创建响应丢失和重复 body 恢复：
```ts
expect(await createPaidRun({ clientRequestId: '' })).toMatchObject({ status: 409 });
expect(await createPaidRun({ clientRequestId: 'req-1', agentId: 'claude' })).toMatchObject({ status: 409 });
expect(fakeUpstream.bodies[0]).toMatchObject({ clientRequestId: 'req-1', agentId: 'deepseek-harness' });
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- run-admission.test.ts
```
Expected: FAIL，因为 admission route 尚不存在。

- [ ] **Step 3: 实现事务内认证、唯一 RunCharge 和预占**

RunCharge 对 `(account_id, client_request_id)` 建唯一约束，并保存 `pricing_version`、固定 `amount`、原始 body digest、reservation state 和可空 `run_id`：
```ts
export type RunChargeState = 'reserved' | 'settled' | 'released';
export interface RunCharge {
  accountId: string;
  clientRequestId: string;
  pricingVersion: string;
  amount: string;
  bodyDigest: string;
  runId: string | null;
  state: RunChargeState;
}
```

- [ ] **Step 4: 实现 upstream retry 不变量**

首次请求把 `agentId` 固定为 `deepseek-harness`，其余 Run body 和响应形状不变。网络结果不确定时保留预占；相同 `clientRequestId` 只允许相同 body digest，并以完全相同 body 重试 OpenDesign `createOrReuse`。

- [ ] **Step 5: 运行测试**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- run-admission.test.ts
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: PASS；fake upstream 观察到相同 body 和同一个 `clientRequestId`。

- [ ] **Step 6: 提交**

```bash
git add apps/aurora-control-plane
git commit -m "feat(aurora): add paid run admission"
```

---

### Task 7: 实现 Run 结算 reconciliation 与错误契约

**Files:**
- Create: `apps/aurora-control-plane/src/runs/reconciler.ts`
- Create: `apps/aurora-control-plane/src/commerce/errors.ts`
- Create: `apps/aurora-control-plane/tests/run-reconciliation.test.ts`
- Modify: `apps/aurora-control-plane/src/server.ts`
- Modify: `apps/aurora-control-plane/src/routes/runs.ts`

**Interfaces:**
- Consumes: Task 6 RunCharge 和现有 OpenDesign Run status。
- Produces: `succeeded` settle、`failed`/`canceled` release、non-terminal/unreachable retry，以及结构化 401/402/409 commerce errors。

- [ ] **Step 1: 写 reconciliation 红测**

覆盖三个终态、非终态、upstream 暂时不可用和重复轮询：
```ts
await reconcile(chargeFor('run-ok'), { status: 'succeeded' });
expect(await loadCharge('run-ok')).toMatchObject({ state: 'settled' });
await reconcile(chargeFor('run-wait'), new Error('upstream unavailable'));
expect(await loadCharge('run-wait')).toMatchObject({ state: 'reserved' });
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- run-reconciliation.test.ts
```
Expected: FAIL，因为 reconciler 尚不存在。

- [ ] **Step 3: 实现最小 reconciler**

只查询现有 Run status，不读取 token/media usage：
```ts
export type ReconcileDecision = 'settle' | 'release' | 'retry';
export function decisionForRunStatus(status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'): ReconcileDecision {
  if (status === 'succeeded') return 'settle';
  if (status === 'failed' || status === 'canceled') return 'release';
  return 'retry';
}
```
server 启动定时轮询 reserved charges；进程退出时停止调度。

- [ ] **Step 4: 实现结构化错误映射**

未认证返回 401、余额不足返回 402、缺失/重复 body 冲突或 agent 冲突返回 409；错误 body 必须通过 `AuroraCommerceErrorSchema`。

- [ ] **Step 5: 运行测试**

Run:
```bash
pnpm --filter @open-design/aurora-control-plane test -- run-reconciliation.test.ts run-admission.test.ts
pnpm --filter @open-design/aurora-control-plane typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/aurora-control-plane
git commit -m "feat(aurora): reconcile paid runs"
```

---

### Task 8: 配置租户实例、DSH-only 与不透明路由

**Files:**
- Create: `deploy/aurora/README.md`
- Create: `deploy/aurora/docker-compose.yml`
- Create: `deploy/aurora/env.example`
- Create: `apps/aurora-control-plane/src/tenants/routes.ts`
- Create: `apps/aurora-control-plane/src/proxy/open-design.ts`
- Create: `e2e/tests/aurora-deployment-contract.test.ts`
- Modify: `apps/aurora-control-plane/src/app.ts`

**Interfaces:**
- Consumes: Task 3 authenticated tenant identity、Task 6 paid `/api/runs` route、未修改 OpenDesign `/api/health` 和 `/api/agents`。
- Produces: authenticated tenant-to-upstream mapping、两个隔离租户实例、opaque proxy 和 dual-tenant deployment contract。

- [ ] **Step 1: 写双租户 deployment 红测**

通过生产 HTTP surface 验证 tenant A/B 的 `/api/health`、`/api/agents`、Project data、credentials 和 upstream 选择；浏览器提交 upstream URL 必须被忽略：
```ts
expect(await tenantA.get('/api/agents')).toContainAgent('deepseek-harness');
expect(await tenantB.getProject(tenantAProjectId)).toMatchObject({ status: 404 });
expect(await tenantA.getProject(tenantAProjectId, { headers: { 'x-aurora-upstream': tenantBUrl } })).toMatchObject({ id: tenantAProjectId });
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/e2e test -- tests/aurora-deployment-contract.test.ts
```
Expected: FAIL，因为 Aurora compose、routing 和 proxy 尚不存在。

- [ ] **Step 3: 创建 Docker Compose reference deployment**

定义 control plane、PostgreSQL、tenant-a Web/Daemon、tenant-b Web/Daemon。每个 Daemon 接收独立最终 `OD_DATA_DIR` volume、独立 `DSH_HOME`、供应商凭证、网络、CPU、内存、PID 和存储限制；只安装/配置 `deepseek-harness`。不得在文档中发明具体宿主机 daemon data path。

- [ ] **Step 4: 实现 authenticated routing 与 opaque proxy**

租户 route 只来自 server-side session：
```ts
export interface TenantRoute { tenantId: string; upstreamOrigin: URL }
export interface TenantRouteStore { getByTenantId(tenantId: string): Promise<TenantRoute | null> }
```
使用 `http-proxy` streaming 转发 `/api/*`、SSE、artifact、frame、preview 和 download；`POST /api/runs` 先经过 Task 6 admission，不能被通用 proxy 绕过。

- [ ] **Step 5: 运行 deployment contract**

Run:
```bash
pnpm --filter @open-design/e2e test -- tests/aurora-deployment-contract.test.ts
```
Expected: PASS；tenant A/B 的实例、数据、凭证和网络不交叉。

- [ ] **Step 6: 提交**

```bash
git add deploy/aurora apps/aurora-control-plane e2e/tests/aurora-deployment-contract.test.ts
git commit -m "feat(aurora): add isolated tenant deployment"
```

---

### Task 9: 建立 Web presentation 配置与能力

**Files:**
- Create: `apps/web/src/product/presentation.ts`
- Create: `apps/web/src/product/aurora/config.ts`
- Create: `apps/web/tests/product/presentation.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 1 默认 OpenDesign 基线。
- Produces: `WebPresentationCapabilities`、`WebPresentation`、`resolveWebPresentation` 和 App 顶层单次解析。

- [ ] **Step 1: 写 presentation 红测**

覆盖 unset/opendesign、aurora 和未知值：
```ts
expect(resolveWebPresentation(undefined)).toMatchObject({ product: 'opendesign', capabilities: { showRuntimeControls: true, showByokControls: true, showDesktopEntrypoints: true } });
expect(resolveWebPresentation('aurora').capabilities).toEqual({ showRuntimeControls: false, showByokControls: false, showDesktopEntrypoints: false });
expect(() => resolveWebPresentation('unknown')).toThrow(/NEXT_PUBLIC_OD_PRESENTATION/);
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/web test -- tests/product/presentation.test.ts
```
Expected: FAIL，因为 presentation 模块尚不存在。

- [ ] **Step 3: 实现 build-only presentation config**

```ts
export interface WebPresentationCapabilities {
  showRuntimeControls: boolean;
  showByokControls: boolean;
  showDesktopEntrypoints: boolean;
}
export interface WebPresentation {
  product: 'opendesign' | 'aurora';
  productName: string;
  capabilities: WebPresentationCapabilities;
}
```
`layout.tsx` 设置对应 title；`App` 只解析一次并把通用 presentation/capabilities 传给最接近的 composition owners，不向 Daemon、contracts 或 DSH 传 product profile。

- [ ] **Step 4: 运行 focused tests 与 build**

Run:
```bash
pnpm --filter @open-design/web test -- tests/product/presentation.test.ts
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web build
NEXT_PUBLIC_OD_PRESENTATION=aurora pnpm --filter @open-design/web build
```
Expected: 默认和 Aurora build 均 PASS；未知值 build FAIL。

- [ ] **Step 5: 提交**

```bash
git add apps/web/app/layout.tsx apps/web/src/App.tsx apps/web/src/product apps/web/tests/product
git commit -m "feat(web): add aurora presentation profile"
```

---

### Task 10: 挂载 Aurora 商业状态与 chrome

**Files:**
- Create: `apps/web/src/product/aurora/api.ts`
- Create: `apps/web/src/product/aurora/state.ts`
- Create: `apps/web/src/components/aurora/AuroraCommerceBar.tsx`
- Create: `apps/web/src/components/aurora/AuroraCommerceBar.module.css`
- Create: `apps/web/src/components/aurora/AuroraPlansDialog.tsx`
- Create: `apps/web/src/components/aurora/AuroraPlansDialog.module.css`
- Create: `apps/web/src/components/aurora/AuroraLedgerDrawer.tsx`
- Create: `apps/web/src/components/aurora/AuroraLedgerDrawer.module.css`
- Create: `apps/web/tests/components/aurora/AuroraCommerceChrome.test.tsx`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 3 session、Task 4 plans/checkout/top-up/portal、Task 5 wallet/ledger DTO、Task 9 presentation。
- Produces: Aurora API client、`AuroraCommerceState` reducer/actions、余额条、套餐 dialog、账本 drawer 和登录/充值恢复入口。

- [ ] **Step 1: 写商业 chrome 红测**

mock `/api/aurora/*`，覆盖未登录、已登录余额、服务端套餐渲染、checkout/top-up/portal、ledger 和 401/402/409 恢复入口：
```tsx
expect(screen.getByRole('button', { name: /登录/ })).toBeVisible();
expect(screen.getByText('12.50')).toBeVisible();
expect(screen.getByText(serverPlan.name)).toBeVisible();
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/web test -- tests/components/aurora/AuroraCommerceChrome.test.tsx
```
Expected: FAIL，因为 Aurora state/chrome 尚不存在。

- [ ] **Step 3: 实现 API client 与顶层 state**

client 只调用同源 `/api/aurora/*`，不计算价格，不持有 OIDC token：
```ts
export interface AuroraCommerceState {
  session: AuroraSessionDto;
  wallet: AuroraWalletDto | null;
  plans: AuroraPlanDto[];
  ledger: AuroraLedgerEntryDto[];
  refresh(): Promise<void>;
}
```
在 `apps/web/package.json` 增加 `@open-design/aurora-contracts: workspace:*`。只在 `presentation.product === 'aurora'` 时由 `App` 持有 commerce state，并把 state/actions 作为 props 传给 chrome；不新增第二个产品级 provider。

- [ ] **Step 4: 实现 UI 组件**

使用 `@open-design/components` 的 `Button` 等现有 primitives；产品特定布局留在 colocated CSS Modules。套餐名、价格、币种和额度只渲染服务端原值。

- [ ] **Step 5: 运行测试与 typecheck**

Run:
```bash
pnpm --filter @open-design/web test -- tests/components/aurora/AuroraCommerceChrome.test.tsx
pnpm --filter @open-design/web typecheck
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): add aurora commerce chrome"
```

---

### Task 11: 集成三个 featured starts

**Files:**
- Create: `apps/web/src/components/aurora/AuroraFeaturedStarts.tsx`
- Create: `apps/web/src/components/aurora/AuroraFeaturedStarts.module.css`
- Create: `apps/web/tests/components/aurora/AuroraFeaturedStarts.test.tsx`
- Modify: `apps/web/src/components/EntryView.tsx`

**Interfaces:**
- Consumes: Task 9 presentation、现有 EntryShell/HomeView 的 catalog、draft、attachment 和 `onCreateProject` flow。
- Produces: 固定顺序 `poster`、`xhs-image`、`xhs-copy` 的数据驱动 featured rail，不创建平行表单或 catalog。

- [ ] **Step 1: 写 featured ordering 红测**

```tsx
expect(featuredIds(renderedCards)).toEqual(['poster', 'xhs-image', 'xhs-copy']);
await user.click(screen.getByRole('button', { name: /poster/i }));
expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'poster' }));
```
同时断言搜索、草稿和附件 controls 仍来自现有 EntryShell/HomeView。

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/web test -- tests/components/aurora/AuroraFeaturedStarts.test.tsx
```
Expected: FAIL，因为 featured component 尚不存在。

- [ ] **Step 3: 实现数据驱动 featured rail**

```ts
export const AURORA_FEATURED_START_IDS = ['poster', 'xhs-image', 'xhs-copy'] as const;
```
组件只从现有 catalog summaries 选择并排序三个 ID；点击继续调用现有 Project creation callback。缺失信息继续由 skill 说明和 inline question-form 处理。

- [ ] **Step 4: 运行测试**

Run:
```bash
pnpm --filter @open-design/web test -- tests/components/aurora/AuroraFeaturedStarts.test.tsx
pnpm --filter @open-design/web typecheck
```
Expected: PASS；没有 `AuroraHomeView`、第二套 search 或硬编码表单。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/EntryView.tsx apps/web/src/components/aurora apps/web/tests/components/aurora
git commit -m "feat(web): add aurora featured starts"
```

---

### Task 12: 隐藏托管控制项并完成 19-locale i18n

**Files:**
- Create: `apps/web/tests/product/presentation-capabilities.test.tsx`
- Modify: `apps/web/src/components/ProjectView.tsx`
- Modify: `apps/web/src/components/AvatarMenu.tsx`
- Modify: `apps/web/src/components/SettingsDialog.tsx`
- Modify: `apps/web/src/i18n/types.ts`
- Modify: `apps/web/src/i18n/locales/ar.ts`
- Modify: `apps/web/src/i18n/locales/de.ts`
- Modify: `apps/web/src/i18n/locales/en.ts`
- Modify: `apps/web/src/i18n/locales/es-ES.ts`
- Modify: `apps/web/src/i18n/locales/fa.ts`
- Modify: `apps/web/src/i18n/locales/fr.ts`
- Modify: `apps/web/src/i18n/locales/hu.ts`
- Modify: `apps/web/src/i18n/locales/id.ts`
- Modify: `apps/web/src/i18n/locales/it.ts`
- Modify: `apps/web/src/i18n/locales/ja.ts`
- Modify: `apps/web/src/i18n/locales/ko.ts`
- Modify: `apps/web/src/i18n/locales/pl.ts`
- Modify: `apps/web/src/i18n/locales/pt-BR.ts`
- Modify: `apps/web/src/i18n/locales/ru.ts`
- Modify: `apps/web/src/i18n/locales/th.ts`
- Modify: `apps/web/src/i18n/locales/tr.ts`
- Modify: `apps/web/src/i18n/locales/uk.ts`
- Modify: `apps/web/src/i18n/locales/zh-CN.ts`
- Modify: `apps/web/src/i18n/locales/zh-TW.ts`
- Modify: `apps/web/tests/i18n/locales.test.ts`

**Interfaces:**
- Consumes: Task 9 capabilities、Task 10/11 Aurora UI 文案。
- Produces: composition-level Runtime/BYOK/desktop visibility 和全部 `aurora.*` translations。

- [ ] **Step 1: 写 capability 与 locale 红测**

默认 OpenDesign 断言三个入口存在；Aurora 断言 Runtime picker、BYOK/provider settings、desktop download 和相关深链均省略。扩展 locale test 覆盖 key parity、own-property 显式声明和 placeholder parity。

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/web test -- tests/product/presentation-capabilities.test.tsx tests/i18n/locales.test.ts
```
Expected: FAIL，因为 owners 尚未消费 capabilities，`Dict` 尚无 Aurora keys。

- [ ] **Step 3: 在最接近的 composition owner 省略子树**

`ProjectView` 只根据 `showRuntimeControls` 省略 Runtime UI，不改变 Run admission/dispatch；`AvatarMenu` 和 `SettingsDialog` 分别根据 BYOK/desktop capabilities 过滤入口和深链。共享叶组件不得出现 `if (aurora)`。

- [ ] **Step 4: 添加 typed Aurora 文案**

在 `Dict` 添加以下扁平 keys：`aurora.commerce.signIn`、`aurora.commerce.balance`、`aurora.commerce.plans`、`aurora.commerce.topUp`、`aurora.commerce.billingPortal`、`aurora.commerce.ledger`、`aurora.commerce.insufficientCredits`、`aurora.commerce.checkoutFailed`、`aurora.commerce.topUpFailed`、`aurora.featured.title`、`aurora.featured.poster`、`aurora.featured.xhsImage`、`aurora.featured.xhsCopy`。在 19 个 locale 中逐项显式提供值；商业 shell 全部通过 `useT()`，产品名、套餐名、价格、币种和额度保持产品身份或服务端值。

- [ ] **Step 5: 运行测试、typecheck 和双 build**

Run:
```bash
pnpm --filter @open-design/web test -- tests/product/presentation-capabilities.test.tsx tests/i18n/locales.test.ts
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web build
NEXT_PUBLIC_OD_PRESENTATION=aurora pnpm --filter @open-design/web build
```
Expected: PASS；默认 OpenDesign 显示全部入口，Aurora 隐藏全部三个托管外入口。

- [ ] **Step 6: 提交**

```bash
git add apps/web
git commit -m "feat(web): localize aurora presentation"
```

---

### Task 13: 添加三个标准内容资源

**Files:**
- Create: `design-templates/poster/SKILL.md`
- Create: `design-templates/poster/example.html`
- Create: `design-templates/poster/references/output-contract.md`
- Create: `design-templates/xhs-image/SKILL.md`
- Create: `design-templates/xhs-image/example.html`
- Create: `design-templates/xhs-image/references/output-contract.md`
- Create: `skills/xhs-copy/SKILL.md`
- Create: `skills/xhs-copy/references/output-schema.json`
- Create: `e2e/tests/aurora-content-resources.test.ts`

**Interfaces:**
- Consumes: Task 1 内容边界、现有 skill/design-template scanner 和 Project/result package。
- Produces: `poster`、`xhs-image`、`xhs-copy` 三个自包含标准资源和一个 content-owned acceptance test。

- [ ] **Step 1: 写 content acceptance 红测**

验证三个资源的 frontmatter、scanner discoverability、example route、输出名、事实安全和禁止外部 Aurora 引用：
```ts
expect(template('poster').mode).toBe('image');
expect(template('xhs-image').exampleHtml).toContain('<svg');
expect(skill('xhs-copy').mode).toBe('utility');
expect(allResourceText).not.toMatch(/skill-runtime\.ts|external Aurora/i);
```

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/e2e test -- tests/aurora-content-resources.test.ts
```
Expected: FAIL，因为三个资源尚不存在。

- [ ] **Step 3: 实现 poster 与 xhs-image templates**

两者使用标准 design-template frontmatter 和 `od.mode: image`，并提供 baked `example.html`。`poster` 规定输出可校对文字层的 `poster.svg` 和清单，可选背景只通过现有 `od media generate`；`xhs-image` 规定输出五张 3:4 SVG、项目内 gallery 和清单，地点与事实只能来自用户输入。

- [ ] **Step 4: 实现 xhs-copy utility skill**

`SKILL.md` 使用 `od.mode: utility`，只输出 `xhs-copy.md` 和符合 `output-schema.json` 的结构化 JSON，不增加 mode/protocol 语义，不调用媒体工具。

- [ ] **Step 5: 运行现有 content checks**

Run:
```bash
pnpm --filter @open-design/e2e test -- tests/aurora-content-resources.test.ts
pnpm guard
```
Expected: scanner/protocol/example/guard 检查 PASS；不修改 `image-poster`、`social-carousel`、`ecommerce-image-workflow` 或其他现有目录。

- [ ] **Step 6: 提交**

```bash
git add design-templates/poster design-templates/xhs-image skills/xhs-copy e2e/tests/aurora-content-resources.test.ts
git commit -m "feat(content): add aurora launch resources"
```

---

### Task 14: 关闭部署、内容与 sale-to-result 验收

**Files:**
- Create: `e2e/tests/aurora-sale-to-result.test.ts`

**Interfaces:**
- Consumes: Tasks 7、8、10、11、12、13 的完成结果。
- Produces: 默认 OpenDesign 无回归、Aurora sale-to-result、双租户隔离和最终 forbidden-surface evidence。

- [ ] **Step 1: 写 sale-to-result smoke 红测**

只通过控制面 HTTP 和正常 OpenDesign HTTP surface 执行：登录 → 获得额度 → 选择技能 → 原样创建 OpenDesign Run → 接收 SSE/result package → 固定价格结算。测试不直接修改钱包、Project 文件或 Daemon 数据。

- [ ] **Step 2: 运行红测**

Run:
```bash
pnpm --filter @open-design/e2e test -- tests/aurora-sale-to-result.test.ts
```
Expected: 在任何未完成集成存在时 FAIL，并指出断裂 seam。

- [ ] **Step 3: 完成最小 smoke wiring**

复用现有 e2e Vitest suite 和 tools-dev/HTTP helpers；不手写 tools-dev lifecycle，不增加 Aurora 专属 CI workload、UI shard、Daemon suite 或 fake DSH protocol。若现有 planner 无法发现新增 e2e test，先阅读 `specs/current/ci.md`，只把该 test set 接入现有 conservative route，不创建新 scheduling identity。

- [ ] **Step 4: 运行 focused 验收**

Run:
```bash
pnpm --filter @open-design/aurora-contracts test
pnpm --filter @open-design/aurora-control-plane test
pnpm --filter @open-design/web test
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web build
NEXT_PUBLIC_OD_PRESENTATION=aurora pnpm --filter @open-design/web build
pnpm --filter @open-design/e2e test -- tests/aurora-deployment-contract.test.ts tests/aurora-content-resources.test.ts tests/aurora-sale-to-result.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5: 运行 repository baseline**

Run:
```bash
pnpm guard
pnpm typecheck
git diff --check
```
Expected: 全部 PASS。

- [ ] **Step 6: 扫描最终 diff 边界**

Run:
```bash
git diff --name-only origin/main...HEAD
```
Expected: 不包含 `apps/daemon/src/**`、`packages/dsh-runtime/**`、`packages/contracts/**`、`apps/web/src/providers/daemon.ts`、现有 skill/design-template 目录或第二套 Workspace 实现。

- [ ] **Step 7: 确认完成证据**

- [ ] 默认 OpenDesign 无行为变化。
- [ ] Aurora 只增加品牌/商业展示、外部付费服务、部署配置和三个内容目录。
- [ ] DSH-only 由网关和部署保证。
- [ ] 付费只依赖固定价格、`clientRequestId`、`runId` 和现有终态。
- [ ] 现有 Project、Conversation、Run、SSE、文件、预览、Automation、协作和 DSH adapter 完整复用。

- [ ] **Step 8: 提交**

```bash
git add e2e/tests/aurora-sale-to-result.test.ts
git commit -m "test(aurora): close sale to result acceptance"
```
