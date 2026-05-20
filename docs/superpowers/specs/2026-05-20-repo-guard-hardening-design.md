# Repo Guard Hardening Design

Date: 2026-05-20
Repository: `ceilf6/repo-guard`

## Purpose

Strengthen Repo Guard through a sequence of small, independently reviewable issues and pull requests. The first pass focuses on behavior that can make the GitHub Action review the wrong subject, miss PR files, or mislead users about documented behavior.

## Scope

This design covers the first hardening batch:

1. Fix PR comment-triggered review subject detection.
2. Fetch all changed PR files through GitHub API pagination.
3. Add a minimal Node test harness for regression coverage.
4. Align README documentation with the implemented trigger and comment behavior.

This batch will not implement comment deduplication. Every workflow run should create a fresh issue comment or PR review.

## Current Context

Repo Guard is a composite GitHub Action. Runtime behavior is implemented by `action.yml` and small ESM scripts under `scripts/`.

The current code has no package manifest, no test command, and no dedicated CI workflow in this repository. Validation is currently limited to syntax checks such as `node --check`.

Important current behavior:

- `action.yml` passes `PR_NUMBER` from `github.event.pull_request.number`.
- `action.yml` passes `ISSUE_NUMBER` from `github.event.issue.number`.
- `review.mjs` treats `issue_comment` on a PR as PR review work, but `reviewPR()` reads `config.prNumber`.
- `github-api.mjs` fetches `/pulls/{number}/files` once without pagination.
- README says the runtime owns "comment posting, deduplication", but deduplication is not desired and should not be implemented.

## Approach

Use a risk-first, issue-by-issue workflow. Each issue gets its own branch, PR, validation, merge, and return to latest `main` before starting the next issue.

Issue order:

1. Behavior correctness: make PR comment-triggered reviews fetch the correct PR.
2. Review completeness: fetch every changed PR file, not only the first page.
3. Safety net: add focused tests for the now-fixed behavior.
4. User-facing accuracy: make README match the actual trigger and comment policy.

## Issue 1: PR Comment Trigger Number

### Problem

For `issue_comment` events, GitHub exposes the subject number as `github.event.issue.number`. If that issue is a pull request, this number is also the PR number. The current action only fills `PR_NUMBER` for `pull_request` events. As a result, `/review` on a PR comment can resolve to PR work while still passing an empty `PR_NUMBER` into `reviewPR()`.

### Design

Introduce a subject-number path that works for both `pull_request` and `issue_comment` events. The minimal implementation can either:

- add a `SUBJECT_NUMBER` environment variable in `action.yml`, or
- derive the PR number in `review.mjs` from `issueNumber` when `eventName === 'issue_comment' && isPullRequest`.

The implementation should preserve existing behavior for native `pull_request` and `issues` events.

### Acceptance Criteria

- A simulated `pull_request` event still resolves to PR review using the pull request number.
- A simulated `issue_comment` event on a PR resolves to PR review using `github.event.issue.number`.
- A simulated `issue_comment` event on a normal issue resolves to issue review.
- Invalid or missing subject numbers should skip cleanly or fail with a clear error, not request `/pulls/NaN`.

## Issue 2: PR File Pagination

### Problem

GitHub's PR files endpoint is paginated. Fetching `/pulls/{number}/files` once can omit changed files from larger PRs. This weakens review coverage and can make the LLM miss important changes.

### Design

Add a small pagination helper in `github-api.mjs`. `fetchPRDiff()` should request `per_page=100` and increment `page` until a page returns fewer than 100 files. It should keep the existing returned file shape:

- `filename`
- `status`
- `additions`
- `deletions`
- `patch`

The helper should keep current error behavior: non-OK responses throw an error with the status.

### Acceptance Criteria

- One-page responses return the same file shape as today.
- Multi-page responses are concatenated in API order.
- The function stops after the first page with fewer than 100 items.
- API failures include enough status information to diagnose the failed request.

## Issue 3: Minimal Test Harness

### Problem

The repository has runtime logic but no automated regression tests. This makes small behavior fixes rely on manual environment simulation.

### Design

Use Node's built-in `node:test` and `node:assert/strict` to avoid new dependencies. Add only enough structure to test stable logic:

- review type resolution for `pull_request`, `issues`, and `issue_comment`.
- user prompt extraction from `@repo-guard` and `/review` comments.
- recommendation extraction and event mapping.
- provider base URL normalization.
- PR file pagination with mocked `fetch`.

If necessary, move pure functions into a small module or export them from existing modules without changing runtime behavior. The public Action inputs and outputs should not change.

### Acceptance Criteria

- A test command exists and can be run locally.
- Tests cover the Issue 1 and Issue 2 regression scenarios.
- `node --test` passes.
- Existing scripts still pass `node --check`.

## Issue 4: README Alignment

### Problem

README documents comment-triggered usage at a high level, but the Quick Start does not include `issue_comment`. It also says repo-guard owns "deduplication", while the desired behavior is to create a fresh comment or PR review every workflow run.

### Design

Update README to:

- include `issue_comment` in trigger examples for `@repo-guard` and `/review`.
- explain the needed permissions for posting issue comments and PR reviews.
- state that every workflow run posts a new comment or review.
- remove any claim that the runtime deduplicates comments.

### Acceptance Criteria

- README matches `action.yml` behavior.
- The documentation explicitly says deduplication is not performed.
- Users can copy the Quick Start workflow and get comment-triggered reviews.

## Branch, PR, And Merge Workflow

For each issue:

1. Create a GitHub issue with evidence and acceptance criteria.
2. Create a branch named `codex/issue-<number>-<short-topic>` from latest `main`.
3. Implement only that issue's scope.
4. Validate with the strongest checks available for that point in the sequence.
5. Open a PR that links the issue.
6. Merge after validation succeeds.
7. Return to `main`, pull latest, and start the next issue.

Before Issue 3 lands, validation may be limited to syntax checks and focused manual simulation. After Issue 3 lands, later PRs should run the full test command.

## Error Handling

New runtime failures should be clear and actionable. Missing numbers, GitHub API failures, or unsupported event/type combinations should not silently review the wrong object.

For pagination, retain the existing throw-on-non-OK behavior, but include the HTTP status and endpoint context where practical.

## Testing Strategy

Testing starts minimal and grows only where it protects known behavior:

- Syntax checks for all ESM scripts.
- Node built-in tests for pure logic.
- Mocked global `fetch` tests for GitHub API pagination.
- No live GitHub API calls in unit tests.
- No LLM API calls in tests.

## Out Of Scope

- Comment deduplication or updating prior bot comments.
- Prompt rewrites in `ceilf6-skills`.
- Model/provider feature expansion.
- Large refactors of the runtime scripts.
- Marketplace packaging changes beyond documentation alignment.

## Success Criteria

The batch is complete when all four issues are closed by merged PRs, the repository has a repeatable local test command, and README accurately describes the Action's trigger and comment behavior.
