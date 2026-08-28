# Aurora Agent Web Product Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变默认 OpenDesign 行为的前提下，引入可显式启用的 Aurora 产品配置，强制所有创作 Run 使用 DSH，并为商业控制面提供可持久化、可重放、可幂等结算的 Run 用量证据。

**Architecture:** `OD_PRODUCT_PROFILE=aurora` 是单一产品开关。Daemon 在 Agent 目录、Run 创建和最终 Runtime 启动三个位置应用同一个纯函数策略；默认配置仍返回 OpenDesign 全量 Runtime。DSH 保留现有 stdio 协议和 `od media generate` 工具闭环，通过 Harness 的 `workspace-write` 文件沙箱与 `approval: never` 运行。Run 服务从持久化 Agent usage 事件和媒体任务证据构建终态 `usageEvidence`，不创建 Aurora 私有 Task API。

**Tech Stack:** Node.js 24、TypeScript 5.9、Express 5、SQLite、Vitest、DeepSeek Harness profile、OpenDesign contracts。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## Global Constraints

- 默认 `open-design` 配置的 Runtime 列表、设置页和 Run 选择行为必须保持不变。
- Aurora 只允许 `deepseek-harness`；请求显式指定其他 Agent、配置残留其他 Agent、自动化保存其他 Agent 都必须失败关闭，不能回退。
- 不删除其他 Runtime 源码，不改写 `AGENT_DEFS` 的上游定义。
- `OD_DATA_DIR` 仍是 Daemon 数据根唯一真相；不得新增或在文档中示例化第二个数据根。
- `usageEvidence` 只记录可计量事实，不包含零售价、余额或 Stripe 状态；商业价格由下一份计划的控制面计算。
- 媒体能力继续走现有 `od media generate`、Run 工具令牌、`/api/tools/media/generate` 和项目文件流程。
- DSH 工具可见性不是租户安全边界；Aurora Run 还必须经过 Linux Worker 封装，只挂载当前 Project、当前 Conversation 的 DSH 会话目录和只读运行依赖。托管部署同时给每个租户独立 OpenDesign 实例，并在集群层限制网络和资源。

---

## Exact File Map

### Create

- `packages/contracts/src/product-profile.ts` — 跨 Web/Daemon 的产品配置枚举和纯解析函数。
- `packages/contracts/tests/product-profile.test.ts` — 默认配置、Aurora 配置和非法值测试。
- `apps/daemon/src/product/runtime-policy.ts` — Aurora Runtime 允许列表、请求归一化和目录过滤。
- `apps/daemon/src/runtimes/aurora-dsh-worker.ts` — Linux bubblewrap Worker 调用构造、Project/Conversation 挂载和失败关闭。
- `apps/daemon/tests/product/runtime-policy.test.ts` — Runtime 策略单元测试。
- `apps/daemon/tests/runtimes/aurora-dsh-worker.test.ts` — Worker argv、挂载、环境清理和 bwrap 缺失测试。
- `apps/daemon/tests/run-usage-evidence.test.ts` — Agent usage 与媒体证据聚合、重启重放测试。
- `apps/daemon/tests/aurora-runtime-policy-routes.test.ts` — `/api/agents`、`POST /api/runs` 和底层启动闸门测试。

### Modify

- `packages/contracts/src/index.ts` — 导出产品配置契约。
- `packages/contracts/src/api/chat.ts` — 增加 `RunUsageEvidence` 和终态 `usageEvidence`。
- `packages/contracts/src/api/registry.ts` — 健康响应公开当前产品配置，供私网控制面验证租户实例。
- `packages/contracts/src/examples.ts` — 更新示例状态响应。
- `apps/daemon/src/routes/static-resource.ts` — Agent 列表按产品策略过滤。
- `apps/daemon/src/routes/runs.ts` — Run 创建前解析并固定 Aurora Agent。
- `apps/daemon/src/server.ts` — 在实际 `startChatRun` 前再次应用底层策略，并将策略传给路由。
- `apps/daemon/src/runtimes/runs.ts` — 聚合、持久化并返回 Run 用量证据。
- `apps/daemon/src/media/tasks.ts` — 持久化媒体任务的 `run_id` 和供应商请求摘要。
- `apps/daemon/src/media/task-store.ts` — 恢复媒体任务与 Run 的关联。
- `apps/daemon/src/routes/media.ts` — 媒体请求结束时登记幂等用量证据。
- `packages/dsh-runtime/cordis.patch.yml` — 固定 `workspace-write`、`approval: never` 并关闭权限切换 UI/工具。
- `packages/dsh-runtime/tests/protocol.test.ts` — 校验 DSH Aurora 安全配置。
- `apps/daemon/tests/media/tasks-persistence.test.ts` — 新字段迁移与重启恢复。
- `apps/daemon/tests/media/tasks-routes.test.ts` — 同一 `taskId` 只能登记一次用量。
- `apps/daemon/tests/agent-protocol/dsh-profile.test.ts` — DSH profile 与安全策略联测。
- `apps/daemon/tests/version-route.test.ts` — `/api/health` 产品配置证明。
- `e2e/tests/aurora-dsh-isolation.test.ts` — 两 Project/Conversation 文件与会话隔离测试。
- `apps/AGENTS.md` — 记录 opt-in Aurora 产品配置和 Runtime 边界，保持根文档只描述跨应用规则。

## Contract Shapes to Implement

```ts
// packages/contracts/src/product-profile.ts
export const PRODUCT_PROFILES = ['open-design', 'aurora'] as const;
export type ProductProfile = (typeof PRODUCT_PROFILES)[number];

export function parseProductProfile(value: string | undefined): ProductProfile {
  const normalized = value?.trim() || 'open-design';
  if (normalized === 'open-design' || normalized === 'aurora') return normalized;
  throw new RangeError(`Unsupported OD_PRODUCT_PROFILE: ${normalized}`);
}
```

```ts
// packages/contracts/src/api/chat.ts
export interface RunTokenUsageEvidence {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
}

export interface RunMediaUsageEvidence {
  idempotencyKey: string; // `media-task:<taskId>`
  taskId: string;
  surface: 'image' | 'video' | 'audio';
  model: string;
  providerId?: string;
  attemptCount: number;
  result: 'succeeded' | 'failed' | 'interrupted';
}

export interface RunUsageEvidence {
  schemaVersion: 1;
  complete: boolean;
  tokens: RunTokenUsageEvidence;
  media: RunMediaUsageEvidence[];
}
```

```ts
// apps/daemon/src/product/runtime-policy.ts
export const AURORA_AGENT_ID = 'deepseek-harness' as const;

export interface ProductRuntimePolicy {
  profile: ProductProfile;
  allowedAgentIds: ReadonlySet<string>;
  defaultAgentId: string | null;
}

export function runtimePolicyForProfile(profile: ProductProfile): ProductRuntimePolicy;
export function enforceRunAgent(
  policy: ProductRuntimePolicy,
  requestedAgentId: string | null,
): { ok: true; agentId: string } | {
  ok: false;
  code: 'AGENT_NOT_ALLOWED';
  message: string;
};
```

## Task 1: Add the product-profile contract

**Files:**
- Create: `packages/contracts/src/product-profile.ts`
- Create: `packages/contracts/tests/product-profile.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] Write tests proving an absent value selects `open-design`, `aurora` is accepted, whitespace is normalized, and every unknown value throws `RangeError`.
- [ ] Run `corepack pnpm --filter @open-design/contracts test -- product-profile.test.ts` and confirm failure because the module does not exist.
- [ ] Implement `PRODUCT_PROFILES`, `ProductProfile`, and `parseProductProfile` exactly as shown above; export them from `src/index.ts`.
- [ ] Run the focused test and `corepack pnpm --filter @open-design/contracts typecheck`; expect both to pass.
- [ ] Commit: `feat(contracts): add Aurora product profile`

## Task 2: Make one pure Runtime policy authoritative

**Files:**
- Create: `apps/daemon/src/product/runtime-policy.ts`
- Create: `apps/daemon/tests/product/runtime-policy.test.ts`

- [ ] Write tests for these cases: default profile preserves every supplied Agent; Aurora filters a mixed list to DSH; absent requested Agent becomes DSH; explicit `codex`, local profiles, and empty available lists fail with `AGENT_NOT_ALLOWED` or `AGENT_UNAVAILABLE` as appropriate.
- [ ] Run `corepack pnpm --filter @open-design/daemon test -- tests/product/runtime-policy.test.ts`; confirm module-not-found failure.
- [ ] Implement pure policy construction and filtering. Do not read `process.env` inside the pure functions; pass a parsed `ProductProfile` from composition roots.
- [ ] Add a separate `resolveProductRuntimePolicy(env)` helper that reads only `OD_PRODUCT_PROFILE` and delegates to the pure parser.
- [ ] Run the focused test and `corepack pnpm --filter @open-design/daemon typecheck`; expect pass.
- [ ] Commit: `feat(daemon): define Aurora DSH runtime policy`

## Task 3: Filter `/api/agents` without changing OpenDesign discovery

**Files:**
- Modify: `apps/daemon/src/routes/static-resource.ts`
- Modify: `apps/daemon/src/server.ts`
- Modify: `packages/contracts/src/api/registry.ts`
- Modify: `packages/contracts/src/examples.ts`
- Modify: `apps/daemon/tests/version-route.test.ts`
- Create: `apps/daemon/tests/aurora-runtime-policy-routes.test.ts`

- [ ] Add a route test whose injected detector returns DSH plus Codex. Assert normal profile returns both, while Aurora JSON and SSE forms return only DSH and still emit terminal `done`.
- [ ] Extend the health contract/test so uncached `GET /api/health` returns `productProfile: 'open-design' | 'aurora'`; assert the value comes from the same parsed bootstrap policy, not a second environment read.
- [ ] Run the focused test and confirm it fails because `RegisterStaticResourceRoutesDeps` has no Runtime policy.
- [ ] Add `runtimePolicy` and injected detector dependencies to the static-resource route context. Filter settled results after detection; do not mutate `AGENT_DEFS` or the detector cache.
- [ ] Parse the product profile once during Daemon bootstrap and pass the same immutable policy object to every route owner.
- [ ] Re-run the focused route test, `version-route.test.ts`, contracts tests and existing Agent stream tests; expect pass.
- [ ] Commit: `feat(daemon): expose only DSH in Aurora agent catalog`

## Task 4: Reject non-DSH Runs at both admission and launch

**Files:**
- Modify: `apps/daemon/src/routes/runs.ts`
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/tests/aurora-runtime-policy-routes.test.ts`

- [ ] Extend the route test to cover: omitted `agentId` is rewritten to DSH; explicit DSH succeeds; explicit Codex returns `409 AGENT_NOT_ALLOWED`; DSH unavailable returns `503 AGENT_UNAVAILABLE`; no fallback Run is created.
- [ ] Add a direct `startChatRun` test showing an internally-created or persisted Run carrying Codex fails before prompt persistence, memory extraction, media setup, or child spawn.
- [ ] Run the focused tests and confirm both new assertions fail.
- [ ] In `POST /api/runs`, resolve `effectiveAgentId` through `enforceRunAgent` immediately after existing conversation/project authority checks and before snapshot or Run creation side effects.
- [ ] In `startChatRun`, call the same policy before `getAgentDef`; this is the non-bypassable guard for Automations, Orbit, retry, and internal Run paths.
- [ ] Ensure the terminal error message names DSH unavailability and never says another Runtime was selected.
- [ ] Run the focused tests plus `corepack pnpm --filter @open-design/daemon test -- tests/run-create-workspace-gate.test.ts`; expect pass.
- [ ] Commit: `feat(daemon): enforce DSH-only Aurora runs`

## Task 5: Pin the DSH non-interactive sandbox profile

**Files:**
- Modify: `packages/dsh-runtime/cordis.patch.yml`
- Modify: `packages/dsh-runtime/tests/protocol.test.ts`
- Modify: `apps/daemon/tests/agent-protocol/dsh-profile.test.ts`

- [ ] Add manifest assertions that the OpenDesign profile replaces `sandbox-policy` with `workspace-write`, replaces `approval` with `never`, disables `permission`, disables subagent/goal/workflow/self-modifying tool rows, and keeps `tool-bash`, `tool-fs`, `tool-skill`, and media-wrapper access required by existing skills.
- [ ] Run `corepack pnpm --filter @open-design/dsh-runtime test`; confirm the new assertions fail.
- [ ] Update `cordis.patch.yml` with complete row replacements. Because Harness patches replace whole configs, copy the full required row configuration rather than assuming a merge.
- [ ] Set `DSH_PERMISSION_MODE=workspace-write` from the Aurora Daemon spawn environment; reject any deployment override that requests `danger-full-access` in Aurora profile.
- [ ] Extend the Daemon profile integration test to prove a denied write outside the session workspace cannot trigger an approval wait and returns a structured denial.
- [ ] Run DSH Runtime tests, the Daemon DSH profile test, and both package typechecks; expect pass.
- [ ] Commit: `security(dsh): pin Aurora workspace sandbox policy`

## Task 6: Confine every Aurora DSH Run to its Project and Conversation

**Files:**
- Create: `apps/daemon/src/runtimes/aurora-dsh-worker.ts`
- Create: `apps/daemon/tests/runtimes/aurora-dsh-worker.test.ts`
- Create: `e2e/tests/aurora-dsh-isolation.test.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] Write pure argv tests for a managed Project and Conversation. Assert the wrapper uses `bwrap`, unshares PID/IPC/UTS, installs `/proc`, a minimal `/dev`, and an ephemeral `/tmp`, then mounts only: system runtime directories read-only, the OpenDesign program/resource roots read-only, the checked DSH profile read-only, the current Project read-write, and the current Conversation DSH session directory read-write.
- [ ] Assert no parent of `RUNTIME_DATA_DIR`, no sibling Project, no sibling Conversation session, no host home and no global DSH credentials/settings file is mounted.
- [ ] Add rejection tests for non-Linux Aurora deployment, missing `bwrap`, imported-folder Project, unsafe IDs, missing profile, non-canonical/symlinked mount sources and a Project path outside `PROJECTS_DIR`.
- [ ] Run `corepack pnpm --filter @open-design/daemon test -- tests/runtimes/aurora-dsh-worker.test.ts`; confirm module-not-found failure.
- [ ] Implement `buildAuroraDshWorkerInvocation()` as a pure validator/argv builder plus a small filesystem preflight. Derive the writable session directory from the already-resolved `RUNTIME_DATA_DIR`, Project ID and Conversation ID; do not add another data-root environment variable.
- [ ] Present the DSH process with an ephemeral `DSH_HOME`: bind the checked OpenDesign profile at `profiles/open-design` read-only and bind only the current Conversation's session storage read-write. Provider authentication must arrive through run-scoped environment, not a mounted credentials document.
- [ ] Keep network namespace shared so `od media` can reach the tenant Daemon; rely on the tenant Pod's egress allowlist. Strip proxy variables not supplied by the platform and preserve only the Run-scoped tool token/daemon URL needed by existing wrappers.
- [ ] In `server.ts`, wrap the already-resolved DSH invocation immediately before `spawn()` only when the product policy is Aurora. If any preflight fails, end the Run with `DSH_SANDBOX_UNAVAILABLE`; never spawn the unwrapped command.
- [ ] Add an E2E test with two Projects and two Conversation session roots. From Project A, prove reads/writes to Project B and Conversation B are unavailable while Project A file writes, DSH resume and `od media generate` still work.
- [ ] Run the unit/E2E tests, Daemon typecheck and DSH profile tests; expect pass.
- [ ] Commit: `security(dsh): isolate Aurora project workers`

## Task 7: Define durable Run usage evidence

**Files:**
- Modify: `packages/contracts/src/api/chat.ts`
- Modify: `packages/contracts/src/examples.ts`
- Modify: `apps/daemon/src/runtimes/runs.ts`
- Create: `apps/daemon/tests/run-usage-evidence.test.ts`

- [ ] Write tests feeding duplicate/cumulative Agent `usage` events into a Run. Assert the aggregator sums distinct model messages, ignores duplicate frames, normalizes missing counters to zero, and marks evidence incomplete until terminal.
- [ ] Add a restart test that writes `state.json` and `events.jsonl`, hydrates the Run, and produces byte-equivalent `usageEvidence` from `GET` status data.
- [ ] Run the focused test and confirm `usageEvidence` is absent.
- [ ] Add the contract interfaces shown above. Implement a pure `buildRunUsageEvidence(events, mediaEvidence, complete)` helper in `runtimes/runs.ts`.
- [ ] Use stable event identity in this order: provider message/request ID when present, otherwise deterministic tuple `(provider, model, event id)`. Never deduplicate solely by token values.
- [ ] Include `usageEvidence` only on terminal status responses; set `complete` from durable terminal state and event-log completeness.
- [ ] Run contracts tests, focused Daemon test, and both typechecks; expect pass.
- [ ] Commit: `feat(runs): expose durable usage evidence`

## Task 8: Persist media-to-Run evidence and make it idempotent

**Files:**
- Modify: `apps/daemon/src/media/tasks.ts`
- Modify: `apps/daemon/src/media/task-store.ts`
- Modify: `apps/daemon/src/routes/media.ts`
- Modify: `apps/daemon/src/runtimes/runs.ts`
- Modify: `apps/daemon/tests/media/tasks-persistence.test.ts`
- Modify: `apps/daemon/tests/media/tasks-routes.test.ts`
- Modify: `apps/daemon/tests/run-usage-evidence.test.ts`

- [ ] Add migration tests starting from both a fresh database and the prior `media_tasks` schema. Assert nullable `run_id` and `provider_request_summary_json` columns are added without losing existing rows.
- [ ] Add route tests for successful, provider-failed, interrupted, and duplicated completion callbacks. The resulting Run must contain one `RunMediaUsageEvidence` per `taskId`.
- [ ] Run all three focused tests and confirm failures.
- [ ] Persist `runId` and the normalized provider request summary in `media_tasks`; restore them in `hydrateMediaTask`.
- [ ] Add `design.runs.recordMediaUsage(runId, evidence)` that upserts by `idempotencyKey`, persists state immediately, and never emits secret provider payloads to SSE.
- [ ] From `routes/media.ts`, record evidence after `onProviderRequestSettled` and terminal task classification. A failed request with no provider-attempt evidence contributes no chargeable media item.
- [ ] Make `statusBody` sort media evidence by `idempotencyKey` for deterministic reconciliation.
- [ ] Run the focused tests plus all `apps/daemon/tests/media/*.test.ts`; expect pass.
- [ ] Commit: `feat(media): persist billable run usage evidence`

## Task 9: Close regression and documentation gates

**Files:**
- Modify: `apps/AGENTS.md`

- [ ] Verify the design document still records approved status and that implementation links back to it without changing the approved decisions.
- [ ] Add a concise `apps/AGENTS.md` section stating that Aurora is opt-in, DSH-only, and must preserve default OpenDesign behavior. Point to the root Daemon data-directory contract instead of restating paths.
- [ ] Run `corepack pnpm --filter @open-design/contracts test`, `corepack pnpm --filter @open-design/dsh-runtime test`, and the focused Daemon suites from Tasks 2–8.
- [ ] Run `corepack pnpm --filter @open-design/contracts typecheck`, `corepack pnpm --filter @open-design/dsh-runtime typecheck`, `corepack pnpm --filter @open-design/daemon typecheck`, and `corepack pnpm guard`.
- [ ] Inspect `git diff --check` and confirm no files from the original Aurora repository were imported or referenced.
- [ ] Commit: `docs: record Aurora product foundation boundaries`

## Completion Evidence

- `GET /api/agents` under Aurora returns only `deepseek-harness` in JSON and SSE forms.
- `GET /api/health` reports the same bootstrap product profile that controls Runtime policy, allowing private deployment attestation.
- Every Run entry path reaches the same DSH-only guard; lower-level launch cannot be bypassed.
- DSH runs inside a fail-closed Linux Worker that cannot mount sibling Project/Conversation data, with workspace-write file confinement and no human approval path.
- Terminal Run status contains deterministic, restart-safe token and media usage evidence.
- Default OpenDesign tests prove its multi-Runtime behavior is unchanged.
- No new Task API, provider API, Project store, or second daemon data root exists.
