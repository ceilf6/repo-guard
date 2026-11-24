import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSH_ENV_DENYLIST,
  MIN_VERIFIED_DSH_VERSION,
  buildDshArgs,
  dshCompletion,
  isDshVersionSupported,
  parseDshVersion,
  resolveDeepSeekApiKey,
} from '../scripts/dsh-client.mjs';

test('parseDshVersion handles prerelease tags like 0.2.2-rc.5', () => {
  assert.equal(parseDshVersion('0.2.2-rc.5\n'), '0.2.2');
  assert.equal(isDshVersionSupported(MIN_VERIFIED_DSH_VERSION), true);
  assert.equal(isDshVersionSupported('0.3.0'), true);
  assert.equal(isDshVersionSupported('0.2.1'), false);
});

test('resolveDeepSeekApiKey checks explicit, env, and ~/.dsh/deepseek_api_key', () => {
  const home = mkdtempSync(join(tmpdir(), 'repo-guard-dsh-key-'));
  try {
    mkdirSync(join(home, '.dsh'));
    writeFileSync(join(home, '.dsh', 'deepseek_api_key'), 'sk-from-file\n');
    assert.equal(resolveDeepSeekApiKey({ explicitKey: 'sk-explicit', env: { DEEPSEEK_API_KEY: 'sk-env' }, home }), 'sk-explicit');
    assert.equal(resolveDeepSeekApiKey({ explicitKey: '', env: { DEEPSEEK_API_KEY: 'sk-env' }, home }), 'sk-env');
    assert.equal(resolveDeepSeekApiKey({ explicitKey: '', env: {}, home }), 'sk-from-file');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildDshArgs runs headless read-only profile reading stdin', () => {
  assert.deepEqual(buildDshArgs(), [
    '--profile', 'headless',
    '--permission-mode', 'read-only',
    '--approval-policy', 'never',
    '-',
  ]);
});

test('dshCompletion isolates DSH_HOME, strips proxies/tokens, and captures stdout', async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'repo-guard-dsh-stub-'));
  const wsDir = mkdtempSync(join(tmpdir(), 'repo-guard-dsh-ws-'));
  const saved = {};
  for (const key of DSH_ENV_DENYLIST) {
    saved[key] = process.env[key];
    process.env[key] = `val-${key}`;
  }
  try {
    writeFileSync(join(wsDir, 'main.js'), 'export const ok = true;\n');
    const stub = join(stubDir, 'dsh-stub.mjs');
    writeFileSync(stub, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) {
  process.stdout.write('0.2.2-rc.5\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  process.stderr.write('dsh: reasoning: thinking...\\n');
  process.stdout.write(JSON.stringify({
    hasMain: existsSync(join(process.cwd(), 'main.js')),
    key: process.env.DEEPSEEK_API_KEY,
    telemetry: process.env.DSH_TELEMETRY_MODE,
    dshHome: process.env.DSH_HOME,
    leaked: ['GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY'].filter((k) => k in process.env),
    prompt: input,
  }));
});
`);
    chmodSync(stub, 0o755);

    const out = await dshCompletion({
      apiKey: 'sk-test-ds',
      system: 'SYS',
      messages: [{ role: 'user', content: 'PR' }],
      workspace: wsDir,
      executable: stub,
      timeoutMinutes: 1,
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hasMain, true);
    assert.equal(parsed.key, 'sk-test-ds');
    assert.equal(parsed.telemetry, 'DISABLED');
    assert.match(parsed.dshHome, /repo-guard-dsh-home-/);
    assert.deepEqual(parsed.leaked, []);
    assert.match(parsed.prompt, /PR/);
  } finally {
    for (const key of DSH_ENV_DENYLIST) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  }
});
