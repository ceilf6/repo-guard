import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderRouting, parseProviderOrder } from '../scripts/openrouter-provider-routing.mjs';

test('parseProviderOrder defaults to an empty order', () => {
  assert.deepEqual(parseProviderOrder(), []);
  assert.deepEqual(parseProviderOrder(''), []);
  assert.deepEqual(parseProviderOrder('  ,  , '), []);
});

test('parseProviderOrder trims entries and keeps configured precedence', () => {
  assert.deepEqual(parseProviderOrder('azure'), ['azure']);
  assert.deepEqual(parseProviderOrder(' azure , openai '), ['azure', 'openai']);
});

test('parseProviderOrder normalizes display-name casing to provider slugs', () => {
  assert.deepEqual(parseProviderOrder('Azure, OpenAI'), ['azure', 'openai']);
});

test('parseProviderOrder rejects duplicates that cannot express a precedence', () => {
  assert.throws(
    () => parseProviderOrder('azure,Azure'),
    /LLM_PROVIDER_ORDER contains duplicate provider "Azure" \(slug "azure"\)/,
  );
});

test('buildProviderRouting omits the field when nothing is configured', () => {
  assert.equal(buildProviderRouting(), undefined);
  assert.equal(buildProviderRouting({ order: [] }), undefined);
});

test('buildProviderRouting combines order with the structured output requirement', () => {
  assert.deepEqual(buildProviderRouting({ order: ['azure'] }), { order: ['azure'] });
  assert.deepEqual(buildProviderRouting({ requireParameters: true }), { require_parameters: true });
  assert.deepEqual(
    buildProviderRouting({ order: ['azure', 'openai'], requireParameters: true }),
    { order: ['azure', 'openai'], require_parameters: true },
  );
});

test('buildProviderRouting copies the order so callers cannot mutate the request body', () => {
  const order = ['azure'];
  const routing = buildProviderRouting({ order });
  order.push('openai');
  assert.deepEqual(routing.order, ['azure']);
});
