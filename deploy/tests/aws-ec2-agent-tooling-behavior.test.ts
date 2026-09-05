import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const repoRoot = join(import.meta.dirname, '../..');
const buildPushPath = join(repoRoot, 'deploy/aws/ec2/build-push.sh');
const verifyImagePath = join(repoRoot, 'deploy/aws/ec2/verify-image.sh');

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
state_dir="$FAKE_STATE_DIR"
[ -n "$state_dir" ] || { echo "FAKE_STATE_DIR is unset" >&2; exit 2; }
printf 'docker %s\n' "$*" >> "$state_dir/commands.log"

ctx="$FAKE_DOCKER_CONTEXT"
[ -n "$ctx" ] || ctx="default"
ctx_host="$FAKE_DOCKER_CONTEXT_HOST"
[ -n "$ctx_host" ] || ctx_host="unix://$HOME/.docker/run/docker.sock"
collide="$FAKE_COLLIDE"

last_arg() {
  local a
  a=""
  for a in "$@"; do :; done
  printf '%s' "$a"
}

label_value() {
  printf '%s\n' "$1" | sed 's/^[^=]*=//'
}

filter_name() {
  printf '%s\n' "$1" | sed 's/^name=^//; s/\$$//'
}

case "$1" in
  context)
    if [ "$2" = "show" ]; then
      printf '%s\n' "$ctx"
    elif [ "$2" = "inspect" ]; then
      printf '%s\n' "$ctx_host"
    fi
    exit 0
    ;;
  info) exit 0 ;;
  version) exit 0 ;;
  login) exit 0 ;;
  pull) exit 0 ;;
  image)
    case "$*" in
      *"{{.Os}}/{{.Architecture}}"*) printf 'linux/arm64\n' ;;
      *"{{.Config.User}}"*) printf '1001:1001\n' ;;
      *"{{range .Config.Env}}"*) printf 'HOME=/app/.od\n' ;;
    esac
    exit 0
    ;;
  network)
    if [ "$2" = "create" ]; then
      label=""
      prev=""
      for arg in "$@"; do
        [ "$prev" = "--label" ] && label="$arg"
        prev="$arg"
      done
      id="net-$(date +%s)-$RANDOM"
      printf '%s\n' "$id"
      printf '%s|%s\n' "$id" "$(label_value "$label")" >> "$state_dir/networks"
    elif [ "$2" = "inspect" ]; then
      id="$(last_arg "$@")"
      if [[ "$*" == *"{{.Id}}"* ]]; then
        printf '%s\n' "$id"
      elif [[ "$*" == *"{{ index .Labels"* ]]; then
        awk -F'|' -v id="$id" '$1==id {print $2}' "$state_dir/networks"
      fi
    elif [ "$2" = "ls" ]; then
      if [ "$collide" = "network" ]; then
        for arg in "$@"; do
          case "$arg" in
            name=^*) printf '%s\n' "$(filter_name "$arg")" ;;
          esac
        done
      fi
    elif [ "$2" = "rm" ]; then
      :
    fi
    exit 0
    ;;
  volume)
    if [ "$2" = "create" ]; then
      label=""
      prev=""
      for arg in "$@"; do
        [ "$prev" = "--label" ] && label="$arg"
        prev="$arg"
      done
      name="$(last_arg "$@")"
      printf '%s\n' "$name"
      printf '%s|%s\n' "$name" "$(label_value "$label")" >> "$state_dir/volumes"
    elif [ "$2" = "inspect" ]; then
      name="$(last_arg "$@")"
      if [[ "$*" == *"{{.Name}}"* ]]; then
        printf '%s\n' "$name"
      elif [[ "$*" == *"{{ index .Labels"* ]]; then
        awk -F'|' -v n="$name" '$1==n {print $2}' "$state_dir/volumes"
      fi
    elif [ "$2" = "ls" ]; then
      if [ "$collide" = "volume" ]; then
        for arg in "$@"; do
          case "$arg" in
            name=^*) printf '%s\n' "$(filter_name "$arg")" ;;
          esac
        done
      fi
    elif [ "$2" = "rm" ]; then
      :
    fi
    exit 0
    ;;
  container)
    if [ "$2" = "ls" ]; then
      if [ "$collide" = "container" ]; then
        for arg in "$@"; do
          case "$arg" in
            name=^*) printf '%s\n' "$(filter_name "$arg")" ;;
          esac
        done
      fi
      exit 0
    fi
    if [ "$2" = "inspect" ]; then
      id="$(last_arg "$@")"
      if [[ "$*" == *"{{.Id}}"* ]]; then
        printf '%s\n' "$id"
      elif [[ "$*" == *"{{ index .Config.Labels"* ]]; then
        awk -F'|' -v id="$id" '$1==id {print $3}' "$state_dir/containers"
      fi
      exit 0
    fi
    if [ "$2" = "rm" ]; then
      :
    fi
    exit 0
    ;;
  buildx)
    case "$2" in
      version) exit 0 ;;
      inspect) printf '%s' "$FAKE_BUILDX_INSPECT" ;;
      build) exit 0 ;;
    esac
    exit 0
    ;;
  create)
    name=""
    label=""
    script=""
    prev=""
    for arg in "$@"; do
      case "$prev" in
        --name) name="$arg" ;;
        --label) label="$arg" ;;
        --env) printf '%s\n' "$arg" >> "$state_dir/probe-env" ;;
        -lc) script="$arg" ;;
      esac
      prev="$arg"
    done
    if [[ "$name" == *-probe ]]; then
      id="probe-$(date +%s)-$RANDOM"
      printf '%s\n' "$script" > "$state_dir/probe-script.sh"
      printf '%s|%s|%s\n' "$id" "$name" "$(label_value "$label")" >> "$state_dir/containers"
      printf '%s\n' "$id"
    else
      id="daemon-$(date +%s)-$RANDOM"
      printf '%s|%s|%s\n' "$id" "$name" "$(label_value "$label")" >> "$state_dir/containers"
      printf '%s\n' "$id"
    fi
    exit 0
    ;;
  start)
    if [ "$2" = "--attach" ]; then
      id="$3"
    else
      id="$2"
    fi
    if [[ "$id" == probe-* ]]; then
      if [ -f "$state_dir/probe-env" ]; then
        while IFS= read -r line; do
          export "$line"
        done < "$state_dir/probe-env"
      fi
      bash "$state_dir/probe-script.sh"
      exit $?
    fi
    exit 0
    ;;
  port)
    printf '127.0.0.1:43210\n'
    exit 0
    ;;
  logs) exit 0 ;;
  *) exit 0 ;;
esac
`;

const FAKE_AWS = String.raw`#!/usr/bin/env bash
state_dir="$FAKE_STATE_DIR"
[ -n "$state_dir" ] || { echo "FAKE_STATE_DIR is unset" >&2; exit 2; }
printf 'aws %s\n' "$*" >> "$state_dir/aws.log"

account="$FAKE_AWS_ACCOUNT"
[ -n "$account" ] || account="389656352076"
scan_type="$FAKE_SCAN_TYPE"
[ -n "$scan_type" ] || scan_type="BASIC"
scan_rules="$FAKE_SCAN_RULES"
[ -n "$scan_rules" ] || scan_rules="0"
repo_uri="$FAKE_REPO_URI"
[ -n "$repo_uri" ] || repo_uri="389656352076.dkr.ecr.ap-southeast-1.amazonaws.com/apexai-opendesign"
tag_mutability="$FAKE_TAG_MUTABILITY"
[ -n "$tag_mutability" ] || tag_mutability="IMMUTABLE"
encryption="$FAKE_ENCRYPTION"
[ -n "$encryption" ] || encryption="KMS"
scan_on_push="$FAKE_SCAN_ON_PUSH"
[ -n "$scan_on_push" ] || scan_on_push="true"
tag_exists="$FAKE_TAG_EXISTS"
[ -n "$tag_exists" ] || tag_exists="0"
digest="$FAKE_DIGEST"
[ -n "$digest" ] || digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
scan_sequence="$FAKE_SCAN_SEQUENCE"
[ -n "$scan_sequence" ] || scan_sequence="COMPLETE"
crit_count="$FAKE_CRIT_COUNT"
[ -n "$crit_count" ] || crit_count="0"
high_count="$FAKE_HIGH_COUNT"
[ -n "$high_count" ] || high_count="0"

service="$1"
command="$2"
case "$service:$command" in
  sts:get-caller-identity)
    printf '%s\n' "$account"
    exit 0
    ;;
  ecr:get-registry-scanning-configuration)
    printf '%s\t%s\n' "$scan_type" "$scan_rules"
    exit 0
    ;;
  ecr:describe-repositories)
    printf '%s\t%s\t%s\t%s\n' "$repo_uri" "$tag_mutability" "$encryption" "$scan_on_push"
    exit 0
    ;;
  ecr:describe-images)
    count_file="$state_dir/describe-images-count"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    if [[ "$tag_exists" == "1" ]]; then
      printf '%s\n' "$digest"
      exit 0
    fi
    if (( count == 1 )); then
      printf '%s\n' "An error occurred (ImageNotFoundException) when calling the DescribeImages operation"
      exit 255
    fi
    printf '%s\n' "$digest"
    exit 0
    ;;
  ecr:get-login-password)
    printf '%s\n' "MOCKPASSWORD"
    exit 0
    ;;
  ecr:describe-image-scan-findings)
    seq_file="$state_dir/scan-sequence"
    if [[ ! -f "$seq_file" ]]; then
      printf '%s\n' "$scan_sequence" | tr ',' '\n' > "$seq_file"
    fi
    prev_file="$state_dir/scan-prev"
    status="$(head -1 "$seq_file" 2>/dev/null)"
    if [[ -n "$status" ]]; then
      tail -n +2 "$seq_file" > "$seq_file.tmp" 2>/dev/null || true
      mv "$seq_file.tmp" "$seq_file"
      printf '%s\n' "$status" > "$prev_file"
    else
      status="$(head -1 "$prev_file" 2>/dev/null)"
      [[ -n "$status" ]] || status="COMPLETE"
    fi
    case "$status" in
      ScanNotFound)
        printf '%s\n' "An error occurred (ScanNotFoundException) ..."
        exit 255
        ;;
      COMPLETE)
        printf 'COMPLETE\t%s\t%s\n' "$crit_count" "$high_count"
        exit 0
        ;;
      *)
        printf '%s\t0\t0\n' "$status"
        exit 0
        ;;
    esac
    ;;
  *)
    printf 'unexpected aws command: %s %s\n' "$service" "$command" >&2
    exit 2
    ;;
esac
`;

const FAKE_CURL = String.raw`#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in
    http://*) url="$arg" ;;
  esac
done
case "$url" in
  */api/health*) printf '{"ok":true,"version":"0.21.1"}\n' ;;
  */api/agents*) printf '{"agents":[{"id":"opencode","available":true},{"id":"byok-opencode","available":true},{"id":"pi","available":true}]}\n' ;;
  *) exit 1 ;;
esac
exit 0
`;

const FAKES = {
  uname: String.raw`#!/usr/bin/env bash
os="$FAKE_UNAME_S"
[ -n "$os" ] || os="Darwin"
arch="$FAKE_UNAME_M"
[ -n "$arch" ] || arch="arm64"
case "$1" in
  -s) printf '%s\n' "$os" ;;
  -m) printf '%s\n' "$arch" ;;
esac
`,
  docker: FAKE_DOCKER,
  aws: FAKE_AWS,
  curl: FAKE_CURL,
  jq: '#!/usr/bin/env bash\nexit 0\n',
  opencode: '#!/usr/bin/env bash\nprintf "1.18.29\\n"\n',
  'opencode-cli': '#!/usr/bin/env bash\nprintf "1.18.29\\n"\n',
  pi: '#!/usr/bin/env bash\nprintf "0.85.1\\n"\n',
  apk: String.raw`#!/usr/bin/env bash
mode="$FAKE_APK_MODE"
[ -n "$mode" ] || mode="absent"
case "$mode" in
  installed) exit 0 ;;
  absent) exit 1 ;;
  error) exit 2 ;;
esac
`,
};

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stateDir: string;
}

async function runTooling(
  scriptPath: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'aod-tooling-'));
  const binDir = join(tempDir, 'bin');
  const stateDir = join(tempDir, 'state');
  await mkdir(binDir);
  await mkdir(stateDir);

  for (const [name, body] of Object.entries(FAKES)) {
    await writeFile(join(binDir, name), body, { mode: 0o755 });
  }

  const { code, stdout, stderr } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: {
        ...process.env,
        HOME: '/Users/mockhome',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_STATE_DIR: stateDir,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
  });

  return { code, stdout, stderr, stateDir };
}

async function readLog(stateDir: string, name: string): Promise<string> {
  try {
    return await readFile(join(stateDir, name), 'utf8');
  } catch {
    return '';
  }
}

function dockerLog(result: RunResult): Promise<string> {
  return readLog(result.stateDir, 'commands.log');
}

function awsLog(result: RunResult): Promise<string> {
  return readLog(result.stateDir, 'aws.log');
}

const LOCAL_BUILDX_INSPECT = `Name:   default
Driver: docker
Nodes:
Name:    default
Endpoint: unix:///Users/mockhome/.docker/run/docker.sock
Status:  running
`;

test('publisher rejects a Linux ARM64 host before any mutation', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_UNAME_S: 'Linux',
    FAKE_UNAME_M: 'aarch64',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /macOS host/);
  const aws = await awsLog(result);
  const docker = await dockerLog(result);
  assert.doesNotMatch(aws, /get-caller-identity/);
  assert.doesNotMatch(docker, /buildx build/);
});

test('publisher rejects a remote DOCKER_HOST before any mutation', async () => {
  const result = await runTooling(buildPushPath, [], {
    DOCKER_HOST: 'tcp://10.0.0.9:2375',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /local Docker Desktop/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
});

test('publisher rejects a remote Docker context before any mutation', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_DOCKER_CONTEXT_HOST: 'ssh://user@example.com:22/run/docker.sock',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /local Docker Desktop/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
});

test('publisher rejects a remote buildx node before any mutation', async () => {
  const remoteBuilder = `Name:   od-builder
Driver: docker-container
Nodes:
Name:    od-builder0
Endpoint: tcp://10.0.0.20:2375
Status:  running
`;
  const result = await runTooling(buildPushPath, [], {
    FAKE_BUILDX_INSPECT: remoteBuilder,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /remote endpoint/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
  const aws = await awsLog(result);
  assert.doesNotMatch(aws, /get-login-password/);
});

test('publisher rejects a non-local buildx driver before any mutation', async () => {
  const cloudBuilder = `Name:   cloud-builder
Driver: cloud
Nodes:
Name:    cloud-builder0
Endpoint: unix:///Users/mockhome/.docker/run/docker.sock
Status:  running
`;
  const result = await runTooling(buildPushPath, [], {
    FAKE_BUILDX_INSPECT: cloudBuilder,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /driver must be local/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
});

test('publisher enforces BASIC-only registry scanning and rejects enhanced', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_TYPE: 'ENHANCED',
    FAKE_SCAN_RULES: '2',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /scan type must be BASIC/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
  const aws = await awsLog(result);
  assert.doesNotMatch(aws, /get-login-password/);
});

test('publisher refuses an already-existing immutable target tag', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_TAG_EXISTS: '1',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists/);
  const aws = await awsLog(result);
  assert.doesNotMatch(aws, /get-login-password/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /buildx build/);
});

test('publisher pushes and resolves a digest through a normal scan sequence', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'ScanNotFound,IN_PROGRESS,COMPLETE',
    AOD_SCAN_POLL_SECONDS: '1',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /:od-0\.21\.1-opencode-1\.18\.29-pi-0\.85\.1-r1$/);
  assert.match(lines[1], /@sha256:[0-9a-f]{64}$/);
  const docker = await dockerLog(result);
  const loginIndex = docker.indexOf('login');
  const buildIndex = docker.indexOf('buildx build');
  assert.ok(loginIndex >= 0 && buildIndex > loginIndex, 'login must precede the build');
  const aws = await awsLog(result);
  const scanIndex = aws.indexOf('describe-image-scan-findings');
  assert.ok(scanIndex > buildIndex, 'scan polling must follow the push');
});

test('publisher rejects ACTIVE enhanced-scan status', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'ACTIVE',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ACTIVE/);
});

test('publisher fails closed on unsupported or failed scan statuses', async () => {
  for (const status of ['FAILED', 'UNSUPPORTED_IMAGE']) {
    const result = await runTooling(buildPushPath, [], {
      FAKE_SCAN_SEQUENCE: status,
      FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
    });
    assert.equal(result.code, 1, status);
    assert.match(result.stderr, /did not complete successfully/);
  }
});

test('publisher blocks Critical findings', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'COMPLETE',
    FAKE_CRIT_COUNT: '2',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Critical/);
});

test('publisher exits 3 for High findings requiring manual review', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'COMPLETE',
    FAKE_HIGH_COUNT: '1',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /manual review/);
});

test('publisher fails on malformed scan severity counts', async () => {
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'COMPLETE',
    FAKE_CRIT_COUNT: 'abc',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid severity counts/);
});

test('publisher scan times out with a bounded window', async () => {
  const startedAt = Date.now();
  const result = await runTooling(buildPushPath, [], {
    FAKE_SCAN_SEQUENCE: 'ScanNotFound',
    AOD_SCAN_TIMEOUT_SECONDS: '1',
    AOD_SCAN_POLL_SECONDS: '1',
    FAKE_BUILDX_INSPECT: LOCAL_BUILDX_INSPECT,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out/);
  assert.ok(elapsedMs < 10_000, `bounded scan timeout took ${elapsedMs}ms`);
});

test('verifier rejects a remote Docker host before the pull', async () => {
  const result = await runTooling(verifyImagePath, [], {
    DOCKER_HOST: 'ssh://user@example.com:22/run/docker.sock',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /local Docker Desktop/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /pull/);
  assert.doesNotMatch(docker, /create/);
});

test('verifier aborts on a colliding volume name without mounting or deleting it', async () => {
  const result = await runTooling(verifyImagePath, [], {
    FAKE_COLLIDE: 'volume',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to adopt existing Docker volume/);
  const docker = await dockerLog(result);
  assert.doesNotMatch(docker, /pull/);
  assert.doesNotMatch(docker, /volume create/);
  assert.doesNotMatch(docker, /volume rm/);
});

test('verifier probe treats an installed compatibility package as a failure', async () => {
  const result = await runTooling(verifyImagePath, [], {
    FAKE_APK_MODE: 'installed',
  });
  assert.equal(result.code, 16);
  assert.match(result.stderr, /prohibited compatibility package is installed: gcompat/);
});

test('verifier probe fails when the package inventory check errors', async () => {
  const result = await runTooling(verifyImagePath, [], {
    FAKE_APK_MODE: 'error',
  });
  assert.equal(result.code, 17);
  assert.match(result.stderr, /compatibility package inventory failed/);
});

test('verifier passes when the image and daemon gates hold and cleans up owned resources', async () => {
  const result = await runTooling(verifyImagePath, []);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^verified /);
  const docker = await dockerLog(result);
  assert.match(docker, /pull/);
  assert.match(docker, /network create/);
  assert.match(docker, /volume create/);
  assert.match(docker, /network rm/);
  assert.match(docker, /volume rm/);
  assert.match(docker, /container rm/);
});
