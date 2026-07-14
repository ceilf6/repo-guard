# Structured Outputs Default Auto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Structured Outputs capability detection the default while preserving an explicit `off` escape hatch and every existing fallback rule.

**Architecture:** Invert the default at the shared mode parser and the direct LLM client boundary, then keep declarative Action/workflow defaults consistent. Tests assert both runtime semantics and checked-in YAML defaults so no entry point silently diverges.

**Tech Stack:** Node.js ESM, native Node test runner, GitHub composite Actions, YAML, Markdown

## Global Constraints

- Missing and empty Structured Outputs configuration resolves to `auto`.
- Only explicit `off` completely bypasses capability probing and Schema request parameters.
- Accepted values remain exactly `off|auto`; invalid values still throw.
- Capability detection, response acceptance, fallback count, and provider targeting do not change.
- Do not add dependencies or alter provider names.
- Final history must squash test/fixup/CR process commits into clear result commits.

---

### Task 1: Invert runtime and configuration defaults

**Files:**

- Modify: `tests/openrouter-structured-output.test.mjs`
- Modify: `tests/quality-eval.test.mjs`
- Create: `tests/structured-output-config.test.mjs`
- Modify: `scripts/openrouter-structured-output.mjs`
- Modify: `scripts/llm-client.mjs`
- Modify: `action.yml`
- Modify: `.github/workflows/repo-guard.yml`
- Modify: `.github/workflows/external-repo-guard.yml`

**Interfaces:**

- Preserves: `parseStructuredOutputMode(value): 'off' | 'auto'`
- Changes: omitted `value` and `''` return `auto`
- Preserves: explicit `off` legacy-only behavior

- [ ] **Step 1: Change parser and quality-config expectations before production code**

Update the parser test to expect:

```js
assert.equal(parseStructuredOutputMode(), 'auto');
assert.equal(parseStructuredOutputMode(''), 'auto');
assert.equal(parseStructuredOutputMode('off'), 'off');
assert.equal(parseStructuredOutputMode('auto'), 'auto');
```

Update both default `getEnvConfig` expected objects in `tests/quality-eval.test.mjs` from `structuredOutput: 'off'` to `structuredOutput: 'auto'`.

- [ ] **Step 2: Add checked-in configuration default tests**

Create `tests/structured-output-config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Action and repository workflows default structured output to auto', () => {
  const action = read('../action.yml');
  const repositoryWorkflow = read('../.github/workflows/repo-guard.yml');
  const externalWorkflow = read('../.github/workflows/external-repo-guard.yml');

  assert.match(action, /structured-output:\n(?:.*\n){2}\s+default: "auto"/);
  assert.match(repositoryWorkflow, /vars\.LLM_STRUCTURED_OUTPUT \|\| 'auto'/);
  assert.match(externalWorkflow, /vars\.LLM_STRUCTURED_OUTPUT \|\| 'auto'/);
});
```

- [ ] **Step 3: Run focused tests and verify the old defaults fail**

Run:

```bash
node --test tests/openrouter-structured-output.test.mjs tests/quality-eval.test.mjs tests/structured-output-config.test.mjs
```

Expected: FAIL because parser, quality evaluation, Action input, and workflows still default to `off`.

- [ ] **Step 4: Apply the minimal default inversion**

Change the shared parser to:

```js
export function parseStructuredOutputMode(value = '') {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'auto') return mode;
  throw new Error('LLM_STRUCTURED_OUTPUT must be "off" or "auto"');
}
```

Change `chatCompletion` parameter default to:

```js
structuredOutputMode = 'auto',
```

Change the Composite Action input and both workflow fallbacks from `off` to `auto`:

```yaml
default: "auto"
```

```yaml
${{ vars.LLM_STRUCTURED_OUTPUT || 'auto' }}
```

- [ ] **Step 5: Verify focused and full behavior**

Run:

```bash
node --test tests/openrouter-structured-output.test.mjs tests/quality-eval.test.mjs tests/structured-output-config.test.mjs tests/llm-client.test.mjs
npm run check
npm test
```

Expected: all focused tests and the full suite pass; explicit `off` still sends one legacy request without metadata probing.

- [ ] **Step 6: Commit the behavior change**

```bash
git add scripts/openrouter-structured-output.mjs scripts/llm-client.mjs tests/openrouter-structured-output.test.mjs tests/quality-eval.test.mjs tests/structured-output-config.test.mjs action.yml .github/workflows/repo-guard.yml .github/workflows/external-repo-guard.yml
git commit -m "feat: default structured output mode to auto"
```

---

### Task 2: Align public and historical documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/quality-evaluation.md`
- Modify: `docs/superpowers/specs/2026-07-14-openrouter-structured-outputs-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-openrouter-structured-outputs.md`

**Interfaces:**

- Documents: missing/empty means `auto`; explicit `off` means legacy only
- Preserves: existing failure and fallback semantics

- [ ] **Step 1: Replace stale default-off documentation**

Update public configuration tables and prose to state:

```markdown
| `LLM_STRUCTURED_OUTPUT` | `auto` | `auto` uses OpenRouter JSON Schema when supported; explicit `off` always uses the legacy free-text request |
```

Document quality evaluation as `auto` by default. Update the original design and implementation plan wherever they claim the public default is `off`, so repository documentation has one current behavior.

- [ ] **Step 2: Check documentation coverage and whitespace**

Run:

```bash
rg -n "LLM_STRUCTURED_OUTPUT|structured-output|default.*off|默认.*off|缺省值.*off" README.md action.yml .github/workflows docs scripts tests
git diff --check
```

Expected: runtime and public configuration surfaces show `auto`; `off` remains only as the explicit opt-out and compatibility path.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/quality-evaluation.md docs/superpowers/specs/2026-07-14-openrouter-structured-outputs-design.md docs/superpowers/plans/2026-07-14-openrouter-structured-outputs.md
git commit -m "docs: make structured output opt-out"
```

- [ ] **Step 4: Final verification and integration**

Run:

```bash
git diff --check origin/main..HEAD
npm run check
npm test
git status --short --branch
```

Expected: clean working tree, all tests pass, and only clear design, behavior, and documentation commits remain before pushing `main`.
