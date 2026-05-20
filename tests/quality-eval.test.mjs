import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildQualityEvalFixtures,
  getEnvConfig,
  getChangedNewLines,
  getSuggestionsSection,
  scoreQualityEvalResponse,
} from '../scripts/evaluate-quality.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('quality eval fixtures cover PR and issue review paths', () => {
  const fixtures = buildQualityEvalFixtures();

  assert.deepEqual(fixtures.map((fixture) => fixture.id), [
    'pr-auth-bypass',
    'pr-large-plus-small',
    'issue-vague-crash',
    'issue-ready-feature',
  ]);
  assert.equal(fixtures.filter((fixture) => fixture.kind === 'pr').length, 2);
  assert.equal(fixtures.filter((fixture) => fixture.kind === 'issue').length, 2);
});

test('scoreQualityEvalResponse catches localized PR marker labels', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-large-plus-small');
  const response = `## CR Report: Fix ID parsing

**风险等级:** HIGH
**建议:** REQUEST_CHANGES
**决策摘要:** marker labels were localized

### Findings
1. **[High] parseId behavior changed**
   - Evidence: src/parse-id.js

### Inline Findings
- [src/parse-id.js:2] parseInt changes behavior.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has recommendation marker').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has decision summary').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'large fixture discusses parse-id').pass, true);
});

test('scoreQualityEvalResponse requires inline PR findings to target changed lines', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-auth-bypass');
  const response = `## CR Report: Make auth middleware more permissive

**Risk:** CRITICAL
**Recommendation:** REQUEST_CHANGES
**Decision Summary:** auth is bypassed

### Findings
1. **[Critical] auth bypass**
   - Evidence: src/auth.js
   - Smallest viable fix: restore 401

### Inline Findings
- [src/auth.js:13] This points at nearby context instead of the changed return.
- [tests/auth.test.js:6] restore the exact 401 assertion.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'auth bypass has inline src/auth.js comment').pass, true);
  assert.equal(score.checks.find((check) => check.label === 'auth bypass inline targets changed src/auth.js line').pass, false);
});

test('scoreQualityEvalResponse requires exact CR report heading level', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-large-plus-small');
  const response = `### CR Report: Fix ID parsing

**Risk:** HIGH
**Recommendation:** REQUEST_CHANGES
**Decision Summary:** parseId changed

### Findings
1. **[High] parseId behavior changed**
   - Evidence: src/parse-id.js

### Inline Findings
- [src/parse-id.js:2] parseInt changes behavior.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has CR report heading').pass, false);
});

test('getChangedNewLines parses added lines from unified diffs', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-auth-bypass');
  const authFile = fixture.files.find((file) => file.filename === 'src/auth.js');

  assert.deepEqual([...getChangedNewLines(authFile)], [12, 16]);
});

test('scoreQualityEvalResponse catches localized issue marker labels', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'issue-vague-crash');
  const response = `## Issue Analysis: 登录后偶发 500

**质量评分:** 2/5
**优先级建议:** P1-High
**类型:** Bug Report
**维护者下一步动作:** Ask reporter

### Suggestions
- 请提供复现步骤和日志。`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has quality score').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has priority suggestion').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has maintainer next action').pass, false);
});

test('ready issue suggestion count is scoped to Suggestions section only', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'issue-ready-feature');
  const response = `## Issue Analysis: Add dry-run mode

**Quality Score:** 5/5
**Priority Suggestion:** P3-Low
**Type:** Feature Request
**Maintainer Next Action:** Ready to work

### Completeness
- Problem statement: clear
- Reproduction steps: N/A
- Expected vs actual: described

### Suggestions
- No required reporter action remains.

### Summary
This is ready to implement.`;

  const suggestions = getSuggestionsSection(response);
  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal((suggestions.match(/^- /gm) || []).length, 1);
  assert.equal(score.checks.find((check) => check.label === 'ready feature avoids noisy suggestion pile').pass, true);
});

test('getEnvConfig accepts short and action-compatible environment variable names', () => {
  assert.deepEqual(getEnvConfig({
    PROVIDER: 'anthropic',
    BASE_URL: 'https://relay.example.com/anthropic',
    API_KEY: 'secret',
    MODEL: 'mimo-v2.5-pro',
  }), {
    provider: 'anthropic',
    baseURL: 'https://relay.example.com/anthropic',
    apiKey: 'secret',
    model: 'mimo-v2.5-pro',
    maxTokens: 3200,
    outputDir: 'quality-eval-results',
  });

  assert.deepEqual(getEnvConfig({
    LLM_PROVIDER: 'openai',
    LLM_BASE_URL: 'https://relay.example.com/v1',
    LLM_API_KEY: 'secret',
    LLM_MODEL: 'gpt-test',
    LLM_MAX_TOKENS: '1024',
    QUALITY_EVAL_OUTPUT_DIR: '/tmp/eval',
  }), {
    provider: 'openai',
    baseURL: 'https://relay.example.com/v1',
    apiKey: 'secret',
    model: 'gpt-test',
    maxTokens: 1024,
    outputDir: '/tmp/eval',
  });
});

test('evaluate-quality module can be imported from eval scripts', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    'import "./scripts/evaluate-quality.mjs";',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
});
