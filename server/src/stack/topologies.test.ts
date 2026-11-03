import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBasicTopology } from '@agent-plexus/adapters/basic-topology';
import { resolveConfig } from '@agent-plexus/core';
import { ROOT } from '../config.ts';
import { memberId, parseMemberId, topologyFor, type Roster, type SystemKind } from './topologies.ts';

const base = JSON.parse(readFileSync(join(ROOT, 'config/plexus/base.json'), 'utf8')) as Record<string, unknown>;
const roster: Roster = {
  group: 'g1', lead: 'a1', workers: ['a2', 'a3'], proposers: ['a2', 'a3'], elder: 'a2', candidates: ['a1', 'a2'], before: ['a2', 'a3'],
  apprentice: 'a3', mentor: 'a2', voting: ['a1', 'a2', 'a3'], maxRounds: 3,
};
const KINDS: Exclude<SystemKind, 'committee'>[] = ['orchestrator', 'council', 'router', 'chain', 'mentor', 'assembly'];

test('member ids are person-capacity and read back', () => {
  assert.equal(memberId('a1', 'write_member'), 'a1-write_member');
  assert.deepEqual(parseMemberId('p-x-write_member'), { person: 'p-x', capacity: 'write_member' });
});

test('every pattern gives a topology the executor accepts, over members it declares', () => {
  for (const kind of KINDS) {
    const def = topologyFor(kind, roster);
    // all member ids named by the topology are declared
    const named = new Set<string>();
    const walk = (n: unknown): void => {
      if (typeof n === 'string') return void named.add(n);
      const o = n as Record<string, unknown>;
      for (const k of ['steps', 'branches', 'members']) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach(walk);
      for (const k of ['body', 'merge']) if (o[k] !== undefined) walk(o[k]);
      for (const k of ['start', 'supervisor']) if (typeof o[k] === 'string' && o.kind !== 'graph') named.add(o[k] as string);
      if (o.kind === 'graph') Object.values(o.nodes as Record<string, unknown>).forEach(walk);
    };
    walk(def.topology);
    for (const id of named) assert.ok(id in def.members, `${kind}: ${id} is declared`);
    createBasicTopology().bind(def.topology);
    const cfg = resolveConfig({ ...base, system: { name: `t-${kind}` }, members: def.members, topology: def.topology }, { cwd: ROOT });
    assert.equal(Object.keys(cfg.members).length, Object.keys(def.members).length);
  }
});

test('orchestrator: the supervisor delegates to the workers, one hand-over per worker at most', () => {
  const def = topologyFor('orchestrator', roster);
  assert.deepEqual(def.topology, { kind: 'supervise', supervisor: 'a1-lead', members: ['a2-propose', 'a3-propose'] });
  assert.equal(def.limits?.maxHandoffs, 2);
  const alone = topologyFor('orchestrator', { ...roster, workers: [] });
  assert.deepEqual(alone.topology, { kind: 'supervise', supervisor: 'a1-lead', members: ['a1-lead'] });
  assert.equal(alone.limits?.maxHandoffs, 1);
});

test('council: proposals merged by the elder, judged by the elder, until pass, within the rounds', () => {
  const { topology, members } = topologyFor('council', roster);
  assert.deepEqual(topology, {
    kind: 'loop',
    body: { kind: 'sequence', steps: [{ kind: 'parallel', branches: ['a2-propose', 'a3-propose'], merge: 'a2-write' }, 'a2-judge'] },
    until: { ext: { 'hub.verdict': 'pass' } },
    maxIterations: 3,
  });
  assert.equal((members['a2-write']!.options as { keep?: boolean }).keep, true);
  assert.equal((topologyFor('council', { ...roster, maxRounds: 0 }).topology as { maxIterations: number }).maxIterations, 1);
});

test('router: the lead routes, one hand-over to a candidate', () => {
  assert.deepEqual(topologyFor('router', roster).topology, { kind: 'handoff', start: 'a1-route', members: ['a1-write_member', 'a2-write_member'], maxHandoffs: 1 });
});

test('chain: scout and planners propose, the doer writes; a group of one is just the doer', () => {
  const { topology, members } = topologyFor('chain', roster);
  assert.deepEqual(topology, { kind: 'sequence', steps: ['a2-propose', 'a3-propose', 'a1-write'] });
  assert.equal((members['a2-propose']!.options as { brief: string }).brief, 'scout');
  assert.equal((members['a3-propose']!.options as { brief: string }).brief, 'planner');
  assert.deepEqual(topologyFor('chain', { ...roster, before: [] }).topology, { kind: 'sequence', steps: ['a1-write'] });
});

test('mentor: the apprentice writes on the member tier unless they are the mentor', () => {
  assert.deepEqual((topologyFor('mentor', roster).topology as { body: unknown }).body, { kind: 'sequence', steps: ['a3-write_member', 'a2-judge'] });
  assert.deepEqual((topologyFor('mentor', { ...roster, apprentice: 'a2' }).topology as { body: unknown }).body, { kind: 'sequence', steps: ['a2-write', 'a2-judge'] });
});

test('assembly: proposals into the ballot box, a poll only when it says so, the tally decides', () => {
  const { topology, members } = topologyFor('assembly', roster);
  assert.deepEqual(topology, {
    kind: 'graph', start: 'proposals',
    nodes: {
      proposals: { kind: 'parallel', branches: ['a1-write_member', 'a2-write_member', 'a3-write_member'], merge: 'ballot-box' },
      ballots: { kind: 'parallel', branches: ['a1-vote', 'a2-vote', 'a3-vote'], merge: 'tally' },
    },
    edges: [{ from: 'proposals', to: 'ballots', when: { ext: { 'hub.vote': 'yes' } } }],
    end: ['proposals', 'ballots'],
  });
  assert.deepEqual(members['tally'], { adapter: 'hub-fn', options: { fn: 'tally' } });
});

test('a pattern without its people, and the committee (built with its review), are refused', () => {
  assert.throws(() => topologyFor('council', { group: 'g', maxRounds: 1 }), /elder/);
  assert.throws(() => topologyFor('assembly', { group: 'g', maxRounds: 1, voting: [] }), /voters/);
  assert.throws(() => topologyFor('committee', roster), /committee/);
});
