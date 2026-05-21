# Repo Guard Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the first repo-guard hardening batch through four independent GitHub issues and PRs.

**Architecture:** Keep the Action runtime small and ESM-only. Fix the two behavior bugs first, then add a Node built-in test harness that backfills regression coverage, then align README with the implemented trigger and comment policy.

**Tech Stack:** GitHub composite Action, Node ESM (`.mjs`), GitHub REST API, Node built-in `node:test`, GitHub CLI (`gh`).

---

## File Structure

- Modify `scripts/review.mjs`: event routing, PR/issue number parsing, later delegating pure logic to `scripts/review-logic.mjs`.
- Modify `scripts/github-api.mjs`: paginated PR files fetching.
- Modify `scripts/llm-client.mjs`: no runtime change expected; add tests for `normalizeBaseURL`.
- Create `scripts/review-logic.mjs`: pure review routing and response parsing helpers that can be tested without running the bot.
- Create `tests/review-logic.test.mjs`: regression tests for PR comment triggers, prompt extraction, recommendation parsing, and review event mapping.
- Create `tests/github-api.test.mjs`: mocked-fetch tests for PR files pagination.
- Create `tests/llm-client.test.mjs`: provider base URL normalization tests.
- Create `package.json`: local `npm test` and `npm run check` scripts using only Node built-ins.
- Modify `README.md`: document `issue_comment`, permissions, and "always create a fresh comment/review".

## Shared GitHub Workflow

Each task below includes concrete issue, branch, PR, and merge commands. Keep these invariants for all four tasks:

- start from latest `main`;
- create exactly one GitHub issue before editing;
- create one `codex/issue-${ISSUE_NUMBER}-...` branch for that issue;
- keep the branch scoped to the issue;
- validate locally before opening the PR;
- squash-merge the PR, delete the branch, return to `main`, and pull latest before moving on.

- [ ] **Step 1: Confirm the GitHub CLI session**

```bash
gh auth status
```

Expected: the active GitHub account is authenticated and can access `ceilf6/repo-guard`.

- [ ] **Step 2: Confirm local branch state**

```bash
git status --short --branch
```

Expected: the worktree is clean before each task begins.

- [ ] **Step 3: Ensure the batch label exists**

```bash
gh label create repo-guard-hardening --color 1f883d --description "Repo Guard hardening batch" || true
```

Expected: the label exists. If it already exists, `gh` may print an error and the command still exits successfully because of `|| true`.

## Task 1: Fix PR Comment Trigger Number

**Files:**
- Modify: `scripts/review.mjs`

- [ ] **Step 1: Create the issue body**

```bash
cat > /tmp/repo-guard-issue.md <<'EOF'
## Problem

When Repo Guard is triggered from an `issue_comment` on a pull request, GitHub exposes the PR number as `github.event.issue.number`. The current runtime identifies the event as PR review work, but `reviewPR()` reads `PR_NUMBER`, which is only populated for native `pull_request` events.

This can make `/review` on a PR comment request `/pulls/NaN` or skip the intended PR.

## Acceptance Criteria

- Native `pull_request` events still use `PR_NUMBER`.
- `issue_comment` events on pull requests use `ISSUE_NUMBER` as the PR number.
- `issue_comment` events on normal issues still run issue review.
- Missing or invalid PR numbers fail with a clear message instead of requesting `/pulls/NaN`.
EOF
```

- [ ] **Step 2: Create branch**

Use the shared workflow with:

```bash
ISSUE_URL=$(gh issue create --title "fix: resolve PR number for comment-triggered reviews" --body-file /tmp/repo-guard-issue.md --label repo-guard-hardening)
ISSUE_NUMBER=${ISSUE_URL##*/}
git switch main
git pull --ff-only origin main
git switch -c "codex/issue-${ISSUE_NUMBER}-pr-comment-number"
```

- [ ] **Step 3: Add PR number fallback helpers**

In `scripts/review.mjs`, add these helpers after the `config` object:

```js
function getPRNumberCandidate() {
  if (config.prNumber) return config.prNumber;
  if (config.eventName === 'issue_comment' && config.isPullRequest) return config.issueNumber;
  return '';
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}
```

- [ ] **Step 4: Update review type resolution**

Replace `resolveReviewType()` in `scripts/review.mjs` with:

```js
function resolveReviewType() {
  if (config.type === 'pr') return getPRNumberCandidate() ? 'pr' : null;
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
```

- [ ] **Step 5: Parse the correct number in review functions**

Replace the first line of `reviewPR()` with:

```js
async function reviewPR() {
  const prNumber = parsePositiveInteger(getPRNumberCandidate(), 'PR number');
```

Replace the first line of `reviewIssue()` with:

```js
async function reviewIssue() {
  const issueNumber = parsePositiveInteger(config.issueNumber, 'Issue number');
```

- [ ] **Step 6: Validate syntax**

```bash
node --check scripts/review.mjs
node --check scripts/github-api.mjs
node --check scripts/llm-client.mjs
node --check scripts/prompts.mjs
```

Expected: each command exits with status 0 and prints no syntax errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/review.mjs
git commit -m "fix: resolve PR number for comment-triggered reviews"
```

- [ ] **Step 8: Push, PR, merge**

Use the shared workflow with:

```bash
git push -u origin "codex/issue-${ISSUE_NUMBER}-pr-comment-number"
gh pr create --title "fix: resolve PR number for comment-triggered reviews" --body "Closes #${ISSUE_NUMBER}

## Summary
- use the PR comment issue number when /review runs on a pull request comment
- reject invalid PR or issue numbers before GitHub API calls

## Verification
- node --check scripts/review.mjs
- node --check scripts/github-api.mjs
- node --check scripts/llm-client.mjs
- node --check scripts/prompts.mjs"
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## Task 2: Fetch All PR Files With Pagination

**Files:**
- Modify: `scripts/github-api.mjs`

- [ ] **Step 1: Create the issue body**

```bash
cat > /tmp/repo-guard-issue.md <<'EOF'
## Problem

Repo Guard fetches `/pulls/{number}/files` only once. GitHub paginates this endpoint, so larger PRs can omit changed files from the review prompt.

## Acceptance Criteria

- `fetchPRDiff()` requests `per_page=100`.
- It keeps fetching pages until a page contains fewer than 100 files.
- It preserves the existing returned file shape.
- API failures still throw an error with status context.
EOF
```

- [ ] **Step 2: Create branch**

```bash
ISSUE_URL=$(gh issue create --title "fix: fetch every changed file in PR reviews" --body-file /tmp/repo-guard-issue.md --label repo-guard-hardening)
ISSUE_NUMBER=${ISSUE_URL##*/}
git switch main
git pull --ff-only origin main
git switch -c "codex/issue-${ISSUE_NUMBER}-pr-files-pagination"
```

- [ ] **Step 3: Add pagination helper**

In `scripts/github-api.mjs`, add this constant after `GITHUB_API`:

```js
const PAGE_SIZE = 100;
```

Add this helper after `headers(token)`:

```js
async function fetchAllPages(url, token, description) {
  const items = [];
  let page = 1;

  while (true) {
    const separator = url.includes('?') ? '&' : '?';
    const pagedURL = `${url}${separator}per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(pagedURL, {
      headers: headers(token),
    });
    if (!res.ok) throw new Error(`Failed to fetch ${description}: ${res.status}`);

    const pageItems = await res.json();
    items.push(...pageItems);

    if (pageItems.length < PAGE_SIZE) break;
    page++;
  }

  return items;
}
```

- [ ] **Step 4: Use pagination in `fetchPRDiff()`**

Replace the body of `fetchPRDiff()` with:

```js
export async function fetchPRDiff(repo, prNumber, token) {
  const files = await fetchAllPages(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files`, token, 'PR files');
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));
}
```

- [ ] **Step 5: Validate syntax**

```bash
node --check scripts/github-api.mjs
node --check scripts/review.mjs
```

Expected: both commands exit with status 0 and print no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/github-api.mjs
git commit -m "fix: fetch all PR files"
```

- [ ] **Step 7: Push, PR, merge**

```bash
git push -u origin "codex/issue-${ISSUE_NUMBER}-pr-files-pagination"
gh pr create --title "fix: fetch every changed file in PR reviews" --body "Closes #${ISSUE_NUMBER}

## Summary
- page through GitHub PR files with per_page=100
- preserve the existing file shape used by prompt assembly

## Verification
- node --check scripts/github-api.mjs
- node --check scripts/review.mjs"
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## Task 3: Add Minimal Test Harness

**Files:**
- Create: `package.json`
- Create: `scripts/review-logic.mjs`
- Create: `tests/review-logic.test.mjs`
- Create: `tests/github-api.test.mjs`
- Create: `tests/llm-client.test.mjs`
- Modify: `scripts/review.mjs`
- Modify: `scripts/github-api.mjs`

- [ ] **Step 1: Create the issue body**

```bash
cat > /tmp/repo-guard-issue.md <<'EOF'
## Problem

Repo Guard has behavior-critical routing and API helpers but no repeatable automated tests. Recent fixes for PR comment routing and PR file pagination need regression coverage.

## Acceptance Criteria

- The repository has an `npm test` command using Node built-ins.
- Tests cover PR comment-trigger routing and PR file pagination.
- Tests do not make live GitHub or LLM API calls.
- `npm test` and `npm run check` pass.
EOF
```

- [ ] **Step 2: Create branch**

```bash
ISSUE_URL=$(gh issue create --title "test: add regression coverage for review routing and pagination" --body-file /tmp/repo-guard-issue.md --label repo-guard-hardening)
ISSUE_NUMBER=${ISSUE_URL##*/}
git switch main
git pull --ff-only origin main
git switch -c "codex/issue-${ISSUE_NUMBER}-minimal-tests"
```

- [ ] **Step 3: Create package scripts**

Create `package.json`:

```json
{
  "name": "repo-guard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "check": "for file in scripts/*.mjs tests/*.test.mjs; do node --check \"$file\" || exit 1; done"
  }
}
```

- [ ] **Step 4: Extract pure review logic**

Create `scripts/review-logic.mjs`:

```js
// @ts-check

const TRIGGER_PATTERNS = [/@repo-guard/i, /\/review/i];

export function isTriggeredByComment(commentBody = '') {
  return TRIGGER_PATTERNS.some((pattern) => pattern.test(commentBody));
}

export function extractUserPrompt(commentBody = '') {
  return commentBody
    .replace(/@repo-guard/gi, '')
    .replace(/\/review/gi, '')
    .trim();
}

export function getPRNumberCandidate(config) {
  if (config.prNumber) return config.prNumber;
  if (config.eventName === 'issue_comment' && config.isPullRequest) return config.issueNumber;
  return '';
}

export function resolveReviewType(config) {
  if (config.type === 'pr') return getPRNumberCandidate(config) ? 'pr' : null;
  if (config.type === 'issue') return config.issueNumber ? 'issue' : null;
  if (config.eventName === 'pull_request' && config.prNumber) return 'pr';
  if (config.eventName === 'issues' && config.issueNumber) return 'issue';
  if (config.eventName === 'issue_comment') {
    if (config.isPullRequest && config.issueNumber) return 'pr';
    if (config.issueNumber) return 'issue';
  }
  if (config.prNumber) return 'pr';
  if (config.issueNumber) return 'issue';
  return null;
}

export function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function getReviewNumber(config, reviewType) {
  const rawNumber = reviewType === 'pr' ? getPRNumberCandidate(config) : config.issueNumber;
  const label = reviewType === 'pr' ? 'PR number' : 'Issue number';
  return parsePositiveInteger(rawNumber, label);
}

export function extractRecommendation(response) {
  const match = response.match(/\*\*处理建议:\*\*\s*(批准|评论|请求修改|需要人工判断)/);
  if (!match) return 'COMMENT';
  return {
    批准: 'APPROVE',
    评论: 'COMMENT',
    请求修改: 'REQUEST_CHANGES',
    需要人工判断: 'NEEDS_HUMAN',
  }[match[1]];
}

export function mapRecommendationToEvent(recommendation) {
  switch (recommendation) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    default: return 'COMMENT';
  }
}

export function extractInlineComments(response, files) {
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
```

- [ ] **Step 5: Refactor `review.mjs` imports**

At the top of `scripts/review.mjs`, add:

```js
import {
  extractInlineComments,
  extractRecommendation,
  extractUserPrompt,
  getReviewNumber,
  isTriggeredByComment,
  mapRecommendationToEvent,
  resolveReviewType,
} from './review-logic.mjs';
```

Then remove the local definitions of:

- `TRIGGER_PATTERNS`
- `getPRNumberCandidate`
- `parsePositiveInteger`
- `resolveReviewType`
- `isTriggeredByComment`
- `extractUserPrompt`
- `extractRecommendation`
- `mapRecommendationToEvent`
- `extractInlineComments`

- [ ] **Step 6: Refactor `review.mjs` call sites**

Use explicit config arguments:

```js
if (!isTriggeredByComment(config.commentBody)) {
  console.log('Comment does not contain trigger keyword. Skipping.');
  return;
}
```

Resolve the review type with:

```js
const reviewType = resolveReviewType(config);
```

Call review functions with parsed numbers:

```js
if (reviewType === 'pr') {
  await reviewPR(getReviewNumber(config, 'pr'));
} else {
  await reviewIssue(getReviewNumber(config, 'issue'));
}
```

Change function signatures:

```js
async function reviewPR(prNumber) {
  console.log(`Fetching PR #${prNumber}...`);
```

```js
async function reviewIssue(issueNumber) {
  console.log(`Fetching Issue #${issueNumber}...`);
```

Get the user prompt with:

```js
const userPrompt = extractUserPrompt(config.commentBody);
```

- [ ] **Step 7: Export pagination helper for tests**

In `scripts/github-api.mjs`, change the helper declaration to:

```js
export async function fetchAllPages(url, token, description) {
```

- [ ] **Step 8: Add review logic tests**

Create `tests/review-logic.test.mjs`:

```js
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
  assert.equal(extractRecommendation('no explicit marker'), 'COMMENT');
  assert.equal(mapRecommendationToEvent('APPROVE'), 'APPROVE');
  assert.equal(mapRecommendationToEvent('REQUEST_CHANGES'), 'REQUEST_CHANGES');
  assert.equal(mapRecommendationToEvent('NEEDS_HUMAN'), 'COMMENT');
});
```

- [ ] **Step 9: Add GitHub API pagination tests**

Create `tests/github-api.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPRDiff } from '../scripts/github-api.mjs';

const originalFetch = globalThis.fetch;

test('fetchPRDiff fetches and maps a single page', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([
      {
        filename: 'scripts/review.mjs',
        status: 'modified',
        additions: 3,
        deletions: 1,
      },
    ]), { status: 200 });
  };

  const files = await fetchPRDiff('owner/repo', 7, 'token');

  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'scripts/review.mjs');
  assert.equal(files[0].patch, '');
  assert.match(calls[0], /per_page=100&page=1/);
});

test('fetchPRDiff concatenates multiple pages', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const page = new URL(String(url)).searchParams.get('page');
    const files = page === '1'
      ? Array.from({ length: 100 }, (_, index) => ({
          filename: `file-${index}.js`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: `@@ file ${index}`,
        }))
      : [{
          filename: 'file-100.js',
          status: 'added',
          additions: 2,
          deletions: 0,
          patch: '@@ file 100',
        }];

    return new Response(JSON.stringify(files), { status: 200 });
  };

  const files = await fetchPRDiff('owner/repo', 8, 'token');

  assert.equal(files.length, 101);
  assert.equal(files[0].filename, 'file-0.js');
  assert.equal(files[100].filename, 'file-100.js');
  assert.match(calls[0], /page=1/);
  assert.match(calls[1], /page=2/);
});

test('fetchPRDiff throws with status context on API failure', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response('rate limited', { status: 403 });

  await assert.rejects(
    () => fetchPRDiff('owner/repo', 9, 'token'),
    /Failed to fetch PR files: 403/,
  );
});
```

- [ ] **Step 10: Add LLM URL normalization tests**

Create `tests/llm-client.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseURL } from '../scripts/llm-client.mjs';

test('normalizeBaseURL uses provider defaults', () => {
  assert.equal(normalizeBaseURL('openai', ''), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseURL('anthropic', ''), 'https://api.anthropic.com/v1');
});

test('normalizeBaseURL normalizes OpenAI-compatible relays', () => {
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1/chat/completions'), 'https://relay.example.com/v1');
});

test('normalizeBaseURL normalizes Anthropic-compatible relays', () => {
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com/v1/messages'), 'https://relay.example.com/v1');
});
```

- [ ] **Step 11: Run tests and syntax checks**

```bash
npm test
npm run check
```

Expected: all tests pass and every `.mjs` file passes `node --check`.

- [ ] **Step 12: Commit**

```bash
git add package.json scripts/review-logic.mjs scripts/review.mjs scripts/github-api.mjs tests
git commit -m "test: add regression coverage"
```

- [ ] **Step 13: Push, PR, merge**

```bash
git push -u origin "codex/issue-${ISSUE_NUMBER}-minimal-tests"
gh pr create --title "test: add regression coverage for review routing and pagination" --body "Closes #${ISSUE_NUMBER}

## Summary
- add Node built-in test scripts
- extract pure review routing helpers for unit coverage
- cover PR comment routing, pagination, and URL normalization

## Verification
- npm test
- npm run check"
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## Task 4: Align README With Trigger And Comment Policy

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Create the issue body**

```bash
cat > /tmp/repo-guard-issue.md <<'EOF'
## Problem

README mentions comment triggers but the Quick Start workflow does not include `issue_comment`. It also says repo-guard owns deduplication, while the intended behavior is to post a fresh comment or PR review for every workflow run.

## Acceptance Criteria

- Quick Start includes `issue_comment` for `@repo-guard` and `/review` comments.
- README explains required permissions for comments and PR reviews.
- README explicitly states that Repo Guard does not deduplicate or update previous bot comments.
- README no longer claims the runtime performs deduplication.
EOF
```

- [ ] **Step 2: Create branch**

```bash
ISSUE_URL=$(gh issue create --title "docs: document comment triggers and fresh-comment behavior" --body-file /tmp/repo-guard-issue.md --label repo-guard-hardening)
ISSUE_NUMBER=${ISSUE_URL##*/}
git switch main
git pull --ff-only origin main
git switch -c "codex/issue-${ISSUE_NUMBER}-comment-trigger-docs"
```

- [ ] **Step 3: Update Quick Start trigger**

In `README.md`, change the workflow trigger block to:

```yaml
on:
  pull_request:
    types: [opened, synchronize]
  issues:
    types: [opened]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
```

- [ ] **Step 4: Add comment trigger behavior section**

Add this text after the Inputs table:

```markdown
## Comment Triggers

When `issue_comment` is enabled, Repo Guard runs only when a newly created issue or PR comment contains `@repo-guard` or `/review`.

- On PR comments, Repo Guard reviews the pull request.
- On issue comments, Repo Guard reviews the issue.
- Any text after the trigger is passed to the model as an additional user request.

Repo Guard posts a fresh comment or PR review on every workflow run. It does not deduplicate, update, or delete previous bot comments.
```

- [ ] **Step 5: Remove deduplication claim**

In the relationship table, change the runtime responsibility from:

```markdown
GitHub Action 运行时：事件监听、数据获取、LLM 调用、评论发布、去重
```

to:

```markdown
GitHub Action 运行时：事件监听、数据获取、LLM 调用、评论发布
```

- [ ] **Step 6: Run full validation**

```bash
npm test
npm run check
```

Expected: tests and syntax checks still pass after documentation changes.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: document comment trigger behavior"
```

- [ ] **Step 8: Push, PR, merge**

```bash
git push -u origin "codex/issue-${ISSUE_NUMBER}-comment-trigger-docs"
gh pr create --title "docs: document comment triggers and fresh-comment behavior" --body "Closes #${ISSUE_NUMBER}

## Summary
- include issue_comment in the Quick Start workflow
- document PR and issue comment trigger behavior
- clarify that every run posts a fresh comment or review

## Verification
- npm test
- npm run check"
gh pr merge --squash --delete-branch
git switch main
git pull --ff-only origin main
```

## Final Verification

- [ ] **Step 1: Confirm no open hardening PRs remain**

```bash
gh pr list --state open --json number,title,headRefName
```

Expected: no PRs created by this plan remain open.

- [ ] **Step 2: Confirm local verification passes**

```bash
npm test
npm run check
git status --short --branch
```

Expected: tests pass, syntax checks pass, and local `main` is clean and aligned with `origin/main`.

- [ ] **Step 3: Confirm issues are closed by merged PRs**

```bash
gh issue list --state open --label repo-guard-hardening --json number,title,url
```

Expected: no open issue from this hardening batch remains unless a PR merge failed.
