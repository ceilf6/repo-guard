# External Repo Guard Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scheduled dispatcher that lets `ceilf6` trigger Repo Guard on public external PRs by commenting `@ceilf6/repo-guard`.

**Architecture:** Add side-effect-free PR review and external-dispatcher logic modules, then wire them into a new scheduled workflow. Reuse existing prompt assembly, LLM client, GitHub API helpers, and review normalization so the existing composite action behavior stays unchanged.

**Tech Stack:** Node.js ESM, `node:test`, GitHub REST API, GitHub Actions scheduled workflow.

---

## File Structure

- Create `scripts/pr-reviewer.mjs`: builds a normalized PR review from explicit config and returns response metadata without posting.
- Create `scripts/external-dispatcher-logic.mjs`: pure trigger, marker, candidate, and limit helpers.
- Create `scripts/external-dispatcher.mjs`: scheduled entrypoint that searches, filters, reviews, and posts external PR comments.
- Modify `scripts/review.mjs`: delegate PR review construction to `scripts/pr-reviewer.mjs` while preserving existing posting behavior.
- Modify `scripts/github-api.mjs`: add search and issue-comment listing helpers.
- Create `tests/external-dispatcher-logic.test.mjs`: unit tests for trigger selection and markers.
- Modify `tests/github-api.test.mjs`: tests for new GitHub API helpers.
- Create `.github/workflows/external-repo-guard.yml`: scheduled and manual workflow.
- Modify `README.md`: document external dispatcher setup.

## Tasks

### Task 1: Dispatcher Logic Tests

**Files:**
- Create: `tests/external-dispatcher-logic.test.mjs`
- Create: `scripts/external-dispatcher-logic.mjs`

- [ ] Write tests for marker generation, marker detection, candidate parsing, actor filtering, prompt extraction, trigger selection, and max review parsing.
- [ ] Run `node --test tests/external-dispatcher-logic.test.mjs` and confirm it fails because the module is missing.
- [ ] Implement the pure logic helper module.
- [ ] Run `node --test tests/external-dispatcher-logic.test.mjs` and confirm it passes.

### Task 2: GitHub API Helper Tests

**Files:**
- Modify: `tests/github-api.test.mjs`
- Modify: `scripts/github-api.mjs`

- [ ] Add tests for issue search URL construction, search result mapping, and issue-comment pagination.
- [ ] Run `node --test tests/github-api.test.mjs` and confirm it fails because helper exports are missing.
- [ ] Implement `searchIssuesAndPullRequests()` and `listIssueComments()`.
- [ ] Run `node --test tests/github-api.test.mjs` and confirm it passes.

### Task 3: PR Review Builder Extraction

**Files:**
- Create: `scripts/pr-reviewer.mjs`
- Modify: `scripts/review.mjs`

- [ ] Extract existing PR review construction into `buildPRReview(config)`.
- [ ] Keep `review.mjs` responsible for event resolution, console logging, PR review posting, and fallback comment posting.
- [ ] Run `node --test tests/review-logic.test.mjs tests/prompts.test.mjs tests/github-api.test.mjs` and confirm existing behavior remains covered.

### Task 4: External Dispatcher Entrypoint

**Files:**
- Create: `scripts/external-dispatcher.mjs`

- [ ] Implement environment parsing with required `CEILF6_GITHUB_TOKEN` and `LLM_API_KEY`.
- [ ] Search public open PRs using the configured query.
- [ ] Fetch comments for each candidate, select the newest unprocessed `ceilf6` trigger, build the PR review, and post a normal comment prefixed with the hidden trigger marker.
- [ ] Implement `DRY_RUN=true` so no comment is posted.
- [ ] Run `npm run check` and confirm syntax is valid.

### Task 5: Scheduled Workflow And Docs

**Files:**
- Create: `.github/workflows/external-repo-guard.yml`
- Modify: `README.md`

- [ ] Add a scheduled workflow with `workflow_dispatch` and conservative default limits.
- [ ] Document `CEILF6_GITHUB_TOKEN`, LLM settings, trigger behavior, schedule delay, and normal-comment output.
- [ ] Run `npm test` and `npm run check`.

### Task 6: Configure Secret And Commit

**Files:**
- GitHub repository secret: `CEILF6_GITHUB_TOKEN`

- [ ] Set `CEILF6_GITHUB_TOKEN` in `ceilf6/repo-guard` using `gh secret set`.
- [ ] Stage code, docs, tests, and workflow changes.
- [ ] Commit with `feat: add external repo guard dispatcher`.
