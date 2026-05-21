# Repo Guard Quality Evaluation

This repository includes a reusable real-model evaluation harness for the combined Repo Guard runtime and `ceilf6-skills` review prompts.

## What It Tests

Run `npm run eval:quality` to evaluate four fixed scenarios:

- `pr-auth-bypass`: PR review should request changes for an authentication bypass and produce an inline finding.
- `pr-large-plus-small`: PR review should still inspect a small source diff when a huge generated file is omitted.
- `issue-vague-crash`: issue review should ask for the smallest useful reproduction details.
- `issue-ready-feature`: issue review should mark an actionable feature request as ready without noisy reporter asks.

The harness checks Chinese output contract stability, parser compatibility, inline comment extraction, changed-line targeting, and basic actionability signals. PR prompts also include a `行级评论行号目标` section so models do not have to calculate new-file line numbers from hunk headers.

## Environment

Provide either the short variables below or the GitHub Action-compatible `LLM_*` names:

```bash
export PROVIDER="anthropic"
export BASE_URL="https://your-anthropic-compatible-relay/anthropic"
export API_KEY="..."
export MODEL="mimo-v2.5-pro"

npm run eval:quality
```

Equivalent names:

- `LLM_PROVIDER`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_MAX_TOKENS`

Optional:

- `QUALITY_EVAL_OUTPUT_DIR`: defaults to `quality-eval-results`
- `MAX_TOKENS`: defaults to `3200`

## Outputs

Each run writes a timestamped directory under `quality-eval-results/`:

- `<fixture-id>.md`: raw model comment
- `summary.json`: fixture scores and check results

`quality-eval-results/` is ignored by git so model outputs and provider-specific details are not committed accidentally.

## Offline Checks

The scoring logic is covered without live model calls:

```bash
node --test tests/quality-eval.test.mjs
```

Use this before changing the evaluation harness. Use `npm run eval:quality` before changing review prompt behavior or repo-guard prompt assembly.
