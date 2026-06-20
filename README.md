# Repo Guard

AI-powered review bot for GitHub Issues and Pull Requests.

- PR: Automated code review with cascade analysis, Karpathy review standard, inline comments
- Issue: Quality assessment with completeness, clarity, actionability scoring
- Supports OpenAI-compatible and Anthropic API formats
- Works with relay/proxy services via custom base URL
- Configurable model and extra instructions
- Chinese review prompts and Chinese output contracts by default
- Trigger via PR/Issue creation or `@ceilf6/repo-guard` / `/review` comments

## Quick Start

Add `.github/workflows/repo-guard.yml` to your repository:

```yaml
name: Repo Guard
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
| `extra-instructions` | No | `""` | Additional prompt instructions |

## Comment Triggers

When `issue_comment` is enabled, Repo Guard runs only when a newly created issue or PR comment contains `@ceilf6/repo-guard` or `/review`.

- On PR comments, Repo Guard reviews the pull request.
- On issue comments, Repo Guard reviews the issue.
- Any text after the trigger is passed to the model as an additional user request.

Repo Guard posts a fresh comment or PR review on every workflow run. It does not deduplicate, update, or delete previous bot comments.

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
          extra-instructions: "重点检查 TypeScript 类型安全和 React 模式。"

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
```

## How It Works

### Architecture

Review prompts are sourced from [ceilf6/ceilf6-skills](https://github.com/ceilf6/ceilf6-skills) via git submodule:
- PR review uses the `code-reviewer` skill (cascade analysis + Karpathy review standard)
- Issue review uses the `issue-reviewer` skill (completeness, clarity, actionability scoring)

At runtime, the action clones the skills repo and assembles the system prompt from `SKILL.md` + all `references/*.md` files.

### PR Review
1. Initializes skills from `ceilf6/ceilf6-skills` submodule
2. Fetches the complete cumulative PR diff, metadata, and linked issue context via GitHub API
3. Includes GitHub closing issues plus same-repo `#123` references from the PR title/body
4. Truncates large diffs (>100KB) to focus on largest changes
5. Assembles system prompt from `code-reviewer` skill
6. Sends to LLM, extracts Chinese recommendation (`批准` / `评论` / `请求修改` / `需要人工判断`)
7. Extracts inline findings and posts as PR review with line comments

### Issue Review
1. Initializes skills from `ceilf6/ceilf6-skills` submodule
2. Fetches issue title, body, and labels
3. Assembles system prompt from `issue-reviewer` skill
4. Sends to LLM, posts structured quality assessment as a comment

## Relay/Proxy Support

If you use a relay service (中转站) for API access, set `LLM_BASE_URL` to your relay endpoint:

- OpenAI-compatible relay: `https://your-relay.com/v1`
- Anthropic-compatible relay: `https://your-relay.com/anthropic`

The bot automatically normalizes the URL for the selected provider.

### Private intranet models

Repo Guard does not require self-hosted runners by default. Public users can
keep using GitHub-hosted runners with public OpenAI-compatible or
Anthropic-compatible endpoints.

If a model endpoint is only reachable from your own machine or company network,
run the repository workflow on a self-hosted runner that has access to that
network, then point the existing provider settings at the private endpoint:

```yaml
jobs:
  guard:
    runs-on: [self-hosted, macOS, repo-guard-intranet]
    steps:
      - uses: ceilf6/repo-guard@main
        with:
          type: both
          provider: anthropic
          model: claude-opus-4-7-thinking
          api-key: ${{ secrets.LLM_API_KEY }}
          base-url: ${{ vars.LLM_BASE_URL }}
```

For public repositories, restrict self-hosted runner workflows to trusted
events and actors. Do not let untrusted fork pull requests execute arbitrary
code on a persistent local runner.

## Relationship with ceilf6-skills

本仓库是 **执行层**，[ceilf6/ceilf6-skills](https://github.com/ceilf6/ceilf6-skills) 是 **知识层**。

| 仓库 | 职责 |
|------|------|
| `ceilf6/repo-guard` | GitHub Action 运行时：事件监听、数据获取、LLM 调用、评论发布 |
| `ceilf6/ceilf6-skills` | 评审知识：system prompt、评审标准、分析框架、评分规则 |

repo-guard 通过 git submodule 引用 ceilf6-skills，运行时始终拉取最新版 skill。更新评审逻辑只需修改 ceilf6-skills 中的 skill 文件，无需改动 repo-guard 代码。

使用的 skill：
- [`code-reviewer`](https://github.com/ceilf6/ceilf6-skills/tree/main/code-reviewer) — PR 代码评审（级联分析 + Karpathy 审查标准）
- [`issue-reviewer`](https://github.com/ceilf6/ceilf6-skills/tree/main/issue-reviewer) — Issue 质量评估（完整性、清晰度、可操作性）

## Friendly Links

- [Linux.do](https://linux.do/) - Chinese AI learning and developer community.
- [Aionui](https://github.com/iOfficeAI/AionUi) - Mobile remote-control UI for letting AI agents operate tasks from a phone.
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) - Office suite designed for AI agents.
- [deepseek-pp](https://github.com/zhu1090093659/deepseek-pp) - Browser extension for DeepSeek web conversations.
- [MuseAI](https://github.com/yejiming/MuseAI) - Local AI companion, text adventure, and interactive fiction app.
- [RedBox](https://github.com/Jamailar/RedBox) - Local AI creation workspace for Xiaohongshu creators.
- [1flowbase](https://github.com/taichuy/1flowbase) - Virtual model gateway for publishing multi-model workflows as OpenAI/Claude-compatible endpoints, with trace, token, latency, and cost visibility.

## License

MIT
