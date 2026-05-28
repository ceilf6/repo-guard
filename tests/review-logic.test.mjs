import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRecommendation,
  extractUserPrompt,
  getReviewNumber,
  isTriggeredByComment,
  mapRecommendationToEvent,
  normalizeReviewResponse,
  resolveReviewType,
  stripThinkingBlocks,
} from '../scripts/review-logic.mjs';

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
  assert.equal(isTriggeredByComment('@repo-guard please focus on auth'), true);
  assert.equal(isTriggeredByComment('ordinary comment'), false);
  assert.equal(extractUserPrompt('/review please focus on auth'), 'please focus on auth');
  assert.equal(extractUserPrompt('@repo-guard'), '');
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
  assert.equal(extractRecommendation(normalized), 'APPROVE');
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

test('normalizeReviewResponse safely wraps unknown PR JSON without leaking raw JSON', () => {
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
  assert.doesNotMatch(normalized, /\{"overall_recommendation"/);
  assert.doesNotMatch(normalized, /"comments"/);
});

test('normalizeReviewResponse safely wraps PR JSON arrays without leaking raw JSON', () => {
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
  assert.doesNotMatch(normalized, /^\[\{/m);
  assert.doesNotMatch(normalized, /"path"/);
});

test('normalizeReviewResponse safely wraps malformed PR JSON-like output without leaking raw JSON', () => {
  const response = '{"summary":"raw JSON should not appear","findings":[';

  const normalized = normalizeReviewResponse(response, {
    type: 'pr',
    title: 'Malformed JSON',
  });

  assert.match(normalized, /^## 代码评审报告: Malformed JSON/);
  assert.match(normalized, /\*\*处理建议:\*\* 需要人工判断/);
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

test('normalizeReviewResponse leaves markdown review responses unchanged', () => {
  const response = `## 代码评审报告: Already Markdown

**风险等级:** 低
**处理建议:** 评论
**决策摘要:** markdown body`;

  assert.equal(normalizeReviewResponse(response, { type: 'pr' }), response);
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

test('normalizeReviewResponse safely wraps unknown fenced issue JSON without leaking raw JSON', () => {
  const response = `\`\`\`json
{"next":"ask reporter","payload":{"missing":"logs"}}
\`\`\``;

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Unknown issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Unknown issue JSON/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 询问报告者/);
  assert.doesNotMatch(normalized, /\{"next"/);
  assert.doesNotMatch(normalized, /"payload"/);
});

test('normalizeReviewResponse safely wraps issue JSON arrays without leaking raw JSON', () => {
  const response = `\`\`\`json
[{"suggestion":"ask reporter for logs"}]
\`\`\``;

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Array issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Array issue JSON/);
  assert.match(normalized, /### 建议\n- 模型返回了未识别 JSON schema/);
  assert.doesNotMatch(normalized, /^\[\{/m);
  assert.doesNotMatch(normalized, /"suggestion"/);
});

test('normalizeReviewResponse safely wraps malformed issue JSON-like output without leaking raw JSON', () => {
  const response = '[{"suggestion":"raw issue JSON should not appear"}';

  const normalized = normalizeReviewResponse(response, {
    type: 'issue',
    title: 'Malformed issue JSON',
  });

  assert.match(normalized, /^## Issue 分析: Malformed issue JSON/);
  assert.match(normalized, /\*\*维护者下一步动作:\*\* 需要分诊决策/);
  assert.doesNotMatch(normalized, /raw issue JSON should not appear/);
  assert.doesNotMatch(normalized, /^\[\{/m);
});
