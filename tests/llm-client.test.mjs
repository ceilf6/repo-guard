import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseURL } from '../scripts/llm-client.mjs';

test('normalizeBaseURL uses provider defaults', () => {
  assert.equal(normalizeBaseURL('openai', ''), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseURL('anthropic', ''), 'https://api.anthropic.com/v1');
});

test('normalizeBaseURL normalizes OpenAI-compatible relays', () => {
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('openai', 'https://relay.example.com/v1/chat/completions'), 'https://relay.example.com/v1');
});

test('normalizeBaseURL normalizes Anthropic-compatible relays', () => {
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(normalizeBaseURL('anthropic', 'https://relay.example.com/v1/messages'), 'https://relay.example.com/v1');
});
