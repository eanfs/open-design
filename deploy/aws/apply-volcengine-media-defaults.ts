// Compatibility hotfix for the pinned v2 private runtime image only.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [root, helperPath] = process.argv.slice(2);
if (!root || !helperPath) throw new Error('Expected app root and helper.ts paths');
const pending = new Map<string, string>();
function replaceOnce(text: string, before: string, after: string): string {
  if (text.split(before).length !== 2) throw new Error(`Expected one occurrence: ${before}`);
  return text.replace(before, after);
}
function patch(relative: string, transform: (text: string) => string): void {
  const path = join(root!, relative);
  pending.set(path, transform(readFileSync(path, 'utf8')));
}

patch('apps/daemon/dist/media/models.js', (text) => {
  const cloud = "{ id: 'vela/gpt-image-2', label: 'gpt-image-2 (Cloud)', hint: 'OpenDesign Cloud · managed image generation and editing', provider: 'vela', caps: ['t2i', 'i2i'], default: true }";
  const seedream = "{ id: 'doubao-seedream-3-0-t2i-250415', label: 'seedream-3.0', hint: 'ByteDance · Doubao image', provider: 'volcengine', caps: ['t2i'] }";
  return replaceOnce(replaceOnce(text, cloud, cloud.replace(', default: true', '')), seedream, seedream.replace(' }', ', default: true }'));
});
patch('apps/daemon/dist/prompts/media-contract.js', (text) => {
  text = replaceOnce(text, 'otherwise use \\`gpt-image-2\\`', 'otherwise use \\`doubao-seedream-3-0-t2i-250415\\` (Volcengine Seedream)');
  return replaceOnce(text,
    '# vela/* images only; e.g. 1K, 2K — must be published for --aspect',
    '# vela/* images: e.g. 1K, 2K — must be published for --aspect; Volcengine Seedream: 2K, 3K, 4K');
});
patch('apps/daemon/dist/media/index.js', (text) => replaceOnce(text,
  'size: volcengineImageSizeFor(ctx.wireModel, ctx.aspect),',
  'size: volcengineImageSizeFor(ctx.wireModel, ctx.aspect, ctx.resolution),'));
pending.set(join(root, 'apps/daemon/dist/media/volcengine-image-size.js'), stripTypeScriptTypes(readFileSync(helperPath, 'utf8')));

// Both pinned chunks carry the catalog. Patch all copies, not just the entry page.
for (const chunk of ['0fb5ha4~sml8r.js', '15_j4ackgjtzm.js']) {
  patch(`apps/web/out/_next/static/chunks/${chunk}`, (text) => {
    const cloud = '{id:"vela/gpt-image-2",label:"gpt-image-2 (Cloud)",hint:"OpenDesign Cloud · managed image generation and editing",provider:"vela",caps:["t2i","i2i"],default:!0}';
    const seedream = '{id:"doubao-seedream-3-0-t2i-250415",label:"seedream-3.0",hint:"ByteDance · Doubao image",provider:"volcengine",caps:["t2i"]}';
    return replaceOnce(replaceOnce(text, cloud, cloud.replace(',default:!0', '')), seedream, seedream.replace('}', ',default:!0}'));
  });
}
// Validate every transformed module before changing any artifact. Docker discards
// the entire build layer on filesystem failure; mismatched inputs write nothing.
for (const [path, content] of pending) {
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: content, encoding: 'utf8' });
  if (check.error || check.status !== 0) throw new Error(`Invalid patched module ${path}: ${check.error ?? check.stderr}`);
}
for (const [path, content] of pending) writeFileSync(path, content);
console.log(`Patched and syntax-checked ${pending.size} pinned artifacts; credentials and explicit model choices unchanged`);
