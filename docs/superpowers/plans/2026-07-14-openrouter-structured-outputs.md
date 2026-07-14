# OpenRouter Structured Outputs Implementation Plan

> **后续修订：** 本计划记录最初的 V1 深层 schema 实现。当前生效的 V2 紧凑契约、内容完整性和双空响应失败语义见 [设计说明](../specs/2026-07-14-structured-output-minimal-contract-design.md) 与 [实施计划](2026-07-14-structured-output-minimal-contract.md)。V1 响应仍保持兼容。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a capability-gated OpenRouter Structured Outputs path for every Repo Guard LLM call while preserving legacy behavior through explicit `off` and automatic fallback.

**Architecture:** Keep `openai` and `anthropic` as the public provider choices. Add a focused OpenRouter capability probe, canonical PR/Issue response contracts, and an optional structured branch inside the existing string-returning LLM client. Every response still flows through `normalizeReviewResponse`; a structured call falls back once only when it produces no non-empty text.

**Tech Stack:** Node.js ESM, native `fetch`, Node test runner, GitHub composite Actions, YAML, Markdown

## Global Constraints

- `LLM_STRUCTURED_OUTPUT` and Action input `structured-output` accept exactly `off` or `auto`; the default is `auto`.
- Do not add an `openrouter` provider or change the meanings of `openai` and `anthropic`.
- Probe capabilities only for `provider=openai`, mode `auto`, and normalized hostname `openrouter.ai`.
- Do not send credentials in the public model metadata request.
- A non-empty string from the first structured request is always used, even when it is not schema-valid JSON.
- Fall back to the existing free-text request exactly once only when the structured request throws or has no non-empty string content.
- Keep the current `fetchWithRetry` transport behavior.
- Do not enable Response Healing, streaming, or a new SDK.
- Preserve existing Markdown, recommendation/event mapping, path filtering, and GitHub Review API fallback behavior for invalid inline locations.
- Automated tests must not call real GitHub or LLM APIs.
- Comments explain background or constraints, not what the code already says.
- Final integration history must squash temporary red/green/fixup commits into clear result commits.

---

## File Map

**Create**

- `scripts/openrouter-structured-output.mjs`: mode validation, target detection, public Models API lookup, and in-process capability caching.
- `scripts/review-contracts.mjs`: canonical PR/Issue JSON Schemas, `response_format` values, canonical-object detection, and deterministic Markdown renderers.
- `tests/openrouter-structured-output.test.mjs`: capability and cache behavior.
- `tests/review-contracts.test.mjs`: schema shape and canonical Markdown rendering.

**Modify**

- `scripts/llm-client.mjs`: optional structured request, prompt override, usable-text decision, and one free-text fallback.
- `tests/llm-client.test.mjs`: request-body isolation and fallback tests.
- `scripts/review-logic.mjs`: recognize canonical contract objects before the existing tolerant JSON fallbacks.
- `tests/review-logic.test.mjs`: end-to-end canonical JSON normalization and inline extraction coverage.
- `scripts/review.mjs`: parse mode and select the Issue schema; pass mode into PR reviews.
- `scripts/pr-reviewer.mjs`: select the PR schema.
- `scripts/external-dispatcher.mjs`: parse and pass mode through the PR path.
- `scripts/evaluate-quality.mjs`: support short/action-compatible mode variables and select schema by fixture kind.
- `tests/quality-eval.test.mjs`: environment parsing and schema-selection-facing config coverage.
- `action.yml`: public input and environment mapping.
- `.github/workflows/repo-guard.yml`: repository variable passthrough with `auto` default.
- `.github/workflows/external-repo-guard.yml`: dispatcher variable passthrough with `auto` default.
- `README.md`: configuration, OpenRouter example, compatibility, and fallback cost.
- `docs/quality-evaluation.md`: quality-evaluation configuration and behavior.

---

### Task 1: Add validated OpenRouter capability detection

**Files:**

- Create: `scripts/openrouter-structured-output.mjs`
- Create: `tests/openrouter-structured-output.test.mjs`

**Interfaces:**

- Produces: `parseStructuredOutputMode(value): 'off' | 'auto'`
- Produces: `supportsOpenRouterStructuredOutputs({ mode, provider, baseURL, model, fetchImpl }): Promise<boolean>`
- Produces: `clearOpenRouterCapabilityCache(): void`
- Consumes: normalized API base URLs from `normalizeBaseURL` in Task 3

- [ ] **Step 1: Write failing mode and target tests**

Create `tests/openrouter-structured-output.test.mjs` with these cases:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOpenRouterCapabilityCache,
  parseStructuredOutputMode,
  supportsOpenRouterStructuredOutputs,
} from '../scripts/openrouter-structured-output.mjs';

test.beforeEach(() => clearOpenRouterCapabilityCache());

test('parseStructuredOutputMode defaults to auto and accepts explicit off', () => {
  assert.equal(parseStructuredOutputMode(), 'auto');
  assert.equal(parseStructuredOutputMode(''), 'auto');
  assert.equal(parseStructuredOutputMode('off'), 'off');
  assert.equal(parseStructuredOutputMode('auto'), 'auto');
});

test('parseStructuredOutputMode rejects unknown values', () => {
  assert.throws(
    () => parseStructuredOutputMode('true'),
    /LLM_STRUCTURED_OUTPUT must be "off" or "auto"/,
  );
});

test('capability probe ignores off, anthropic, and non-OpenRouter targets', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };

  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'off', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.5', fetchImpl,
  }), false);
  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'auto', provider: 'anthropic', baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude', fetchImpl,
  }), false);
  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'auto', provider: 'openai', baseURL: 'https://relay.example.com/v1', model: 'openai/gpt-5.5', fetchImpl,
  }), false);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `node --test tests/openrouter-structured-output.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/openrouter-structured-output.mjs`.

- [ ] **Step 3: Implement mode validation and capability lookup**

Create `scripts/openrouter-structured-output.mjs`:

```js
// @ts-check

const capabilityCache = new Map();

export function parseStructuredOutputMode(value = '') {
  const mode = String(value || 'off').trim().toLowerCase();
  if (mode === 'off' || mode === 'auto') return mode;
  throw new Error('LLM_STRUCTURED_OUTPUT must be "off" or "auto"');
}

export async function supportsOpenRouterStructuredOutputs({
  mode,
  provider,
  baseURL,
  model,
  fetchImpl = fetch,
}) {
  if (!isOpenRouterTarget({ mode, provider, baseURL })) return false;

  const key = `${baseURL}\n${model}`;
  if (!capabilityCache.has(key)) {
    capabilityCache.set(key, probeModel(baseURL, model, fetchImpl));
  }
  return capabilityCache.get(key);
}

export function clearOpenRouterCapabilityCache() {
  capabilityCache.clear();
}

function isOpenRouterTarget({ mode, provider, baseURL }) {
  if (mode !== 'auto' || provider !== 'openai') return false;
  try {
    return new URL(baseURL).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

async function probeModel(baseURL, model, fetchImpl) {
  try {
    const modelPath = String(model).split('/').map(encodeURIComponent).join('/');
    const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/model/${modelPath}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload?.data?.supported_parameters) &&
      payload.data.supported_parameters.includes('structured_outputs');
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Add cache, encoding, failure, and credential tests**

Append these tests:

```js
test('probe recognizes structured_outputs and encodes model path segments', async () => {
  const calls = [];
  const supported = await supportsOpenRouterStructuredOutputs({
    mode: 'auto',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5:floor',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ data: { supported_parameters: ['response_format', 'structured_outputs'] } }),
      };
    },
  });

  assert.equal(supported, true);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/model/openai/gpt-5.5%3Afloor');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
  assert.equal('Authorization' in calls[0].options.headers, false);
});

test('probe failures and missing parameters use legacy behavior', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ data: {} }) }),
    async () => { throw new Error('offline'); },
  ]) {
    clearOpenRouterCapabilityCache();
    assert.equal(await supportsOpenRouterStructuredOutputs({
      mode: 'auto', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/test', fetchImpl,
    }), false);
  }
});

test('same model shares an in-flight capability request', async () => {
  let calls = 0;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const config = {
    mode: 'auto',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5',
    fetchImpl: async () => {
      calls += 1;
      return responsePromise;
    },
  };

  const first = supportsOpenRouterStructuredOutputs(config);
  const second = supportsOpenRouterStructuredOutputs(config);
  resolveResponse({
    ok: true,
    json: async () => ({ data: { supported_parameters: ['structured_outputs'] } }),
  });

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1);
});
```

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/openrouter-structured-output.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit the capability unit**

```bash
git add scripts/openrouter-structured-output.mjs tests/openrouter-structured-output.test.mjs
git commit -m "feat: detect OpenRouter structured output support"
```

---

### Task 2: Define full PR and Issue response contracts

**Files:**

- Create: `scripts/review-contracts.mjs`
- Create: `tests/review-contracts.test.mjs`
- Modify: `scripts/review-logic.mjs:1-105`
- Modify: `tests/review-logic.test.mjs:108-204,522-566`

**Interfaces:**

- Produces: `PR_REVIEW_RESPONSE_FORMAT`
- Produces: `ISSUE_REVIEW_RESPONSE_FORMAT`
- Produces: `getReviewResponseFormat(kind)`
- Produces: `isCanonicalPRReview(value)` and `isCanonicalIssueReview(value)`
- Produces: `renderCanonicalPRReview(review, title)` and `renderCanonicalIssueReview(review, title)`
- Consumes: no provider or network state

- [ ] **Step 1: Write failing schema-shape tests**

Create `tests/review-contracts.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_REVIEW_RESPONSE_FORMAT,
  PR_REVIEW_RESPONSE_FORMAT,
  getReviewResponseFormat,
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
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `node --test tests/review-contracts.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement schema builders and complete schemas**

Create the schema section of `scripts/review-contracts.mjs`:

```js
// @ts-check

const string = (description) => ({ type: 'string', description });
const enumString = (values, description) => ({ type: 'string', enum: values, description });
const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });
const nullableString = (description) => ({
  anyOf: [{ type: 'string' }, { type: 'null' }],
  description,
});
const nullableLine = {
  anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
  description: 'Changed new-file line for an inline comment, or null when no exact changed line is known.',
};
const strictObject = (properties, description) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  description,
});
const responseFormat = (name, schema) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema },
});

const PR_FINDING = strictObject({
  severity: enumString(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], 'Severity supported by Repo Guard.'),
  title: string('Short actionable finding title.'),
  evidence: string('Concrete diff evidence without fabricated facts.'),
  affected_flows: string('Affected callers or flows, or unknown when evidence is unavailable.'),
  smallest_viable_fix: string('Smallest compatible fix direction.'),
  path: nullableString('Repository-relative path, or null without an exact changed location.'),
  line: nullableLine,
  inline_comment: nullableString('Concise inline comment body, or null without an exact changed location.'),
}, 'One PR review finding.');

const PR_SCHEMA = strictObject({
  risk_level: enumString(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], 'Overall merge risk.'),
  recommendation: enumString(['APPROVE', 'COMMENT', 'REQUEST_CHANGES', 'NEEDS_HUMAN'], 'Merge recommendation.'),
  decision_summary: string('One sentence stating merge readiness and the main reason.'),
  cascade_analysis: strictObject({
    changed_symbols: stringArray('Changed public or shared symbols visible in the supplied diff.'),
    affected_flows: stringArray('Affected flows inferred from available evidence.'),
    outside_changeset_callers: string('Identified callers or unknown.'),
    confidence: enumString(['high', 'medium', 'degraded'], 'Confidence in cascade coverage.'),
  }, 'Cascade impact analysis.'),
  findings: { type: 'array', items: PR_FINDING, description: 'Actionable findings; empty when none exist.' },
  karpathy_review: strictObject({
    assumptions: string('Material assumptions or ambiguity.'),
    simplicity: string('Whether the change is proportional and avoids speculative complexity.'),
    surgical_scope: string('Whether every changed line serves the stated goal.'),
    verification: string('Verification evidence and confidence gaps.'),
  }, 'Karpathy-style implementation review.'),
  missing_coverage: stringArray('Tests or scenarios still needed before merge.'),
}, 'Complete Repo Guard PR review.');

const ISSUE_SCHEMA = strictObject({
  quality_score: { type: 'integer', minimum: 1, maximum: 5, description: 'Issue quality from 1 to 5.' },
  priority_suggestion: enumString(['P0_CRITICAL', 'P1_HIGH', 'P2_MEDIUM', 'P3_LOW'], 'Evidence-based priority.'),
  issue_type: enumString(['BUG_REPORT', 'FEATURE_REQUEST', 'QUESTION', 'DISCUSSION'], 'Issue type.'),
  maintainer_next_action: enumString(['READY_TO_START', 'ASK_REPORTER', 'TRIAGE_DECISION', 'REPRODUCE'], 'Immediate maintainer action.'),
  completeness: strictObject({
    problem_statement: enumString(['CLEAR', 'VAGUE', 'MISSING'], 'Problem statement quality.'),
    reproduction_steps: enumString(['PROVIDED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE'], 'Reproduction completeness.'),
    expected_vs_actual: enumString(['DESCRIBED', 'INFERRED', 'MISSING', 'NOT_APPLICABLE'], 'Expected and actual behavior.'),
    environment_info: enumString(['PROVIDED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE'], 'Environment information.'),
    supporting_evidence: enumString(['PROVIDED', 'MISSING', 'NOT_APPLICABLE'], 'Logs, screenshots, or other evidence.'),
  }, 'Issue completeness dimensions.'),
  clarity: strictObject({
    title_quality: enumString(['DESCRIPTIVE', 'VAGUE', 'MISLEADING'], 'Title quality.'),
    single_concern: enumString(['YES', 'MULTIPLE_CONCERNS'], 'Whether the issue has one concern.'),
    language_precision: enumString(['PRECISE', 'SOMEWHAT_VAGUE', 'UNCLEAR'], 'Language precision.'),
    scope: enumString(['WELL_DEFINED', 'OPEN_ENDED', 'UNCLEAR'], 'Scope quality.'),
  }, 'Issue clarity dimensions.'),
  actionability: strictObject({
    ready_to_start: enumString(['YES', 'NEEDS_CLARIFICATION', 'BLOCKED'], 'Whether implementation can start.'),
    acceptance_criteria: enumString(['EXPLICIT', 'INFERRED', 'MISSING'], 'Acceptance criteria quality.'),
    dependencies: enumString(['IDENTIFIED', 'NOT_APPLICABLE', 'UNKNOWN'], 'Dependency status.'),
  }, 'Issue actionability dimensions.'),
  suggestions: stringArray('Two or three concrete suggestions, or the no-further-input message for ready issues.'),
  summary: string('One or two sentence overall assessment.'),
}, 'Complete Repo Guard Issue assessment.');

export const PR_REVIEW_RESPONSE_FORMAT = responseFormat('repo_guard_pr_review', PR_SCHEMA);
export const ISSUE_REVIEW_RESPONSE_FORMAT = responseFormat('repo_guard_issue_review', ISSUE_SCHEMA);

export function getReviewResponseFormat(kind) {
  if (kind === 'pr') return PR_REVIEW_RESPONSE_FORMAT;
  if (kind === 'issue') return ISSUE_REVIEW_RESPONSE_FORMAT;
  throw new Error(`Unsupported review contract kind: ${kind}`);
}
```

- [ ] **Step 4: Add canonical renderers and detection**

Append complete renderer behavior to `scripts/review-contracts.mjs`:

```js
const RISK = { LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '致命' };
const RECOMMENDATION = { APPROVE: '批准', COMMENT: '评论', REQUEST_CHANGES: '请求修改', NEEDS_HUMAN: '需要人工判断' };
const SEVERITY = RISK;
const PRIORITY = { P0_CRITICAL: 'P0-致命', P1_HIGH: 'P1-高', P2_MEDIUM: 'P2-中', P3_LOW: 'P3-低' };
const ISSUE_TYPE = { BUG_REPORT: '缺陷报告', FEATURE_REQUEST: '功能请求', QUESTION: '问题咨询', DISCUSSION: '讨论' };
const NEXT_ACTION = { READY_TO_START: '可以开始', ASK_REPORTER: '询问报告者', TRIAGE_DECISION: '需要分诊决策', REPRODUCE: '需要复现' };

export function isCanonicalPRReview(value) {
  return isObject(value) && 'decision_summary' in value && 'cascade_analysis' in value &&
    'karpathy_review' in value && Array.isArray(value.findings) && Array.isArray(value.missing_coverage);
}

export function isCanonicalIssueReview(value) {
  return isObject(value) && 'quality_score' in value && 'completeness' in value &&
    'clarity' in value && 'actionability' in value && 'maintainer_next_action' in value &&
    Array.isArray(value.suggestions);
}

export function renderCanonicalPRReview(review, title = 'PR Review') {
  const findings = review.findings.length === 0
    ? '未发现 blocking findings。'
    : review.findings.map((finding, index) => [
      `${index + 1}. **[${SEVERITY[finding.severity]}] ${singleLine(finding.title)}**`,
      `   - 证据: ${singleLine(finding.evidence)}`,
      `   - 受影响调用方/流程: ${singleLine(finding.affected_flows)}`,
      `   - 最小可行修复: ${singleLine(finding.smallest_viable_fix)}`,
    ].join('\n')).join('\n');
  const inline = review.findings
    .filter((finding) => finding.path && Number.isInteger(finding.line) && finding.inline_comment)
    .map((finding) => `- [${finding.path}:${finding.line}] ${singleLine(finding.inline_comment)}`);

  return [
    `## 代码评审报告: ${title || 'PR Review'}`,
    '',
    `**风险等级:** ${RISK[review.risk_level]}`,
    `**处理建议:** ${RECOMMENDATION[review.recommendation]}`,
    `**决策摘要:** ${singleLine(review.decision_summary)}`,
    '',
    '### 级联分析',
    `- 变更符号: ${listText(review.cascade_analysis.changed_symbols)}`,
    `- 受影响流程: ${listText(review.cascade_analysis.affected_flows)}`,
    `- 变更集外调用方: ${singleLine(review.cascade_analysis.outside_changeset_callers)}`,
    `- 置信度: ${review.cascade_analysis.confidence}`,
    '',
    '### 问题发现',
    findings,
    '',
    '### 行级发现',
    inline.length > 0 ? inline.join('\n') : '- 无明确变更行归属。',
    '',
    '### Karpathy 评审',
    `- 假设: ${singleLine(review.karpathy_review.assumptions)}`,
    `- 简洁性: ${singleLine(review.karpathy_review.simplicity)}`,
    `- 变更范围: ${singleLine(review.karpathy_review.surgical_scope)}`,
    `- 验证: ${singleLine(review.karpathy_review.verification)}`,
    '',
    '### 缺失覆盖',
    bulletList(review.missing_coverage, '验证覆盖与当前风险匹配。'),
  ].join('\n');
}

export function renderCanonicalIssueReview(review, title = 'Issue Review') {
  return [
    `## Issue 分析: ${title || 'Issue Review'}`,
    '',
    `**质量评分:** ${review.quality_score}/5`,
    `**优先级建议:** ${PRIORITY[review.priority_suggestion]}`,
    `**类型:** ${ISSUE_TYPE[review.issue_type]}`,
    `**维护者下一步动作:** ${NEXT_ACTION[review.maintainer_next_action]}`,
    '',
    '### 完整性',
    `- 问题陈述: ${mapValue(review.completeness.problem_statement, { CLEAR: '清楚', VAGUE: '模糊', MISSING: '缺失' })}`,
    `- 复现步骤: ${mapValue(review.completeness.reproduction_steps, { PROVIDED: '已提供', PARTIAL: '部分提供', MISSING: '缺失', NOT_APPLICABLE: 'N/A' })}`,
    `- 预期与实际: ${mapValue(review.completeness.expected_vs_actual, { DESCRIBED: '已描述', INFERRED: '可推断', MISSING: '缺失', NOT_APPLICABLE: 'N/A' })}`,
    `- 环境信息: ${mapValue(review.completeness.environment_info, { PROVIDED: '已提供', PARTIAL: '部分提供', MISSING: '缺失', NOT_APPLICABLE: 'N/A' })}`,
    `- 支撑证据: ${mapValue(review.completeness.supporting_evidence, { PROVIDED: '已提供', MISSING: '缺失', NOT_APPLICABLE: 'N/A' })}`,
    '',
    '### 清晰度',
    `- 标题质量: ${mapValue(review.clarity.title_quality, { DESCRIPTIVE: '描述准确', VAGUE: '模糊', MISLEADING: '误导' })}`,
    `- 单一关注点: ${mapValue(review.clarity.single_concern, { YES: '是', MULTIPLE_CONCERNS: '多个问题混杂' })}`,
    `- 表达精确度: ${mapValue(review.clarity.language_precision, { PRECISE: '精确', SOMEWHAT_VAGUE: '略模糊', UNCLEAR: '不清楚' })}`,
    `- 范围: ${mapValue(review.clarity.scope, { WELL_DEFINED: '边界清楚', OPEN_ENDED: '开放式', UNCLEAR: '不清楚' })}`,
    '',
    '### 可执行性',
    `- 是否可开始: ${mapValue(review.actionability.ready_to_start, { YES: '是', NEEDS_CLARIFICATION: '需要澄清', BLOCKED: '被阻塞' })}`,
    `- 验收标准: ${mapValue(review.actionability.acceptance_criteria, { EXPLICIT: '明确', INFERRED: '可推断', MISSING: '缺失' })}`,
    `- 依赖: ${mapValue(review.actionability.dependencies, { IDENTIFIED: '已识别', NOT_APPLICABLE: '不适用', UNKNOWN: '未知' })}`,
    '',
    '### 建议',
    bulletList(review.suggestions, '无需报告者继续补充。'),
    '',
    '### 总结',
    singleLine(review.summary),
  ].join('\n');
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function listText(values) {
  return values.length > 0 ? values.map(singleLine).join(', ') : '无';
}

function bulletList(values, emptyText) {
  return values.length > 0 ? values.map((value) => `- ${singleLine(value)}`).join('\n') : `- ${emptyText}`;
}

function mapValue(value, mapping) {
  return mapping[value];
}
```

- [ ] **Step 5: Add renderer fixtures**

Append one complete PR fixture and one complete Issue fixture to `tests/review-contracts.test.mjs`. Assert every section uses supplied data, including these representative checks:

```js
test('canonical PR renderer preserves every contract section', () => {
  const markdown = renderCanonicalPRReview({
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
  }, 'Harden auth');

  assert.match(markdown, /\*\*风险等级:\*\* 高/);
  assert.match(markdown, /- 变更符号: authorize/);
  assert.match(markdown, /- \[src\/auth\.js:12\] 缺失 token 时应返回 401。/);
  assert.match(markdown, /- 验证: Missing rejection-path test\./);
  assert.match(markdown, /- Add a missing-token integration test\./);
});

test('canonical Issue renderer preserves all rubric dimensions', () => {
  const markdown = renderCanonicalIssueReview({
    quality_score: 2,
    priority_suggestion: 'P1_HIGH',
    issue_type: 'BUG_REPORT',
    maintainer_next_action: 'ASK_REPORTER',
    completeness: {
      problem_statement: 'CLEAR', reproduction_steps: 'MISSING', expected_vs_actual: 'MISSING',
      environment_info: 'MISSING', supporting_evidence: 'MISSING',
    },
    clarity: {
      title_quality: 'DESCRIPTIVE', single_concern: 'YES', language_precision: 'SOMEWHAT_VAGUE', scope: 'WELL_DEFINED',
    },
    actionability: {
      ready_to_start: 'NEEDS_CLARIFICATION', acceptance_criteria: 'MISSING', dependencies: 'UNKNOWN',
    },
    suggestions: ['请补充稳定复现步骤。'],
    summary: '问题明确，但当前信息不足以开始修复。',
  }, '登录后 500');

  assert.match(markdown, /\*\*维护者下一步动作:\*\* 询问报告者/);
  assert.match(markdown, /- 复现步骤: 缺失/);
  assert.match(markdown, /- 是否可开始: 需要澄清/);
  assert.match(markdown, /- 请补充稳定复现步骤。/);
});
```

- [ ] **Step 6: Integrate canonical objects into normalization**

At the top of `scripts/review-logic.mjs`, import the four canonical helpers. In `normalizeReviewResponse`, place canonical checks before the existing tolerant structured checks:

```js
import {
  isCanonicalIssueReview,
  isCanonicalPRReview,
  renderCanonicalIssueReview,
  renderCanonicalPRReview,
} from './review-contracts.mjs';
```

```js
if (context.type === 'pr') {
  if (isValidPRMarkdownContract(trimmed)) return trimmed;
  if (parsed && isCanonicalPRReview(parsed)) return renderCanonicalPRReview(parsed, context.title);
  if (parsed && looksLikeStructuredPRReview(parsed)) return formatStructuredPRReview(parsed, context.title);
}

if (context.type === 'issue') {
  if (isValidIssueMarkdownContract(trimmed)) return trimmed;
  if (parsed && isCanonicalIssueReview(parsed)) return renderCanonicalIssueReview(parsed, context.title);
  if (parsed && looksLikeStructuredIssueReview(parsed)) return formatStructuredIssueReview(parsed, context.title);
}
```

Add canonical JSON normalization cases to `tests/review-logic.test.mjs`; assert recommendation extraction, all canonical sections, and that `extractInlineComments` still rejects a path absent from the changed files.

- [ ] **Step 7: Run contract and review-logic tests**

Run: `node --test tests/review-contracts.test.mjs tests/review-logic.test.mjs`

Expected: all tests PASS, including the existing tolerant JSON and free-text tests.

- [ ] **Step 8: Commit the contract unit**

```bash
git add scripts/review-contracts.mjs scripts/review-logic.mjs tests/review-contracts.test.mjs tests/review-logic.test.mjs
git commit -m "feat: define structured review contracts"
```

---

### Task 3: Add structured requests and one content-aware fallback

**Files:**

- Modify: `scripts/llm-client.mjs:1-109`
- Modify: `tests/llm-client.test.mjs:1-19`

**Interfaces:**

- Consumes: `supportsOpenRouterStructuredOutputs({ mode, provider, baseURL, model, fetchImpl? })`
- Extends: `chatCompletion({ provider, model, apiKey, baseURL, maxTokens, messages, system, structuredOutputMode?, responseFormat? }) => Promise<string>`
- Preserves: current parameters and return type

- [ ] **Step 1: Write failing default-isolation and structured-request tests**

Extend `tests/llm-client.test.mjs` to import `chatCompletion` and `clearOpenRouterCapabilityCache`. Add this test isolation before the request tests:

```js
const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
  clearOpenRouterCapabilityCache();
});
```

Then assert:

```js
test('off mode sends the legacy OpenAI request without probing', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'legacy text' } }] }) };
  };

  const result = await chatCompletion({
    provider: 'openai', model: 'openai/gpt-5.5', apiKey: 'secret',
    baseURL: 'https://openrouter.ai/api/v1', maxTokens: 4096,
    messages: [{ role: 'user', content: 'review' }], system: 'system',
    structuredOutputMode: 'off', responseFormat: { type: 'json_schema' },
  });

  assert.equal(result, 'legacy text');
  assert.equal(calls.length, 1);
  assert.equal('response_format' in calls[0].body, false);
  assert.equal('provider' in calls[0].body, false);
  assert.equal(calls[0].body.messages[0].content, 'system');
});
```

The structured test must mock one metadata GET followed by one completion POST and assert `response_format`, `provider.require_parameters`, and the temporary JSON instruction are present.

- [ ] **Step 2: Run focused tests and verify structured assertions fail**

Run: `node --test tests/llm-client.test.mjs`

Expected: legacy tests PASS and the new structured request test FAIL because `chatCompletion` ignores the new options.

- [ ] **Step 3: Refactor the OpenAI request into a reusable single-attempt helper**

Add these helpers to `scripts/llm-client.mjs` without changing the Anthropic branch:

```js
import { supportsOpenRouterStructuredOutputs } from './openrouter-structured-output.mjs';

const STRUCTURED_OUTPUT_INSTRUCTION = [
  '',
  '## 本次响应序列化要求',
  '本次响应必须遵守请求携带的 JSON Schema。',
  'Schema 字段承载原 Markdown 输出契约的同等语义。',
  '不要输出 Markdown fence、额外解释或 schema 外字段。',
].join('\n');

function hasUsableText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

async function requestOpenAI({ url, apiKey, body }) {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return typeof data.choices?.[0]?.message?.content === 'string'
    ? data.choices[0].message.content
    : '';
}
```

- [ ] **Step 4: Implement capability-gated structured invocation and fallback**

Extend `chatCompletion` with `structuredOutputMode = 'auto'` and `responseFormat`. Replace only the OpenAI-compatible branch with this logic:

```js
const url = `${base}/chat/completions`;
const legacyBody = buildOpenAIRequest(model, messages, system, maxTokens);
const structuredSupported = responseFormat && await supportsOpenRouterStructuredOutputs({
  mode: structuredOutputMode,
  provider,
  baseURL: base,
  model,
});

if (!structuredSupported) {
  console.log(structuredOutputMode === 'off'
    ? 'structured output: off'
    : 'structured output: unsupported, using legacy');
  return requestOpenAI({ url, apiKey, body: legacyBody });
}

console.log('structured output: enabled');
const structuredBody = buildOpenAIRequest(
  model,
  messages,
  system ? `${system}${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION.trimStart(),
  maxTokens,
);
structuredBody.response_format = responseFormat;
structuredBody.provider = { require_parameters: true };

let structuredError;
try {
  const content = await requestOpenAI({ url, apiKey, body: structuredBody });
  if (hasUsableText(content)) {
    console.log('structured output returned usable text, normalizing without retry');
    return content;
  }
} catch (error) {
  structuredError = error;
}

console.warn('structured output produced no usable text, falling back once');
try {
  return await requestOpenAI({ url, apiKey, body: legacyBody });
} catch (fallbackError) {
  if (structuredError && fallbackError.cause === undefined) fallbackError.cause = structuredError;
  throw fallbackError;
}
```

- [ ] **Step 5: Add exact fallback tests**

Cover these cases with ordered mock responses:

- structured JSON string: one metadata GET and one model POST
- non-schema Markdown string: no fallback POST
- malformed JSON-like non-empty string: no fallback POST
- structured 400 response: one legacy POST after the error
- structured 200 with missing content: one legacy POST
- structured 200 with whitespace content: one legacy POST
- structured error plus legacy error: final error has the structured error as `cause`
- fallback body has no `response_format`, no `provider`, and no temporary system suffix
- `anthropic` with mode `auto` keeps the current `/messages` body and never probes

Use a 400 response for error-path tests so the existing 5xx retry sleeps do not slow the suite.

- [ ] **Step 6: Run focused client tests**

Run: `node --test tests/openrouter-structured-output.test.mjs tests/llm-client.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit the client unit**

```bash
git add scripts/llm-client.mjs tests/llm-client.test.mjs
git commit -m "feat: use structured output with safe fallback"
```

---

### Task 4: Wire every LLM call and public configuration surface

**Files:**

- Modify: `scripts/review.mjs:1-35,82-93,124-132`
- Modify: `scripts/pr-reviewer.mjs:1-38`
- Modify: `scripts/external-dispatcher.mjs:14-30,68-79`
- Modify: `scripts/evaluate-quality.mjs:219-227,300-317`
- Modify: `tests/quality-eval.test.mjs:207-237`
- Modify: `action.yml:7-38,53-61`
- Modify: `.github/workflows/repo-guard.yml:42-48`
- Modify: `.github/workflows/external-repo-guard.yml:37-47`

**Interfaces:**

- Consumes: `parseStructuredOutputMode`
- Consumes: `PR_REVIEW_RESPONSE_FORMAT`, `ISSUE_REVIEW_RESPONSE_FORMAT`, and `getReviewResponseFormat(kind)`
- Produces: all production and evaluation calls pass `structuredOutputMode` and a review-specific `responseFormat`

- [ ] **Step 1: Extend quality-evaluation config tests first**

Update the expected objects in `tests/quality-eval.test.mjs` to include `structuredOutput: 'auto'`. Add this precedence assertion:

```js
assert.equal(getEnvConfig({
  PROVIDER: 'openai', BASE_URL: 'https://openrouter.ai/api/v1', API_KEY: 'secret', MODEL: 'openai/gpt-5.5',
  STRUCTURED_OUTPUT: 'auto', LLM_STRUCTURED_OUTPUT: 'off',
}).structuredOutput, 'auto');
```

Add an invalid-value assertion matching the shared parser error.

- [ ] **Step 2: Run the quality config test and verify failure**

Run: `node --test tests/quality-eval.test.mjs`

Expected: FAIL because `getEnvConfig` does not return `structuredOutput`.

- [ ] **Step 3: Wire schemas and mode through JavaScript call sites**

Apply these exact data-flow changes:

```js
// scripts/review.mjs config
structuredOutput: parseStructuredOutputMode(env.LLM_STRUCTURED_OUTPUT),

// buildPRReview config in scripts/review.mjs and scripts/external-dispatcher.mjs
structuredOutput: config.structuredOutput,

// Issue call in scripts/review.mjs
structuredOutputMode: config.structuredOutput,
responseFormat: ISSUE_REVIEW_RESPONSE_FORMAT,

// PR call in scripts/pr-reviewer.mjs
structuredOutputMode: config.structuredOutput,
responseFormat: PR_REVIEW_RESPONSE_FORMAT,

// scripts/evaluate-quality.mjs getEnvConfig
structuredOutput: parseStructuredOutputMode(env.STRUCTURED_OUTPUT || env.LLM_STRUCTURED_OUTPUT),

// quality fixture call
structuredOutputMode: config.structuredOutput,
responseFormat: getReviewResponseFormat(fixture.kind),
```

Use these imports in the call-site files:

```js
import { parseStructuredOutputMode } from './openrouter-structured-output.mjs';
import {
  ISSUE_REVIEW_RESPONSE_FORMAT,
  PR_REVIEW_RESPONSE_FORMAT,
  getReviewResponseFormat,
} from './review-contracts.mjs';
```

Each file imports only the contract values it uses. Set external dispatcher config from `env.LLM_STRUCTURED_OUTPUT` with the same parser.

- [ ] **Step 4: Add the Action input and workflow passthrough**

Add this input to `action.yml`:

```yaml
  structured-output:
    description: "OpenRouter structured output mode: 'off' or 'auto'"
    required: false
    default: "auto"
```

Map it into the composite step:

```yaml
        LLM_STRUCTURED_OUTPUT: ${{ inputs.structured-output }}
```

Add this input to `.github/workflows/repo-guard.yml`:

```yaml
          structured-output: ${{ vars.LLM_STRUCTURED_OUTPUT || 'auto' }}
```

Add this environment value to `.github/workflows/external-repo-guard.yml`:

```yaml
          LLM_STRUCTURED_OUTPUT: ${{ vars.LLM_STRUCTURED_OUTPUT || 'auto' }}
```

- [ ] **Step 5: Run config, syntax, and full unit tests**

Run: `npm run check`

Expected: all JavaScript files pass `node --check`.

Run: `npm test`

Expected: all tests PASS; no live network requests occur.

- [ ] **Step 6: Commit full call-site coverage**

```bash
git add action.yml .github/workflows/repo-guard.yml .github/workflows/external-repo-guard.yml scripts/review.mjs scripts/pr-reviewer.mjs scripts/external-dispatcher.mjs scripts/evaluate-quality.mjs tests/quality-eval.test.mjs
git commit -m "feat: enable structured output across review flows"
```

---

### Task 5: Document rollout and verify compatibility

**Files:**

- Modify: `README.md:75-93,120-128,208-236`
- Modify: `docs/quality-evaluation.md:18-49`
- Verify: all files from Tasks 1-4

**Interfaces:**

- Documents: public Action input, environment variable, OpenRouter-only auto behavior, model metadata fallback, and possible second model call
- Produces: release-ready, backward-compatible change set

- [ ] **Step 1: Update the README configuration tables**

Add these rows:

```markdown
| `LLM_STRUCTURED_OUTPUT` | `auto` | `auto` uses OpenRouter JSON Schema when supported; explicit `off` always uses the legacy free-text request |
```

```markdown
| `structured-output` | No | `auto` | OpenRouter Structured Outputs mode: `off` or `auto` |
```

Add an OpenRouter example using the confirmed configuration:

```yaml
with:
  provider: openai
  model: openai/gpt-5.5
  api-key: ${{ secrets.LLM_API_KEY }}
  base-url: https://openrouter.ai/api/v1
  structured-output: auto
```

State explicitly that `auto`:

- probes OpenRouter's public model metadata once per model per process;
- uses legacy text immediately when capability lookup fails or support is absent;
- keeps any non-empty first response even when it does not match the schema;
- performs one additional legacy model call only when the structured call returns no usable text, which can add cost.

- [ ] **Step 2: Update quality-evaluation documentation**

Document both variable names:

```markdown
- `STRUCTURED_OUTPUT` or `LLM_STRUCTURED_OUTPUT` (`auto` by default; use `off` to force the legacy free-text path)
```

Clarify that PR fixtures use the PR schema, Issue fixtures use the Issue schema, and all fixtures in one process share the model capability cache.

- [ ] **Step 3: Run documentation and repository checks**

Run: `rg -n "structured-output|LLM_STRUCTURED_OUTPUT|STRUCTURED_OUTPUT" README.md action.yml .github/workflows docs/quality-evaluation.md scripts tests`

Expected: every public surface, call site, and test named in the spec appears in the output.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `npm run check && npm test`

Expected: syntax check and all tests PASS.

- [ ] **Step 4: Inspect backward-compatible request evidence**

Run: `node --test tests/llm-client.test.mjs --test-name-pattern="off mode|anthropic|non-OpenRouter"`

Expected: matching compatibility tests PASS and show no metadata or structured request parameters on legacy paths.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/quality-evaluation.md
git commit -m "docs: explain OpenRouter structured output mode"
```

- [ ] **Step 6: Squash process-only commits before integration**

Keep the already committed spec and plan as documentation history. Combine implementation red/green/fixup commits so the final implementation history contains only clear result commits for capability/client behavior, review contracts/call-site coverage, and documentation. Do not alter `origin/main` or push without explicit authorization.

- [ ] **Step 7: Record final evidence**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
npm run check
npm test
```

Expected: working tree clean; concise implementation commits visible; syntax checks and all tests PASS.
