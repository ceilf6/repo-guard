// @ts-check
import { chatCompletion } from './llm-client.mjs';
import { fetchIssue, postComment, postPRReview } from './github-api.mjs';
import { loadSystemPrompt, buildIssueUserMessage } from './prompts.mjs';
import { buildPRReview } from './pr-reviewer.mjs';
import {
  extractUserPrompt,
  getReviewNumber,
  isRepoGuardPublishedComment,
  isTriggeredByComment,
  normalizeReviewResponse,
  resolveReviewType,
  stripThinkingBlocks,
} from './review-logic.mjs';

const env = process.env;

const config = {
  type: env.REVIEW_TYPE || 'both',
  provider: env.LLM_PROVIDER || 'openai',
  model: env.LLM_MODEL || 'gpt-4o',
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL || '',
  maxTokens: parseInt(env.LLM_MAX_TOKENS || '4096', 10),
  githubToken: env.GITHUB_TOKEN,
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

  // Comment-triggered events only run when the comment explicitly asks for review.
  if (config.eventName === 'issue_comment') {
    if (!isTriggeredByComment(config.commentBody)) {
      console.log('评论未包含触发关键词，跳过。');
      return;
    }
    // Prevent feedback loops from comments posted by this action.
    if (isRepoGuardPublishedComment(config.commentBody)) {
      console.log('忽略机器人自己的评论，跳过。');
      return;
    }
  }

  const reviewType = resolveReviewType(config);
  if (!reviewType) {
    console.log('未匹配到需要评审的事件，跳过。');
    return;
  }

  console.log(`在 ${config.repo} 上运行 ${reviewType} 评审...`);
  console.log(`供应商: ${config.provider}, 模型: ${config.model}`);

  if (reviewType === 'pr') {
    await reviewPR(getReviewNumber(config, 'pr'));
  } else {
    await reviewIssue(getReviewNumber(config, 'issue'));
  }

  console.log('评审完成。');
}

async function reviewPR(prNumber) {
  console.log(`获取 PR #${prNumber}...`);

  const userPrompt = extractUserPrompt(config.commentBody);
  const review = await buildPRReview({
    repo: config.repo,
    prNumber,
    githubToken: config.githubToken,
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
    extraInstructions: config.extraInstructions,
    userPrompt,
  });

  console.log(`评审上下文: ${review.files.length} 个文件，${review.prInfo.additions + review.prInfo.deletions} 行变更，${review.linkedIssueContext.issues.length} 个关联 Issue`);
  console.log(`处理建议: ${review.recommendation} → GitHub 评审事件: ${review.event}`);
  console.log(`行级评论数: ${review.inlineComments.length}`);

  try {
    await postPRReview(config.repo, prNumber, review.response, review.event, review.inlineComments, config.githubToken);
  } catch (err) {
    // If inline review posting fails, keep the review body by falling back to a plain comment.
    console.warn(`PR 评审发布失败（${err.message}），降级为普通评论...`);
    await postComment(config.repo, prNumber, review.response, config.githubToken);
  }
}

async function reviewIssue(issueNumber) {
  console.log(`获取 Issue #${issueNumber}...`);

  const issue = await fetchIssue(config.repo, issueNumber, config.githubToken);
  const userPrompt = extractUserPrompt(config.commentBody);
  const extra = [config.extraInstructions, userPrompt].filter(Boolean).join('\n');
  const systemPrompt = loadSystemPrompt('issue', extra);
  const userMessage = buildIssueUserMessage(issue);

  const messages = [{ role: 'user', content: userMessage }];
  if (userPrompt) {
    messages.push({ role: 'user', content: `用户请求: ${userPrompt}` });
  }

  console.log('调用 LLM...');

  const rawResponse = await chatCompletion({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
    system: systemPrompt,
    messages,
  });
  const response = normalizeReviewResponse(stripThinkingBlocks(rawResponse), { type: 'issue', title: issue.title });

  await postComment(config.repo, issueNumber, response, config.githubToken);
}

main().catch((err) => {
  console.error('评审机器人错误:', err.message);
  process.exit(1);
});
