import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInlineComments,
  extractRecommendation,
  extractUserPrompt,
  getReviewNumber,
  isRepoGuardPublishedComment,
  isTriggeredByComment,
  mapRecommendationToEvent,
  normalizeReviewResponse,
  resolveReviewType,
  stripThinkingBlocks,
} from '../scripts/review-logic.mjs';

test('normalizeReviewResponse preserves every canonical PR field', () => {
  const response = JSON.stringify({
    risk_level: 'HIGH',
    recommendation: 'REQUEST_CHANGES',
    decision_summary: 'Authentication can be bypassed.',
    cascade_analysis: {
      changed_symbols: ['authorize'],
      affected_flows: ['protected routes'],
      outside_changeset_callers: 'unknown',
      confidence: 'degraded',
    },
    findings: [{
      severity: 'HIGH',
      title: 'Missing token bypasses authentication',
      evidence: 'src/auth.js:12 calls next()',
      affected_flows: 'protected routes',
      smallest_viable_fix: 'Return 401 before next().',
      path: 'src/auth.js',
      line: 12,
      inline_comment: 'Reject missing tokens before calling next().',
    }, {
      severity: 'MEDIUM',
      title: 'Unscoped finding',
      evidence: 'Configuration behavior',
      affected_flows: 'deployment',
      smallest_viable_fix: 'Document the constraint.',
      path: 'src/missing.js',
      line: 3,
      inline_comment: 'This path is absent from the supplied diff.',
    }],
    karpathy_review: {
      assumptions: 'No anonymous route uses this middleware.',
      simplicity: 'A local guard is sufficient.',
      surgical_scope: 'Only auth behavior changes.',
      verification: 'Missing rejection-path test.',
    },
    missing_coverage: ['Add a missing-token integration test.'],
  });

  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'Harden auth' });

  assert.match(normalized, /- 变更符号: authorize/);
  assert.match(normalized, /- 假设: No anonymous route uses this middleware\./);
  assert.match(normalized, /- Add a missing-token integration test\./);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
  assert.deepEqual(extractInlineComments(normalized, [{ filename: 'src/auth.js' }]), [{
    path: 'src/auth.js',
    line: 12,
    body: 'Reject missing tokens before calling next().',
  }]);
});

test('normalizeReviewResponse preserves canonical Issue rubric values', () => {
  const response = JSON.stringify({
    quality_score: 2,
    priority_suggestion: 'P1_HIGH',
    issue_type: 'BUG_REPORT',
    maintainer_next_action: 'ASK_REPORTER',
    completeness: {
      problem_statement: 'CLEAR',
      reproduction_steps: 'MISSING',
      expected_vs_actual: 'MISSING',
      environment_info: 'MISSING',
      supporting_evidence: 'MISSING',
    },
    clarity: {
      title_quality: 'DESCRIPTIVE',
      single_concern: 'YES',
      language_precision: 'SOMEWHAT_VAGUE',
      scope: 'WELL_DEFINED',
    },
    actionability: {
      ready_to_start: 'NEEDS_CLARIFICATION',
      acceptance_criteria: 'MISSING',
      dependencies: 'UNKNOWN',
    },
    suggestions: ['请补充稳定复现步骤。'],
    summary: '问题明确，但当前信息不足以开始修复。',
  });

  const normalized = normalizeReviewResponse(response, { type: 'issue', title: '登录后 500' });

  assert.match(normalized, /- 问题陈述: 清楚/);
  assert.match(normalized, /- 复现步骤: 缺失/);
  assert.match(normalized, /- 是否可开始: 需要澄清/);
  assert.match(normalized, /- 请补充稳定复现步骤。/);
});

test('normalizeReviewResponse tolerates non-empty partial contract JSON', () => {
  const partialPR = JSON.stringify({
    decision_summary: 'Partial but usable review.',
    cascade_analysis: {},
    findings: [],
    karpathy_review: {},
    missing_coverage: [],
  });
  const partialIssue = JSON.stringify({
    quality_score: 2,
    maintainer_next_action: 'ASK_REPORTER',
    completeness: null,
    clarity: {},
    actionability: {},
    suggestions: [],
    summary: 'Partial but usable issue review.',
  });

  assert.match(
    normalizeReviewResponse(partialPR, { type: 'pr', title: 'Partial PR' }),
    /^## 代码评审报告: Partial PR/,
  );
  assert.match(
    normalizeReviewResponse(partialIssue, { type: 'issue', title: 'Partial Issue' }),
    /Partial but usable issue review\./,
  );
});

test('issue_comment on a pull request resolves to PR review and uses issue number', () => {
  const config = {
    type: 'both',
    prNumber: '',
    issueNumber: '42',
    eventName: 'issue_comment',
    isPullRequest: true,
  };

  assert.equal(resolveReviewType(config), 'pr');
  assert.equal(getReviewNumber(config, 'pr'), 42);
});

test('issue_comment on a normal issue resolves to issue review', () => {
  const config = {
    type: 'both',
    prNumber: '',
    issueNumber: '43',
    eventName: 'issue_comment',
    isPullRequest: false,
  };

  assert.equal(resolveReviewType(config), 'issue');
  assert.equal(getReviewNumber(config, 'issue'), 43);
});

test('explicit PR review also supports PR issue comments', () => {
  const config = {
    type: 'pr',
    prNumber: '',
    issueNumber: '44',
    eventName: 'issue_comment',
    isPullRequest: true,
  };

  assert.equal(resolveReviewType(config), 'pr');
  assert.equal(getReviewNumber(config, 'pr'), 44);
});

test('missing PR number throws a clear error', () => {
  const config = {
    type: 'pr',
    prNumber: '',
    issueNumber: '',
    eventName: 'pull_request',
    isPullRequest: false,
  };

  assert.equal(resolveReviewType(config), null);
  assert.throws(() => getReviewNumber(config, 'pr'), /PR number must be a positive integer/);
});

test('comment trigger and user prompt extraction remove trigger words', () => {
  assert.equal(isTriggeredByComment('@ceilf6/repo-guard please focus on auth'), true);
  assert.equal(isTriggeredByComment('@repo-guard please focus on auth'), false);
  assert.equal(isTriggeredByComment('ordinary comment'), false);
  assert.equal(extractUserPrompt('@ceilf6/repo-guard please focus on auth'), 'please focus on auth');
  assert.equal(extractUserPrompt('/review please focus on auth'), 'please focus on auth');
  assert.equal(extractUserPrompt('@ceilf6/repo-guard'), '');
});

test('repo guard published comment detection does not block user mentions', () => {
  assert.equal(isRepoGuardPublishedComment('@ceilf6/repo-guard please focus on auth'), false);
  assert.equal(
    isRepoGuardPublishedComment('> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\n## Issue 分析'),
    true,
  );
});

test('recommendation mapping supports blocking and non-blocking outcomes', () => {
  assert.equal(extractRecommendation('**处理建议:** 请求修改'), 'REQUEST_CHANGES');
  assert.equal(extractRecommendation('**处理建议:** 批准'), 'APPROVE');
  assert.equal(extractRecommendation('**处理建议:** 需要人工判断'), 'NEEDS_HUMAN');
  assert.equal(extractRecommendation('no explicit marker'), 'COMMENT');
  assert.equal(mapRecommendationToEvent('APPROVE'), 'APPROVE');
  assert.equal(mapRecommendationToEvent('REQUEST_CHANGES'), 'REQUEST_CHANGES');
  assert.equal(mapRecommendationToEvent('NEEDS_HUMAN'), 'COMMENT');
});

test('stripThinkingBlocks removes model thinking before publishing', () => {
  const response = `
<thinking>
Private reasoning should not be posted.
</thinking>

## Issue 分析

正文保留。
`;

  assert.equal(stripThinkingBlocks(response), '## Issue 分析\n\n正文保留。');
});

test('normalizeReviewResponse converts structured PR JSON into markdown contract', () => {
  const response = JSON.stringify({
    summary: 'The PR appears aligned with Issue #98.',
    findings: [],
    risk_level: 'MEDIUM',
    recommendation: 'Approve after normal CR.',
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: '[codex] Add AI subtitle replay support',
  });

  assert.match(normalized, /^## 代码评审报告: \[codex\] Add AI subtitle replay support/);
  assert.match(normalized, /\*\*风险等级:\*\* 中/);
  assert.match(normalized, /\*\*处理建议:\*\* 批准/);
  assert.match(normalized, /\*\*决策摘要:\*\* The PR appears aligned with Issue #98\./);
  assert.match(normalized, /### 问题发现\n未发现 blocking findings。/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /"recommendation"\s*:\s*"Approve after normal CR\."/);
  assert.equal(extractRecommendation(normalized), 'APPROVE');
});

test('normalizeReviewResponse does not leak structured PR JSON original text', () => {
  const response = '```json\n{\n  "summary": "Fenced structured JSON",\n  "findings": [],\n  "risk_level": "LOW",\n  "recommendation": "COMMENT"\n}\n```';

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Fenced structured JSON',
  });

  assert.match(normalized, /\*\*决策摘要:\*\* Fenced structured JSON/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /```json/);
});

test('normalizeReviewResponse does not approve negated structured recommendations', () => {
  const response = JSON.stringify({
    summary: 'Authentication is still bypassed.',
    risk_level: 'HIGH',
    recommendation: 'Do not approve until auth is fixed.',
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse does not approve conditional recommendations with high findings', () => {
  const response = JSON.stringify({
    summary: 'Authentication is still bypassed.',
    recommendation: 'Approve after fixing auth.',
    findings: [{
      path: 'src/auth.js',
      line: 12,
      severity: 'high',
      message: 'missing token falls through to next()',
    }],
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /\*\*风险等级:\*\* 高/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
  assert.equal(mapRecommendationToEvent(extractRecommendation(normalized)), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse converts localized PR JSON into inline markdown findings', () => {
  const response = JSON.stringify({
    行级发现: [{
      文件: 'src/auth.js',
      行号: 12,
      严重性: '高',
      问题: '缺少 token 时直接调用 next() 会绕过认证。',
    }],
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth middleware more permissive',
  });

  assert.match(normalized, /^## 代码评审报告: Make auth middleware more permissive/);
  assert.match(normalized, /\*\*风险等级:\*\* 高/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /- \[src\/auth\.js:12\] 缺少 token 时直接调用 next\(\) 会绕过认证。/);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse wraps unknown PR JSON without leaking original output', () => {
  const response = JSON.stringify({
    overall_recommendation: 'REQUEST_CHANGES',
    comments: [{ path: 'src/auth.js', line: 12, message: 'auth bypass' }],
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Unknown JSON',
  });

  assert.match(normalized, /^## 代码评审报告: Unknown JSON/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /- \[src\/auth\.js:12\] auth bypass/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /"overall_recommendation"\s*:\s*"REQUEST_CHANGES"/);
});

test('normalizeReviewResponse wraps PR JSON arrays without leaking original output', () => {
  const response = JSON.stringify([
    { path: 'src/auth.js', line: 12, severity: 'high', message: 'auth bypass' },
  ]);

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Array JSON',
  });

  assert.match(normalized, /^## 代码评审报告: Array JSON/);
  assert.match(normalized, /\*\*风险等级:\*\* 高/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /- \[src\/auth\.js:12\] auth bypass/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /"path"\s*:\s*"src\/auth.js"/);
});

test('normalizeReviewResponse wraps malformed PR JSON-like output without leaking it', () => {
  const response = '{"summary":"raw JSON should not appear","findings":[';

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Malformed JSON',
  });

  assert.match(normalized, /^## 代码评审报告: Malformed JSON/);
  assert.match(normalized, /\*\*处理建议:\*\* 需要人工判断/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /raw JSON should not appear/);
  assert.doesNotMatch(normalized, /\{"summary"/);
});

test('normalizeReviewResponse wraps non-contract PR markdown and preserves loose inline findings', () => {
  const response = `## PR Review

### 行级发现

- **src/parse-id.js:2**
  parseInt 会接受部分数字字符串。

### 总结

建议修改后再合并。`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Fix ID parsing',
  });

  assert.match(normalized, /^## 代码评审报告: Fix ID parsing/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /- \[src\/parse-id\.js:2\] parseInt 会接受部分数字字符串。/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
});

test('normalizeReviewResponse keeps useful plain-text PR review details', () => {
  const response = `代码评审报告: feat: add subtitle LLM fine-tuning pipeline
风险等级: 高
处理建议: 请求修改
决策摘要: fine-tuning 数据集会把本地 Hugging Face token 写入可提交的缓存文件。

问题发现
[高] 训练数据缓存包含敏感 token
证据: scripts/fine-tune.mjs 将 HF_TOKEN 拼进 dataset-cache.json。
受影响调用方/流程: subtitle fine-tuning pipeline
最小可行修复: 写缓存前移除 token，并补充回归测试。`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'feat: add subtitle LLM fine-tuning pipeline',
  });

  assert.match(normalized, /^## 代码评审报告: feat: add subtitle LLM fine-tuning pipeline/);
  assert.match(normalized, /\*\*风险等级:\*\* 高/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /\*\*决策摘要:\*\* fine-tuning 数据集会把本地 Hugging Face token 写入可提交的缓存文件。/);
  assert.match(normalized, /1\. \*\*\[高\] 训练数据缓存包含敏感 token\*\*/);
  assert.match(normalized, /证据: scripts\/fine-tune\.mjs 将 HF_TOKEN 拼进 dataset-cache\.json。/);
  assert.match(normalized, /最小可行修复: 写缓存前移除 token，并补充回归测试。/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /模型输出未遵循 Repo Guard 契约/);
});

test('normalizeReviewResponse keeps inline findings when loose findings are also present', () => {
  const response = `风险等级: 高
处理建议: 请求修改
决策摘要: auth middleware still allows bypass.

问题发现
[高] Auth middleware can bypass token checks
证据: src/auth.js still calls next() when token is missing.
受影响调用方/流程: authentication middleware
最小可行修复: Return 401 before calling next().

行级发现
- [src/auth.js:12] Missing token falls through to next().`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /1\. \*\*\[高\] Auth middleware can bypass token checks\*\*/);
  assert.match(normalized, /- \[src\/auth\.js:12\] Missing token falls through to next\(\)\./);
});

test('normalizeReviewResponse keeps loose finding evidence scoped to each finding block', () => {
  const response = `风险等级: 高
处理建议: 请求修改
决策摘要: two independent problems need fixes.

问题发现
[高] Auth middleware can bypass token checks
证据: src/auth.js calls next() without a token.
受影响调用方/流程: authentication middleware
最小可行修复: Return 401 before calling next().

[中] Cache writes stale subtitle entries
证据: src/cache.js stores subtitles under a replay-agnostic key.
受影响调用方/流程: replay subtitle cache
最小可行修复: Include replayId in the cache key.`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Fix auth and cache',
  });

  assert.match(normalized, /1\. \*\*\[高\] Auth middleware can bypass token checks\*\*[\s\S]*证据: src\/auth\.js calls next\(\) without a token\.[\s\S]*最小可行修复: Return 401 before calling next\(\)\./);
  assert.match(normalized, /2\. \*\*\[中\] Cache writes stale subtitle entries\*\*[\s\S]*证据: src\/cache\.js stores subtitles under a replay-agnostic key\.[\s\S]*最小可行修复: Include replayId in the cache key\./);
  assert.doesNotMatch(normalized, /Cache writes stale subtitle entries\*\*[\s\S]*证据: src\/auth\.js calls next\(\) without a token\./);
});

test('normalizeReviewResponse does not promote fallback placeholder findings as review findings', () => {
  const response = `代码评审报告: feat: add subtitle LLM fine-tuning pipeline
风险等级: 高
处理建议: 批准
决策摘要: 代码评审报告: feat: add subtitle LLM fine-tuning pipeline

问题发现
[中] 模型输出未遵循 Repo Guard 契约
证据: 代码评审报告: feat: add subtitle LLM fine-tuning pipeline
受影响调用方/流程: GitHub 评论展示与后续解析
最小可行修复: 已在发布前归一化为固定 Markdown 契约；仍建议优化提示让模型直接遵循契约。`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'feat: add subtitle LLM fine-tuning pipeline',
  });

  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /模型输出未遵循 Repo Guard 契约/);
  assert.doesNotMatch(normalized, /最小可行修复: 已在发布前归一化为固定 Markdown 契约/);
});

test('normalizeReviewResponse stays idempotent and does not leak JSON from non-contract markdown', () => {
  const response = `## PR Review

### Notes
{"summary":"raw JSON should stay out of the published comment"}

建议人工判断。`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Original output idempotency',
  });
  const renormalized = normalizeReviewResponse(normalized, {
    type: 'pr',
    title: 'Original output idempotency',
  });

  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /\{"summary":"raw JSON should stay out of the published comment"\}/);
  assert.equal(renormalized, normalized);
});

test('normalizeReviewResponse preserves bracket inline findings in non-contract PR markdown', () => {
  const response = `Review follows:

### 行级发现
- [src/auth.js:12] Missing token now falls through to next().

Do not approve until auth is fixed.`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.match(normalized, /- \[src\/auth\.js:12\] Missing token now falls through to next\(\)\./);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse does not approve conditional non-contract markdown', () => {
  const response = `Review follows:

Not ready to approve until auth is fixed.

- [src/auth.js:12] Missing token now falls through to next().`;

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
  assert.equal(mapRecommendationToEvent(extractRecommendation(normalized)), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse treats approve-once-fixed text as blocking', () => {
  const response = 'Approve once fixed: src/auth.js:12 must reject missing tokens.';

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Make auth permissive',
  });

  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
  assert.equal(extractRecommendation(normalized), 'REQUEST_CHANGES');
});

test('normalizeReviewResponse leaves markdown review responses unchanged', () => {
  const response = `## 代码评审报告: Already Markdown

**风险等级:** 低
**处理建议:** 评论
**决策摘要:** markdown body

### 级联分析
- 变更符号: none
- 受影响流程: none
- 变更集外调用方: unknown
- 置信度: high

### 问题发现
未发现 blocking findings。

### 行级发现
- 无明确变更行归属。

### Karpathy 评审
- 假设: none
- 简洁性: ok
- 变更范围: small
- 验证: tests

### 缺失覆盖
- none`;

  assert.equal(normalizeReviewResponse(response, { type: 'pr' }), response);
});

test('normalizeReviewResponse wraps incomplete PR contracts instead of passing them through', () => {
  const response = `## 代码评审报告: Incomplete

This starts with the right heading but lacks the contract fields.`;

  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'Incomplete' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## 代码评审报告: Incomplete/);
  assert.match(normalized, /\*\*风险等级:\*\*/);
  assert.match(normalized, /### 行级发现/);
});

test('normalizeReviewResponse wraps PR contract headings with raw JSON bodies without leaking them', () => {
  const response = `## 代码评审报告: JSON Body

\`\`\`json
{"summary":"raw body should not leak"}
\`\`\``;

  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'JSON Body' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## 代码评审报告: JSON Body/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /raw body should not leak/);
  assert.doesNotMatch(normalized, /\{"summary"/);
});

test('normalizeReviewResponse wraps responses that prepend text before the PR contract', () => {
  const response = `Here is the review:

## 代码评审报告: Nested Contract

**风险等级:** 低
**处理建议:** 评论
**决策摘要:** nested body`;

  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'Nested Contract' });

  assert.match(normalized, /^## 代码评审报告: Nested Contract/);
  assert.doesNotMatch(normalized, /^Here is the review:/);
});

test('normalizeReviewResponse converts structured issue JSON into markdown contract', () => {
  const response = JSON.stringify({
    quality_score: '2/5',
    priority_suggestion: 'P1-高',
    type: '缺陷报告',
    maintainer_next_action: '询问报告者',
    suggestions: ['请补充稳定复现步骤和错误日志。'],
    summary: '当前 issue 缺少复现信息，维护者需要先追问。',
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: '登录后偶发 500',
  });

  assert.match(normalized, /^## Issue 分析: 登录后偶发 500/);
  assert.match(normalized, /\*\*质量评分:\*\* 2\/5/);
  assert.match(normalized, /\*\*优先级建议:\*\* P1-高/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 询问报告者/);
  assert.match(normalized, /### 建议\n- 请补充稳定复现步骤和错误日志。/);
});

test('normalizeReviewResponse converts localized issue JSON into markdown contract', () => {
  const response = JSON.stringify({
    质量评分: '5/5',
    优先级建议: 'P3-低',
    类型: '功能请求',
    维护者下一步动作: '可以开始',
    建议: ['无需报告者继续补充。'],
    总结: '需求已经可执行。',
  });

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Add dry-run mode',
  });

  assert.match(normalized, /^## Issue 分析: Add dry-run mode/);
  assert.match(normalized, /\*\*质量评分:\*\* 5\/5/);
  assert.match(normalized, /\*\*优先级建议:\*\* P3-低/);
  assert.match(normalized, /\*\*类型:\*\* 功能请求/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 可以开始/);
  assert.match(normalized, /### 建议\n- 无需报告者继续补充。/);
});

test('normalizeReviewResponse wraps unknown fenced issue JSON without leaking original output', () => {
  const response = `\`\`\`json
{"next":"ask reporter","payload":{"missing":"logs"}}
\`\`\``;

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Unknown issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Unknown issue JSON/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 询问报告者/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /"next"\s*:\s*"ask reporter"/);
  assert.doesNotMatch(normalized, /"payload"\s*:\s*\{/);
});

test('normalizeReviewResponse leaves markdown issue responses unchanged', () => {
  const response = `## Issue 分析: Already Markdown

**质量评分:** 4/5
**优先级建议:** P2-中
**类型:** 缺陷报告
**维护者下一步动作:** 询问报告者

### 完整性
- 问题陈述: clear
- 复现步骤: present
- 预期与实际: present
- 环境信息: present
- 支撑证据: present

### 清晰度
- 标题质量: ok
- 单一关注点: ok
- 表达精确度: ok
- 范围: scoped

### 可执行性
- 是否可开始: yes
- 验收标准: present
- 依赖: none

### 建议
- Ask for one missing log.

### 总结
Contract is complete.`;

  assert.equal(normalizeReviewResponse(response, { type: 'issue' }), response);
});

test('normalizeReviewResponse wraps incomplete issue contracts instead of passing them through', () => {
  const response = `## Issue 分析: Incomplete

This starts with the right heading but lacks the issue contract fields.`;

  const normalized = normalizeReviewResponse(response, { type: 'issue', title: 'Incomplete issue' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## Issue 分析: Incomplete issue/);
  assert.match(normalized, /\*\*质量评分:\*\*/);
  assert.match(normalized, /### 建议/);
});

test('normalizeReviewResponse wraps issue contract headings with raw JSON bodies without leaking them', () => {
  const response = `## Issue 分析: JSON Body

{"suggestion":"raw issue body should not leak"}`;

  const normalized = normalizeReviewResponse(response, { type: 'issue', title: 'JSON Body' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## Issue 分析: JSON Body/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /raw issue body should not leak/);
  assert.doesNotMatch(normalized, /\{"suggestion"/);
});

test('normalizeReviewResponse wraps issue JSON arrays without leaking original output', () => {
  const response = `\`\`\`json
[{"suggestion":"ask reporter for logs"}]
\`\`\``;

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Array issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Array issue JSON/);
  assert.match(normalized, /### 建议\n- 模型返回了未识别 JSON schema/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /"suggestion"\s*:\s*"ask reporter for logs"/);
});

test('normalizeReviewResponse wraps malformed issue JSON-like output without leaking it', () => {
  const response = '[{"suggestion":"raw issue JSON should not appear"}';

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Malformed issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Malformed issue JSON/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 需要分诊决策/);
  assert.doesNotMatch(normalized, /### 原始模型输出/);
  assert.doesNotMatch(normalized, /raw issue JSON should not appear/);
  assert.doesNotMatch(normalized, /^\[\{/m);
});

test('normalizeReviewResponse does not leak model preamble into unstructured issue summary', () => {
  const response = [
    "I'm going to score this issue against the rubric.",
    '',
    'The issue clearly describes a reproducible crash with a stack trace and version info, and is ready to start.',
  ].join('\n');

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Crash on startup',
  });

  assert.match(normalized, /^## Issue 分析: Crash on startup/);
  // Preamble meta-narration must not be picked up as the summary or the suggestion.
  assert.doesNotMatch(normalized, /I'm going to score this issue against the rubric/);
  // The real content line should be promoted into the summary instead.
  assert.match(normalized, /### 总结\n.*reproducible crash/);
});

test('normalizeReviewResponse does not leak Chinese model preamble into unstructured issue summary', () => {
  const response = [
    '我将根据评分标准对这个 issue 进行评分。',
    '',
    '该 issue 清晰描述了可复现的崩溃，包含堆栈与版本信息，可以开始。',
  ].join('\n');

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: '启动崩溃',
  });

  assert.doesNotMatch(normalized, /我将根据评分标准对这个 issue 进行评分/);
  assert.match(normalized, /### 总结\n.*可复现的崩溃/);
});

test('normalizeReviewResponse does not leak model preamble into unstructured PR summary', () => {
  const response = [
    "Let me review this pull request against the checklist.",
    '',
    'The change adds a null guard around the cache lookup and is low risk.',
  ].join('\n');

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Add null guard',
  });

  assert.match(normalized, /^## 代码评审报告: Add null guard/);
  assert.doesNotMatch(normalized, /Let me review this pull request against the checklist/);
  assert.match(normalized, /\*\*决策摘要:\*\*.*null guard/);
});

test('normalizeReviewResponse keeps a real first-line summary that is not preamble', () => {
  const response = 'The issue is well scoped and ready to start; acceptance criteria are listed.';

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Well scoped issue',
  });

  // A genuine summary that happens to be the first line must still be preserved.
  assert.match(normalized, /### 总结\nThe issue is well scoped and ready to start/);
});

test('normalizeReviewResponse preserves a first-person review decision as the PR summary', () => {
  // Regression for Codex review of #27: an opener like "I will" that carries an
  // actual decision/rationale is substantive content, not preamble to strip.
  const response = 'I will request changes because this patch deletes persisted user data without a migration.';

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Risky data change',
  });

  assert.match(normalized, /\*\*决策摘要:\*\*.*deletes persisted user data/);
  assert.match(normalized, /\*\*处理建议:\*\* 请求修改/);
});

test('normalizeReviewResponse preserves a first-person decision as the issue summary', () => {
  const response = "I'll need the reporter to attach logs since the stack trace is missing.";

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Needs logs',
  });

  assert.match(normalized, /### 总结\n.*attach logs/);
});
