# OpenDesign EC2 agent image delivery

This directory defines the reproducible ARM64 image that derives from the immutable OpenDesign 0.21.1 base and adds the locked OpenCode and pi CLIs. Image delivery is intentionally separate from production deployment.

## Fixed image identity

The r2 image adds a deployment-local, fail-closed patch for the pinned 0.21.1
compiled server: POST `/api/runs` accepts at most 20 MiB, while the global JSON
parser stays at 4 MiB. nginx must enforce `client_max_body_size 20m` on the exact
run endpoint. The shared AWS WAF exception is managed in the Apex AI edge module;
its ALB inspection window is not increased by this application limit.
Verify the patch with `node --test deploy/tests/aws-ec2-run-body-limit.test.ts`.

`app.env` is the checked-in, non-secret source of truth. The human-readable ECR tag is:

```text
389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:od-0.21.1-opencode-1.18.29-pi-0.85.1-r2
```

The tag is immutable and identifies one build recipe. After a successful push, `build-push.sh` resolves the registry digest. Runtime deployment must use the content identity:

```text
389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign@sha256:<resolved-digest>
```

In other words, the tag is the readable release identity and `repo@sha256` is the deployable identity. Never overwrite or reuse the configured tag; increment its `rN` suffix for a changed image.

## Build and push

Run from the repository root on a **local macOS Apple Silicon host** (Darwin + `arm64` only) with Docker Desktop, Docker buildx, and an AWS CLI identity for account `389656352076`:

```bash
deploy/aws/ec2/build-push.sh
```

The publisher is local-only by construction: it rejects any host that is not Darwin/`arm64`, any effective Docker endpoint other than a recognized local Docker Desktop Unix socket (`DOCKER_HOST` and `DOCKER_CONTEXT` are refused), and any active buildx builder whose driver or node is remote (SSH/TCP/cloud). The script validates the AWS account, the registry scan mode (BASIC only; enhanced scanning is rejected), and the existing ECR repository's immutable-tag, KMS-encryption, and scan-on-push settings before authenticating through Docker's password-stdin interface. It refuses an existing target tag, builds `linux/arm64` from the repository root (the smallest context that contains the Dockerfile's locked `COPY` inputs), pushes it, resolves one digest, and waits for the ECR BASIC scan.

Critical findings fail the build delivery. High findings are reported and exit with status `3`, which requires manual review. Unsupported, failed, missing beyond the bounded wait, or timed-out scans never pass; an ECR `ACTIVE` status (enhanced scanning) is rejected as unsupported. On success, stdout ends with exactly two lines: the tagged reference followed by the digest reference.

Do not build on the production host. This script has no production-host mutation or deployment behavior; deploying the verified digest is a separate deployment step.

## Verify an image

The default verifies the fixed ECR tag from `app.env`:

```bash
deploy/aws/ec2/verify-image.sh
```

An explicit immutable tag can be checked with:

```bash
deploy/aws/ec2/verify-image.sh \
  '389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:od-0.21.1-opencode-1.18.29-pi-0.85.1-r2'
```

Prefer verifying the resolved digest before deployment:

```bash
deploy/aws/ec2/verify-image.sh \
  '389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign@sha256:<resolved-digest>'
```

Verification pulls the ARM64 image, checks its platform, default UID/GID, home, exact CLI versions, and prohibited runtime packages, then starts the inherited official daemon with uniquely named temporary Docker resources and a fresh writable volume. It enforces the same local macOS/Docker Desktop gate as the publisher and refuses to run against a remote Docker host or context. Every temporary resource is created with a task-run ownership label and recorded by its returned ID; a resource is used or removed only when its label still matches the current run, so a pre-existing volume or container of the same name causes an abort rather than adoption or deletion. It requires OpenDesign 0.21.1 health and all three required agent IDs to be available. Its exit trap removes only resources created by that verification run; it never targets production resources. Daemon storage ownership and path rules remain defined only by root [`AGENTS.md`](../../../AGENTS.md) under **Daemon data directory contract**.

## Deploy a verified digest

`deploy.sh` performs a transactional, SSM-only production deployment of the immutable image digest. Remote execution happens exclusively through `aws ssm send-command` (AWS-RunShellScript); there is no SSH, no session-manager shell, and no Terraform. The SSM payload carries only validated non-secret values: the `repo@sha256` candidate, the production path, compose project/service names, and expected version strings. It never contains `.env` contents or any token.

```bash
deploy/aws/ec2/deploy.sh \
  '389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign@sha256:<resolved-digest>'
```

Preview everything without sending a command:

```bash
DRY_RUN=1 deploy/aws/ec2/deploy.sh \
  '389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign@sha256:<resolved-digest>'
```

`DRY_RUN=1` performs only read-only AWS metadata calls (caller identity, ECR tag/digest resolution, ECR scan status, EC2 instance discovery, SSM ping status), prints a fully redacted action summary plus the exact remote script that would run, and exits without sending any command.

The candidate must equal the digest the immutable tag resolves to. Local preflight fails closed unless: the caller account matches `app.env`, the tag resolves to exactly one valid digest, the ECR BASIC scan is `COMPLETE`, exactly one running instance is named `apexai-newapi-app`, and its SSM agent is `Online`.

On the host the script, before mutating anything:

1. Preflights `/data/open-design`, `docker-compose.prod.yml`, `.env`, and `data` as regular non-symlink objects; tightens `.env` to mode 600 without printing its contents; verifies exactly one `OPEN_DESIGN_IMAGE=` line and an approved current `repo@sha256` reference; captures container/image/mount identities without dumping environment.
2. Pulls the candidate, confirms `linux/arm64` and default user `1001:1001`, and runs `docker compose config -q` (never printing the rendered config).
3. Creates `/data/open-design/rollback/<UTC>/` mode 700 and saves the current Compose file, `.env` (mode 600), integrity hashes, the previous image reference, the actual image ID/RepoDigest, container fingerprints (ID/StartedAt/restart count), and the data mount summary. File contents are never printed.
4. Atomically replaces only the `OPEN_DESIGN_IMAGE=` line in `.env` with the candidate `repo@sha256` (temp file + rename, mode 600); every other key is byte-preserved.
5. Runs exactly `docker compose -p open-design -f /data/open-design/docker-compose.prod.yml up -d --no-deps open-design`. nginx and every other container are never restarted, recreated, or removed; no `down`, `-v`, `remove-orphans`, or prune is ever used.

Post-deploy gates: the running image ID matches the candidate, UID 1001, `HOME=/app/.od`, the data mount is `/data/open-design/data:/app/.od`, `/api/health` succeeds inside the container and through the nginx sidecar with version `0.21.1`, `opencode`/`opencode-cli` are `1.18.29`, `pi` is `0.85.1`, no prohibited agent CLI is present, and every non-OpenDesign container keeps its prior ID/StartedAt/restart count.

If any post-mutation gate fails, the script automatically restores the snapshot `.env` and recreates only the OpenDesign service, verifies in-container health, then returns nonzero as `FAILED_RECOVERED` or `FAILED_RECOVERY_FAILED`. A local ALB target-health check runs after the SSM round trip when `AOD_TARGET_GROUP` is set.

## Roll back

`rollback.sh` validates and restores snapshots over SSM only. It never touches production data, nginx, or any other container; it restores only the OpenDesign image/config.

```bash
# read-only: list snapshots
deploy/aws/ec2/rollback.sh --list

# read-only: validate the newest snapshot, or a named one
deploy/aws/ec2/rollback.sh --validate
deploy/aws/ec2/rollback.sh --validate 20260905T120000Z

# execute: restore a snapshot (default newest), recreating only open-design
deploy/aws/ec2/rollback.sh --execute
deploy/aws/ec2/rollback.sh 20260905T120000Z

# preview any of the above without sending a command
DRY_RUN=1 deploy/aws/ec2/rollback.sh --execute 20260905T120000Z
```

Validation (read-only) checks the snapshot directory mode 700, `.env` mode 600, all required files, an approved immutable image reference, and that the recorded `SHA256SUMS` hashes still match. Execution restores the snapshot `.env` atomically, pulls the snapshot image if it is not present locally, recreates only the OpenDesign service, and verifies in-container `/api/health` plus the data mount before reporting `ROLLED_BACK`.

## Mountable agent provider configuration

The templates in [agent-config/](agent-config/) add ARK Agent Plan and MiniMax Coding Plan without changing the selected/default chat model:

- [opencode.json.example](agent-config/opencode.json.example): OpenCode 1.x provider configuration.
- [pi-models.json.example](agent-config/pi-models.json.example): Pi custom providers and model catalog.
- [media-config.json.example](agent-config/media-config.json.example): OpenDesign Volcengine media configuration with Agent Plan model aliases.
- [agent-profiles.json.example](agent-config/agent-profiles.json.example): four independent agent entries with provider-specific defaults.

The model lists are snapshots, not entitlement guarantees. Refresh them from the subscribed provider catalog when needed. ARK uses `/api/plan/v3`, not the platform/pay-as-you-go endpoint. MiniMax uses `/anthropic/v1` for OpenCode; Pi uses `/anthropic` and its SDK appends `/v1/messages`. The MiniMax chat subscription key is not a media-generation credential.

Copy the examples to private files **outside the checkout**, replace the credential placeholders there, and restrict access to container UID 1001 (owner 1001, mode 600 on Linux). Never put credentials in shell arguments, SSM command payloads, versioned files, or image builds. The example directory ignores non-example files and is excluded from the Docker build context.

Keep daemon-managed storage rooted according to the [root data-directory contract](../../../AGENTS.md#daemon-data-directory-contract). The existing persisted home mount already covers `$HOME/.config/opencode/opencode.json` and `$HOME/.pi/agent/models.json`. Preserve existing `opencode.jsonc`, Pi auth/session files, and saved OpenDesign model selections. Provider credential/catalog updates need no new mount or container recreation. Independent agent profiles must live under the resolved daemon data root and be selected by `OD_AGENT_PROFILES_CONFIG`; restart the daemon after changing profile definitions because the runtime registry loads them at startup.

For independently managed files, [docker-compose.agents.yml](docker-compose.agents.yml) provides **read-only file bind mounts**. Set `OPENCODE_CONFIG_FILE`, `PI_MODELS_FILE`, and `AGENT_PROFILES_FILE` to existing absolute host file paths. Set `BASE_COMPOSE` to the existing deployment Compose file, then:

```bash
docker compose -f "$BASE_COMPOSE" -f deploy/aws/ec2/docker-compose.agents.yml config --quiet
docker compose -f "$BASE_COMPOSE" -f deploy/aws/ec2/docker-compose.agents.yml up -d --no-deps open-design
```

Use the overlay with the derived agent image and retain the base daemon data volume. Missing sources fail instead of creating empty directories. Only Pi models are read-only: its enclosing home remains writable for auth, sessions, and settings. OpenCode uses `OPENCODE_CONFIG` while retaining its ordinary global configuration layer.

EC2 `deploy.sh` and `rollback.sh` use the canonical production Compose file alone. When adopting independent mounts there, incorporate this overlay's environment/volume entries into that canonical file before the next deployment. A one-off `-f` override will not survive those scripts.

File bind mounts retain the mounted inode. If an editor replaces a file using temp-file + rename, recreate only the OpenDesign service to mount the replacement; no image rebuild is needed. Rescan agents after catalog updates because OpenDesign may cache the model list.

For media, merge the example provider through the media configuration API or into the existing media configuration file under the root data contract. Store model aliases in that file or `OD_MEDIA_MODEL_ALIASES`: `PUT /api/media/config` preserves aliases but does not update them. Preserve other providers. The aliases map OpenDesign catalog IDs to Plan image/video IDs; they do not change the chat model. Media generation is not part of configuration validation.

The official [Agent Plan visual-model API guide](https://www.volcengine.com/docs/82379/2375486?lang=zh) specifies the same dedicated Agent Plan key and `/api/plan/v3` base for both media surfaces:

| Operation | Method and path relative to the Plan base | Model sent upstream |
|---|---|---|
| Generate image | `POST /images/generations` | `doubao-seedream-5.0-lite` |
| Create video task | `POST /contents/generations/tasks` | `doubao-seedance-2.0` or `doubao-seedance-2.0-fast` |
| Poll video task | `GET /contents/generations/tasks/{id}` | Same task; download `content.video_url` on success |

Do not switch this subscription key to the platform `/api/v3` gateway. Seedream 5.0 Lite is listed for all Agent Plan tiers; Seedance 2.0 models require Large/Max. A configured provider does not prove model entitlement. The guide also lists Seedance 1.5 Pro for Medium but marks it for retirement; do not silently substitute it for 2.0. Generation consumes subscription quota and may incur overage charges if enabled.

Inside daemon-spawned agents, invoke `"$OD_NODE_BIN" "$OD_BIN" media --help` and the corresponding `media generate` / `media wait` commands. Do not rely on bare `od`: Alpine can resolve it to BusyBox’s octal-dump utility. The daemon injects the project and local tool authorization; provider secrets stay in the daemon media configuration. Both OpenCode and Pi, including their provider-specific profiles, use this shared dispatcher; no provider-specific skill or MCP installation is required.

**Seedream renderer compatibility:** aliases alone do not upgrade the image request. The [Volcengine renderer](../../../apps/daemon/src/media/index.ts) currently derives Seedream size as `1024x1024`, below Seedream 5.0 Lite’s 3,686,400-pixel minimum. This needs a renderer fix before the template’s image alias is usable; the CLI’s `--resolution` option does not override this provider. After that fix, select the Seedream catalog entry explicitly rather than leaving the image model on an unrelated cloud-provider default. For Seedance 2.0 use supported lengths such as 5/8/10/15 seconds; current dispatcher output is 720p.

The independent entries default to these exact models:

| Entry | ID | Default model |
|---|---|---|
| OpenCode · ARK Plan | `opencode-ark-plan` | `ark-agent-plan/deepseek-v4-flash` |
| OpenCode · MiniMax | `opencode-minimax-plan` | `minimax-coding-plan/MiniMax-M3` |
| Pi · ARK Plan | `pi-ark-plan` | `ark-agent-plan/deepseek-v4-flash` |
| Pi · MiniMax | `pi-minimax-plan` | `minimax-coding-plan/MiniMax-M3` |

Choose the desired entry in OpenDesign and leave its model on the default option to use the profile default. Explicit model selections still override it. Original OpenCode/Pi entries and their saved selections remain unchanged. Profiles reuse the existing provider credentials; the profile file contains no keys. The two OpenCode profiles set `OPENCODE_DISABLE_PROJECT_CONFIG=true` to retain the ordinary OpenCode runtime’s project-config isolation. ARK `auto` remains excluded because the Chat Completions endpoint returned `UnsupportedModel`. The generic CLI templates deliberately do not set a global default.

## Secret boundary

Only non-secret constants belong in `app.env`, this directory, the Docker build context, image layers, commands, or reports. Do not add AWS credentials, API tokens, provider keys, copied production environment files, or proxy credentials. AWS authentication must come from the operator's normal AWS CLI credential provider, and ECR authentication remains in the password-stdin pipeline so no registry password is printed or placed in arguments.

Image verification is no-cost: it detects installed agents but does not start a model run. Any deployment or paid agent canary is outside these scripts and requires its own explicit step.
