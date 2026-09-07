// Compatibility hotfix for the pinned 0.21.1 private runtime image.
// Normal source builds consume src/media/volcengine-image-size.ts directly.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const indexPath = process.argv[2];
const helperPath = process.argv[3];
if (!indexPath || !helperPath) throw new Error('Expected index.js and helper.ts paths');
const original = readFileSync(indexPath, 'utf8');
const start = original.indexOf('async function renderVolcengineImage(');
const end = original.indexOf('\nasync function ', start + 1);
if (start < 0 || end < 0) throw new Error('Pinned image renderer boundary not found');
const before = original.slice(start, end);
const oldCall = 'size: openaiSizeFor(ctx.model, ctx.aspect),';
if (before.split(oldCall).length !== 2) throw new Error('Expected exactly one legacy image size call');
const after = before.replace(oldCall, 'size: volcengineImageSizeFor(ctx.wireModel, ctx.aspect),');
const importLine = "import { volcengineImageSizeFor } from './volcengine-image-size.js';\n";
if (original.includes(importLine)) throw new Error('Image is already patched');
writeFileSync(indexPath, importLine + original.slice(0, start) + after + original.slice(end));
writeFileSync(new URL('./volcengine-image-size.js', `file://${indexPath}`).pathname,
  stripTypeScriptTypes(readFileSync(helperPath, 'utf8')));
console.log('Patched only the Volcengine image size call and installed its helper');

const routesPath = new URL('../routes/media.js', `file://${indexPath}`).pathname;
const routes = readFileSync(routesPath, 'utf8');
const oldHeader = "const authorizationHeader = req.get('authorization');";
if (routes.split(oldHeader).length !== 2) throw new Error('Expected exactly one media wait auth header');
const newHeader = "const requestAuthorizationHeader = req.get('authorization');\n"
  + '    const authorizationHeader = apiTokenAuthorizationMatches(requestAuthorizationHeader, apiTokenFromEnv())\n'
  + '        ? undefined : requestAuthorizationHeader;';
writeFileSync(routesPath, "import { apiTokenAuthorizationMatches, apiTokenFromEnv } from '../api-token-auth.js';\n"
  + routes.replace(oldHeader, newHeader));
console.log('Distinguished deployment authentication from scoped media tool grants');
