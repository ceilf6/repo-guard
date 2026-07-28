import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPRReview } from '../scripts/pr-reviewer.mjs';

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// Serves the GitHub reads buildPRReview performs, so the assertions can focus on
// the single model request it derives from them.
function stubReviewFetch(modelBodies) {
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/graphql')) {
      return jsonResponse({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } });
    }
    if (url.includes('/pulls/7/files')) {
      return jsonResponse([{
        filename: 'src/app.js',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;',
      }]);
    }
    if (url.includes('/pulls/7')) {
      return jsonResponse({
        number: 7,
        title: 'Add b',
        body: 'no linked issue',
        html_url: 'https://github.com/o/r/pull/7',
        base: { ref: 'main' },
        head: { ref: 'feature', sha: 'abc123' },
        user: { login: 'author' },
        additions: 1,
        deletions: 0,
        changed_files: 1,
      });
    }
    modelBodies.push(JSON.parse(options.body));
    return jsonResponse({ choices: [{ message: { content: '## 代码评审报告: Add b\n\n**处理建议:** 通过' } }] });
  };
}

function reviewConfig(overrides = {}) {
  return {
    repo: 'o/r',
    prNumber: 7,
    githubToken: 'gh-token',
    provider: 'openai',
    model: 'openai/gpt-5.6-sol',
    apiKey: 'secret',
    baseURL: 'https://openrouter.ai/api/v1',
    structuredOutput: 'off',
    ...overrides,
  };
}

test('buildPRReview routes the model request with the configured provider order', async () => {
  const modelBodies = [];
  stubReviewFetch(modelBodies);

  await buildPRReview(reviewConfig({ providerOrder: ['azure'] }));

  assert.equal(modelBodies.length, 1);
  assert.deepEqual(modelBodies[0].provider, { order: ['azure'] });
});

test('buildPRReview leaves the model request unrouted when no order is configured', async () => {
  const modelBodies = [];
  stubReviewFetch(modelBodies);

  await buildPRReview(reviewConfig());

  assert.equal(modelBodies.length, 1);
  assert.equal('provider' in modelBodies[0], false);
});
