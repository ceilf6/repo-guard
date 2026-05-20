import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPRUserMessage } from '../scripts/prompts.mjs';

function prInfo(overrides = {}) {
  return {
    title: 'Fix parsing with generated snapshot',
    body: 'A small source fix ships with a large generated snapshot update.',
    base: 'main',
    head: 'fix-parser',
    user: 'tester',
    additions: 5000,
    deletions: 10,
    changedFiles: 2,
    ...overrides,
  };
}

test('buildPRUserMessage keeps smaller actionable diffs after omitting an oversized file', () => {
  const message = buildPRUserMessage(prInfo(), [
    {
      filename: 'snapshots/generated.txt',
      status: 'modified',
      additions: 5000,
      deletions: 0,
      patch: 'x'.repeat(120 * 1024),
    },
    {
      filename: 'src/parse-id.js',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1,3 +1,4 @@\n function parseId(value) {\n-  return Number(value);\n+  return parseInt(value, 10);\n }',
    },
  ]);

  assert.match(message, /src\/parse-id\.js \(modified, \+1 -1\)/);
  assert.match(message, /function parseId/);
  assert.match(message, /Diff truncated/);
  assert.match(message, /1 file\(s\) omitted/);
});
