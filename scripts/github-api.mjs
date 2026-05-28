// @ts-check

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL_API = 'https://api.github.com/graphql';
const PAGE_SIZE = 100;
const MAX_LINKED_ISSUES = 10;
const MAX_LINKED_ISSUE_BODY_CHARS = 12000;
const HEADER = '> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\n';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function jsonHeaders(token) {
  return {
    ...headers(token),
    'Content-Type': 'application/json',
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
    number: data.number,
    title: data.title,
    body: data.body || '',
    url: data.html_url,
    base: data.base.ref,
    head: data.head.ref,
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

export async function fetchIssue(repo, issueNumber, token) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch issue: ${res.status}`);
  const data = await res.json();
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    labels: (data.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    user: data.user.login,
    state: data.state,
    url: data.html_url,
    pull_request: data.pull_request,
  };
}

export async function fetchPRLinkedIssues(repo, prNumber, prInfo, token) {
  const warnings = [];
  const issuesByNumber = new Map();

  try {
    const closingIssues = await fetchClosingIssueReferences(repo, prNumber, token);
    for (const issue of closingIssues) {
      addIssue(issuesByNumber, issue, 'linked');
    }
  } catch (err) {
    warnings.push(`获取 PR closing issues 失败: ${err.message}`);
  }

  const bodyRefs = extractIssueReferences(`${prInfo?.title || ''}\n${prInfo?.body || ''}`);
  for (const issueNumber of bodyRefs) {
    if (issuesByNumber.has(issueNumber)) {
      mergeSource(issuesByNumber.get(issueNumber), 'body-ref');
      continue;
    }
    if (issuesByNumber.size >= MAX_LINKED_ISSUES) break;

    try {
      const issue = await fetchIssue(repo, issueNumber, token);
      if (issue.pull_request) continue;
      addIssue(issuesByNumber, issue, 'body-ref');
    } catch (err) {
      warnings.push(`获取 PR 文本引用的 Issue #${issueNumber} 失败: ${err.message}`);
    }
  }

  return {
    issues: [...issuesByNumber.values()].slice(0, MAX_LINKED_ISSUES).map(truncateIssueBody),
    warnings,
  };
}

async function fetchClosingIssueReferences(repo, prNumber, token) {
  const [owner, name] = parseRepo(repo);
  const query = `
query RepoGuardLinkedIssues($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: ${MAX_LINKED_ISSUES}) {
        nodes {
          number
          title
          body
          state
          url
          author {
            login
          }
          labels(first: 20) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
}`;
  const res = await fetch(GITHUB_GRAPHQL_API, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ query, variables: { owner, name, number: Number(prNumber) } }),
  });
  if (!res.ok) throw new Error(`Failed to fetch closing issues: ${res.status}`);

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Failed to fetch closing issues: ${data.errors.map((err) => err.message).join('; ')}`);
  }

  return (data.data?.repository?.pullRequest?.closingIssuesReferences?.nodes || []).map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    labels: (issue.labels?.nodes || []).map((label) => label.name),
    user: issue.author?.login || '',
    state: issue.state,
    url: issue.url,
  }));
}

function parseRepo(repo) {
  const parts = String(repo || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo full name: ${repo}`);
  }
  return parts;
}

function extractIssueReferences(text) {
  const refs = new Set();
  const pattern = /(?:^|[^\w/])#([1-9]\d*)\b/g;
  let match;
  while ((match = pattern.exec(text || '')) !== null) {
    refs.add(Number.parseInt(match[1], 10));
  }
  return [...refs];
}

function addIssue(issuesByNumber, issue, source) {
  if (!issue?.number || issue.pull_request) return;
  const normalized = {
    number: issue.number,
    title: issue.title || '',
    body: issue.body || '',
    labels: issue.labels || [],
    user: issue.user || '',
    state: issue.state || '',
    url: issue.url || '',
    sources: [],
  };
  issuesByNumber.set(issue.number, normalized);
  mergeSource(normalized, source);
}

function mergeSource(issue, source) {
  if (!issue.sources.includes(source)) issue.sources.push(source);
}

function truncateIssueBody(issue) {
  if (issue.body.length <= MAX_LINKED_ISSUE_BODY_CHARS) return issue;
  return {
    ...issue,
    body: issue.body.slice(0, MAX_LINKED_ISSUE_BODY_CHARS),
    bodyTruncated: true,
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
