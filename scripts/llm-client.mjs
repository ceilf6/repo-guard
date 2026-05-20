// @ts-check

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

export async function chatCompletion({ provider, model, apiKey, baseURL, maxTokens, messages, system }) {
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
  const body = buildOpenAIRequest(model, messages, system, maxTokens);
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}
