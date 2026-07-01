// @ts-check
import { isRepoGuardPublishedComment } from './review-logic.mjs';

export const DEFAULT_EXTERNAL_TRIGGER = '@ceilf6/repo-guard';
export const DEFAULT_EXTERNAL_ACTOR = 'ceilf6';

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
