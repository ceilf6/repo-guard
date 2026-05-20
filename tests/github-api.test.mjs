import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPRDiff } from '../scripts/github-api.mjs';

const originalFetch = globalThis.fetch;

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
