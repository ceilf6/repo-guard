import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearOpenRouterCapabilityCache,
  parseStructuredOutputMode,
  supportsOpenRouterStructuredOutputs,
} from '../scripts/openrouter-structured-output.mjs';

test.beforeEach(() => clearOpenRouterCapabilityCache());

test('parseStructuredOutputMode defaults to auto and accepts explicit off', () => {
  assert.equal(parseStructuredOutputMode(), 'auto');
  assert.equal(parseStructuredOutputMode(''), 'auto');
  assert.equal(parseStructuredOutputMode('off'), 'off');
  assert.equal(parseStructuredOutputMode('auto'), 'auto');
});

test('parseStructuredOutputMode rejects unknown values', () => {
  assert.throws(
    () => parseStructuredOutputMode('true'),
    /LLM_STRUCTURED_OUTPUT must be "off" or "auto"/,
  );
});

test('capability probe ignores off, anthropic, and non-OpenRouter targets', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('must not fetch');
  };

  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'off',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5',
    fetchImpl,
  }), false);
  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'auto',
    provider: 'anthropic',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude',
    fetchImpl,
  }), false);
  assert.equal(await supportsOpenRouterStructuredOutputs({
    mode: 'auto',
    provider: 'openai',
    baseURL: 'https://relay.example.com/v1',
    model: 'openai/gpt-5.5',
    fetchImpl,
  }), false);
  assert.equal(calls, 0);
});

test('probe recognizes structured_outputs and encodes model path segments', async () => {
  const calls = [];
  const supported = await supportsOpenRouterStructuredOutputs({
    mode: 'auto',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5:floor',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ data: { supported_parameters: ['response_format', 'structured_outputs'] } }),
      };
    },
  });

  assert.equal(supported, true);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/model/openai/gpt-5.5%3Afloor');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
  assert.equal('Authorization' in calls[0].options.headers, false);
});

test('probe failures and missing parameters use legacy behavior', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ data: {} }) }),
    async () => { throw new Error('offline'); },
  ]) {
    clearOpenRouterCapabilityCache();
    assert.equal(await supportsOpenRouterStructuredOutputs({
      mode: 'auto',
      provider: 'openai',
      baseURL: 'https://openrouter.ai/api/v1',
      model: 'openai/test',
      fetchImpl,
    }), false);
  }
});

test('same model shares an in-flight capability request', async () => {
  let calls = 0;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const config = {
    mode: 'auto',
    provider: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5',
    fetchImpl: async () => {
      calls += 1;
      return responsePromise;
    },
  };

  const first = supportsOpenRouterStructuredOutputs(config);
  const second = supportsOpenRouterStructuredOutputs(config);
  resolveResponse({
    ok: true,
    json: async () => ({ data: { supported_parameters: ['structured_outputs'] } }),
  });

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1);
});
