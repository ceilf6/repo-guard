// @ts-check
import { supportsOpenRouterStructuredOutputs } from './openrouter-structured-output.mjs';

const STRUCTURED_OUTPUT_INSTRUCTION = [
  '',
  '## 本次响应序列化要求',
  '本次响应必须遵守请求携带的 JSON Schema。',
  'Schema 字段承载原 Markdown 输出契约的同等语义。',
  '不要输出 Markdown fence、额外解释或 schema 外字段。',
].join('\n');
const ANTHROPIC_MAX_TOKENS = 16384;

/**
 * Normalize provider base URL to the correct API root.
 * Ported from FrontAgent's normalizeProviderBaseURL logic.
 */
export function normalizeBaseURL(provider, baseURL) {
  if (!baseURL) return getDefaultBaseURL(provider);
  const normalized = baseURL.replace(/\/+$/, '');
  if (provider === 'openai') {
    const stripped = normalized.replace(/\/chat\/completions$/, '');
    return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
  }
  if (provider === 'anthropic') {
    const stripped = normalized.replace(/\/messages$/, '');
    return stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
  }
  return normalized;
}

function getDefaultBaseURL(provider) {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
  return 'https://api.openai.com/v1';
}

async function fetchWithRetry(url, options, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      await res.text();
      if (res.status >= 500 && attempt < retries) {
        lastError = httpError(res.status);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw httpError(res.status);
    } catch (err) {
      if (err.message?.startsWith('HTTP')) throw err;
      if (attempt < retries) {
        lastError = err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw lastError || err;
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

function buildOpenAIRequest(model, messages, system, { temperature = true } = {}) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...messages);
  const body = {
    model,
    messages: msgs,
  };
  if (temperature) body.temperature = 0.3;
  return body;
}

function buildAnthropicRequest(model, messages, system) {
  return {
    model,
    system: system || undefined,
    messages,
    max_tokens: ANTHROPIC_MAX_TOKENS,
  };
}

function hasUsableText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

async function requestOpenAI({ url, apiKey, body }) {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    finishReason: choice?.finish_reason || '',
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
    },
  };
}

function responseDiagnostics(response) {
  const fields = [`finish_reason=${response.finishReason || 'unknown'}`];
  for (const [label, value] of [
    ['prompt_tokens', response.usage.promptTokens],
    ['completion_tokens', response.usage.completionTokens],
    ['reasoning_tokens', response.usage.reasoningTokens],
  ]) {
    if (Number.isFinite(value)) fields.push(`${label}=${value}`);
  }
  return fields.join(', ');
}

function safeErrorLabel(error) {
  if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
  return error?.name || 'Error';
}

export async function chatCompletion({
  provider,
  model,
  apiKey,
  baseURL,
  messages,
  system,
  structuredOutputMode = 'auto',
  responseFormat,
}) {
  const base = normalizeBaseURL(provider, baseURL);

  if (provider === 'anthropic') {
    const url = `${base}/messages`;
    const body = buildAnthropicRequest(model, messages, system);
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  // OpenAI-compatible
  const url = `${base}/chat/completions`;
  const legacyBody = buildOpenAIRequest(model, messages, system);
  const structuredSupported = responseFormat && await supportsOpenRouterStructuredOutputs({
    mode: structuredOutputMode,
    provider,
    baseURL: base,
    model,
  });

  if (!structuredSupported) {
    console.log(structuredOutputMode === 'off'
      ? 'structured output: off'
      : 'structured output: unsupported, using legacy');
    const result = await requestOpenAI({ url, apiKey, body: legacyBody });
    return result.content;
  }

  console.log('structured output: enabled');
  const structuredBody = {
    ...buildOpenAIRequest(
      model,
      messages,
      system ? `${system}${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION.trimStart(),
      { temperature: false },
    ),
    response_format: responseFormat,
    provider: { require_parameters: true },
  };

  let structuredError;
  try {
    const result = await requestOpenAI({ url, apiKey, body: structuredBody });
    if (hasUsableText(result.content)) {
      console.log('structured output returned usable text, normalizing without retry');
      return result.content;
    }
    console.warn(`structured output empty: ${responseDiagnostics(result)}`);
    structuredError = new Error('Structured request returned no usable model content');
  } catch (error) {
    structuredError = error;
    console.warn(`structured output failed: ${safeErrorLabel(error)}`);
  }

  console.warn('structured output produced no usable text, falling back once');
  try {
    const result = await requestOpenAI({ url, apiKey, body: legacyBody });
    if (hasUsableText(result.content)) return result.content;
    console.warn(`legacy output empty: ${responseDiagnostics(result)}`);
    const error = new Error('No usable model content after structured and legacy attempts');
    if (structuredError) error.cause = structuredError;
    throw error;
  } catch (fallbackError) {
    if (structuredError && fallbackError.cause === undefined) fallbackError.cause = structuredError;
    throw fallbackError;
  }
}
