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
