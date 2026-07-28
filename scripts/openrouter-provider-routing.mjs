// @ts-check

// OpenRouter routes `provider.order` on lowercase provider slugs, not display
// names, so a configured "Azure" is normalized instead of failing upstream.
export function parseProviderOrder(value = '') {
  const configured = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const order = [];
  const seen = new Set();
  for (const entry of configured) {
    const slug = entry.toLowerCase();
    if (seen.has(slug)) {
      throw new Error(`LLM_PROVIDER_ORDER contains duplicate provider "${entry}" (slug "${slug}")`);
    }
    seen.add(slug);
    order.push(slug);
  }
  return order;
}

export function buildProviderRouting({ order = [], requireParameters = false } = {}) {
  const routing = {};
  if (order.length) routing.order = [...order];
  if (requireParameters) routing.require_parameters = true;
  return Object.keys(routing).length > 0 ? routing : undefined;
}
