# Repo Guard

**智能体开发闭环 issue → PR → CR 中的评审环节**，以 GitHub Action 形态交付，已上架 GitHub Marketplace。

AI-powered review bot for GitHub Issues and Pull Requests, built as the CR stage of an agent-driven development loop.

## 为什么造这个轮子

社区不缺 AI review bot，但它们大多面向**人类协作**：评审意见写给人看，流程的终点是 approve 按钮。而在智能体驱动的开发方式里，评审是**循环的一环**——智能体按 issue 开发、提 PR，CR 给出结论与行级意见，智能体消费这些反馈进入下一轮修复，直到质量门放行：

```
issue → dev → PR → CR ──批准──→ merge
         ↑            │
         └─── fix ←───┘ 请求修改
```

repo-guard 是为这个闭环造的 CR 环节：输出稳定的结论契约与可定位的行级意见——既给人看，也让下一轮智能体能稳定消费。

> repo-guard 是我 Harness 工程实践中的 CR 环节；要在一个新仓库里快速冷启动整套 Harness 环境，见 [harness-kit](https://github.com/ceilf6/harness-kit)。

## 设计决策

1. **知识层 / 执行层分离** — 评审标准（system prompt、评审框架、评分规则）沉淀在独立的 [ceilf6-skills](https://github.com/ceilf6/ceilf6-skills) 仓库，本仓库只做运行时：事件监听、数据获取、LLM 调用、评论发布。迭代评审标准不需要动一行运行时代码。
2. **输出即契约** — 评审结论是固定的中文枚举（`批准` / `评论` / `请求修改` / `需要人工判断`）加结构化行级意见；解析器与下游智能体都依赖这份契约，评测中对契约稳定性做断言。
3. **评审质量本身也过质量门** — `npm run eval:quality` 用真模型跑 4 个固定评审场景，断言输出契约、行级定位与可操作性。给评审 bot 装上它给别的仓库装的东西。

---

## Features

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
| `LLM_STRUCTURED_OUTPUT` | `auto` | `auto` uses OpenRouter JSON Schema when supported; explicit `off` always uses the legacy free-text request |

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `type` | No | `both` | `pr`, `issue`, or `both` (auto-detect) |
| `provider` | No | `openai` | `openai` or `anthropic` |
| `model` | No | `gpt-4o` | Model name |
| `api-key` | Yes | — | LLM API key |
| `base-url` | No | `""` | Custom API base URL |
| `max-tokens` | No | `4096` | Max response tokens |
| `structured-output` | No | `auto` | OpenRouter Structured Outputs mode: `off` or `auto` |
| `github-token` | No | `github.token` | GitHub token |
| `extra-instructions` | No | `""` | Additional prompt instructions |

## Comment Triggers

When `issue_comment` is enabled, Repo Guard runs only when a newly created issue or PR comment contains `@ceilf6/repo-guard` or `/review`.

- On PR comments, Repo Guard reviews the pull request.
- On issue comments, Repo Guard reviews the issue.
- Any text after the trigger is passed to the model as an additional user request.

Repo Guard posts a fresh comment or PR review on every workflow run. It does not deduplicate, update, or delete previous bot comments.

## Advanced: External PR Dispatch

Repo Guard can also run from this repository on a schedule to review public PRs in repositories that have not installed Repo Guard. This is a separate path from the composite action above.

When the scheduled dispatcher sees a public open PR conversation comment authored by `ceilf6` that contains `@ceilf6/repo-guard`, it reviews that PR and posts a normal PR conversation comment from the `ceilf6` account.

Required secret for `ceilf6/repo-guard`:

| Name | Required | Description |
|------|----------|-------------|
| `CEILF6_GITHUB_TOKEN` | Yes | GitHub token used to search public PRs and post comments as `ceilf6`. For arbitrary public repositories, use a classic PAT with `public_repo`. |

The dispatcher also uses the normal LLM settings:

| Name | Type | Description |
|------|------|-------------|
| `LLM_API_KEY` | Secret | API key for the configured LLM provider |
| `LLM_PROVIDER` | Variable | `openai` or `anthropic` |
| `LLM_MODEL` | Variable | Model name |
| `LLM_BASE_URL` | Variable | Custom relay/proxy URL |
| `LLM_STRUCTURED_OUTPUT` | Variable | OpenRouter Structured Outputs mode, default `auto`; set `off` to force legacy free text |
| `EXTERNAL_REPO_GUARD_MAX_REVIEWS` | Variable | Maximum external PR reviews per run, default `3` |
| `EXTERNAL_REPO_GUARD_SEARCH_LIMIT` | Variable | Maximum search results scanned per run, default `20` |

Notes:

- Target repositories do not need to add workflows or secrets.
- Only trigger comments authored by `ceilf6` are processed by default, so other users cannot spend the configured LLM budget by mentioning Repo Guard.
- Scheduled workflows are not immediate; discovery depends on GitHub Actions schedule timing and GitHub search freshness.
- The external dispatcher posts a normal comment, not a formal PR review with line comments.
- External repository code is never checked out or executed.

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

本仓库是**执行层**，[ceilf6/ceilf6-skills](https://github.com/ceilf6/ceilf6-skills) 是**知识层**，通过 git submodule 引用、运行时始终拉取最新版 skill。更新评审标准只需修改 ceilf6-skills 中的 skill 文件，无需改动本仓库代码。

| 仓库 | 职责 |
|------|------|
| `ceilf6/repo-guard` | GitHub Action 运行时：事件监听、数据获取、LLM 调用、评论发布 |
| `ceilf6/ceilf6-skills` | 评审知识：system prompt、评审标准、分析框架、评分规则 |

- PR review uses the [`code-reviewer`](https://github.com/ceilf6/ceilf6-skills/tree/main/code-reviewer) skill (cascade analysis + Karpathy review standard)
- Issue review uses the [`issue-reviewer`](https://github.com/ceilf6/ceilf6-skills/tree/main/issue-reviewer) skill (completeness, clarity, actionability scoring)

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

## Quality Evaluation

The review bot itself is behind a quality gate: `npm run eval:quality` runs a real-model evaluation harness over four fixed scenarios (auth-bypass PR, huge-diff-plus-small-change PR, vague crash issue, ready feature issue), asserting Chinese output contract stability, parser compatibility, inline comment extraction, and changed-line targeting. See [docs/quality-evaluation.md](docs/quality-evaluation.md).

## Relay/Proxy Support

If you use a relay service (中转站) for API access, set `LLM_BASE_URL` to your relay endpoint:

- OpenAI-compatible relay: `https://your-relay.com/v1`
- Anthropic-compatible relay: `https://your-relay.com/anthropic`

The bot automatically normalizes the URL for the selected provider.

### OpenRouter Structured Outputs

OpenRouter users get model-native JSON Schema responses automatically when the selected model advertises support, without changing the public provider type:

```yaml
with:
  provider: openai
  model: openai/gpt-5.5
  api-key: ${{ secrets.LLM_API_KEY }}
  base-url: https://openrouter.ai/api/v1
  structured-output: auto
```

`auto` is the default and checks OpenRouter's public model metadata once per model per process. When the lookup fails or the model does not advertise Structured Outputs support, Repo Guard immediately uses the existing free-text request. When a structured request returns any non-empty text, Repo Guard keeps that response even if it does not match the schema and passes it through the existing normalizer without another model call. Only an error or a response with no usable text triggers one additional legacy free-text model call, which can add model cost. Set `structured-output: off` only when you want to skip metadata lookup and always use the existing free-text request.

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
