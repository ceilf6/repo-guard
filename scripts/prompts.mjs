// @ts-check
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

export function loadSystemPrompt(type, language, extraInstructions) {
  const filename = type === 'pr' ? 'pr-system.md' : 'issue-system.md';
  let prompt = readFileSync(join(PROMPTS_DIR, filename), 'utf-8');

  if (language === 'zh') {
    prompt += '\n\n## Language Instruction\nRespond in Chinese (简体中文). Use Chinese for all analysis, findings, and suggestions.';
  }

  if (extraInstructions) {
    prompt += `\n\n## Additional Instructions\n${extraInstructions}`;
  }

  return prompt;
}

const MAX_DIFF_SIZE = 100 * 1024;

export function buildPRUserMessage(prInfo, files) {
  let diffText = '';
  let totalSize = 0;
  let truncated = false;

  const sorted = [...files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));

  let includedCount = 0;

  for (const file of sorted) {
    const entry = `\n### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    if (totalSize + entry.length > MAX_DIFF_SIZE) {
      truncated = true;
      break;
    }
    diffText += entry;
    totalSize += entry.length;
    includedCount++;
  }

  let message = `# Pull Request: ${prInfo.title}\n\n`;
  message += `**Author:** ${prInfo.user}\n`;
  message += `**Branch:** ${prInfo.head} → ${prInfo.base}\n`;
  message += `**Stats:** +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files\n\n`;

  if (prInfo.body) {
    message += `## Description\n${prInfo.body}\n\n`;
  }

  message += `## Changed Files\n${files.map((f) => `- ${f.filename} (${f.status})`).join('\n')}\n\n`;
  message += `## Diff\n${diffText}`;

  if (truncated) {
    const omitted = files.length - includedCount;
    message += `\n\n> ⚠️ Diff truncated (exceeded ${MAX_DIFF_SIZE / 1024}KB). ${omitted} file(s) omitted. Review focused on largest changes.`;
  }

  return message;
}

export function buildIssueUserMessage(issue) {
  let message = `# Issue: ${issue.title}\n\n`;
  message += `**Author:** ${issue.user}\n`;

  if (issue.labels.length > 0) {
    message += `**Labels:** ${issue.labels.join(', ')}\n`;
  }

  message += `\n## Body\n${issue.body || '(empty)'}`;
  return message;
}
