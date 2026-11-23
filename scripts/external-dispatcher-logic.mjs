// @ts-check
import { isRepoGuardPublishedComment } from './review-logic.mjs';
import { isLocalCliEngine, parseLLMConnectionEnv } from './review-engine.mjs';

export const DEFAULT_EXTERNAL_TRIGGER = '@ceilf6/repo-guard';
export const DEFAULT_EXTERNAL_ACTOR = 'ceilf6';

export function buildExternalDispatcherConfig(env) {
  return {
    ...parseLLMConnectionEnv(env),
    githubToken: env.CEILF6_GITHUB_TOKEN,
    // External repository code is never checked out, so local CLI engines always
    // run prompt-only from an empty scratch directory.
    workspace: '',
    trigger: env.EXTERNAL_REPO_GUARD_TRIGGER || DEFAULT_EXTERNAL_TRIGGER,
    actor: env.EXTERNAL_REPO_GUARD_TRIGGER_ACTOR || DEFAULT_EXTERNAL_ACTOR,
    maxReviews: parseMaxReviews(env.EXTERNAL_REPO_GUARD_MAX_REVIEWS, 3),
    searchLimit: parseMaxReviews(env.EXTERNAL_REPO_GUARD_SEARCH_LIMIT, 20, 'EXTERNAL_REPO_GUARD_SEARCH_LIMIT'),
    searchQuery: env.EXTERNAL_REPO_GUARD_SEARCH_QUERY || `"${DEFAULT_EXTERNAL_TRIGGER}" is:pr is:open is:public`,
    dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN || ''),
  };
}

export function validateExternalDispatcherConfig(config) {
  const errors = [];
  if (!config.githubToken) {
    errors.push('CEILF6_GITHUB_TOKEN is required');
  }
  if (!config.dryRun && !isLocalCliEngine(config.engine) && !config.apiKey) {
    errors.push('LLM_API_KEY is required unless DRY_RUN=true or engine is claude-code or agy');
  }
  return errors;
}

export function externalMarker(commentId) {
  return `<!-- repo-guard external trigger:${commentId} -->`;
}

export function hasExternalMarker(comments, commentId) {
  const marker = externalMarker(commentId);
  return (comments || []).some((comment) => String(comment?.body || '').includes(marker));
}

export function extractExternalUserPrompt(commentBody = '', trigger = DEFAULT_EXTERNAL_TRIGGER) {
  return String(commentBody || '')
    .replace(new RegExp(escapeRegExp(trigger), 'gi'), '')
    .trim();
}

export function isExternalTriggerComment(comment, options = {}) {
  const actor = options.actor || DEFAULT_EXTERNAL_ACTOR;
  const trigger = options.trigger || DEFAULT_EXTERNAL_TRIGGER;
  const body = String(comment?.body || '');

  if (comment?.user?.login !== actor) return false;
  if (isRepoGuardPublishedComment(body)) return false;
  return new RegExp(escapeRegExp(trigger), 'i').test(body);
}

export function selectUnprocessedTrigger(comments, options = {}) {
  const sortedTriggers = [...(comments || [])]
    .filter((comment) => isExternalTriggerComment(comment, options))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  for (const trigger of sortedTriggers) {
    if (!hasExternalMarker(comments, trigger.id)) return trigger;
  }

  return null;
}

export function candidateFromSearchItem(item) {
  if (!item?.pull_request) return null;

  const repo = repoFromRepositoryURL(item.repository_url);
  const number = Number(item.number);
  if (!repo || !Number.isInteger(number) || number <= 0) return null;

  return {
    repo,
    number,
    state: item.state || '',
    htmlUrl: item.html_url || '',
  };
}

export function parseMaxReviews(value, fallback, name = 'EXTERNAL_REPO_GUARD_MAX_REVIEWS') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function repoFromRepositoryURL(repositoryURL) {
  try {
    const url = new URL(String(repositoryURL || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'repos') return '';
    return `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}`;
  } catch {
    return '';
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
