#!/usr/bin/env bash
set -euo pipefail

# SSM-only production rollback for the OpenDesign agent image.
#
# A rollback restores the snapshot .env (and therefore the previous immutable
# OPEN_DESIGN_IMAGE reference) and recreates ONLY the open-design compose service
# through AWS SSM Run Command. It never mutates production data, nginx, or any
# other container. Snapshot validation is read-only; execution mutates only the
# open-design image/config via:
#   docker compose -p open-design -f <prod>/docker-compose.prod.yml up -d --no-deps open-design

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/app.env"
POLL_INTERVAL_SECONDS="${AOD_ROLLBACK_POLL_SECONDS:-6}"
POLL_TIMEOUT_SECONDS="${AOD_ROLLBACK_TIMEOUT_SECONDS:-900}"

log() {
  printf '[aod-rollback] %s\n' "$*" >&2
}

die() {
  printf '[aod-rollback] ERROR: %s\n' "$*" >&2
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
  : "${INSTANCE_NAME:?}" "${PRODUCTION_PATH:?}" "${OPENDESIGN_VERSION:?}"
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

# Shared read-only validation fragment: selects the snapshot (named or newest by
# UTC name), verifies directory mode 700, required files, .env mode 600, a valid
# immutable image reference, and that the recorded integrity hashes still match.
build_validate_fragment() {
  cat <<'REMOTE_EOF'
select_snapshot() {
  local name
  if [[ -n "$SNAPSHOT_ARG" ]]; then
    SNAPSHOT_DIR="$ROLLBACK_ROOT/$SNAPSHOT_ARG"
  else
    name="$(ls -1d "$ROLLBACK_ROOT"/*/ 2>/dev/null | xargs -n 1 basename 2>/dev/null | sort | tail -n 1 || true)"
    [[ -n "$name" ]] || { printf 'NO_SNAPSHOTS\n' >&2; exit 3; }
    SNAPSHOT_DIR="$ROLLBACK_ROOT/$name"
  fi
}

validate_snapshot() {
  local mode
  local env_mode
  local image_ref
  [[ -d "$SNAPSHOT_DIR" && ! -L "$SNAPSHOT_DIR" ]] || fatal "snapshot is not a real directory: $SNAPSHOT_DIR"
  mode="$(stat -c '%a' "$SNAPSHOT_DIR" 2>/dev/null || stat -f '%Lp' "$SNAPSHOT_DIR")"
  [[ "$mode" == "700" ]] || fatal "snapshot directory mode is $mode (expected 700)"
  local file
  for file in docker-compose.prod.yml .env OPEN_DESIGN_IMAGE image-id.txt containers.txt SHA256SUMS; do
    [[ -f "$SNAPSHOT_DIR/$file" && ! -L "$SNAPSHOT_DIR/$file" ]] || fatal "snapshot is missing regular file: $file"
  done
  env_mode="$(stat -c '%a' "$SNAPSHOT_DIR/.env" 2>/dev/null || stat -f '%Lp' "$SNAPSHOT_DIR/.env")"
  [[ "$env_mode" == "600" ]] || fatal "snapshot .env mode is $env_mode (expected 600)"
  image_ref="$(cat "$SNAPSHOT_DIR/OPEN_DESIGN_IMAGE")"
  [[ "$image_ref" =~ ^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[A-Za-z0-9_.-]+@sha256:[0-9a-f]{64}$ ]] \
    || fatal "snapshot OPEN_DESIGN_IMAGE is not an approved repo@sha256 reference"
  ( cd "$SNAPSHOT_DIR" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) \
    || fatal "snapshot integrity hashes do not match"
  printf 'VALID %s image=%s\n' "$(basename "$SNAPSHOT_DIR")" "$image_ref"
}
REMOTE_EOF
}

build_list_script() {
  cat <<'REMOTE_EOF'
set -euo pipefail
ROLLBACK_ROOT='__ROLLBACK_ROOT__'
log() { printf '[aod-rollback] %s\n' "$*" >&2; }
if [[ ! -d "$ROLLBACK_ROOT" ]]; then
  printf 'NO_SNAPSHOTS\n'
  exit 0
fi
if ! ls -1d "$ROLLBACK_ROOT"/*/ >/dev/null 2>&1; then
  printf 'NO_SNAPSHOTS\n'
  exit 0
fi
for d in "$ROLLBACK_ROOT"/*/; do
  printf '%s\n' "$(basename "$d")"
done | sort
REMOTE_EOF
}

build_validate_script() {
  local head
  local tail
  head="$(cat <<'REMOTE_EOF'
set -euo pipefail
fatal() { printf '[aod-rollback] FATAL: %s\n' "$*" >&2; exit 1; }
ROLLBACK_ROOT='__ROLLBACK_ROOT__'
SNAPSHOT_ARG='__SNAPSHOT_ARG__'
SNAPSHOT_DIR=''
REMOTE_EOF
)"
  tail="$(cat <<'REMOTE_EOF'
select_snapshot
validate_snapshot
exit 0
REMOTE_EOF
)"
  printf '%s\n%s\n%s\n' "$head" "$VALIDATE_FRAGMENT" "$tail"
}

build_execute_script() {
  local head
  local tail
  head="$(cat <<'REMOTE_EOF'
set -euo pipefail

# Rollback restores ONLY the open-design service image/config from a snapshot.
# Production data, nginx, and every other container are never touched.

fatal() { printf '[aod-rollback] FATAL: %s\n' "$*" >&2; exit 1; }
log() { printf '[aod-rollback] %s\n' "$*" >&2; }
ROLLBACK_ROOT='__ROLLBACK_ROOT__'
SNAPSHOT_ARG='__SNAPSHOT_ARG__'
PROD_PATH='__PROD_PATH__'
COMPOSE_FILE='__COMPOSE_FILE__'
DATA_DIR='__DATA_DIR__'
EXPECTED_VERSION='__EXPECTED_VERSION__'
CONTAINER_NAME='open-design-open-design-1'
SNAPSHOT_DIR=''
REMOTE_EOF
)"
  tail="$(cat <<'REMOTE_EOF'
select_snapshot
validate_snapshot

image_ref="$(cat "$SNAPSHOT_DIR/OPEN_DESIGN_IMAGE")"
log "rolling back open-design to $image_ref from $(basename "$SNAPSHOT_DIR")"

tmp_env="$(mktemp "$PROD_PATH/.env.rollback.XXXXXX")"
chmod 600 "$tmp_env"
cp -p "$SNAPSHOT_DIR/.env" "$tmp_env" || { rm -f "$tmp_env"; fatal "unable to stage the snapshot .env"; }
chmod 600 "$tmp_env"
if ! mv -f "$tmp_env" "$PROD_PATH/.env"; then
  rm -f "$tmp_env"
  fatal "unable to restore the snapshot .env"
fi
chmod 600 "$PROD_PATH/.env"
log "restored snapshot .env atomically"

if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
  log "snapshot image not present locally; pulling it"
  docker pull --platform linux/arm64 "$image_ref" >/dev/null || fatal "unable to pull snapshot image $image_ref"
fi

log "running compose up -d --no-deps for service open-design"
if ! docker compose -p open-design -f "$COMPOSE_FILE" up -d --no-deps open-design >/dev/null 2>&1; then
  printf 'ROLLBACK_FAILED compose up failed\n' >&2
  exit 32
fi

container="$(docker ps -aq --filter "name=^${CONTAINER_NAME}$" --format '{{.ID}}' | head -n 1 || true)"
[[ -n "$container" ]] || { printf 'ROLLBACK_FAILED container missing\n' >&2; exit 32; }

if ! docker exec "$container" node -e '
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
  ' "$EXPECTED_VERSION" >/dev/null 2>&1; then
  printf 'ROLLBACK_FAILED health gate failed\n' >&2
  exit 32
fi

mounts="$(docker inspect --format '{{range .Mounts}}{{.Source}}={{.Destination}}{{println}}{{end}}' "$container")" \
  || { printf 'ROLLBACK_FAILED container inspect failed\n' >&2; exit 32; }
grep -Fxq "$DATA_DIR=/app/.od" <<<"$mounts" \
  || { printf 'ROLLBACK_FAILED data mount missing\n' >&2; exit 32; }

printf 'ROLLED_BACK %s image=%s container=%s\n' "$(basename "$SNAPSHOT_DIR")" "$image_ref" "$container"
exit 0
REMOTE_EOF
)"
  printf '%s\n%s\n%s\n' "$head" "$VALIDATE_FRAGMENT" "$tail"
}

assert_remote_script_has_no_secrets() {
  local script="$1"
  if grep -Eiq '(TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|CREDENTIAL)[[:space:]]*=' <<<"$script"; then
    die "refusing to display a remote script that may carry a secret-bearing assignment"
  fi
}

print_dry_run_summary() {
  local instance_id="$1"
  local mode="$2"
  local snapshot_arg="$3"
  cat >&2 <<EOF
[aod-rollback] DRY_RUN=1 -- NO COMMAND WILL BE SENT TO AWS
[aod-rollback]   mode:     $mode
[aod-rollback]   snapshot: ${snapshot_arg:-<newest by UTC name>}
[aod-rollback]   account:  $AWS_ACCOUNT_ID
[aod-rollback]   region:   $AWS_REGION
[aod-rollback]   instance: $instance_id (SSM Online)
[aod-rollback]   production: $PRODUCTION_PATH
[aod-rollback] remote actions that would run on the host:
[aod-rollback]   list:     enumerate $PRODUCTION_PATH/rollback/*/ snapshot names (read-only)
[aod-rollback]   validate: check snapshot dir mode 700, .env 600, required files, approved image reference, integrity hashes (read-only)
[aod-rollback]   execute:  restore snapshot .env atomically, pull the snapshot image if needed, then
[aod-rollback]             docker compose -p open-design -f docker-compose.prod.yml up -d --no-deps open-design
[aod-rollback]             and verify in-container /api/health + data mount; never touches data/nginx/other containers
[aod-rollback] END DRY_RUN SUMMARY
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
    3) die "no rollback snapshot is available (NO_SNAPSHOTS)" ;;
    32) die "rollback failed on the host (ROLLBACK_FAILED); see remote output above" ;;
    *)
      die "remote script exited with code $response_code (SSM status: $status)"
      ;;
  esac
}

usage() {
  cat >&2 <<'EOF'
usage: rollback.sh --list
       rollback.sh --validate [SNAPSHOT]
       rollback.sh --execute [SNAPSHOT]
       rollback.sh SNAPSHOT
  --list            list available snapshots (read-only, via SSM)
  --validate        validate a snapshot without mutating anything (default: newest by UTC name)
  --execute         restore open-design from a snapshot (default: newest by UTC name)
  SNAPSHOT          a snapshot UTC name such as 20260905T120000Z
EOF
}

MODE="execute"
SNAPSHOT_ARG=""
if (( $# >= 1 )); then
  case "$1" in
    --list) MODE="list" ;;
    --validate) MODE="validate"; [[ $# -ge 2 ]] && SNAPSHOT_ARG="$2" ;;
    --execute) MODE="execute"; [[ $# -ge 2 ]] && SNAPSHOT_ARG="$2" ;;
    --help|-h) usage; exit 0 ;;
    *)
      MODE="execute"
      SNAPSHOT_ARG="$1"
      ;;
  esac
fi
if [[ "$MODE" != "list" && -n "$SNAPSHOT_ARG" ]]; then
  [[ "$SNAPSHOT_ARG" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
    || die "snapshot name must be a UTC timestamp like 20260905T120000Z"
fi

load_constants
require_command aws
require_command base64

check_caller_account
INSTANCE_ID="$(discover_instance)"
check_ssm_online "$INSTANCE_ID"

VALIDATE_FRAGMENT="$(build_validate_fragment)"

case "$MODE" in
  list)
    REMOTE_SCRIPT="$(build_list_script)"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__ROLLBACK_ROOT__/${PRODUCTION_PATH}/rollback}"
    ;;
  validate)
    REMOTE_SCRIPT="$(build_validate_script)"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__ROLLBACK_ROOT__/${PRODUCTION_PATH}/rollback}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__SNAPSHOT_ARG__/${SNAPSHOT_ARG}}"
    ;;
  execute)
    REMOTE_SCRIPT="$(build_execute_script)"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__ROLLBACK_ROOT__/${PRODUCTION_PATH}/rollback}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__SNAPSHOT_ARG__/${SNAPSHOT_ARG}}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__PROD_PATH__/${PRODUCTION_PATH}}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__COMPOSE_FILE__/${PRODUCTION_PATH}/docker-compose.prod.yml}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__DATA_DIR__/${PRODUCTION_PATH}/data}"
    REMOTE_SCRIPT="${REMOTE_SCRIPT//__EXPECTED_VERSION__/${OPENDESIGN_VERSION}}"
    ;;
esac

assert_remote_script_has_no_secrets "$REMOTE_SCRIPT"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  print_dry_run_summary "$INSTANCE_ID" "$MODE" "$SNAPSHOT_ARG"
  printf '%s\n' "$REMOTE_SCRIPT"
  exit 0
fi

run_remote "$REMOTE_SCRIPT" "OpenDesign rollback ($MODE)"
