# Aurora Agent Web Commercial Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Aurora 自有的账号、Stripe 订阅/充值、积分钱包、不可变账本、Run 预占/结算/对账和租户路由服务，并以透明网关方式复用 OpenDesign 的 Project、Run/SSE、文件和预览接口。

**Architecture:** 新应用 `apps/aurora-control-plane` 是公开 API 入口。OIDC 会话在网关解析为账号与租户；PostgreSQL 保存商业事实和租户路由；所有创作数据仍在该租户独享的 OpenDesign 实例。网关自身处理 `/api/aurora/*`，匿名目录请求只读地发往 catalog 实例，已认证的 OpenDesign API/文件/预览/SSE 请求按 `TenantRoute` 转发。`POST /api/runs` 被拦截并执行“事务预占 → OpenDesign 幂等创建 → 绑定 runId → 后台结算”。

**Tech Stack:** Node.js 24、TypeScript 5.9.3、Express 5.2.1、PostgreSQL 17、`pg@8.23.0`、`stripe@22.6.0`、`openid-client@6.8.7`、`http-proxy@1.18.1`、Zod 3.25.76、Vitest 4.1.6、Testcontainers 12.1.0。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## Global Constraints

- 本计划依赖 `2026-08-28-aurora-product-foundation.md` 提供 DSH-only 策略和终态 `usageEvidence`。
- 商业控制面不得保存 Project、Conversation、消息、文件正文、预览内容或 DSH 会话。
- 浏览器不能提交权威 `tenantId`、上游 URL、Stripe Price、币种、税额、积分单价或实际用量。
- 所有积分均使用 PostgreSQL `BIGINT` 和 API 十进制字符串；禁止 JavaScript 浮点财务计算。
- Stripe Webhook 是订阅支付状态的权威输入；重放、乱序和重复事件必须安全。
- 新 Run 在控制面不可用、余额不足、并发已满、租户路由缺失或 DSH 容量不可用时失败关闭。
- 正式价格不写死在代码中。启动时加载并验证服务端套餐目录；测试使用已提交的确定性 fixture。
- 每个 `TenantRoute` 必须指向一个独立 OpenDesign 实例；实例数据根继续遵循根 `AGENTS.md` 的 Daemon data directory contract，本文档和新增运维文档不写具体路径示例。
- 租户 OpenDesign 服务只允许控制面所在的私有网络访问；供应商密钥不进入控制面响应、浏览器或项目文件。

---

## Exact File Map

### Create application shell

- `apps/aurora-control-plane/package.json`
- `apps/aurora-control-plane/tsconfig.json`
- `apps/aurora-control-plane/tsconfig.tests.json`
- `apps/aurora-control-plane/vitest.config.ts`
- `apps/aurora-control-plane/src/index.ts`
- `apps/aurora-control-plane/src/config.ts`
- `apps/aurora-control-plane/src/http/errors.ts`
- `apps/aurora-control-plane/src/http/origin.ts`
- `apps/aurora-control-plane/tests/setup.ts`

### Create contracts and persistence

- `packages/contracts/src/api/aurora.ts`
- `packages/contracts/tests/aurora-contracts.test.ts`
- `apps/aurora-control-plane/src/db/pool.ts`
- `apps/aurora-control-plane/src/db/migrate.ts`
- `apps/aurora-control-plane/src/db/transaction.ts`
- `apps/aurora-control-plane/migrations/001_commercial_core.sql`
- `apps/aurora-control-plane/migrations/002_run_billing.sql`
- `apps/aurora-control-plane/tests/db/migrations.test.ts`

### Create identity and commerce

- `apps/aurora-control-plane/src/auth/oidc.ts`
- `apps/aurora-control-plane/src/auth/session-store.ts`
- `apps/aurora-control-plane/src/auth/routes.ts`
- `apps/aurora-control-plane/tests/auth/routes.test.ts`
- `apps/aurora-control-plane/src/billing/catalog.ts`
- `apps/aurora-control-plane/src/billing/ledger.ts`
- `apps/aurora-control-plane/src/billing/stripe-routes.ts`
- `apps/aurora-control-plane/src/billing/stripe-webhook.ts`
- `apps/aurora-control-plane/tests/billing/catalog.test.ts`
- `apps/aurora-control-plane/tests/billing/ledger.test.ts`
- `apps/aurora-control-plane/tests/billing/stripe-webhook.test.ts`
- `apps/aurora-control-plane/tests/fixtures/plans.valid.json`

### Create gateway and Run billing

- `apps/aurora-control-plane/src/tenants/routes.ts`
- `apps/aurora-control-plane/src/tenants/service.ts`
- `apps/aurora-control-plane/src/gateway/proxy.ts`
- `apps/aurora-control-plane/src/gateway/authorization.ts`
- `apps/aurora-control-plane/src/runs/estimator.ts`
- `apps/aurora-control-plane/src/runs/charges.ts`
- `apps/aurora-control-plane/src/runs/create-run.ts`
- `apps/aurora-control-plane/src/runs/reconciler.ts`
- `apps/aurora-control-plane/tests/gateway/proxy.test.ts`
- `apps/aurora-control-plane/tests/runs/charges.test.ts`
- `apps/aurora-control-plane/tests/runs/create-run.test.ts`
- `apps/aurora-control-plane/tests/runs/reconciler.test.ts`
- `apps/aurora-control-plane/src/ops-cli.ts`
- `apps/aurora-control-plane/tests/ops-cli.test.ts`

### Modify repository guides/exports

- `AGENTS.md`
- `packages/contracts/src/index.ts`
- `apps/AGENTS.md`
- `docs/architecture.md`
- `deploy/README.md`
- `pnpm-lock.yaml` — 只由精确的 `pnpm add --save-exact` 命令更新。

### Create deployable image and cross-boundary validation

- `deploy/aurora-control-plane.Dockerfile`
- `e2e/tests/aurora-control-plane-image.test.ts`

### Modify CI planning and merge-gate topology

- `.github/config/scopes.json`
- `.github/config/convergence.json`
- `.github/scripts/scopes.py`
- `.github/workflows/ci.yml`
- `e2e/tests/scripts/scopes.test.ts`
- `e2e/tests/packaged-smoke-workflow.test.ts`
- `specs/current/ci.md`

## Public Contract Shapes

```ts
// packages/contracts/src/api/aurora.ts
export type AuroraPlanTier = 'creator' | 'pro' | 'studio';
export type AuroraBillingInterval = 'monthly' | 'yearly';
export type AuroraCurrency = 'USD' | 'SGD';
export type CreditMicros = string; // /^(0|[1-9][0-9]*)$/

export interface AuroraSessionResponse {
  authenticated: boolean;
  account?: { id: string; displayName: string; email: string | null };
}

export interface AuroraWalletResponse {
  subscriptionAvailableMicros: CreditMicros;
  topupAvailableMicros: CreditMicros;
  reservedMicros: CreditMicros;
  totalAvailableMicros: CreditMicros;
  version: string;
}

export interface AuroraRunEstimateRequest {
  skillId: string;
  promptBytes: number;
  attachmentBytes: number;
}

export interface AuroraRunEstimateResponse {
  estimateMinMicros: CreditMicros;
  reserveMicros: CreditMicros;
  pricingVersion: string;
}
```

## Required Database Invariants

`001_commercial_core.sql` creates:

- `tenants(id, status, created_at, updated_at)`
- `accounts(id, oidc_issuer, oidc_subject, email, display_name, tenant_id, created_at, updated_at)` with unique `(oidc_issuer, oidc_subject)`
- `auth_sessions(id_hash, account_id, expires_at, created_at, last_seen_at)`; only the hash is stored
- `tenant_routes(tenant_id, upstream_origin, status, version, created_at, updated_at)`
- `subscriptions(id, tenant_id, stripe_customer_id, stripe_subscription_id, tier, interval, currency, status, current_period_start, current_period_end, last_event_created, updated_at)`
- `wallets(tenant_id, subscription_available_micros, topup_available_micros, reserved_micros, version, updated_at)`
- `credit_ledger(id, tenant_id, bucket, entry_type, delta_micros, reference_type, reference_id, idempotency_key, metadata_json, created_at)` with unique `(tenant_id, idempotency_key)`
- `stripe_events(event_id, event_type, event_created, payload_sha256, processed_at)`

`002_run_billing.sql` creates:

- `run_charges(id, tenant_id, account_id, client_request_id, request_sha256, skill_id, pricing_version, reserve_micros, reserved_subscription_micros, reserved_topup_micros, open_design_run_id, status, actual_micros, usage_evidence_json, created_at, updated_at, settled_at)` with unique `(tenant_id, client_request_id)` and unique non-null `open_design_run_id`
- `run_usage_items(id, run_charge_id, idempotency_key, kind, meter, quantity, unit_price_micros, charge_micros, evidence_json, created_at)` with unique `(run_charge_id, idempotency_key)`
- `idempotent_responses(tenant_id, operation, idempotency_key, request_sha256, response_status, response_headers_json, response_body_json, created_at)`

Every balance-changing transaction must lock one wallet row, insert ledger entries, update the materialized wallet, and assert that rebuilding from ledger yields the same bucket balances.

## Task 1: Scaffold the control-plane app

**Files:** application shell files listed above; `AGENTS.md`; `apps/AGENTS.md`; `pnpm-lock.yaml`.

- [ ] Create a failing smoke test importing `createAuroraControlPlaneApp()` and asserting `GET /healthz` returns `{ ok: true, service: 'aurora-control-plane' }` without touching PostgreSQL.
- [ ] Run `corepack pnpm --filter @open-design/aurora-control-plane test`; confirm the workspace package does not exist.
- [ ] Add runtime dependencies with `pnpm add --save-exact`: `express@5.2.1`, `pg@8.23.0`, `stripe@22.6.0`, `openid-client@6.8.7`, `http-proxy@1.18.1`, `zod@3.25.76`, and `@open-design/contracts@workspace:*`.
- [ ] Add development dependencies with `pnpm add --save-dev --save-exact`: `@types/express@5.0.6`, `@types/http-proxy@1.17.17`, `@types/node@20.19.39`, `@types/pg@8.23.1`, `@types/supertest@7.2.1`, `@testcontainers/postgresql@12.1.0`, `supertest@7.2.2`, `tsx@4.22.3`, `typescript@5.9.3`, and `vitest@4.1.6`.
- [ ] Implement typed configuration parsing. Required production variables are PostgreSQL URL, public origin, OIDC issuer/client credentials, Stripe secret/webhook secret, plan catalog path, catalog upstream origin, session signing secret, and internal proxy secret.
- [ ] Make startup reject missing/invalid configuration before listening. Do not log secret values.
- [ ] Run smoke test and package typecheck; expect pass.
- [ ] Update root `AGENTS.md` and `apps/AGENTS.md` with ownership: commercial data and transparent routing only, never OpenDesign project data. Record the approved exception that Aurora commerce is a hosted-product surface rather than an OpenDesign creative capability, so it does not add a customer-facing `od` billing CLI; existing creative capabilities remain UI/CLI dual-track.
- [ ] Commit: `feat(aurora): scaffold commercial control plane`

## Task 2: Add Aurora browser/control-plane contracts

**Files:**
- Create: `packages/contracts/src/api/aurora.ts`
- Create: `packages/contracts/tests/aurora-contracts.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] Write Zod/parser tests for credit strings, plan catalog responses, session, wallet, ledger pagination, checkout requests, estimate requests, and structured API errors.
- [ ] Run the focused contracts test and confirm failure.
- [ ] Implement the DTOs with credit amounts as canonical unsigned decimal strings. Reject leading plus signs, decimals, exponents, negatives, whitespace, and values above PostgreSQL `BIGINT`.
- [ ] Export the new API module from contracts.
- [ ] Run contracts test and typecheck; expect pass.
- [ ] Commit: `feat(contracts): add Aurora commerce API`

## Task 3: Build forward-only PostgreSQL migrations

**Files:** DB and migration files listed above.

- [ ] Write migration tests against an isolated PostgreSQL database: fresh apply, second apply no-op, checksum mismatch rejection, unique idempotency constraints, and foreign-key cascade behavior.
- [ ] Run the focused migration test and confirm failure.
- [ ] Implement `schema_migrations(version, checksum, applied_at)` and apply SQL files in numeric order under one advisory lock.
- [ ] Add all tables and constraints from “Required Database Invariants”. Use `CHECK` constraints for closed statuses, buckets, intervals, currencies, and non-negative wallet columns.
- [ ] Make application startup run migrations before accepting traffic.
- [ ] Run migration tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add commercial database schema`

## Task 4: Implement OIDC Authorization Code + PKCE sessions

**Files:** auth files listed above.

- [ ] Write tests with a fake OIDC issuer for login redirect, PKCE/state/nonce validation, callback account upsert, opaque `HttpOnly; Secure; SameSite=Lax` cookie, session expiry, logout, and forged/expired state rejection.
- [ ] Add an Origin/Host test proving state-changing `/api/aurora/*` requests reject cross-origin form or fetch submissions.
- [ ] Run auth tests and confirm failure.
- [ ] Implement provider discovery at startup, authorization-code callback, account-to-tenant creation, random 32-byte session token, SHA-256 token storage, rotation after callback, and bounded last-seen renewal.
- [ ] Return only public account fields from `GET /api/aurora/session`; never return OIDC tokens.
- [ ] Run auth tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add OIDC account sessions`

## Task 5: Validate a server-owned plan catalog

**Files:**
- Create: `apps/aurora-control-plane/src/billing/catalog.ts`
- Create: `apps/aurora-control-plane/tests/billing/catalog.test.ts`
- Create: `apps/aurora-control-plane/tests/fixtures/plans.valid.json`

- [ ] Write tests requiring Creator/Pro/Studio, monthly/yearly entries, USD/SGD Stripe Price IDs, charge amount, recurring credit grant, concurrency, priority, optional promotion window, and one immutable `pricingVersion`.
- [ ] Assert duplicate Stripe Price IDs, missing intervals/currencies, negative amounts, client-supplied price overrides, and expired malformed promotions are rejected.
- [ ] Run the focused test and confirm failure.
- [ ] Implement startup-loaded immutable catalog snapshots. Production has no baked prices; tests load the committed fixture with deliberately non-production values.
- [ ] Add public `GET /api/aurora/plans` that omits Stripe secrets but returns display price, currency, grants, concurrency, priority, interval, discount and active promotion.
- [ ] Run catalog tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add server-owned subscription catalog`

## Task 6: Implement the immutable credit ledger

**Files:**
- Create: `apps/aurora-control-plane/src/billing/ledger.ts`
- Create: `apps/aurora-control-plane/tests/billing/ledger.test.ts`

- [ ] Write transaction tests for subscription grant, top-up grant, subscription-first reservation, mixed-bucket reservation, settlement, release, full refund, partial refund, duplicate idempotency key, insufficient balance, and ledger rebuild.
- [ ] Add concurrency tests issuing two reservations against one wallet and assert the second cannot overspend.
- [ ] Run ledger tests and confirm failure.
- [ ] Implement every operation under `SELECT ... FOR UPDATE`. Store signed deltas in ledger; use explicit reservation rows in `run_charges`; never update a ledger row.
- [ ] Expose `GET /api/aurora/wallet` and cursor-paginated `GET /api/aurora/ledger` for the authenticated tenant.
- [ ] Run ledger tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add transactional credit ledger`

## Task 7: Add Stripe checkout, portal and webhook handling

**Files:** Stripe files and tests listed above.

- [ ] Write tests for subscription checkout, top-up checkout, billing portal creation, webhook signature rejection, duplicate event replay, out-of-order subscription update, invoice-paid recurring grant, checkout completion, cancellation, and refund.
- [ ] Run webhook tests and confirm failure.
- [ ] Implement checkout routes that accept only catalog tier/interval/currency/top-up product IDs and derive Stripe Price IDs server-side.
- [ ] Put `tenantId`, `accountId`, catalog item and `pricingVersion` in Stripe metadata; validate all metadata again in the webhook.
- [ ] Insert `stripe_events` before applying side effects. Ignore an older subscription event when `event.created <= last_event_created`.
- [ ] Grant recurring credits idempotently using `stripe:invoice:<invoiceId>` and top-ups using `stripe:checkout:<sessionId>`.
- [ ] Run Stripe tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add Stripe subscriptions and topups`

## Task 8: Bind tenants to private OpenDesign instances

**Files:**
- Create: `apps/aurora-control-plane/src/tenants/routes.ts`
- Create: `apps/aurora-control-plane/src/tenants/service.ts`
- Create: `apps/aurora-control-plane/src/ops-cli.ts`
- Create: `apps/aurora-control-plane/tests/ops-cli.test.ts`
- Modify: `deploy/README.md`

- [ ] Write CLI tests for `tenant bind`, `tenant suspend`, `tenant show --json`, duplicate version conflict, public/credential-bearing URL rejection, unreachable upstream, non-Aurora health response, missing DSH, and secret-safe output.
- [ ] Run CLI tests and confirm failure.
- [ ] Implement an operator-only CLI backed directly by PostgreSQL. `tenant bind` accepts a tenant ID and a normalized private HTTPS origin; loopback HTTP is accepted only when `NODE_ENV=test`.
- [ ] Before committing a binding, call the private upstream's existing uncached `/api/health` and Agent catalog using the platform credential. Require `productProfile='aurora'` and an available `deepseek-harness`; reject OpenDesign-default, unavailable, ambiguous or non-DSH responses without writing `tenant_routes`.
- [ ] Require optimistic `--expected-version` for route replacement; never accept route mutation through the browser API.
- [ ] Update deployment documentation with invariants only: one route per isolated instance, private ingress, unique persistent storage, Aurora product profile, DSH installed, sandbox enabled, resource quotas, and egress allowlist. Link to the root Daemon data directory contract and do not include a concrete data-root path.
- [ ] Run CLI tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): add tenant route operations`

## Task 9: Build a streaming, tenant-safe OpenDesign proxy

**Files:** gateway files and proxy tests listed above.

- [ ] Start two fake OpenDesign upstreams and a public catalog upstream in tests. Assert each authenticated account reaches only its own upstream for `/api/*`, `/artifacts/*`, `/frames/*`, previews, downloads and SSE.
- [ ] Assert anonymous callers may access only the explicit public plan/session/catalog GET allowlist; Project, Conversation, files, previews and Run paths return 401.
- [ ] Assert inbound `x-aurora-*`, `forwarded`, `x-forwarded-*`, hop-by-hop headers, absolute-form URLs and websocket upgrades cannot influence routing.
- [ ] Run proxy tests and confirm failure.
- [ ] Implement `http-proxy` with a route resolved exclusively from the authenticated session. Disable proxy buffering, forward backpressure, preserve SSE event bytes/order/status, rewrite redirect origins to the public origin, and abort upstream when the client disconnects from non-detached reads.
- [ ] Add an internal HMAC request header for the tenant daemon and strip it from responses/logs. Keep tenant daemons on private ingress; this header is defense-in-depth, not the only boundary.
- [ ] Run proxy tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): proxy isolated OpenDesign tenants`

## Task 10: Reserve credits and create one OpenDesign Run

**Files:** Run estimator/charge/create files and tests listed above.

- [ ] Write estimator tests for the three launch skills plus an existing OpenDesign skill. Estimates must depend on server pricing version, bounded prompt/attachment size and declared skill policy, never a browser-supplied amount.
- [ ] Write create tests for success, insufficient balance, expired subscription with top-up balance, concurrency full, tenant suspended, DSH unavailable, upstream validation failure, network ambiguity, duplicate same request, and duplicate key with different body.
- [ ] Run focused tests and confirm failure.
- [ ] Require `Idempotency-Key` equal to the OpenDesign `clientRequestId`. Hash the canonical request body and reject key reuse with a different hash.
- [ ] Under one DB transaction, enforce plan concurrency, reserve subscription then top-up credits, create `run_charges(status='reserved')`, and commit before contacting OpenDesign.
- [ ] Force `agentId: 'deepseek-harness'` and forward the original OpenDesign body with the same `clientRequestId`. On a definite non-creation response, release all reservation. On network ambiguity, keep `status='create_unknown'` for reconciliation rather than sending a second logical request.
- [ ] Bind the returned OpenDesign `runId` in a transaction and persist the exact successful response for idempotent replay.
- [ ] Add authenticated `POST /api/aurora/run-estimate`; keep `POST /api/runs` response shape identical to OpenDesign.
- [ ] Run tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): reserve credits before OpenDesign runs`

## Task 11: Settle terminal Runs and reconcile uncertain states

**Files:**
- Create: `apps/aurora-control-plane/src/runs/reconciler.ts`
- Modify: `apps/aurora-control-plane/src/runs/charges.ts`
- Create: `apps/aurora-control-plane/tests/runs/reconciler.test.ts`

- [ ] Write tests for succeeded, failed before usage, failed after media usage, canceled, browser disconnected, create-unknown recovered by `clientRequestId`, duplicate terminal poll, malformed evidence, pricing-version mismatch, and upstream unavailable.
- [ ] Run reconciler tests and confirm failure.
- [ ] Poll non-terminal charges with `FOR UPDATE SKIP LOCKED`, bounded batches and exponential retry metadata. Resolve `create_unknown` by replaying the same OpenDesign request identity or querying the scoped Run list; never mint a new request ID.
- [ ] Price token and media evidence against the immutable `pricingVersion` captured at reservation. Insert one `run_usage_items` row per evidence idempotency key.
- [ ] Settle at `min(actual, reserve)`, release the remainder to the original buckets, and flag `budget_exceeded` if evidence would exceed the reservation; never create debt automatically.
- [ ] Mark malformed/incomplete evidence `manual_review` and preserve the reservation until an operator resolves it.
- [ ] Run reconciler tests and typecheck; expect pass.
- [ ] Commit: `feat(aurora): reconcile and settle run charges`

## Task 12: Package the control plane for independent deployment

**Files:**
- Create: `deploy/aurora-control-plane.Dockerfile`
- Create: `e2e/tests/aurora-control-plane-image.test.ts`
- Modify: `deploy/README.md`
- Modify: `docs/architecture.md`

- [ ] Write a failing cross-boundary test asserting the image builds only the control-plane app and contracts, starts as a non-root user, exposes one HTTP port, and probes `/healthz` without embedding credentials or daemon data paths.
- [ ] Run `corepack pnpm --filter @open-design/e2e test tests/aurora-control-plane-image.test.ts`; confirm failure because the Dockerfile does not exist.
- [ ] Add a multi-stage `deploy/aurora-control-plane.Dockerfile` with Corepack/pinned pnpm, production-only runtime output, non-root execution, `NODE_ENV=production`, and a `/healthz` health check. It must not bundle DSH, OpenDesign project data, Stripe/OIDC secrets, or an OpenDesign daemon.
- [ ] Extend `deploy/README.md` with image build/run variable names and topology invariants only. Link to the root daemon data contract for tenant instances; do not provide a concrete daemon data-root example.
- [ ] Update `docs/architecture.md` with the public gateway → commercial control plane → isolated tenant OpenDesign → DSH worker boundary and make clear that only the first two layers are in this image.
- [ ] Run the focused image test and build the image locally; expect pass.
- [ ] Commit: `build(aurora): package commercial control plane`

## Task 13: Add a dedicated Aurora CI workload

**Files:**
- Modify: `.github/config/scopes.json`
- Modify: `.github/config/convergence.json`
- Modify: `.github/scripts/scopes.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `e2e/tests/scripts/scopes.test.ts`
- Modify: `e2e/tests/packaged-smoke-workflow.test.ts`
- Modify: `specs/current/ci.md`

- [ ] Add failing planner goldens proving `apps/aurora-control-plane/**`, its image test, and `packages/contracts/**` enable `aurora_control_plane_tests`, while unrelated web-only source does not; mixed, unknown, lockfile, workspace manifest, forced-full and merge-queue cases must remain conservative.
- [ ] Add a failing workflow-topology test requiring the new job to appear in `Validate workspace.needs` and to run `corepack pnpm --filter @open-design/aurora-control-plane test` plus the focused image-contract test.
- [ ] Run `corepack pnpm --filter @open-design/e2e test tests/scripts/scopes.test.ts tests/packaged-smoke-workflow.test.ts`; confirm the new expectations fail.
- [ ] Add `aurora_control_plane_tests_required` to scope effects and a medium-confidence `aurora-control-plane-sources` rule. Add the effect to workspace manifest/lockfile routing; do not promote a `certain` omission in this MVP.
- [ ] Add `aurora_control_plane_tests` to `WORKLOADS` and `enabled_workloads()`. Create a `suite://aurora-control-plane` convergence input closure containing workspace install inputs, `apps/aurora-control-plane/`, `packages/contracts/`, the image test and Dockerfile; use the existing `workspace_unit` runner class and set `reusable: false`.
- [ ] Add the CI job with a 20-minute timeout. Run its PostgreSQL tests through Testcontainers, then run `e2e/tests/aurora-control-plane-image.test.ts`; add the job to the sole `Validate workspace` convergence gate.
- [ ] Update `specs/current/ci.md` with the new medium-confidence source unit, dedicated test set/workload, conservative full-plan fallback and non-reusable external-database boundary.
- [ ] Run `python3 .github/scripts/scopes.py validate`, the focused planner/topology tests, `python3 .github/scripts/convergence.py validate`, and `actionlint -color`; expect pass.
- [ ] Commit: `ci(aurora): gate control-plane tests`

## Task 14: Close the control-plane acceptance gate

**Files:** all files in this plan.

- [ ] Run all package tests against an isolated PostgreSQL database and fake OIDC/Stripe/OpenDesign servers; no real provider or payment account may be required.
- [ ] Run `corepack pnpm --filter @open-design/aurora-control-plane typecheck`, `corepack pnpm --filter @open-design/contracts typecheck`, `corepack pnpm typecheck`, and `corepack pnpm guard`.
- [ ] Run `git diff --check` and scan logs/fixtures for cookie values, OIDC tokens, Stripe secrets, provider keys, Project content and concrete daemon data-root examples.
- [ ] Execute the two-tenant proxy test with concurrent SSE streams and prove no cross-tenant event, file, redirect or preview URL leakage.
- [ ] Commit: `test(aurora): close commercial control plane acceptance`

## Completion Evidence

- A new account can authenticate, view the server-owned plan catalog, enter Stripe checkout, receive an idempotent credit grant and view its wallet/ledger.
- `POST /api/runs` cannot reach OpenDesign without authenticated tenant routing, positive balance, free concurrency and a successful reservation.
- Duplicate browser requests, Stripe events and Run terminal observations never double grant or double charge.
- SSE, files, previews and result packages retain OpenDesign response shapes while always routing by the authenticated tenant.
- A tenant route cannot become active until its private OpenDesign health proves the Aurora product profile and an available DSH runtime.
- The ledger can reconstruct wallet balances and the reconciler can converge every non-terminal `RunCharge` without browser participation.
