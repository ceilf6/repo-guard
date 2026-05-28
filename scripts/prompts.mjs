// @ts-check
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');
const FALLBACK_PROMPTS_DIR = join(__dirname, '..', 'prompts');

function readSkillPrompt(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) {
    throw new Error(`Skill not found: ${skillName}. Ensure submodule is initialized.`);
  }

  let prompt = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');

  const refsDir = join(skillDir, 'references');
  if (existsSync(refsDir)) {
    const refPattern = /\[references\/([^\]]+)\]/g;
    const refs = [...prompt.matchAll(refPattern)].map((m) => m[1]);
    for (const ref of refs) {
      const refPath = join(refsDir, ref);
      if (existsSync(refPath)) {
        const content = readFileSync(refPath, 'utf-8');
        prompt += `\n\n---\n\n${content}`;
      }
    }
    // Also load any references not explicitly linked in SKILL.md
    for (const file of readdirSync(refsDir)) {
      if (file.endsWith('.md') && !refs.includes(file)) {
        const content = readFileSync(join(refsDir, file), 'utf-8');
        prompt += `\n\n---\n\n${content}`;
      }
    }
  }

  return prompt;
}

export function loadSystemPrompt(type, extraInstructions) {
  let prompt;

  if (existsSync(SKILLS_DIR)) {
    const skillName = type === 'pr' ? 'code-reviewer' : 'issue-reviewer';
    prompt = readSkillPrompt(skillName);
  } else {
    // Fallback to embedded prompts if submodule not available
    const filename = type === 'pr' ? 'pr-system.md' : 'issue-system.md';
    prompt = readFileSync(join(FALLBACK_PROMPTS_DIR, filename), 'utf-8');
  }

  if (extraInstructions) {
    prompt += `\n\n## 补充要求\n${extraInstructions}`;
  }

  return prompt;
}

const MAX_DIFF_SIZE = 100 * 1024;

export function getChangedNewLines(file) {
  const changedLines = new Set();
  let newLine = null;

  for (const line of (file.patch || '').split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === null) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    } else {
      newLine += 1;
    }
  }

  return changedLines;
}

function formatChangedLineTargets(files) {
  const lines = files
    .map((file) => {
      const changedLines = [...getChangedNewLines(file)];
      if (changedLines.length === 0) return '';
      return `- ${file.filename}: 变更行 ${formatLineList(changedLines)}`;
    })
    .filter(Boolean);

  if (lines.length === 0) return '';

  return [
    '## 行级评论行号目标',
    '在 `### 行级发现` 中使用这些新文件行号；不要自行推算邻近上下文行。',
    ...lines,
    '',
  ].join('\n');
}

function formatLineList(lines) {
  return lines.join(', ');
}

function formatFileStatus(status) {
  switch (status) {
    case 'added': return '新增';
    case 'removed': return '删除';
    case 'modified': return '修改';
    case 'renamed': return '重命名';
    case 'copied': return '复制';
    case 'changed': return '变更';
    case 'unchanged': return '未变更';
    default: return status;
  }
}

function formatLinkedIssueContext(linkedIssueContext) {
  if (!linkedIssueContext) return '';

  const issues = linkedIssueContext.issues || [];
  const warnings = linkedIssueContext.warnings || [];
  const lines = ['## 关联 Issue 上下文'];

  for (const warning of warnings) {
    lines.push(`> ⚠️ ${warning}`);
  }

  if (warnings.length > 0) {
    lines.push('> 关联上下文获取不完整，级联置信度 degraded；不要在产品意图不清晰时给出强 approval。');
  }

  if (issues.length === 0) {
    lines.push(warnings.length > 0 ? '未获取到可用关联 Issue。' : '未发现关联 Issue。');
    return `${lines.join('\n')}\n\n`;
  }

  for (const issue of issues) {
    lines.push('');
    lines.push(`### Issue #${issue.number}: ${issue.title}`);
    lines.push(`- 状态: ${issue.state || 'unknown'}`);
    lines.push(`- 作者: ${issue.user || 'unknown'}`);
    lines.push(`- 标签: ${(issue.labels || []).length > 0 ? issue.labels.join(', ') : '(无)'}`);
    lines.push(`- URL: ${issue.url || '(无)'}`);
    lines.push(`- 来源: ${(issue.sources || []).join(', ') || 'unknown'}`);
    lines.push('');
    lines.push('正文:');
    lines.push(issue.body || '(空)');
    if (issue.bodyTruncated) {
      lines.push('');
      lines.push('> ⚠️ Issue 正文已截断到 12000 字符。');
    }
  }

  return `${lines.join('\n')}\n\n`;
}

export function buildPRUserMessage(prInfo, files, linkedIssueContext) {
  let diffText = '';
  let totalSize = 0;
  let truncated = false;
  const includedFiles = [];

  const sorted = [...files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));

  let includedCount = 0;
  let omittedCount = 0;

  for (const file of sorted) {
    const entry = `\n### ${file.filename} (${formatFileStatus(file.status)}, +${file.additions} -${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    if (totalSize + entry.length > MAX_DIFF_SIZE) {
      truncated = true;
      omittedCount++;
      continue;
    }
    diffText += entry;
    totalSize += entry.length;
    includedFiles.push(file);
    includedCount++;
  }

  let message = `# PR: ${prInfo.title}\n\n`;
  message += `**作者:** ${prInfo.user}\n`;
  message += `**分支:** ${prInfo.head} → ${prInfo.base}\n`;
  message += `**统计:** +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} 个文件\n\n`;

  if (prInfo.body) {
    message += `## 描述\n${prInfo.body}\n\n`;
  }

  message += formatLinkedIssueContext(linkedIssueContext);
  message += `## 变更文件\n${files.map((f) => `- ${f.filename} (${formatFileStatus(f.status)})`).join('\n')}\n\n`;
  const inlineTargets = formatChangedLineTargets(includedFiles);
  if (inlineTargets) {
    message += `${inlineTargets}\n`;
  }
  message += `## 完整 PR 差异\n以下 diff 来自 PR 当前全部变更，而不是本次推送的增量提交。\n${diffText}`;

  if (truncated) {
    message += `\n\n> ⚠️ 差异已截断（超过 ${MAX_DIFF_SIZE / 1024}KB）。已省略 ${omittedCount} 个文件。评审聚焦于可纳入上下文的最大变更。`;
  }

  return message;
}

export function buildIssueUserMessage(issue) {
  let message = `# Issue: ${issue.title}\n\n`;
  message += `**作者:** ${issue.user}\n`;

  if (issue.labels.length > 0) {
    message += `**标签:** ${issue.labels.join(', ')}\n`;
  }

  message += `\n## 正文\n${issue.body || '(空)'}`;
  return message;
}
