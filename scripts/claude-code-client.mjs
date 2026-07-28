// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Review runs treat repository and PR content as untrusted input, so the CLI
// only gets repository lookup tools: no mutation, no Bash, no network egress.
export const CLAUDE_CODE_READONLY_TOOLS = 'Read,Grep,Glob';

// Reads outside the working directory are already auto-denied in print mode
// (verified on 2.1.220: the attempt lands in permission_denials, content never
// read). These deny rules are defense in depth for the runner user's own
// credentials and the checkout's .git metadata; --settings is honored under
// --safe-mode (also verified on 2.1.220).
export const CLAUDE_CODE_PERMISSION_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      'Read(~/.claude/**)',
      'Read(~/.claude.json)',
      'Read(~/.claude.json.backup)',
      'Read(~/.config/claude/**)',
      'Read(./.git/**)',
    ],
  },
});

// The review process holds live credentials the CLI never needs (repo-write
// GitHub tokens, api-engine keys); stripping them from the child environment
// removes the leak surface instead of relying on the permission system alone.
// Claude's own auth (~/.claude OAuth, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY)
// stays intact.
export const CLAUDE_CODE_ENV_DENYLIST = ['GITHUB_TOKEN', 'GH_TOKEN', 'LLM_API_KEY', 'CEILF6_GITHUB_TOKEN'];

const DEFAULT_TIMEOUT_MINUTES = 20;
const MAX_DIAGNOSTIC_CHARS = 400;
// A misbehaving CLI that streams output for the whole timeout window must fail
// as a clear review error, not as runner OOM.
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Injection isolation rests entirely on --safe-mode/--tools semantics, which
// are only verified against a known CLI version. Anything older fails fast
// instead of running with an unverified security boundary.
export const MIN_VERIFIED_CLI_VERSION = '2.1.220';

export function parseClaudeCodeVersion(output) {
  const match = String(output ?? '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : '';
}

export function isClaudeCodeVersionSupported(version, minimum = MIN_VERIFIED_CLI_VERSION) {
  const actual = String(version).split('.').map(Number);
  const required = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

const cliVersionChecks = new Map();

function ensureVerifiedCliVersion(executable) {
  if (!cliVersionChecks.has(executable)) {
    cliVersionChecks.set(executable, verifyCliVersion(executable));
  }
  return cliVersionChecks.get(executable);
}

async function verifyCliVersion(executable) {
  let output;
  try {
    output = await runClaudeCode({
      executable,
      args: ['--version'],
      prompt: '',
      cwd: tmpdir(),
      timeoutMs: 30_000,
    });
  } catch (err) {
    // An unlaunchable executable fails the review run itself with a clearer
    // error than the probe could give; a flaky probe must not block reviews.
    console.warn(`Claude Code version probe failed (${err.message}); skipping the version guard`);
    return;
  }
  const version = parseClaudeCodeVersion(output);
  if (!version) {
    console.warn(`Claude Code version probe returned no parsable version; skipping the version guard: ${boundedDiagnostic(output)}`);
    return;
  }
  if (!isClaudeCodeVersionSupported(version)) {
    throw new Error(`Claude Code CLI ${version} is older than the verified minimum ${MIN_VERIFIED_CLI_VERSION}; --safe-mode/--tools semantics are unverified there, upgrade the CLI`);
  }
  console.log(`Claude Code CLI ${version} (verified minimum ${MIN_VERIFIED_CLI_VERSION})`);
}

export function parseClaudeCodeTimeoutMinutes(value, fallback = DEFAULT_TIMEOUT_MINUTES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`CLAUDE_CODE_TIMEOUT_MINUTES must be a positive number, got "${value}"`);
  }
  return minutes;
}

// --safe-mode keeps auth and built-in tools but refuses all customization
// loading (CLAUDE.md, .claude settings, hooks, MCP, plugins), so a reviewed
// checkout cannot smuggle instructions in through the trusted-config channel.
export function buildClaudeCodeArgs({ model, system, tools = CLAUDE_CODE_READONLY_TOOLS }) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--no-session-persistence',
    '--safe-mode',
    '--tools', tools,
    '--settings', CLAUDE_CODE_PERMISSION_SETTINGS,
  ];
  if (system) args.push('--append-system-prompt', system);
  if (model) args.push('--model', model);
  return args;
}

// An existing-but-empty workspace (e.g. github.workspace without a checkout
// step) must not make the reviewer believe it can verify repository context.
export function resolveClaudeCodeWorkspace(workspace) {
  if (!workspace) return '';
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Claude Code workspace is not a directory: ${workspace}`);
  }
  if (readdirSync(workspace).length === 0) {
    console.warn(`Claude Code workspace 为空目录，退化为 prompt-only 模式: ${workspace}`);
    return '';
  }
  return workspace;
}

export function parseClaudeCodeOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code returned non-JSON output: ${boundedDiagnostic(stdout)}`);
  }

  const subtype = typeof envelope?.subtype === 'string' ? envelope.subtype : 'unknown';
  const result = typeof envelope?.result === 'string' ? envelope.result : '';
  if (envelope?.is_error) {
    throw new Error(`Claude Code reported an error (subtype=${subtype}): ${boundedDiagnostic(result) || '(no detail)'}`);
  }
  if (result.trim() === '') {
    throw new Error(`Claude Code returned no usable text (subtype=${subtype})`);
  }
  return result;
}

function boundedDiagnostic(text) {
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_DIAGNOSTIC_CHARS
    ? `${flattened.slice(0, MAX_DIAGNOSTIC_CHARS)}…(truncated)`
    : flattened;
}

export async function claudeCodeCompletion({
  model,
  system,
  messages,
  workspace,
  executable = process.env.CLAUDE_CODE_EXECUTABLE || 'claude',
  timeoutMinutes = parseClaudeCodeTimeoutMinutes(process.env.CLAUDE_CODE_TIMEOUT_MINUTES),
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const resolvedWorkspace = resolveClaudeCodeWorkspace(workspace);
  // A system-prompt function sees the resolved workspace ('' when the run is
  // prompt-only), so callers cannot claim a checkout the CLI does not have.
  const systemPrompt = typeof system === 'function' ? system(resolvedWorkspace) : system;

  const prompt = (messages || [])
    .map((message) => message?.content)
    .filter((content) => typeof content === 'string' && content.trim() !== '')
    .join('\n\n');
  if (prompt.trim() === '') {
    throw new Error('Claude Code received an empty prompt');
  }

  await ensureVerifiedCliVersion(executable);

  // Without a checkout the CLI still needs a working directory it can trust;
  // an empty scratch directory keeps it away from whatever cwd the caller has.
  const scratch = resolvedWorkspace ? null : mkdtempSync(join(tmpdir(), 'repo-guard-claude-'));
  try {
    const stdout = await runClaudeCode({
      executable,
      args: buildClaudeCodeArgs({ model, system: systemPrompt }),
      prompt,
      cwd: resolvedWorkspace || scratch,
      timeoutMs: timeoutMinutes * 60_000,
      maxOutputBytes,
    });
    return parseClaudeCodeOutput(stdout);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function runClaudeCode({ executable, args, prompt, cwd, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const key of CLAUDE_CODE_ENV_DENYLIST) delete childEnv[key];

    const child = spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Chunks stay Buffers until the process closes: decoding per chunk would
    // corrupt multi-byte UTF-8 characters split across pipe reads, and the
    // output cap must meter real bytes, not UTF-16 code units.
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
        reject(new Error(`Claude Code output exceeded ${maxOutputBytes} bytes and the process was killed`));
        return;
      }
      if (timedOut) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout);
        reject(new Error(`Claude Code timed out after ${timeoutMs / 60_000} minutes${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (spawnError) {
        reject(new Error(`Failed to run Claude Code executable "${executable}": ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout) || '(no output)';
        reject(new Error(`Claude Code exited with code ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
