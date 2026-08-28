# Aurora Agent Web Launch Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `poster`、`xhs-image`、`xhs-copy` 重新实现为 OpenDesign 原生内容，保留全部现有成品技能，并通过现有 Project、DSH、媒体工具、文件、预览和结果包闭环交付。

**Architecture:** `poster` 与 `xhs-image` 是主要渲染视觉产物的形状，放在 `design-templates/`；`xhs-copy` 是对用户输入执行内容工作的功能技能，放在 `skills/`。三者只使用标准 `SKILL.md`、`example.html`、项目文件和现有 `od media generate`，不引入 `SkillRuntime`、Provider 路由或 Aurora Task 类型。外部 `skill-runtime.ts` 只提供已批准的名称、输入/输出和工作流语义。

**Tech Stack:** OpenDesign skill protocol、Markdown、HTML/SVG、现有 `od media generate` CLI、Daemon skill/design-template scanners、Vitest、DSH fake runtime、E2E Vitest。

**Spec:** `docs/superpowers/specs/2026-08-28-aurora-agent-web-opendesign-dsh-saas-design.md`

## Global Constraints

- 不复制、导入、执行或运行时读取 `/Users/lirichen/Work/apexai/aurora-ai-agents` 的任何代码。
- 外部 `credits`、provider 顺序、环境变量和 `routeSkill` 不进入新实现；费用由商业控制面的版本化定价表决定。
- 不重命名、不覆盖、不隐藏现有 `image-poster`、`social-carousel`、`ecommerce-image-workflow` 或其他 OpenDesign 技能。
- 三个新 ID 必须精确为 `poster`、`xhs-image`、`xhs-copy`。
- 图片生成只能通过 `"$OD_NODE_BIN" "$OD_BIN" media generate`；禁止直接调用供应商 API。
- 每个技能必须写明输入缺失时的最少澄清、工具上限、完成条件、输出文件、失败行为和事实/安全检查。
- 首发默认不依赖 BYOK，不将供应商名称或密钥写入技能内容。
- 生成文本不得伪造地点、功效、认证、价格、用户评价或平台保证；用户未提供的事实必须省略或明确标为待确认。

---

## Exact File Map

### Create

- `design-templates/poster/SKILL.md`
- `design-templates/poster/example.html`
- `design-templates/poster/references/acceptance.md`
- `design-templates/xhs-image/SKILL.md`
- `design-templates/xhs-image/example.html`
- `design-templates/xhs-image/references/acceptance.md`
- `skills/xhs-copy/SKILL.md`
- `skills/xhs-copy/references/policy-checklist.md`
- `apps/daemon/tests/aurora-launch-skills.test.ts`
- `e2e/specs/aurora/launch-skills.spec.ts`

## Output Contracts

### `poster`

默认产物：

- `poster-background.<png|jpg|webp>` — 通过 OpenDesign 媒体工具生成的可选背景；
- `poster.svg` — 独立可预览的成品海报，中文文案由 SVG 文本层排版；
- `poster-manifest.json` — 主题、画布、文案、素材文件、生成次数和 QA 结果。

### `xhs-image`

默认产物：

- `xhs-01-cover.svg`；
- `xhs-02-point-1.svg` 至 `xhs-05-point-4.svg`；
- `xhs-gallery.html` — 只负责项目内预览五张卡，不是第二套 Studio；
- `xhs-manifest.json` — 标题、四个重点、素材来源、地点事实和 QA 结果。

### `xhs-copy`

默认产物：

- `xhs-copy.md` — 可直接复制的标题、正文和话题标签；
- `xhs-copy.json` — 结构化 `title/body/tags/audience/claimsToVerify`。

`poster.svg` 和五张小红书 SVG 使用真实文字层，避免把中文交给图片模型渲染。媒体模型只生成不含关键文字的背景/素材。

## Standard Frontmatter Shapes

```yaml
# design-templates/poster/SKILL.md
---
name: poster
zh_name: 海报制作
description: 根据主题、尺寸、文案和可选参考图制作一张文字可校对的成品海报。
triggers: [poster, 海报, 活动海报, 宣传海报]
od:
  mode: image
  surface: image
  category: marketing-creative
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: 为周末独立咖啡市集制作一张 4:5 中文活动海报。
---
```

```yaml
# skills/xhs-copy/SKILL.md
---
name: xhs-copy
zh_name: 小红书文案
description: 基于真实信息撰写 20 字以内标题、正文和话题标签，并列出待核实表达。
triggers: [小红书文案, 种草文案, 笔记文案, xhs copy]
od:
  mode: utility
  category: marketing-creative
  scenario: marketing
  design_system:
    requires: false
  example_prompt: 为一家新开的社区咖啡馆写一篇克制、真实的小红书探店文案。
---
```

## Task 1: Pin catalog ownership and non-dependency rules

**Files:**
- Create: `apps/daemon/tests/aurora-launch-skills.test.ts`

- [ ] Write a failing catalog test that expects `poster` and `xhs-image` only in `listAllDesignTemplates`, `xhs-copy` only in `listSkills`, and all three in the combined skill-like catalog.
- [ ] Assert existing `image-poster`, `social-carousel`, and `ecommerce-image-workflow` remain present and their source folders are unchanged.
- [ ] Add a source scan assertion rejecting `aurora-ai-agents`, `skill-runtime.ts`, `SkillRuntime`, `routeSkill`, `providerEnvironment`, and the original provider-environment variable names inside the three new folders.
- [ ] Run `corepack pnpm --filter @open-design/daemon test -- tests/aurora-launch-skills.test.ts`; confirm missing-catalog failure.
- [ ] Commit only the red test: `test(skills): specify Aurora launch catalog`

## Task 2: Implement the `poster` design template

**Files:**
- Create: `design-templates/poster/SKILL.md`
- Create: `design-templates/poster/example.html`
- Create: `design-templates/poster/references/acceptance.md`
- Modify: `apps/daemon/tests/aurora-launch-skills.test.ts`

- [ ] Extend the test to parse frontmatter and assert `od.mode=image`, preview entry exists, output contract names `poster.svg`, and the workflow contains the existing OD media wrapper rather than a provider API.
- [ ] Add content assertions for these workflow stages: collect theme/size, normalize supplied copy, generate optional text-free background, compose SVG, check Chinese text/safe area/contrast, write manifest.
- [ ] Run the focused test and confirm failure.
- [ ] Write `SKILL.md` with one safe default: when no size is supplied use 4:5; ask only when required copy or an exact print dimension changes the deliverable materially.
- [ ] Limit default media generation to one background and one explicit QA retry. The retry must name the failed visual criterion; no blind variants.
- [ ] Require SVG viewBox, embedded/relative project asset references, real text nodes, minimum safe-area margin, contrast check, no invented sponsor/logo/date/location, and deterministic file names.
- [ ] Create an `example.html` that visually demonstrates the product card without external network resources and includes meaningful alt/accessible text.
- [ ] Put the machine-checkable acceptance list in `references/acceptance.md`; link it from the skill.
- [ ] Run focused Daemon test and `corepack pnpm --filter @open-design/daemon typecheck`; expect pass.
- [ ] Commit: `feat(skills): add native poster template`

## Task 3: Implement the `xhs-image` design template

**Files:**
- Create: `design-templates/xhs-image/SKILL.md`
- Create: `design-templates/xhs-image/example.html`
- Create: `design-templates/xhs-image/references/acceptance.md`
- Modify: `apps/daemon/tests/aurora-launch-skills.test.ts`

- [ ] Extend the catalog test to assert the five-card output contract, `xhs-gallery.html`, manifest, four information points, and fact-safe location handling.
- [ ] Assert the skill permits no more than four media calls by default and requires every generated material to omit critical in-image text.
- [ ] Run the focused test and confirm failure.
- [ ] Write `SKILL.md` with this exact sequence: identify audience/topic → title ≤20 Chinese characters → four non-overlapping points → select supplied or generated material → compose cover + four SVG cards → verify text/location/safe areas → write gallery/manifest.
- [ ] Require user-supplied locations/addresses to be copied exactly. If a location is absent, omit it rather than inventing one.
- [ ] Make every card 3:4 by default, use a coherent scrapbook system, and preserve a shared color/type/token section across all five SVGs.
- [ ] Make `xhs-gallery.html` load only the five project-relative SVGs, support keyboard previous/next, and expose all cards in print/no-script fallback.
- [ ] Create a self-contained `example.html` using baked HTML/CSS/SVG only.
- [ ] Run focused test and typecheck; expect pass.
- [ ] Commit: `feat(skills): add native Xiaohongshu image template`

## Task 4: Implement the `xhs-copy` functional skill

**Files:**
- Create: `skills/xhs-copy/SKILL.md`
- Create: `skills/xhs-copy/references/policy-checklist.md`
- Modify: `apps/daemon/tests/aurora-launch-skills.test.ts`

- [ ] Extend the test to assert `od.mode=utility`, title length rule, required Markdown/JSON outputs, `claimsToVerify`, and zero media-generation commands.
- [ ] Run the focused test and confirm failure.
- [ ] Write the workflow: confirm audience only when material does not imply it → extract only supported facts → create a ≤20-character title → write skimmable body → run policy/claim QA → append focused tags → save both outputs.
- [ ] Define `xhs-copy.json` precisely:

```json
{
  "title": "不超过20个中文字符的标题",
  "body": "正文",
  "tags": ["话题一", "话题二"],
  "audience": "目标受众或未指定",
  "claimsToVerify": []
}
```

- [ ] Put prohibited behavior in the checklist: absolute efficacy, fake first-person experience, fabricated scarcity/price/review/ranking, medical/financial guarantees, undisclosed sponsored claim, keyword stuffing and unsupported location facts.
- [ ] Require the final assistant response to name both written files and summarize any `claimsToVerify`; do not only paste chat text.
- [ ] Run focused test and typecheck; expect pass.
- [ ] Commit: `feat(skills): add native Xiaohongshu copy skill`

## Task 5: Prove all three skills operate through DSH and existing tools

**Files:**
- Create: `e2e/specs/aurora/launch-skills.spec.ts`
- Modify: `e2e/lib/fake-agents.ts` only if its existing DSH fixture cannot emit file/media tool behavior; keep the helper generic.

- [ ] Add a pure-inspect E2E smoke using an isolated tools-dev namespace, fake DSH executable and fake media provider. Do not use Playwright or real provider keys.
- [ ] For `poster`, create Project/Conversation, start a DSH Run with `skillId=poster`, observe one media tool dispatch, and assert `poster.svg` plus manifest appear in the result package.
- [ ] For `xhs-image`, assert five SVGs, gallery and manifest; verify a supplied location survives byte-for-byte and no absent location is invented.
- [ ] For `xhs-copy`, assert no media request occurs, title length is within contract, both output files are present, and result package includes them.
- [ ] Assert every Run status reports `agentId=deepseek-harness`; a request attempting another Agent fails and produces no files.
- [ ] Run `cd e2e && corepack pnpm test specs/aurora/launch-skills.spec.ts`; confirm failure before fixture behavior is added.
- [ ] Add the smallest fake DSH/media behavior needed to exercise existing HTTP, SSE, CLI wrapper and file paths; do not bypass them with direct fixture file writes from the test process.
- [ ] Re-run the E2E spec; expect pass.
- [ ] Commit: `test(skills): verify Aurora launch workflows on DSH`

## Task 6: Run skill protocol and preservation gates

**Files:** all files in this plan.

- [ ] Run `corepack pnpm --filter @open-design/daemon test -- tests/aurora-launch-skills.test.ts tests/skills.test.ts tests/skills-workspace-scope.test.ts`.
- [ ] Run `cd e2e && corepack pnpm test tests/collab/workspace-skill-resource-isolation.test.ts specs/aurora/launch-skills.spec.ts`.
- [ ] Run `corepack pnpm --filter @open-design/daemon typecheck`, `cd e2e && corepack pnpm typecheck`, and `corepack pnpm guard`.
- [ ] Open all three baked examples through the existing example route and perform one browser screenshot check at desktop and narrow widths; store only normal repository-approved E2E evidence, not generated local scratch.
- [ ] Run `git diff --check` and verify no existing skill/template file was removed or hidden.
- [ ] Commit: `test(skills): close Aurora launch skill acceptance`

## Completion Evidence

- 三个新 ID 在正确的 OpenDesign registry 出现，同时所有原有成品技能仍可见。
- Poster 和小红书图片使用可校对的真实文字层与现有媒体工具，结果进入 Project 文件/预览/结果包。
- 小红书文案输出 Markdown 与结构化 JSON，并明确列出待核实表达。
- 三个工作流均由 DSH 执行，没有原 Aurora 代码、Provider 路由、平行任务模型或 BYOK 依赖。
