// @ts-check
import { supportsOpenRouterStructuredOutputs } from './openrouter-structured-output.mjs';

const STRUCTURED_OUTPUT_INSTRUCTION = [
  '',
  '## 本次响应序列化要求',
  '本次响应必须遵守请求携带的 JSON Schema。',
  'Schema 字段承载原 Markdown 输出契约的同等语义。',
  '不要输出 Markdown fence、额外解释或 schema 外字段。',
].join('\n');

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
      const body = await res.text();
      if (res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}: ${body}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${body}`);
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

function buildOpenAIRequest(model, messages, system, maxTokens) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...messages);
  return {
    model,
    messages: msgs,
    max_tokens: maxTokens,
    temperature: 0.3,
  };
}

function buildAnthropicRequest(model, messages, system, maxTokens) {
  return {
    model,
    system: system || undefined,
    messages,
    max_tokens: maxTokens,
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
  return typeof data.choices?.[0]?.message?.content === 'string'
    ? data.choices[0].message.content
    : '';
}

export async function chatCompletion({
  provider,
  model,
  apiKey,
  baseURL,
  maxTokens,
  messages,
  system,
  structuredOutputMode = 'auto',
  responseFormat,
}) {
  const base = normalizeBaseURL(provider, baseURL);

  if (provider === 'anthropic') {
    const url = `${base}/messages`;
    const body = buildAnthropicRequest(model, messages, system, maxTokens);
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
  const legacyBody = buildOpenAIRequest(model, messages, system, maxTokens);
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
    return requestOpenAI({ url, apiKey, body: legacyBody });
  }

  console.log('structured output: enabled');
  const structuredBody = {
    ...buildOpenAIRequest(
      model,
      messages,
      system ? `${system}${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION.trimStart(),
      maxTokens,
    ),
    response_format: responseFormat,
    provider: { require_parameters: true },
  };

  let structuredError;
  try {
    const content = await requestOpenAI({ url, apiKey, body: structuredBody });
    if (hasUsableText(content)) {
      console.log('structured output returned usable text, normalizing without retry');
      return content;
    }
  } catch (error) {
    structuredError = error;
  }

  console.warn('structured output produced no usable text, falling back once');
  try {
    return await requestOpenAI({ url, apiKey, body: legacyBody });
  } catch (fallbackError) {
    if (structuredError && fallbackError.cause === undefined) fallbackError.cause = structuredError;
    throw fallbackError;
  }
}
