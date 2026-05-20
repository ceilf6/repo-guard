# Repo Guard

AI-powered review bot for GitHub Issues and Pull Requests.

- PR: Automated code review with cascade analysis, Karpathy review standard, inline comments
- Issue: Quality assessment with completeness, clarity, actionability scoring
- Supports OpenAI-compatible and Anthropic API formats
- Works with relay/proxy services via custom base URL
- Configurable model, language, and extra instructions
- Deduplication: edits existing bot comments instead of creating new ones

## Quick Start

Add `.github/workflows/repo-guard.yml` to your repository:

```yaml
name: Repo Guard
on:
  pull_request:
    types: [opened, synchronize]
  issues:
    types: [opened]
permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: ceilf6/repo-guard@main
        with:
          provider: ${{ vars.LLM_PROVIDER || 'openai' }}
          model: ${{ vars.LLM_MODEL || 'gpt-4o' }}
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: ${{ vars.LLM_BASE_URL }}
          language: zh
```

## Configuration

### Repository Secrets

| Name | Required | Description |
|------|----------|-------------|
| `LLM_API_KEY` | Yes | API key for your LLM provider or relay service |

### Repository Variables

| Name | Default | Description |
|------|---------|-------------|
| `LLM_PROVIDER` | `openai` | `openai` or `anthropic` |
| `LLM_MODEL` | `gpt-4o` | Model name |
| `LLM_BASE_URL` | (empty) | Custom API base URL for relay/proxy |

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | No | `both` | `pr`, `issue`, or `both` (auto-detect) |
| `provider` | No | `openai` | `openai` or `anthropic` |
| `model` | No | `gpt-4o` | Model name |
| `api-key` | Yes | — | LLM API key |
| `base-url` | No | `""` | Custom API base URL |
| `max-tokens` | No | `4096` | Max response tokens |
| `github-token` | No | `github.token` | GitHub token |
| `language` | No | `en` | Response language (`en` / `zh`) |
| `extra-instructions` | No | `""` | Additional prompt instructions |

## Advanced: Separate PR and Issue Config

Use different models or providers for PR review vs issue review:

```yaml
jobs:
  review-pr:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: ceilf6/repo-guard@main
        with:
          type: pr
          provider: anthropic
          model: claude-sonnet-4-20250514
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: ${{ vars.LLM_BASE_URL }}
          language: zh
          extra-instructions: "Focus on TypeScript type safety and React patterns."

  review-issue:
    if: github.event_name == 'issues'
    runs-on: ubuntu-latest
    steps:
      - uses: ceilf6/repo-guard@main
        with:
          type: issue
          provider: openai
          model: gpt-4o
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: ${{ vars.LLM_BASE_URL }}
          language: zh
```

## How It Works

### PR Review
1. Fetches PR diff and metadata via GitHub API
2. Truncates large diffs (>100KB) to focus on largest changes
3. Sends to LLM with code review system prompt (cascade analysis + Karpathy standard)
4. Extracts recommendation (APPROVE / COMMENT / REQUEST_CHANGES)
5. Extracts inline findings and posts as PR review with line comments

### Issue Review
1. Fetches issue title, body, and labels
2. Sends to LLM with issue analysis system prompt
3. Posts structured quality assessment as a comment

### Deduplication
Bot comments include a hidden marker (`<!-- repo-guard:v1 -->`). On subsequent runs (e.g., PR update), the bot edits its existing comment instead of creating a new one.

## Relay/Proxy Support

If you use a relay service (中转站) for API access, set `LLM_BASE_URL` to your relay endpoint:

- OpenAI-compatible relay: `https://your-relay.com/v1`
- Anthropic-compatible relay: `https://your-relay.com/anthropic`

The bot automatically normalizes the URL for the selected provider.

## License

MIT
