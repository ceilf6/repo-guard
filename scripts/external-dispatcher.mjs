// @ts-check
import { listIssueComments, postComment, searchIssuesAndPullRequests } from './github-api.mjs';
import { buildPRReview } from './pr-reviewer.mjs';
import {
  buildExternalDispatcherConfig,
  candidateFromSearchItem,
  externalMarker,
  extractExternalUserPrompt,
  selectUnprocessedTrigger,
  validateExternalDispatcherConfig,
} from './external-dispatcher-logic.mjs';

const config = buildExternalDispatcherConfig(process.env);

async function main() {
  const configErrors = validateExternalDispatcherConfig(config);
  if (configErrors.length > 0) {
    throw new Error(configErrors.join('; '));
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
        engine: config.engine,
        provider: config.provider,
        model: config.model,
        claudeModel: config.claudeModel,
        agyModel: config.agyModel,
        workspace: config.workspace,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        structuredOutput: config.structuredOutput,
        providerOrder: config.providerOrder,
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
