// Fail-closed check for the pinned-image patcher against a synthetic replica
// of the exact v2 artifacts. Unit-testing the real Docker layer is not
// possible on x64; this proves every match string is present and atomic.
// Run: pnpm exec tsx deploy/aws/apply-volcengine-media-defaults.check.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fake = mkdtempSync(join(tmpdir(), 'od-media-defaults-'));
const B = String.fromCharCode(92); // backslash
const T = String.fromCharCode(96); // backtick
const esc = (s) => s.replaceAll(T, B + T); // real dist escapes backticks inside template literals

// Faithful replicas of the pinned v2 dist shapes (valid modules).
const modelsJs = 'export const IMAGE_MODELS = [\n'
  + esc(`  { id: 'vela/gpt-image-2', label: 'gpt-image-2 (Cloud)', hint: 'OpenDesign Cloud · managed image generation and editing', provider: 'vela', caps: ['t2i', 'i2i'], default: true },\n  { id: 'doubao-seedream-3-0-t2i-250415', label: 'seedream-3.0', hint: 'ByteDance · Doubao image', provider: 'volcengine', caps: ['t2i'] },\n`) + '];\n';
const contractJs = 'export const C = `\n'
  + esc(`  [--resolution <res>]              # vela/* images only; e.g. 1K, 2K — must be published for --aspect\n   - **Image, best quality (user says "best", "highest quality", "most realistic")**:\n     \`imageModel\` if set; otherwise use \`gpt-image-2\`\n`) + '`;\n';
const indexJs = 'async function renderVolcengineImage(ctx) {\n'
  + `  const body = {\n    model: ctx.wireModel,\n    size: volcengineImageSizeFor(ctx.wireModel, ctx.aspect),\n    prompt: ctx.prompt || 'A high-quality reference image.',\n  };\n}\n`;
const chunkJs = 'const i=[{id:"vela/gpt-image-2",label:"gpt-image-2 (Cloud)",hint:"OpenDesign Cloud · managed image generation and editing",provider:"vela",caps:["t2i","i2i"],default:!0},{id:"doubao-seedream-3-0-t2i-250415",label:"seedream-3.0",hint:"ByteDance · Doubao image",provider:"volcengine",caps:["t2i"]}];\n';

mkdirSync(join(fake, 'apps/daemon/dist/media'), { recursive: true });
mkdirSync(join(fake, 'apps/daemon/dist/prompts'), { recursive: true });
mkdirSync(join(fake, 'apps/daemon/src/media'), { recursive: true });
mkdirSync(join(fake, 'apps/web/out/_next/static/chunks'), { recursive: true });
writeFileSync(join(fake, 'apps/daemon/dist/media/models.js'), modelsJs);
writeFileSync(join(fake, 'apps/daemon/dist/prompts/media-contract.js'), contractJs);
writeFileSync(join(fake, 'apps/daemon/dist/media/index.js'), indexJs);
for (const chunk of ['0fb5ha4~sml8r.js', '15_j4ackgjtzm.js']) {
  writeFileSync(join(fake, `apps/web/out/_next/static/chunks/${chunk}`), chunkJs);
}
writeFileSync(join(fake, 'apps/daemon/src/media/volcengine-image-size.ts'), 'export function volcengineImageSizeFor(wireModel?: string, aspect?: string, resolution?: string): string { return resolution ?? "2048x2048"; }\n');

const here = new URL('.', import.meta.url).pathname;
const run = spawnSync('node', ['--experimental-strip-types', join(here, 'apply-volcengine-media-defaults.ts'), fake, join(fake, 'apps/daemon/src/media/volcengine-image-size.ts')], { encoding: 'utf8' });
if (run.error) throw run.error;
if (run.status !== 0) throw new Error(`patcher failed on fixture: ${run.stderr}`);

const read = (p) => readFileSync(join(fake, p), 'utf8');
const model = read('apps/daemon/dist/media/models.js');
const contract = read('apps/daemon/dist/prompts/media-contract.js');
const renderer = read('apps/daemon/dist/media/index.js');
const chunk0 = read('apps/web/out/_next/static/chunks/0fb5ha4~sml8r.js');
const chunk1 = read('apps/web/out/_next/static/chunks/15_j4ackgjtzm.js');

const checks = [
  [(model.split('default: true').length - 1) === 1 && model.includes("caps: ['t2i'], default: true }"), 'exactly one daemon default, moved onto Seedream'],
  [contract.includes(`otherwise use ${B + T}doubao-seedream-3-0-t2i-250415${B + T} (Volcengine Seedream)`), 'prompt default phrase swapped'],
  [contract.includes('Volcengine Seedream: 2K, 3K, 4K'), 'resolution scope line updated'],
  [renderer.includes('volcengineImageSizeFor(ctx.wireModel, ctx.aspect, ctx.resolution)'), 'renderer forwards resolution'],
  [chunk0.includes('"t2i","i2i"],default:!0}') === false && chunk0.includes('"t2i"],default:!0}'), 'client cloud default removed, Seedream flagged'],
  [chunk1.includes('"t2i","i2i"],default:!0}') === false && chunk1.includes('"t2i"],default:!0}'), 'second client chunk patched identically'],
];

let failures = 0;
for (const [ok, label] of checks) {
  if (!ok) { failures++; console.error('FAIL:', label); }
}
rmSync(fake, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log(`patcher fixture assertions passed (${checks.length})`);
