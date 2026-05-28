import test from 'node:test';
import assert from 'node:assert/strict';
import * as githubApi from '../scripts/github-api.mjs';

const { fetchPRDiff, fetchPRLinkedIssues } = githubApi;

const originalFetch = globalThis.fetch;

test('github API does not expose incremental PR diff helpers', () => {
  assert.equal('fetchBotLogin' in githubApi, false);
  assert.equal('fetchLastReviewForUser' in githubApi, false);
  assert.equal('fetchCompareDiff' in githubApi, false);
});

test('fetchPRDiff fetches and maps a single page', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([
      {
        filename: 'scripts/review.mjs',
        status: 'modified',
        additions: 3,
        deletions: 1,
      },
    ]), { status: 200 });
  };

  const files = await fetchPRDiff('owner/repo', 7, 'token');

  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'scripts/review.mjs');
  assert.equal(files[0].patch, '');
  assert.match(calls[0], /per_page=100&page=1/);
});

test('fetchPRDiff concatenates multiple pages', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const page = new URL(String(url)).searchParams.get('page');
    const files = page === '1'
      ? Array.from({ length: 100 }, (_, index) => ({
          filename: `file-${index}.js`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: `@@ file ${index}`,
        }))
      : [{
          filename: 'file-100.js',
          status: 'added',
          additions: 2,
          deletions: 0,
          patch: '@@ file 100',
        }];

    return new Response(JSON.stringify(files), { status: 200 });
  };

  const files = await fetchPRDiff('owner/repo', 8, 'token');

  assert.equal(files.length, 101);
  assert.equal(files[0].filename, 'file-0.js');
  assert.equal(files[100].filename, 'file-100.js');
  assert.match(calls[0], /page=1/);
  assert.match(calls[1], /page=2/);
});

test('fetchPRDiff throws with status context on API failure', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response('rate limited', { status: 403 });

  await assert.rejects(
    () => fetchPRDiff('owner/repo', 9, 'token'),
    /Failed to fetch PR files: 403/,
  );
});

test('fetchPRLinkedIssues includes GraphQL closing issues and PR body refs', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/graphql')) {
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [{
                  number: 12,
                  title: 'Add dry-run mode',
                  body: 'Acceptance criteria: dry-run never posts comments.',
                  state: 'OPEN',
                  url: 'https://github.com/owner/repo/issues/12',
                  author: { login: 'product' },
                  labels: { nodes: [{ name: 'enhancement' }] },
                }],
              },
            },
          },
        },
      }), { status: 200 });
    }

    if (String(url).endsWith('/issues/13')) {
      return new Response(JSON.stringify({
        number: 13,
        title: 'Keep default posting behavior',
        body: 'Existing workflows must keep posting reviews by default.',
        state: 'open',
        html_url: 'https://github.com/owner/repo/issues/13',
        user: { login: 'maintainer' },
        labels: [{ name: 'bug' }],
      }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await fetchPRLinkedIssues('owner/repo', 7, {
    title: 'Implement dry-run support',
    body: 'Closes #12 and relates to #13. Ignore owner/repo#99.',
  }, 'token');

  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.issues.map((issue) => issue.number), [12, 13]);
  assert.deepEqual(result.issues[0].sources, ['linked', 'body-ref']);
  assert.deepEqual(result.issues[1].sources, ['body-ref']);
  assert.match(result.issues[0].body, /dry-run never posts/);
  assert.equal(calls.filter((call) => call.url.endsWith('/issues/12')).length, 0);
  assert.equal(calls.filter((call) => call.url.endsWith('/issues/99')).length, 0);
});

test('fetchPRLinkedIssues skips issue references that are pull requests', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/graphql')) {
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: { nodes: [] },
            },
          },
        },
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      number: 22,
      title: 'This is actually a PR',
      body: 'Do not include this.',
      state: 'open',
      html_url: 'https://github.com/owner/repo/pull/22',
      user: { login: 'dev' },
      labels: [],
      pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/22' },
    }), { status: 200 });
  };

  const result = await fetchPRLinkedIssues('owner/repo', 8, {
    title: 'Follow-up',
    body: 'Mentioned in #22.',
  }, 'token');

  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 0);
});

test('fetchPRLinkedIssues continues with degraded warning on API failure', async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/graphql')) {
      return new Response(JSON.stringify({ message: 'rate limited' }), { status: 403 });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };

  const result = await fetchPRLinkedIssues('owner/repo', 9, {
    title: 'Needs context #14',
    body: '',
  }, 'token');

  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join('\n'), /closing issues.*403/);
  assert.match(result.warnings.join('\n'), /#14.*404/);
});
