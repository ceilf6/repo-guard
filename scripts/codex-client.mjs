// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgyWorkspace, stageAgyWorkspace } from './agy-client.mjs';

export const MIN_VERIFIED_CODEX_VERSION = '0.171.0';
export const CODEX_ENV_DENYLIST = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LLM_API_KEY',
  'CEILF6_GITHUB_TOKEN',
  // Clear runner HTTP_PROXY (locked to Claude residential exit on 7897) so
  // Codex uses its native OpenAI route rather than sharing Claude's exit IP.
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

export function parseCodexVersion(output) {
  const match = String(output ?? '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : '';
}

export function isCodexVersionSupported(version, minimum = MIN_VERIFIED_CODEX_VERSION) {
  const actual = String(version).split('.').map(Number);
  const required = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

const codexVersionChecks = new Map();

function ensureVerifiedCodexVersion(executable) {
  if (!codexVersionChecks.has(executable)) {
    codexVersionChecks.set(executable, verifyCodexVersion(executable));
  }
  return codexVersionChecks.get(executable);
}

async function verifyCodexVersion(executable) {
  let output;
  try {
    output = await runCodexProcess({
      executable,
      args: ['--version'],
      prompt: '',
      cwd: tmpdir(),
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(`Codex CLI version probe failed (${err.message}); skipping the version guard`);
    return;
  }
  const version = parseCodexVersion(output);
  if (!version) {
    console.warn(`Codex CLI version probe returned no parsable version; skipping the version guard: ${boundedDiagnostic(output)}`);
    return;
  }
  if (!isCodexVersionSupported(version)) {
    throw new Error(`Codex CLI ${version} is older than the verified minimum ${MIN_VERIFIED_CODEX_VERSION}; upgrade codex`);
  }
  console.log(`Codex CLI ${version} (verified minimum ${MIN_VERIFIED_CODEX_VERSION})`);
}

export function parseCodexTimeoutMinutes(value, fallback = DEFAULT_TIMEOUT_MINUTES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`CODEX_TIMEOUT_MINUTES must be a positive number, got "${value}"`);
  }
  return minutes;
}

export function buildCodexArgs({ model = '', cwd, outputFile }) {
  const args = [
    'exec',
    '-',
    '-C', cwd,
    '--sandbox', 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--disable', 'codex_hooks',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
  ];
  if (model && String(model).trim() !== '') {
    args.push('-m', String(model).trim());
  }
  if (outputFile) {
    args.push('-o', outputFile);
  }
  return args;
}

export function buildCodexPrompt({ system, messages }) {
  const userContent = (messages || [])
    .map((message) => message?.content)
    .filter((content) => typeof content === 'string' && content.trim() !== '')
    .join('\n\n');
  if (userContent.trim() === '') {
    throw new Error('Codex CLI received an empty prompt');
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

export async function codexCompletion({
  model = '',
  system,
  messages,
  workspace,
  executable = process.env.CODEX_EXECUTABLE || 'codex',
  timeoutMinutes = parseCodexTimeoutMinutes(process.env.CODEX_TIMEOUT_MINUTES),
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const resolvedWorkspace = resolveAgyWorkspace(workspace);
  const staged = stageAgyWorkspace(resolvedWorkspace);
  const outDir = mkdtempSync(join(tmpdir(), 'repo-guard-codex-out-'));
  const outputFile = join(outDir, 'last-message.txt');

  try {
    const effectiveWorkspace = staged.hasFiles ? staged.cwd : '';
    const systemPrompt = typeof system === 'function' ? system(effectiveWorkspace) : system;
    const prompt = buildCodexPrompt({ system: systemPrompt, messages });

    await ensureVerifiedCodexVersion(executable);

    const stdout = await runCodexProcess({
      executable,
      args: buildCodexArgs({ model, cwd: staged.cwd, outputFile }),
      prompt,
      cwd: staged.cwd,
      timeoutMs: timeoutMinutes * 60_000,
      maxOutputBytes,
    });

    const lastMessage = existsSync(outputFile)
      ? readFileSync(outputFile, 'utf8')
      : stdout;
    if (String(lastMessage || '').trim() === '') {
      throw new Error('Codex CLI returned no usable text');
    }
    return lastMessage;
  } finally {
    staged.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
}

function runCodexProcess({ executable, args, prompt, cwd, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const key of CODEX_ENV_DENYLIST) delete childEnv[key];
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
        reject(new Error(`Codex CLI output exceeded ${maxOutputBytes} bytes and the process was killed`));
        return;
      }
      if (timedOut) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout);
        reject(new Error(`Codex CLI timed out after ${timeoutMs / 60_000} minutes${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (spawnError) {
        reject(new Error(`Failed to run Codex CLI executable "${executable}": ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout) || '(no output)';
        reject(new Error(`Codex CLI exited with code ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
