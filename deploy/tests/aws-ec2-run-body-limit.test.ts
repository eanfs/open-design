import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchRunBodyLimit } from '../aws/ec2/image/patch-run-body-limit.ts';

test('adds a run POST parser before the existing global parser', () => {
  const source = "before\napp.use(express.json({ limit: '4mb' }));\nafter";
  const patched = patchRunBodyLimit(source);
  assert.ok(patched.indexOf("app.post('/api/runs'") < patched.indexOf('app.use('));
  assert.ok(patched.includes("express.json({ limit: '20mb' })"));
  assert.ok(patched.endsWith("app.use(express.json({ limit: '4mb' }));\nafter"));
  assert.throws(() => patchRunBodyLimit(patched));
});

test('refuses upstream drift or ambiguous parser anchors', () => {
  assert.throws(() => patchRunBodyLimit("app.use(express.json({ limit: '8mb' }));"));
  assert.throws(() => patchRunBodyLimit("app.use(express.json({ limit: '4mb' }));".repeat(2)));
});
