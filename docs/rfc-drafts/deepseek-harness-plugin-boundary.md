# RFC: OpenDesign and DeepSeek Harness plugin boundary

**Status:** Draft (architecture assessment; no behavior ships with this document)
**Source snapshot:** OpenDesign `0dc31fef636c0f3e0e388a5e4d191d94a725e011`; DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

English | [简体中文](./deepseek-harness-plugin-boundary.zh-CN.md)

## Summary

OpenDesign can move more agent-facing behavior into DeepSeek Harness (DSH) plugins, but the complete product should not become one DSH plugin. OpenDesign should remain the product control plane and source of truth for projects, artifacts, installed content, trust, permissions, credentials, durable workflows, and Studio state. DSH should remain the agent execution plane for model calls, tools, sessions, context compaction, sandbox execution, subagents, and foreground workflows.

This is an extension of the existing integration, not a new runtime choice. OpenDesign already ships `@open-design/dsh-runtime`, installs it as an `open-design` DSH profile bundle, and starts one short-lived `dsh --profile open-design --stdio` process for each run. The recommended work is to evolve that bundle into a small family of capability plugins while keeping the daemon API as the only product-state interface.

## Problem

OpenDesign is a complete design-agent product. Its [architecture](../architecture.md) includes browser and Electron clients, an Express daemon, SQLite-backed project and conversation state, content registries, plugin installation and trust, preview and export services, GenUI persistence, and agent runtime adapters. Wrapping all of those responsibilities in one Cordis plugin would change the module container without reducing the product's state, security, or lifecycle complexity.

OpenDesign also has reusable agent-facing behavior: skills, design-system context, craft guidance, model and tool execution, artifact delivery, and runtime event projection. These responsibilities fit DSH extension points, but an [OpenDesign plugin](../plugins-spec.md) and a Cordis plugin are different artifacts. An OpenDesign plugin is primarily a portable `SKILL.md` plus an optional `open-design.json` manifest and content directories. A Cordis plugin is executable code that registers services, tools, events, and lifecycle effects.

The integration needs an explicit owner for each state transition. Without that split, OpenDesign and DSH can both appear authoritative for project state, permissions, workflow progress, credentials, or model-visible context, which makes retries and cold resume ambiguous.

## Existing DSH integration

The [`@open-design/dsh-runtime`](../../packages/dsh-runtime/README.md) package is already a real DSH bundle. Its [`cordis.patch.yml`](../../packages/dsh-runtime/cordis.patch.yml) adds the OpenDesign startup and protocol plugins to the user's profile while leaving credentials, settings, tools, sessions, and model providers under the user's DSH composition.

The daemon's [`deepseek-harness` runtime definition](../../apps/daemon/src/runtimes/defs/deepseek-harness.ts) starts `dsh --profile open-design --stdio`. The [DSH profile session adapter](../../apps/daemon/src/agent-protocol/dsh-profile/session.ts) sends the prompt, working directory, model selection, reasoning selection, and resume identity, then projects DSH JSONL messages into the shared OpenDesign agent event stream. The runtime plugin creates or resumes a DSH session and emits text, reasoning, tool, usage, cancellation, and terminal results.

The bridge is therefore a DSH runtime adapter and bundle, not a conversion of OpenDesign into a plugin. One concrete gap remains in the inspected source: the daemon sends an empty `mcp_servers` list to the profile. Plugin-declared OpenDesign MCP configuration does not yet participate in DSH runtime composition.

## Recommendation

### Ownership

OpenDesign remains the product control plane and source of truth. It owns users, projects, conversations, installed content, plugin trust and capability grants, OAuth records, immutable applied-plugin snapshots, artifact metadata and versions, preview and export state, durable pipeline progress, and security decisions involving paths, network destinations, credentials, or user-selected folders.

DSH remains the agent execution plane. It owns agent construction, model calls, model-facing tools, session events, context compaction, shell and filesystem providers, sandbox execution, subagents, foreground workflows, and runtime telemetry. Any OpenDesign input that reaches a model request must first become reconstructable DSH session state.

The OpenDesign web, Electron, and CLI clients continue to call the daemon rather than a DSH web host. The daemon authenticates the request, resolves immutable content and permission inputs, starts DSH, and projects DSH events back into the OpenDesign protocol.

| OpenDesign owns | DSH plugins own |
| --- | --- |
| Project, conversation, and artifact records | Agent, model, tool, and session execution |
| Marketplace installation and plugin trust | Skill discovery and model-facing skill loading |
| Capability grants and credential references | Enforcement of the resolved per-run tool policy |
| Applied-plugin snapshots and design catalogs | Logged prompt and pre-step context derived from a snapshot |
| Durable pipeline and devloop state | Foreground subagent and workflow execution |
| Studio, preview, GenUI persistence, and export | Tool presentation metadata and produced-file locations |
| OAuth tokens, path policy, SSRF policy, and audit | Provider calls allowed by product-issued run authority |

### Plugin family

OpenDesign should evolve the existing bundle into a small plugin family rather than let one plugin import daemon internals:

| Role | Responsibility |
| --- | --- |
| OpenDesign Service Definition | Defines branded project, catalog-snapshot, artifact, and run-authority identities plus provider-neutral requests and results |
| OpenDesign daemon Service Provider | Calls an authenticated local HTTP or stdio interface and never opens the OpenDesign SQLite database directly |
| OpenDesign tool Consumer | Registers project, catalog, artifact, preview, and export tools over the Service Definition |
| OpenDesign context Consumer | Resolves one immutable applied-plugin snapshot and contributes its skills, design-system instructions, craft guidance, and references to logged model context |
| OpenDesign policy Consumer | Maps product-issued run authority to DSH tool, filesystem, shell, MCP, network, and approval availability without widening grants |
| OpenDesign event projector | Converts DSH session and runtime events to OpenDesign SSE or AG-UI while preserving the DSH session identity used for cold resume |
| OpenDesign Bundle | Composes the provider, consumers, runtime adapter, and user-selected DSH providers under the `open-design` profile |

The Service Definition, Service Provider, and Consumer roles form complete capability seams. They may share packages initially, but their public types must not import OpenDesign persistence classes, Next.js components, or Electron APIs. OpenDesign should own their names and release cadence because the plugins adapt its product protocol.

### Content mapping

OpenDesign `SKILL.md` bodies can enter DSH through the provider-neutral [`ctx.skills`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/skill/skill/README.md) registry. An OpenDesign skill provider should preserve invocation policy and expose only content selected by an applied-plugin snapshot, rather than every installed skill visible to the daemon.

`open-design.json`, design systems, templates, craft, assets, pipelines, and GenUI declarations need explicit adapters. Prompt and reference content becomes logged DSH context. MCP declarations become resolved provider configuration only after OpenDesign trust and capability evaluation. Pipeline declarations remain durable OpenDesign state and may invoke DSH foreground workflows as individual attempts. GenUI declarations remain OpenDesign UI state rather than executable Host or Client Cordis code.

Artifact tools should return stable OpenDesign artifact identities and declare render intent and `locations`. Files may still be written into the project working directory, but artifact registration, version selection, preview readiness, and export completion remain daemon operations rather than facts inferred from a DSH session.

## Runtime sequence

1. The OpenDesign daemon authenticates the user and resolves the project, runtime, applied-plugin snapshot, capability grants, model selection, and resume identity.
2. The daemon starts or connects to the OpenDesign DSH Bundle and sends opaque product identities plus the immutable snapshot identity. OAuth secrets never enter model-visible context.
3. The provider fetches the authorized snapshot and project capabilities from the daemon. The context Consumer appends every model-visible instruction and reference to the DSH session log.
4. The agent invokes OpenDesign tools through the provider-neutral Service Definition. The daemon revalidates run authority before changing product state.
5. DSH records model, tool, usage, and terminal events. The event projector translates them for OpenDesign without creating a second authoritative execution record.
6. The daemon persists product outcomes and links OpenDesign attempts, artifacts, and conversations to the DSH session identity used for later cold resume.

## Delivery sequence

### 1. Complete the existing bridge

Carry resolved MCP configuration instead of an always-empty list and prove that one OpenDesign run still maps to one cold-resumable DSH session. This increment does not change product ownership.

### 2. Add catalog and context providers

Add a read-only catalog and applied-plugin snapshot provider plus a context Consumer. Prove that selected `SKILL.md`, design-system, craft, and reference content is visible to the model and reconstructable from the DSH session log.

### 3. Add project and artifact tools

Expose project and artifact operations through the daemon API with explicit render intent and produced-file locations. OpenDesign remains responsible for preview, artifact versions, and export state.

### 4. Map policy and MCP providers

Map OpenDesign capability grants and approvals to DSH tool availability and MCP providers. Missing or stale run authority must fail before an external effect, and a DSH plugin cannot grant itself more authority than the daemon issued.

### 5. Re-evaluate durable orchestration later

Keep durable pipeline scheduling in OpenDesign until DSH has a durable jobs provider and resumable workflow execution. At the inspected DSH revision, [`jobs-local`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/jobs/jobs-local/README.md) records die with the process and the [workflow engine](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/workflow/workflow/README.md) has no journaling or resume.

Rich interactions also remain in OpenDesign because [`ctx.userQuestions`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/interaction/user-questions/README.md) currently covers options and custom text rather than file pickers, diff previews, OAuth, or persistent GenUI surfaces. [`ctx.storageDomain`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/storage/storage-domain/README.md) has single-process change visibility and no cross-table transactions or secondary indexes, so it does not replace OpenDesign's relational product state.

## Alternatives considered

### Convert all of OpenDesign into one DSH plugin

This gives neither process a clear state boundary and requires DSH process-local jobs, foreground workflows, basic questions, and domain storage to replace durable product services they do not currently implement.

### Keep only the existing JSONL bridge

This avoids new packages but leaves OpenDesign skills, MCP declarations, immutable plugin snapshots, and capability grants outside native DSH extension points. Prompt staging remains duplicated, and the model cannot access OpenDesign capabilities through provider-neutral services.

### Build a separate DSH-native OpenDesign client

A lightweight DSH client could present chat and produced files, but reproducing the Studio, marketplace, preview sandbox, GenUI persistence, project history, and export experience would create a second product. Such a client may become a narrower interface later; it is not the migration target.

### Let DSH plugins read OpenDesign SQLite directly

Direct database access couples plugins to private schemas, bypasses daemon authorization and audit, and creates competing writers. The daemon API remains the only product-state interface.

## Acceptance criteria

- The OpenDesign daemon remains the sole writer of project, plugin, permission, credential, artifact, GenUI, and durable pipeline state.
- One OpenDesign run has one DSH session identity that survives the short-lived runtime process and is stored with the product attempt.
- Every OpenDesign instruction, skill, reference, and design context sent to a model is reconstructable from DSH session events.
- DSH tools use a provider-neutral OpenDesign service and never import or open the daemon's SQLite implementation.
- OpenDesign run authority is opaque, scoped, revalidated by the daemon, and cannot be widened by a Cordis plugin.
- Trusted and authorized plugin-declared MCP configuration reaches the DSH profile; untrusted or unauthorized declarations fail before provider startup.
- Artifact tools declare render intent and locations while artifact identity, version, preview, and export state remain daemon-owned.
- Durable OpenDesign work does not depend on process-local jobs, non-resumable workflow runs, or single-process storage notifications.
- Provider and policy failures have unit coverage; a runnable example exercises the assembled profile; keyless snapshots cover model-visible context and tool results.
- The OpenDesign runtime protocol documents versioning, cancellation, cold resume, terminal status, and failure ownership before another process topology is introduced.

## Risks

- **Two event streams can drift.** DSH owns execution history while OpenDesign owns product history. Stable run, attempt, session, tool-call, and artifact identities must correlate them without treating the projection as a second source of truth.
- **Context can be logged too late.** Fetching OpenDesign content outside the session-event path would violate replay and resume guarantees even when the first model request succeeds.
- **Permission translation can widen authority.** Defaults, missing capability names, or provider-specific options must fail closed instead of enabling a broader DSH tool or MCP provider.
- **Short-lived processes constrain background work.** A runtime process may exit after a foreground result, so OpenDesign must retain durable scheduling and external provider job identities.
- **Adapter growth can duplicate the daemon.** Service methods must expose product operations rather than reproduce persistence, policy, preview, marketplace, or OAuth logic inside DSH plugins.
- **The protocol can change independently.** The bundle and daemon need explicit compatible protocol versions and fail-loud negotiation because OpenDesign and DSH release separately.
