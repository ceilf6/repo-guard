# Structured Outputs Minimal Contract Design

**日期：** 2026-07-14
**状态：** 已确认

## 背景

Repo Guard 当前把完整 PR 和 Issue 展示模板编码为严格 JSON Schema。该设计能稳定 recommendation、行级位置和评分字段，但也要求模型一次性满足大量深层字段、枚举和嵌套对象。最新真实运行已经出现 Structured 请求快速失败、Legacy fallback 最终没有可用文本，却发布了默认“风险中 / 建议评论”占位报告的问题。

用户要求保留当前全部评审内容，不删除级联分析、问题发现、行级发现、Karpathy 评审、缺失覆盖，以及 Issue 的完整性、清晰度、可执行性、建议和总结。

## 目标

1. Schema 只严格约束机器必须稳定消费的骨架。
2. 所有现有评审内容和 Markdown 章节继续完整发布。
3. recommendation 到 GitHub Review event 的映射和行级评论定位保持不变。
4. 兼容旧版完整 Schema、自由文本和现有 Markdown 输入。
5. Structured 请求只携带路由端明确需要且模型支持的参数。
6. Structured 与 Legacy 两次调用都无有效文本时，不发布伪评审。
7. 诊断日志能区分 HTTP 错误、空 content 和 token/finish 状态，但不记录 prompt、diff、API key 或完整模型正文。

## 方案选择

采用“结构化骨架 + 完整内容块”。

未采用：

- 仅保留机器字段并增加一个 `report_markdown`：自由度最高，但 machine fields 与 Markdown 可能互相矛盾。
- 保留当前完整 Schema 并把字段改为 nullable：改动较小，但模型仍需生成大量深层属性，且合法空值会造成内容缩水。
- 完全取消 Schema：兼容性最高，但 recommendation、行级位置和下游消费重新依赖正则猜测。

## PR V2 契约

保留以下严格字段：

- `risk_level`: `LOW | MEDIUM | HIGH | CRITICAL`
- `recommendation`: `APPROVE | COMMENT | REQUEST_CHANGES | NEEDS_HUMAN`
- `decision_summary`: string
- `cascade_analysis`: string
- `findings`: array
- `karpathy_review`: string
- `missing_coverage`: string[]

每个 finding 包含：

- `severity`: `LOW | MEDIUM | HIGH | CRITICAL`
- `title`: string
- `details`: string，完整包含证据、受影响流程和最小可行修复
- `path`: string | null
- `line`: positive integer | null
- `inline_comment`: string | null

`cascade_analysis` 必须在一个自由内容块内覆盖变更符号、受影响流程、变更集外调用方和置信度。`karpathy_review` 必须覆盖假设、简洁性、变更范围和验证。Schema 不再把这些写作维度拆成深层 required 属性。

## Issue V2 契约

保留以下严格字段：

- `quality_score`: integer 1..5
- `priority_suggestion`: `P0_CRITICAL | P1_HIGH | P2_MEDIUM | P3_LOW`
- `issue_type`: `BUG_REPORT | FEATURE_REQUEST | QUESTION | DISCUSSION`
- `maintainer_next_action`: `READY_TO_START | ASK_REPORTER | TRIAGE_DECISION | REPRODUCE`
- `completeness`: string
- `clarity`: string
- `actionability`: string
- `suggestions`: string[]
- `summary`: string

三个内容块仍分别覆盖当前完整 rubric，只是不再要求每个维度成为独立 JSON 属性。

## Markdown 输出兼容

最终 PR 评论继续包含：

- 风险等级
- 处理建议
- 决策摘要
- 级联分析
- 问题发现
- 行级发现
- Karpathy 评审
- 缺失覆盖

最终 Issue 评论继续包含质量评分、优先级、类型、维护者下一步动作、完整性、清晰度、可执行性、建议和总结。

V2 渲染器直接把完整内容块放回原章节。V1 canonical 对象继续由旧渲染器处理；现有 tolerant JSON 和自由文本归一化分支不删除。

## Structured 请求

Legacy 请求继续使用当前 request body，包括 `temperature: 0.3`。

Structured 请求不发送 `temperature`，避免在 `provider.require_parameters=true` 时因模型未声明支持 temperature 而被 OpenRouter 路由拒绝。Structured 请求继续携带：

- `model`
- `messages`
- `max_tokens`
- `response_format`
- `provider.require_parameters=true`

能力探测、`auto|off` 配置和缓存语义不变。

## 响应与降级

第一次 Structured 调用返回任何非空 content 时仍立即使用，即使文本未匹配 Schema；不因解析失败产生第二次模型调用。

第一次调用抛错、缺少 content 或返回空白时，执行一次原始 Legacy 请求。Legacy 请求返回非空文本时照常归一化。若 Legacy 也没有非空文本，则抛出明确运行错误，不发布默认风险、默认 recommendation 或伪问题发现，也不进行第三次调用。

## 安全诊断

每次 OpenAI-compatible 响应内部保留以下元数据供日志使用：

- `finish_reason`
- prompt、completion、reasoning token count（存在时）
- content 是否为非空
- Structured 请求的 HTTP 状态和截断后的安全错误摘要

日志不得包含 API key、完整请求 body、prompt、diff、完整 content 或 reasoning 正文。

## 测试与验收

- V2 Schema 每层仍为 strict object，拒绝未知属性。
- V2 PR 和 Issue fixture 能表达并渲染当前所有内容维度。
- Markdown 章节、recommendation mapping 和 inline extraction 与现有契约兼容。
- V1 canonical、tolerant JSON、Markdown 和自由文本测试继续通过。
- Structured request 不含 `temperature`；Legacy request 仍含 `temperature: 0.3`。
- Structured 非空非 Schema 文本不触发 fallback。
- Structured 空/错误只触发一次 Legacy。
- Structured 与 Legacy 都空时抛错，不生成占位评审，不产生第三次调用。
- 日志只包含安全响应元数据。
- PR、Issue、external dispatcher 和 quality evaluator 全部使用 V2 Schema。
- `npm run check` 和 `npm test` 全量通过。
- 有可用 API key 时运行一次 `npm run eval:quality`；没有凭据时明确记录未执行 live evaluation，不伪称已验证真实模型。
