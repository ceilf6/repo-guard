// @ts-check
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_AGY_MODEL = 'claude-opus-5-5-high';

// Security isolation (Seatbelt/namespace --sandbox, proceed-in-sandbox, inline
// --settings permissions.deny, and stream-json envelope semantics) was verified
// empirically on Antigravity CLI 1.5.15.
export const MIN_VERIFIED_AGY_VERSION = '1.5.15';

// Strip live GitHub/API tokens from the child environment so even if a tool
// boundary regresses, no repo-write or relay secret exists in process.env.
export const AGY_ENV_DENYLIST = ['GITHUB_TOKEN', 'GH_TOKEN', 'LLM_API_KEY', 'CEILF6_GITHUB_TOKEN'];

// Antigravity automatically discovers rules, skills, hooks, plugins, and MCP
// servers from workspace directories (.agents/.agent/_agents/_agent, GEMINI.md,
// AGENTS.md). Stripping these (plus .git and heavy/untrusted dirs) when staging
// the review copy ensures untrusted PR checkouts cannot inject instructions or
// execute hooks/MCP servers, and .git credentials are physically absent.
export const AGY_STRIPPED_ENTRY_NAMES = new Set([
  '.git',
  '.agents',
  '.agent',
  '_agents',
  '_agent',
  '.claude',
  '.codex',
  '.dsh',
  'gemini.md',
  'agents.md',
  'claude.md',
  'node_modules',
]);

const DEFAULT_TIMEOUT_MINUTES = 20;
const MAX_DIAGNOSTIC_CHARS = 400;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_STAGED_BYTES = 200 * 1024 * 1024;

export function buildAgyPermissionSettings(home = homedir()) {
  const credentialDirs = ['.gemini', '.ssh', '.claude', '.config', '.aws', '.gnupg']
    .filter(() => Boolean(home))
    .map((dir) => `read_file(${join(home, dir).replace(/\\/g, '/')})`);

  return JSON.stringify({
    enableTerminalSandbox: true,
    toolPermission: 'proceed-in-sandbox',
    allowNonWorkspaceAccess: false,
    permissions: {
      deny: [
        'write_file(*)',
        'unsandboxed(*)',
        'read_url(*)',
        'execute_url(*)',
        'mcp(*)',
        'read_file(.git)',
        ...credentialDirs,
      ],
    },
  });
}

export function parseAgyVersion(output) {
  const match = String(output ?? '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : '';
}

export function isAgyVersionSupported(version, minimum = MIN_VERIFIED_AGY_VERSION) {
  const actual = String(version).split('.').map(Number);
  const required = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

const agyVersionChecks = new Map();

function ensureVerifiedAgyVersion(executable) {
  if (!agyVersionChecks.has(executable)) {
    agyVersionChecks.set(executable, verifyAgyVersion(executable));
  }
  return agyVersionChecks.get(executable);
}

async function verifyAgyVersion(executable) {
  let output;
  try {
    output = await runAgyProcess({
      executable,
      args: ['--version'],
      stdinPayload: '',
      cwd: tmpdir(),
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(`Antigravity CLI version probe failed (${err.message}); skipping the version guard`);
    return;
  }
  const version = parseAgyVersion(output);
  if (!version) {
    console.warn(`Antigravity CLI version probe returned no parsable version; skipping the version guard: ${boundedDiagnostic(output)}`);
    return;
  }
  if (!isAgyVersionSupported(version)) {
    throw new Error(`Antigravity CLI ${version} is older than the verified minimum ${MIN_VERIFIED_AGY_VERSION}; sandbox/permission semantics are unverified there, upgrade agy`);
  }
  console.log(`Antigravity CLI ${version} (verified minimum ${MIN_VERIFIED_AGY_VERSION})`);
}

export function parseAgyTimeoutMinutes(value, fallback = DEFAULT_TIMEOUT_MINUTES) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`AGY_TIMEOUT_MINUTES must be a positive number, got "${value}"`);
  }
  return minutes;
}

export function shouldStripWorkspaceEntry(name) {
  return AGY_STRIPPED_ENTRY_NAMES.has(String(name ?? '').toLowerCase());
}

export function resolveAgyWorkspace(workspace) {
  if (!workspace) return '';
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Antigravity workspace is not a directory: ${workspace}`);
  }
  const visibleEntries = readdirSync(workspace).filter((name) => !shouldStripWorkspaceEntry(name));
  if (visibleEntries.length === 0) {
    console.warn(`Antigravity workspace 为空目录（或仅含被隔离元数据），退化为 prompt-only 模式: ${workspace}`);
    return '';
  }
  return workspace;
}

// Stages a read-only, customization-stripped copy of the checkout in tmpdir so:
// 1) .git credentials and untrusted .agents/GEMINI.md/AGENTS.md hooks/rules are physically absent;
// 2) symlinks are skipped so a PR cannot smuggle host-file pointers into the workspace;
// 3) chmod 0555/0444 prevents in-sandbox commands from mutating review data.
export function stageAgyWorkspace(resolvedWorkspace, { maxBytes = DEFAULT_MAX_STAGED_BYTES } = {}) {
  const stageDir = mkdtempSync(join(tmpdir(), 'repo-guard-agy-'));
  if (!resolvedWorkspace) {
    chmodSync(stageDir, 0o555);
    return {
      cwd: stageDir,
      hasFiles: false,
      cleanup: () => cleanupReadOnlyTree(stageDir),
    };
  }

  let copiedBytes = 0;
  let copiedFiles = 0;
  let budgetExceeded = false;

  const copyTree = (srcDir, destDir) => {
    const entries = readdirSync(srcDir);
    for (const name of entries) {
      if (budgetExceeded) break;
      if (shouldStripWorkspaceEntry(name)) continue;

      const srcPath = join(srcDir, name);
      let lst;
      try {
        lst = lstatSync(srcPath);
      } catch {
        continue;
      }
      // Never follow or recreate symlinks from untrusted PR checkouts.
      if (lst.isSymbolicLink()) continue;

      const destPath = join(destDir, name);
      if (lst.isDirectory()) {
        mkdirSync(destPath, { mode: 0o700 });
        copyTree(srcPath, destPath);
        chmodSync(destPath, 0o555);
      } else if (lst.isFile()) {
        if (copiedBytes + lst.size > maxBytes) {
          budgetExceeded = true;
          console.warn(`Antigravity workspace staging reached ${maxBytes} bytes cap; remaining files skipped`);
          break;
        }
        copyFileSync(srcPath, destPath);
        chmodSync(destPath, 0o444);
        copiedBytes += lst.size;
        copiedFiles += 1;
      }
    }
  };

  try {
    copyTree(resolvedWorkspace, stageDir);
    chmodSync(stageDir, 0o555);
  } catch (err) {
    cleanupReadOnlyTree(stageDir);
    throw err;
  }

  return {
    cwd: stageDir,
    hasFiles: copiedFiles > 0,
    cleanup: () => cleanupReadOnlyTree(stageDir),
  };
}

function cleanupReadOnlyTree(rootDir) {
  const makeWritable = (dir) => {
    try {
      chmodSync(dir, 0o700);
      for (const name of readdirSync(dir)) {
        const child = join(dir, name);
        try {
          const lst = lstatSync(child);
          if (lst.isDirectory()) makeWritable(child);
          else chmodSync(child, 0o600);
        } catch {
          // Ignore best-effort cleanup errors on individual children.
        }
      }
    } catch {
      // Ignore if directory already removed.
    }
  };
  makeWritable(rootDir);
  rmSync(rootDir, { recursive: true, force: true });
}

export function buildAgyArgs({
  model = DEFAULT_AGY_MODEL,
  timeoutMinutes = DEFAULT_TIMEOUT_MINUTES,
  settings = buildAgyPermissionSettings(),
} = {}) {
  const resolvedModel = String(model ?? '').trim() || DEFAULT_AGY_MODEL;
  const timeoutSeconds = Math.max(1, Math.ceil(Number(timeoutMinutes) * 60));
  return [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--sandbox',
    '--settings', settings,
    '--print-timeout', `${timeoutSeconds}s`,
    '--model', resolvedModel,
  ];
}

export function buildAgyStdinPayload({ system, messages }) {
  const userContent = (messages || [])
    .map((message) => message?.content)
    .filter((content) => typeof content === 'string' && content.trim() !== '')
    .join('\n\n');
  if (userContent.trim() === '') {
    throw new Error('Antigravity CLI received an empty prompt');
  }

  const combined = system && String(system).trim() !== ''
    ? [
        '<system_instructions>',
        String(system).trim(),
        '</system_instructions>',
        '',
        '<review_target>',
        userContent,
        '</review_target>',
      ].join('\n')
    : userContent;

  return `${JSON.stringify({ event: 'user', message: { content: combined } })}\n`;
}

// In stream-json mode, result.response concatenates every agent_response step
// across the turn, including pre-tool narration ("我将先查看调用方..."). Grouping
// text_delta by step_index and selecting the final non-empty agent_response
// step preserves the exact post-tool review contract without preamble noise.
export function parseAgyStreamOutput(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Antigravity CLI returned empty stdout');
  }

  /** @type {Map<number, string>} */
  const stepTexts = new Map();
  let resultPayload = null;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Antigravity CLI returned non-JSON stream line: ${boundedDiagnostic(line)}`);
    }

    if (parsed?.event === 'step_update' && parsed.step_update?.step_type === 'agent_response') {
      const idx = Number(parsed.step_update.step_index ?? 0);
      const delta = typeof parsed.step_update.text_delta === 'string' ? parsed.step_update.text_delta : '';
      if (delta) {
        stepTexts.set(idx, (stepTexts.get(idx) || '') + delta);
      }
    } else if (parsed?.event === 'result' && parsed.result) {
      resultPayload = parsed.result;
    }
  }

  if (!resultPayload) {
    throw new Error(`Antigravity CLI stream ended without a result event: ${boundedDiagnostic(stdout)}`);
  }

  const status = typeof resultPayload.status === 'string' ? resultPayload.status : 'UNKNOWN';
  if (status !== 'SUCCESS') {
    const detail = boundedDiagnostic(resultPayload.error || resultPayload.response || '');
    throw new Error(`Antigravity CLI reported status=${status}${detail ? `: ${detail}` : ''}`);
  }

  const orderedStepTexts = [...stepTexts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .filter((text) => text.trim() !== '');

  const finalText = orderedStepTexts.length > 0
    ? orderedStepTexts[orderedStepTexts.length - 1]
    : (typeof resultPayload.response === 'string' ? resultPayload.response : '');

  if (finalText.trim() === '') {
    const denied = Array.isArray(resultPayload.denied_actions) && resultPayload.denied_actions.length > 0
      ? ` (denied_actions=${resultPayload.denied_actions.map((d) => d?.action || 'unknown').join(',')})`
      : '';
    throw new Error(`Antigravity CLI returned no usable text (status=${status})${denied}`);
  }

  return finalText;
}

function boundedDiagnostic(text) {
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_DIAGNOSTIC_CHARS
    ? `${flattened.slice(0, MAX_DIAGNOSTIC_CHARS)}…(truncated)`
    : flattened;
}

export async function agyCompletion({
  model = DEFAULT_AGY_MODEL,
  system,
  messages,
  workspace,
  executable = process.env.AGY_EXECUTABLE || 'agy',
  timeoutMinutes = parseAgyTimeoutMinutes(process.env.AGY_TIMEOUT_MINUTES),
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  const resolvedWorkspace = resolveAgyWorkspace(workspace);
  const staged = stageAgyWorkspace(resolvedWorkspace);

  try {
    const effectiveWorkspace = staged.hasFiles ? staged.cwd : '';
    const systemPrompt = typeof system === 'function' ? system(effectiveWorkspace) : system;
    const stdinPayload = buildAgyStdinPayload({ system: systemPrompt, messages });

    await ensureVerifiedAgyVersion(executable);

    const stdout = await runAgyProcess({
      executable,
      args: buildAgyArgs({ model, timeoutMinutes }),
      stdinPayload,
      cwd: staged.cwd,
      // Give the outer SIGKILL timer a 30s grace buffer past --print-timeout so
      // agy can emit a structured timeout error before hard kill if responsive.
      timeoutMs: timeoutMinutes * 60_000 + 30_000,
      hardTimeoutMinutes: timeoutMinutes,
      maxOutputBytes,
    });
    return parseAgyStreamOutput(stdout);
  } finally {
    staged.cleanup();
  }
}

function runAgyProcess({
  executable,
  args,
  stdinPayload,
  cwd,
  timeoutMs,
  hardTimeoutMinutes = timeoutMs / 60_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const key of AGY_ENV_DENYLIST) delete childEnv[key];
    // Ensure ~/.local/bin (standard agy install location) is always on PATH
    // even inside minimal launchd/systemd runner environments.
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
        reject(new Error(`Antigravity CLI output exceeded ${maxOutputBytes} bytes and the process was killed`));
        return;
      }
      if (timedOut) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout);
        reject(new Error(`Antigravity CLI timed out after ${hardTimeoutMinutes} minutes${detail ? `: ${detail}` : ''}`));
        return;
      }
      if (spawnError) {
        reject(new Error(`Failed to run Antigravity CLI executable "${executable}": ${spawnError.message}`));
        return;
      }
      if (code !== 0) {
        const detail = boundedDiagnostic(stderr) || boundedDiagnostic(stdout) || '(no output)';
        reject(new Error(`Antigravity CLI exited with code ${code}: ${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdinPayload);
  });
}
