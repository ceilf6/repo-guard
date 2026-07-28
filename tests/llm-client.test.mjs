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
    messages: [{ role: 'user', content: 'review' }],
    system: 'system prompt',
    structuredOutputMode: 'auto',
    responseFormat: PR_REVIEW_RESPONSE_FORMAT,
    ...overrides,
  };
}

function assertNoOutputTokenLimit(body) {
  assert.equal('max_tokens' in body, false);
  assert.equal('max_completion_tokens' in body, false);
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
  assertNoOutputTokenLimit(calls[0].body);
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
  assertNoOutputTokenLimit(calls[0].body);
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
  assertNoOutputTokenLimit(calls[1].body);
});

test('configured provider order routes the legacy request', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonResponse({ choices: [{ message: { content: 'azure text' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig({
    structuredOutputMode: 'off',
    providerOrder: ['azure'],
  }));

  assert.equal(result, 'azure text');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.provider, { order: ['azure'] });
});

test('configured provider order merges with the structured routing requirement', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url) };
    if (options.body) call.body = JSON.parse(options.body);
    calls.push(call);
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    return jsonResponse({ choices: [{ message: { content: '{"recommendation":"COMMENT"}' } }] });
  };

  await chatCompletion(baseCompletionConfig({ providerOrder: ['azure', 'openai'] }));

  assert.deepEqual(calls[1].body.provider, {
    order: ['azure', 'openai'],
    require_parameters: true,
  });
});

test('provider order survives the fallback to the legacy request', async () => {
  const modelBodies = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelBodies.push(JSON.parse(options.body));
    if (modelBodies.length === 1) return jsonResponse({ error: { message: 'invalid schema' } }, 400);
    return jsonResponse({ choices: [{ message: { content: 'legacy fallback' } }] });
  };

  const result = await chatCompletion(baseCompletionConfig({ providerOrder: ['azure'] }));

  assert.equal(result, 'legacy fallback');
  assert.deepEqual(modelBodies[0].provider, { order: ['azure'], require_parameters: true });
  assert.deepEqual(modelBodies[1].provider, { order: ['azure'] });
  assert.equal('response_format' in modelBodies[1], false);
});

test('anthropic ignores provider order and warns about it', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(' '));
  const calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return jsonResponse({ content: [{ text: 'anthropic text' }] });
    };

    assert.equal(await chatCompletion(baseCompletionConfig({
      provider: 'anthropic',
      model: 'claude-test',
      baseURL: 'https://api.anthropic.com/v1',
      providerOrder: ['azure'],
    })), 'anthropic text');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal('provider' in calls[0].body, false);
  assert.match(warnings.join('\n'), /provider order ignored/);
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

test('non-empty length response is returned once with safe diagnostics', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.join(' '));
  let modelCalls = 0;
  try {
    global.fetch = async (url) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      modelCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: '{"decision_summary":"sentinel-model-body"' }, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4096,
          completion_tokens_details: { reasoning_tokens: 2048 },
        },
      });
    };

    assert.equal(
      await chatCompletion(baseCompletionConfig()),
      '{"decision_summary":"sentinel-model-body"',
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(modelCalls, 1);
  const output = logs.join('\n');
  assert.match(output, /finish_reason=length/);
  assert.match(output, /completion_tokens=4096/);
  assert.match(output, /reasoning_tokens=2048/);
  assert.match(output, /content_chars=41/);
  assert.doesNotMatch(output, /sentinel-model-body/);
});

test('off mode rejects empty content once with safe diagnostics', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(' '));
  let modelCalls = 0;
  try {
    global.fetch = async () => {
      modelCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      });
    };

    await assert.rejects(
      chatCompletion(baseCompletionConfig({ structuredOutputMode: 'off' })),
      /No usable model content/,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(modelCalls, 1);
  assert.match(warnings.join('\n'), /legacy output empty: finish_reason=stop, content_chars=0/);
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
  assertNoOutputTokenLimit(modelBodies[0]);
  assertNoOutputTokenLimit(modelBodies[1]);
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

test('fallback failure preserves both statuses and their provider messages', async () => {
  let modelCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelCalls += 1;
    return modelCalls === 1
      ? jsonResponse({ error: { message: 'schema unsupported' } }, 400)
      : jsonResponse({ error: { message: 'User not found.' } }, 401);
  };

  await assert.rejects(
    chatCompletion(baseCompletionConfig()),
    (error) => {
      assert.match(error.message, /HTTP 401 \(message=User not found\.\)/);
      assert.match(error.cause.message, /HTTP 400 \(message=schema unsupported\)/);
      return true;
    },
  );
});

test('rejections name the provider error classifiers and message', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...values) => warnings.push(values.join(' '));
  try {
    global.fetch = async (url) => {
      if (String(url).includes('/model/')) {
        return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
      }
      return jsonResponse({
        error: {
          code: 403,
          message: 'Prompt blocked by guardrail',
          metadata: {
            error_type: 'guardrail_blocked',
            provider_name: 'Azure',
            provider_code: 'content_filter',
          },
        },
      }, 403);
    };

    await assert.rejects(
      chatCompletion(baseCompletionConfig()),
      (error) => {
        assert.match(
          error.message,
          /HTTP 403 \(error_type=guardrail_blocked, provider=Azure, provider_code=content_filter, message=Prompt blocked by guardrail\)/,
        );
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings.join('\n'), /structured output failed: HTTP 403 \(error_type=guardrail_blocked/);
});

test('surfaced provider messages are single-lined, redacted, and length bounded', async () => {
  const message = `leaked Bearer sk-or-v1-abcdef0123456789 and\nsk-live-9876543210fedcba while ${'x'.repeat(300)}`;
  global.fetch = async () => jsonResponse({ error: { message } }, 400);

  await assert.rejects(
    chatCompletion(baseCompletionConfig({ structuredOutputMode: 'off' })),
    (error) => {
      assert.doesNotMatch(error.message, /sk-or-v1-abcdef0123456789|sk-live-9876543210fedcba/);
      assert.match(error.message, /message=leaked \[redacted\] and \[redacted\] while x+…\(truncated\)/);
      assert.equal(error.message.includes('\n'), false);
      assert.ok(error.message.length < 260, `unbounded detail: ${error.message.length} chars`);
      return true;
    },
  );
});

test('rejections describe a non-JSON error body by shape instead of content', async () => {
  global.fetch = async () => new Response('<html>sentinel-cloudflare-block</html>', {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    chatCompletion(baseCompletionConfig({ structuredOutputMode: 'off' })),
    (error) => {
      assert.match(error.message, /HTTP 403 \(non-JSON body: content_type=text\/html, body_chars=38\)/);
      assert.doesNotMatch(error.message, /sentinel-cloudflare-block/);
      return true;
    },
  );
});

test('direct legacy invalid JSON response is sanitized', async () => {
  global.fetch = async () => new Response('sentinel-direct-provider-body', { status: 200 });

  await assert.rejects(
    chatCompletion(baseCompletionConfig({ structuredOutputMode: 'off' })),
    (error) => {
      assert.match(error.message, /OpenAI-compatible provider returned invalid JSON/);
      assert.doesNotMatch(error.message, /sentinel-direct-provider-body|sentinel-direct/);
      return true;
    },
  );
});

test('structured and fallback invalid JSON responses are sanitized', async () => {
  let modelCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('/model/')) {
      return jsonResponse({ data: { supported_parameters: ['structured_outputs'] } });
    }
    modelCalls += 1;
    return new Response(
      modelCalls === 1 ? 'sentinel-structured-provider-body' : 'sentinel-legacy-provider-body',
      { status: 200 },
    );
  };

  await assert.rejects(
    chatCompletion(baseCompletionConfig()),
    (error) => {
      assert.match(error.message, /OpenAI-compatible provider returned invalid JSON/);
      assert.match(error.cause.message, /OpenAI-compatible provider returned invalid JSON/);
      assert.doesNotMatch(
        `${error.message}\n${error.cause.message}`,
        /sentinel-structured|sentinel-legacy|provider-body/,
      );
      return true;
    },
  );
  assert.equal(modelCalls, 2);
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

test('structured failures log the provider message but never the key or prompt', async () => {
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
        return jsonResponse({ error: { message: 'schema rejected' } }, 400);
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

  assert.match(warnings.join('\n'), /structured output failed: HTTP 400 \(message=schema rejected\)/);
  assert.doesNotMatch(warnings.join('\n'), /sentinel-api-key|sentinel-prompt/);
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
  assert.equal(calls[0].body.max_tokens, 16384);
});

test('anthropic invalid JSON response is sanitized', async () => {
  global.fetch = async () => new Response('sentinel-anthropic-provider-body', { status: 200 });

  await assert.rejects(
    chatCompletion(baseCompletionConfig({
      provider: 'anthropic',
      model: 'claude-test',
      baseURL: 'https://api.anthropic.com/v1',
    })),
    (error) => {
      assert.match(error.message, /Anthropic provider returned invalid JSON/);
      assert.doesNotMatch(error.message, /sentinel-anthropic|provider-body/);
      return true;
    },
  );
});
