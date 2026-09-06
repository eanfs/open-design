#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONFIG_FILE="$SCRIPT_DIR/app.env"
DOCKERFILE="$SCRIPT_DIR/Dockerfile.agents"
SCAN_TIMEOUT_SECONDS="${AOD_SCAN_TIMEOUT_SECONDS:-600}"
SCAN_POLL_SECONDS="${AOD_SCAN_POLL_SECONDS:-5}"

log() {
  printf '[aod-image] %s\n' "$*" >&2
}

die() {
  printf '[aod-image] ERROR: %s\n' "$*" >&2
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
  : "${OPENDESIGN_VERSION:?}" "${OPENCODE_VERSION:?}" "${PI_VERSION:?}" "${BASE_IMAGE_DIGEST:?}"
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

resolve_context_endpoint() {
  local context_name="$1"
  docker context inspect "$context_name" --format '{{.Endpoints.docker.Host}}'
}

require_local_docker_desktop() {
  [[ "$(uname -s)" == "Darwin" ]] || die "image delivery requires a local macOS host"
  [[ "$(uname -m)" == "arm64" ]] || die "image delivery requires native Apple Silicon"
  [[ -n "${HOME:-}" ]] || die "HOME is required to identify the Docker Desktop socket"

  local context_name
  local endpoint
  context_name="${DOCKER_CONTEXT:-$(docker context show)}"
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    endpoint="$DOCKER_HOST"
  else
    endpoint="$(resolve_context_endpoint "$context_name")" \
      || die "unable to resolve Docker context endpoint"
  fi

  is_local_docker_desktop_endpoint "$endpoint" \
    || die "Docker must use a recognized local Docker Desktop Unix socket"
  docker info >/dev/null 2>&1 || die "local Docker Desktop daemon is unavailable"
}

require_local_buildx_builder() {
  local builder_details
  local builder_driver=""
  local field
  local value
  local ignored
  local endpoint_count=0
  local node_endpoint

  builder_details="$(docker buildx inspect 2>&1)" || die "unable to inspect the active buildx builder"
  while IFS= read -r line; do
    read -r field value ignored <<<"$line"
    case "$field" in
      Driver:)
        builder_driver="$value"
        ;;
      Endpoint:)
        endpoint_count=$((endpoint_count + 1))
        node_endpoint="$value"
        case "$node_endpoint" in
          unix://*)
            ;;
          *://*)
            die "active buildx node uses a remote endpoint"
            ;;
          *)
            node_endpoint="$(resolve_context_endpoint "$node_endpoint")" \
              || die "unable to resolve the active buildx node context"
            ;;
        esac
        is_local_docker_desktop_endpoint "$node_endpoint" \
          || die "active buildx node is not on local Docker Desktop"
        ;;
    esac
  done <<<"$builder_details"

  case "$builder_driver" in
    docker|docker-container)
      ;;
    *)
      die "active buildx driver must be local docker or docker-container"
      ;;
  esac
  ((endpoint_count > 0)) || die "active buildx builder reported no nodes"
}

apply_scan_findings_gate() {
  local critical_count="$1"
  local high_count="$2"

  [[ "$critical_count" =~ ^[0-9]+$ && "$high_count" =~ ^[0-9]+$ ]] \
    || die "ECR scan returned invalid severity counts"
  if ((critical_count > 0)); then
    die "ECR scan reported $critical_count Critical findings"
  fi
  if ((high_count > 0)); then
    log "manual review required: ECR scan reported $high_count High findings"
    exit 3
  fi
  log "ECR scan complete: 0 Critical, 0 High"
}

wait_for_ecr_scan() {
  local digest="$1"
  local deadline=$((SECONDS + SCAN_TIMEOUT_SECONDS))
  local scan_result
  local scan_status
  local critical_count
  local high_count

  log "waiting for the ECR BASIC scan of $digest"
  while ((SECONDS < deadline)); do
    if scan_result="$(aws ecr describe-image-scan-findings \
      --region "$AWS_REGION" \
      --repository-name "$ECR_REPOSITORY" \
      --image-id "imageDigest=$digest" \
      --query '[imageScanStatus.status, imageScanFindings.findingSeverityCounts.CRITICAL || `0`, imageScanFindings.findingSeverityCounts.HIGH || `0`]' \
      --output text 2>&1)"; then
      read -r scan_status critical_count high_count <<<"$scan_result"
      case "$scan_status" in
        COMPLETE)
          apply_scan_findings_gate "$critical_count" "$high_count"
          return 0
          ;;
        IN_PROGRESS|PENDING)
          ;;
        ACTIVE)
          die "ECR returned enhanced-scan status ACTIVE; only BASIC scanning is supported"
          ;;
        FAILED|UNSUPPORTED_IMAGE|SCAN_ELIGIBILITY_EXPIRED|FINDINGS_UNAVAILABLE|LIMIT_EXCEEDED)
          die "ECR BASIC scan did not complete successfully (status: $scan_status)"
          ;;
        *)
          die "ECR BASIC scan returned an unknown status"
          ;;
      esac
    elif [[ "$scan_result" != *ScanNotFoundException* ]]; then
      die "unable to read ECR BASIC scan status"
    fi

    sleep "$SCAN_POLL_SECONDS"
  done

  die "ECR BASIC scan timed out after $SCAN_TIMEOUT_SECONDS seconds"
}

load_constants
[[ "$SCAN_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "scan timeout must be a positive integer"
[[ "$SCAN_POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "scan poll interval must be a positive integer"

require_command docker
require_command aws
docker buildx version >/dev/null 2>&1 || die "Docker buildx is required"
require_local_docker_desktop
require_local_buildx_builder

caller_account="$(aws sts get-caller-identity \
  --region "$AWS_REGION" \
  --query Account \
  --output text)"
[[ "$caller_account" == "$AWS_ACCOUNT_ID" ]] \
  || die "AWS account mismatch: expected $AWS_ACCOUNT_ID"

registry_scan_details="$(aws ecr get-registry-scanning-configuration \
  --region "$AWS_REGION" \
  --query '[scanningConfiguration.scanType, length(scanningConfiguration.rules)]' \
  --output text)" || die "unable to inspect ECR registry scanning configuration"
read -r registry_scan_type registry_scan_rule_count <<<"$registry_scan_details"
[[ "$registry_scan_type" == "BASIC" ]] \
  || die "ECR registry scan type must be BASIC; enhanced scanning is not supported"
[[ "$registry_scan_rule_count" == "0" ]] \
  || die "ECR BASIC registry scanning configuration must not contain enhanced rules"

repository_details="$(aws ecr describe-repositories \
  --region "$AWS_REGION" \
  --repository-names "$ECR_REPOSITORY" \
  --query 'repositories[0].[repositoryUri,imageTagMutability,encryptionConfiguration.encryptionType,imageScanningConfiguration.scanOnPush]' \
  --output text)" || die "ECR repository not found: $ECR_REPOSITORY"
read -r repository_uri tag_mutability encryption_type scan_on_push <<<"$repository_details"
[[ -n "$repository_uri" && "$repository_uri" != "None" ]] || die "ECR repository URI is missing"
[[ "$tag_mutability" == "IMMUTABLE" ]] || die "ECR repository must use immutable tags"
[[ "$encryption_type" == "KMS" ]] || die "ECR repository must use KMS encryption"
case "$scan_on_push" in
  true|True|TRUE)
    ;;
  *)
    die "ECR repository must scan on push"
    ;;
esac

expected_repository_uri="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
[[ "$repository_uri" == "$expected_repository_uri" ]] \
  || die "ECR repository URI does not match the approved account and region"
tagged_reference="${repository_uri}:${IMAGE_TAG}"

if existing_digest="$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text 2>&1)"; then
  die "immutable target tag already exists: $tagged_reference ($existing_digest)"
elif [[ "$existing_digest" != *ImageNotFoundException* ]]; then
  die "unable to prove that the immutable target tag is unused"
fi

log "authenticating Docker to the approved ECR registry"
if ! aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" >/dev/null; then
  die "ECR authentication failed"
fi

log "building and pushing $tagged_reference"
docker buildx build \
  --pull \
  --platform linux/arm64 \
  --provenance=false \
  --file "$DOCKERFILE" \
  --tag "$tagged_reference" \
  --push \
  "$REPO_ROOT"

image_digest="$(aws ecr describe-images \
  --region "$AWS_REGION" \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$IMAGE_TAG" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || die "ECR did not resolve exactly one valid image digest for the pushed tag"
digest_reference="${repository_uri}@${image_digest}"

wait_for_ecr_scan "$image_digest"

printf '%s\n' "$tagged_reference"
printf '%s\n' "$digest_reference"
