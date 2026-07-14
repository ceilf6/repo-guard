// @ts-check
import { listIssueComments, postComment, searchIssuesAndPullRequests } from './github-api.mjs';
import { parseStructuredOutputMode } from './openrouter-structured-output.mjs';
import { buildPRReview } from './pr-reviewer.mjs';
import {
  DEFAULT_EXTERNAL_ACTOR,
  DEFAULT_EXTERNAL_TRIGGER,
  candidateFromSearchItem,
  externalMarker,
  extractExternalUserPrompt,
  parseMaxReviews,
  selectUnprocessedTrigger,
} from './external-dispatcher-logic.mjs';

const env = process.env;

const config = {
  githubToken: env.CEILF6_GITHUB_TOKEN,
  provider: env.LLM_PROVIDER || 'openai',
  model: env.LLM_MODEL || 'gpt-4o',
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL || '',
  structuredOutput: parseStructuredOutputMode(env.LLM_STRUCTURED_OUTPUT),
  extraInstructions: env.EXTRA_INSTRUCTIONS || '',
  trigger: env.EXTERNAL_REPO_GUARD_TRIGGER || DEFAULT_EXTERNAL_TRIGGER,
  actor: env.EXTERNAL_REPO_GUARD_TRIGGER_ACTOR || DEFAULT_EXTERNAL_ACTOR,
  maxReviews: parseMaxReviews(env.EXTERNAL_REPO_GUARD_MAX_REVIEWS, 3),
  searchLimit: parseMaxReviews(env.EXTERNAL_REPO_GUARD_SEARCH_LIMIT, 20, 'EXTERNAL_REPO_GUARD_SEARCH_LIMIT'),
  searchQuery: env.EXTERNAL_REPO_GUARD_SEARCH_QUERY || `"${DEFAULT_EXTERNAL_TRIGGER}" is:pr is:open is:public`,
  dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN || ''),
};

async function main() {
  if (!config.githubToken) {
    throw new Error('CEILF6_GITHUB_TOKEN is required');
  }
  if (!config.dryRun && !config.apiKey) {
    throw new Error('LLM_API_KEY is required unless DRY_RUN=true');
  }

  const items = await searchIssuesAndPullRequests(config.searchQuery, config.githubToken, {
    perPage: config.searchLimit,
  });
  const candidates = uniqueCandidates(items.map(candidateFromSearchItem).filter(Boolean));

  console.log(`Found ${candidates.length} candidate PRs for external Repo Guard dispatch.`);

  let reviewed = 0;
  for (const candidate of candidates) {
    if (reviewed >= config.maxReviews) break;
    if (candidate.state && candidate.state !== 'open') continue;

    try {
      const comments = await listIssueComments(candidate.repo, candidate.number, config.githubToken);
      const trigger = selectUnprocessedTrigger(comments, {
        actor: config.actor,
        trigger: config.trigger,
      });
      if (!trigger) continue;

      const userPrompt = extractExternalUserPrompt(trigger.body, config.trigger);
      if (config.dryRun) {
        console.log(`DRY_RUN: would review ${candidate.repo}#${candidate.number} from trigger comment ${trigger.id}.`);
        reviewed++;
        continue;
      }

      console.log(`Reviewing ${candidate.repo}#${candidate.number} from trigger comment ${trigger.id}...`);
      const review = await buildPRReview({
        repo: candidate.repo,
        prNumber: candidate.number,
        githubToken: config.githubToken,
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        structuredOutput: config.structuredOutput,
        extraInstructions: config.extraInstructions,
        userPrompt,
      });

      await postComment(
        candidate.repo,
        candidate.number,
        `${externalMarker(trigger.id)}\n\n${review.response}`,
        config.githubToken,
      );
      console.log(`Posted external Repo Guard comment to ${candidate.repo}#${candidate.number}.`);
      reviewed++;
    } catch (err) {
      console.warn(`Skipping ${candidate.repo}#${candidate.number}: ${err.message}`);
    }
  }

  console.log(`External Repo Guard dispatch processed ${reviewed} trigger(s).`);
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = `${candidate.repo}#${candidate.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

main().catch((err) => {
  console.error('External Repo Guard dispatcher failed:', err.message);
  process.exit(1);
});
