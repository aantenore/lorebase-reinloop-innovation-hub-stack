import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../config.ts';
import { loadGameConfig } from '../rt/config.ts';
import { type DecideHost, personCatalog } from '../rt/decide.ts';
import { Game } from '../rt/game.ts';
import { GroupManager, type GroupEvents, type JointPlan } from '../rt/groups.ts';
import { isFailure } from '../rt/decide.ts';
import type { GroupPattern } from '../rt/config.ts';
import type { RtEntity } from '../rt/world.ts';
import { StackFeed, StackHub } from './index.ts';
import { blocksOf } from './members.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'hub-groups-'));
const sim = loadConfig(['--mock'], {});
const game = new Game(sim, { ...loadGameConfig({}), mock: { ...loadGameConfig({}).mock, thinkDelayMs: 0 } });
game.world.rules = new Proxy({}, { get: () => 1 }) as typeof game.world.rules;
const host = (game as unknown as { decideHost(): DecideHost }).decideHost();
const feed = new StackFeed();
const hub = new StackHub(host, { mock: true, feed, dataDir, catalog: (e) => personCatalog(host, e) });
host.stacks = hub;
const noop: GroupEvents = { changed: () => undefined, removed: () => undefined, joined: () => undefined, left: () => undefined, formed: () => undefined };
const deliberations: string[] = [];
const manager = new GroupManager({ ...host, deliberated: (_g, member, role, text) => void deliberations.push(`${member}:${role}:${text}`) }, noop);

after(async () => {
  await hub.close();
  game.stopLoop();
  rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
const people = (count: number): RtEntity[] => Array.from({ length: count }, (_, k) => {
  const tier = (['opus', 'sonnet', 'haiku', 'sonnet'] as const)[k % 4]!;
  const e = game.world.spawn({ name: `Tester ${++n}`, role: k === 1 ? 'elder' : 'crafter', tier, model: sim.models[tier], kind: 'agent' });
  e.stage = k === 1 ? 'elder' : e.stage;
  return e;
});

const group = (pattern: GroupPattern, count = 4) => {
  const members = people(count);
  const g = manager.create(`G${++n}`, pattern, members, members[0]!);
  assert.ok(typeof g !== 'string', String(g));
  return g as Exclude<typeof g, string>;
};

const valid = (r: JointPlan | { error: string }): JointPlan => {
  assert.ok(!isFailure(r), isFailure(r) ? r.error : '');
  const plan = r as JointPlan;
  assert.ok(plan.summary.length > 0);
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps.every((s) => typeof s.args.who === 'string'), 'every step has an owner');
  assert.ok(plan.trace.length > 0, 'the trace says who said what');
  return plan;
};

for (const pattern of ['orchestrator', 'council', 'router', 'chain', 'mentor', 'assembly', 'crowd'] as const) {
  test(`${pattern}: the offline hub returns a valid joint plan with a trace`, async () => {
    const g = group(pattern);
    const plan = valid(await manager.decide(g, 'test'));
    const ids = new Set(g.members);
    assert.ok(plan.steps.every((s) => ids.has(String(s.args.who))));
    assert.ok(plan.trace.every((t) => ids.has(t.member) || t.member === g.id));
  });
}

test('the system of a group is kept while its membership stays and rebuilt when it changes', async () => {
  const g = group('council');
  valid(await manager.decide(g, 'a'));
  const members = g.members.map((id) => game.world.entities.get(id)!);
  const roster = { group: g.id, elder: members[1]!.id, proposers: [members[0]!.id], maxRounds: 2 };
  const first = await hub.systemFor(g, members, 'council', roster);
  assert.equal(await hub.systemFor(g, members, 'council', roster), first);
  assert.notEqual(await hub.systemFor(g, members, 'council', { ...roster, proposers: [members[0]!.id, members[2]!.id] }), first);
});

test('a failing member does not fail the parallel node it sits in', async () => {
  for (const pattern of ['council', 'assembly'] as const) {
    const g = group(pattern);
    const victim = game.world.entities.get(g.members[2]!)!;
    const real = hub.stackFor.bind(hub);
    hub.stackFor = (e) => (e.id === victim.id ? Promise.reject(new Error('stack down')) : real(e));
    try {
      valid(await manager.decide(g, 'test'));
    } finally {
      hub.stackFor = real;
    }
  }
});

test('assembly voters record their choice with vota_proposta; a free-text JSON answer still counts', async () => {
  const g = group('assembly');
  const real = hub.stackFor.bind(hub);
  const recorded: unknown[] = [];
  let text = false;
  hub.stackFor = async (e) => {
    const ps = await real(e);
    return new Proxy(ps, {
      get: (t, k) => (k === 'run' ? async (...a: Parameters<typeof ps.run>) => {
        const res = await ps.run(...a);
        if (a[0] === 'vote') {
          recorded.push(res.record);
          // the first voter answers in prose instead of the tool
          if (!text) {
            text = true;
            return { run: { ...res.run, output: '{"choice": 1, "reason": "testo"}' } };
          }
        }
        return res;
      } : Reflect.get(t, k)),
    });
  };
  try {
    valid(await manager.decide(g, 'test'));
  } finally {
    hub.stackFor = real;
  }
  assert.ok(recorded.length >= 2);
  assert.ok(recorded.every((r) => r && typeof (r as { choice: unknown }).choice === 'number'), 'the offline voters call the record tool');
  const votes = deliberations.filter((d) => d.includes(':voter:#'));
  assert.ok(votes.length >= 2, votes.join(' | '));
  assert.ok(votes.some((v) => v.endsWith('#1: testo')), 'the free-text vote is counted too');
});

test('a judge that fails the first round sends the council back for a revision; the last plan stands when rounds run out', async () => {
  const g = group('council');
  const plan = valid(await manager.decide(g, 'test'));
  assert.ok(plan.steps.length > 0);
  // the offline judge asks for a revision first, then passes
  const mine = deliberations.filter((d) => d.includes(':critic:'));
  const last = mine.slice(-2);
  assert.ok(last[0]!.includes('✗') && last[1]!.includes('✓'), last.join(' | '));
});

test('blocksOf splits the joined outputs of a parallel node by label, empty outputs included', () => {
  const text = '[a]\n\n\n[b]\nline 1\n\nline 2\n\n[c]\n{"x":1}';
  assert.deepEqual(blocksOf(text, ['a', 'b', 'c']), ['', 'line 1\n\nline 2', '{"x":1}']);
});
