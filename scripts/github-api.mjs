// @ts-check

const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
const HEADER = '> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\n';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function fetchAllPages(url, token, description) {
  const items = [];
  let page = 1;

  while (true) {
    const separator = url.includes('?') ? '&' : '?';
    const pagedURL = `${url}${separator}per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(pagedURL, {
      headers: headers(token),
    });
    if (!res.ok) throw new Error(`Failed to fetch ${description}: ${res.status}`);

    const pageItems = await res.json();
    items.push(...pageItems);

    if (pageItems.length < PAGE_SIZE) break;
    page++;
  }

  return items;
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
    headSha: data.head.sha,
    user: data.user.login,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changed_files,
  };
}

export async function fetchPRDiff(repo, prNumber, token) {
  const files = await fetchAllPages(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files`, token, 'PR files');
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));
}

export async function fetchBotLogin(token) {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch bot login: ${res.status}`);
  const data = await res.json();
  return data.login;
}

export async function fetchLastReviewForUser(repo, prNumber, userLogin, token) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch PR reviews: ${res.status}`);
  const reviews = await res.json();
  // Iterate in reverse to find the latest non-dismissed review by this user
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i];
    if (r.user.login === userLogin && r.state !== 'DISMISSED' && r.commit_id) {
      return r.commit_id;
    }
  }
  return null;
}

export async function fetchCompareDiff(repo, baseSha, headSha, token) {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/compare/${baseSha}...${headSha}`, {
      headers: headers(token),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'diverged') return null;
    return (data.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || '',
    }));
  } catch {
    return null;
  }
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
  const markedBody = `${HEADER}${body}`;
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ body: markedBody }),
  });
  if (!res.ok) throw new Error(`Failed to post comment: ${res.status}`);
}

export async function postPRReview(repo, prNumber, body, event, comments, token) {
  const markedBody = `${HEADER}${body}`;
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
