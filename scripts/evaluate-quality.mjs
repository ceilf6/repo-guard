// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatCompletion } from './llm-client.mjs';
import { parseStructuredOutputMode } from './openrouter-structured-output.mjs';
import { buildIssueUserMessage, buildPRUserMessage, getChangedNewLines, loadSystemPrompt } from './prompts.mjs';
import { extractInlineComments, extractRecommendation, normalizeReviewResponse, stripThinkingBlocks } from './review-logic.mjs';
import { getReviewResponseFormat } from './review-contracts.mjs';

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

  const prLinkedIssueFiles = [
    {
      filename: 'scripts/review.mjs',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: `@@ -5,8 +5,10 @@ async function finishReview({ dryRun, kind, body }) {
   if (dryRun && kind === 'issue') {
     console.log(body);
     return;
   }
+  if (kind === 'issue') {
+    return postComment(body);
+  }
   return postPRReview(body);
 }`,
    },
  ];

  return [
    {
      id: 'pr-auth-bypass',
      kind: 'pr',
      expectation: '请求修改，并给出可执行的鉴权/安全发现和 src/auth.js 行级评论',
      system: loadSystemPrompt('pr', '重点关注用户可见的正确性和安全风险。'),
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
      expectation: '即使巨大生成文件被省略，也要评论 parseId 行为变化',
      system: loadSystemPrompt('pr', '重点关注用户可见的正确性。'),
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
      id: 'pr-linked-issue-context',
      kind: 'pr',
      expectation: '结合关联 Issue #77 的验收标准，发现 dry-run 仍会发布 PR review',
      system: loadSystemPrompt('pr', '重点检查 PR 是否满足关联 issue 的验收标准。'),
      user: buildPRUserMessage(
        prInfo({
          title: 'Add dry-run mode',
          body: 'Closes #77. This adds dry-run handling for review publishing.',
          head: 'dry-run',
          user: 'dev-c',
          additions: 3,
          deletions: 1,
          changedFiles: 1,
        }),
        prLinkedIssueFiles,
        {
          issues: [{
            number: 77,
            title: 'Add dry-run mode for repository review',
            state: 'open',
            user: 'reporter-c',
            labels: ['enhancement'],
            url: 'https://github.com/owner/repo/issues/77',
            sources: ['linked', 'body-ref'],
            body: `Problem: maintainers want to preview Repo Guard output without posting comments.

Acceptance criteria:
- Existing workflows keep posting comments by default.
- dry-run prevents issue comments and PR reviews.
- Unit tests cover both issue and PR modes.`,
          }],
          warnings: [],
        },
      ),
      files: prLinkedIssueFiles,
    },
    {
      id: 'issue-vague-crash',
      kind: 'issue',
      expectation: '询问最小有用复现信息，而不是输出模板说教',
      system: loadSystemPrompt('issue'),
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
      expectation: '标记为可以开始或需要分诊决策，并避免填充式建议',
      system: loadSystemPrompt('issue'),
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
    structuredOutput: parseStructuredOutputMode(env.STRUCTURED_OUTPUT || env.LLM_STRUCTURED_OUTPUT),
    outputDir: env.QUALITY_EVAL_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
  };
}

export function getSuggestionsSection(response) {
  return getSection(response, '### 建议', '### 总结');
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
    has('has CR report heading', /^## 代码评审报告:/im.test(response));
    has('has recommendation marker', /\*\*处理建议:\*\*/.test(response));
    has('has decision summary', /\*\*决策摘要:\*\*/.test(response));
    has('does not echo inline template meta instruction', !response.includes('line-specific `[path:line]` findings') && !response.includes('Use `[path/to/file.ext:42]') && !response.includes('行级发现必须以方括号形式'));
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
    if (fixture.id === 'pr-linked-issue-context') {
      has('linked issue context is used', /Issue #77|acceptance criteria|验收|dry-run prevents issue comments and PR reviews|PR reviews/i.test(response));
      has('linked issue fixture recommends changes', recommendation === 'REQUEST_CHANGES');
    }
  } else {
    has('has issue analysis heading', /^## Issue 分析:/im.test(response));
    has('has quality score', /\*\*质量评分:\*\*/.test(response));
    has('has priority suggestion', /\*\*优先级建议:\*\*/.test(response));
    has('has maintainer next action', /\*\*维护者下一步动作:\*\*/.test(response));
    has('avoids abstract missing-info labels in suggestions', !/Environment info is missing|Reproduction steps are incomplete/.test(response));
    if (fixture.id === 'issue-vague-crash') {
      has('vague crash asks for reproduction or logs', /复现|日志|错误|500|版本|触发/.test(response));
      has('vague crash does not mark ready', !/\*\*维护者下一步动作:\*\*\s*可以开始/.test(response));
    }
    if (fixture.id === 'issue-ready-feature') {
      const suggestions = getSuggestionsSection(response);
      has('ready feature avoids noisy suggestion pile', (suggestions.match(/^- /gm) || []).length <= 2);
      has('ready feature recognizes actionable acceptance criteria', /可以开始|需要分诊决策|可开始|排期|决策/.test(response));
    }
  }

  return {
    passed: checks.filter((check) => check.pass).length,
    total: checks.length,
    checks,
  };
}

export function normalizeQualityEvalResponse(fixture, response) {
  return normalizeReviewResponse(stripThinkingBlocks(response), {
    type: fixture.kind,
    title: fixture.title || fixture.id,
  });
}

export async function runQualityEvaluation(config = getEnvConfig()) {
  validateConfig(config);

  const runDir = join(config.outputDir, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });

  const results = [];
  for (const fixture of buildQualityEvalFixtures()) {
    const rawResponse = await chatCompletion({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxTokens: config.maxTokens,
      structuredOutputMode: config.structuredOutput,
      responseFormat: getReviewResponseFormat(fixture.kind),
      system: fixture.system,
      messages: [{ role: 'user', content: fixture.user }],
    });
    const response = normalizeQualityEvalResponse(fixture, rawResponse);
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
