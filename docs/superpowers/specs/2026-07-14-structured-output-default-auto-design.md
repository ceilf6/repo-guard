# Structured Outputs Default Auto Design

**日期：** 2026-07-14
**状态：** 已确认

## 目标

Repo Guard 的 Structured Outputs 模式默认启用自动探测。未配置或配置为空时使用 `auto`；只有显式配置 `off` 时，才完全使用原有自由文本请求。

## 设计

保留公开配置值 `off|auto`，不引入新枚举或 provider：

- `parseStructuredOutputMode()` 将缺失值和空字符串解析为 `auto`。
- `chatCompletion()` 的直接调用默认值改为 `auto`。
- Composite Action 的 `structured-output` input 默认值改为 `auto`。
- 内置 workflow 在 `LLM_STRUCTURED_OUTPUT` 未配置时传入 `auto`。
- 质量评估的短变量和 `LLM_*` 变量遵循同一默认语义。

显式 `off` 继续跳过 OpenRouter 元数据探测和 Schema 参数，直接发送原自由文本请求。非法值继续快速报错。

## 保持不变的行为

- 仅 `provider=openai` 且 base URL 主机为 `openrouter.ai` 时进行能力探测。
- 能力探测失败或模型未声明 `structured_outputs` 时立即使用自由文本请求。
- Structured Outputs 首次调用返回任何非空文本时直接使用，不因 Schema 校验失败再次调用模型。
- 首次调用报错或没有非空文本时，只追加一次原自由文本调用。
- Anthropic 和非 OpenRouter 的 OpenAI-compatible 服务保持原请求体。

## 测试与验收

- 缺失值、空字符串解析为 `auto`。
- 显式 `off` 仍返回 `off`，非法值仍报错。
- 质量评估缺省配置为 `auto`，短变量优先级不变。
- Action 和两个 workflow 的声明默认值均为 `auto`。
- LLM 客户端的显式 `off` 隔离测试继续证明不探测、不携带 Structured Outputs 参数。
- 全量静态检查和单元测试通过。
