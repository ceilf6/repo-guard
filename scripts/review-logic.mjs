// @ts-check

const TRIGGER_PATTERNS = [/@repo-guard/i, /\/review/i];

export function isTriggeredByComment(commentBody = '') {
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(commentBody));
}

export function extractUserPrompt(commentBody = '') {
  return commentBody
    .replace(/@repo-guard/gi, '')
    .replace(/\/review/gi, '')
    .trim();
}

export function getPRNumberCandidate(config) {
  if (config.prNumber) return config.prNumber;
  if (config.eventName === 'issue_comment' && config.isPullRequest) return config.issueNumber;
  return '';
}

export function resolveReviewType(config) {
  if (config.type === 'pr') return getPRNumberCandidate(config) ? 'pr' : null;
  if (config.type === 'issue') return config.issueNumber ? 'issue' : null;
  if (config.eventName === 'pull_request' && config.prNumber) return 'pr';
  if (config.eventName === 'issues' && config.issueNumber) return 'issue';
  if (config.eventName === 'issue_comment') {
    if (config.isPullRequest && config.issueNumber) return 'pr';
    if (config.issueNumber) return 'issue';
  }
  if (config.prNumber) return 'pr';
  if (config.issueNumber) return 'issue';
  return null;
}

export function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function getReviewNumber(config, reviewType) {
  const rawNumber = reviewType === 'pr' ? getPRNumberCandidate(config) : config.issueNumber;
  const label = reviewType === 'pr' ? 'PR number' : 'Issue number';
  return parsePositiveInteger(rawNumber, label);
}

export function extractRecommendation(response) {
  const match = response.match(/\*\*处理建议:\*\*\s*(批准|评论|请求修改|需要人工判断)/);
  if (!match) return 'COMMENT';

  switch (match[1]) {
    case '批准': return 'APPROVE';
    case '请求修改': return 'REQUEST_CHANGES';
    case '需要人工判断': return 'NEEDS_HUMAN';
    default: return 'COMMENT';
  }
}

export function mapRecommendationToEvent(recommendation) {
  switch (recommendation) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    default: return 'COMMENT';
  }
}

export function stripThinkingBlocks(response = '') {
  return response
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

export function normalizeReviewResponse(response = '', context = {}) {
  const trimmed = String(response || '').trim();

  const parsed = parseStandaloneJson(trimmed);
  const jsonLike = looksLikeStandaloneJson(trimmed);
  if (context.type === 'pr') {
    if (trimmed.startsWith('## 代码评审报告:')) return trimmed;
    if (parsed && looksLikeStructuredPRReview(parsed)) return formatStructuredPRReview(parsed, context.title);
    if (parsed) return formatUnknownJsonPRReview(parsed, context.title);
    if (jsonLike) return formatInvalidJsonPRReview(context.title);
    return formatUnstructuredPRReview(trimmed, context.title);
  }

  if (context.type === 'issue') {
    if (trimmed.startsWith('## Issue 分析:')) return trimmed;
    if (parsed && looksLikeStructuredIssueReview(parsed)) return formatStructuredIssueReview(parsed, context.title);
    if (parsed) return formatUnknownJsonIssueReview(parsed, context.title);
    if (jsonLike) return formatInvalidJsonIssueReview(context.title);
    return formatUnstructuredIssueReview(trimmed, context.title);
  }

  return trimmed;
}

function parseStandaloneJson(response) {
  const json = unwrapJsonFence(response);
  if (!looksLikeCompleteJsonValue(json)) return null;

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function looksLikeStandaloneJson(response) {
  const json = unwrapJsonFence(response);
  return json.startsWith('{') || json.startsWith('[');
}

function looksLikeCompleteJsonValue(response) {
  const json = String(response || '').trim();
  return (json.startsWith('{') && json.endsWith('}')) || (json.startsWith('[') && json.endsWith(']'));
}

function unwrapJsonFence(response) {
  const fence = response.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return (fence ? fence[1] : response).trim();
}

function looksLikeStructuredPRReview(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (
      'summary' in value ||
      'findings' in value ||
      'risk_level' in value ||
      'recommendation' in value ||
      '决策摘要' in value ||
      '摘要' in value ||
      '总结' in value ||
      '问题发现' in value ||
      '行级发现' in value ||
      '风险等级' in value ||
      '处理建议' in value
    ),
  );
}

function looksLikeStructuredIssueReview(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (
      'quality_score' in value ||
      'priority_suggestion' in value ||
      'maintainer_next_action' in value ||
      'suggestions' in value ||
      '质量评分' in value ||
      '优先级建议' in value ||
      '维护者下一步动作' in value ||
      '建议' in value ||
      '类型' in value ||
      '总结' in value
    ),
  );
}

function formatStructuredPRReview(review, title = 'PR Review') {
  const findings = [
    ...asArray(review.findings || review['问题发现']),
    ...asArray(review.inline_findings || review['行级发现']),
  ];
  const summary = toSingleLine(firstPresent(review.summary, review['决策摘要'], review['摘要'], review['总结'], review.recommendation, review['处理建议'], '模型返回了结构化 JSON，已归一化为 Repo Guard Markdown 契约。'));

  return [
    `## 代码评审报告: ${title || 'PR Review'}`,
    '',
    `**风险等级:** ${mapRiskLevel(review.risk_level || review.risk || review['风险等级'], findings)}`,
    `**处理建议:** ${mapRecommendationLabel(review.recommendation || review['处理建议'], findings)}`,
    `**决策摘要:** ${summary}`,
    '',
    '### 级联分析',
    '- 变更符号: 未在模型 JSON 中提供',
    '- 受影响流程: 未在模型 JSON 中提供',
    '- 变更集外调用方: unknown',
    '- 置信度: degraded',
    '',
    '### 问题发现',
    formatFindings(findings),
    '',
    '### 行级发现',
    formatInlineFindings(findings),
    '',
    '### Karpathy 评审',
    '- 假设: 模型返回了非契约 JSON，发布前已做格式归一化。',
    '- 简洁性: 保留原始 summary/findings/recommendation 信息，不额外推断缺失证据。',
    '- 变更范围: 未在模型 JSON 中提供',
    '- 验证: 需要查看 CI、测试或人工 CR 证据补强合并信心。',
    '',
    '### 缺失覆盖',
    '- 模型未按 Markdown 契约输出，建议补充真实模型质量评估覆盖。',
  ].join('\n');
}

function formatUnstructuredPRReview(response, title = 'PR Review') {
  const inlineFindings = extractLooseInlineFindings(response);

  return [
    `## 代码评审报告: ${title || 'PR Review'}`,
    '',
    `**风险等级:** ${inferRiskLevelFromText(response, inlineFindings)}`,
    `**处理建议:** ${inferRecommendationFromText(response, inlineFindings)}`,
    `**决策摘要:** ${extractSummaryLine(response)}`,
    '',
    '### 级联分析',
    '- 变更符号: 未在模型非契约输出中提供',
    '- 受影响流程: 未在模型非契约输出中提供',
    '- 变更集外调用方: unknown',
    '- 置信度: degraded',
    '',
    '### 问题发现',
    formatOriginalResponseFinding(response),
    '',
    '### 行级发现',
    formatInlineFindings(inlineFindings),
    '',
    '### Karpathy 评审',
    '- 假设: 模型返回了非契约 Markdown，发布前已做格式归一化。',
    '- 简洁性: 保留原始模型输出，不额外推断缺失证据。',
    '- 变更范围: 未在模型非契约输出中提供',
    '- 验证: 需要查看 CI、测试或人工 CR 证据补强合并信心。',
    '',
    '### 缺失覆盖',
    '- 模型未按 Markdown 契约输出，建议补充真实模型质量评估覆盖。',
  ].join('\n');
}

function formatUnknownJsonPRReview(review, title = 'PR Review') {
  const findings = Array.isArray(review)
    ? review
    : asArray(review.comments || review.review_comments || review.annotations);
  const recommendation = Array.isArray(review)
    ? ''
    : firstPresent(review.recommendation, review.overall_recommendation, review.decision, review.result);
  const risk = Array.isArray(review) ? '' : (review.risk_level || review.risk || review.severity);

  return [
    `## 代码评审报告: ${title || 'PR Review'}`,
    '',
    `**风险等级:** ${mapRiskLevel(risk, findings)}`,
    `**处理建议:** ${mapRecommendationLabel(recommendation, findings)}`,
    '**决策摘要:** 模型返回了未识别 JSON schema，已归一化为 Repo Guard Markdown 契约。',
    '',
    '### 级联分析',
    '- 变更符号: 未在模型 JSON 中提供',
    '- 受影响流程: 未在模型 JSON 中提供',
    '- 变更集外调用方: unknown',
    '- 置信度: degraded',
    '',
    '### 问题发现',
    formatFindings(findings),
    '',
    '### 行级发现',
    formatInlineFindings(findings),
    '',
    '### Karpathy 评审',
    '- 假设: 模型返回了未识别 JSON schema，发布前已做安全归一化。',
    '- 简洁性: 不发布原始 JSON；只保留可映射的 recommendation、risk 与行级发现。',
    '- 变更范围: 未在模型 JSON 中提供',
    '- 验证: 需要查看 CI、测试或人工 CR 证据补强合并信心。',
    '',
    '### 缺失覆盖',
    '- 模型未按 Markdown 契约输出，建议补充真实模型质量评估覆盖。',
  ].join('\n');
}

function formatInvalidJsonPRReview(title = 'PR Review') {
  return [
    `## 代码评审报告: ${title || 'PR Review'}`,
    '',
    '**风险等级:** 中',
    '**处理建议:** 需要人工判断',
    '**决策摘要:** 模型返回了不可解析的 JSON-like 输出，已安全归一化为 Repo Guard Markdown 契约。',
    '',
    '### 级联分析',
    '- 变更符号: 未在模型 JSON-like 输出中提供',
    '- 受影响流程: GitHub 评论展示与后续解析',
    '- 变更集外调用方: unknown',
    '- 置信度: degraded',
    '',
    '### 问题发现',
    '1. **[中] 模型输出是不可解析 JSON-like 内容**',
    '   - 证据: 发布前检测到 JSON-like 输出，但无法安全解析；原文未发布。',
    '   - 受影响调用方/流程: GitHub 评论展示与后续解析',
    '   - 最小可行修复: 已使用安全 fallback，避免原始 JSON-like 内容泄漏到评论。',
    '',
    '### 行级发现',
    '- 无明确变更行归属。',
    '',
    '### Karpathy 评审',
    '- 假设: 模型返回了不可解析 JSON-like 输出，发布前已做安全归一化。',
    '- 简洁性: 不发布原始 JSON-like 内容，避免格式污染后续解析。',
    '- 变更范围: 未在模型 JSON-like 输出中提供',
    '- 验证: 需要查看 CI、测试或人工 CR 证据补强合并信心。',
    '',
    '### 缺失覆盖',
    '- 模型未按 Markdown 契约输出，建议补充真实模型质量评估覆盖。',
  ].join('\n');
}

function formatStructuredIssueReview(review, title = 'Issue Review') {
  return [
    `## Issue 分析: ${title || 'Issue Review'}`,
    '',
    `**质量评分:** ${formatQualityScore(review.quality_score || review.score || review['质量评分'])}`,
    `**优先级建议:** ${formatPriority(review.priority_suggestion || review.priority || review['优先级建议'])}`,
    `**类型:** ${formatIssueType(review.issue_type || review.type || review['类型'])}`,
    `**维护者下一步动作:** ${formatMaintainerAction(review.maintainer_next_action || review.next_action || review.action || review['维护者下一步动作'])}`,
    '',
    '### 完整性',
    '- 问题陈述: 未在模型 JSON 中提供',
    '- 复现步骤: 未在模型 JSON 中提供',
    '- 预期与实际: 未在模型 JSON 中提供',
    '- 环境信息: 未在模型 JSON 中提供',
    '- 支撑证据: 未在模型 JSON 中提供',
    '',
    '### 清晰度',
    '- 标题质量: 未在模型 JSON 中提供',
    '- 单一关注点: 未在模型 JSON 中提供',
    '- 表达精确度: 未在模型 JSON 中提供',
    '- 范围: 未在模型 JSON 中提供',
    '',
    '### 可执行性',
    '- 是否可开始: 未在模型 JSON 中提供',
    '- 验收标准: 未在模型 JSON 中提供',
    '- 依赖: 未在模型 JSON 中提供',
    '',
    '### 建议',
    formatSuggestions(review.suggestions || review.recommendations || review.recommendation || review['建议']),
    '',
    '### 总结',
    toSingleLine(review.summary || review['总结'] || '模型返回了结构化 JSON，已归一化为 Repo Guard Markdown 契约。'),
  ].join('\n');
}

function formatUnknownJsonIssueReview(review, title = 'Issue Review') {
  const action = Array.isArray(review)
    ? ''
    : firstPresent(review.maintainer_next_action, review.next_action, review.next, review.action);
  const qualityScore = Array.isArray(review) ? '' : (review.quality_score || review.score);
  const priority = Array.isArray(review) ? '' : (review.priority_suggestion || review.priority);
  const issueType = Array.isArray(review) ? '' : (review.issue_type || review.type);

  return [
    `## Issue 分析: ${title || 'Issue Review'}`,
    '',
    `**质量评分:** ${formatQualityScore(qualityScore)}`,
    `**优先级建议:** ${formatPriority(priority)}`,
    `**类型:** ${formatIssueType(issueType)}`,
    `**维护者下一步动作:** ${formatMaintainerAction(action)}`,
    '',
    '### 完整性',
    '- 问题陈述: 未在模型 JSON 中提供',
    '- 复现步骤: 未在模型 JSON 中提供',
    '- 预期与实际: 未在模型 JSON 中提供',
    '- 环境信息: 未在模型 JSON 中提供',
    '- 支撑证据: 未在模型 JSON 中提供',
    '',
    '### 清晰度',
    '- 标题质量: 未在模型 JSON 中提供',
    '- 单一关注点: 未在模型 JSON 中提供',
    '- 表达精确度: 未在模型 JSON 中提供',
    '- 范围: 未在模型 JSON 中提供',
    '',
    '### 可执行性',
    '- 是否可开始: 未在模型 JSON 中提供',
    '- 验收标准: 未在模型 JSON 中提供',
    '- 依赖: 未在模型 JSON 中提供',
    '',
    '### 建议',
    '- 模型返回了未识别 JSON schema，已归一化为 Repo Guard Markdown 契约；需要人工查看原始模型配置或优化提示。',
    '',
    '### 总结',
    '模型返回了未识别 JSON schema，已归一化为 Repo Guard Markdown 契约。',
  ].join('\n');
}

function formatInvalidJsonIssueReview(title = 'Issue Review') {
  return [
    `## Issue 分析: ${title || 'Issue Review'}`,
    '',
    '**质量评分:** 2/5',
    '**优先级建议:** P2-中',
    '**类型:** 讨论',
    '**维护者下一步动作:** 需要分诊决策',
    '',
    '### 完整性',
    '- 问题陈述: 未在模型 JSON-like 输出中提供',
    '- 复现步骤: 未在模型 JSON-like 输出中提供',
    '- 预期与实际: 未在模型 JSON-like 输出中提供',
    '- 环境信息: 未在模型 JSON-like 输出中提供',
    '- 支撑证据: 未在模型 JSON-like 输出中提供',
    '',
    '### 清晰度',
    '- 标题质量: 未在模型 JSON-like 输出中提供',
    '- 单一关注点: 未在模型 JSON-like 输出中提供',
    '- 表达精确度: 未在模型 JSON-like 输出中提供',
    '- 范围: 未在模型 JSON-like 输出中提供',
    '',
    '### 可执行性',
    '- 是否可开始: 需要维护者分诊',
    '- 验收标准: 未在模型 JSON-like 输出中提供',
    '- 依赖: 未在模型 JSON-like 输出中提供',
    '',
    '### 建议',
    '- 模型返回了不可解析的 JSON-like 输出，已安全归一化为 Repo Guard Markdown 契约；需要人工查看原始模型配置或优化提示。',
    '',
    '### 总结',
    '模型返回了不可解析的 JSON-like 输出，已安全归一化为 Repo Guard Markdown 契约。',
  ].join('\n');
}

function formatUnstructuredIssueReview(response, title = 'Issue Review') {
  return [
    `## Issue 分析: ${title || 'Issue Review'}`,
    '',
    `**质量评分:** ${inferQualityScoreFromText(response)}`,
    `**优先级建议:** ${inferPriorityFromText(response)}`,
    `**类型:** ${inferIssueTypeFromText(response)}`,
    `**维护者下一步动作:** ${inferMaintainerActionFromText(response)}`,
    '',
    '### 完整性',
    '- 问题陈述: 未在模型非契约输出中提供',
    '- 复现步骤: 未在模型非契约输出中提供',
    '- 预期与实际: 未在模型非契约输出中提供',
    '- 环境信息: 未在模型非契约输出中提供',
    '- 支撑证据: 未在模型非契约输出中提供',
    '',
    '### 清晰度',
    '- 标题质量: 未在模型非契约输出中提供',
    '- 单一关注点: 未在模型非契约输出中提供',
    '- 表达精确度: 未在模型非契约输出中提供',
    '- 范围: 未在模型非契约输出中提供',
    '',
    '### 可执行性',
    '- 是否可开始: 未在模型非契约输出中提供',
    '- 验收标准: 未在模型非契约输出中提供',
    '- 依赖: 未在模型非契约输出中提供',
    '',
    '### 建议',
    `- ${extractSummaryLine(response)}`,
    '',
    '### 总结',
    extractSummaryLine(response),
  ].join('\n');
}

function mapRiskLevel(value, findings = []) {
  const normalized = normalizeToken(value);
  if (['LOW', '低'].includes(normalized)) return '低';
  if (['MEDIUM', '中', '中等'].includes(normalized)) return '中';
  if (['HIGH', '高'].includes(normalized)) return '高';
  if (['CRITICAL', '致命'].includes(normalized)) return '致命';
  const severities = findings.map((finding) => normalizeFinding(finding).severity);
  if (severities.includes('致命')) return '致命';
  if (severities.includes('高')) return '高';
  if (severities.includes('中')) return '中';
  return '中';
}

function mapRecommendationLabel(value, findings) {
  const text = String(value || '').toLowerCase();
  const normalized = normalizeToken(value);
  if (hasNegatedApproval(text)) return '请求修改';
  if (normalized === 'REQUEST_CHANGES' || /request[_ -]?changes|请求修改|block|blocking|must fix/.test(text)) return '请求修改';
  if (normalized === 'NEEDS_HUMAN' || /needs[_ -]?human|human|人工/.test(text)) return '需要人工判断';
  if (normalized === 'APPROVE' || /approve|批准|可以合并/.test(text)) return '批准';
  if (normalized === 'COMMENT' || /comment|评论/.test(text)) return '评论';
  const severities = findings.map((finding) => normalizeFinding(finding).severity);
  if (severities.includes('致命') || severities.includes('高')) return '请求修改';
  return findings.length > 0 ? '评论' : '评论';
}

function normalizeToken(value) {
  return String(value || '').trim().replace(/[\s-]+/g, '_').toUpperCase();
}

function formatQualityScore(value) {
  if (typeof value === 'number') return `${Math.min(Math.max(Math.round(value), 1), 5)}/5`;
  const text = String(value || '').trim();
  const score = text.match(/[1-5](?:\s*\/\s*5)?/);
  return score ? score[0].replace(/\s+/g, '') : '3/5';
}

function formatPriority(value) {
  const text = String(value || '').trim();
  if (/P0|致命/i.test(text)) return 'P0-致命';
  if (/P1|高/i.test(text)) return 'P1-高';
  if (/P3|低/i.test(text)) return 'P3-低';
  return 'P2-中';
}

function formatIssueType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/bug|defect|缺陷|错误|故障/.test(text)) return '缺陷报告';
  if (/feature|enhancement|功能|需求/.test(text)) return '功能请求';
  if (/question|问题|咨询/.test(text)) return '问题咨询';
  return '讨论';
}

function formatMaintainerAction(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/ready|start|可以开始|可开始/.test(text)) return '可以开始';
  if (/ask|reporter|询问|补充/.test(text)) return '询问报告者';
  if (/repro|复现/.test(text)) return '需要复现';
  if (/triage|分诊|decision|决策/.test(text)) return '需要分诊决策';
  return '需要分诊决策';
}

function formatSuggestions(value) {
  const suggestions = Array.isArray(value) ? value : [value].filter(Boolean);
  if (suggestions.length === 0) return '- 根据总结补充维护者下一步需要的信息。';
  return suggestions.map((item) => `- ${toSingleLine(item)}`).join('\n');
}

function inferRiskLevelFromText(text, findings = []) {
  if (/致命|critical/i.test(text)) return '致命';
  if (/高风险|严重|high/i.test(text)) return '高';
  if (/低风险|low/i.test(text)) return '低';
  return mapRiskLevel('', findings);
}

function inferRecommendationFromText(text, findings = []) {
  if (hasNegatedApproval(text)) return '请求修改';
  if (/请求修改|需要修改|修改后再合并|不能合并|request[_ -]?changes/i.test(text)) return '请求修改';
  if (/需要人工判断|人工判断|needs[_ -]?human/i.test(text)) return '需要人工判断';
  if (/批准|可以合并|approve/i.test(text)) return '批准';
  return mapRecommendationLabel('', findings);
}

function inferQualityScoreFromText(text) {
  if (/不能判断|无法判断|缺少|需要更多上下文|请.*提供|请.*贴/.test(text)) return '2/5';
  if (/可以开始|ready|可执行/.test(text)) return '4/5';
  return '3/5';
}

function inferPriorityFromText(text) {
  if (/P0|致命|critical/i.test(text)) return 'P0-致命';
  if (/P1|高|500|大量|用户反馈/.test(text)) return 'P1-高';
  if (/P3|低/.test(text)) return 'P3-低';
  return 'P2-中';
}

function inferIssueTypeFromText(text) {
  if (/feature|enhancement|功能|需求|实现/i.test(text)) return '功能请求';
  if (/500|bug|缺陷|错误|故障|复现|日志/i.test(text)) return '缺陷报告';
  if (/question|咨询|问题/.test(text)) return '问题咨询';
  return '讨论';
}

function inferMaintainerActionFromText(text) {
  if (/可以开始|ready|可执行/.test(text)) return '可以开始';
  if (/复现|日志|stack trace|请.*提供|请.*贴|需要更多上下文/.test(text)) return '询问报告者';
  return '需要分诊决策';
}

function extractSummaryLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .find((item) => item && !/^```/.test(item));
  return toSingleLine(line || '模型未按输出契约返回，已归一化为 Repo Guard Markdown 契约。');
}

function formatOriginalResponseFinding(response) {
  return [
    '1. **[中] 模型输出未遵循 Repo Guard 契约**',
    `   - 证据: ${extractSummaryLine(response)}`,
    '   - 受影响调用方/流程: GitHub 评论展示与后续解析',
    '   - 最小可行修复: 已在发布前归一化为固定 Markdown 契约；仍建议优化提示让模型直接遵循契约。',
  ].join('\n');
}

function extractLooseInlineFindings(response) {
  const lines = String(response || '').split(/\r?\n/);
  const findings = [];
  const pattern = /^\s*[-*]?\s*(?:\*\*)?`?([\w./-]+):(\d+)`?(?:\*\*)?\s*(.*)$/;
  const bracketPattern = /^\s*[-*]?\s*(?:\*\*)?\[([\w./-]+):(\d+)\](?:\*\*)?\s*(.*)$/;

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(bracketPattern) || lines[index].match(pattern);
    if (!match) continue;

    const [, path, line, sameLineBody] = match;
    const following = sameLineBody.trim() || (lines[index + 1] || '').trim();
    findings.push({
      path,
      line: Number.parseInt(line, 10),
      body: following.replace(/^[-*]\s*/, '').replace(/^`|`$/g, '') || '模型指出该行存在问题。',
    });
  }

  return findings;
}

function hasNegatedApproval(text) {
  return /do\s+not\s+approve|not\s+approved|cannot\s+approve|can't\s+approve|don'?t\s+approve|不要批准|不应批准|不能批准|不可批准/i.test(text);
}

function formatFindings(findings) {
  if (findings.length === 0) return '未发现 blocking findings。';

  return findings.map((finding, index) => {
    const normalized = normalizeFinding(finding);
    return [
      `${index + 1}. **[${normalized.severity}] ${normalized.title}**`,
      `   - 证据: ${normalized.evidence}`,
      `   - 受影响调用方/流程: ${normalized.impact}`,
      `   - 最小可行修复: ${normalized.fix}`,
    ].join('\n');
  }).join('\n');
}

function formatInlineFindings(findings) {
  const lines = findings
    .map(normalizeFinding)
    .filter((finding) => finding.path && finding.line)
    .map((finding) => `- [${finding.path}:${finding.line}] ${finding.body}`);

  return lines.length > 0 ? lines.join('\n') : '- 无明确变更行归属。';
}

function normalizeFinding(finding) {
  if (typeof finding === 'string') {
    return {
      severity: '中',
      title: toSingleLine(finding),
      evidence: '模型 JSON 未提供具体证据',
      impact: 'unknown',
      fix: '根据上述发现补充最小修复',
      body: toSingleLine(finding),
    };
  }

  const value = finding && typeof finding === 'object' ? finding : {};
  const title = toSingleLine(value.title || value.summary || value.issue || value.message || value['标题'] || value['问题'] || '未命名发现');
  return {
    severity: mapSeverity(value.severity || value.risk || value.level || value['严重性']),
    title,
    evidence: toSingleLine(value.evidence || value.location || value.path || value.file || value['文件'] || '模型 JSON 未提供具体证据'),
    impact: toSingleLine(value.impact || value.affected_flows || value.affected || value['影响'] || 'unknown'),
    fix: toSingleLine(value.fix || value.recommendation || value.suggestion || value['建议'] || '根据上述发现补充最小修复'),
    path: value.path || value.file || value['文件'],
    line: Number.isInteger(value.line || value['行号']) ? (value.line || value['行号']) : Number.parseInt(value.line || value['行号'], 10),
    body: toSingleLine(value.body || value.comment || value.description || value['问题'] || title),
  };
}

function mapSeverity(value) {
  const normalized = normalizeToken(value);
  if (['LOW', '低'].includes(normalized)) return '低';
  if (['MEDIUM', '中', '中等'].includes(normalized)) return '中';
  if (['HIGH', '高'].includes(normalized)) return '高';
  if (['CRITICAL', '致命'].includes(normalized)) return '致命';
  return '中';
}

function toSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

export function extractInlineComments(response, files) {
  const pattern = /\[([^\]]+):(\d+)\]\s*(.+)/g;
  const comments = [];
  const validPaths = new Set(files.map((f) => f.filename));
  let match;

  while ((match = pattern.exec(response)) !== null) {
    const [, path, line, body] = match;
    if (validPaths.has(path)) {
      comments.push({ path, line: parseInt(line, 10), body });
    }
  }

  return comments;
}
