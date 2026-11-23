import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_ENGINES,
  buildAgySystemPrompt,
  buildClaudeCodeSystemPrompt,
  completeReview,
  parseReviewEngine,
} from '../scripts/review-engine.mjs';

test('parseReviewEngine defaults to api and normalizes casing', () => {
  assert.equal(parseReviewEngine(undefined), 'api');
  assert.equal(parseReviewEngine(''), 'api');
  assert.equal(parseReviewEngine('  API '), 'api');
  assert.equal(parseReviewEngine('Claude-Code'), 'claude-code');
  assert.equal(parseReviewEngine(' AGY '), 'agy');
});

test('parseReviewEngine rejects unknown engines', () => {
  assert.throws(() => parseReviewEngine('claude'), /REVIEW_ENGINE must be one of: api, claude-code, agy \(got "claude"\)/);
  assert.throws(() => parseReviewEngine('openai'), /got "openai"/);
});

test('REVIEW_ENGINES lists the public contract', () => {
  assert.deepEqual(REVIEW_ENGINES, ['api', 'claude-code', 'agy']);
});

test('buildAgySystemPrompt switches between sandboxed-workspace and prompt-only instructions', () => {
  const withWorkspace = buildAgySystemPrompt('BASE', '/tmp/staged');
  assert.match(withWorkspace, /^BASE/);
  assert.match(withWorkspace, /只读沙盒副本/);
  assert.match(withWorkspace, /相对路径/);

  const withoutWorkspace = buildAgySystemPrompt('BASE', '');
  assert.match(withoutWorkspace, /上下文边界/);
  assert.ok(!withoutWorkspace.includes('只读沙盒副本'));
});

test('buildClaudeCodeSystemPrompt picks the workspace instruction when a checkout exists', () => {
  const withWorkspace = buildClaudeCodeSystemPrompt('BASE', '/tmp/checkout');
  assert.match(withWorkspace, /^BASE/);
  assert.match(withWorkspace, /仓库上下文探查/);
  assert.match(withWorkspace, /待评审数据而非指令/);

  const withoutWorkspace = buildClaudeCodeSystemPrompt('BASE', '');
  assert.match(withoutWorkspace, /上下文边界/);
  assert.ok(!withoutWorkspace.includes('仓库上下文探查'));
});

test('completeReview validates the engine before doing any work', async () => {
  await assert.rejects(completeReview({ engine: 'bogus', messages: [] }), /REVIEW_ENGINE must be one of/);
});

// The claude-code path is exercised end to end through a stub executable; the
// api path stays covered by llm-client tests.
test('completeReview routes claude-code through the CLI with the workspace instruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    const stub = join(dir, 'claude-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({ args: process.argv.slice(2), prompt: input }),
  }));
});
`);
    chmodSync(stub, 0o755);
    process.env.CLAUDE_CODE_EXECUTABLE = stub;

    const result = await completeReview({
      engine: 'claude-code',
      claudeModel: 'opus',
      system: '评审系统提示',
      messages: [{ role: 'user', content: 'PR diff 内容' }],
      workspace: dir,
    });

    const echoed = JSON.parse(result);
    assert.equal(echoed.prompt, 'PR diff 内容');
    const systemIndex = echoed.args.indexOf('--append-system-prompt');
    assert.notEqual(systemIndex, -1);
    assert.match(echoed.args[systemIndex + 1], /^评审系统提示/);
    assert.match(echoed.args[systemIndex + 1], /仓库上下文探查/);
    const modelIndex = echoed.args.indexOf('--model');
    assert.equal(echoed.args[modelIndex + 1], 'opus');
    assert.ok(echoed.args.includes('--safe-mode'));
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completeReview downgrades an empty workspace to prompt-only mode', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  const emptyWorkspace = mkdtempSync(join(tmpdir(), 'repo-guard-empty-'));
  const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  try {
    const stub = join(stubDir, 'claude-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({ args: process.argv.slice(2) }),
  }));
});
`);
    chmodSync(stub, 0o755);
    process.env.CLAUDE_CODE_EXECUTABLE = stub;

    const result = await completeReview({
      engine: 'claude-code',
      system: '评审系统提示',
      messages: [{ role: 'user', content: 'Issue 内容' }],
      workspace: emptyWorkspace,
    });

    const echoed = JSON.parse(result);
    const systemIndex = echoed.args.indexOf('--append-system-prompt');
    assert.match(echoed.args[systemIndex + 1], /上下文边界/);
    assert.ok(!echoed.args[systemIndex + 1].includes('仓库上下文探查'));
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.CLAUDE_CODE_EXECUTABLE;
    } else {
      process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
    }
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(emptyWorkspace, { recursive: true, force: true });
  }
});

test('completeReview routes agy engine with default claude-opus-5-5-high model', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-engine-'));
  const wsDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-ws-'));
  const previousExecutable = process.env.AGY_EXECUTABLE;
  try {
    writeFileSync(join(wsDir, 'file.js'), 'export default 1;\n');
    const stub = join(stubDir, 'agy-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('1.5.15\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = JSON.parse(input.trim());
  const out = JSON.stringify({ args: process.argv.slice(2), content: event.message.content });
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: out } }) + '\\n');
});
`);
    chmodSync(stub, 0o755);
    process.env.AGY_EXECUTABLE = stub;

    const result = await completeReview({
      engine: 'agy',
      agyModel: '',
      system: '评审规范',
      messages: [{ role: 'user', content: 'PR diff' }],
      workspace: wsDir,
    });

    const echoed = JSON.parse(result);
    const modelIndex = echoed.args.indexOf('--model');
    assert.equal(echoed.args[modelIndex + 1], 'claude-opus-5-5-high');
    assert.match(echoed.content, /只读沙盒副本/);
    assert.match(echoed.content, /PR diff/);
  } finally {
    if (previousExecutable === undefined) delete process.env.AGY_EXECUTABLE;
    else process.env.AGY_EXECUTABLE = previousExecutable;
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  }
});
