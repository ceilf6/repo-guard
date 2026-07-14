// @ts-check
import { chatCompletion } from './llm-client.mjs';
import { fetchPRInfo, fetchPRDiff, fetchPRLinkedIssues } from './github-api.mjs';
import { loadSystemPrompt, buildPRUserMessage } from './prompts.mjs';
import { PR_REVIEW_RESPONSE_FORMAT } from './review-contracts.mjs';
import {
  extractInlineComments,
  extractRecommendation,
  mapRecommendationToEvent,
  normalizeReviewResponse,
  stripThinkingBlocks,
} from './review-logic.mjs';

export async function buildPRReview(config) {
  const [prInfo, files] = await Promise.all([
    fetchPRInfo(config.repo, config.prNumber, config.githubToken),
    fetchPRDiff(config.repo, config.prNumber, config.githubToken),
  ]);
  const linkedIssueContext = await fetchPRLinkedIssues(config.repo, config.prNumber, prInfo, config.githubToken);

  const extra = [config.extraInstructions, config.userPrompt].filter(Boolean).join('\n');
  const systemPrompt = loadSystemPrompt('pr', extra);
  const userMessage = buildPRUserMessage(prInfo, files, linkedIssueContext);

  const messages = [{ role: 'user', content: userMessage }];
  if (config.userPrompt) {
    messages.push({ role: 'user', content: `用户请求: ${config.userPrompt}` });
  }

  const rawResponse = await chatCompletion({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    structuredOutputMode: config.structuredOutput,
    responseFormat: PR_REVIEW_RESPONSE_FORMAT,
    system: systemPrompt,
    messages,
  });
  const response = normalizeReviewResponse(stripThinkingBlocks(rawResponse), { type: 'pr', title: prInfo.title });

  const recommendation = extractRecommendation(response);
  const event = mapRecommendationToEvent(recommendation);
  const inlineComments = extractInlineComments(response, files);

  return {
    response,
    recommendation,
    event,
    inlineComments,
    prInfo,
    files,
    linkedIssueContext,
  };
}
