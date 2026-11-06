import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availability, chooseMode, modelsInUse, modelSpec, providerOf } from './models.ts';

const models = { opus: 'anthropic/claude-opus-5-5', sonnet: 'anthropic/claude-sonnet-5-5', haiku: 'anthropic/claude-haiku-5-5' };

test('model specs: a bare id is an Anthropic model, a prefixed one keeps its provider', () => {
  assert.equal(modelSpec('claude-haiku-5-5'), 'anthropic/claude-haiku-5-5');
  assert.equal(modelSpec('ollama/qwen3:4b'), 'ollama/qwen3:4b');
  assert.equal(providerOf('claude-haiku-5-5'), 'anthropic');
  assert.equal(providerOf('openrouter/openai/gpt-5-mini'), 'openrouter');
});

test('availability: a hosted provider needs its key, a local server none, the mock and unknown providers cannot run live', () => {
  assert.deepEqual(availability('anthropic/claude-haiku-5-5', {}), { provider: 'anthropic', live: false, reason: 'anthropic/claude-haiku-5-5 needs ANTHROPIC_API_KEY' });
  assert.deepEqual(availability('claude-haiku-5-5', { ANTHROPIC_API_KEY: 'k' }), { provider: 'anthropic', live: true });
  assert.deepEqual(availability('ollama/qwen3:4b', {}), { provider: 'ollama', live: true });
  assert.equal(availability('openai/gpt-5-mini', {}).reason, 'openai/gpt-5-mini needs OPENAI_API_KEY');
  assert.equal(availability('mock/echo', {}).live, false);
  const unknown = availability('nosuch/model', {});
  assert.equal(unknown.live, false);
  assert.match(unknown.reason ?? '', /unknown provider "nosuch"/);
});

test('modelsInUse: the override alone, else the tier models and the roster models', () => {
  assert.deepEqual(modelsInUse({ models, modelOverride: 'ollama/qwen3:4b', roster: [{ model: 'anthropic/claude-opus-5-5' }] }), ['ollama/qwen3:4b']);
  assert.deepEqual(modelsInUse({ models, roster: [{ model: 'openai/gpt-5-mini' }, {}] }), [...Object.values(models), 'openai/gpt-5-mini']);
});

test('chooseMode: mock when asked or when a model in use cannot run; the provider of the run otherwise', () => {
  assert.deepEqual(chooseMode({ models, forceMock: true }, { ANTHROPIC_API_KEY: 'k' }), { mock: true, provider: 'mock', reason: 'requested (--mock or SIM_MOCK=1)' });
  assert.deepEqual(chooseMode({ models, forceMock: false }, {}), { mock: true, provider: 'mock', reason: 'anthropic/claude-opus-5-5 needs ANTHROPIC_API_KEY' });
  assert.deepEqual(chooseMode({ models, forceMock: false }, { ANTHROPIC_API_KEY: 'k' }), { mock: false, provider: 'anthropic' });
  assert.deepEqual(chooseMode({ models, forceMock: false, modelOverride: 'ollama/qwen3:4b' }, {}), { mock: false, provider: 'ollama' });
  assert.deepEqual(chooseMode({ models, forceMock: false, roster: [{ model: 'ollama/qwen3:4b' }] }, { ANTHROPIC_API_KEY: 'k' }), { mock: false, provider: 'anthropic+ollama' });
});
