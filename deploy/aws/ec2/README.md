# OpenDesign EC2 agent image delivery

This directory defines the reproducible ARM64 image that derives from the immutable OpenDesign 0.21.1 base and adds the locked OpenCode and pi CLIs. Image delivery is intentionally separate from production deployment.

## Fixed image identity

`app.env` is the checked-in, non-secret source of truth. The human-readable ECR tag is:

```text
389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:od-0.21.1-opencode-1.18.29-pi-0.85.1-r1
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
  '389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign:od-0.21.1-opencode-1.18.29-pi-0.85.1-r1'
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

## Secret boundary

Only non-secret constants belong in `app.env`, this directory, the Docker build context, image layers, commands, or reports. Do not add AWS credentials, API tokens, provider keys, copied production environment files, or proxy credentials. AWS authentication must come from the operator's normal AWS CLI credential provider, and ECR authentication remains in the password-stdin pipeline so no registry password is printed or placed in arguments.

Image verification is no-cost: it detects installed agents but does not start a model run. Any deployment or paid agent canary is outside these scripts and requires its own explicit step.
