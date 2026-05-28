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

test('normalizeReviewResponse wraps PR contract headings with raw JSON bodies', () => {
  const response = `## 代码评审报告: JSON Body

\`\`\`json
{"summary":"raw body should not leak"}
\`\`\``;

  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'JSON Body' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## 代码评审报告: JSON Body/);
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

test('normalizeReviewResponse wraps issue contract headings with raw JSON bodies', () => {
  const response = `## Issue 分析: JSON Body

{"suggestion":"raw issue body should not leak"}`;

  const normalized = normalizeReviewResponse(response, { type: 'issue', title: 'JSON Body' });

  assert.notEqual(normalized, response);
  assert.match(normalized, /^## Issue 分析: JSON Body/);
  assert.doesNotMatch(normalized, /raw issue body should not leak/);
  assert.doesNotMatch(normalized, /\{"suggestion"/);
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
