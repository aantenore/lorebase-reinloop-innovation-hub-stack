import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Tool } from 'reinloop';
import { loadConfig } from '../config.ts';
import { loadGameConfig } from '../rt/config.ts';
import type { DecideHost } from '../rt/decide.ts';
import type { RtEntity } from '../rt/world.ts';
import { loadPersonConfig } from './configs.ts';
import { StackFeed, StackHub, type Capacity, type ReasoningEvent, type UsageEvent } from './index.ts';

const cfg = loadGameConfig({});
const sim = loadConfig([], {});
const dataDir = mkdtempSync(join(tmpdir(), 'hub-stack-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));

const CAPACITIES: Capacity[] = ['decide', 'reply', 'propose', 'write', 'write_member', 'vote', 'ballot', 'chair', 'judge', 'route', 'lead'];
const host = { cfg, sim } as unknown as DecideHost;
const person = (id: string, tier: 'opus' | 'sonnet' | 'haiku'): RtEntity => ({ id, name: `P-${id}`, tier, model: sim.models[tier], kind: 'agent' }) as unknown as RtEntity;

/** Tools of a run: commit_plan ends the run and carries the plan, say is an ordinary tool. */
function runTools(log: string[]): Tool[] {
  return [
    {
      name: 'commit_plan', description: 'commit', schema: { type: 'object', properties: { reason: { type: 'string' }, steps: { type: 'array' } }, required: ['reason', 'steps'] },
      run: (args: { reason: string; steps: unknown[] }) => {
        log.push('commit');
        return { content: 'planned', stop: true, data: { summary: args.reason, steps: args.steps } };
      },
    },
    { name: 'say', description: 'say', schema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } }, run: (args: { text: string }) => { log.push(`say:${args.text}`); return 'said'; } },
  ];
}

const hubOf = (feed = new StackFeed(), mock = true) => new StackHub(host, { mock, feed, dataDir, catalog: () => runTools([]) });

test('stackFor composes the three tiers on the offline model, one agent per capacity, budgets and params from the game config', async () => {
  const hub = hubOf();
  try {
    for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
      const ps = await hub.stackFor(person(`p-${tier}`, tier));
      assert.deepEqual(ps.stack.agents().sort(), [...CAPACITIES].sort());
      assert.equal(ps.stack.config.layers.model?.adapter, 'hub-mock');
      assert.equal(ps.stack.config.profile, tier);
      const tc = cfg.decisions.tiers[tier];
      const decide = ps.stack.config.agents.decide!;
      assert.deepEqual(decide.ext?.['reinloop.budget'], { maxTurns: tc.maxTurns, maxToolCalls: tc.maxConsults + tc.maxTurns * 4 });
      assert.deepEqual(decide.settings, { maxOutputTokens: tc.maxOutputTokens });
      const params = decide.ext?.['anthropic.params'] as Record<string, unknown>;
      assert.deepEqual(params.thinking, cfg.decisions.modelParams.plan.thinking);
      assert.equal(params.cache, cfg.promptCache.enabled);
      assert.equal('temperature' in (decide.settings ?? {}), false);
      assert.equal(ps.stack.config.agents.reply!.ext?.['reinloop.retryMaxTokens'], cfg.decisions.modelParams.reply.retryMaxTokens);
      // members who only propose or vote run on the member tier model
      assert.equal(ps.stack.config.agents.propose!.model, sim.modelOverride ?? sim.models[cfg.groups.memberTier!]);
      assert.equal(ps.stack.config.agents.write!.model, 'default');
    }
  } finally {
    await hub.close();
  }
});

test('stackFor keeps one stack per person and tier; a failed build is not cached', async () => {
  const hub = hubOf();
  try {
    const a = person('p1', 'sonnet');
    assert.equal(await hub.stackFor(a), await hub.stackFor(a));
    assert.notEqual(await hub.stackFor(a), await hub.stackFor(person('p2', 'sonnet')));
    const bad = new StackHub(host, { mock: true, feed: new StackFeed(), dataDir, configFile: join(dataDir, 'missing.json') });
    await assert.rejects(bad.stackFor(a));
    await assert.rejects(bad.stackFor(a));
  } finally {
    await hub.close();
  }
});

test('a mock decide run commits a plan through the scratch; the tap reports usage and reasoning; the transcript is kept for a closing turn', async () => {
  const feed = new StackFeed();
  const usages: UsageEvent[] = [];
  const reasons: ReasoningEvent[] = [];
  const spans: string[] = [];
  feed.on('usage', (u) => usages.push(u));
  feed.on('reasoning', (r) => reasons.push(r));
  feed.on('telemetry', (t) => spans.push(t.record.name));
  const hub = hubOf(feed);
  try {
    const ps = await hub.stackFor(person('p1', 'sonnet'));
    const log: string[] = [];
    const out = await ps.run('decide', 'what now?', {
      sessionId: 'p1:d1', tools: runTools(log),
      mock: (req, i) => {
        // the model sees plain tool names
        assert.ok(req.tools.some((t) => t.name === 'commit_plan'));
        if (req.messages.some((m) => m.role === 'tool')) return { text: 'done' };
        return i === 0 ? {
          parts: [{ type: 'thinking', text: 'devo costruire' }],
          toolCalls: [{ name: 'say', args: { to: 'all', text: 'ciao' } }, { name: 'commit_plan', args: { reason: 'build', steps: [{ action: 'wait', label: 'w' }] } }],
        } : { text: 'again' };
      },
    });
    assert.equal(out.run.status, 'completed');
    assert.deepEqual(log, ['say:ciao', 'commit']);
    assert.deepEqual(out.plan, { summary: 'build', steps: [{ action: 'wait', label: 'w' }] });
    assert.equal(usages.length, 2);
    assert.equal(usages[0]!.agent, 'decide');
    assert.equal(usages[0]!.person.tier, 'sonnet');
    assert.ok(usages[0]!.usage.inputTokens > 0);
    assert.deepEqual(reasons.map((r) => r.text), ['devo costruire']);
    assert.equal(reasons[0]!.runId, out.run.runId);
    // closing turn input: the conversation with the stack's own tool names
    const calls = out.transcript!.flatMap((m) => m.parts).filter((p) => p.type === 'call').map((p) => (p as { tool: string }).tool);
    assert.deepEqual(calls, ['world__say', 'world__commit_plan']);
    assert.ok(spans.includes('agent.run'), spans.join(','));
    // the scratch is closed after the run
    assert.equal(ps.scratch.get('p1:d1', 'decide'), undefined);
  } finally {
    await hub.close();
  }
});

test('stream: events come while the run goes on, the result carries the plan; a run without a script echoes', async () => {
  const hub = hubOf();
  try {
    const ps = await hub.stackFor(person('p2', 'haiku'));
    const s = ps.stream('decide', 'go', {
      sessionId: 'p2:d1', runId: 'p2:decide:fixed', tools: runTools([]),
      mock: (req) => (req.messages.some((m) => m.role === 'tool') ? { text: 'ok' } : { toolCalls: [{ name: 'commit_plan', args: { reason: 'r', steps: [] } }] }),
    });
    const types: string[] = [];
    for await (const ev of s) types.push(ev.type);
    assert.ok(types.includes('tool.call') && types.at(-1) === 'run.end', types.join(','));
    const res = await s.result;
    assert.equal(res.run.runId, 'p2:decide:fixed');
    assert.equal(res.run.output, 'ok');
    assert.equal(res.plan?.summary, 'r');

    const echo = await ps.run('reply', 'ciao Mara', { sessionId: 'p2:r1', tools: [] });
    assert.equal(echo.run.output, 'ciao Mara');

    await assert.rejects(ps.run('decide', 'x', { sessionId: 's', runId: 'x'.repeat(129) }), /128/);
  } finally {
    await hub.close();
  }
});

test('stream consumed through the result only, and a failing model rejects it', async () => {
  const hub = hubOf();
  try {
    const ps = await hub.stackFor(person('p3', 'opus'));
    const ok = await ps.stream('reply', 'hi', { sessionId: 'p3:r1', tools: [], mock: () => ({ text: 'ciao' }) }).result;
    assert.equal(ok.run.output, 'ciao');
    const bad = await ps.run('reply', 'hi', { sessionId: 'p3:r2', tools: [], mock: () => ({ error: { status: 500, message: 'down' } }) });
    assert.notEqual(bad.run.status, 'completed');
  } finally {
    await hub.close();
  }
});

test('runs of one person and capacity in one session go one after the other', async () => {
  const hub = hubOf();
  try {
    const ps = await hub.stackFor(person('p4', 'sonnet'));
    const order: string[] = [];
    const slow = (label: string, ms: number) => ps.run('reply', label, {
      sessionId: 's', tools: [], mock: () => { order.push(`${label}:model`); return { delayMs: ms, text: label }; },
    });
    const [a, b] = await Promise.all([slow('a', 30), slow('b', 1)]);
    assert.deepEqual(order, ['a:model', 'b:model']);
    assert.deepEqual([a.run.output, b.run.output], ['a', 'b']);
  } finally {
    await hub.close();
  }
});

test('telemetry of the stacks goes to the data directory', async () => {
  const hub = hubOf();
  try {
    const ps = await hub.stackFor(person('p5', 'sonnet'));
    await ps.run('reply', 'hi', { sessionId: 's5', tools: [], mock: () => ({ text: 'x' }) });
  } finally {
    await hub.close();
  }
  const lines = readFileSync(join(dataDir, 'telemetry', 'stack.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string });
  assert.ok(lines.some((l) => l.name === 'agent.run'));
});

test('loadPersonConfig: profile model, own model, offline model, agent overlay as a function or a map', async () => {
  const live = await loadPersonConfig('haiku', false, { dataDir });
  assert.deepEqual(live.layers.model, { adapter: 'hub-anthropic', options: { model: 'anthropic/claude-haiku-5-5' } });
  const own = await loadPersonConfig('opus', false, { dataDir, model: 'anthropic/claude-x', agents: { reply: { settings: { maxOutputTokens: 7 } } } });
  assert.equal((own.layers.model as { options: { model: string } }).options.model, 'anthropic/claude-x');
  assert.equal(own.agents.reply!.settings?.maxOutputTokens, 7);
  assert.equal(own.agents.reply!.model, 'default');
  const mock = await loadPersonConfig('sonnet', true, { dataDir, model: 'anthropic/claude-x', agents: (a) => ({ decide: { instructions: `${Object.keys(a).length} agents` } }) });
  assert.deepEqual(mock.layers.model, { adapter: 'hub-mock', options: { model: 'mock/anthropic/claude-x' } });
  assert.equal(mock.agents.decide!.instructions, '11 agents');
  await assert.rejects(loadPersonConfig('gold' as never, false, { dataDir }), /gold/);
});
