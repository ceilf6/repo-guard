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
    'pr-linked-issue-context',
    'issue-vague-crash',
    'issue-ready-feature',
  ]);
  assert.equal(fixtures.filter((fixture) => fixture.kind === 'pr').length, 3);
  assert.equal(fixtures.filter((fixture) => fixture.kind === 'issue').length, 2);
});

test('scoreQualityEvalResponse catches localized PR marker labels', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-large-plus-small');
  const response = `## 代码评审报告: Fix ID parsing

**风险等级:** 高
**建议:** 请求修改
**摘要:** marker labels were localized

### 问题发现
1. **[High] parseId behavior changed**
   - Evidence: src/parse-id.js

### 行级发现
- [src/parse-id.js:2] parseInt changes behavior.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has recommendation marker').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has decision summary').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'large fixture discusses parse-id').pass, true);
});

test('scoreQualityEvalResponse requires inline PR findings to target changed lines', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-auth-bypass');
  const response = `## 代码评审报告: Make auth middleware more permissive

**风险等级:** 致命
**处理建议:** 请求修改
**决策摘要:** auth is bypassed

### 问题发现
1. **[Critical] auth bypass**
   - Evidence: src/auth.js
   - Smallest viable fix: restore 401

### 行级发现
- [src/auth.js:13] This points at nearby context instead of the changed return.
- [tests/auth.test.js:6] restore the exact 401 assertion.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'auth bypass has inline src/auth.js comment').pass, true);
  assert.equal(score.checks.find((check) => check.label === 'auth bypass inline targets changed src/auth.js line').pass, false);
});

test('scoreQualityEvalResponse requires exact CR report heading level', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-large-plus-small');
  const response = `### 代码评审报告: Fix ID parsing

**风险等级:** 高
**处理建议:** 请求修改
**决策摘要:** parseId changed

### 问题发现
1. **[High] parseId behavior changed**
   - Evidence: src/parse-id.js

### 行级发现
- [src/parse-id.js:2] parseInt changes behavior.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has CR report heading').pass, false);
});

test('linked issue fixture requires review to use acceptance criteria context', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-linked-issue-context');
  const response = `## 代码评审报告: Add dry-run mode

**风险等级:** 高
**处理建议:** 请求修改
**决策摘要:** PR misses the linked issue acceptance criteria.

### 级联分析
- 变更符号:
- 受影响流程:
- 变更集外调用方:
- 置信度: degraded

### 问题发现
1. **[高] dry-run still posts PR reviews**
   - 证据: linked Issue #77 acceptance criteria require dry-run to prevent issue comments and PR reviews, but scripts/review.mjs only skips issue comments.
   - 受影响调用方/流程: dry-run PR review path
   - 最小可行修复: gate both postComment and postPRReview when dry-run is enabled.

### 行级发现
- [scripts/review.mjs:8] dry-run is only checked before issue comments; apply it to PR reviews too.

### Karpathy 评审
- 假设:
- 简洁性:
- 变更范围:
- 验证:

### 缺失覆盖
- Add a PR dry-run test.`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'linked issue context is used').pass, true);
  assert.equal(score.checks.find((check) => check.label === 'linked issue fixture recommends changes').pass, true);
});

test('getChangedNewLines parses added lines from unified diffs', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'pr-auth-bypass');
  const authFile = fixture.files.find((file) => file.filename === 'src/auth.js');

  assert.deepEqual([...getChangedNewLines(authFile)], [12, 16]);
});

test('scoreQualityEvalResponse catches localized issue marker labels', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'issue-vague-crash');
  const response = `## Issue 分析: 登录后偶发 500

**质量分:** 2/5
**优先级:** P1-高
**类型:** 缺陷报告
**下一步动作:** 询问报告者

### 建议
- 请提供复现步骤和日志。`;

  const score = scoreQualityEvalResponse(fixture, response);

  assert.equal(score.checks.find((check) => check.label === 'has quality score').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has priority suggestion').pass, false);
  assert.equal(score.checks.find((check) => check.label === 'has maintainer next action').pass, false);
});

test('ready issue suggestion count is scoped to Suggestions section only', () => {
  const fixture = buildQualityEvalFixtures().find((item) => item.id === 'issue-ready-feature');
  const response = `## Issue 分析: Add dry-run mode

**质量评分:** 5/5
**优先级建议:** P3-低
**类型:** 功能请求
**维护者下一步动作:** 可以开始

### 完整性
- Problem statement: clear
- Reproduction steps: N/A
- Expected vs actual: described

### 建议
- 无需报告者继续补充。

### 总结
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
