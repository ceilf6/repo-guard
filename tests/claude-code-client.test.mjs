import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CODE_READONLY_TOOLS,
  MIN_VERIFIED_CLI_VERSION,
  buildClaudeCodeArgs,
  claudeCodeCompletion,
  isClaudeCodeVersionSupported,
  parseClaudeCodeOutput,
  parseClaudeCodeTimeoutMinutes,
  parseClaudeCodeVersion,
  resolveClaudeCodeWorkspace,
} from '../scripts/claude-code-client.mjs';

test('parseClaudeCodeVersion extracts the semver triple from --version output', () => {
  assert.equal(parseClaudeCodeVersion('2.1.220 (Claude Code)'), '2.1.220');
  assert.equal(parseClaudeCodeVersion('  3.0.1\n'), '3.0.1');
  assert.equal(parseClaudeCodeVersion('no version here'), '');
  assert.equal(parseClaudeCodeVersion(undefined), '');
});

test('isClaudeCodeVersionSupported compares against the verified minimum', () => {
  assert.equal(isClaudeCodeVersionSupported(MIN_VERIFIED_CLI_VERSION), true);
  assert.equal(isClaudeCodeVersionSupported('2.1.221'), true);
  assert.equal(isClaudeCodeVersionSupported('2.2.0'), true);
  assert.equal(isClaudeCodeVersionSupported('3.0.0'), true);
  assert.equal(isClaudeCodeVersionSupported('2.1.219'), false);
  assert.equal(isClaudeCodeVersionSupported('2.0.999'), false);
  assert.equal(isClaudeCodeVersionSupported('1.9.9'), false);
});

test('parseClaudeCodeTimeoutMinutes defaults and validates', () => {
  assert.equal(parseClaudeCodeTimeoutMinutes(undefined), 20);
  assert.equal(parseClaudeCodeTimeoutMinutes(''), 20);
  assert.equal(parseClaudeCodeTimeoutMinutes('35'), 35);
  assert.equal(parseClaudeCodeTimeoutMinutes(0.5), 0.5);
  assert.throws(() => parseClaudeCodeTimeoutMinutes('0'), /positive number/);
  assert.throws(() => parseClaudeCodeTimeoutMinutes('abc'), /positive number/);
});

test('buildClaudeCodeArgs restricts tools, refuses customization loading, and emits print JSON mode', () => {
  const args = buildClaudeCodeArgs({ model: 'opus', system: 'SYSTEM' });
  assert.deepEqual(args, [
    '--print',
    '--output-format', 'json',
    '--no-session-persistence',
    '--safe-mode',
    '--tools', CLAUDE_CODE_READONLY_TOOLS,
    '--append-system-prompt', 'SYSTEM',
    '--model', 'opus',
  ]);
});

test('resolveClaudeCodeWorkspace passes through a checkout and rejects a bad path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    writeFileSync(join(dir, 'README.md'), 'content');
    assert.equal(resolveClaudeCodeWorkspace(dir), dir);
    assert.equal(resolveClaudeCodeWorkspace(''), '');
    assert.equal(resolveClaudeCodeWorkspace(undefined), '');
    assert.throws(() => resolveClaudeCodeWorkspace('/nonexistent/repo-guard-workspace'), /not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveClaudeCodeWorkspace treats an empty directory as no checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    assert.equal(resolveClaudeCodeWorkspace(dir), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildClaudeCodeArgs omits empty model and system prompt', () => {
  const args = buildClaudeCodeArgs({ model: '', system: '' });
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--append-system-prompt'));
});

test('parseClaudeCodeOutput returns the result text on success', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '## 评审' });
  assert.equal(parseClaudeCodeOutput(stdout), '## 评审');
});

test('parseClaudeCodeOutput rejects error envelopes with the subtype', () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
  assert.throws(() => parseClaudeCodeOutput(stdout), /subtype=error_during_execution.*boom/);
});

test('parseClaudeCodeOutput rejects empty results and non-JSON output', () => {
  assert.throws(
    () => parseClaudeCodeOutput(JSON.stringify({ subtype: 'success', is_error: false, result: '  ' })),
    /no usable text \(subtype=success\)/,
  );
  assert.throws(() => parseClaudeCodeOutput('not json at all'), /non-JSON output: not json at all/);
});

test('parseClaudeCodeOutput bounds diagnostics from oversized junk output', () => {
  const error = getError(() => parseClaudeCodeOutput('x'.repeat(5000)));
  assert.ok(error.message.length < 600);
  assert.match(error.message, /truncated/);
});

function getError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
}

// A stub executable stands in for the claude CLI so the spawn/stdin/timeout
// plumbing is exercised without a real model call.
function writeStub(dir, body) {
  const stub = join(dir, 'claude-stub.mjs');
  writeFileSync(stub, `#!/usr/bin/env node\n${body}`);
  chmodSync(stub, 0o755);
  return stub;
}

const VERSION_BRANCH = `
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.220 (Claude Code)');
  process.exit(0);
}
`;

const ECHO_STUB = `${VERSION_BRANCH}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({ args: process.argv.slice(2), prompt: input, cwd: process.cwd() }),
  }));
});
`;

test('claudeCodeCompletion pipes messages via stdin and runs in the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    const stub = writeStub(dir, ECHO_STUB);
    const result = await claudeCodeCompletion({
      model: 'opus',
      system: '系统提示',
      messages: [{ role: 'user', content: 'PR 上下文' }, { role: 'user', content: '用户请求: 关注安全' }],
      workspace: dir,
      executable: stub,
      timeoutMinutes: 1,
    });
    const echoed = JSON.parse(result);
    assert.equal(echoed.prompt, 'PR 上下文\n\n用户请求: 关注安全');
    assert.equal(realpathSync(echoed.cwd), realpathSync(dir));
    assert.ok(echoed.args.includes('--append-system-prompt'));
    assert.ok(echoed.args.includes('系统提示'));
    assert.deepEqual(echoed.args.slice(0, 2), ['--print', '--output-format']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeCodeCompletion runs from a scratch directory without a workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    const stub = writeStub(dir, ECHO_STUB);
    const result = await claudeCodeCompletion({
      messages: [{ role: 'user', content: '内容' }],
      workspace: '',
      executable: stub,
      timeoutMinutes: 1,
    });
    const echoed = JSON.parse(result);
    assert.notEqual(echoed.cwd, process.cwd());
    assert.match(echoed.cwd, /repo-guard-claude-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeCodeCompletion rejects a missing workspace directory', async () => {
  await assert.rejects(
    claudeCodeCompletion({
      messages: [{ role: 'user', content: '内容' }],
      workspace: '/nonexistent/repo-guard-workspace',
      executable: 'claude',
      timeoutMinutes: 1,
    }),
    /workspace is not a directory/,
  );
});

test('claudeCodeCompletion rejects an empty prompt before spawning', async () => {
  await assert.rejects(
    claudeCodeCompletion({ messages: [], executable: 'claude', timeoutMinutes: 1 }),
    /empty prompt/,
  );
});

test('claudeCodeCompletion surfaces nonzero exit with bounded stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    const stub = writeStub(dir, `${VERSION_BRANCH}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('auth expired');
  process.exit(3);
});
`);
    await assert.rejects(
      claudeCodeCompletion({
        messages: [{ role: 'user', content: '内容' }],
        workspace: dir,
        executable: stub,
        timeoutMinutes: 1,
      }),
      /exited with code 3.*auth expired/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeCodeCompletion kills the process on timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    const stub = writeStub(dir, `${VERSION_BRANCH}
setTimeout(() => {}, 60000);`);
    await assert.rejects(
      claudeCodeCompletion({
        messages: [{ role: 'user', content: '内容' }],
        workspace: dir,
        executable: stub,
        timeoutMinutes: 0.002,
      }),
      /timed out after 0.002 minutes/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeCodeCompletion fails fast on a CLI older than the verified minimum', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-test-'));
  try {
    const stub = writeStub(dir, `
if (process.argv.includes('--version')) {
  process.stdout.write('2.0.0 (Claude Code)');
  process.exit(0);
}
process.stdin.resume();
`);
    await assert.rejects(
      claudeCodeCompletion({
        messages: [{ role: 'user', content: '内容' }],
        workspace: dir,
        executable: stub,
        timeoutMinutes: 1,
      }),
      /2\.0\.0 is older than the verified minimum/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claudeCodeCompletion reports an unlaunchable executable', async () => {
  await assert.rejects(
    claudeCodeCompletion({
      messages: [{ role: 'user', content: '内容' }],
      executable: '/nonexistent/claude-binary',
      timeoutMinutes: 1,
    }),
    /Failed to run Claude Code executable/,
  );
});
