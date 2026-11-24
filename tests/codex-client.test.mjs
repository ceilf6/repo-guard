import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_ENV_DENYLIST,
  MIN_VERIFIED_CODEX_VERSION,
  buildCodexArgs,
  codexCompletion,
  isCodexVersionSupported,
  parseCodexVersion,
} from '../scripts/codex-client.mjs';

test('parseCodexVersion and isCodexVersionSupported validate minimum version', () => {
  assert.equal(parseCodexVersion('codex-cli 0.171.0\n'), '0.171.0');
  assert.equal(isCodexVersionSupported(MIN_VERIFIED_CODEX_VERSION), true);
  assert.equal(isCodexVersionSupported('0.172.0'), true);
  assert.equal(isCodexVersionSupported('0.170.9'), false);
});

test('buildCodexArgs enforces read-only sandbox, ignores user config/hooks, and sets output file', () => {
  const args = buildCodexArgs({ model: 'gpt-6.2-astra', cwd: '/tmp/ws', outputFile: '/tmp/out.txt' });
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--disable'));
  assert.ok(args.includes('codex_hooks'));
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('gpt-6.2-astra'));
  assert.ok(args.includes('/tmp/out.txt'));
});

test('codexCompletion stages read-only workspace, clears proxy/secret env, and reads -o file', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-codex-stub-'));
  const wsDir = mkdtempSync(join(tmpdir(), 'repo-guard-codex-ws-'));
  const saved = {};
  for (const key of CODEX_ENV_DENYLIST) {
    saved[key] = process.env[key];
    process.env[key] = `val-${key}`;
  }
  try {
    writeFileSync(join(wsDir, 'code.js'), 'export const a = 1;\n');
    mkdirSync(join(wsDir, '.git'));
    writeFileSync(join(wsDir, '.git', 'config'), 'secret');

    const stub = join(stubDir, 'codex-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.171.0\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const outIdx = process.argv.indexOf('-o');
  const outFile = process.argv[outIdx + 1];
  const payload = JSON.stringify({
    hasCode: existsSync(join(process.cwd(), 'code.js')),
    hasGit: existsSync(join(process.cwd(), '.git')),
    leaked: ['GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY'].filter((k) => k in process.env),
    prompt: input,
  });
  writeFileSync(outFile, payload);
});
`);
    chmodSync(stub, 0o755);

    const res = await codexCompletion({
      system: 'SYS',
      messages: [{ role: 'user', content: 'DIFF' }],
      workspace: wsDir,
      executable: stub,
      timeoutMinutes: 1,
    });
    const parsed = JSON.parse(res);
    assert.equal(parsed.hasCode, true);
    assert.equal(parsed.hasGit, false);
    assert.deepEqual(parsed.leaked, []);
    assert.match(parsed.prompt, /SYS/);
    assert.match(parsed.prompt, /DIFF/);
  } finally {
    for (const key of CODEX_ENV_DENYLIST) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  }
});
