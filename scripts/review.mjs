// @ts-check
import { chatCompletion } from './llm-client.mjs';
import { fetchPRInfo, fetchPRDiff, fetchIssue, postComment, postPRReview } from './github-api.mjs';
import { loadSystemPrompt, buildPRUserMessage, buildIssueUserMessage } from './prompts.mjs';

const env = process.env;

const TRIGGER_PATTERNS = [/@repo-guard/i, /\/review/i];

const config = {
  type: env.REVIEW_TYPE || 'both',
  provider: env.LLM_PROVIDER || 'openai',
  model: env.LLM_MODEL || 'gpt-4o',
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL || '',
  maxTokens: parseInt(env.LLM_MAX_TOKENS || '4096', 10),
  githubToken: env.GITHUB_TOKEN,
  language: env.REVIEW_LANGUAGE || 'en',
  extraInstructions: env.EXTRA_INSTRUCTIONS || '',
  prNumber: env.PR_NUMBER,
  issueNumber: env.ISSUE_NUMBER,
  repo: env.REPO_FULL_NAME,
  eventAction: env.EVENT_ACTION,
  eventName: env.EVENT_NAME,
  commentBody: env.COMMENT_BODY || '',
  commentUser: env.COMMENT_USER || '',
  isPullRequest: env.IS_PULL_REQUEST === 'true',
};

async function main() {
  if (!config.apiKey) {
    console.error('Error: LLM_API_KEY is required');
    process.exit(1);
  }
  if (!config.githubToken) {
    console.error('Error: GITHUB_TOKEN is required');
    process.exit(1);
  }

  // For comment-triggered events, check if the comment matches trigger patterns
  if (config.eventName === 'issue_comment') {
    if (!isTriggeredByComment()) {
      console.log('Comment does not contain trigger keyword. Skipping.');
      return;
    }
    // Prevent infinite loop: skip if comment is from the bot itself
    if (config.commentBody.includes('<!-- repo-guard:v1 -->')) {
      console.log('Ignoring bot\'s own comment. Skipping.');
      return;
    }
  }

  const reviewType = resolveReviewType();
  if (!reviewType) {
    console.log('No matching event for review. Skipping.');
    return;
  }

  console.log(`Running ${reviewType} review on ${config.repo}...`);
  console.log(`Provider: ${config.provider}, Model: ${config.model}`);

  if (reviewType === 'pr') {
    await reviewPR();
  } else {
    await reviewIssue();
  }

  console.log('Review complete.');
}

function resolveReviewType() {
  if (config.type === 'pr') return config.prNumber ? 'pr' : null;
  if (config.type === 'issue') return config.issueNumber ? 'issue' : null;
  // type === 'both': auto-detect from event
  if (config.eventName === 'pull_request' && config.prNumber) return 'pr';
  if (config.eventName === 'issues' && config.issueNumber) return 'issue';
  // issue_comment: determine if it's on a PR or issue
  if (config.eventName === 'issue_comment') {
    if (config.isPullRequest && config.issueNumber) return 'pr';
    if (config.issueNumber) return 'issue';
  }
  // Fallback: check which number is available
  if (config.prNumber) return 'pr';
  if (config.issueNumber) return 'issue';
  return null;
}

function isTriggeredByComment() {
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(config.commentBody));
}

function extractUserPrompt() {
  const cleaned = config.commentBody
    .replace(/@repo-guard/gi, '')
    .replace(/\/review/gi, '')
    .trim();
  return cleaned || '';
}

async function reviewPR() {
  const prNumber = parseInt(config.prNumber, 10);
  console.log(`Fetching PR #${prNumber}...`);

  const [prInfo, files] = await Promise.all([
    fetchPRInfo(config.repo, prNumber, config.githubToken),
    fetchPRDiff(config.repo, prNumber, config.githubToken),
  ]);

  const userPrompt = extractUserPrompt();
  const extra = [config.extraInstructions, userPrompt].filter(Boolean).join('\n');
  const systemPrompt = loadSystemPrompt('pr', config.language, extra);
  const userMessage = buildPRUserMessage(prInfo, files);

  const messages = [{ role: 'user', content: userMessage }];
  if (userPrompt) {
    messages.push({ role: 'user', content: `User request: ${userPrompt}` });
  }

  console.log(`Calling LLM (${files.length} files, ${prInfo.additions + prInfo.deletions} lines changed)...`);

  const response = await chatCompletion({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
    system: systemPrompt,
    messages,
  });

  const recommendation = extractRecommendation(response);
  const event = mapRecommendationToEvent(recommendation);
  const inlineComments = extractInlineComments(response, files);

  console.log(`Recommendation: ${recommendation} → GitHub event: ${event}`);
  console.log(`Inline comments: ${inlineComments.length}`);

  try {
    await postPRReview(config.repo, prNumber, response, event, inlineComments, config.githubToken);
  } catch (err) {
    // If review with inline comments fails, fall back to simple comment
    console.warn(`PR review post failed (${err.message}), falling back to comment...`);
    await postComment(config.repo, prNumber, response, config.githubToken);
  }
}

async function reviewIssue() {
  const issueNumber = parseInt(config.issueNumber, 10);
  console.log(`Fetching Issue #${issueNumber}...`);

  const issue = await fetchIssue(config.repo, issueNumber, config.githubToken);
  const userPrompt = extractUserPrompt();
  const extra = [config.extraInstructions, userPrompt].filter(Boolean).join('\n');
  const systemPrompt = loadSystemPrompt('issue', config.language, extra);
  const userMessage = buildIssueUserMessage(issue);

  const messages = [{ role: 'user', content: userMessage }];
  if (userPrompt) {
    messages.push({ role: 'user', content: `User request: ${userPrompt}` });
  }

  console.log('Calling LLM...');

  const response = await chatCompletion({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
    system: systemPrompt,
    messages,
  });

  await postComment(config.repo, issueNumber, response, config.githubToken);
}

function extractRecommendation(response) {
  const match = response.match(/\*\*Recommendation:\*\*\s*(APPROVE|COMMENT|REQUEST_CHANGES|NEEDS_HUMAN)/i);
  return match ? match[1].toUpperCase() : 'COMMENT';
}

function mapRecommendationToEvent(recommendation) {
  switch (recommendation) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    default: return 'COMMENT';
  }
}

function extractInlineComments(response, files) {
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

main().catch((err) => {
  console.error('Review bot error:', err.message);
  process.exit(1);
});
