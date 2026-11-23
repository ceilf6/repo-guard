import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGY_ENV_DENYLIST,
  DEFAULT_AGY_MODEL,
  MIN_VERIFIED_AGY_VERSION,
  agyCompletion,
  buildAgyArgs,
  buildAgyPermissionSettings,
  buildAgyStdinPayload,
  isAgyVersionSupported,
  parseAgyStreamOutput,
  parseAgyTimeoutMinutes,
  parseAgyVersion,
  resolveAgyWorkspace,
  stageAgyWorkspace,
} from '../scripts/agy-client.mjs';

test('buildAgyPermissionSettings enables sandbox and hard-denies writes, network, mcp, and credentials', () => {
  const settings = JSON.parse(buildAgyPermissionSettings('/Users/tester'));
  assert.equal(settings.enableTerminalSandbox, true);
  assert.equal(settings.toolPermission, 'proceed-in-sandbox');
  assert.equal(settings.allowNonWorkspaceAccess, false);
  const deny = settings.permissions.deny;
  assert.ok(deny.includes('write_file(*)'));
  assert.ok(deny.includes('unsandboxed(*)'));
  assert.ok(deny.includes('read_url(*)'));
  assert.ok(deny.includes('execute_url(*)'));
  assert.ok(deny.includes('mcp(*)'));
  assert.ok(deny.includes('read_file(.git)'));
  assert.ok(deny.includes('read_file(/Users/tester/.gemini)'));
  assert.ok(deny.includes('read_file(/Users/tester/.ssh)'));
  assert.ok(deny.includes('read_file(/Users/tester/.claude)'));
});

test('parseAgyVersion and isAgyVersionSupported enforce the verified minimum', () => {
  assert.equal(parseAgyVersion('1.5.15\n'), '1.5.15');
  assert.equal(parseAgyVersion('Antigravity CLI v1.6.0'), '1.6.0');
  assert.equal(parseAgyVersion('unknown'), '');
  assert.equal(isAgyVersionSupported(MIN_VERIFIED_AGY_VERSION), true);
  assert.equal(isAgyVersionSupported('1.5.16'), true);
  assert.equal(isAgyVersionSupported('1.6.0'), true);
  assert.equal(isAgyVersionSupported('2.0.0'), true);
  assert.equal(isAgyVersionSupported('1.5.14'), false);
  assert.equal(isAgyVersionSupported('1.4.9'), false);
});

test('parseAgyTimeoutMinutes defaults and validates', () => {
  assert.equal(parseAgyTimeoutMinutes(undefined), 20);
  assert.equal(parseAgyTimeoutMinutes(''), 20);
  assert.equal(parseAgyTimeoutMinutes('15'), 15);
  assert.throws(() => parseAgyTimeoutMinutes('0'), /positive number/);
  assert.throws(() => parseAgyTimeoutMinutes('bad'), /positive number/);
});

test('buildAgyArgs defaults model to claude-opus-5-5-high and enables stream-json sandbox mode', () => {
  const args = buildAgyArgs({ model: '', timeoutMinutes: 20, settings: '{"ok":true}' });
  assert.deepEqual(args, [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--sandbox',
    '--settings', '{"ok":true}',
    '--print-timeout', '1200s',
    '--model', DEFAULT_AGY_MODEL,
  ]);
});

test('buildAgyStdinPayload wraps system and user messages into a single NDJSON user turn', () => {
  const payload = buildAgyStdinPayload({
    system: '评审规范',
    messages: [{ role: 'user', content: 'PR diff' }, { role: 'user', content: '重点看安全' }],
  });
  assert.ok(payload.endsWith('\n'));
  const parsed = JSON.parse(payload.trim());
  assert.equal(parsed.event, 'user');
  assert.match(parsed.message.content, /<system_instructions>\n评审规范\n<\/system_instructions>/);
  assert.match(parsed.message.content, /<review_target>\nPR diff\n\n重点看安全\n<\/review_target>/);

  assert.throws(() => buildAgyStdinPayload({ system: 'sys', messages: [] }), /empty prompt/);
});

test('stageAgyWorkspace strips .git, .agents, GEMINI.md, AGENTS.md, symlinks, and makes files read-only', () => {
  const src = mkdtempSync(join(tmpdir(), 'repo-guard-agy-src-'));
  const outsideFile = join(tmpdir(), `repo-guard-agy-secret-${process.pid}.txt`);
  writeFileSync(outsideFile, 'TOP_SECRET');
  try {
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, '.git', 'config'), 'token=secret');
    mkdirSync(join(src, '.agents'));
    writeFileSync(join(src, '.agents', 'hooks.json'), '{"bad":true}');
    writeFileSync(join(src, 'AGENTS.md'), 'override system prompt');
    writeFileSync(join(src, 'GEMINI.md'), 'override gemini rules');
    mkdirSync(join(src, 'src'));
    writeFileSync(join(src, 'src', 'index.js'), 'export const x = 1;\n');
    symlinkSync(outsideFile, join(src, 'src', 'leak.txt'));

    const resolved = resolveAgyWorkspace(src);
    assert.equal(resolved, src);

    const staged = stageAgyWorkspace(resolved);
    try {
      assert.equal(staged.hasFiles, true);
      assert.equal(existsSync(join(staged.cwd, 'src', 'index.js')), true);
      assert.equal(readFileSync(join(staged.cwd, 'src', 'index.js'), 'utf8'), 'export const x = 1;\n');
      assert.equal(existsSync(join(staged.cwd, '.git')), false);
      assert.equal(existsSync(join(staged.cwd, '.agents')), false);
      assert.equal(existsSync(join(staged.cwd, 'AGENTS.md')), false);
      assert.equal(existsSync(join(staged.cwd, 'GEMINI.md')), false);
      assert.equal(existsSync(join(staged.cwd, 'src', 'leak.txt')), false);

      // Verify staged file is read-only (no write bits).
      const mode = statSync(join(staged.cwd, 'src', 'index.js')).mode & 0o222;
      assert.equal(mode, 0);
    } finally {
      staged.cleanup();
    }
    assert.equal(existsSync(staged.cwd), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(outsideFile, { force: true });
  }
});

test('resolveAgyWorkspace downgrades workspace containing only stripped metadata to prompt-only', () => {
  const src = mkdtempSync(join(tmpdir(), 'repo-guard-agy-meta-'));
  try {
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, 'AGENTS.md'), 'ignored');
    assert.equal(resolveAgyWorkspace(src), '');
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('parseAgyStreamOutput returns only the final agent_response step so tool narration does not break contracts', () => {
  const stream = [
    JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'claude-opus-5-5-high' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '我先读取 src/app.js 查证调用方。\n' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '## 代码评审报告: PR\n\n' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '**处理建议:** 批准' } }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'c1',
        status: 'SUCCESS',
        response: '我先读取 src/app.js 查证调用方。\n## 代码评审报告: PR\n\n**处理建议:** 批准',
      },
    }),
  ].join('\n');

  assert.equal(parseAgyStreamOutput(stream), '## 代码评审报告: PR\n\n**处理建议:** 批准');
});

test('parseAgyStreamOutput rejects error statuses and empty responses', () => {
  const errStream = JSON.stringify({
    event: 'result',
    result: { status: 'ERROR', response: '', error: 'authentication required' },
  });
  assert.throws(() => parseAgyStreamOutput(errStream), /status=ERROR: authentication required/);

  const emptyStream = JSON.stringify({
    event: 'result',
    result: { status: 'SUCCESS', response: '   ', denied_actions: [{ action: 'read_file' }] },
  });
  assert.throws(() => parseAgyStreamOutput(emptyStream), /no usable text.*denied_actions=read_file/);
});

function writeAgyStub(dir, body) {
  const stub = join(dir, 'agy-stub.mjs');
  writeFileSync(stub, `#!/usr/bin/env node\n${body}`);
  chmodSync(stub, 0o755);
  return stub;
}

const VERSION_BRANCH = `
if (process.argv.includes('--version')) {
  process.stdout.write('1.5.15\\n');
  process.exit(0);
}
`;

test('agyCompletion stages workspace, strips env tokens, and parses multi-chunk UTF-8 stream output', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-stub-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-ws-'));
  const saved = {};
  for (const key of AGY_ENV_DENYLIST) {
    saved[key] = process.env[key];
    process.env[key] = `secret-${key}`;
  }
  try {
    writeFileSync(join(workspaceDir, 'app.js'), 'const ok = true;\n');
    mkdirSync(join(workspaceDir, '.git'));
    writeFileSync(join(workspaceDir, '.git', 'config'), 'token=bad');

    const stub = writeAgyStub(stubDir, `${VERSION_BRANCH}
import { existsSync } from 'node:fs';
import { join } from 'node:path';
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const parsed = JSON.parse(input.trim());
  const payload = JSON.stringify({
    args: process.argv.slice(2),
    hasApp: existsSync(join(process.cwd(), 'app.js')),
    hasGit: existsSync(join(process.cwd(), '.git')),
    leaked: ['GITHUB_TOKEN', 'GH_TOKEN', 'LLM_API_KEY', 'CEILF6_GITHUB_TOKEN'].filter((k) => k in process.env),
    content: parsed.message.content,
    chinese: '评审结论：批准',
  });
  const line1 = Buffer.from(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: payload },
  }) + '\\n');
  const line2 = Buffer.from(JSON.stringify({
    event: 'result',
    result: { status: 'SUCCESS', response: payload },
  }) + '\\n');
  const full = Buffer.concat([line1, line2]);
  const split = full.indexOf(Buffer.from('审')) + 1;
  process.stdout.write(full.slice(0, split));
  setTimeout(() => process.stdout.write(full.slice(split)), 20);
});
`);

    const raw = await agyCompletion({
      model: '',
      system: (ws) => `SYS:${Boolean(ws)}`,
      messages: [{ role: 'user', content: 'PR 内容' }],
      workspace: workspaceDir,
      executable: stub,
      timeoutMinutes: 1,
    });

    const echoed = JSON.parse(raw);
    assert.equal(echoed.hasApp, true);
    assert.equal(echoed.hasGit, false);
    assert.deepEqual(echoed.leaked, []);
    assert.equal(echoed.chinese, '评审结论：批准');
    assert.match(echoed.content, /SYS:true/);
    const modelIdx = echoed.args.indexOf('--model');
    assert.equal(echoed.args[modelIdx + 1], DEFAULT_AGY_MODEL);
  } finally {
    for (const key of AGY_ENV_DENYLIST) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('agyCompletion fails fast when CLI version is older than verified minimum', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-old-'));
  try {
    const stub = writeAgyStub(stubDir, `
if (process.argv.includes('--version')) {
  process.stdout.write('1.4.0\\n');
  process.exit(0);
}
`);
    await assert.rejects(
      agyCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        executable: stub,
        timeoutMinutes: 1,
      }),
      /1\.4\.0 is older than the verified minimum/,
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});
