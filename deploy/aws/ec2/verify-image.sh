#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/app.env"
RUN_ID="aod-verify-$(date +%s)-$$-$RANDOM"
OWNERSHIP_LABEL="io.apexai.opendesign.verify-run"
PROBE_CONTAINER_NAME="${RUN_ID}-probe"
DAEMON_CONTAINER_NAME="${RUN_ID}-daemon"
NETWORK_NAME="${RUN_ID}-network"
VOLUME_NAME="${RUN_ID}-data"
PROBE_CONTAINER_ID=""
DAEMON_CONTAINER_ID=""
NETWORK_ID=""
VOLUME_ID=""

log() {
  printf '[aod-verify] %s\n' "$*" >&2
}

die() {
  printf '[aod-verify] ERROR: %s\n' "$*" >&2
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
  : "${OPENDESIGN_VERSION:?}" "${OPENCODE_VERSION:?}" "${PI_VERSION:?}"
}

is_local_docker_desktop_endpoint() {
  local endpoint="$1"
  case "$endpoint" in
    unix:///var/run/docker.sock|"unix://${HOME}/.docker/run/docker.sock"|"unix://${HOME}/Library/Containers/com.docker.docker/Data/docker-cli.sock")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_local_docker_desktop() {
  [[ "$(uname -s)" == "Darwin" ]] || die "image verification requires a local macOS host"
  [[ "$(uname -m)" == "arm64" ]] || die "image verification requires native Apple Silicon"
  [[ -n "${HOME:-}" ]] || die "HOME is required to identify the Docker Desktop socket"

  local context_name
  local endpoint
  context_name="${DOCKER_CONTEXT:-$(docker context show)}"
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    endpoint="$DOCKER_HOST"
  else
    endpoint="$(docker context inspect "$context_name" --format '{{.Endpoints.docker.Host}}')" \
      || die "unable to resolve Docker context endpoint"
  fi

  is_local_docker_desktop_endpoint "$endpoint" \
    || die "Docker must use a recognized local Docker Desktop Unix socket"
  docker info >/dev/null 2>&1 || die "local Docker Desktop daemon is unavailable"
}

assert_name_unused() {
  local resource_type="$1"
  local resource_name="$2"
  local listing

  case "$resource_type" in
    container)
      listing="$(docker container ls --all --filter "name=^${resource_name}$" --format '{{.Names}}')" \
        || die "unable to list Docker containers"
      ;;
    network)
      listing="$(docker network ls --filter "name=^${resource_name}$" --format '{{.Name}}')" \
        || die "unable to list Docker networks"
      ;;
    volume)
      listing="$(docker volume ls --filter "name=^${resource_name}$" --quiet)" \
        || die "unable to list Docker volumes"
      ;;
    *)
      die "unknown Docker resource type: $resource_type"
      ;;
  esac

  while IFS= read -r existing_name; do
    [[ "$existing_name" != "$resource_name" ]] \
      || die "refusing to adopt existing Docker $resource_type: $resource_name"
  done <<<"$listing"
}

container_is_owned() {
  local container_id="$1"
  local actual_id
  local actual_label
  actual_id="$(docker container inspect --format '{{.Id}}' "$container_id" 2>/dev/null)" || return 1
  actual_label="$(docker container inspect --format "{{ index .Config.Labels \"$OWNERSHIP_LABEL\" }}" "$container_id" 2>/dev/null)" || return 1
  [[ "$actual_id" == "$container_id" && "$actual_label" == "$RUN_ID" ]]
}

network_is_owned() {
  local network_id="$1"
  local actual_id
  local actual_label
  actual_id="$(docker network inspect --format '{{.Id}}' "$network_id" 2>/dev/null)" || return 1
  actual_label="$(docker network inspect --format "{{ index .Labels \"$OWNERSHIP_LABEL\" }}" "$network_id" 2>/dev/null)" || return 1
  [[ "$actual_id" == "$network_id" && "$actual_label" == "$RUN_ID" ]]
}

volume_is_owned() {
  local volume_id="$1"
  local actual_name
  local actual_label
  actual_name="$(docker volume inspect --format '{{.Name}}' "$volume_id" 2>/dev/null)" || return 1
  actual_label="$(docker volume inspect --format "{{ index .Labels \"$OWNERSHIP_LABEL\" }}" "$volume_id" 2>/dev/null)" || return 1
  [[ "$actual_name" == "$volume_id" && "$actual_label" == "$RUN_ID" ]]
}

assert_owned_container() {
  container_is_owned "$1" || die "Docker container ownership check failed"
}

assert_owned_network() {
  network_is_owned "$1" || die "Docker network ownership check failed"
}

assert_owned_volume() {
  volume_is_owned "$1" || die "Docker volume ownership check failed"
}

cleanup() {
  if [[ -n "$DAEMON_CONTAINER_ID" ]]; then
    if container_is_owned "$DAEMON_CONTAINER_ID"; then
      docker container rm --force "$DAEMON_CONTAINER_ID" >/dev/null 2>&1 \
        || log "failed to remove owned daemon container $DAEMON_CONTAINER_ID"
    else
      log "refusing to remove daemon container whose ownership cannot be verified"
    fi
  fi
  if [[ -n "$PROBE_CONTAINER_ID" ]]; then
    if container_is_owned "$PROBE_CONTAINER_ID"; then
      docker container rm --force "$PROBE_CONTAINER_ID" >/dev/null 2>&1 \
        || log "failed to remove owned probe container $PROBE_CONTAINER_ID"
    else
      log "refusing to remove probe container whose ownership cannot be verified"
    fi
  fi
  if [[ -n "$VOLUME_ID" ]]; then
    if volume_is_owned "$VOLUME_ID"; then
      docker volume rm "$VOLUME_ID" >/dev/null 2>&1 \
        || log "failed to remove owned verification volume $VOLUME_ID"
    else
      log "refusing to remove volume whose ownership cannot be verified"
    fi
  fi
  if [[ -n "$NETWORK_ID" ]]; then
    if network_is_owned "$NETWORK_ID"; then
      docker network rm "$NETWORK_ID" >/dev/null 2>&1 \
        || log "failed to remove owned verification network $NETWORK_ID"
    else
      log "refusing to remove network whose ownership cannot be verified"
    fi
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if (( $# > 1 )); then
  printf 'usage: %s [image-reference]\n' "$0" >&2
  exit 64
fi

load_constants
require_command docker
require_command curl
require_command jq
require_local_docker_desktop

assert_name_unused container "$PROBE_CONTAINER_NAME"
assert_name_unused container "$DAEMON_CONTAINER_NAME"
assert_name_unused network "$NETWORK_NAME"
assert_name_unused volume "$VOLUME_NAME"

registry="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
image_reference="${1:-${registry}/${ECR_REPOSITORY}:${IMAGE_TAG}}"
[[ "$image_reference" == */*:* || "$image_reference" == *@sha256:* ]] \
  || die "provide a fully qualified image reference by tag or sha256 digest"

log "pulling the linux/arm64 image from ECR"
docker pull --platform linux/arm64 "$image_reference" >/dev/null

image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_reference")"
[[ "$image_platform" == "linux/arm64" ]] \
  || die "unexpected image platform: $image_platform"

image_user="$(docker image inspect --format '{{.Config.User}}' "$image_reference")"
[[ "$image_user" == "1001:1001" ]] \
  || die "unexpected default image user: $image_user"

image_home=""
while IFS= read -r env_entry; do
  case "$env_entry" in
    HOME=*) image_home="${env_entry#HOME=}" ;;
  esac
done < <(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image_reference")
[[ "HOME=$image_home" == "HOME=/app/.od" ]] \
  || die "unexpected image HOME: $image_home"

probe_script='
set -eu
opencode_version="$(opencode --version | tr -d "\r\n")"
opencode_cli_version="$(opencode-cli --version | tr -d "\r\n")"
pi_version="$(pi --version | tr -d "\r\n")"
[ "$opencode_version" = "$EXPECTED_OPENCODE_VERSION" ] || { printf "unexpected opencode version: %s\n" "$opencode_version" >&2; exit 11; }
[ "$opencode_cli_version" = "$EXPECTED_OPENCODE_VERSION" ] || { printf "unexpected opencode-cli version: %s\n" "$opencode_cli_version" >&2; exit 12; }
[ "$pi_version" = "$EXPECTED_PI_VERSION" ] || { printf "unexpected pi version: %s\n" "$pi_version" >&2; exit 13; }
if command -v vela >/dev/null 2>&1; then
  printf "prohibited agent CLI is installed\n" >&2
  exit 14
fi
command -v apk >/dev/null 2>&1 || { printf "apk package inventory is unavailable\n" >&2; exit 15; }
for compatibility_package in gcompat libc6-compat; do
  if apk info --exists "$compatibility_package" >/dev/null 2>&1; then
    printf "prohibited compatibility package is installed: %s\n" "$compatibility_package" >&2
    exit 16
  else
    apk_status=$?
    if [ "$apk_status" -ne 1 ]; then
      printf "compatibility package inventory failed for %s (status %s)\n" "$compatibility_package" "$apk_status" >&2
      exit 17
    fi
  fi
done
'

PROBE_CONTAINER_ID="$(docker create \
  --name "$PROBE_CONTAINER_NAME" \
  --label "$OWNERSHIP_LABEL=$RUN_ID" \
  --env "EXPECTED_OPENCODE_VERSION=$OPENCODE_VERSION" \
  --env "EXPECTED_PI_VERSION=$PI_VERSION" \
  --entrypoint /bin/sh \
  "$image_reference" \
  -lc "$probe_script")"
[[ -n "$PROBE_CONTAINER_ID" ]] || die "failed to create the CLI probe container"
assert_owned_container "$PROBE_CONTAINER_ID"
docker start --attach "$PROBE_CONTAINER_ID"
assert_owned_container "$PROBE_CONTAINER_ID"
docker container rm "$PROBE_CONTAINER_ID" >/dev/null
PROBE_CONTAINER_ID=""

NETWORK_ID="$(docker network create \
  --label "$OWNERSHIP_LABEL=$RUN_ID" \
  "$NETWORK_NAME")"
[[ -n "$NETWORK_ID" ]] || die "failed to create the verification network"
assert_owned_network "$NETWORK_ID"
VOLUME_ID="$(docker volume create \
  --label "$OWNERSHIP_LABEL=$RUN_ID" \
  "$VOLUME_NAME")"
[[ "$VOLUME_ID" == "$VOLUME_NAME" ]] || die "failed to create the verification volume"
assert_owned_volume "$VOLUME_ID"
assert_owned_network "$NETWORK_ID"
assert_owned_volume "$VOLUME_ID"

DAEMON_CONTAINER_ID="$(docker create \
  --name "$DAEMON_CONTAINER_NAME" \
  --label "$OWNERSHIP_LABEL=$RUN_ID" \
  --network "$NETWORK_ID" \
  --mount "type=volume,source=$VOLUME_ID,target=/app/.od" \
  --publish 127.0.0.1::7456 \
  "$image_reference")"
[[ -n "$DAEMON_CONTAINER_ID" ]] || die "failed to create the daemon container"
assert_owned_container "$DAEMON_CONTAINER_ID"
docker start "$DAEMON_CONTAINER_ID" >/dev/null

published_port="$(docker port "$DAEMON_CONTAINER_ID" 7456/tcp)"
runtime_port="${published_port##*:}"
[[ "$runtime_port" =~ ^[0-9]+$ ]] || die "could not resolve the daemon's temporary host port"
base_url="http://127.0.0.1:${runtime_port}"
health_json=""
health_deadline=$((SECONDS + 60))

while ((SECONDS < health_deadline)); do
  if health_json="$(curl --fail --silent --show-error --max-time 3 "$base_url/api/health" 2>/dev/null)" \
    && jq -e --arg version "$OPENDESIGN_VERSION" \
      '.ok == true and .version == $version' >/dev/null <<<"$health_json"; then
    break
  fi
  health_json=""
  sleep 1
done

if [[ -z "$health_json" ]]; then
  docker logs "$DAEMON_CONTAINER_ID" >&2 || true
  die "official daemon did not return /api/health version $OPENDESIGN_VERSION"
fi

agents_json="$(curl --fail --silent --show-error --max-time 90 "$base_url/api/agents")" \
  || die "official daemon did not return /api/agents"
for agent_id in opencode byok-opencode pi; do
  jq -e --arg id "$agent_id" \
    'any(.agents[]?; .id == $id and .available == true)' >/dev/null <<<"$agents_json" \
    || die "/api/agents did not report $agent_id available"
done

printf 'verified %s\n' "$image_reference"
