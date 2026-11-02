import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallContext, ModelDelta, ModelReply, ModelRequest } from '@agent-layers/core';
import { assembleDeltas } from '@agent-layers/core';
import { costOf, pricingFor, type ModelRef, type ModelRequest as LoopRequest, type ModelResponse, type Provider } from 'reinloop';
import { StackFeed, type ReasoningEvent, type UsageEvent } from './feed.ts';
import { EXT, hubAnthropicPort, hubMockPort, MockScripts, tap, ThinkingMemory, toLoopRequest, toolAlias, Transcripts } from './model.ts';

const person = { id: 'a1', name: 'Ilse', model: 'anthropic/claude-sonnet-5-5', tier: 'sonnet' };
const ctx = (extra: Partial<CallContext> = {}): CallContext => ({ runId: 'r1', agent: 'decide', ...extra });
const tools = [
  { name: 'world__commit_plan', description: 'plan', params: { type: 'object', properties: {} } },
  { name: 'world__say', description: 'say', params: { type: 'object', properties: {} } },
  { name: 'lorebase__lorebase_search', description: 'search', params: { type: 'object', properties: {} } },
];
const user = (text: string) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text }] });
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'default', messages: [user('hello')], tools, ...extra });

/** A provider that plays the given responses and keeps the requests it got. */
function fakeProvider(responses: Array<ModelResponse | ((req: LoopRequest, g: { onText?: (t: string) => void; onThinking?: (t: string) => void }) => ModelResponse)>) {
  const requests: LoopRequest[] = [];
  const provider: Provider = {
    name: 'fake',
    async generate(req, g) {
      requests.push(req);
      const next = responses[requests.length - 1] ?? responses.at(-1)!;
      return typeof next === 'function' ? next(req, g) : next;
    },
  };
  const ref: ModelRef = { provider, model: 'claude-sonnet-5-5' };
  return { requests, resolve: () => ref };
}

const reply = (parts: ModelResponse['message']['parts'], extra: Partial<ModelResponse> = {}): ModelResponse => ({
  message: { role: 'assistant', parts }, usage: { inputTokens: 100, outputTokens: 20 }, stopReason: parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'end', ...extra,
});

test('toolAlias: the model sees plain names while they are unique, the stack gets the prefixed ones back', () => {
  const a = toolAlias(tools);
  assert.equal(a.toModel('world__commit_plan'), 'commit_plan');
  assert.equal(a.fromModel('commit_plan'), 'world__commit_plan');
  assert.equal(a.fromModel('unknown'), 'unknown');
  // Two sources with the same tool name keep their prefixes.
  const clash = toolAlias([{ name: 'a__x' }, { name: 'b__x' }, { name: 'a__y' }]);
  assert.equal(clash.toModel('a__x'), 'a__x');
  assert.equal(clash.toModel('a__y'), 'y');
  // A plain tool of the same name wins over an alias.
  assert.equal(toolAlias([{ name: 'a__x' }, { name: 'x' }]).toModel('a__x'), 'a__x');
});

test('hub-anthropic: provider gets plain tool names, params from ext, system as instructions; reply names are prefixed again', async () => {
  const fake = fakeProvider([reply([{ type: 'tool_call', id: 't1', name: 'commit_plan', args: { reason: 'x' } }])]);
  const port = hubAnthropicPort({ model: 'claude-sonnet-5-5', resolve: fake.resolve });
  const out = await port.chat(request({
    messages: [{ role: 'system', parts: [{ type: 'text', text: 'be brief' }] }, user('plan')],
    settings: { maxOutputTokens: 300 },
    ext: { [EXT.params]: { thinking: { type: 'adaptive', display: 'omitted' }, effort: 'low', cache: true, cacheTtl: '5m' } },
  }), ctx());
  const sent = fake.requests[0]!;
  assert.deepEqual(sent.tools.map((t) => t.name), ['commit_plan', 'say', 'lorebase_search']);
  assert.equal(sent.instructions, 'be brief');
  assert.deepEqual(sent.params, { maxTokens: 300, thinking: { type: 'adaptive', display: 'omitted' }, effort: 'low', cache: true, cacheTtl: '5m' });
  assert.equal('temperature' in (sent.params ?? {}), false);
  assert.equal(out.finish, 'tools');
  assert.deepEqual(out.message.parts, [{ type: 'call', id: 't1', tool: 'world__commit_plan', args: { reason: 'x' } }]);
});

test('hub-anthropic: thinking blocks with their signature come back with the tool results even when the runtime drops them', async () => {
  const thinking = { type: 'thinking' as const, text: '', signature: 'sig-1' };
  const fake = fakeProvider([
    reply([thinking, { type: 'tool_call', id: 't1', name: 'say', args: { to: 'all', text: 'hi' } }]),
    reply([{ type: 'text', text: 'done' }]),
  ]);
  const port = hubAnthropicPort({ model: 'claude-sonnet-5-5', resolve: fake.resolve });
  const first = await port.chat(request(), ctx());
  const withSignature = first.message.parts.find((p) => p.type === 'reasoning') as { ext?: Record<string, unknown> };
  assert.equal(withSignature.ext?.[EXT.signature], 'sig-1');
  // The next request carries the assistant turn as the runtime rebuilt it: reasoning without the signature (or none at all).
  const history = [
    user('plan'),
    { role: 'assistant' as const, parts: first.message.parts.filter((p) => p.type === 'call') },
    { role: 'tool' as const, parts: [{ type: 'result' as const, callId: 't1', ok: true, text: 'said' }] },
  ];
  await port.chat(request({ messages: history }), ctx());
  const assistant = fake.requests[1]!.messages.find((m) => m.role === 'assistant')!;
  assert.deepEqual(assistant.parts[0], thinking);
  assert.equal(assistant.parts[1]!.type, 'tool_call');
  const result = fake.requests[1]!.messages.find((m) => m.role === 'tool')!.parts[0]!;
  assert.equal(result.type === 'tool_result' && result.name, 'say');
});

test('hub-anthropic stream: text and reasoning are streamed, calls and usage close the stream', async () => {
  const fake = fakeProvider([(_req, g) => {
    g.onThinking?.('hmm');
    g.onText?.('Ciao ');
    g.onText?.('Mara');
    return reply([{ type: 'thinking', text: 'hmm', signature: 's' }, { type: 'text', text: 'Ciao Mara' }, { type: 'tool_call', id: 't9', name: 'say', args: { to: 'all' } }], {
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 },
    });
  }]);
  const port = hubAnthropicPort({ model: 'claude-sonnet-5-5', resolve: fake.resolve });
  const deltas: ModelDelta[] = [];
  for await (const d of port.stream!(request(), ctx())) deltas.push(d);
  assert.deepEqual(deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text), ['Ciao ', 'Mara']);
  assert.equal(deltas.filter((d) => d.type === 'reasoning').length, 1);
  const whole = assembleDeltas(deltas, 'm');
  assert.equal(whole.finish, 'tools');
  assert.equal(whole.usage?.ext?.[EXT.cacheRead], 30);
  assert.equal(deltas.at(-1)!.type, 'end');
});

test('hub-anthropic stream: a provider failure reaches the consumer', async () => {
  const port = hubAnthropicPort({ model: 'claude-sonnet-5-5', resolve: () => ({ provider: { name: 'x', generate: async () => { throw new Error('boom'); } }, model: 'm' }) });
  await assert.rejects(async () => { for await (const _ of port.stream!(request(), ctx())) { /* drain */ } }, /boom/);
});

test('ThinkingMemory keeps a bounded number of calls', () => {
  const m = new ThinkingMemory(2);
  m.remember(['a'], [{ type: 'thinking', text: '', signature: 'sa' }]);
  m.remember(['b'], [{ type: 'thinking', text: '', signature: 'sb' }]);
  m.remember(['c'], [{ type: 'thinking', text: '', signature: 'sc' }]);
  const call = (id: string) => [{ type: 'tool_call' as const, id, name: 'n', args: {} }];
  assert.equal(m.restore(call('a')).length, 1);
  assert.equal(m.restore(call('c')).length, 2);
});

test('toLoopRequest: roles, results named after their call, invalid arguments flagged', () => {
  const req: ModelRequest = {
    model: 'm',
    messages: [
      user('go'),
      { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 'world__say', args: {} }, { type: 'call', id: 'c2', tool: 'world__say', args: {}, invalid: '{bad' }] },
      { role: 'tool', parts: [{ type: 'result', callId: 'c1', ok: false, text: 'no' }] },
    ],
    tools,
  };
  const out = toLoopRequest(req, toolAlias(tools));
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'tool']);
  const calls = out.messages[1]!.parts;
  assert.equal(calls[1]!.type === 'tool_call' && calls[1]!.argsIssue?.repaired, false);
  assert.deepEqual(out.messages[2]!.parts[0], { type: 'tool_result', callId: 'c1', name: 'say', content: 'no', isError: true });
});

test('hub-mock plays the run script with plain tool names, reports thinking and falls back to an echo', async () => {
  const scripts = new MockScripts();
  const seen: LoopRequest[] = [];
  scripts.set('r1', (req, i) => {
    seen.push(req);
    return i === 0
      ? { parts: [{ type: 'thinking', text: 'ragiono' }], toolCalls: [{ name: 'commit_plan', args: { reason: 'ok', steps: [] } }] }
      : { text: 'fatto' };
  });
  const port = hubMockPort({ model: 'mock/x', scripts });
  const first = await port.chat(request(), ctx());
  assert.deepEqual(first.message.parts.map((p) => p.type), ['reasoning', 'call']);
  assert.equal((first.message.parts[1] as { tool: string }).tool, 'world__commit_plan');
  assert.equal(first.finish, 'tools');
  assert.equal(seen[0]!.tools[0]!.name, 'commit_plan');
  const second = await port.chat(request(), ctx());
  assert.equal(second.finish, 'end');
  assert.equal(first.model, 'mock/x');
  const echoed = await port.chat(request(), ctx({ runId: 'other' }));
  assert.deepEqual(echoed.message.parts, [{ type: 'text', text: 'hello' }]);
  const words: string[] = [];
  for await (const d of port.stream!(request(), ctx({ runId: 'other' }))) if (d.type === 'text') words.push(d.text);
  assert.equal(words.join(''), 'hello');
});

test('hub-mock: a scripted error and an aborted wait are thrown', async () => {
  const scripts = new MockScripts();
  scripts.set('r1', () => ({ error: { status: 529, message: 'overloaded' } }));
  scripts.set('r2', () => ({ delayMs: 10_000, text: 'late' }));
  const port = hubMockPort({ scripts });
  await assert.rejects(port.chat(request(), ctx()), (e: Error & { status?: number }) => e.status === 529);
  const stop = new AbortController();
  const pending = port.chat(request(), ctx({ runId: 'r2', signal: stop.signal }));
  stop.abort();
  await assert.rejects(pending, /abort/i);
});

test('tap reports usage with cache counts and price, and reasoning, and keeps the transcript of the run', async () => {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100 };
  const fake = fakeProvider([reply([{ type: 'thinking', text: 'penso al piano', signature: 'sg' }, { type: 'text', text: 'ok' }], { usage })]);
  const feed = new StackFeed();
  const usages: UsageEvent[] = [];
  const reasons: ReasoningEvent[] = [];
  feed.on('usage', (u) => usages.push(u));
  feed.on('reasoning', (r) => reasons.push(r));
  const transcripts = new Transcripts();
  const port = tap(hubAnthropicPort({ model: 'claude-sonnet-5-5', resolve: fake.resolve }), person, feed, transcripts);
  await port.chat(request(), ctx());
  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0]!.usage, usage);
  assert.equal(usages[0]!.person.id, 'a1');
  assert.equal(usages[0]!.agent, 'decide');
  const price = pricingFor('claude-sonnet-5-5');
  assert.equal(usages[0]!.costUsd, price ? costOf(price, usage) : 0);
  assert.deepEqual(reasons.map((r) => r.text), ['penso al piano']);
  const t = transcripts.take('r1')!;
  assert.deepEqual(t.map((m) => m.role), ['user', 'assistant']);
  assert.equal(transcripts.take('r1'), undefined);
});

test('tap on a streamed call: events after the stream, transcript from the assembled reply; a listener that throws is isolated', async () => {
  const scripts = new MockScripts();
  scripts.set('r1', () => ({ parts: [{ type: 'thinking', text: 'think' }], text: 'one two' }));
  const feed = new StackFeed();
  const seen: string[] = [];
  feed.on('usage', () => { throw new Error('listener'); });
  feed.on('reasoning', (r) => seen.push(r.text));
  const port = tap(hubMockPort({ scripts }), person, feed);
  const text: string[] = [];
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    for await (const d of port.stream!(request(), ctx())) if (d.type === 'text') text.push(d.text);
  } finally {
    console.warn = origWarn;
  }
  assert.equal(text.join(''), 'one two');
  assert.deepEqual(seen, ['think']);
  const last = port.transcripts.take('r1')!.at(-1)!;
  assert.deepEqual(last.parts.map((p) => p.type), ['reasoning', 'text']);
});

test('a reply without usage or reasoning reports nothing', async () => {
  const feed = new StackFeed();
  let n = 0;
  feed.on('usage', () => n++);
  feed.on('reasoning', () => n++);
  const port = tap({ chat: async (): Promise<ModelReply> => ({ model: 'm', message: { role: 'assistant', parts: [{ type: 'text', text: 'x' }] }, finish: 'end' }) }, person, feed);
  await port.chat(request(), ctx());
  assert.equal(n, 0);
});
