import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRecommendation,
  extractUserPrompt,
  getReviewNumber,
  isTriggeredByComment,
  mapRecommendationToEvent,
  resolveReviewType,
} from '../scripts/review-logic.mjs';

test('issue_comment on a pull request resolves to PR review and uses issue number', () => {
  const config = {
    type: 'both',
    prNumber: '',
    issueNumber: '42',
    eventName: 'issue_comment',
    isPullRequest: true,
  };

  assert.equal(resolveReviewType(config), 'pr');
  assert.equal(getReviewNumber(config, 'pr'), 42);
});

test('issue_comment on a normal issue resolves to issue review', () => {
  const config = {
    type: 'both',
    prNumber: '',
    issueNumber: '43',
    eventName: 'issue_comment',
    isPullRequest: false,
  };

  assert.equal(resolveReviewType(config), 'issue');
  assert.equal(getReviewNumber(config, 'issue'), 43);
});

test('explicit PR review also supports PR issue comments', () => {
  const config = {
    type: 'pr',
    prNumber: '',
    issueNumber: '44',
    eventName: 'issue_comment',
    isPullRequest: true,
  };

  assert.equal(resolveReviewType(config), 'pr');
  assert.equal(getReviewNumber(config, 'pr'), 44);
});

test('missing PR number throws a clear error', () => {
  const config = {
    type: 'pr',
    prNumber: '',
    issueNumber: '',
    eventName: 'pull_request',
    isPullRequest: false,
  };

  assert.equal(resolveReviewType(config), null);
  assert.throws(() => getReviewNumber(config, 'pr'), /PR number must be a positive integer/);
});

test('comment trigger and user prompt extraction remove trigger words', () => {
  assert.equal(isTriggeredByComment('@repo-guard please focus on auth'), true);
  assert.equal(isTriggeredByComment('ordinary comment'), false);
  assert.equal(extractUserPrompt('/review please focus on auth'), 'please focus on auth');
  assert.equal(extractUserPrompt('@repo-guard'), '');
});

test('recommendation mapping supports blocking and non-blocking outcomes', () => {
  assert.equal(extractRecommendation('**处理建议:** 请求修改'), 'REQUEST_CHANGES');
  assert.equal(extractRecommendation('**处理建议:** 批准'), 'APPROVE');
  assert.equal(extractRecommendation('**处理建议:** 需要人工判断'), 'NEEDS_HUMAN');
  assert.equal(extractRecommendation('no explicit marker'), 'COMMENT');
  assert.equal(mapRecommendationToEvent('APPROVE'), 'APPROVE');
  assert.equal(mapRecommendationToEvent('REQUEST_CHANGES'), 'REQUEST_CHANGES');
  assert.equal(mapRecommendationToEvent('NEEDS_HUMAN'), 'COMMENT');
});
