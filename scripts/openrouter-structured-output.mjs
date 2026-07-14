// @ts-check

const capabilityCache = new Map();

export function parseStructuredOutputMode(value = '') {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'auto') return mode;
  throw new Error('LLM_STRUCTURED_OUTPUT must be "off" or "auto"');
}

export async function supportsOpenRouterStructuredOutputs({
  mode,
  provider,
  baseURL,
  model,
  fetchImpl = fetch,
}) {
  if (!isOpenRouterTarget({ mode, provider, baseURL })) return false;

  const key = `${baseURL}\n${model}`;
  if (!capabilityCache.has(key)) {
    capabilityCache.set(key, probeModel(baseURL, model, fetchImpl));
  }
  return capabilityCache.get(key);
}

export function clearOpenRouterCapabilityCache() {
  capabilityCache.clear();
}

function isOpenRouterTarget({ mode, provider, baseURL }) {
  if (mode !== 'auto' || provider !== 'openai') return false;
  try {
    return new URL(baseURL).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

async function probeModel(baseURL, model, fetchImpl) {
  try {
    const modelPath = String(model).split('/').map(encodeURIComponent).join('/');
    const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/model/${modelPath}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload?.data?.supported_parameters) &&
      payload.data.supported_parameters.includes('structured_outputs');
  } catch {
    return false;
  }
}
