// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Review runs treat repository and PR content as untrusted input, so the CLI
// only gets repository lookup tools: no mutation, no Bash, no network egress.
export const CLAUDE_CODE_READONLY_TOOLS = 'Read,Grep,Glob';

const DEFAULT_TIMEOUT_MINUTES = 20;
const MAX_DIAGNOSTIC_CHARS = 400;

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
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--safe-mode', '--tools', tools];
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
}) {
  if (workspace && (!existsSync(workspace) || !statSync(workspace).isDirectory())) {
    throw new Error(`Claude Code workspace is not a directory: ${workspace}`);
  }

  const prompt = (messages || [])
    .map((message) => message?.content)
    .filter((content) => typeof content === 'string' && content.trim() !== '')
    .join('\n\n');
  if (prompt.trim() === '') {
    throw new Error('Claude Code received an empty prompt');
  }

  // Without a checkout the CLI still needs a working directory it can trust;
  // an empty scratch directory keeps it away from whatever cwd the caller has.
  const scratch = workspace ? null : mkdtempSync(join(tmpdir(), 'repo-guard-claude-'));
  try {
    const stdout = await runClaudeCode({
      executable,
      args: buildClaudeCodeArgs({ model, system }),
      prompt,
      cwd: workspace || scratch,
      timeoutMs: timeoutMinutes * 60_000,
    });
    return parseClaudeCodeOutput(stdout);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function runClaudeCode({ executable, args, prompt, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { spawnError = err; });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Claude Code timed out after ${timeoutMs / 60_000} minutes`));
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
