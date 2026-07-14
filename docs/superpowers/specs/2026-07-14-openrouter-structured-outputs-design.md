# OpenRouter Structured Outputs 设计

**日期：** 2026-07-14
**状态：** 已确认
**范围：** Repo Guard 的 PR 评审、Issue 分析、外部 dispatcher 和质量评估

## 背景

Repo Guard 当前通过 `scripts/llm-client.mjs` 支持两种请求格式：

- `provider=openai` 使用 OpenAI-compatible `/chat/completions`；OpenRouter 也复用这条路径。
- `provider=anthropic` 使用 Anthropic `/messages`。

模型输出目前是字符串。上层先清理 thinking block，再由 `normalizeReviewResponse` 把契约 Markdown、结构化 JSON、非契约文本或不可解析 JSON-like 内容归一化为 Repo Guard 的 GitHub Markdown 契约。这套容错能避免发布格式失控，但不能在生成阶段保证字段完整。

OpenRouter 支持 `response_format.type=json_schema`、`strict=true` 和 `provider.require_parameters=true`。其 Models API 还会通过 `supported_parameters` 声明模型是否支持 `structured_outputs`。当前使用配置为：

- `LLM_PROVIDER=openai`
- `LLM_BASE_URL=https://openrouter.ai/api/v1`
- `LLM_MODEL=openai/gpt-5.5`

2026-07-14 查询到的 `openai/gpt-5.5` 元数据同时声明支持 `structured_outputs` 和 `response_format`。

## 目标

1. 允许显式开启 OpenRouter Structured Outputs，使 PR 与 Issue 输出在模型侧尽量匹配完整 JSON Schema。
2. 默认关闭新能力，确保现有 OpenAI-compatible、Anthropic 和其他中转服务的行为不变。
3. Structured Outputs 不可用时自动使用现有自由文本路径。
4. 第一次结构化调用只要返回非空模型文本，就保留该信息，不因 schema 不合规而重复调用。
5. 第一次结构化调用没有返回可用文本时，允许追加一次旧版自由文本调用。
6. 所有最终输出继续通过同一个 Markdown 归一化与发布流程。
7. 覆盖生产 PR/Issue 评审、外部 dispatcher 和质量评估脚本。

## 非目标

- 不新增 `openrouter` provider，也不要求用户修改现有 `LLM_PROVIDER=openai`。
- 不为 Anthropic 原生请求或其他 OpenAI-compatible 服务自动增加 Structured Outputs。
- 不启用 OpenRouter Response Healing 插件。
- 不引入流式响应。
- 不替换现有 Markdown 展示契约、GitHub 发布逻辑或行级评论校验。
- 不新增 OpenRouter SDK；继续使用原生 `fetch`。
- 不为模型能力维护静态白名单。

## 方案选择

采用“能力探测 + 严格 schema + 内容感知降级”。

未采用的方案：

- 直接乐观发送 schema：实现略少，但不支持 schema 的模型会浪费一次生成请求。
- 新增 `openrouter` provider：隔离更强，但需要配置迁移并扩大 provider 维护面，不符合当前最小改动目标。

## 用户配置

新增环境变量：

```text
LLM_STRUCTURED_OUTPUT=off|auto
```

新增 GitHub Action input：

```text
structured-output: off|auto
```

语义：

- `off`：默认值。完全沿用现有请求路径，不查询模型元数据，不添加请求参数，不修改 prompt。
- `auto`：只有在 `provider=openai` 且规范化后的 base URL hostname 严格等于 `openrouter.ai` 时才探测能力。其他 endpoint 直接使用现有自由文本路径。
- 其他值：在开始 LLM 调用前报告配置错误，防止拼写错误静默改变行为。

配置需要贯穿：

- `action.yml` 到 `scripts/review.mjs`
- `.github/workflows/repo-guard.yml`
- `.github/workflows/external-repo-guard.yml` 到 `scripts/external-dispatcher.mjs`
- `scripts/evaluate-quality.mjs`
- `scripts/pr-reviewer.mjs` 的 PR 构建配置

仓库内 workflow 从 `vars.LLM_STRUCTURED_OUTPUT` 读取配置并以 `off` 为缺省值；启用由仓库变量显式完成。公共 Action input 的默认值同样保持 `off`。质量评估脚本遵循现有短变量优先约定，同时接受 `STRUCTURED_OUTPUT` 和 `LLM_STRUCTURED_OUTPUT`。

## 模块边界

### 配置解析

配置层只负责把 `off|auto` 解析为已校验值并传入调用链。它不判断模型能力，也不构造 schema。

### OpenRouter 能力探测

能力探测模块负责回答一个问题：给定 `baseURL + model`，当前 OpenRouter 模型是否声明支持 `structured_outputs`。

约束：

- 只接受已经过 URL 规范化并确认 hostname 为 `openrouter.ai` 的地址。
- 使用 OpenRouter Models API 的单模型元数据端点。
- 模型 slug 按 path segment 安全编码，同时保留 `author/model` 的层级。
- 元数据查询不携带 API key；该端点是公开模型元数据接口。
- 只发起一次 GET，不对元数据请求做独立重试。
- 查询、解析或字段缺失均视为“不支持”，随后安静地使用自由文本路径。
- 按 `normalizedBaseURL + model` 做进程内缓存；缓存进行中的 Promise，以合并同一进程内的并发查询。
- 缓存只影响性能，不持久化到磁盘，不跨 Action run。

### 评审契约

新增独立评审契约模块，避免继续扩大已经承担大量容错工作的 `review-logic.mjs`。该模块拥有：

- PR JSON Schema
- Issue JSON Schema
- OpenRouter `response_format` 包装
- 完整结构化对象到现有中文 Markdown 契约的确定性渲染

`review-logic.mjs` 继续作为所有字符串输出的统一归一化入口，并复用评审契约模块处理已识别的结构化对象。未知 JSON、自由文本和 JSON-like 安全外壳继续保留现有行为。

### LLM 客户端

`chatCompletion` 继续返回字符串。它新增可选的结构化调用配置，但不理解 PR 或 Issue 的业务字段；调用方传入对应的 `response_format`。

客户端负责：

- 判断是否进入 `auto` 路径。
- 调用能力探测。
- 构造结构化请求。
- 判定是否获得可用文本。
- 必要时只执行一次自由文本降级。

上层 PR、Issue、dispatcher 和质量评估无需建立第二套发布或评分流程。

## JSON Schema

所有 schema 均满足：

- 顶层类型为 object。
- `strict=true`。
- 每层 object 都设置 `additionalProperties=false`。
- 所有字段明确列入 `required`。
- 没有语义值时使用 `null`、空字符串或空数组，而不是省略字段。
- 机器枚举使用稳定英文值；本地渲染器转换为当前中文标签。
- 自然语言字段遵循现有 prompt 的语言要求。

### PR schema

顶层字段：

- `risk_level`: `LOW | MEDIUM | HIGH | CRITICAL`
- `recommendation`: `APPROVE | COMMENT | REQUEST_CHANGES | NEEDS_HUMAN`
- `decision_summary`: string
- `cascade_analysis`
- `findings`
- `karpathy_review`
- `missing_coverage`

`cascade_analysis` 包含：

- `changed_symbols`: string[]
- `affected_flows`: string[]
- `outside_changeset_callers`: string
- `confidence`: `high | medium | degraded`

每个 finding 包含：

- `severity`: `LOW | MEDIUM | HIGH | CRITICAL`
- `title`: string
- `evidence`: string
- `affected_flows`: string
- `smallest_viable_fix`: string
- `path`: string | null
- `line`: integer | null
- `inline_comment`: string | null

`path` 与 `line` 只是候选位置。现有 `extractInlineComments` 仍负责确认文件存在且行号属于真实变更行；schema 合法不代表可以绕过 GitHub inline comment 校验。

`karpathy_review` 包含 assumptions、simplicity、surgical scope 和 verification 四个文本字段。`missing_coverage` 为字符串数组。

### Issue schema

顶层字段：

- `quality_score`: 1 到 5 的整数
- `priority_suggestion`: `P0_CRITICAL | P1_HIGH | P2_MEDIUM | P3_LOW`
- `issue_type`: `BUG_REPORT | FEATURE_REQUEST | QUESTION | DISCUSSION`
- `maintainer_next_action`: `READY_TO_START | ASK_REPORTER | TRIAGE_DECISION | REPRODUCE`
- `completeness`
- `clarity`
- `actionability`
- `suggestions`: string[]
- `summary`: string

三个评估对象完整覆盖现有 Markdown 契约里的问题陈述、复现步骤、预期与实际、环境信息、支撑证据、标题质量、单一关注点、表达精确度、范围、是否可开始、验收标准和依赖。各字段使用与当前契约一一对应的英文枚举，本地映射为中文展示值。

## Prompt 处理

当前 system prompt 明确要求输出 Markdown，这与 `response_format=json_schema` 冲突。

仅在真正发送结构化请求时，客户端在原始 system prompt 末尾追加一段短指令：

- 本次响应必须遵守请求携带的 JSON Schema。
- schema 字段承载原 Markdown 契约要求的同等语义。
- 不输出 Markdown fence、额外解释或 schema 外字段。

自由文本请求，包括降级请求，必须使用未经追加的原始 system prompt。这样 `off`、不支持 schema 和降级路径都保持旧模型行为。

## 调用流程

1. 调用方根据评审类型选择 PR 或 Issue `response_format`，并把已校验的 structured output mode 传给 `chatCompletion`。
2. `off` 直接发送现有请求。
3. `auto` 检查 provider 与 hostname；不匹配则发送现有请求。
4. 查询或读取缓存中的模型能力。
5. 不支持或能力查询失败时发送现有请求。
6. 支持时发送结构化请求，请求体增加：
   - `response_format`，类型为 `json_schema`
   - `json_schema.strict=true`
   - `provider.require_parameters=true`
7. 读取 `choices[0].message.content`。
8. 如果得到可用文本，立即返回，不做第二次模型调用。
9. 如果没有得到可用文本，记录降级原因，并发送一次不含结构化参数、使用原始 prompt 的自由文本请求。
10. 返回第二次调用的文本；若第二次也失败，抛出错误。
11. 上层继续执行 thinking block 清理、归一化、行级评论提取、质量评分或 GitHub 发布。

## 可用文本与降级语义

“可用文本”定义为 `choices[0].message.content` 是字符串，且 `trim()` 后非空。其他类型不通过隐式字符串化伪装成模型文本。

以下第一次响应都视为可用，不触发降级：

- 完整匹配 schema 的 JSON。
- 合法但未完整匹配预期 schema 的 JSON。
- Markdown。
- 普通自由文本。
- 非空但不可解析的 JSON-like 文本。

这些内容进入现有归一化逻辑。尤其是非空 JSON-like 内容，继续使用现有安全外壳，不为了追求格式完美再次计费。

以下情况触发一次自由文本降级：

- 结构化 HTTP 请求最终抛错。
- 响应缺少 `choices[0].message.content`。
- content 为 null、空字符串或仅空白。

现有 `fetchWithRetry` 行为不变：网络异常与 5xx 在一次逻辑调用内部最多重试两次，普通 4xx 立即抛错。结构化逻辑调用在这些内部重试耗尽后，才执行一次自由文本降级。自由文本降级本身仍受相同的 `fetchWithRetry` 保护。

若降级也失败，抛出降级错误，并通过 error cause 保留第一次结构化失败信息，便于排障。

## 日志与安全

增加简短状态日志：

- `structured output: off`
- `structured output: unsupported, using legacy`
- `structured output: enabled`
- `structured output returned usable text, normalizing without retry`
- `structured output produced no usable text, falling back once`

日志不得输出：

- API key
- 完整请求 body
- 完整模型响应
- GitHub token

能力探测失败可以记录简短原因，但不能把它提升为评审失败。结构化请求与降级请求的错误仍沿用当前错误出口。

## 向后兼容

必须满足：

- 未配置新 input 或环境变量时等价于 `off`。
- `off` 时不发模型元数据请求。
- `off` 时 OpenAI 与 Anthropic 请求 body 保持现有字段和 prompt。
- `auto` 配合非 OpenRouter base URL 时不发元数据请求，也不添加 OpenRouter 参数。
- `provider=anthropic` 永远不进入本设计的结构化路径。
- 现有 `provider`、`model`、`base-url`、`api-key` 和 `max-tokens` 输入含义不变。
- GitHub Markdown、recommendation 到 review event 的映射以及 inline comment 安全校验不变。

## 测试策略

自动化测试不调用真实 GitHub 或 LLM API，全部使用 mock fetch。

### 配置测试

- 缺省值解析为 `off`。
- `off` 与 `auto` 被接受。
- 其他值在调用前报告明确错误。
- Action input、生产脚本、dispatcher 和质量评估均正确透传配置。

### 能力探测测试

- 仅 `openai + openrouter.ai + auto` 发起元数据 GET。
- `structured_outputs` 存在时返回支持。
- 参数缺失、非预期 JSON、HTTP 错误和网络错误均返回不支持。
- 相同 `baseURL + model` 在一个进程内只查询一次。
- 并发查询共享同一个 in-flight Promise。
- 不向元数据请求添加 API key。

### LLM 客户端测试

- `off` 的请求体与现有 OpenAI、Anthropic 请求一致。
- 不支持 schema 时只发送一次旧请求。
- 支持时请求包含严格 schema 和 `provider.require_parameters=true`。
- 结构化 prompt 包含 JSON 覆盖指令，自由文本 prompt 不包含。
- 第一次返回 schema JSON 时不降级。
- 第一次返回非空 Markdown、普通文本或 malformed JSON-like 内容时不降级。
- 第一次抛错、缺少 content 或返回空白时恰好降级一次。
- 降级请求彻底移除 `response_format`、`provider` 路由参数和临时 JSON 指令。
- 第二次失败时向上抛错并保留第一次失败 cause。

### 契约与归一化测试

- 完整 PR JSON 映射到当前所有 Markdown 字段与章节。
- 完整 Issue JSON 映射到当前所有 Markdown 字段与章节。
- 枚举稳定映射为中文标签。
- null 行号不会产生 inline comment。
- schema 中存在 path/line 也必须经过现有变更行校验。
- 未识别 JSON、自由文本和 JSON-like 安全外壳的现有测试继续通过。
- `normalizeReviewResponse` 保持幂等。

### 调用场景测试

- PR 评审选择 PR schema。
- Issue 分析选择 Issue schema。
- external dispatcher 复用 PR schema。
- quality evaluator 根据 fixture 类型选择 PR 或 Issue schema。
- quality evaluator 的多个 fixture 复用能力缓存。

## 文档

更新：

- `README.md` 配置表和 OpenRouter 示例。
- `action.yml` input 描述。
- 仓库内两个 workflow 示例。
- `docs/quality-evaluation.md`。

文档必须明确：

- 默认关闭，不影响现有 provider。
- `auto` 只在 OpenRouter 官方 hostname 上工作。
- 模型能力查询失败时直接使用旧输出。
- 结构化调用没有产出有效文本时，可能追加一次模型调用并产生相应费用。
- 非空但 schema 不合规的输出不会触发第二次调用。

## 验收标准

1. 未设置新配置时，现有测试与请求行为保持不变。
2. 当前 OpenRouter 配置在 `auto` 下识别 `openai/gpt-5.5` 的 structured output 能力。
3. 支持模型的 PR 与 Issue 请求携带严格且完整的各自 schema。
4. 完整结构化响应能无信息缩水地渲染为现有 Markdown 契约。
5. 任意非空首次模型文本都不会产生第二次调用。
6. 首次没有可用文本时只追加一次旧版自由文本调用。
7. 非 OpenRouter、Anthropic 和默认 `off` 路径不接收 OpenRouter 专用参数。
8. PR、Issue、dispatcher 和质量评估全部覆盖。
9. 自动化测试不产生真实 LLM 调用或费用。
