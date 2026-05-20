// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatCompletion } from './llm-client.mjs';
import { buildIssueUserMessage, buildPRUserMessage, getChangedNewLines, loadSystemPrompt } from './prompts.mjs';
import { extractInlineComments, extractRecommendation } from './review-logic.mjs';

export { getChangedNewLines };

const DEFAULT_MAX_TOKENS = 3200;
const DEFAULT_OUTPUT_DIR = 'quality-eval-results';

function prInfo(overrides = {}) {
  return {
    title: 'Untitled PR',
    body: '',
    base: 'main',
    head: 'feature',
    user: 'tester',
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...overrides,
  };
}

export function buildQualityEvalFixtures() {
  const prBugFiles = [
    {
      filename: 'src/auth.js',
      status: 'modified',
      additions: 3,
      deletions: 2,
      patch: `@@ -10,10 +10,11 @@ export function requireUser(req, res, next) {
   const token = req.headers.authorization?.replace('Bearer ', '');
   if (!token) {
-    return res.status(401).json({ error: 'missing token' });
+    return next();
   }
   const user = verifyToken(token);
   if (!user) {
-    return res.status(401).json({ error: 'invalid token' });
+    return next();
   }
   req.user = user;
   return next();
 }`,
    },
    {
      filename: 'tests/auth.test.js',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: `@@ -5,7 +5,8 @@ test('requires auth', async () => {
   const res = await request(app).get('/api/me');
-  expect(res.status).toBe(401);
+  expect([200, 401]).toContain(res.status);
+  expect(res.body).toBeDefined();
 });`,
    },
  ];

  const prLargeFiles = [
    {
      filename: 'snapshots/generated.txt',
      status: 'modified',
      additions: 5000,
      deletions: 0,
      patch: 'x'.repeat(120 * 1024),
    },
    {
      filename: 'src/parse-id.js',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: `@@ -1,5 +1,6 @@
 export function parseId(value) {
-  return Number(value);
+  return parseInt(value, 10);
 }`,
    },
  ];

  return [
    {
      id: 'pr-auth-bypass',
      kind: 'pr',
      expectation: 'REQUEST_CHANGES with actionable auth/security finding and inline comment on src/auth.js',
      system: loadSystemPrompt('pr', 'zh', 'Focus on user-visible correctness and security.'),
      user: buildPRUserMessage(
        prInfo({
          title: 'Make auth middleware more permissive',
          body: 'Avoid blocking requests when tokens are missing because some internal callers do not send auth headers.',
          head: 'auth-permissive',
          user: 'dev-a',
          additions: 5,
          deletions: 3,
          changedFiles: 2,
        }),
        prBugFiles,
      ),
      files: prBugFiles,
    },
    {
      id: 'pr-large-plus-small',
      kind: 'pr',
      expectation: 'Comment on parseId behavior despite a huge generated file being omitted',
      system: loadSystemPrompt('pr', 'zh', 'Focus on user-visible correctness.'),
      user: buildPRUserMessage(
        prInfo({
          title: 'Fix ID parsing and update generated snapshot',
          body: 'The generated snapshot is large. The source change adjusts ID parsing.',
          head: 'parse-id',
          user: 'dev-b',
          additions: 5001,
          deletions: 1,
          changedFiles: 2,
        }),
        prLargeFiles,
      ),
      files: prLargeFiles,
    },
    {
      id: 'issue-vague-crash',
      kind: 'issue',
      expectation: 'Ask for minimum useful reproduction info, not a long template lecture',
      system: loadSystemPrompt('issue', 'zh', ''),
      user: buildIssueUserMessage({
        title: '登录后偶发 500',
        body: '登录以后偶尔报 500，但我不知道怎么复现。用户反馈挺多的。',
        labels: ['bug'],
        user: 'reporter-a',
        state: 'open',
      }),
    },
    {
      id: 'issue-ready-feature',
      kind: 'issue',
      expectation: 'Mark as ready or triage decision, avoid filler suggestions',
      system: loadSystemPrompt('issue', 'zh', ''),
      user: buildIssueUserMessage({
        title: 'Add dry-run mode for repository review',
        body: `Problem: maintainers want to preview Repo Guard output without posting comments.

Proposal:
- Add input dry-run: true.
- When enabled, run the same review path but print the generated comment to logs instead of posting.
- Keep default behavior unchanged.

Acceptance criteria:
- Existing workflows keep posting comments by default.
- dry-run prevents issue comments and PR reviews.
- Unit tests cover both issue and PR modes.`,
        labels: ['enhancement'],
        user: 'reporter-b',
        state: 'open',
      }),
    },
  ];
}

export function getEnvConfig(env = process.env) {
  return {
    provider: env.PROVIDER || env.LLM_PROVIDER || '',
    baseURL: env.BASE_URL || env.LLM_BASE_URL || '',
    apiKey: env.API_KEY || env.LLM_API_KEY || '',
    model: env.MODEL || env.LLM_MODEL || '',
    maxTokens: Number.parseInt(env.MAX_TOKENS || env.LLM_MAX_TOKENS || `${DEFAULT_MAX_TOKENS}`, 10),
    outputDir: env.QUALITY_EVAL_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
  };
}

export function getSuggestionsSection(response) {
  return getSection(response, '### Suggestions', '### Summary');
}

function getSection(response, heading, nextHeading) {
  const start = response.indexOf(heading);
  if (start === -1) return '';
  const end = nextHeading ? response.indexOf(nextHeading, start + heading.length) : -1;
  return response.slice(start, end === -1 ? undefined : end);
}

export function scoreQualityEvalResponse(fixture, response) {
  const checks = [];
  const has = (label, pass) => checks.push({ label, pass: Boolean(pass) });

  if (fixture.kind === 'pr') {
    const recommendation = extractRecommendation(response);
    const inlineComments = extractInlineComments(response, fixture.files || []);
    const changedLinesByPath = new Map((fixture.files || []).map((file) => [file.filename, getChangedNewLines(file)]));
    const targetsChangedLine = (comment) => changedLinesByPath.get(comment.path)?.has(comment.line) || false;
    has('has CR report heading', /^## CR Report:/im.test(response));
    has('has recommendation marker', /\*\*Recommendation:\*\*/i.test(response));
    has('has decision summary', /\*\*Decision Summary:\*\*/i.test(response));
    has('does not echo inline template meta instruction', !response.includes('line-specific `[path:line]` findings') && !response.includes('Use `[path/to/file.ext:42]'));
    has('has concise fix direction', /fix|修复|reject|拒绝|restore|恢复|validate|校验|401|鉴权|认证|解析|parse/i.test(response));
    if (fixture.id === 'pr-auth-bypass') {
      has('auth bypass recommends changes', recommendation === 'REQUEST_CHANGES');
      has('auth bypass has inline src/auth.js comment', inlineComments.some((comment) => comment.path === 'src/auth.js'));
      has('auth bypass inline targets changed src/auth.js line', inlineComments.some((comment) => comment.path === 'src/auth.js' && targetsChangedLine(comment)));
    }
    if (fixture.id === 'pr-large-plus-small') {
      has('large fixture discusses parse-id', /parse-id|parseId|Number|parseInt|解析/.test(response));
      has('large fixture has inline parse-id comment', inlineComments.some((comment) => comment.path === 'src/parse-id.js'));
      has('large fixture inline targets changed parse-id line', inlineComments.some((comment) => comment.path === 'src/parse-id.js' && targetsChangedLine(comment)));
    }
  } else {
    has('has issue analysis heading', /## Issue Analysis:/i.test(response));
    has('has quality score', /\*\*Quality Score:\*\*/i.test(response));
    has('has priority suggestion', /\*\*Priority Suggestion:\*\*/i.test(response));
    has('has maintainer next action', /\*\*Maintainer Next Action:\*\*/i.test(response));
    has('avoids abstract missing-info labels in suggestions', !/Environment info is missing|Reproduction steps are incomplete/.test(response));
    if (fixture.id === 'issue-vague-crash') {
      has('vague crash asks for reproduction or logs', /复现|日志|错误|500|版本|触发/.test(response));
      has('vague crash does not mark ready', !/\*\*Maintainer Next Action:\*\*\s*Ready to work/i.test(response));
    }
    if (fixture.id === 'issue-ready-feature') {
      const suggestions = getSuggestionsSection(response);
      has('ready feature avoids noisy suggestion pile', (suggestions.match(/^- /gm) || []).length <= 2);
      has('ready feature recognizes actionable acceptance criteria', /Ready to work|Needs triage decision|可开始|排期|决策/.test(response));
    }
  }

  return {
    passed: checks.filter((check) => check.pass).length,
    total: checks.length,
    checks,
  };
}

export async function runQualityEvaluation(config = getEnvConfig()) {
  validateConfig(config);

  const runDir = join(config.outputDir, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });

  const results = [];
  for (const fixture of buildQualityEvalFixtures()) {
    const response = await chatCompletion({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxTokens: config.maxTokens,
      system: fixture.system,
      messages: [{ role: 'user', content: fixture.user }],
    });
    const score = scoreQualityEvalResponse(fixture, response);
    writeFileSync(join(runDir, `${fixture.id}.md`), response);
    results.push({
      id: fixture.id,
      kind: fixture.kind,
      expectation: fixture.expectation,
      promptChars: fixture.system.length + fixture.user.length,
      responseChars: response.length,
      score,
    });
  }

  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(results, null, 2));
  return { outputDir: runDir, results };
}

function validateConfig(config) {
  const missing = [];
  if (!config.provider) missing.push('PROVIDER or LLM_PROVIDER');
  if (!config.model) missing.push('MODEL or LLM_MODEL');
  if (!config.apiKey) missing.push('API_KEY or LLM_API_KEY');
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    missing.push('MAX_TOKENS or LLM_MAX_TOKENS as a positive integer');
  }
  if (missing.length > 0) {
    throw new Error(`Missing quality evaluation config: ${missing.join(', ')}`);
  }
}

async function main() {
  const result = await runQualityEvaluation();
  console.log(JSON.stringify(redactResult(result), null, 2));
}

function redactResult(result) {
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Quality evaluation failed:', err.message);
    process.exit(1);
  });
}
