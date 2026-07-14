import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_REVIEW_RESPONSE_FORMAT,
  PR_REVIEW_RESPONSE_FORMAT,
  getReviewResponseFormat,
  isCanonicalIssueReview,
  isCanonicalPRReview,
  renderCanonicalIssueReview,
  renderCanonicalPRReview,
} from '../scripts/review-contracts.mjs';

function assertStrictObjectsDeep(schema) {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
    for (const property of Object.values(schema.properties)) assertStrictObjectsDeep(property);
  }
  if (schema.type === 'array') assertStrictObjectsDeep(schema.items);
  for (const branch of schema.anyOf || []) assertStrictObjectsDeep(branch);
}

test('PR and Issue response formats use strict complete object schemas', () => {
  for (const responseFormat of [PR_REVIEW_RESPONSE_FORMAT, ISSUE_REVIEW_RESPONSE_FORMAT]) {
    assert.equal(responseFormat.type, 'json_schema');
    assert.equal(responseFormat.json_schema.strict, true);
    assertStrictObjectsDeep(responseFormat.json_schema.schema);
  }
  assert.equal(getReviewResponseFormat('pr'), PR_REVIEW_RESPONSE_FORMAT);
  assert.equal(getReviewResponseFormat('issue'), ISSUE_REVIEW_RESPONSE_FORMAT);
  assert.throws(() => getReviewResponseFormat('discussion'), /Unsupported review contract kind/);
});

test('canonical PR renderer preserves every contract section', () => {
  const review = {
    risk_level: 'HIGH',
    recommendation: 'REQUEST_CHANGES',
    decision_summary: '认证绕过会影响所有受保护路由。',
    cascade_analysis: {
      changed_symbols: ['authorize'],
      affected_flows: ['HTTP authentication'],
      outside_changeset_callers: 'unknown',
      confidence: 'degraded',
    },
    findings: [{
      severity: 'HIGH',
      title: '缺失 token 时绕过认证',
      evidence: 'src/auth.js:12 calls next()',
      affected_flows: 'All protected routes',
      smallest_viable_fix: 'Reject the request before next().',
      path: 'src/auth.js',
      line: 12,
      inline_comment: '缺失 token 时应返回 401。',
    }],
    karpathy_review: {
      assumptions: 'No anonymous route uses this middleware.',
      simplicity: 'A local guard is sufficient.',
      surgical_scope: 'Only authentication behavior changes.',
      verification: 'Missing rejection-path test.',
    },
    missing_coverage: ['Add a missing-token integration test.'],
  };

  assert.equal(isCanonicalPRReview(review), true);
  assert.equal(isCanonicalPRReview({ decision_summary: 'incomplete' }), false);

  const markdown = renderCanonicalPRReview(review, 'Harden auth');
  assert.match(markdown, /^## 代码评审报告: Harden auth/);
  assert.match(markdown, /\*\*风险等级:\*\* 高/);
  assert.match(markdown, /\*\*处理建议:\*\* 请求修改/);
  assert.match(markdown, /- 变更符号: authorize/);
  assert.match(markdown, /- 受影响流程: HTTP authentication/);
  assert.match(markdown, /1\. \*\*\[高\] 缺失 token 时绕过认证\*\*/);
  assert.match(markdown, /- \[src\/auth\.js:12\] 缺失 token 时应返回 401。/);
  assert.match(markdown, /- 验证: Missing rejection-path test\./);
  assert.match(markdown, /- Add a missing-token integration test\./);
});

test('canonical PR renderer omits inline markers without an exact location', () => {
  const markdown = renderCanonicalPRReview({
    risk_level: 'LOW',
    recommendation: 'APPROVE',
    decision_summary: 'No blocking findings.',
    cascade_analysis: {
      changed_symbols: [], affected_flows: [], outside_changeset_callers: 'none', confidence: 'medium',
    },
    findings: [{
      severity: 'LOW', title: 'General note', evidence: 'PR description', affected_flows: 'none',
      smallest_viable_fix: 'No change required.', path: null, line: null, inline_comment: null,
    }],
    karpathy_review: {
      assumptions: 'None.', simplicity: 'Proportional.', surgical_scope: 'Focused.', verification: 'Adequate.',
    },
    missing_coverage: [],
  }, 'Safe change');

  assert.match(markdown, /### 行级发现\n- 无明确变更行归属。/);
  assert.match(markdown, /### 缺失覆盖\n- 验证覆盖与当前风险匹配。/);
});

test('canonical Issue renderer preserves all rubric dimensions', () => {
  const review = {
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
  };

  assert.equal(isCanonicalIssueReview(review), true);
  assert.equal(isCanonicalIssueReview({ quality_score: 2 }), false);

  const markdown = renderCanonicalIssueReview(review, '登录后 500');
  assert.match(markdown, /^## Issue 分析: 登录后 500/);
  assert.match(markdown, /\*\*优先级建议:\*\* P1-高/);
  assert.match(markdown, /\*\*类型:\*\* 缺陷报告/);
  assert.match(markdown, /\*\*维护者下一步动作:\*\* 询问报告者/);
  assert.match(markdown, /- 问题陈述: 清楚/);
  assert.match(markdown, /- 复现步骤: 缺失/);
  assert.match(markdown, /- 表达精确度: 略模糊/);
  assert.match(markdown, /- 是否可开始: 需要澄清/);
  assert.match(markdown, /- 请补充稳定复现步骤。/);
  assert.match(markdown, /### 总结\n问题明确，但当前信息不足以开始修复。/);
});

test('canonical detection rejects partial schema-like objects', () => {
  assert.equal(isCanonicalPRReview({
    decision_summary: 'Partial structured response.',
    cascade_analysis: {},
    findings: [],
    karpathy_review: {},
    missing_coverage: [],
  }), false);

  assert.equal(isCanonicalIssueReview({
    quality_score: 2,
    maintainer_next_action: 'ASK_REPORTER',
    completeness: null,
    clarity: {},
    actionability: {},
    suggestions: [],
  }), false);
});
