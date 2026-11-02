import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../config.ts';
import { loadGameConfig } from '../rt/config.ts';
import { type DecideHost, isFailure, personCatalog } from '../rt/decide.ts';
import { Game } from '../rt/game.ts';
import { type CommitteeMock, type CommitteeReview, type Group, GroupManager, type GroupEvents } from '../rt/groups.ts';
import type { CommitteeDecision } from '../rt/ideas.ts';
import type { RtEntity } from '../rt/world.ts';
import { createBasicTopology } from '@agent-plexus/adapters/basic-topology';
import { StackFeed, StackHub } from './index.ts';
import { topologyFor } from './topologies.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'hub-committee-'));
const sim = loadConfig(['--mock'], {});
const game = new Game(sim, { ...loadGameConfig({}), mock: { ...loadGameConfig({}).mock, thinkDelayMs: 0 } });
game.world.rules = new Proxy({}, { get: () => 1 }) as typeof game.world.rules;
const host = (game as unknown as { decideHost(): DecideHost }).decideHost();
const noop: GroupEvents = { changed: () => undefined, removed: () => undefined, joined: () => undefined, left: () => undefined, formed: () => undefined };
const deliberations: string[] = [];
const deliberated = (_g: Group, member: string, role: string, text: string) => void deliberations.push(`${member}:${role}:${text}`);

const hubs: StackHub[] = [];
/** A hub over the shared journal (a new one is a restart of the process) and a group manager on it. */
function boot() {
  const hub = new StackHub(host, { mock: true, feed: new StackFeed(), dataDir, catalog: (e) => personCatalog(host, e) });
  hubs.push(hub);
  const h = { ...host, stacks: hub, deliberated } as DecideHost;
  return { hub, manager: new GroupManager(h, noop) };
}

after(async () => {
  await Promise.all(hubs.map((h) => h.close()));
  game.stopLoop();
  rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
const people = (count: number): RtEntity[] => Array.from({ length: count }, (_, k) => {
  const tier = (['opus', 'sonnet', 'haiku'] as const)[k % 3]!;
  return game.world.spawn({ name: `Seat ${++n}`, role: 'crafter', tier, model: sim.models[tier], kind: 'agent' });
});

const committee = (manager: GroupManager, pattern: 'council' | 'assembly' = 'council', count = 3) => {
  const members = people(count);
  const g = manager.create(`Comitato ${++n}`, pattern, members, members[0]!, { jointPlans: false, committee: true });
  assert.ok(typeof g !== 'string', String(g));
  return { g: g as Group, members };
};

/** A committee that follows `script`: the decision of each pass over the ballots (the chair's too), counting the model calls. */
function scripted(script: CommitteeDecision[]) {
  const calls = { votes: 0, chair: 0 };
  const at = (k: number) => script[Math.min(k, script.length - 1)]!;
  let pass = 0;
  const mock: CommitteeMock & { next(): void } = {
    next: () => void pass++,
    vote: () => (calls.votes++, { vote: at(pass), reason: `vote ${at(pass)}` }),
    chair: () => (calls.chair++, { decision: at(pass), summary: `chair ${at(pass)}` }),
  };
  return { mock, calls };
}

const ok = (r: CommitteeReview | { error: string }): CommitteeReview => {
  assert.ok(!isFailure(r), isFailure(r) ? r.error : '');
  return r as CommitteeReview;
};

const criteria = [{ code: 'criterio_comitato_prove', key: 'prove', text: 'Evidence of the problem' }];

test('a deferral ends the run waiting; the resubmission goes on with it and the committee approves', async () => {
  const { manager } = boot();
  const { g, members } = committee(manager);
  const { mock, calls } = scripted(['defer', 'approve']);

  const first = ok(await manager.reviewIdea(g, 'brief v1', mock, members, undefined, { idea: 'idea-1' }));
  assert.equal(first.decision, 'defer');
  assert.equal(first.waiting, true);
  assert.ok(first.runId && first.configHash && first.wait);
  assert.equal(first.votes.length, 3);
  assert.deepEqual([calls.votes, calls.chair], [3, 1]);

  mock.next();
  const second = ok(await manager.resumeReview(g, first, 'brief v2', mock, members, undefined, 'idea-1'));
  assert.equal(second.decision, 'approve');
  assert.equal(second.waiting, false);
  assert.equal(second.runId, first.runId, 'the same run went on');
  assert.equal(second.configHash, first.configHash);
  // The ballots of the first pass replayed from the journal: only the new pass called the models.
  assert.deepEqual([calls.votes, calls.chair], [6, 2]);
});

test('the run survives a restart: a new hub on the same journal resumes it', async () => {
  const a = boot();
  const { g, members } = committee(a.manager);
  const { mock, calls } = scripted(['defer', 'approve']);
  const first = ok(await a.manager.reviewIdea(g, 'brief v1', mock, members, undefined, { idea: 'idea-2' }));
  assert.equal(first.waiting, true);
  await a.hub.close();

  const b = boot();
  mock.next();
  const second = ok(await b.manager.resumeReview(g, first, 'brief v2', mock, members, undefined, 'idea-2'));
  assert.equal(second.runId, first.runId);
  assert.equal(second.decision, 'approve');
  assert.deepEqual([calls.votes, calls.chair], [6, 2]);
});

test('an assembly decides by the weighted plurality of the ballots, with no chair; a deferral waits as well', async () => {
  const { manager } = boot();
  const { g, members } = committee(manager, 'assembly', 3);
  const { mock, calls } = scripted(['defer', 'kill']);
  const first = ok(await manager.reviewIdea(g, 'brief', mock, members, undefined, { idea: 'idea-3' }));
  assert.deepEqual([first.decision, first.waiting, calls.chair], ['defer', true, 0]);
  mock.next();
  const second = ok(await manager.resumeReview(g, first, 'brief', mock, members, undefined, 'idea-3'));
  assert.deepEqual([second.decision, second.waiting, second.runId], ['kill', false, first.runId]);
  assert.ok(second.summary.includes('vote kill'));
});

test('another membership cannot replay the old run: a new run starts', async () => {
  const { manager } = boot();
  const { g, members } = committee(manager);
  const { mock, calls } = scripted(['defer', 'approve']);
  const first = ok(await manager.reviewIdea(g, 'brief', mock, members, undefined, { idea: 'idea-4' }));
  assert.equal(first.waiting, true);

  // The chair recused: another one chairs, the topology (and its hash) change.
  const reseated = [members[1]!, members[0]!, members[2]!];
  mock.next();
  const second = ok(await manager.resumeReview(g, first, 'brief', mock, reseated, undefined, 'idea-4'));
  assert.notEqual(second.configHash, first.configHash);
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.decision, 'approve');
  // Everything was voted anew.
  assert.deepEqual([calls.votes, calls.chair], [6, 2]);
});

test('a run the idea lets go (another config, a lost run) is cancelled first when plexus can; without cancel the new run just starts', async () => {
  const { hub, manager } = boot();
  const { g, members } = committee(manager);
  const { mock } = scripted(['defer', 'approve']);
  const first = ok(await manager.reviewIdea(g, 'brief', mock, members, undefined, { idea: 'idea-8' }));
  assert.equal(first.waiting, true);

  const cancelled: Array<{ id: string; by: string; reason: string }> = [];
  const real = hub.systemFor.bind(hub);
  hub.systemFor = async (...a) => {
    const system = await real(...a);
    return { ...system, cancel: async (id: string, o: { by: string; reason: string }) => void cancelled.push({ id, ...o }) } as typeof system;
  };
  try {
    mock.next();
    const reseated = [members[1]!, members[0]!, members[2]!];
    const second = ok(await manager.resumeReview(g, first, 'brief', mock, reseated, undefined, 'idea-8'));
    assert.notEqual(second.runId, first.runId);
    assert.deepEqual(cancelled.map((c) => [c.id, c.reason]), [[first.runId, 'config changed']]);

    cancelled.length = 0;
    const lost = ok(await manager.resumeReview(g, { ...second, runId: 'gone' }, 'brief', mock, reseated, undefined, 'idea-8'));
    assert.notEqual(lost.runId, 'gone');
    assert.deepEqual(cancelled.map((c) => [c.id, c.reason]), [['gone', 'run lost']]);

    // A cancel that throws never stops the new run.
    hub.systemFor = async (...a) => ({ ...(await real(...a)), cancel: async () => { throw new Error('refused'); } }) as never;
    const again = ok(await manager.resumeReview(g, { ...lost, configHash: 'other' }, 'brief', mock, reseated, undefined, 'idea-8'));
    assert.ok(again.runId);
  } finally {
    hub.systemFor = real;
  }
});

test('a run that used up its deferrals starts anew', async () => {
  const cc = host.cfg.ideas.committee;
  const keep = cc.maxDeferrals;
  cc.maxDeferrals = 1;
  try {
    const { manager } = boot();
    const { g, members } = committee(manager);
    const { mock } = scripted(['defer']);
    const first = ok(await manager.reviewIdea(g, 'brief', mock, members, undefined, { idea: 'idea-5' }));
    assert.equal(first.waiting, true);
    const second = ok(await manager.resumeReview(g, first, 'brief', mock, members, undefined, 'idea-5'));
    assert.equal(second.waiting, true);
    assert.equal(second.runId, first.runId, 'the one allowed deferral goes on with the run');
    const third = ok(await manager.resumeReview(g, second, 'brief', mock, members, undefined, 'idea-5'));
    assert.equal(third.waiting, true);
    assert.notEqual(third.runId, first.runId, 'past the cap the idea gets a new run');
  } finally {
    cc.maxDeferrals = keep;
  }
});

test('seats outside the voters abstain without a model call', async () => {
  const cc = host.cfg.ideas.committee;
  const keep = cc.maxVoters;
  cc.maxVoters = 1;
  try {
    const { manager } = boot();
    const { g, members } = committee(manager);
    const { mock, calls } = scripted(['approve']);
    const out = ok(await manager.reviewIdea(g, 'brief', mock, members, undefined, { idea: 'idea-6' }));
    assert.equal(calls.votes, 1);
    assert.equal(out.votes.length, 1);
    assert.equal(out.decision, 'approve');
  } finally {
    cc.maxVoters = keep;
  }
});

test('with policy criteria the ballots are record tools checked against them; a deferral names an unmet criterion', async () => {
  const { manager } = boot();
  const { g, members } = committee(manager);
  const { mock } = scripted(['defer', 'approve']);
  const policy = { criteria };
  const first = ok(await manager.reviewIdea(g, 'brief', mock, members, policy, { idea: 'idea-7' }));
  assert.equal(first.decision, 'defer');
  assert.ok(first.votes.every((v) => v.criteria?.prove && v.unmet?.includes('prove')));
  assert.deepEqual(first.unmet, ['prove']);
  mock.next();
  const second = ok(await manager.resumeReview(g, first, 'brief', mock, members, policy, 'idea-7'));
  assert.equal(second.decision, 'approve');
  assert.deepEqual(second.unmet, []);
});

test('committee topology: ballots tallied, the chair or the revision after, deferrals capped by the rounds', () => {
  const def = topologyFor('committee', { group: 'g1', seats: ['a1', 'a2', 'a3'], chair: 'a2', maxRounds: 4 });
  assert.deepEqual(Object.keys(def.members).sort(), ['a1-ballot', 'a2-ballot', 'a2-chair', 'a3-ballot', 'committee-tally', 'revision']);
  assert.deepEqual(def.members['revision'], { adapter: 'hub-revision' });
  assert.deepEqual(def.topology, {
    kind: 'graph',
    start: 'ballots',
    nodes: { ballots: { kind: 'parallel', branches: ['a1-ballot', 'a2-ballot', 'a3-ballot'], merge: 'committee-tally' }, chair: 'a2-chair', revision: 'revision' },
    edges: [
      { from: 'ballots', to: 'revision', when: { ext: { 'hub.decision': 'defer' } } },
      { from: 'ballots', to: 'chair', when: { ext: { 'hub.chair': 'yes' } } },
      { from: 'chair', to: 'revision', when: { ext: { 'hub.decision': 'defer' } } },
      { from: 'revision', to: 'ballots' },
    ],
    end: ['ballots', 'chair'],
  });
  assert.deepEqual(def.limits, { maxIterations: 4, maxSteps: 24 });
  createBasicTopology().bind(def.topology);
  assert.throws(() => topologyFor('committee', { group: 'g1', seats: ['a1'], maxRounds: 1 }), /chair/);
});
