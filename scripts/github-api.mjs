// @ts-check

const GITHUB_API = 'https://api.github.com';
const BOT_MARKER = '<!-- repo-guard:v1 -->';
const HEADER = '> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\n';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function fetchPRInfo(repo, prNumber, token) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch PR info: ${res.status}`);
  const data = await res.json();
  return {
    title: data.title,
    body: data.body || '',
    base: data.base.ref,
    head: data.head.ref,
    user: data.user.login,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changed_files,
  };
}

export async function fetchPRDiff(repo, prNumber, token) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch PR files: ${res.status}`);
  const files = await res.json();
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));
}

export async function fetchIssue(repo, issueNumber, token) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch issue: ${res.status}`);
  const data = await res.json();
  return {
    title: data.title,
    body: data.body || '',
    labels: (data.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    user: data.user.login,
    state: data.state,
  };
}

export async function postComment(repo, number, body, token) {
  const markedBody = `${BOT_MARKER}\n${HEADER}${body}`;
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ body: markedBody }),
  });
  if (!res.ok) throw new Error(`Failed to post comment: ${res.status}`);
}

export async function postPRReview(repo, prNumber, body, event, comments, token) {
  const markedBody = `${BOT_MARKER}\n${HEADER}${body}`;
  const payload = {
    body: markedBody,
    event,
    comments: comments || [],
  };

  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Failed to post PR review: ${res.status} ${errBody}`);
  }
}
