# Provider-native Output Token Budget Design

**日期：** 2026-07-14
**状态：** 已确认
**范围：** Repo Guard 的生产 PR/Issue 评审、external dispatcher、质量评估和公共 Action 配置

## 背景

真实运行 `ceilf6/resume#63` 使用 `openai/gpt-5.5`、OpenRouter Structured Outputs 和 `max-tokens: 4096`。请求返回 HTTP 成功与非空 content，但本地归一化识别为不可解析 JSON-like 内容，随后丢弃真实模型文本并发布了解析失败占位报告。

OpenRouter 将 `max_tokens` 定义为可选参数。`openai/gpt-5.5` 默认启用 medium reasoning，而 reasoning token 与最终文本共同占用 completion budget；固定 4096 会显著压缩完整评审 JSON 的空间。Anthropic 原生 Messages 请求不同：其官方 OpenAPI 请求类型将 `max_tokens` 定义为必填 number。

用户要求 Repo Guard 不再对无需该参数的协议主动设置 token 上限；协议必须携带时统一使用 16384。同时，任何非空模型响应仍应被视为有效信息，不得因为 JSON 损坏而替换成只描述解析失败的伪评审，也不得为格式问题追加模型调用。

## 目标

1. OpenAI-compatible 请求不发送 `max_tokens`，包括 OpenRouter Structured、Legacy、fallback 和非 OpenRouter relay。
2. Anthropic 原生 Messages 请求固定发送 `max_tokens: 16384`。
3. 删除 Repo Guard 公共 `max-tokens` / `LLM_MAX_TOKENS` 配置和 4096 默认值。
4. 非空 Structured content 永远不因 schema、JSON 语法或 `finish_reason=length` 触发第二次模型调用。
5. 可恢复的截断 JSON 尽量恢复并进入现有 V2/V1/tolerant 渲染器。
6. 无法恢复的非空内容安全保留原始模型文本，不再生成“不可解析 JSON-like”问题发现。
7. 所有非空与空 OpenAI-compatible 响应记录安全的 finish/token 元数据，不记录 prompt、diff、API key、reasoning 正文或模型正文。

## 非目标

- 不改变模型选择、Structured Outputs `auto|off` 语义或能力缓存。
- 不降低 reasoning effort。
- 不启用第二次格式修复模型调用。
- 不把 OpenRouter Response Healing 当成截断恢复方案；其官方限制明确说明无法修复 `max_tokens` 截断。
- 不改变 recommendation 到 GitHub Review event 的映射。
- 不为未知 relay 猜测私有 token 参数。

## 参数策略

### OpenAI-compatible

`buildOpenAIRequest` 不再接收 output token budget，也不输出 `max_tokens` 或 `max_completion_tokens`。适用范围：

- OpenRouter Structured 请求
- OpenRouter Legacy fallback
- `structured-output: off`
- 不支持 Structured Outputs 的 OpenRouter 模型
- 非 OpenRouter 的 OpenAI-compatible relay

模型仍受 provider 的 completion hard limit 和 context window 约束；Repo Guard 只是不再额外施加 4096 软上限。

### Anthropic Messages

新增内部常量：

```text
ANTHROPIC_MAX_TOKENS=16384
```

`buildAnthropicRequest` 始终发送该值。它不是用户配置，也不复用已删除的 `LLM_MAX_TOKENS`。这样满足 Anthropic 协议要求，同时避免公共配置表现出跨 provider 的虚假一致性。

### 公共配置移除

删除：

- `action.yml` 的 `max-tokens` input
- 生产与 external workflow 的 `LLM_MAX_TOKENS`
- `scripts/review.mjs`、`scripts/external-dispatcher.mjs` 和 `scripts/evaluate-quality.mjs` 的 max token 解析与校验
- `buildPRReview`、`chatCompletion` 和各调用点的 `maxTokens` 参数
- README 与质量评估文档中的公共配置说明

现有 workflow 若显式传入 `max-tokens`，升级后需要删除该 input；Repo Guard 不静默接受再忽略它。

## 响应处理

### 非空 content

`chatCompletion` 仍返回 string。只要 content trim 后非空，就立即返回，不因以下情况 fallback：

- `finish_reason=length`
- Schema 不匹配
- JSON 不完整或包含额外包装
- 普通 Markdown 或自由文本

日志附加 `finish_reason`、prompt/completion/reasoning token count 和 content 字符数。日志不包含 content 本身。

### JSON 恢复

归一化依次执行：

1. 解析完整 JSON。
2. 对以 `{` 或 `[` 开始的非空 JSON-like 文本执行保守的截断恢复：只补齐未闭合字符串、数组和对象，处理 EOF 前的悬空转义、冒号或逗号，不改写已有字段值。
3. 恢复后可解析时，继续使用 V2、V1 或 tolerant formatter；不要求恢复结果完整匹配 Schema。
4. 无法恢复时，生成固定 Markdown 外壳并在安全的 preformatted block 中保留原始模型文本。该外壳只说明“模型返回了非空的非契约内容”，不虚构代码风险、发现、证据或修复建议。

PR 的最终兜底 recommendation 为 COMMENT；Issue 的最终兜底 maintainer action 为需要分诊决策。原始内容经过 HTML escaping，避免模型文本注入 GitHub Markdown/HTML 结构。

### 空 content 或请求错误

保持现有语义：Structured 请求错误、缺失 content 或空白时执行一次 Legacy 请求。Legacy 也为空或报错时明确失败，不发布占位评审，不进行第三次逻辑调用。

## 兼容性

- Anthropic 请求保持协议有效，固定 budget 从当前默认 4096 提高为 16384。
- OpenAI-compatible 服务不再接收 Repo Guard 人为 token 上限；这是用户确认的行为变化。
- Structured `auto|off`、provider、model、base URL、API key 和 prompt 行为不变。
- V2、V1、tolerant JSON、Markdown 和自由文本归一化继续兼容。
- 无法解析的非空 JSON-like 输出从“丢弃原文并发布伪问题”改为“恢复或保留真实内容”。

## 测试与验收

- 所有 OpenAI-compatible 请求体都不含 `max_tokens` 与 `max_completion_tokens`。
- Structured error/empty 后的 Legacy body 同样不含 token 上限。
- Anthropic body 精确包含 `max_tokens: 16384`。
- Action、workflow、runtime config 和质量评估不再暴露或解析公共 max token 配置。
- 非空响应日志包含安全 finish/token/字符数元数据且不含模型正文。
- 仅缺闭合符号的截断 V2 JSON 能恢复并保留已有决策与内容 marker。
- 无法恢复的非空 JSON-like 内容原样出现在安全兜底区，不再出现“模型输出是不可解析 JSON-like 内容”伪 finding。
- `finish_reason=length` 的非空内容不会触发 Legacy。
- Structured 空/错误只触发一次 Legacy；双空无第三次调用。
- 全量静态检查和测试通过。
- 有真实 API key 时运行质量评估；没有凭据时明确记录未执行。

## 参考

- [OpenRouter API Parameters](https://openrouter.ai/docs/api/reference/parameters)
- [OpenRouter Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter Response Healing](https://openrouter.ai/docs/guides/features/plugins/response-healing)
- [Anthropic official TypeScript SDK OpenAPI-generated Messages types](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)
