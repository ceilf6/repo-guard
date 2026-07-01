import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFromSearchItem,
  externalMarker,
  extractExternalUserPrompt,
  hasExternalMarker,
  isExternalTriggerComment,
  parseMaxReviews,
  selectUnprocessedTrigger,
} from '../scripts/external-dispatcher-logic.mjs';

test('external markers are stable and detectable in prior comments', () => {
  assert.equal(externalMarker(12345), '<!-- repo-guard external trigger:12345 -->');
  assert.equal(hasExternalMarker([{ body: 'before\n<!-- repo-guard external trigger:12345 -->\nafter' }], 12345), true);
  assert.equal(hasExternalMarker([{ body: '<!-- repo-guard external trigger:999 -->' }], 12345), false);
});

test('candidateFromSearchItem extracts public PR repository and number', () => {
  assert.deepEqual(candidateFromSearchItem({
    number: 77,
    state: 'open',
    html_url: 'https://github.com/owner/repo/pull/77',
    repository_url: 'https://api.github.com/repos/owner/repo',
    pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/77' },
  }), {
    repo: 'owner/repo',
    number: 77,
    state: 'open',
    htmlUrl: 'https://github.com/owner/repo/pull/77',
  });

  assert.equal(candidateFromSearchItem({
    number: 7,
    repository_url: 'https://api.github.com/repos/owner/repo',
  }), null);
});

test('trigger comments must contain the trigger and be authored by the configured actor', () => {
  assert.equal(isExternalTriggerComment({
    body: '@ceilf6/repo-guard focus on auth',
    user: { login: 'ceilf6' },
  }, { actor: 'ceilf6' }), true);
  assert.equal(isExternalTriggerComment({
    body: '@ceilf6/repo-guard focus on auth',
    user: { login: 'someone-else' },
  }, { actor: 'ceilf6' }), false);
  assert.equal(isExternalTriggerComment({
    body: '> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\nold output',
    user: { login: 'ceilf6' },
  }, { actor: 'ceilf6' }), false);
});

test('selectUnprocessedTrigger chooses the newest unprocessed actor-authored trigger', () => {
  const comments = [
    { id: 1, body: '@ceilf6/repo-guard from stranger', user: { login: 'stranger' } },
    { id: 2, body: '@ceilf6/repo-guard already handled', user: { login: 'ceilf6' } },
    { id: 3, body: '<!-- repo-guard external trigger:2 -->\n\nhandled output', user: { login: 'ceilf6' } },
    { id: 4, body: 'ordinary comment', user: { login: 'ceilf6' } },
    { id: 5, body: '@ceilf6/repo-guard focus on cache invalidation', user: { login: 'ceilf6' } },
  ];

  const trigger = selectUnprocessedTrigger(comments, { actor: 'ceilf6' });

  assert.equal(trigger.id, 5);
  assert.equal(extractExternalUserPrompt(trigger.body), 'focus on cache invalidation');
});

test('selectUnprocessedTrigger returns null when all actor triggers were handled', () => {
  const comments = [
    { id: 10, body: '@ceilf6/repo-guard please review', user: { login: 'ceilf6' } },
    { id: 11, body: '<!-- repo-guard external trigger:10 -->\n\nhandled output', user: { login: 'ceilf6' } },
  ];

  assert.equal(selectUnprocessedTrigger(comments, { actor: 'ceilf6' }), null);
});

test('parseMaxReviews applies defaults and rejects invalid limits', () => {
  assert.equal(parseMaxReviews('', 3), 3);
  assert.equal(parseMaxReviews(undefined, 3), 3);
  assert.equal(parseMaxReviews('2', 3), 2);
  assert.throws(() => parseMaxReviews('0', 3), /positive integer/);
  assert.throws(() => parseMaxReviews('1.5', 3), /positive integer/);
});
