import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = join(import.meta.dirname, '../..');
const dockerfilePath = join(repoRoot, 'deploy/aws/ec2/Dockerfile.agents');
const ec2DeployDir = join(repoRoot, 'deploy/aws/ec2');
const appEnvPath = join(ec2DeployDir, 'app.env');
const buildPushPath = join(ec2DeployDir, 'build-push.sh');
const verifyImagePath = join(ec2DeployDir, 'verify-image.sh');
const deployPath = join(ec2DeployDir, 'deploy.sh');
const rollbackPath = join(ec2DeployDir, 'rollback.sh');
const readmePath = join(ec2DeployDir, 'README.md');
const imageDir = join(ec2DeployDir, 'image');
const packageJsonPath = join(imageDir, 'package.json');
const packageLockPath = join(imageDir, 'package-lock.json');
const testFilePath = join(repoRoot, 'deploy/tests/aws-ec2-agent-image.test.ts');

const BASE_IMAGE =
  'ghcr.io/nexu-io/od:0.21.1@sha256:441daca881e699657bacf28e0c27b16cd6be551dfff4bd63368dd74bec581f39';
const LOCKED_DEPENDENCIES = {
  '@earendil-works/pi-coding-agent': '0.85.1',
  'opencode-ai': '1.18.29',
} as const;

interface PackageManifest {
  private?: unknown;
  dependencies?: unknown;
}

interface LockPackage {
  name?: unknown;
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageLock {
  name?: unknown;
  lockfileVersion?: unknown;
  packages?: Record<string, LockPackage>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function packageLockSemanticFields(lock: PackageLock): string {
  const fields = typeof lock.name === 'string' ? [lock.name] : [];
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    fields.push(packagePath);
    for (const value of [entry.name, entry.resolved]) {
      if (typeof value === 'string') fields.push(value);
    }
    for (const dependencies of [
      entry.dependencies,
      entry.optionalDependencies,
      entry.peerDependencies,
    ]) {
      for (const [name, specifier] of Object.entries(dependencies ?? {})) {
        fields.push(name, specifier);
      }
    }
  }
  return fields.join('\n');
}

function assertLockedPackage(
  lock: PackageLock,
  packagePath: string,
  version: string,
): LockPackage {
  const entry = lock.packages?.[packagePath];
  assert.ok(entry, `lockfile is missing ${packagePath}`);
  assert.equal(entry.version, version, `${packagePath} must stay pinned to ${version}`);
  assert.match(
    String(entry.integrity),
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    `${packagePath} must include sha512 integrity metadata`,
  );
  return entry;
}

test('agent image manifest pins only the approved production CLIs', async () => {
  const manifest = await readJson<PackageManifest>(packageJsonPath);
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, LOCKED_DEPENDENCIES);
});

test('agent image lockfile records exact CLI and arm64 musl artifacts', async () => {
  const lock = await readJson<PackageLock>(packageLockPath);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages?.['']?.dependencies, LOCKED_DEPENDENCIES);

  const opencode = assertLockedPackage(lock, 'node_modules/opencode-ai', '1.18.29');
  assert.deepEqual(Object.keys(opencode.bin ?? {}), ['opencode']);
  assertLockedPackage(
    lock,
    'node_modules/opencode-linux-arm64-musl',
    '1.18.29',
  );

  const pi = assertLockedPackage(
    lock,
    'node_modules/@earendil-works/pi-coding-agent',
    '0.85.1',
  );
  assert.deepEqual(pi.bin, { pi: 'dist/bundle/cli.js' });
});

test('agent Dockerfile derives from the immutable OpenDesign 0.21.1 image', async () => {
  const source = await readFile(dockerfilePath, 'utf8');
  const instructions = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  assert.equal(instructions[0], `FROM ${BASE_IMAGE}`);
  assert.match(source, /io\.apexai\.opendesign\.base\.image="ghcr\.io\/nexu-io\/od:0\.21\.1@sha256:441daca881e699657bacf28e0c27b16cd6be551dfff4bd63368dd74bec581f39"/);
  assert.match(source, /io\.apexai\.opendesign\.base\.version="0\.21\.1"/);
  assert.match(source, /io\.apexai\.opendesign\.opencode\.version="1\.18\.29"/);
  assert.match(source, /io\.apexai\.opendesign\.pi\.version="0\.85\.1"/);
});

test('agent Dockerfile installs the lock as root and restores the runtime user', async () => {
  const source = await readFile(dockerfilePath, 'utf8');
  const rootPosition = source.indexOf('USER root');
  const installPosition = source.indexOf(
    'npm ci --omit=dev --no-audit --no-fund',
  );
  const runtimeUserPosition = source.lastIndexOf('USER 1001:1001');

  assert.ok(rootPosition >= 0, 'dependency installation must switch to root');
  assert.ok(installPosition > rootPosition, 'npm ci must run after switching to root');
  assert.ok(
    runtimeUserPosition > installPosition,
    'the final runtime user must be restored after installation',
  );
  assert.match(
    source,
    /RUN cd \/opt\/aod-cli && npm ci --omit=dev --no-audit --no-fund/,
  );

  const userInstructions = source.match(/^USER\s+.+$/gm) ?? [];
  assert.equal(userInstructions.at(-1), 'USER 1001:1001');
});

test('agent Dockerfile exposes locked package bins and runtime environment', async () => {
  const source = await readFile(dockerfilePath, 'utf8');

  assert.match(
    source,
    /ln -sf \/opt\/aod-cli\/node_modules\/\.bin\/opencode \/usr\/local\/bin\/opencode\b/,
  );
  assert.match(
    source,
    /ln -sf \/opt\/aod-cli\/node_modules\/\.bin\/opencode \/usr\/local\/bin\/opencode-cli\b/,
  );
  assert.match(
    source,
    /ln -sf \/opt\/aod-cli\/node_modules\/\.bin\/pi \/usr\/local\/bin\/pi\b/,
  );
  assert.match(source, /^ENV HOME=\/app\/\.od$/m);
  assert.match(source, /^ENV OPENCODE_BIN=\/usr\/local\/bin\/opencode$/m);
  assert.match(source, /^ENV PI_BIN=\/usr\/local\/bin\/pi$/m);
});

test('agent image recipe preserves the official runtime and excludes prohibited deployment behavior', async () => {
  const [dockerfile, manifestSource, lock, policyTestSource] = await Promise.all([
    readFile(dockerfilePath, 'utf8'),
    readFile(packageJsonPath, 'utf8'),
    readJson<PackageLock>(packageLockPath),
    readFile(testFilePath, 'utf8'),
  ]);
  const policySurfaces = [
    ['Dockerfile.agents', dockerfile],
    ['image/package.json', manifestSource],
    ['image/package-lock.json semantic fields', packageLockSemanticFields(lock)],
    ['aws-ec2-agent-image.test.ts', policyTestSource],
  ] as const;
  const prohibited = [
    ['retired agent', new RegExp(`\\b${'ve' + 'la'}\\b`, 'i')],
    ['GNU C compatibility layer', new RegExp(`${'glib' + 'c'}|${'gcom' + 'pat'}|${'libc6' + '-compat'}`, 'i')],
    ['host library mount', new RegExp(`--mount=[^\\n]*${'/li' + 'b'}(?:/|\\b|\\*)`, 'i')],
    ['container engine socket', new RegExp(`${'/var/run/' + 'docker.sock'}`, 'i')],
    ['floating image tag', new RegExp(`\\b${'la' + 'test'}\\b`, 'i')],
    ['infrastructure apply', new RegExp(`${'terra' + 'form'}\\s+${'app' + 'ly'}`, 'i')],
    ['remote shell', new RegExp(`\\b${'s' + 'sh'}\\b`, 'i')],
    ['destructive compose stop', new RegExp(`${'compose'}\\s+${'do' + 'wn'}`, 'i')],
    ['volume deletion', new RegExp(`${'volume'}\\s+(?:${'rm'}|${'delete'})`, 'i')],
  ] as const;

  for (const [behavior, pattern] of prohibited) {
    for (const [surface, source] of policySurfaces) {
      assert.doesNotMatch(source, pattern, `${surface} contains ${behavior}`);
    }
  }

  const instructions = sourceForInstructions(dockerfile);
  assert.doesNotMatch(instructions, /^(?:WORKDIR|ENTRYPOINT|CMD)\b/m);
  assert.deepEqual(instructions.match(/^COPY\s+.+$/gm), [
    'COPY deploy/aws/ec2/image/package.json deploy/aws/ec2/image/package-lock.json /opt/aod-cli/',
  ]);
});

function sourceForInstructions(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');
}

function parseConstantEnv(source: string): Record<string, string> {
  const entries = source
    .trim()
    .split('\n')
    .map((line) => {
      assert.match(line, /^[A-Z][A-Z0-9_]*=[A-Za-z0-9._/:@-]+$/);
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
  return Object.fromEntries(entries);
}

test('AWS EC2 image constants contain only the approved non-secret identity', async () => {
  const source = await readFile(appEnvPath, 'utf8');
  assert.deepEqual(parseConstantEnv(source), {
    AWS_ACCOUNT_ID: '389656352076',
    AWS_REGION: 'ap-southeast-1',
    ECR_REPOSITORY: 'apexai-opendesign',
    IMAGE_TAG: 'od-0.21.1-opencode-1.18.29-pi-0.85.1-r1',
    APP_HOSTNAME: 'aod.apexxai.net',
    INSTANCE_NAME: 'apexai-newapi-app',
    PRODUCTION_PATH: '/data/open-design',
    OPENDESIGN_VERSION: '0.21.1',
    OPENCODE_VERSION: '1.18.29',
    PI_VERSION: '0.85.1',
    BASE_IMAGE_DIGEST:
      'sha256:441daca881e699657bacf28e0c27b16cd6be551dfff4bd63368dd74bec581f39',
  });
  assert.doesNotMatch(source, /(?:secret|password|token|api[_-]?key|credential)/i);
});

test('AWS image publisher validates immutable ECR policy before an arm64 push', async () => {
  const source = await readFile(buildPushPath, 'utf8');
  const tagPreflight = source.indexOf('describe-images');
  const registryLogin = source.indexOf('get-login-password');
  const imageBuild = source.indexOf('docker buildx build');

  assert.match(source, /^set -euo pipefail$/m);
  assert.match(source, /uname -s/);
  assert.match(source, /Darwin/);
  assert.match(source, /uname -m/);
  assert.match(source, /native Apple Silicon/);
  assert.match(source, /docker context inspect/);
  assert.match(source, /recognized local Docker Desktop Unix socket/);
  assert.match(source, /docker buildx version/);
  assert.match(source, /docker buildx inspect/);
  assert.match(source, /docker\|docker-container/);
  assert.match(source, /get-caller-identity/);
  assert.match(source, /imageTagMutability/);
  assert.match(source, /IMMUTABLE/);
  assert.match(source, /encryptionConfiguration\.encryptionType/);
  assert.match(source, /scanOnPush/);
  assert.ok(tagPreflight >= 0, 'publisher must query the immutable target tag');
  assert.ok(registryLogin > tagPreflight, 'registry login must happen after tag preflight');
  assert.ok(imageBuild > registryLogin, 'build must happen after ECR validation and login');
  assert.match(
    source,
    /aws ecr get-login-password[^|]*\|\s*docker login[^\n]*--password-stdin/,
  );
  assert.match(source, /--pull/);
  assert.match(source, /--platform[ "']+linux\/arm64/);
  assert.match(source, /--provenance=false/);
  assert.match(source, /--file/);
  assert.match(source, /--tag/);
  assert.match(source, /--push/);
  assert.match(source, /imageDigest/);
});

test('AWS image publisher has a bounded fail-closed digest scan gate', async () => {
  const source = await readFile(buildPushPath, 'utf8');

  assert.match(source, /get-registry-scanning-configuration/);
  assert.match(source, /registry_scan_type[^\n]*BASIC/);
  assert.match(source, /describe-image-scan-findings/);
  assert.match(source, /imageDigest/);
  assert.match(source, /AOD_SCAN_TIMEOUT_SECONDS:-600/);
  assert.match(source, /deadline=.*SECONDS.*SCAN_TIMEOUT_SECONDS/);
  assert.match(source, /CRITICAL/);
  assert.match(source, /HIGH/);
  assert.match(source, /COMPLETE/);
  assert.match(source, /FAILED/);
  assert.match(source, /UNSUPPORTED_IMAGE/);
  assert.match(source, /ACTIVE\)/);
  assert.doesNotMatch(source, /IN_PROGRESS\|PENDING\|ACTIVE/);
  assert.match(source, /exit 3/);
  assert.match(source, /manual review/i);
  assert.match(source, /timed out/i);
});

test('AWS image tooling excludes floating and production mutation paths', async () => {
  const [buildSource, verifySource] = await Promise.all([
    readFile(buildPushPath, 'utf8'),
    readFile(verifyImagePath, 'utf8'),
  ]);
  const source = `${buildSource}\n${verifySource}`;
  const forbidden = [
    ['floating image tag', new RegExp(`\\b${'la' + 'test'}\\b`, 'i')],
    ['infrastructure apply', new RegExp(`${'terra' + 'form'}\\s+${'app' + 'ly'}`, 'i')],
    ['remote shell', new RegExp(`\\b${'s' + 'sh'}\\b`, 'i')],
    ['destructive compose stop', new RegExp(`${'compose'}\\s+${'do' + 'wn'}`, 'i')],
    ['production control plane', /aws\s+(?:ec2|ssm)\b/i],
  ] as const;

  for (const [behavior, pattern] of forbidden) {
    assert.doesNotMatch(source, pattern, `AWS image tooling contains ${behavior}`);
  }
});

test('AWS image verifier checks the locked runtime and isolated daemon APIs', async () => {
  const source = await readFile(verifyImagePath, 'utf8');

  assert.match(source, /^set -euo pipefail$/m);
  assert.match(source, /docker pull[^\n]*--platform[ "']+linux\/arm64/);
  assert.match(source, /\.Config\.User/);
  assert.match(source, /1001:1001/);
  assert.match(source, /HOME=\/app\/\.od/);
  assert.match(source, /opencode --version/);
  assert.match(source, /opencode-cli --version/);
  assert.match(source, /pi --version/);
  assert.match(source, new RegExp(`command -v ${'ve' + 'la'}`));
  assert.match(source, /apk info --exists/);
  assert.match(source, /apk_status/);
  assert.match(source, new RegExp(`${'gcom' + 'pat'}`));
  assert.match(source, new RegExp(`${'libc6' + '-compat'}`));
  assert.match(source, /\/api\/health/);
  assert.match(source, /\/api\/agents/);
  for (const agentId of ['opencode', 'byok-opencode', 'pi']) {
    assert.match(source, new RegExp(agentId));
  }
  assert.match(source, /docker context inspect/);
  assert.match(source, /recognized local Docker Desktop Unix socket/);
  assert.match(source, /assert_name_unused volume/);
  assert.match(source, /volume_is_owned/);
  assert.match(source, /container_is_owned/);
  assert.match(source, /network_is_owned/);
  assert.match(source, /docker network create/);
  assert.match(source, /docker volume create/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /RUN_ID=.*\$\$/);
});

test('AWS EC2 README separates immutable image delivery from deployment', async () => {
  const source = await readFile(readmePath, 'utf8');

  assert.match(source, /deploy\/aws\/ec2\/build-push\.sh/);
  assert.match(source, /deploy\/aws\/ec2\/verify-image\.sh/);
  assert.match(source, /389656352076\.dkr\.ecr\.ap-southeast-1\.amazonaws\.com\/apexai-opendesign:od-0\.21\.1-opencode-1\.18\.29-pi-0\.85\.1-r1/);
  assert.match(source, /repo@sha256/i);
  assert.match(source, /secret/i);
  assert.match(source, /production host/i);
  assert.match(source, /separate deployment step/i);
});

test('AWS deployment scripts enforce SSM-only secret-safe remote execution', async () => {
  const [deploySource, rollbackSource] = await Promise.all([
    readFile(deployPath, 'utf8'),
    readFile(rollbackPath, 'utf8'),
  ]);
  const source = `${deploySource}\n${rollbackSource}`;

  assert.match(source, /^set -euo pipefail$/m);
  assert.match(source, /aws ssm send-command/);
  assert.match(source, /AWS-RunShellScript/);
  assert.match(source, /get-command-invocation/);
  assert.match(source, /base64 --decode/);
  assert.doesNotMatch(source, /aws ssm start-session/);
  assert.doesNotMatch(source, /session-manager-plugin/);
  assert.doesNotMatch(source, new RegExp(`\\b${'s' + 'sh'}\\b`));
  assert.doesNotMatch(source, new RegExp(`${'terra' + 'form'}\\s+${'app' + 'ly'}`));
  assert.doesNotMatch(source, /get-login-password/);
  // .env contents must never reach argv or stdout
  assert.doesNotMatch(source, /cat[^\n]*\.env/);
  assert.doesNotMatch(source, /\.env[^\n]*\bcat\b/);
  // no secret-shaped identifiers, no third-party provider keys
  assert.doesNotMatch(source, /(?:OD_|OPEN_DESIGN_|NGINX_)(?:TOKEN|SECRET|APIKEY|PASSWORD)/);
  assert.doesNotMatch(source, /BYOK/);
});

test('AWS deployment scripts require digest-consistent preflight and DRY_RUN short-circuit', async () => {
  const deploySource = await readFile(deployPath, 'utf8');

  assert.match(deploySource, /get-caller-identity/);
  assert.match(deploySource, /describe-images/);
  assert.match(deploySource, /imageTag=/);
  assert.match(deploySource, /must resolve to exactly one digest/);
  assert.match(deploySource, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploySource, /describe-image-scan-findings/);
  assert.match(deploySource, /COMPLETE/);
  assert.match(deploySource, /describe-instances/);
  assert.match(deploySource, /tag:Name/);
  assert.match(deploySource, /instance-state-name/);
  assert.match(deploySource, /describe-instance-information/);
  assert.match(deploySource, /PingStatus/);
  assert.match(deploySource, /Online/);

  const gateIndex = deploySource.indexOf('DRY_RUN:-0');
  const sendIndex = deploySource.indexOf('run_remote "$REMOTE_SCRIPT"');
  assert.ok(gateIndex >= 0, 'deploy.sh must implement a DRY_RUN gate');
  assert.ok(sendIndex > gateIndex, 'the DRY_RUN gate must precede the remote send');
});

test('AWS deploy script snapshots production before an atomic single-key swap', async () => {
  const source = await readFile(deployPath, 'utf8');

  assert.match(source, /rollback/);
  assert.match(source, /mkdir[^\n]*-m 700/);
  assert.match(source, /date -u \+%Y%m%dT%H%M%SZ/);
  assert.match(source, /SHA256SUMS/);
  assert.match(source, /chmod 600/);
  assert.match(source, /mktemp/);
  assert.match(source, /mv -f/);
  assert.match(source, /sed[^\n]*\^OPEN_DESIGN_IMAGE=/);
  assert.match(source, /docker compose[^\n]*up -d --no-deps open-design/);
  assert.match(source, /FAILED_RECOVERED/);
  assert.match(source, /FAILED_RECOVERY_FAILED/);
});

test('AWS deployment scripts prohibit destructive compose, prune, nginx, and data operations', async () => {
  const [deploySource, rollbackSource] = await Promise.all([
    readFile(deployPath, 'utf8'),
    readFile(rollbackPath, 'utf8'),
  ]);
  const source = `${deploySource}\n${rollbackSource}`;
  const forbidden = [
    ['compose teardown', new RegExp(`${'compose'}\\s+${'do' + 'wn'}`)],
    ['compose orphan removal', /remove-orphans/],
    ['compose volume teardown', new RegExp(`${'do' + 'wn'}\\s+-v\\b`)],
    ['docker prune', /docker[^\n]*prune/],
    ['volume removal', new RegExp(`${'volume'}\\s+(?:${'rm'}|${'delete'})`)],
    ['data deletion', new RegExp(`${'rm'}\\s+-r?f?[^\n]*(?:${'data'}|\\$[A-Z_]*DATA)`)],
  ] as const;
  for (const [behavior, pattern] of forbidden) {
    assert.doesNotMatch(source, pattern, `AWS deployment tooling contains ${behavior}`);
  }
  // nginx and other containers must never be targeted by compose or lifecycle commands
  assert.doesNotMatch(source, new RegExp(`${'compose'}[^\n]*${'nginx'}`));
  assert.doesNotMatch(source, /docker\s+(?:restart|stop|rm|kill)[^\n]*nginx/);
  // no host CLI or library mounts
  assert.doesNotMatch(source, /-v\s+\/(?:usr|bin|lib|opt)/);
  assert.doesNotMatch(source, new RegExp(`--mount=[^\\n]*/li${'b'}`));
});

test('AWS rollback script validates snapshots and restores only OpenDesign', async () => {
  const source = await readFile(rollbackPath, 'utf8');

  assert.match(source, /^set -euo pipefail$/m);
  assert.match(source, /--list/);
  assert.match(source, /--validate/);
  assert.match(source, /--execute/);
  assert.match(source, /aws ssm send-command/);
  assert.match(source, /sha256sum -c/);
  assert.match(source, /docker compose[^\n]*up -d --no-deps open-design/);
  assert.match(source, /ROLLED_BACK/);
  assert.doesNotMatch(source, /rm -rf/);
  assert.doesNotMatch(source, new RegExp(`${'compose'}\\s+${'do' + 'wn'}`));
});

test('AWS EC2 README documents SSM-only deployment and rollback', async () => {
  const source = await readFile(readmePath, 'utf8');

  assert.match(source, /deploy\/aws\/ec2\/deploy\.sh/);
  assert.match(source, /deploy\/aws\/ec2\/rollback\.sh/);
  assert.match(source, /DRY_RUN/);
  assert.match(source, /SSM-only/);
  assert.match(source, /aws ssm send-command/);
  assert.match(source, /rollback/);
  assert.match(source, /up -d --no-deps open-design/);
  assert.match(source, /repo@sha256/i);
  assert.match(source, /FAILED_RECOVERED/);
});
