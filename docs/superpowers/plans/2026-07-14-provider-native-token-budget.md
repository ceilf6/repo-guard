# Provider-native Token Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Repo Guard 仅在 Anthropic 原生 Messages 协议中固定发送 `max_tokens: 16384`，OpenAI/OpenRouter 兼容请求不发送 token 上限，并确保任何非空模型内容不会因 JSON 损坏而被伪造的解析失败报告替换。

**Architecture:** Token budget 由 `scripts/llm-client.mjs` 根据协议在内部决定，调用方和公共配置不再传递一个跨 provider 的 `maxTokens`。OpenAI-compatible 响应继续保持 `chatCompletion(): Promise<string>`，但输出安全的完成元数据；归一化层先尝试完整解析与仅补齐 EOF 的保守修复，仍失败时用 HTML 转义的原始内容兜底。

**Tech Stack:** Node.js ESM、内置 `node:test` / `node:assert`、GitHub composite Action YAML、OpenAI-compatible Chat Completions、Anthropic Messages。

## Global Constraints

- Anthropic 原生 Messages 请求始终发送 `max_tokens: 16384`，且该值不暴露为 Action input 或环境变量。
- OpenAI-compatible Structured、Legacy、fallback 与 relay 请求都不得发送 `max_tokens` 或 `max_completion_tokens`。
- Structured 非空 content 即为有效信息，包括 `finish_reason=length`、Markdown、自由文本和损坏 JSON；不得因此追加模型调用。
- Structured 请求错误或空白 content 只允许一次 Legacy fallback；Legacy 仍为空时失败，不进行第三次调用。
- JSON 修复只能处理 EOF 截断，不改写模型已经返回的字段和值。
- 不记录 API key、prompt、diff、reasoning 正文或模型正文。
- 保持 `structured-output` 的 `auto|off` 语义和 `chatCompletion(): Promise<string>` 接口。

---

### Task 1: Lock provider-native request parameters

**Files:**
- Modify: `tests/llm-client.test.mjs`
- Modify: `scripts/llm-client.mjs`

**Interfaces:**
- Consumes: `chatCompletion({ provider, model, apiKey, baseURL, messages, system, structuredOutputMode?, responseFormat? }): Promise<string>`
- Produces: OpenAI-compatible request bodies without output-token fields; Anthropic Messages bodies with internal `max_tokens: 16384`.

- [ ] **Step 1: Write failing request-body tests**

Remove `maxTokens` from `baseCompletionConfig`. Add this helper and assertions to all OpenAI request-path tests:

```js
function assertNoOutputTokenLimit(body) {
  assert.equal('max_tokens' in body, false);
  assert.equal('max_completion_tokens' in body, false);
}

assertNoOutputTokenLimit(calls[0].body); // off / relay
assertNoOutputTokenLimit(calls[1].body); // structured
assertNoOutputTokenLimit(modelBodies[0]);
assertNoOutputTokenLimit(modelBodies[1]); // fallback
```

Extend the Anthropic test so the fixed protocol value is proved even though the caller supplies no budget:

```js
const result = await chatCompletion(baseCompletionConfig({
  provider: 'anthropic',
  model: 'claude-test',
  baseURL: 'https://api.anthropic.com/v1',
}));

assert.equal(calls[0].body.max_tokens, 16384);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/llm-client.test.mjs`

Expected: FAIL because OpenAI bodies still contain `max_tokens: 4096` and Anthropic omits the now-undefined caller-supplied value instead of using `16384`.

- [ ] **Step 3: Implement the protocol-owned budget**

In `scripts/llm-client.mjs`, add the internal constant and remove `maxTokens` from builders and `chatCompletion` destructuring:

```js
const ANTHROPIC_MAX_TOKENS = 16384;

function buildOpenAIRequest(model, messages, system, { temperature = true } = {}) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...messages);
  const body = { model, messages: msgs };
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
```

Update both legacy and structured builder calls so the structured options object is the fourth argument:

```js
const legacyBody = buildOpenAIRequest(model, messages, system);
const structuredSystem = system
  ? `${system}${STRUCTURED_OUTPUT_INSTRUCTION}`
  : STRUCTURED_OUTPUT_INSTRUCTION.trimStart();

const structuredBody = {
  ...buildOpenAIRequest(model, messages, structuredSystem, { temperature: false }),
  response_format: responseFormat,
  provider: { require_parameters: true },
};
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/llm-client.test.mjs`

Expected: all `tests/llm-client.test.mjs` tests PASS.

- [ ] **Step 5: Commit the request strategy**

```bash
git add scripts/llm-client.mjs tests/llm-client.test.mjs
git commit -m "fix: use provider-native token budgets"
```

### Task 2: Remove the obsolete public token configuration

**Files:**
- Modify: `tests/structured-output-config.test.mjs`
- Modify: `tests/quality-eval.test.mjs`
- Modify: `action.yml`
- Modify: `.github/workflows/external-repo-guard.yml`
- Modify: `scripts/review.mjs`
- Modify: `scripts/pr-reviewer.mjs`
- Modify: `scripts/external-dispatcher.mjs`
- Modify: `scripts/evaluate-quality.mjs`

**Interfaces:**
- Consumes: provider, model, key, base URL, structured-output mode and prompt inputs.
- Produces: no public `max-tokens`, `LLM_MAX_TOKENS`, `MAX_TOKENS`, `maxTokens` parsing, validation or call-graph plumbing.

- [ ] **Step 1: Write failing configuration tests**

Extend `tests/structured-output-config.test.mjs`:

```js
test('Action and workflows do not expose a cross-provider token limit', () => {
  const files = [
    read('../action.yml'),
    read('../.github/workflows/repo-guard.yml'),
    read('../.github/workflows/external-repo-guard.yml'),
  ];
  for (const file of files) {
    assert.doesNotMatch(file, /max-tokens|LLM_MAX_TOKENS/);
  }
});
```

Change the two `getEnvConfig` expected values in `tests/quality-eval.test.mjs` to omit `maxTokens`. Keep `LLM_MAX_TOKENS: '1024'` in the second input and prove it has no effect by expecting exactly:

```js
{
  provider: 'openai',
  baseURL: 'https://relay.example.com/v1',
  apiKey: 'secret',
  model: 'gpt-test',
  outputDir: '/tmp/eval',
  structuredOutput: 'auto',
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/structured-output-config.test.mjs tests/quality-eval.test.mjs`

Expected: FAIL because Action/workflow text still exposes the old setting and `getEnvConfig` still returns `maxTokens`.

- [ ] **Step 3: Remove config and call-graph plumbing**

Apply these exact removals:

```text
action.yml: delete the max-tokens input and LLM_MAX_TOKENS env mapping
.github/workflows/external-repo-guard.yml: delete LLM_MAX_TOKENS
scripts/review.mjs: delete config.maxTokens and both maxTokens call properties
scripts/pr-reviewer.mjs: delete the maxTokens chatCompletion property
scripts/external-dispatcher.mjs: delete config.maxTokens and the buildPRReview property
scripts/evaluate-quality.mjs: delete DEFAULT_MAX_TOKENS, getEnvConfig.maxTokens,
  chatCompletion maxTokens, and max-token validation
```

The resulting evaluation config shape is:

```js
return {
  provider: env.PROVIDER || env.LLM_PROVIDER || '',
  baseURL: env.BASE_URL || env.LLM_BASE_URL || '',
  apiKey: env.API_KEY || env.LLM_API_KEY || '',
  model: env.MODEL || env.LLM_MODEL || '',
  structuredOutput: parseStructuredOutputMode(env.STRUCTURED_OUTPUT || env.LLM_STRUCTURED_OUTPUT),
  outputDir: env.QUALITY_EVAL_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
};
```

- [ ] **Step 4: Verify tests and repository-wide absence**

Run: `node --test tests/structured-output-config.test.mjs tests/quality-eval.test.mjs`

Expected: both files PASS.

Run: `rg -n "maxTokens|LLM_MAX_TOKENS|max-tokens|DEFAULT_MAX_TOKENS" action.yml .github scripts tests README.md docs/quality-evaluation.md`

Expected: no matches.

- [ ] **Step 5: Commit the public configuration removal**

```bash
git add action.yml .github/workflows/external-repo-guard.yml scripts/review.mjs scripts/pr-reviewer.mjs scripts/external-dispatcher.mjs scripts/evaluate-quality.mjs tests/structured-output-config.test.mjs tests/quality-eval.test.mjs
git commit -m "refactor: remove public token limit configuration"
```

### Task 3: Preserve safe completion diagnostics without retrying non-empty content

**Files:**
- Modify: `tests/llm-client.test.mjs`
- Modify: `scripts/llm-client.mjs`

**Interfaces:**
- Consumes: internal OpenAI response `{ content, finishReason, usage }`.
- Produces: safe log string with `finish_reason`, available token counters and `content_chars`; non-empty content returned after one model request.

- [ ] **Step 1: Write the failing length-response diagnostic test**

Add a test that returns nonempty truncated text and records model calls/logs:

```js
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
```

Also add an `off`-mode empty-content test which asserts one request, a rejection matching `No usable model content`, and a warning containing `legacy output empty: finish_reason=stop, content_chars=0`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="non-empty length response" tests/llm-client.test.mjs`

Expected: FAIL because the current non-empty success log has no finish/token/character diagnostics.

- [ ] **Step 3: Add content length to safe diagnostics and success logs**

Change the diagnostics helper and structured success branch:

```js
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

if (hasUsableText(result.content)) {
  console.log(`structured output returned usable text, normalizing without retry: ${responseDiagnostics(result)}`);
  return result.content;
}
```

For direct Legacy and fallback Legacy success, log the same metadata using a stable `legacy output returned usable text:` prefix before returning. If direct Legacy content is empty, log `legacy output empty:` diagnostics and throw `No usable model content`; do not retry because no Structured request preceded it. Do not log `result.content`.

- [ ] **Step 4: Run all LLM client tests and verify GREEN**

Run: `node --test tests/llm-client.test.mjs`

Expected: all tests PASS and the model call count remains one for non-empty `length`.

- [ ] **Step 5: Commit diagnostics**

```bash
git add scripts/llm-client.mjs tests/llm-client.test.mjs
git commit -m "fix: log safe completion diagnostics"
```

### Task 4: Recover EOF-truncated JSON and retain irreparable model content

**Files:**
- Modify: `tests/review-logic.test.mjs`
- Modify: `scripts/review-logic.mjs`

**Interfaces:**
- Consumes: trimmed model string and `{ type: 'pr'|'issue', title: string }`.
- Produces: existing canonical/tolerant Markdown for parseable repaired JSON; otherwise escaped raw-model Markdown with recommendation/event defaulting naturally to `COMMENT`.

- [ ] **Step 1: Replace fake-report expectations with failing preservation tests**

Replace the malformed PR/Issue tests and add a truncated structured test:

```js
test('normalizeReviewResponse repairs EOF-truncated PR JSON and preserves returned fields', () => {
  const response = '{"decision_summary":"real-review-marker","recommendation":"COMMENT","findings":[';
  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'Truncated JSON' });

  assert.match(normalized, /^## 代码评审报告: Truncated JSON/);
  assert.match(normalized, /real-review-marker/);
  assert.match(normalized, /\*\*处理建议:\*\* 评论/);
  assert.doesNotMatch(normalized, /不可解析的 JSON-like|模型输出是不可解析/);
});

test('normalizeReviewResponse safely preserves irreparable PR JSON-like output', () => {
  const response = '{not-json <script>alert("sentinel")</script>';
  const normalized = normalizeReviewResponse(response, { type: 'pr', title: 'Malformed JSON' });

  assert.match(normalized, /^## 模型原始代码评审输出: Malformed JSON/);
  assert.match(normalized, /\{not-json &lt;script&gt;alert\(&quot;sentinel&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(normalized, /<script>|不可解析的 JSON-like|模型输出是不可解析/);
  assert.equal(extractRecommendation(normalized), 'COMMENT');
});

test('normalizeReviewResponse safely preserves irreparable Issue JSON-like output', () => {
  const response = '[not-json & sentinel';
  const normalized = normalizeReviewResponse(response, { type: 'issue', title: 'Malformed issue JSON' });

  assert.match(normalized, /^## 模型原始 Issue 分析输出: Malformed issue JSON/);
  assert.match(normalized, /\[not-json &amp; sentinel/);
  assert.doesNotMatch(normalized, /不可解析的 JSON-like/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern="EOF-truncated|irreparable" tests/review-logic.test.mjs`

Expected: FAIL because current malformed JSON branches discard original text and manufacture a NEEDS_HUMAN report.

- [ ] **Step 3: Implement conservative EOF repair**

Make `parseStandaloneJson` try exact JSON first, then a helper that scans only JSON-like input. The helper must reject mismatched closing delimiters and non-whitespace after the root closes; at EOF it may remove one dangling escape, close a string, convert a trailing colon to `null`, drop a trailing comma, and append missing delimiters:

```js
function parseStandaloneJson(response) {
  const json = unwrapJsonFence(response);
  if (!looksLikeStandaloneJson(json)) return null;
  try {
    return JSON.parse(json);
  } catch {
    const repaired = repairTruncatedJson(json);
    if (!repaired) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}
```

`repairTruncatedJson` keeps a `{`/`[` stack, `inString`, `escaped`, and `rootClosed` state. It returns `null` on any mismatched closer, control character inside a string, or non-whitespace after `rootClosed`. Before appending `"` and reverse-stack closers, normalize only these EOF forms:

```js
if (escaped) repaired = repaired.slice(0, -1);
if (inString) repaired += '"';
repaired = repaired.trimEnd();
if (repaired.endsWith(':')) repaired += 'null';
if (repaired.endsWith(',')) repaired = repaired.slice(0, -1);
repaired += stack.reverse().map((open) => open === '{' ? '}' : ']').join('');
```

- [ ] **Step 4: Implement escaped raw-content fallbacks**

Replace `formatInvalidJsonPRReview` and `formatInvalidJsonIssueReview` with functions that consume the actual response and do not claim risk/findings:

```js
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRawPRReview(response, title = 'PR Review') {
  return [
    `## 模型原始代码评审输出: ${title || 'PR Review'}`,
    '',
    '模型返回了非空内容，但该内容无法按结构化契约解析。以下保留模型实际返回的信息；本次不因格式问题追加模型调用。',
    '',
    `<pre>${escapeHtml(response)}</pre>`,
  ].join('\n');
}

function formatRawIssueReview(response, title = 'Issue Review') {
  return [
    `## 模型原始 Issue 分析输出: ${title || 'Issue Review'}`,
    '',
    '模型返回了非空内容，但该内容无法按结构化契约解析。以下保留模型实际返回的信息；本次不因格式问题追加模型调用。',
    '',
    `<pre>${escapeHtml(response)}</pre>`,
  ].join('\n');
}
```

Pass `trimmed` into these fallbacks from `normalizeReviewResponse`. Existing complete JSON, V2/V1/tolerant JSON, valid contract Markdown and free-text branches remain unchanged.

- [ ] **Step 5: Run review-logic tests and verify GREEN**

Run: `node --test tests/review-logic.test.mjs`

Expected: all tests PASS; repaired markers survive and irreparable content appears only HTML-escaped.

- [ ] **Step 6: Commit response preservation**

```bash
git add scripts/review-logic.mjs tests/review-logic.test.mjs
git commit -m "fix: preserve truncated model reviews"
```

### Task 5: Update documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `docs/quality-evaluation.md`

**Interfaces:**
- Consumes: final runtime behavior from Tasks 1-4.
- Produces: user-facing provider-specific token policy and evaluation setup with no obsolete knobs.

- [ ] **Step 1: Update user documentation**

Delete the `max-tokens` row from the README input table. Add this note after the inputs table:

```markdown
Repo Guard does not impose an output-token limit on OpenAI-compatible requests, including OpenRouter. Anthropic Messages requires the parameter, so the Action supplies `max_tokens: 16384` internally; it is not configurable across providers.
```

In `docs/quality-evaluation.md`, remove `LLM_MAX_TOKENS` and `MAX_TOKENS`, then add:

```markdown
Token-budget behavior matches production: OpenAI-compatible requests omit an output-token limit, while Anthropic Messages uses the internal required value `16384`.
```

- [ ] **Step 2: Check docs and source for obsolete settings**

Run: `rg -n "maxTokens|LLM_MAX_TOKENS|max-tokens|DEFAULT_MAX_TOKENS" action.yml .github scripts tests README.md docs/quality-evaluation.md`

Expected: no matches. Historical design/plan documents under `docs/superpowers/` are excluded because they record prior decisions.

- [ ] **Step 3: Run static and full test verification**

Run: `npm run check`

Expected: exit 0.

Run: `npm test`

Expected: all tests PASS with zero failures.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Run quality evaluation only when credentials exist**

Run: `test -n "$LLM_API_KEY" && npm run eval:quality || echo "SKIP: LLM_API_KEY unavailable"`

Expected with credentials: four fixtures complete and write `quality-eval-results/<timestamp>/summary.json`. Expected without credentials: exactly `SKIP: LLM_API_KEY unavailable`.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/quality-evaluation.md
git commit -m "docs: explain provider token policy"
```

- [ ] **Step 6: Review final commit history and push main**

Run: `git log --oneline origin/main..main`

Expected: only clear design, plan, implementation and documentation commits; no temporary, fixup or CR-only commits. Squash only process commits if any exist.

Run: `git fetch origin main && test "$(git rev-parse origin/main)" = "$(git merge-base HEAD origin/main)" && git push origin main`

Expected: fast-forward push succeeds without force.
