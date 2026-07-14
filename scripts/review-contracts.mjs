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

const RISK = { LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '致命' };
const RECOMMENDATION = { APPROVE: '批准', COMMENT: '评论', REQUEST_CHANGES: '请求修改', NEEDS_HUMAN: '需要人工判断' };
const PRIORITY = { P0_CRITICAL: 'P0-致命', P1_HIGH: 'P1-高', P2_MEDIUM: 'P2-中', P3_LOW: 'P3-低' };
const ISSUE_TYPE = { BUG_REPORT: '缺陷报告', FEATURE_REQUEST: '功能请求', QUESTION: '问题咨询', DISCUSSION: '讨论' };
const NEXT_ACTION = { READY_TO_START: '可以开始', ASK_REPORTER: '询问报告者', TRIAGE_DECISION: '需要分诊决策', REPRODUCE: '需要复现' };

export function getReviewResponseFormat(kind) {
  if (kind === 'pr') return PR_REVIEW_RESPONSE_FORMAT;
  if (kind === 'issue') return ISSUE_REVIEW_RESPONSE_FORMAT;
  throw new Error(`Unsupported review contract kind: ${kind}`);
}

export function isCanonicalPRReview(value) {
  return matchesSchema(value, PR_SCHEMA);
}

export function isCanonicalIssueReview(value) {
  return matchesSchema(value, ISSUE_SCHEMA);
}

export function renderCanonicalPRReview(review, title = 'PR Review') {
  const findings = review.findings.length === 0
    ? '未发现 blocking findings。'
    : review.findings.map((finding, index) => [
      `${index + 1}. **[${RISK[finding.severity]}] ${singleLine(finding.title)}**`,
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

function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((branch) => matchesSchema(value, branch));
  if (schema.enum && !schema.enum.includes(value)) return false;

  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'integer') {
    return Number.isInteger(value) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum);
  }
  if (schema.type === 'array') {
    return Array.isArray(value) && value.every((item) => matchesSchema(item, schema.items));
  }
  if (schema.type === 'object') {
    if (!isObject(value)) return false;
    const properties = schema.properties || {};
    if ((schema.required || []).some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    return Object.entries(value).every(([key, item]) => properties[key] && matchesSchema(item, properties[key]));
  }
  return false;
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
