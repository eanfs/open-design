#!/usr/bin/env bash
set -euo pipefail

# Transactional SSM-only production deployment for the OpenDesign agent image.
#
# Remote execution happens exclusively through AWS SSM Run Command: no SSH, no
# session-manager shell, no Terraform. The SSM payload carries only validated
# non-secret values (the immutable ECR digest, the production path, compose
# project/service names, and expected version strings). Production .env content
# is never read into argv, never embedded in the payload, and never printed; the
# remote script only rewrites the single OPEN_DESIGN_IMAGE= line on the host.
#
# The only production mutation performed remotely is:
#   docker compose -p open-design -f <prod>/docker-compose.prod.yml up -d --no-deps open-design
# No nginx or other container is ever restarted, recreated, or removed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/app.env"
POLL_INTERVAL_SECONDS="${AOD_DEPLOY_POLL_SECONDS:-6}"
POLL_TIMEOUT_SECONDS="${AOD_DEPLOY_TIMEOUT_SECONDS:-900}"
ALB_HEALTH_ATTEMPTS="${AOD_ALB_HEALTH_ATTEMPTS:-6}"
ALB_HEALTH_POLL_SECONDS="${AOD_ALB_HEALTH_POLL_SECONDS:-10}"

log() {
  printf '[aod-deploy] %s\n' "$*" >&2
}

die() {
  printf '[aod-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

load_constants() {
  [[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] || die "constants file must be a regular non-symlink: $CONFIG_FILE"

  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9._/:@-]+$ ]] \
      || die "constants file contains an unsafe assignment"
  done <"$CONFIG_FILE"

  # shellcheck source=app.env
  source "$CONFIG_FILE"
  : "${AWS_ACCOUNT_ID:?}" "${AWS_REGION:?}" "${ECR_REPOSITORY:?}" "${IMAGE_TAG:?}"
  : "${APP_HOSTNAME:?}" "${INSTANCE_NAME:?}" "${PRODUCTION_PATH:?}"
  : "${OPENDESIGN_VERSION:?}" "${OPENCODE_VERSION:?}" "${PI_VERSION:?}"
}

validate_versions() {
  [[ "$OPENDESIGN_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid OPENDESIGN_VERSION: $OPENDESIGN_VERSION"
  [[ "$OPENCODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid OPENCODE_VERSION: $OPENCODE_VERSION"
  [[ "$PI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid PI_VERSION: $PI_VERSION"
}

check_caller_account() {
  local caller_account
  caller_account="$(aws sts get-caller-identity \
    --region "$AWS_REGION" \
    --query Account \
    --output text)" || die "unable to resolve the caller AWS account"
  [[ "$caller_account" == "$AWS_ACCOUNT_ID" ]] \
    || die "AWS account mismatch: expected $AWS_ACCOUNT_ID"
}

resolve_tag_digest() {
  local digests
  local line
  local count=0
  local resolved=""
  digests="$(aws ecr describe-images \
    --region "$AWS_REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-ids "imageTag=$IMAGE_TAG" \
    --query 'imageDetails[*].imageDigest' \
    --output text)" || die "unable to resolve the immutable tag $IMAGE_TAG"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    [[ "$line" =~ ^sha256:[0-9a-f]{64}$ ]] || die "tag $IMAGE_TAG resolved to an invalid digest: $line"
    count=$((count + 1))
    resolved="$line"
  done <<<"$digests"
  [[ "$count" -eq 1 ]] || die "tag $IMAGE_TAG must resolve to exactly one digest (resolved $count)"
  printf '%s\n' "$resolved"
}

verify_scan_complete() {
  local digest="$1"
  local status
  status="$(aws ecr describe-image-scan-findings \
    --region "$AWS_REGION" \
    --repository-name "$ECR_REPOSITORY" \
    --image-id "imageDigest=$digest" \
    --query 'imageScanStatus.status' \
    --output text)" || die "unable to read the ECR scan status for $digest"
  [[ "$status" == "COMPLETE" ]] || die "ECR scan for $digest is not COMPLETE (status: $status)"
  log "scan gate previously passed: ECR BASIC scan for $digest is COMPLETE"
}

discover_instance() {
  local ids
  ids="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=running" \
    --query 'Reservations[*].Instances[*].InstanceId' \
    --output text)" || die "unable to discover instances named $INSTANCE_NAME"
  [[ "$ids" =~ ^i-[0-9a-f]{8,17}$ ]] \
    || die "expected exactly one running instance named $INSTANCE_NAME (resolved: ${ids:-none})"
  printf '%s\n' "$ids"
}

check_ssm_online() {
  local instance_id="$1"
  local ping_status
  ping_status="$(aws ssm describe-instance-information \
    --region "$AWS_REGION" \
    --filters "Key=InstanceIds,Values=$instance_id" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text)" || die "unable to query SSM status for $instance_id"
  [[ "$ping_status" == "Online" ]] || die "SSM agent for $instance_id is not Online (status: $ping_status)"
  log "instance $instance_id is SSM Online"
}

# Build the non-secret remote script. The values below are injected by the local
# layer and validated against strict non-secret patterns; the heredoc body is
# passed through verbatim (quoted delimiter) so nothing else can be smuggled in.
build_remote_script() {
  local body
  body="$(cat <<'REMOTE_EOF'
set -euo pipefail

# Values above this heredoc are injected by the local orchestration layer and are
# validated non-secret: immutable ECR digest, production path, compose project and
# service names, and expected version strings. This script never reads or prints
# the contents of production .env, and never touches nginx or any other container.

PROJECT='open-design'
SERVICE='open-design'
CONTAINER_NAME='open-design-open-design-1'

log() { printf '[aod-remote] %s\n' "$*" >&2; }
fatal() { printf '[aod-remote] FATAL: %s\n' "$*" >&2; exit 1; }

remote_preflight() {
  [[ -d "$PROD_PATH" && ! -L "$PROD_PATH" ]] || fatal "production path is missing or a symlink: $PROD_PATH"
  [[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] || fatal "compose file must be a regular non-symlink file: $COMPOSE_FILE"
  [[ -f "$PROD_PATH/.env" && ! -L "$PROD_PATH/.env" ]] || fatal ".env must be a regular non-symlink file"
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || fatal "data directory is missing or a symlink: $DATA_DIR"

  local env_mode
  env_mode="$(stat -c '%a' "$PROD_PATH/.env" 2>/dev/null || stat -f '%Lp' "$PROD_PATH/.env")"
  if [[ "$env_mode" != "600" ]]; then
    chmod 600 "$PROD_PATH/.env"
    log "tightened .env mode to 600 (was $env_mode)"
  fi

  local image_line_count
  image_line_count="$(grep -c '^OPEN_DESIGN_IMAGE=' "$PROD_PATH/.env" 2>/dev/null || true)"
  [[ "$image_line_count" == "1" ]] || fatal "expected exactly one OPEN_DESIGN_IMAGE= line in .env (found ${image_line_count:-0})"

  CURRENT_IMAGE="$(grep '^OPEN_DESIGN_IMAGE=' "$PROD_PATH/.env" | head -n 1 | cut -d= -f2-)"
  [[ "$CURRENT_IMAGE" =~ ^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[A-Za-z0-9_.-]+@sha256:[0-9a-f]{64}$ ]] \
    || fatal "current OPEN_DESIGN_IMAGE is not an approved repo@sha256 reference"
  log "remote preflight complete"
}

capture_container_fingerprints() {
  local output="$1"
  local ids
  local id
  ids="$(docker ps -aq --no-trunc)" || fatal "unable to list containers"
  : > "$output"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    docker inspect --format '{{.Name}}|{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}' "$id" >> "$output" \
      || fatal "unable to fingerprint container $id"
  done <<<"$ids"
}

container_has_data_mount() {
  local container="$1"
  local mounts
  mounts="$(docker inspect --format '{{range .Mounts}}{{.Source}}={{.Destination}}{{println}}{{end}}' "$container")" \
    || return 1
  grep -Fxq "$DATA_DIR=/app/.od" <<<"$mounts"
}

pull_and_check_candidate() {
  log "pulling candidate $CANDIDATE"
  docker pull --platform linux/arm64 "$CANDIDATE" >/dev/null \
    || fatal "unable to pull candidate $CANDIDATE"
  local platform
  local user
  platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$CANDIDATE")"
  [[ "$platform" == "linux/arm64" ]] || fatal "candidate platform is $platform"
  user="$(docker image inspect --format '{{.Config.User}}' "$CANDIDATE")"
  [[ "$user" == "1001:1001" ]] || fatal "candidate default user is $user"
  CANDIDATE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE")"
}

create_snapshot() {
  local utc
  utc="$(date -u +%Y%m%dT%H%M%SZ)"
  SNAPSHOT_DIR="$ROLLBACK_ROOT/$utc"
  mkdir -p -m 700 "$ROLLBACK_ROOT"
  mkdir -m 700 "$SNAPSHOT_DIR"
  cp -p "$COMPOSE_FILE" "$SNAPSHOT_DIR/docker-compose.prod.yml"
  cp -p "$PROD_PATH/.env" "$SNAPSHOT_DIR/.env"
  chmod 600 "$SNAPSHOT_DIR/.env"
  ( cd "$PROD_PATH" && sha256sum docker-compose.prod.yml .env > "$SNAPSHOT_DIR/SHA256SUMS" )
  printf '%s\n' "$CURRENT_IMAGE" > "$SNAPSHOT_DIR/OPEN_DESIGN_IMAGE"
  docker image inspect --format '{{.Id}}' "$CURRENT_IMAGE" > "$SNAPSHOT_DIR/image-id.txt" 2>/dev/null || true
  docker image inspect --format '{{range .RepoDigests}}{{println}}{{end}}' "$CURRENT_IMAGE" > "$SNAPSHOT_DIR/repodigests.txt" 2>/dev/null || true
  capture_container_fingerprints "$SNAPSHOT_DIR/containers.txt"
  local od_id
  od_id="$(docker ps -aq --filter "name=^${CONTAINER_NAME}$" --format '{{.ID}}' | head -n 1 || true)"
  if [[ -n "$od_id" ]]; then
    printf '%s\n' "$od_id" > "$SNAPSHOT_DIR/open-design-container-id.txt"
    docker inspect --format '{{range .Mounts}}{{.Source}}={{.Destination}}{{println}}{{end}}' "$od_id" > "$SNAPSHOT_DIR/open-design-mounts.txt" 2>/dev/null || true
  fi
  log "rollback snapshot created at $SNAPSHOT_DIR (mode 700)"
}

atomic_set_image() {
  local new_reference="$1"
  local tmp_env
  tmp_env="$(mktemp "$PROD_PATH/.env.deploy.XXXXXX")"
  chmod 600 "$tmp_env"
  sed "s|^OPEN_DESIGN_IMAGE=.*|OPEN_DESIGN_IMAGE=${new_reference}|" "$PROD_PATH/.env" > "$tmp_env" \
    || { rm -f "$tmp_env"; fatal "unable to rewrite the OPEN_DESIGN_IMAGE line"; }
  mv -f "$tmp_env" "$PROD_PATH/.env"
  chmod 600 "$PROD_PATH/.env"
  log "OPEN_DESIGN_IMAGE line updated atomically; other .env bytes preserved"
}

deploy_service() {
  local output
  log "running compose up -d --no-deps for service open-design"
  if ! output="$(docker compose -p open-design -f "$COMPOSE_FILE" up -d --no-deps open-design 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  return 0
}

in_container_health() {
  local container="$1"
  docker exec "$container" node -e '
    const http = require("http");
    const expected = process.argv[1];
    const req = http.get({ host: "127.0.0.1", port: 7456, path: "/api/health", timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          process.exit(json.ok === true && json.version === expected ? 0 : 1);
        } catch (err) { process.exit(1); }
      });
    });
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' "$EXPECTED_VERSION" >/dev/null 2>&1
}

through_nginx_health() {
  local nginx_container
  local host_port
  local body
  nginx_container="$(docker ps -aq --filter 'name=nginx' --format '{{.ID}}' | head -n 1 || true)"
  [[ -n "$nginx_container" ]] || { log "nginx container not found"; return 1; }
  host_port="$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{if eq $port "80/tcp"}}{{range $bindings}}{{.HostPort}} {{end}}{{end}}{{end}}' "$nginx_container" | awk '{print $1}')" \
    || return 1
  if [[ -z "$host_port" ]]; then
    host_port="$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{if eq $port "443/tcp"}}{{range $bindings}}{{.HostPort}} {{end}}{{end}}{{end}}' "$nginx_container" | awk '{print $1}')" \
      || return 1
  fi
  [[ -n "$host_port" ]] || { log "nginx publishes neither 80/tcp nor 443/tcp"; return 1; }
  body="$(curl --fail --silent --show-error --max-time 10 -H "Host: $APP_HOSTNAME" "http://127.0.0.1:${host_port}/api/health")" \
    || { log "health request through nginx failed"; return 1; }
  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$body" || { log "health through nginx did not report ok:true"; return 1; }
  grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${EXPECTED_VERSION}\"" <<<"$body" || { log "health through nginx version mismatch"; return 1; }
  return 0
}

check_cli_versions() {
  local container="$1"
  local oc
  local oc_cli
  local pi
  oc="$(docker exec "$container" opencode --version 2>/dev/null | tr -d '\r\n' || true)"
  oc_cli="$(docker exec "$container" opencode-cli --version 2>/dev/null | tr -d '\r\n' || true)"
  pi="$(docker exec "$container" pi --version 2>/dev/null | tr -d '\r\n' || true)"
  [[ "$oc" == "$EXPECTED_OPENCODE_VERSION" ]] || { log "opencode version mismatch: ${oc:-missing}"; return 1; }
  [[ "$oc_cli" == "$EXPECTED_OPENCODE_VERSION" ]] || { log "opencode-cli version mismatch: ${oc_cli:-missing}"; return 1; }
  [[ "$pi" == "$EXPECTED_PI_VERSION" ]] || { log "pi version mismatch: ${pi:-missing}"; return 1; }
  if docker exec "$container" sh -lc 'command -v vela' >/dev/null 2>&1; then
    log "prohibited agent CLI found in the container"
    return 1
  fi
  return 0
}

non_od_containers_unchanged() {
  local current_file
  local name
  local id
  local started
  local restarts
  current_file="$(mktemp)"
  capture_container_fingerprints "$current_file"
  while IFS='|' read -r name id started restarts; do
    [[ -n "$name" ]] || continue
    [[ "$name" == "/${CONTAINER_NAME}" ]] && continue
    if ! grep -Fxq "$name|$id|$started|$restarts" "$SNAPSHOT_DIR/containers.txt"; then
      log "non-OpenDesign container changed after deploy: $name"
      rm -f "$current_file"
      return 1
    fi
  done <"$current_file"
  while IFS='|' read -r name id started restarts; do
    [[ -n "$name" ]] || continue
    [[ "$name" == "/${CONTAINER_NAME}" ]] && continue
    if ! grep -Fxq "$name|$id|$started|$restarts" "$current_file"; then
      log "pre-existing container disappeared after deploy: $name"
      rm -f "$current_file"
      return 1
    fi
  done <"$SNAPSHOT_DIR/containers.txt"
  rm -f "$current_file"
  return 0
}

post_deploy_gates() {
  local container
  local running_image
  local uid
  local home_env
  container="$(docker ps -aq --filter "name=^${CONTAINER_NAME}$" --format '{{.ID}}' | head -n 1 || true)"
  [[ -n "$container" ]] || { log "open-design container is not running"; return 21; }
  NEW_CONTAINER_ID="$container"
  running_image="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  [[ "$running_image" == "$CANDIDATE_IMAGE_ID" ]] || { log "running image $running_image does not match candidate $CANDIDATE_IMAGE_ID"; return 22; }
  uid="$(docker inspect --format '{{.Config.User}}' "$container" 2>/dev/null || true)"
  [[ "$uid" == "1001:1001" ]] || { log "unexpected container user: $uid"; return 23; }
  home_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null | grep '^HOME=' | head -n 1 || true)"
  [[ "$home_env" == "HOME=/app/.od" ]] || { log "unexpected container HOME: ${home_env:-unset}"; return 24; }
  container_has_data_mount "$container" || { log "data mount $DATA_DIR:/app/.od missing"; return 25; }
  in_container_health "$container" || { log "in-container /api/health gate failed"; return 26; }
  through_nginx_health || { log "through-nginx /api/health gate failed"; return 27; }
  check_cli_versions "$container" || { log "CLI version gate failed"; return 28; }
  non_od_containers_unchanged || { log "container fingerprint gate failed"; return 29; }
  return 0
}

recover_previous_deployment() {
  local reason="$1"
  local tmp_env
  local restored
  log "post-mutation failure ($reason); restoring the snapshot image"
  if [[ -f "$SNAPSHOT_DIR/.env" ]]; then
    tmp_env="$(mktemp "$PROD_PATH/.env.rollback.XXXXXX")" \
      || { printf 'FAILED_RECOVERY_FAILED: %s (cannot create temporary .env)\n' "$reason"; exit 31; }
    chmod 600 "$tmp_env"
    if ! cp -p "$SNAPSHOT_DIR/.env" "$tmp_env" || ! mv -f "$tmp_env" "$PROD_PATH/.env"; then
      rm -f "$tmp_env"
      printf 'FAILED_RECOVERY_FAILED: %s (cannot restore snapshot .env)\n' "$reason"
      exit 31
    fi
    chmod 600 "$PROD_PATH/.env"
    log "restored snapshot .env atomically"
  fi
  if deploy_service; then
    restored="$(docker ps -aq --filter "name=^${CONTAINER_NAME}$" --format '{{.ID}}' | head -n 1 || true)"
    if [[ -n "$restored" ]] && in_container_health "$restored"; then
      printf 'FAILED_RECOVERED: %s\n' "$reason"
      exit 30
    fi
  fi
  printf 'FAILED_RECOVERY_FAILED: %s\n' "$reason"
  exit 31
}

remote_preflight
pull_and_check_candidate
create_snapshot
atomic_set_image "$CANDIDATE"
if ! docker compose -p open-design -f "$COMPOSE_FILE" config -q >/dev/null 2>&1; then
  recover_previous_deployment "compose config -q failed after image swap"
fi
if ! deploy_service; then
  recover_previous_deployment "compose up failed"
fi
if ! post_deploy_gates; then
  recover_previous_deployment "post-deploy gate failed"
fi
printf 'DEPLOYED %s container=%s image=%s\n' "$CANDIDATE" "$NEW_CONTAINER_ID" "$CANDIDATE_IMAGE_ID"
exit 0
REMOTE_EOF
)"
  local preamble
  preamble="$(
    printf 'CANDIDATE=%q\n' "$CANDIDATE"
    printf 'PROD_PATH=%q\n' "$PRODUCTION_PATH"
    printf 'COMPOSE_FILE=%q\n' "${PRODUCTION_PATH}/docker-compose.prod.yml"
    printf 'DATA_DIR=%q\n' "${PRODUCTION_PATH}/data"
    printf 'ROLLBACK_ROOT=%q\n' "${PRODUCTION_PATH}/rollback"
    printf 'EXPECTED_VERSION=%q\n' "$OPENDESIGN_VERSION"
    printf 'EXPECTED_OPENCODE_VERSION=%q\n' "$OPENCODE_VERSION"
    printf 'EXPECTED_PI_VERSION=%q\n' "$PI_VERSION"
    printf 'APP_HOSTNAME=%q\n' "$APP_HOSTNAME"
  )"
  printf '%s\n%s\n' "$preamble" "$body"
}

assert_remote_script_has_no_secrets() {
  local script="$1"
  if grep -Eiq '(TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|CREDENTIAL)[[:space:]]*=' <<<"$script"; then
    die "refusing to display a remote script that may carry a secret-bearing assignment"
  fi
}

print_dry_run_summary() {
  local instance_id="$1"
  cat >&2 <<EOF
[aod-deploy] DRY_RUN=1 -- NO COMMAND WILL BE SENT TO AWS
[aod-deploy]   account:    $AWS_ACCOUNT_ID
[aod-deploy]   region:     $AWS_REGION
[aod-deploy]   repository: $ECR_REPOSITORY
[aod-deploy]   release tag: $IMAGE_TAG
[aod-deploy]   candidate:  $CANDIDATE
[aod-deploy]   instance:   $instance_id (SSM Online)
[aod-deploy]   production: $PRODUCTION_PATH
[aod-deploy] remote actions that would run on the host:
[aod-deploy]   1. remote preflight: path/type checks, .env mode 600, single OPEN_DESIGN_IMAGE line, current image
[aod-deploy]   2. pull candidate (linux/arm64, user 1001:1001), compose config -q
[aod-deploy]   3. create $PRODUCTION_PATH/rollback/<UTC>/ mode 700 snapshot (compose, .env 600, hashes, image + container fingerprints)
[aod-deploy]   4. atomically replace only the OPEN_DESIGN_IMAGE= line in .env
[aod-deploy]   5. docker compose -p open-design -f docker-compose.prod.yml up -d --no-deps open-design
[aod-deploy]   6. post-deploy gates: image id, uid 1001, HOME, data mount, in-container and through-nginx /api/health ($OPENDESIGN_VERSION), CLI versions, non-OpenDesign fingerprints unchanged
[aod-deploy]   7. on any post-mutation failure: restore snapshot .env and recreate only open-design, verify health, exit FAILED_RECOVERED / FAILED_RECOVERY_FAILED
[aod-deploy] END DRY_RUN SUMMARY
EOF
}

run_remote() {
  local remote_script="$1"
  local comment="$2"
  local run_b64
  local params
  local cmd_id
  local status="Pending"
  local deadline=$((SECONDS + POLL_TIMEOUT_SECONDS))
  local response_code
  local stdout_content
  local stderr_content

  run_b64="$(printf '%s' "$remote_script" | base64 | tr -d '\n')"
  params="{\"commands\":[\"echo ${run_b64} | base64 --decode | sudo bash\"]}"

  log "sending SSM Run Command to $INSTANCE_ID"
  cmd_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --document-name AWS-RunShellScript \
    --instance-ids "$INSTANCE_ID" \
    --comment "$comment" \
    --parameters "$params" \
    --query 'Command.CommandId' \
    --output text)" || die "failed to send the SSM Run Command"
  log "command id $cmd_id; polling"

  while (( SECONDS < deadline )); do
    sleep "$POLL_INTERVAL_SECONDS"
    status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$cmd_id" \
      --instance-id "$INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || echo Pending)"
    case "$status" in
      Success|Failed|Cancelled|TimedOut) break ;;
      Pending|InProgress|Delayed|PlatformPending|Invalid) ;;
      *) log "unexpected SSM status: $status" ;;
    esac
  done

  case "$status" in
    Success|Failed|Cancelled|TimedOut) ;;
    *) die "SSM command $cmd_id did not finish within $POLL_TIMEOUT_SECONDS seconds (last status: $status)" ;;
  esac

  stdout_content="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$cmd_id" \
    --instance-id "$INSTANCE_ID" \
    --query StandardOutputContent \
    --output text 2>/dev/null || true)"
  stderr_content="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$cmd_id" \
    --instance-id "$INSTANCE_ID" \
    --query StandardErrorContent \
    --output text 2>/dev/null || true)"
  response_code="$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$cmd_id" \
    --instance-id "$INSTANCE_ID" \
    --query ResponseCode \
    --output text 2>/dev/null || echo 1)"

  printf '%s\n' "$stdout_content"
  [[ -z "$stderr_content" ]] || printf '%s\n' "$stderr_content" >&2

  case "$response_code" in
    0) return 0 ;;
    30) die "remote deployment failed and the previous image was restored (FAILED_RECOVERED); see remote output above" ;;
    31) die "remote deployment failed and automatic recovery failed (FAILED_RECOVERY_FAILED); manual intervention required" ;;
    *)
      die "remote script exited with code $response_code (SSM status: $status)"
      ;;
  esac
}

check_alb_target_health() {
  local target_group="${AOD_TARGET_GROUP:-}"
  if [[ -z "$target_group" ]]; then
    log "ALB target health check skipped (set AOD_TARGET_GROUP to a target group name to enable it)"
    return 0
  fi
  local tg_arn
  local health
  local line
  local id
  local state
  local reason
  local targets
  local any_bad
  local attempt=1
  tg_arn="$(aws elbv2 describe-target-groups \
    --region "$AWS_REGION" \
    --names "$target_group" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)" || die "target group $target_group not found"
  [[ "$tg_arn" =~ ^arn: ]] || die "target group $target_group did not resolve to an ARN"

  while (( attempt <= ALB_HEALTH_ATTEMPTS )); do
    health="$(aws elbv2 describe-target-health \
      --region "$AWS_REGION" \
      --target-group-arn "$tg_arn" \
      --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State,TargetHealth.Reason]' \
      --output text)" || die "unable to read target health for $target_group"
    targets=0
    any_bad=0
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      targets=$((targets + 1))
      read -r id state reason <<<"$line"
      if [[ "$state" != "healthy" ]]; then
        any_bad=1
        log "ALB target $id is $state (${reason:-no reason})"
      fi
    done <<<"$health"
    if (( targets == 0 )); then
      log "ALB target group $target_group has no registered targets"
      return 0
    fi
    if (( any_bad == 0 )); then
      log "ALB target group $target_group: all $targets targets healthy"
      return 0
    fi
    if (( attempt >= ALB_HEALTH_ATTEMPTS )); then
      break
    fi
    log "ALB target group $target_group not healthy yet; retrying"
    sleep "$ALB_HEALTH_POLL_SECONDS"
    attempt=$((attempt + 1))
  done
  die "ALB target group $target_group still has unhealthy targets"
}

if (( $# != 1 )); then
  printf 'usage: %s <account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<digest>\n' "$0" >&2
  exit 64
fi

load_constants
validate_versions
require_command aws
require_command base64

CANDIDATE="$1"
expected_repo_uri="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
[[ "$CANDIDATE" == "$expected_repo_uri@sha256:"* ]] \
  || die "candidate must be exactly ${expected_repo_uri}@sha256:<64-hex-digest>"
CANDIDATE_DIGEST="${CANDIDATE##*@}"
[[ "$CANDIDATE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "candidate digest must be sha256:<64 hex characters>"

check_caller_account
TAG_DIGEST="$(resolve_tag_digest)"
[[ "$CANDIDATE_DIGEST" == "$TAG_DIGEST" ]] \
  || die "candidate digest does not match tag $IMAGE_TAG ($TAG_DIGEST)"
verify_scan_complete "$CANDIDATE_DIGEST"
INSTANCE_ID="$(discover_instance)"
check_ssm_online "$INSTANCE_ID"

REMOTE_SCRIPT="$(build_remote_script)"

assert_remote_script_has_no_secrets "$REMOTE_SCRIPT"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  print_dry_run_summary "$INSTANCE_ID"
  printf '%s\n' "$REMOTE_SCRIPT"
  exit 0
fi

run_remote "$REMOTE_SCRIPT" "deploy OpenDesign $CANDIDATE"
check_alb_target_health
log "deployment complete: $CANDIDATE"
