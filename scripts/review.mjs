// @ts-check
import { chatCompletion } from './llm-client.mjs';
import { fetchPRInfo, fetchPRDiff, fetchBotLogin, fetchLastReviewForUser, fetchCompareDiff, fetchIssue, postComment, postPRReview } from './github-api.mjs';
import { loadSystemPrompt, buildPRUserMessage, buildIssueUserMessage } from './prompts.mjs';
import {
  extractInlineComments,
  extractRecommendation,
  extractUserPrompt,
  getReviewNumber,
  isTriggeredByComment,
  mapRecommendationToEvent,
  resolveReviewType,
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
    if (config.commentBody.includes('ceilf6/repo-guard')) {
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

function shouldUseIncrementalDiff() {
  return config.eventName === 'pull_request' && config.eventAction === 'synchronize';
}

async function reviewPR(prNumber) {
  console.log(`获取 PR #${prNumber}...`);

  const prInfo = await fetchPRInfo(config.repo, prNumber, config.githubToken);
  let files;
  let incrementalUsed = false;

  if (shouldUseIncrementalDiff()) {
    try {
      const botLogin = await fetchBotLogin(config.githubToken);
      const lastReviewSha = await fetchLastReviewForUser(config.repo, prNumber, botLogin, config.githubToken);
      if (lastReviewSha) {
        const compareFiles = await fetchCompareDiff(config.repo, lastReviewSha, prInfo.headSha, config.githubToken);
        if (compareFiles && compareFiles.length > 0) {
          files = compareFiles;
          incrementalUsed = true;
        } else if (compareFiles && compareFiles.length === 0) {
          console.log('增量差异：自上次评审以来无新变更，跳过。');
          return;
        }
      }
    } catch (err) {
      console.warn(`增量差异获取失败（${err.message}），降级为全量差异。`);
    }
  }

  if (!files) {
    files = await fetchPRDiff(config.repo, prNumber, config.githubToken);
  }

  const deltaStats = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  console.log(`差异模式: ${incrementalUsed ? '增量' : '全量'}（${files.length} 个文件，${deltaStats} 行变更）`);

  const userPrompt = extractUserPrompt(config.commentBody);
  const extra = [config.extraInstructions, userPrompt].filter(Boolean).join('\n');
  const systemPrompt = loadSystemPrompt('pr', extra);
  const userMessage = buildPRUserMessage(prInfo, files);

  const messages = [{ role: 'user', content: userMessage }];
  if (userPrompt) {
    messages.push({ role: 'user', content: `用户请求: ${userPrompt}` });
  }

  console.log(`调用 LLM（${files.length} 个文件，${deltaStats} 行变更）...`);

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

  console.log(`处理建议: ${recommendation} → GitHub 评审事件: ${event}`);
  console.log(`行级评论数: ${inlineComments.length}`);

  try {
    await postPRReview(config.repo, prNumber, response, event, inlineComments, config.githubToken);
  } catch (err) {
    // If inline review posting fails, keep the review body by falling back to a plain comment.
    console.warn(`PR 评审发布失败（${err.message}），降级为普通评论...`);
    await postComment(config.repo, prNumber, response, config.githubToken);
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

main().catch((err) => {
  console.error('评审机器人错误:', err.message);
  process.exit(1);
});
