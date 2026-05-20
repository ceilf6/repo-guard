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
  const match = response.match(/\*\*Recommendation:\*\*\s*(APPROVE|COMMENT|REQUEST_CHANGES|NEEDS_HUMAN)/i);
  return match ? match[1].toUpperCase() : 'COMMENT';
}

export function mapRecommendationToEvent(recommendation) {
  switch (recommendation) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    default: return 'COMMENT';
  }
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
