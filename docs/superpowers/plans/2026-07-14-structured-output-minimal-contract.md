# Structured Outputs Minimal Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deep full-report JSON Schemas with compact machine-stable skeletons while preserving every published review section and preventing empty model responses from becoming fake reviews.

**Architecture:** Keep V1 canonical detection/rendering for backward compatibility, but point the OpenRouter `response_format` exports to new V2 contracts. V2 stores non-machine analysis dimensions as complete text blocks and keeps recommendation, risk, findings, inline locations, scores, and maintainer actions typed. Refine the internal OpenAI response helper to retain safe completion metadata while preserving the public `chatCompletion(): Promise<string>` interface.

**Tech Stack:** Node.js ESM, native `fetch`, Node test runner, OpenRouter OpenAI-compatible API, Markdown

## Global Constraints

- Do not remove any current PR or Issue Markdown section.
- Keep `PR_REVIEW_RESPONSE_FORMAT` and `ISSUE_REVIEW_RESPONSE_FORMAT` as the schema exports used by all existing call sites.
- Keep old V1 canonical JSON, tolerant JSON, Markdown, and free-text normalization working.
- Keep public `chatCompletion()` return type as `Promise<string>`.
- Structured non-empty content never triggers a second model call, even when it violates the schema.
- Structured empty/error triggers exactly one Legacy call; Legacy empty/error never triggers a third call.
- Legacy request body keeps `temperature: 0.3`; Structured request omits `temperature`.
- Logs never include API keys, prompts, diffs, full content, reasoning text, or full request bodies.
- Automated tests never call real GitHub or LLM APIs.
- Final history must squash temporary/fixup/CR commits into clear result commits.

---

### Task 1: Add compact V2 contracts without content loss

**Files:**

- Modify: `scripts/review-contracts.mjs`
- Modify: `scripts/review-logic.mjs`
- Modify: `tests/review-contracts.test.mjs`
- Modify: `tests/review-logic.test.mjs`

**Interfaces:**

- Preserves: `PR_REVIEW_RESPONSE_FORMAT`, `ISSUE_REVIEW_RESPONSE_FORMAT`
- Adds: `isStructuredPRReviewV2(value): boolean`
- Adds: `isStructuredIssueReviewV2(value): boolean`
- Adds: `renderStructuredPRReviewV2(review, title): string`
- Adds: `renderStructuredIssueReviewV2(review, title): string`
- Preserves: existing `isCanonical*` and `renderCanonical*` exports as V1 compatibility

- [ ] **Step 1: Write failing V2 schema-shape tests**

Add tests asserting the response schemas use content blocks instead of the old deep objects:

```js
const pr = PR_REVIEW_RESPONSE_FORMAT.json_schema.schema;
assert.equal(pr.properties.cascade_analysis.type, 'string');
assert.equal(pr.properties.karpathy_review.type, 'string');
assert.deepEqual(Object.keys(pr.properties.findings.items.properties), [
  'severity', 'title', 'details', 'path', 'line', 'inline_comment',
]);

const issue = ISSUE_REVIEW_RESPONSE_FORMAT.json_schema.schema;
assert.equal(issue.properties.completeness.type, 'string');
assert.equal(issue.properties.clarity.type, 'string');
assert.equal(issue.properties.actionability.type, 'string');
```

Keep the existing recursive strict-object assertion.

- [ ] **Step 2: Write failing complete-content renderer tests**

Create PR and Issue V2 fixtures containing unique markers for every existing content dimension. Assert the rendered PR contains all existing headings and markers:

```js
for (const heading of ['级联分析', '问题发现', '行级发现', 'Karpathy 评审', '缺失覆盖']) {
  assert.match(markdown, new RegExp(`^### ${heading}$`, 'm'));
}
for (const marker of ['changed-symbol-marker', 'affected-flow-marker', 'outside-caller-marker',
  'confidence-marker', 'evidence-marker', 'impact-marker', 'smallest-fix-marker',
  'assumption-marker', 'simplicity-marker', 'scope-marker', 'verification-marker']) {
  assert.match(markdown, new RegExp(marker));
}
```

Assert the Issue renderer preserves completeness, clarity, actionability, suggestions, and summary markers under their existing headings.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test tests/review-contracts.test.mjs tests/review-logic.test.mjs
```

Expected: V2 shape and renderer tests fail because current response formats still expose V1 nested objects and no V2 renderer exists.

- [ ] **Step 4: Implement V2 schemas and renderers**

Retain the current schemas as `PR_SCHEMA_V1` and `ISSUE_SCHEMA_V1`. Add V2 schemas matching the approved design and point response formats to names `repo_guard_pr_review_v2` and `repo_guard_issue_review_v2`.

Use strict objects at every object layer. Content block strings remain free-form; finding `path`, `line`, and `inline_comment` remain nullable. Add detection and rendering exports named in the Interfaces section.

The PR renderer must retain the exact top-level markers and headings. It renders `cascade_analysis` and `karpathy_review` without collapsing internal newlines, renders each finding `details` in full, and derives inline markers only from exact locations. The Issue renderer places the three complete text blocks under their existing headings.

- [ ] **Step 5: Route V2 before V1 in normalization**

In `normalizeReviewResponse`, check parsed JSON in this order:

```js
if (parsed && isStructuredPRReviewV2(parsed)) return renderStructuredPRReviewV2(parsed, context.title);
if (parsed && isCanonicalPRReview(parsed)) return renderCanonicalPRReview(parsed, context.title);
```

Apply the same V2-then-V1 ordering for Issue responses. Do not change tolerant fallbacks.

- [ ] **Step 6: Verify focused and full normalization tests**

Run:

```bash
node --test tests/review-contracts.test.mjs tests/review-logic.test.mjs tests/quality-eval.test.mjs
```

Expected: V2 and all existing V1/tolerant tests pass.

- [ ] **Step 7: Commit contract work**

```bash
git add scripts/review-contracts.mjs scripts/review-logic.mjs tests/review-contracts.test.mjs tests/review-logic.test.mjs
git commit -m "feat: simplify structured review contracts"
```

---

### Task 2: Make Structured requests provider-compatible and empty-safe

**Files:**

- Modify: `scripts/llm-client.mjs`
- Modify: `tests/llm-client.test.mjs`

**Interfaces:**

- Preserves: `chatCompletion(config): Promise<string>`
- Internal `requestOpenAI` returns `{ content, finishReason, usage }`
- Adds no public configuration

- [ ] **Step 1: Write failing request-isolation tests**

Extend the supported OpenRouter test to assert:

```js
assert.equal('temperature' in structuredBody, false);
```

Keep the explicit-off test and fallback-body test asserting:

```js
assert.equal(legacyBody.temperature, 0.3);
```

- [ ] **Step 2: Write failing double-empty and diagnostic tests**

Mock one metadata response followed by two successful HTTP responses whose `message.content` values are empty. Assert `chatCompletion` rejects with:

```text
No usable model content after structured and legacy attempts
```

and assert exactly two model POSTs occurred.

Capture `console.warn` and verify separate messages for:

- Structured HTTP error
- Structured empty content with `finish_reason`
- Legacy empty content

Assert logs do not contain a sentinel prompt, API key, response content, or reasoning body.

- [ ] **Step 3: Run client tests and verify RED**

Run:

```bash
node --test tests/llm-client.test.mjs
```

Expected: FAIL because Structured requests contain temperature, fallback empty resolves to an empty string, and diagnostics do not distinguish failure modes.

- [ ] **Step 4: Return response metadata internally**

Change internal `requestOpenAI` to return:

```js
{
  content: typeof message.content === 'string' ? message.content : '',
  finishReason: data.choices?.[0]?.finish_reason || '',
  usage: {
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
  },
}
```

Keep this object internal; `chatCompletion` returns only `content`.

- [ ] **Step 5: Omit temperature only from Structured requests**

Extend `buildOpenAIRequest` with an internal option:

```js
function buildOpenAIRequest(model, messages, system, maxTokens, { temperature = true } = {})
```

Add `temperature: 0.3` only when the option is true. Legacy calls use the default; Structured calls pass `{ temperature: false }`.

- [ ] **Step 6: Implement safe diagnostics and final empty failure**

On Structured error, log only its HTTP status when available or error class. On empty content, log `finish_reason` and numeric usage fields. After the one Legacy attempt, require non-empty content; otherwise throw the exact error from Step 2. Preserve the Structured failure as `cause` when available. Do not make a third request.

- [ ] **Step 7: Verify client and full tests**

Run:

```bash
node --test tests/llm-client.test.mjs tests/openrouter-structured-output.test.mjs
npm run check
npm test
```

Expected: all tests pass; full test count increases from 106; no live network calls occur.

- [ ] **Step 8: Commit client work**

```bash
git add scripts/llm-client.mjs tests/llm-client.test.mjs
git commit -m "fix: make structured review fallback observable"
```

---

### Task 3: Document compatibility and verify real behavior

**Files:**

- Modify: `README.md`
- Modify: `docs/quality-evaluation.md`
- Modify: `docs/superpowers/specs/2026-07-14-openrouter-structured-outputs-design.md`

**Interfaces:**

- Documents: V2 content blocks, unchanged output sections, no-temperature Structured request, and final empty failure

- [ ] **Step 1: Update documentation**

Document that Structured Outputs constrains the machine skeleton while complete analysis remains in content blocks. State that published Markdown sections are unchanged, V1 JSON remains accepted, Structured calls omit temperature, and two empty attempts fail explicitly instead of publishing a synthetic review.

- [ ] **Step 2: Run repository verification**

Run:

```bash
rg -n "minimal|V2|content block|内容块|temperature|empty|空响应" README.md docs scripts tests
git diff --check origin/main..HEAD
npm run check
npm test
```

Expected: documentation and code describe one consistent behavior; all tests pass.

- [ ] **Step 3: Run live quality evaluation when credentials exist**

Check for `LLM_API_KEY` or `API_KEY` without printing values. If present, run:

```bash
PROVIDER=openai BASE_URL=https://openrouter.ai/api/v1 MODEL=openai/gpt-5.5 STRUCTURED_OUTPUT=auto npm run eval:quality
```

Expected: five fixtures produce non-placeholder Markdown reports and a summary file. If no API key is available, record that live evaluation was not executed; do not claim live-model verification.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/quality-evaluation.md docs/superpowers/specs/2026-07-14-openrouter-structured-outputs-design.md
git commit -m "docs: explain compact structured review contracts"
```

- [ ] **Step 5: Final review and integration**

Request an independent read-only review against this plan. Fix Critical and Important findings, squash process-only commits, rerun `git diff --check origin/main..HEAD`, `npm run check`, and `npm test`, then fetch and push `main` only when it remains a fast-forward.
