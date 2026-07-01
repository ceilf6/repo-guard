# External Repo Guard Dispatcher Design

## Goal

Allow `ceilf6` to trigger Repo Guard on public pull requests in repositories that have not installed or configured Repo Guard. A comment containing `@ceilf6/repo-guard` on an external public PR should be discovered by a scheduled workflow in `ceilf6/repo-guard`, reviewed with the existing Repo Guard prompt/runtime logic, and answered with a normal PR conversation comment from the `ceilf6` account.

## Non-Goals

- Do not change the existing `ceilf6/repo-guard@main` composite action contract.
- Do not require target repositories to add workflows, install GitHub Apps, or configure secrets.
- Do not run, checkout, build, or execute code from external repositories.
- Do not store tokens, LLM keys, or processed trigger state in source control.
- Do not post formal GitHub PR review events for the external dispatcher path.

## Current Behavior

The existing action runs only inside the repository whose workflow triggered it. It reads `github.repository`, `github.token`, event metadata, and LLM inputs from that workflow. For `issue_comment`, the trigger text is only useful after the target repository has configured a workflow that runs Repo Guard. A repository that has not configured Repo Guard will not emit an Action run for `@ceilf6/repo-guard`.

## Target Architecture

Add a separate scheduled dispatcher workflow in this repository. The dispatcher is a side path: it runs in `ceilf6/repo-guard`, searches GitHub for public open PRs that mention `@ceilf6/repo-guard`, filters to explicit trigger comments authored by `ceilf6`, and then calls the existing review-building modules to produce a normal comment.

The existing composite action remains unchanged for installed-repository usage. Shared review functions may be extracted from `scripts/review.mjs` if needed, but the external dispatcher should not alter current event resolution or comment-trigger behavior.

## Components

### Scheduled Workflow

Create `.github/workflows/external-repo-guard.yml`.

- Trigger with `schedule` and `workflow_dispatch`.
- Run on a GitHub-hosted Ubuntu runner unless a private LLM endpoint requires a self-hosted runner.
- Use repository secrets:
  - `CEILF6_GITHUB_TOKEN`: a classic PAT for the `ceilf6` account with `public_repo` capability.
  - `LLM_API_KEY`: existing LLM provider credential.
- Use repository variables:
  - `LLM_PROVIDER`
  - `LLM_MODEL`
  - `LLM_BASE_URL`
- Set conservative defaults for run limits.

### External Dispatcher Script

Create `scripts/external-dispatcher.mjs`.

Responsibilities:

- Read runtime config from environment.
- Search recent public open PRs matching `@ceilf6/repo-guard`.
- Fetch issue comments for candidate PRs and identify the newest unprocessed trigger comment.
- Validate that the trigger comment author is exactly the configured actor, default `ceilf6`.
- Fetch PR info, cumulative file diff, and linked issue context using existing GitHub API helpers.
- Assemble the same PR system prompt and user message used by normal PR review.
- Call the existing LLM client.
- Normalize the review response.
- Post a normal issue comment to the PR thread using the PAT.
- Include a hidden marker with the source trigger comment id so future scheduled runs can skip it.

### GitHub API Helpers

Extend `scripts/github-api.mjs` with focused helpers:

- Search issues and pull requests.
- List issue comments for a specific PR issue thread.
- Optionally extract repository and PR number from API URLs if search results provide only API links.

Existing helpers for PR info, PR diff, linked issue context, and comment posting should remain reusable.

### Review Runtime Sharing

If direct reuse from `scripts/review.mjs` would require importing a script with side effects, extract a side-effect-free helper, for example `scripts/pr-reviewer.mjs`, that accepts explicit config:

- repo
- PR number
- GitHub token
- LLM provider/model/base URL/api key/max tokens
- extra instructions
- user prompt

Both `scripts/review.mjs` and `scripts/external-dispatcher.mjs` can call that helper. This avoids duplicating review logic and preserves current behavior.

## Data Flow

1. Scheduled workflow starts in `ceilf6/repo-guard`.
2. Dispatcher searches public open PRs for the trigger string.
3. For each candidate, dispatcher fetches PR conversation comments.
4. Dispatcher skips comments that:
   - do not contain `@ceilf6/repo-guard`
   - were not authored by `ceilf6`
   - already have a Repo Guard external marker response
   - belong to a closed PR
5. Dispatcher reviews up to `EXTERNAL_REPO_GUARD_MAX_REVIEWS` triggers per run.
6. Dispatcher posts a comment with a hidden marker:

```markdown
<!-- repo-guard external trigger:<comment_id> -->
```

7. Later runs use that marker to avoid duplicate reviews.

## Safety Boundaries

The dispatcher is headless and uses a user PAT, so it needs deterministic gates before any LLM or write action:

- Only public PR metadata and diffs are fetched.
- Only comments authored by the configured trigger actor are accepted.
- External repository code is never checked out or executed.
- The PAT is read only from `CEILF6_GITHUB_TOKEN`; it is never logged or written to files.
- Posting is limited by a per-run maximum.
- `DRY_RUN=true` logs intended actions without posting.
- Search failures, permission failures, and LLM failures fail closed for that candidate.
- Existing Repo Guard generated comments are ignored to avoid loops.

Because the PAT was shared outside GitHub Secrets during design discussion, deployment should use a newly rotated token rather than the exposed value.

## Error Handling

- Search API failure exits non-zero unless `DRY_RUN=true` is being used for local inspection.
- Candidate-level failures are logged with repository, PR number, and reason, then the dispatcher continues to the next candidate.
- Posting failure does not retry indefinitely; the scheduled workflow can pick up the same trigger later.
- If the GitHub token lacks permission to comment on a public PR, the candidate is skipped with a clear error.
- If search results are incomplete or delayed, the next scheduled run can discover the trigger.

## Testing

Add unit tests for dispatcher logic without network calls:

- Trigger comment detection.
- Author filtering.
- Marker generation and detection.
- Candidate extraction from GitHub search results.
- Per-run limit behavior.
- Dry-run behavior.

Add focused tests for any new GitHub API helper URL construction and pagination behavior using mocked `fetch`.

Run the existing test suite and syntax check:

```bash
npm test
npm run check
```

## Documentation

Update `README.md` with an advanced section for external PR dispatch:

- Explain that target repositories do not need to configure Repo Guard.
- State that only `ceilf6`-authored trigger comments are processed by default.
- Document required secrets and variables.
- State that dispatch is scheduled, so it is not immediate.
- Clarify that the result is a normal PR conversation comment from the PAT owner.

## Rollout

1. Implement and test with `DRY_RUN=true`.
2. Configure a newly rotated `CEILF6_GITHUB_TOKEN` repository secret.
3. Run `workflow_dispatch` manually against a known public PR trigger.
4. Enable schedule after the manual run succeeds.
5. Keep the per-run limit conservative until behavior is stable.
