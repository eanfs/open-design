import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// This deployment pins OD 0.21.1. Fail closed if its parser anchor changes.
export function patchRunBodyLimit(source: string): string {
  const anchor = "app.use(express.json({ limit: '4mb' }));";
  if (source.split(anchor).length !== 2 || source.includes('aod-run-body-20m')) {
    throw new Error('Expected exactly one unpatched OD 0.21.1 JSON parser');
  }
  return source.replace(anchor,
    "// aod-run-body-20m: preserve the global limit for other APIs.\n"
    + "    app.post('/api/runs', express.json({ limit: '20mb' }));\n    " + anchor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: patch-run-body-limit.ts <compiled-server>');
  writeFileSync(target, patchRunBodyLimit(readFileSync(target, 'utf8')));
}
