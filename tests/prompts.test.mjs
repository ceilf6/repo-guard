import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIssueUserMessage, buildPRUserMessage, loadSystemPrompt } from '../scripts/prompts.mjs';

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

  assert.match(message, /src\/parse-id\.js \(修改, \+1 -1\)/);
  assert.match(message, /function parseId/);
  assert.match(message, /## 行级评论行号目标/);
  assert.match(message, /- src\/parse-id\.js: 变更行 2/);
  assert.match(message, /差异已截断/);
  assert.match(message, /已省略 1 个文件/);
  assert.match(message, /\*\*统计:\*\* \+5000 -10, 2 个文件/);
  assert.match(message, /## 差异/);
  assert.doesNotMatch(message, /Changed Files|Inline Comment Line Targets|Diff truncated|\\d+ files/);
});

test('buildPRUserMessage includes linked issue context and degraded warnings', () => {
  const message = buildPRUserMessage(prInfo({
    title: 'Add dry-run mode',
    body: 'Closes #12.',
  }), [{
    filename: 'scripts/review.mjs',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1,2 +1,3 @@\n export function run() {}\n+export function dryRun() {}',
  }], {
    warnings: ['关联 Issue 获取不完整，级联置信度 degraded。'],
    issues: [{
      number: 12,
      title: 'Add dry-run mode',
      state: 'open',
      user: 'reporter',
      labels: ['enhancement'],
      url: 'https://github.com/owner/repo/issues/12',
      sources: ['linked', 'body-ref'],
      body: 'Acceptance criteria: dry-run prevents issue comments and PR reviews.',
    }],
  });

  assert.match(message, /## 关联 Issue 上下文/);
  assert.match(message, /关联 Issue 获取不完整/);
  assert.match(message, /### Issue #12: Add dry-run mode/);
  assert.match(message, /来源: linked, body-ref/);
  assert.match(message, /dry-run prevents issue comments and PR reviews/);
});

test('buildPRUserMessage states when no linked issues were found', () => {
  const message = buildPRUserMessage(prInfo(), [], { issues: [], warnings: [] });

  assert.match(message, /## 关联 Issue 上下文/);
  assert.match(message, /未发现关联 Issue/);
});

test('buildIssueUserMessage localizes issue metadata labels', () => {
  const message = buildIssueUserMessage({
    title: '登录后偶发 500',
    user: 'reporter',
    labels: ['bug', 'needs-info'],
    body: '',
  });

  assert.match(message, /\*\*作者:\*\* reporter/);
  assert.match(message, /\*\*标签:\*\* bug, needs-info/);
  assert.match(message, /## 正文/);
  assert.doesNotMatch(message, /Author|Labels|Body/);
});

test('loadSystemPrompt uses Chinese skills without language instruction append', () => {
  const prompt = loadSystemPrompt('pr', '重点检查鉴权风险。');

  assert.match(prompt, /你是代码评审机器人/);
  assert.match(prompt, /## 代码评审报告:/);
  assert.match(prompt, /重点检查鉴权风险。/);
  assert.doesNotMatch(prompt, /Language Instruction|Respond in Chinese|Use Chinese/);
  assert.doesNotMatch(prompt, /## CR Report:|\*\*Recommendation:\*\*/);
});

test('action metadata no longer exposes language setting', () => {
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

  assert.doesNotMatch(action, /^\s+language:/m);
  assert.doesNotMatch(action, /REVIEW_LANGUAGE/);
});
