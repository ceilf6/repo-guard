// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgyWorkspace, stageAgyWorkspace } from './agy-client.mjs';

export const MIN_VERIFIED_DSH_VERSION = '0.2.2';
export const DSH_ENV_DENYLIST = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LLM_API_KEY',
  'CEILF6_GITHUB_TOKEN',
  // DeepSeek official API (api.deepseek.com) is domestic CN; clear runner HTTP
  // proxy so requests connect directly instead of detouring via US residential SSH.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

const DEFAULT_TIMEOUT_MINUTES = 20;
const MAX_DIAGNOSTIC_CHARS = 400;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export function parseDshVersion(output) {
  const match = String(output ?? '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : '';
}

export function isDshVersionSupported(version, minimum = MIN_VERIFIED_DSH_VERSION) {
  const actual = String(version).split('.').map(Number);
  const required = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

export function resolveDeepSeekApiKey({
  explicitKey = '',
  env = process.env,
  home = homedir(),
} = {}) {
  if (explicitKey && String(explicitKey).trim() !== '') return String(explicitKey).trim();
  if (env.DEEPSEEK_API_KEY && String(env.DEEPSEEK_API_KEY).trim() !== '') {
    return String(env.DEEPSEEK_API_KEY).trim();
  }
  if (home) {
    const keyFile = join(home, '.dsh', 'deepseek_api_key');
    if (existsSync(keyFile)) {
      const fileKey = readFileSync(keyFile, 'utf8').trim();
      if (fileKey) return fileKey;
    }
  }
  return '';
}

const dshVersionChecks = new Map();

function ensureVerifiedDshVersion(executable) {
  if (!dshVersionChecks.has(executable)) {
    dshVersionChecks.set(executable, verifyDshVersion(executable));
  }
  return dshVersionChecks.get(executable);
}

async function verifyDshVersion(executable) {
  let output;
  try {
    output = await runDshProcess({
      executable,
      args: ['--version'],
      prompt: '',
      cwd: tmpdir(),
      dshHome: tmpdir(),
      apiKey: 'probe',
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(`DeepSeek Harness (dsh) version probe failed (${err.message}); skipping the version guard`);
    return;
  }
  const version = parseDshVersion(output);
  if (!version) {
    console.warn(`DeepSeek Harness (dsh) version probe returned no parsable version; skipping the version guard: ${boundedDiagnostic(output)}`);
    return;
  }
  if (!isDshVersionSupported(version)) {
    throw new Error(`DeepSeek Harness (dsh) ${version} is older than the verified minimum ${MIN_VERIFIED_DSH_VERSION}; upgrade @deepseek-ai/dsh`);
  }
  console.log(`DeepSeek Harness CLI ${version} (verified minimum ${MIN_VERIFIED_DSH_VERSION})`);
}

export function parseDshTimeoutMinutes(value, fallback = DEFAULT_TIMEOUT_MINUTES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`DSH_TIMEOUT_MINUTES must be a positive number, got "${value}"`);
  }
  return minutes;
}

export function buildDshArgs() {
  return [
    '--profile', 'headless',
    '--permission-mode', 'read-only',
    '--approval-policy', 'never',
    '-',
  ];
}

export function buildDshPrompt({ system, messages }) {
  const userContent = (messages || [])
    .map((message) => message?.content)
    .filter((content) => typeof content === 'string' && content.trim() !== '')
    .join('\n\n');
  if (userContent.trim() === '') {
    throw new Error('DeepSeek Harness (dsh) received an empty prompt');
  }
  if (!system || String(system).trim() === '') return userContent;
  return [
    '<system_instructions>',
    String(system).trim(),
    '</system_instructions>',
    '',
    '<review_target>',
    userContent,
    '</review_target>',
  ].join('\n');
}

function boundedDiagnostic(text) {
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_DIAGNOSTIC_CHARS
    ? `${flattened.slice(0, MAX_DIAGNOSTIC_CHARS)}…(truncated)`
    : flattened;
}

export async function dshCompletion({
  system,
  messages,
  workspace,
  apiKey = '',
  executable = process.env.DSH_EXECUTABLE || 'dsh',
  timeoutMinutes = parseDshTimeoutMinutes(process.env.DSH_TIMEOUT_MINUTES),
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const resolvedKey = resolveDeepSeekApiKey({ explicitKey: apiKey });
  if (!resolvedKey) {
    throw new Error('DEEPSEEK_API_KEY is required for the dsh engine (set DEEPSEEK_API_KEY or ~/.dsh/deepseek_api_key)');
  }

  const resolvedWorkspace = resolveAgyWorkspace(workspace);
  const staged = stageAgyWorkspace(resolvedWorkspace);
  const isolatedDshHome = mkdtempSync(join(tmpdir(), 'repo-guard-dsh-home-'));

  try {
    const effectiveWorkspace = staged.hasFiles ? staged.cwd : '';
    const systemPrompt = typeof system === 'function' ? system(effectiveWorkspace) : system;
    const prompt = buildDshPrompt({ system: systemPrompt, messages });

    await ensureVerifiedDshVersion(executable);

    const stdout = await runDshProcess({
      executable,
      args: buildDshArgs(),
      prompt,
      cwd: staged.cwd,
      dshHome: isolatedDshHome,
      apiKey: resolvedKey,
      timeoutMs: timeoutMinutes * 60_000,
      maxOutputBytes,
    });

    if (String(stdout || '').trim() === '') {
      throw new Error('DeepSeek Harness (dsh) returned no usable text');
    }
    return stdout;
  } finally {
    staged.cleanup();
    rmSync(isolatedDshHome, { recursive: true, force: true });
  }
}

function runDshProcess({
  executable,
  args,
  prompt,
  cwd,
  dshHome,
  apiKey,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
    };
    for (const key of DSH_ENV_DENYLIST) delete childEnv[key];
    const localBin = join(homedir(), '.local', 'bin');
    const currentPath = childEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
    if (!currentPath.split(':').includes(localBin)) {
      childEnv.PATH = `${localBin}:/opt/homebrew/bin:/usr/local/bin:${currentPath}`;
    }

    const child = spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let spawnError;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (chunks, chunk) => {
      if (overflowed) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', (chunk) => collect(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => collect(stderrChunks, chunk));
    child.on('error', (err) => { spawnError = err; });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (overflowed) {
        reject(new Error(`DeepSeek Harness (dsh) output exceeded ${maxOutputBytes} bytes and the process was killed`));
        return;
      }
      if (timedOut) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout);
        reject(new Error(`DeepSeek Harness (dsh) timed out after ${timeoutMs / 60_000} minutes${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (spawnError) {
        reject(new Error(`Failed to run DeepSeek Harness executable "${executable}": ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout) || '(no output)';
        reject(new Error(`DeepSeek Harness (dsh) exited with code ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
