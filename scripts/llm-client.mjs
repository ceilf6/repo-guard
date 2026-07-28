// @ts-check
import { buildProviderRouting } from './openrouter-provider-routing.mjs';
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
      const detail = await safeErrorDetail(res);
      if (res.status >= 500 && attempt < retries) {
        lastError = httpError(res.status, detail);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw httpError(res.status, detail);
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

function httpError(status, detail = '') {
  const error = new Error(detail ? `HTTP ${status} (${detail})` : `HTTP ${status}`);
  error.status = status;
  if (detail) error.detail = detail;
  return error;
}

const MAX_ERROR_MESSAGE_CHARS = 200;
// `Bearer <token>` is matched before bare tokens so the scheme prefix is
// redacted with the credential instead of being left behind as a hint.
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\bsk-[A-Za-z0-9._-]{8,}/g,
];

// Failed requests are diagnosed from the rejection alone, so a rejected review
// must say why. Providers only populate the classifier fields for pass-through
// and guardrail errors, so `error.message` is included too — bounded, since a
// relay may echo the request into it and Actions logs are readable by anyone
// who can read the repository. A non-JSON body (relay HTML, edge block) is
// described by shape instead of content.
async function safeErrorDetail(response) {
  let body;
  try {
    body = await response.text();
  } catch {
    return '';
  }

  let error;
  try {
    error = JSON.parse(body)?.error;
  } catch {
    const contentType = response.headers?.get?.('content-type') || 'unknown';
    return `non-JSON body: content_type=${contentType.split(';')[0]}, body_chars=${body.length}`;
  }

  const fields = [];
  for (const [label, value] of [
    ['error_type', error?.metadata?.error_type],
    ['provider', error?.metadata?.provider_name],
    ['provider_code', error?.metadata?.provider_code],
    ['message', boundedErrorMessage(error?.message)],
  ]) {
    if (typeof value === 'string' && value.trim() !== '') fields.push(`${label}=${value.trim()}`);
  }
  return fields.length > 0 ? fields.join(', ') : `body_chars=${body.length}`;
}

function boundedErrorMessage(message) {
  if (typeof message !== 'string') return '';
  let redacted = message.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]');
  }
  return redacted.length > MAX_ERROR_MESSAGE_CHARS
    ? `${redacted.slice(0, MAX_ERROR_MESSAGE_CHARS)}…(truncated)`
    : redacted;
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

async function parseJsonResponse(response, providerLabel) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${providerLabel} provider returned invalid JSON`);
  }
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
  const data = await parseJsonResponse(res, 'OpenAI-compatible');
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
    ['content_chars', response.content.length],
  ]) {
    if (Number.isFinite(value)) fields.push(`${label}=${value}`);
  }
  return fields.join(', ');
}

function safeErrorLabel(error) {
  if (Number.isInteger(error?.status)) {
    return error.detail ? `HTTP ${error.status} (${error.detail})` : `HTTP ${error.status}`;
  }
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
  providerOrder = [],
  responseFormat,
}) {
  const base = normalizeBaseURL(provider, baseURL);

  if (provider === 'anthropic') {
    if (providerOrder.length > 0) {
      console.warn('provider order ignored: Anthropic Messages has no provider routing');
    }
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
    const data = await parseJsonResponse(res, 'Anthropic');
    return data.content?.[0]?.text || '';
  }

  // OpenAI-compatible
  const url = `${base}/chat/completions`;
  if (providerOrder.length > 0) {
    console.log(`provider routing order: ${providerOrder.join(' > ')}`);
  }
  const legacyBody = buildOpenAIRequest(model, messages, system);
  const legacyRouting = buildProviderRouting({ order: providerOrder });
  if (legacyRouting) legacyBody.provider = legacyRouting;
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
    if (hasUsableText(result.content)) {
      console.log(`legacy output returned usable text: ${responseDiagnostics(result)}`);
      return result.content;
    }
    console.warn(`legacy output empty: ${responseDiagnostics(result)}`);
    throw new Error('No usable model content');
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
    provider: buildProviderRouting({ order: providerOrder, requireParameters: true }),
  };

  let structuredError;
  try {
    const result = await requestOpenAI({ url, apiKey, body: structuredBody });
    if (hasUsableText(result.content)) {
      console.log(`structured output returned usable text, normalizing without retry: ${responseDiagnostics(result)}`);
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
    if (hasUsableText(result.content)) {
      console.log(`legacy output returned usable text: ${responseDiagnostics(result)}`);
      return result.content;
    }
    console.warn(`legacy output empty: ${responseDiagnostics(result)}`);
    const error = new Error('No usable model content after structured and legacy attempts');
    if (structuredError) error.cause = structuredError;
    throw error;
  } catch (fallbackError) {
    if (structuredError && fallbackError.cause === undefined) fallbackError.cause = structuredError;
    throw fallbackError;
  }
}
