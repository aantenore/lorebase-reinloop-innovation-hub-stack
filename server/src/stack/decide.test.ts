import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Message, RunInput, RunEvent } from '@agent-layers/core';
import type { Tool } from 'reinloop';
import { loadConfig } from '../config.ts';
import { closableRun, closingMessages, decide, isFailure, reply, type DecideHost } from '../rt/decide.ts';
import { loadGameConfig } from '../rt/config.ts';
import { Game } from '../rt/game.ts';
import type { RtEntity } from '../rt/world.ts';
import { StackFeed, type StackHub, type CapResult, type Capacity, type RunOpts } from './index.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'hub-decide-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------
// End to end on the offline model: the game's own decide host, the real hub.

/** Lets the span of a finished run reach the feed's listeners. */
const settled = () => new Promise((r) => setTimeout(r, 20));

function world() {
  const sim = loadConfig(['--mock'], {});
  const game = loadGameConfig({});
  const g = new Game(sim, { ...game, stack: { dataDir }, mock: { ...game.mock, thinkDelayMs: 0, replyDelayMs: 0 } });
  g.world.rules = new Proxy({}, { get: () => 1 }) as typeof g.world.rules;
  const host = (g as unknown as { decideHost(): DecideHost }).decideHost();
  // The game's own hub: its feed books usage, runs and reasoning in the game's ledger.
  const hub = g.stacks;
  assert.equal(host.stacks, hub);
  host.recall = async () => [];
  const spawn = (name: string) => g.world.spawn({ name, role: 'elder', tier: 'haiku', model: 'mock', kind: 'agent' }) as RtEntity;
  return { g, host, hub, spawn };
}

test('decide on the offline model commits a plan through the stack and counts its usage', async () => {
  const { g, host, hub, spawn } = world();
  try {
    const mara = spawn('Mara Bianca');
    const out = await decide(host, mara, 'test');
    assert.ok(!isFailure(out), isFailure(out) ? out.error : '');
    assert.ok(out.steps.length > 0);
    assert.equal(typeof out.reason, 'string');
    // Counted once, by the feed: one run, no failure, its tokens.
    await settled();
    const row = g.usage.rows.get(mara.id)!;
    assert.deepEqual([row.runs, row.failures], [1, 0]);
    assert.ok(row.inputTokens > 0);
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

test('reply on the offline model streams its words and ends', async () => {
  const { g, host, hub, spawn } = world();
  try {
    const a = spawn('Mara Bianca');
    const b = spawn('Luca Rossi');
    const deltas: string[] = [];
    const out = await reply(host, a, b, (d) => deltas.push(d));
    assert.equal(out.error, undefined);
    assert.equal(out.rethink, false);
    assert.ok(out.text.length > 0);
    assert.equal(deltas.join('').trim(), out.text);
    await settled();
    assert.equal(g.usage.rows.get(a.id)!.runs, 1);
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

test('on the real stack a run cut off by its turn budget is closable, and its transcript closes on the decide_close agent', async () => {
  const { g, host, hub, spawn } = world();
  try {
    const e = spawn('Mara Bianca');
    const ps = await hub.stackFor(e);
    const tools: Tool[] = [
      { name: 'commit_plan', description: 'c', schema: { type: 'object' }, run: (a: { reason: string }) => ({ content: 'ok', stop: true, data: { summary: a.reason, steps: [{ action: 'wait' }] } }) },
      { name: 'say', description: 's', schema: { type: 'object' }, run: () => 'said' },
    ];
    const first = await ps.run('decide', { messages: [{ role: 'system', parts: [{ type: 'text', text: 'sys' }] }, { role: 'user', parts: [{ type: 'text', text: 'go' }] }] }, {
      sessionId: 'a', tools, mock: () => ({ toolCalls: [{ name: 'say', args: {} }] }),
    });
    assert.equal(first.run.status, 'stopped');
    assert.ok(closableRun(first.run), JSON.stringify(first.run.reason));
    assert.equal(first.plan, undefined);
    const messages = closingMessages(first.transcript!, [{ name: 'say', content: 'said', isError: false }], 'chiudi', 'no');
    assert.deepEqual(messages.slice(-3).map((m) => m.role), ['assistant', 'tool', 'user']);
    let seen: string[] = [];
    const closing = await ps.run('decide_close' as Capacity, { messages }, {
      sessionId: 'b', tools,
      mock: (req) => {
        seen = req.messages.map((m) => m.role);
        return { toolCalls: [{ name: 'commit_plan', args: { reason: 'chiuso' } }] };
      },
    });
    assert.equal(closing.plan?.summary, 'chiuso');
    assert.equal(seen[0], 'user');
    assert.equal(seen.at(-1), 'user');
    assert.ok(seen.includes('tool'));
    assert.deepEqual(ps.stack.config.agents.decide_close!.ext?.['reinloop.budget'], { maxTurns: host.cfg.decisions.closingTurn.maxTurns });
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Orchestration: a scripted stack stands in for the person's stack.

const text = (t: string): Message => ({ role: 'user', parts: [{ type: 'text', text: t }] });

interface Call {
  cap: string;
  input: RunInput;
  opts: RunOpts;
}

/** A hub whose people run `script` instead of a model: it gets the capacity, the input and the run's tools. */
function scripted(host: DecideHost, script: (call: Call, feed: StackFeed) => Promise<{ events?: RunEvent[]; result: CapResult }>) {
  const calls: Call[] = [];
  const feed = new StackFeed();
  const ps = {
    stream(cap: Capacity, input: RunInput, opts: RunOpts) {
      const call = { cap, input, opts };
      calls.push(call);
      const done = script(call, feed);
      return {
        result: done.then((d) => d.result),
        async *[Symbol.asyncIterator]() {
          for (const ev of (await done).events ?? []) yield ev;
        },
      };
    },
  };
  host.stacks = { feed, stackFor: async () => ps } as unknown as StackHub;
  return calls;
}

const run = (runId: string, status: 'completed' | 'stopped', detail?: string) => ({
  runId, status, output: '', ...(detail ? { reason: { code: 'limit', detail } } : {}),
}) as CapResult['run'];

const toolOf = (tools: Tool[] | undefined, name: string) => tools!.find((t) => t.name === name)!;
const noCtx = {} as never;

test('closing turn: the run cut off by its budget gets the notice and the results of its last calls, then only commit_plan answers', async () => {
  const { g, host, hub, spawn } = world();
  const transcript: Message[] = [
    { role: 'system', parts: [{ type: 'text', text: 'sys' }] },
    { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 'world__say', args: { to: 'all', text: 'ciao' } }, { type: 'call', id: 'c2', tool: 'world__share_insight', args: {} }] },
  ];
  let said = '';
  const calls = scripted(host, async (call) => {
    const tools = call.opts.tools;
    if (call.cap === 'decide') {
      said = String((await toolOf(tools, 'say').run({ to: 'all', text: 'ciao' }, noCtx) as string));
      return { result: { run: run('r1', 'stopped', 'maxTurns'), transcript } };
    }
    // closing run: other tools are refused, commit_plan commits
    const refused = await toolOf(tools, 'say').run({ to: 'all', text: 'again' }, noCtx) as { isError: boolean };
    assert.equal(refused.isError, true);
    const out = await toolOf(tools, 'commit_plan').run({ reason: 'fatto', steps: [{ action: 'wait', label: 'w', minutes: 1 }] }, noCtx) as { stop: boolean; data: unknown };
    assert.equal(out.stop, true);
    return { result: { run: run('r2', 'completed'), plan: out.data as never } };
  });
  const closed: boolean[] = [];
  host.closed = (_e, committed) => void closed.push(committed);
  try {
    const d = await decide(host, spawn('Mara Bianca'), 'test');
    assert.ok(!isFailure(d), isFailure(d) ? d.error : '');
    assert.equal(d.reason, 'fatto');
    assert.deepEqual(closed, [true]);
    assert.deepEqual(calls.map((c) => c.cap), ['decide', 'decide_close']);
    // the first run carries the person's prompt as the system message
    const first = (calls[0]!.input as { messages: Message[] }).messages;
    assert.deepEqual(first.map((m) => m.role), ['system', 'user']);
    // the closing input: the conversation, results of both cut-off calls (one ran, one never did), then the notice
    const second = (calls[1]!.input as { messages: Message[] }).messages;
    assert.deepEqual(second.map((m) => m.role), ['system', 'assistant', 'tool', 'user']);
    const results = second[2]!.parts as Array<{ callId: string; ok: boolean; text: string }>;
    assert.deepEqual(results.map((r) => [r.callId, r.ok]), [['c1', !!said], ['c2', false]]);
    assert.equal(results[0]!.text, said);
    // same tools in both runs
    assert.deepEqual(calls[1]!.opts.tools!.map((t) => t.name), calls[0]!.opts.tools!.map((t) => t.name));
    assert.ok(calls[0]!.opts.tools![0]!.name === 'commit_plan');
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

test('no closing turn when a plan was committed, when the run was aborted, or on a failed stack', async () => {
  const { g, host, hub, spawn } = world();
  try {
    const calls = scripted(host, async (call) => ({ result: { run: run('r', 'completed'), plan: { summary: 's', steps: [{ action: 'wait' }] }, ...(call.cap ? {} : {}) } }));
    const ok = await decide(host, spawn('Mara Bianca'), 'x');
    assert.ok(!isFailure(ok));
    assert.deepEqual(calls.map((c) => c.cap), ['decide']);

    const cut = scripted(host, async () => ({ result: { run: { runId: 'r', status: 'stopped', output: '', reason: { code: 'timeout' } } as CapResult['run'], transcript: [text('x')] } }));
    const timeout = await decide(host, spawn('Luca Rossi'), 'x');
    assert.ok(isFailure(timeout) && timeout.error === 'stopped: timeout');
    assert.equal(cut.length, 1);

    host.stacks = { feed: new StackFeed(), stackFor: async () => { throw new Error('no config'); } } as unknown as StackHub;
    const broken = await decide(host, spawn('Gina Verdi'), 'x');
    assert.ok(isFailure(broken) && /no config/.test(broken.error));
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

test('reply: words are one answer across consultations, a cut-off or silent run is told apart, rethink says nothing after', async () => {
  const { g, host, hub, spawn } = world();
  try {
    const a = spawn('Mara Bianca');
    const b = spawn('Luca Rossi');
    scripted(host, async () => ({
      events: [
        { type: 'text', text: 'Un attimo' }, { type: 'model.reply', turn: 1, model: 'm', finish: 'tools', calls: 1 },
        { type: 'tool.call', id: 'c', tool: 'lorebase__lorebase_search' }, { type: 'tool.result', id: 'c', tool: 'lorebase__lorebase_search', ok: true },
        { type: 'text', text: 'ecco' }, { type: 'text', text: ' fatto' }, { type: 'model.reply', turn: 2, model: 'm', finish: 'end', calls: 0 },
      ],
      result: { run: run('r', 'completed') },
    }));
    const deltas: string[] = [];
    const out = await reply(host, a, b, (d) => deltas.push(d));
    assert.equal(out.text, 'Un attimo ecco fatto');
    assert.deepEqual(deltas, ['Un attimo', ' ', 'ecco', ' fatto']);

    scripted(host, async () => ({ events: [{ type: 'text', text: 'Pronto' }], result: { run: { ...run('r', 'completed'), reason: { code: 'limit', detail: 'max_tokens' } } } }));
    const cut = await reply(host, a, b, () => undefined);
    assert.equal(cut.text, 'Pronto');
    assert.equal(cut.error, 'completed: max_tokens');

    scripted(host, async () => ({
      events: [{ type: 'text', text: 'Hmm' }, { type: 'tool.call', id: 'c', tool: 'world__rethink' }, { type: 'text', text: 'ignorato' }],
      result: { run: run('r', 'completed'), rethink: true },
    }));
    const think = await reply(host, a, b, () => undefined);
    assert.equal(think.text, 'Hmm');
    assert.equal(think.rethink, true);

    scripted(host, async () => ({ result: { run: run('r', 'completed') } }));
    const silent = await reply(host, a, b, () => undefined);
    assert.deepEqual([silent.text, silent.error], ['', undefined]);
  } finally {
    g.stopLoop();
    await hub.close();
  }
});

test('closableRun: only a run that ended on its own or on its turn or tool-call budget', () => {
  assert.equal(closableRun({ status: 'completed' }), true);
  assert.equal(closableRun({ status: 'stopped', reason: { code: 'limit', detail: 'maxTurns' } }), true);
  assert.equal(closableRun({ status: 'stopped', reason: { code: 'limit', detail: 'maxToolCalls' } }), true);
  assert.equal(closableRun({ status: 'stopped', reason: { code: 'limit', detail: 'max_tokens' } }), false);
  assert.equal(closableRun({ status: 'stopped', reason: { code: 'timeout' } }), false);
  assert.equal(closableRun({ status: 'failed', reason: { code: 'error' } }), false);
});

test('closingMessages: results for the calls of a trailing assistant reply, none for a plain answer', () => {
  const answer: Message[] = [text('q'), { role: 'assistant', parts: [{ type: 'text', text: 'a' }] }];
  assert.deepEqual(closingMessages(answer, [], 'chiudi', 'no').map((m) => m.role), ['user', 'assistant', 'user']);
  const cut: Message[] = [{ role: 'assistant', parts: [{ type: 'call', id: 'x', tool: 'lorebase__lorebase_search', args: {} }] }];
  const out = closingMessages(cut, [{ name: 'lorebase_search', content: 'regola', isError: false }], 'chiudi', 'no');
  assert.deepEqual(out.at(-2)!.parts, [{ type: 'result', callId: 'x', ok: true, text: 'regola' }]);
  assert.deepEqual(out.at(-1)!.parts, [{ type: 'text', text: 'chiudi' }]);
});
