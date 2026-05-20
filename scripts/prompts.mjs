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

export function loadSystemPrompt(type, language, extraInstructions) {
  let prompt;

  if (existsSync(SKILLS_DIR)) {
    const skillName = type === 'pr' ? 'code-reviewer' : 'issue-reviewer';
    prompt = readSkillPrompt(skillName);
  } else {
    // Fallback to embedded prompts if submodule not available
    const filename = type === 'pr' ? 'pr-system.md' : 'issue-system.md';
    prompt = readFileSync(join(FALLBACK_PROMPTS_DIR, filename), 'utf-8');
  }

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
