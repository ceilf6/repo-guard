import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, normalizeBaseURL } from '../scripts/llm-client.mjs';
import { clearOpenRouterCapabilityCache } from '../scripts/openrouter-structured-output.mjs';
import { PR_REVIEW_RESPONSE_FORMAT } from '../scripts/review-contracts.mjs';

const originalFetch = global.fetch;

test.beforeEach(() => clearOpenRouterCapabilityCache());
test.afterEach(() => {
  global.fetch = originalFetch;
  clearOpenRouterCapabilityCache();
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function baseCompletionConfig(overrides = {}) {
  return {
    provider: 'openai',
    model: 'openai/gpt-5.5',
    apiKey: 'secret',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 4096,
    messages: [{ role: 'user', content: 'review' }],
    system: 'system prompt',
    structuredOutputMode: 'auto',
    responseFormat: PR_REVIEW_RESPONSE_FORMAT,
    ...overrides,
  };
}

test('normalizeBaseURL uses provider defaults', () => {
  assert.equal(normalizeBaseURL('openai', ''), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseURL('anthropic', ''), 'https://api.anthropic.com/v1');
});

test('normalizeBaseURL normalizes OpenAI-compatible relays', () => {
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1/chat/completions'), 'https://relay.example.com/v1');
});

test('normalizeBaseURL normalizes Anthropic-compatible relays', () => {
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com/v1/messages'), 'https://relay.example.com/v1');
});

test('off mode sends the legacy OpenAI request without probing', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return jsonResponse({ choices: [{ message: { content: 'legacy text' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig({ structuredOutputMode: 'off' }));

  assert.equal(result, 'legacy text');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal('response_format' in calls[0].body, false);
  assert.equal('provider' in calls[0].body, false);
  assert.equal(calls[0].body.messages[0].content, 'system prompt');
  assert.equal(calls[0].body.temperature, 0.3);
});

test('auto mode keeps non-OpenRouter OpenAI-compatible requests unchanged', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonResponse({ choices: [{ message: { content: 'relay text' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig({ baseURL: 'https://relay.example.com/v1' }));

  assert.equal(result, 'relay text');
  assert.equal(calls.length, 1);
  assert.equal('response_format' in calls[0].body, false);
  assert.equal('provider' in calls[0].body, false);
});

test('supported OpenRouter model sends strict response format and routing requirement', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    if (options.body) call.body = JSON.parse(options.body);
    calls.push(call);
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['response_format', 'structured_outputs'] } });
    }
    return jsonResponse({ choices: [{ message: { content: '{"recommendation":"COMMENT"}' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig());

  assert.equal(result, '{"recommendation":"COMMENT"}');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/model/openai/gpt-5.5');
  assert.deepEqual(calls[1].body.response_format, PR_REVIEW_RESPONSE_FORMAT);
  assert.deepEqual(calls[1].body.provider, { require_parameters: true });
  assert.equal('temperature' in calls[1].body, false);
  assert.match(calls[1].body.messages[0].content, /本次响应必须遵守请求携带的 JSON Schema/);
});

test('omitted mode defaults to OpenRouter capability detection', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    return jsonResponse({ choices: [{ message: { content: '{"recommendation":"COMMENT"}' } }] });
  };
  const config = baseCompletionConfig();
  delete config.structuredOutputMode;

  await chatCompletion(config);

  assert.deepEqual(calls, [
    'https://openrouter.ai/api/v1/model/openai/gpt-5.5',
    'https://openrouter.ai/api/v1/chat/completions',
  ]);
});

test('non-empty structured response is used without a fallback even when it is not JSON', async () => {
  for (const content of ['## Markdown review', '{malformed json']) {
    clearOpenRouterCapabilityCache();
    const modelBodies = [];
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      modelBodies.push(JSON.parse(options.body));
      return jsonResponse({ choices: [{ message: { content } }] });
    };

    assert.equal(await chatCompletion(baseCompletionConfig()), content);
    assert.equal(modelBodies.length, 1);
  }
});

test('structured request error falls back once with the original request', async () => {
  const modelBodies = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelBodies.push(JSON.parse(options.body));
    if (modelBodies.length === 1) return jsonResponse({ error: { message: 'invalid schema' } }, 400);
    return jsonResponse({ choices: [{ message: { content: 'legacy fallback' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig());

  assert.equal(result, 'legacy fallback');
  assert.equal(modelBodies.length, 2);
  assert.deepEqual(modelBodies[0].provider, { require_parameters: true });
  assert.equal('response_format' in modelBodies[1], false);
  assert.equal('provider' in modelBodies[1], false);
  assert.equal(modelBodies[1].messages[0].content, 'system prompt');
  assert.equal('temperature' in modelBodies[0], false);
  assert.equal(modelBodies[1].temperature, 0.3);
});

test('missing or blank structured content falls back once', async () => {
  for (const firstPayload of [
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: '   ' } }] },
  ]) {
    clearOpenRouterCapabilityCache();
    let modelCalls = 0;
    global.fetch = async (url) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      modelCalls += 1;
      if (modelCalls === 1) return jsonResponse(firstPayload);
      return jsonResponse({ choices: [{ message: { content: 'legacy fallback' } }] });
    };

    assert.equal(await chatCompletion(baseCompletionConfig()), 'legacy fallback');
    assert.equal(modelCalls, 2);
  }
});

test('fallback failure preserves statuses without leaking provider response bodies', async () => {
  let modelCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelCalls += 1;
    return modelCalls === 1
      ? jsonResponse({ error: { message: 'sentinel-structured-response-body' } }, 400)
      : jsonResponse({ error: { message: 'sentinel-legacy-response-body' } }, 401);
  };

  await assert.rejects(
    chatCompletion(baseCompletionConfig()),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.cause.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /sentinel-legacy-response-body/);
      assert.doesNotMatch(error.cause.message, /sentinel-structured-response-body/);
      return true;
    },
  );
});

test('structured and legacy empty content fails without a third model call', async () => {
  let modelCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelCalls += 1;
    return jsonResponse({
      choices: [{
        message: { content: modelCalls === 1 ? '' : '   ' },
        finish_reason: modelCalls === 1 ? 'length' : 'stop',
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4096,
        completion_tokens_details: { reasoning_tokens: 4096 },
      },
    });
  };

  await assert.rejects(
    chatCompletion(baseCompletionConfig()),
    /No usable model content after structured and legacy attempts/,
  );
  assert.equal(modelCalls, 2);
});

test('structured failures log only safe response diagnostics', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(' '));
  let modelCalls = 0;
  try {
    global.fetch = async (url) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      modelCalls += 1;
      if (modelCalls === 1) {
        return jsonResponse({ error: { message: 'schema rejected sentinel-response-content' } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: 'legacy fallback' } }] });
    };

    assert.equal(await chatCompletion(baseCompletionConfig({
      apiKey: 'sentinel-api-key',
      system: 'sentinel-prompt',
    })), 'legacy fallback');
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings.join('\n'), /structured output failed: HTTP 400/);
  assert.doesNotMatch(warnings.join('\n'), /sentinel-api-key|sentinel-prompt|sentinel-response-content/);
});

test('empty responses log finish and token metadata without model text', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(' '));
  let modelCalls = 0;
  try {
    global.fetch = async (url) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      modelCalls += 1;
      return jsonResponse({
        choices: [{
          message: {
            content: '',
            reasoning: 'sentinel-reasoning-body',
          },
          finish_reason: modelCalls === 1 ? 'length' : 'stop',
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 4096,
          completion_tokens_details: { reasoning_tokens: 4096 },
        },
      });
    };

    await assert.rejects(chatCompletion(baseCompletionConfig()), /No usable model content/);
  } finally {
    console.warn = originalWarn;
  }

  const output = warnings.join('\n');
  assert.match(output, /structured output empty: finish_reason=length/);
  assert.match(output, /legacy output empty: finish_reason=stop/);
  assert.match(output, /prompt_tokens=120/);
  assert.match(output, /completion_tokens=4096/);
  assert.match(output, /reasoning_tokens=4096/);
  assert.doesNotMatch(output, /sentinel-reasoning-body/);
});

test('anthropic auto mode keeps the native message request unchanged', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonResponse({ content: [{ text: 'anthropic text' }] });
  };

  const result = await chatCompletion(baseCompletionConfig({
    provider: 'anthropic',
    model: 'claude-test',
    baseURL: 'https://api.anthropic.com/v1',
  }));

  assert.equal(result, 'anthropic text');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal('response_format' in calls[0].body, false);
  assert.equal('provider' in calls[0].body, false);
});
