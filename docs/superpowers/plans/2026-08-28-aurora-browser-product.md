# Aurora Agent Web Browser Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 OpenDesign Web 中增加一个 opt-in 的 Aurora Agent Web 浏览器产品入口，让用户从统一技能目录选择任务、登录/购买/充值、进入现有 Project 工作区、通过 DSH 生成并继续修改、预览和下载。

**Architecture:** 默认 OpenDesign 继续渲染现有 `EntryShell/HomeView` 和 Runtime 设置；Aurora 构建通过 `NEXT_PUBLIC_OD_PRODUCT_PROFILE=aurora` 选择轻量的 `AuroraHomeView`，并隐藏 Runtime/BYOK/桌面产品控制。共享工作区、聊天、文件和预览不分叉。Aurora 商业状态全部来自 `/api/aurora/*`；`POST /api/runs` 仍使用现有 Web provider，但附加与 `clientRequestId` 相同的幂等请求头，并在发送前完成客户端体验闸门。服务端控制面仍是最终授权者。

**Tech Stack:** Next.js 16、React 18、TypeScript、CSS Modules、`@open-design/components`、OpenDesign Daemon provider/SSE、Vitest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## Global Constraints

- 本计划依赖前三份计划：产品底座、商业控制面、首发技能。
- 不恢复、复制或参考原 Aurora Agent Web 的页面、组件、样式、路由或 API 客户端。
- 默认 OpenDesign 页面、桌面构建、客户可见功能和所有现有技能必须保持不变。
- Aurora 对外只发布 Web；仓库现有 `od` CLI 与桌面源码保留，但 Aurora 页面不得宣传、下载或引导客户使用它们。
- 不增加 Task Center、第二套 Studio 或第二套 Project 页面。
- 新组件优先使用 `@open-design/components`；组件样式使用同目录 CSS Modules，不向 `apps/web/src/index.css` 添加声明。
- 未登录用户可以浏览技能与填写草稿；创建 Project/Run 前将草稿安全保存在当前浏览器会话并发起登录。
- 余额客户端状态只改善体验，不能替代控制面 `POST /api/runs` 的服务端预占。
- Aurora 页面不显示 Runtime、执行模式、BYOK、供应商密钥、媒体 Provider 或模型选择器。

---

## Exact File Map

### Create product identity and commerce client

- `apps/web/src/product/profile.ts`
- `apps/web/src/product/identity.ts`
- `apps/web/src/product/aurora/api.ts`
- `apps/web/src/product/aurora/state.ts`
- `apps/web/src/product/aurora/run-gate.ts`
- `apps/web/tests/product/profile.test.ts`
- `apps/web/tests/product/aurora-api.test.ts`
- `apps/web/tests/product/aurora-run-gate.test.ts`

### Create Aurora browser surfaces

- `apps/web/src/components/aurora/AuroraHomeView.tsx`
- `apps/web/src/components/aurora/AuroraHomeView.module.css`
- `apps/web/src/components/aurora/AuroraSkillCard.tsx`
- `apps/web/src/components/aurora/AuroraSkillCard.module.css`
- `apps/web/src/components/aurora/AuroraCommerceBar.tsx`
- `apps/web/src/components/aurora/AuroraCommerceBar.module.css`
- `apps/web/src/components/aurora/AuroraPlansDialog.tsx`
- `apps/web/src/components/aurora/AuroraPlansDialog.module.css`
- `apps/web/src/components/aurora/AuroraLedgerDrawer.tsx`
- `apps/web/src/components/aurora/AuroraLedgerDrawer.module.css`
- `apps/web/src/components/aurora/AuroraRunGateDialog.tsx`
- `apps/web/src/components/aurora/AuroraRunGateDialog.module.css`
- `apps/web/tests/components/aurora/AuroraHomeView.test.tsx`
- `apps/web/tests/components/aurora/AuroraPlansDialog.test.tsx`
- `apps/web/tests/components/aurora/AuroraRunGateDialog.test.tsx`

### Modify integration seams

- `apps/web/src/components/EntryView.tsx` — Aurora 首页分支，默认分支不动。
- `apps/web/src/components/ProjectView.tsx` — Aurora Run 体验闸门与商业状态入口。
- `apps/web/src/components/InlineModelSwitcher.tsx` — Aurora 不渲染。
- `apps/web/src/components/AvatarMenu.tsx` — Aurora 不渲染 Runtime/模型菜单。
- `apps/web/src/components/SettingsDialog.tsx` — Aurora 隐藏 Execution、BYOK 和 Provider 配置入口。
- `apps/web/src/providers/daemon.ts` — Aurora Run 添加幂等头并保留现有 SSE。
- `apps/web/src/App.tsx` — 加载 Aurora session/wallet 状态并把产品配置传入入口/工作区。
- `apps/web/app/layout.tsx` — 构建时产品标题与描述。
- `apps/web/next.config.ts` — 记录并校验公开产品配置，不改默认代理语义。
- `apps/web/tests/components/EntryView.aurora.test.tsx`
- `apps/web/tests/components/ProjectView.aurora-run-gate.test.tsx`
- `apps/web/tests/providers/daemon.aurora-idempotency.test.ts`
- `apps/web/tests/components/SettingsDialog.aurora.test.tsx`

### Create end-to-end acceptance

- `e2e/ui/aurora-product.test.ts`
- `e2e/specs/aurora/sale-to-result.spec.ts`
- `e2e/lib/aurora/fake-commerce.ts`
- `e2e/resources/aurora-launch-skills.json`

### Modify UI P0 suite registration

- `e2e/lib/playwright/suites.ts`
- `.github/config/scopes.json`
- `e2e/tests/packaged-smoke-workflow.test.ts`
- `specs/current/ci.md`

## Product Identity Contract

```ts
// apps/web/src/product/identity.ts
export interface ProductIdentity {
  profile: 'open-design' | 'aurora';
  name: string;
  shortName: string;
  browserOnly: boolean;
  showRuntimeControls: boolean;
  showByokControls: boolean;
}

export const OPEN_DESIGN_IDENTITY: ProductIdentity = {
  profile: 'open-design',
  name: 'OpenDesign',
  shortName: 'OpenDesign',
  browserOnly: false,
  showRuntimeControls: true,
  showByokControls: true,
};

export const AURORA_IDENTITY: ProductIdentity = {
  profile: 'aurora',
  name: 'Aurora Agent Web',
  shortName: 'Aurora',
  browserOnly: true,
  showRuntimeControls: false,
  showByokControls: false,
};
```

## Aurora Home Interaction Contract

The Aurora home is one calm page, not a dashboard grid:

1. Top bar: `Aurora Agent Web`, current credit balance, `套餐与充值`, account menu.
2. Hero: “今天想完成什么？” and one draft textarea.
3. First row: the three launch skills as result-oriented cards.
4. Below: all existing OpenDesign functional skills and design templates in one searchable catalog, with no separate Template product concept.
5. Selecting a skill changes the draft helper and one compact skill-specific form; submitting creates/reuses a Project and enters the existing workspace.

The form fields are fixed at launch:

- `poster`: theme, copy, aspect (`4:5`, `1:1`, `16:9`), optional files.
- `xhs-image`: topic, audience, optional exact location, optional files.
- `xhs-copy`: topic/material, audience, tone, optional files.
- Existing skills: one prompt and optional files, using the existing generic Project creation path.

## Task 1: Add a build-time product identity without changing default OpenDesign

**Files:** profile/identity files and tests listed above; `apps/web/next.config.ts`; `apps/web/app/layout.tsx`.

- [ ] Write tests proving absent build config selects `OPEN_DESIGN_IDENTITY`, `aurora` selects `AURORA_IDENTITY`, and an unknown value fails the build helper.
- [ ] Assert default title/description stay OpenDesign and Aurora title becomes `Aurora Agent Web`.
- [ ] Run `corepack pnpm --filter @open-design/web test -- tests/product/profile.test.ts`; confirm failure.
- [ ] Implement a pure parser that accepts an injected string. Keep the direct `process.env.NEXT_PUBLIC_OD_PRODUCT_PROFILE` read in one build-time module only.
- [ ] Update layout metadata through the shared identity. Do not perform a repository-wide string replacement.
- [ ] Run focused test, Web typecheck and one default Web build; expect pass.
- [ ] Commit: `feat(web): add Aurora product identity`

## Task 2: Add a typed Aurora commerce client and state owner

**Files:** Aurora API/state files and tests listed above.

- [ ] Write fetch tests for session, plans, wallet, ledger, estimate, checkout, top-up, portal and logout. Cover non-JSON errors, 401, 409, 402, abort and network failure.
- [ ] Run focused test and confirm failure.
- [ ] Implement functions using the contracts from `@open-design/contracts`; use `cache: 'no-store'`, same-origin credentials and `AbortSignal`.
- [ ] Implement one `useAuroraCommerce()` owner in `state.ts` with explicit `loading/authenticated/anonymous/error` states. Deduplicate concurrent wallet refreshes and clear private state on logout.
- [ ] Do not cache auth tokens or ledger contents in localStorage. Store only the pre-login creative draft in `sessionStorage` under a versioned Aurora key.
- [ ] Run API tests and typecheck; expect pass.
- [ ] Commit: `feat(web): add Aurora commerce client`

## Task 3: Build the simple Aurora home catalog

**Files:** Aurora home/card files and tests; `EntryView.tsx`.

- [ ] Write a component test with three Aurora launch entries plus two existing OpenDesign entries. Assert launch entries lead, all five remain visible, search covers both registries, and no Runtime/Studio/Task Center label appears.
- [ ] Test the three compact forms and generic form. Assert missing essential input shows one inline error without creating a Project.
- [ ] Test anonymous submit: draft is stored, login URL opens, and `onCreateProject` is not called. Test authenticated return: draft restores once and clears after successful Project creation.
- [ ] Run focused component test and confirm failure.
- [ ] Implement `AuroraHomeView` and `AuroraSkillCard` with `Button` and other existing shared primitives. Use semantic form controls and CSS Modules.
- [ ] In `EntryView`, branch on `ProductIdentity.profile`; keep the entire existing `EntryShell` invocation as the default branch.
- [ ] Convert each form to the existing `onCreateProject` input: exact `skillId`, generated `pendingPrompt`, `pendingFiles`, `autoSendFirstMessage: true`, and a client request ID.
- [ ] Render existing skills/templates without modifying their registry records or hiding legacy cards.
- [ ] Run component tests, the existing `EntryView` tests and Web typecheck; expect pass.
- [ ] Commit: `feat(web): add Aurora skill-first home`

## Task 4: Add plans, balance, checkout and ledger surfaces

**Files:** commerce bar/dialog/drawer files and tests listed above.

- [ ] Write tests for anonymous/sign-in state, zero balance, positive balance, Creator/Pro/Studio monthly/yearly toggle, active promotion, checkout pending/failure, top-up, portal, paginated ledger and logout.
- [ ] Assert plan cards render only server values and never construct a Stripe Price ID or numeric credit amount locally.
- [ ] Run focused component tests and confirm failure.
- [ ] Implement a compact `AuroraCommerceBar`; place plans in a dialog and ledger in a drawer so the home stays simple.
- [ ] Use server-returned checkout URLs only after validating same-origin or the configured Stripe Checkout host; reject arbitrary redirect URLs.
- [ ] Format credit decimal strings without converting the underlying amount to `number` before arithmetic. Formatting may use `BigInt` and locale grouping.
- [ ] Refresh session/wallet after checkout return and on window focus; do not poll continuously.
- [ ] Run component tests and typecheck; expect pass.
- [ ] Commit: `feat(web): add Aurora subscription surfaces`

## Task 5: Hide Runtime and BYOK controls only in Aurora

**Files:**
- Modify: `apps/web/src/components/InlineModelSwitcher.tsx`
- Modify: `apps/web/src/components/AvatarMenu.tsx`
- Modify: `apps/web/src/components/SettingsDialog.tsx`
- Create/modify: related Aurora tests listed above.

- [ ] Write tests rendering each component under both identities. Default OpenDesign must retain existing controls; Aurora must omit Runtime, mode, model, API/BYOK and media-provider credential controls.
- [ ] Run focused tests and confirm Aurora assertions fail.
- [ ] Add an explicit `identity` or `capabilities` prop rather than reading a hidden global inside leaf components. Return `null` for complete Runtime switchers in Aurora.
- [ ] Filter Settings navigation and deep-link handling. If an Aurora URL requests a hidden section, route to the first allowed section rather than flashing restricted content.
- [ ] Keep DSH identity visible only as non-interactive diagnostic copy where needed; do not render a picker.
- [ ] Run focused tests, existing Agent picker/settings tests and typecheck; expect pass.
- [ ] Commit: `feat(web): hide runtime configuration in Aurora`

## Task 6: Add the Aurora Run experience gate and idempotency header

**Files:** run-gate files/tests; `ProjectView.tsx`; `providers/daemon.ts`.

- [ ] Write pure gate tests for anonymous, wallet unavailable, zero balance, positive balance, estimate failure, stale wallet, and insufficient reserve. Anonymous/zero/insufficient are hard blocks; transient client fetch failure shows an error and does not claim the Run is authorized.
- [ ] Write provider tests proving Aurora sends `Idempotency-Key === clientRequestId`, retries reuse both values, and default OpenDesign request headers are unchanged.
- [ ] Run focused tests and confirm failure.
- [ ] Implement `checkAuroraRunGate` as a client experience preflight: refresh session/wallet, request a server estimate, and return a discriminated result. Never subtract credits client-side.
- [ ] Integrate before the existing Run dispatch in `ProjectView`; keep AMR-specific gating unchanged for default OpenDesign.
- [ ] Show estimated range and current balance in `AuroraRunGateDialog`. Allow “开始创作” only when authenticated and the server estimate fits the current wallet; offer login, plan or top-up otherwise.
- [ ] Pass the already-generated `clientRequestId` through the dialog and provider. Do not create a second ID after confirmation.
- [ ] Handle a final gateway 401/402/409 by refreshing commerce state and showing the server error; do not optimistically append a running task.
- [ ] Run focused tests, existing ProjectView run tests and Web typecheck; expect pass.
- [ ] Commit: `feat(web): gate Aurora runs with server estimates`

## Task 7: Preserve the existing Project workspace as the only Studio

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/ProjectView.tsx`
- Create: `apps/web/tests/components/ProjectView.aurora-run-gate.test.tsx`

- [ ] Add a component integration test that starts from an Aurora draft, creates a Project, receives Run SSE, writes an artifact, opens preview, sends a revision and downloads the result package.
- [ ] Assert the test uses the existing ProjectView/chat/files/preview components and no Aurora task/status store.
- [ ] Run the focused test and confirm missing commerce integration.
- [ ] Own Aurora commerce state once in `App.tsx`; pass it to Entry and Project surfaces. Do not duplicate session/wallet fetches in every card.
- [ ] Add the small Aurora commerce entry to the existing Project header without replacing chat, tabs, files, versions, preview or download behavior.
- [ ] On refresh/reconnect, recover through existing Project/Conversation/Run status; refresh wallet independently after a terminal Run.
- [ ] Run the integration test and typecheck; expect pass.
- [ ] Commit: `feat(web): connect Aurora commerce to Project workspace`

## Task 8: Add browser-level Aurora UI coverage

**Files:**
- Create: `e2e/ui/aurora-product.test.ts`
- Create: `e2e/resources/aurora-launch-skills.json`
- Modify: `e2e/lib/playwright/suites.ts`
- Modify: `.github/config/scopes.json`
- Modify: `e2e/tests/packaged-smoke-workflow.test.ts`
- Modify: `specs/current/ci.md`

- [ ] Use `test`/`expect` from `@/playwright/suite` and `applyStandardMocks` plus focused Aurora route mocks. Keep each case independently seeded.
- [ ] Add a failing topology assertion for one `aurora-product` UI P0 group, exactly one assignment of `ui/aurora-product.test.ts`, and a matching `ui_p0` matrix entry.
- [ ] Cover: catalog and search, each launch form, anonymous draft/login handoff, plan interval toggle, zero-balance block, positive-balance Run creation, hidden Runtime controls, and ledger opening.
- [ ] Add one browser witness for SSE-to-artifact-to-preview transition; leave lower-layer billing arithmetic to Vitest.
- [ ] Run `cd e2e && NEXT_PUBLIC_OD_PRODUCT_PROFILE=aurora corepack pnpm exec playwright test -c playwright.config.ts ui/aurora-product.test.ts --workers=1`; confirm failures before integration is complete.
- [ ] Register the file in `uiP0Groups`, `uiP0CoverageFiles`, `uiP0CiMatrix`, and `.github/config/scopes.json` under a dedicated single-worker `aurora-product` shard. The spec must restart its isolated `toolsDev` worker with `NEXT_PUBLIC_OD_PRODUCT_PROFILE=aurora`; it must not mutate the environment of another shard.
- [ ] Update `specs/current/ci.md` to record the seven applied UI P0 shards while leaving the four-shard runtime-definition shadow candidate unchanged.
- [ ] Fix only product code or deterministic test setup; do not serialize the suite or use force-clicks.
- [ ] Run `corepack pnpm --filter @open-design/e2e test tests/packaged-smoke-workflow.test.ts`, then re-run the UI file with `OD_PLAYWRIGHT_FULLY_PARALLEL=1` and both `--shard=1/2` and `--shard=2/2` to prove topology and split independence.
- [ ] Commit: `test(web): cover Aurora browser product`

## Task 9: Prove the sale-to-result system chain

**Files:**
- Create: `e2e/lib/aurora/fake-commerce.ts`
- Create: `e2e/specs/aurora/sale-to-result.spec.ts`

- [ ] Build hermetic fake OIDC and Stripe servers plus two fake tenant OpenDesign runtimes; PostgreSQL uses an isolated test database.
- [ ] Specify one end-to-end business flow: sign in → checkout webhook → recurring credit grant → select `poster` → estimate/reserve → DSH Run/SSE → media file → preview/result package → settle/release → ledger view.
- [ ] Add negative flows for duplicate checkout webhook, duplicate Run submission, browser disconnect, insufficient balance and cross-tenant file/SSE request.
- [ ] Run `cd e2e && corepack pnpm test specs/aurora/sale-to-result.spec.ts`; confirm failure before the complete chain exists.
- [ ] Connect only real application HTTP surfaces to the fakes. Do not update wallet rows or write Project artifacts directly from the test.
- [ ] Re-run and save a curated JSON report containing IDs/statuses/amount strings only; exclude cookies, prompts, file contents and secrets.
- [ ] Commit: `test(aurora): prove sale to result workflow`

## Task 10: Final product regression and release evidence

**Files:** all files in this plan.

- [ ] Run all new Web unit/component tests and the existing EntryView, HomeView, ProjectView, settings and provider-focused tests touched by the change.
- [ ] Run `corepack pnpm --filter @open-design/web typecheck` and `corepack pnpm --filter @open-design/web build` once with the default profile and once with Aurora profile.
- [ ] Run `python3 .github/scripts/scopes.py validate`, the Aurora Playwright file, the sale-to-result spec, `cd e2e && corepack pnpm typecheck`, and `corepack pnpm guard`.
- [ ] Capture PR screenshots showing the entry point in both default OpenDesign and Aurora, plus Aurora home, plan dialog, balance block and Project result. Use the repository's normal Playwright artifact path.
- [ ] Run `git diff --check`; verify no desktop release workflow, original Aurora code, second Project/Task store, raw global CSS selectors or client-side prices were added.
- [ ] Commit: `test(aurora): close browser SaaS acceptance`

## Completion Evidence

- Aurora 用户在浏览器内完成“选技能 → 登录/购买 → 创建 Project → DSH Run → 修改 → 预览 → 下载 → 查看扣费”的闭环。
- 页面只显示 Aurora Agent Web 品牌，不提供 Runtime/BYOK/桌面/客户 CLI 入口。
- 所有现有 OpenDesign 技能继续可见，Project 工作区仍是唯一创作工作区。
- 默认 OpenDesign 构建和测试证明其现有入口、Runtime 控制和商业界面没有被 Aurora 配置改变。
- 服务端预占仍是最终闸门；浏览器刷新、断线和重复点击不会重复创建或重复扣费。
