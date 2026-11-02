import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../config.ts';
import { loadGameConfig } from '../rt/config.ts';
import { Game } from '../rt/game.ts';
import type { CommitteeMock, Group, GroupManager } from '../rt/groups.ts';
import type { CommitteeDecision } from '../rt/ideas.ts';

// The game's own committee session over the offline hub: a deferral keeps the run on the idea (and in its record), the
// resubmitted idea goes on with that run, the decision lets it go.

const dataDir = mkdtempSync(join(tmpdir(), 'hub-game-committee-'));
const sim = loadConfig(['--mock'], {});
const base = loadGameConfig({});
const game = new Game(sim, { ...base, stack: { dataDir }, mock: { ...base.mock, thinkDelayMs: 0 } });
// Rules the session reads: a quorum of one, approval slots, no freeze.
game.world.rules = new Proxy({}, { get: (_t, k) => (k === 'committee_quorum' ? 1 : k === 'quarter_idea_slots' ? 5 : 0) }) as typeof game.world.rules;

/** Writes the Keeper would get (rows of the Idea kind) and a client that accepts everything. */
const rows: Array<Record<string, unknown>> = [];
Object.assign(game.client, {
  createBranch: async (name: string) => ({ name, head: 'h' }),
  execute: async (_op: string, p: { kind: string; rows?: Array<Record<string, unknown>> }) => {
    if (p.kind === 'Idea') rows.push(...(p.rows ?? []));
    return { status: 'ok', revision: 'r', head: 'h', edit_count: 1 };
  },
  createProposal: async () => ({ id: 'prp_1', status: 'open' }),
  review: async () => ({ approval: { satisfied: true } }),
  merge: async () => ({ result: 'merged', revision: 'r2' }),
  closeProposal: async () => ({}),
  deleteBranch: async () => ({}),
});

after(async () => {
  game.stopLoop();
  await game.stacks.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const internals = game as unknown as {
  groups: GroupManager;
  runCommittee(g: Group): Promise<void>;
  committeeMock(idea: unknown): CommitteeMock;
  sessionDue: boolean;
};

test('runCommittee: a deferral keeps the run on the idea; the resubmission resumes it and the committee approves', async () => {
  const members = ['Seat A', 'Seat B', 'Seat C'].map((name) => game.world.spawn({ name, role: 'crafter', tier: 'haiku', model: sim.models.haiku, kind: 'agent' }));
  const created = internals.groups.create('Comitato', 'council', members, members[0]!, { jointPlans: false, committee: true });
  assert.ok(typeof created !== 'string', String(created));
  const g = created as Group;

  const at = { day: 1, minute: 600 };
  const full = { problem: 'p', users: 'u', solution: 's', differentiation: 'd', feasibility: 'f', risks: 'r' };
  const idea = await game.ideas.create('Livia', { title: 'Rinvio', ...full }, { at, quarter: 'Q1', signals: [], maxOpen: 3 });
  assert.ok(typeof idea !== 'string');
  game.ideas.review(idea.code, 'Dario', { impact: 8, feasibility: 6, novelty: 7, fit: 8, risk: 3 }, 'bene', at);
  game.ideas.review(idea.code, 'Sara', { impact: 6, feasibility: 6, novelty: 5, fit: 7, risk: 4 }, 'ok', at);
  const submit = async () => {
    const out = await game.ideas.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2 });
    assert.ok(typeof out !== 'string', String(out));
  };
  await submit();

  let next: CommitteeDecision = 'defer';
  internals.committeeMock = () => ({
    vote: () => ({ vote: next, reason: `vote ${next}` }),
    chair: () => ({ decision: next, summary: `chair ${next}` }),
  });
  const resumed: Array<{ runId: string }> = [];
  const resume = internals.groups.resumeReview.bind(internals.groups);
  internals.groups.resumeReview = (gr, prior, ...rest) => (resumed.push(prior), resume(gr, prior, ...rest));

  await internals.runCommittee(g);
  const deferred = game.ideas.get(idea.code)!;
  assert.equal(deferred.decision?.decision, 'defer');
  assert.ok(deferred.committeeRun?.runId, 'the waiting run stays on the idea');
  await game.ideas.settle();
  const record = rows.at(-1)!;
  assert.deepEqual(record.committee_run, deferred.committeeRun, 'and in its record');
  assert.deepEqual(resumed, []);

  // The authors resubmit; the committee goes on with the run that deferred it.
  const run = deferred.committeeRun!;
  next = 'approve';
  const revised = game.ideas.enrich(idea.code, 'Giulia', { risks: 'rischi rivisti dopo il rinvio' }, { at, signals: [] });
  assert.ok(typeof revised !== 'string', String(revised));
  await submit();
  await internals.runCommittee(g);
  assert.deepEqual(resumed.map((r) => r.runId), [run.runId]);
  const approved = game.ideas.get(idea.code)!;
  assert.equal(approved.decision?.decision, 'approve');
  assert.equal(approved.stage, 'approved');
  assert.equal(approved.committeeRun, null, 'the run is let go once decided');
  await game.ideas.settle();
  assert.deepEqual(rows.at(-1)!.committee_run, {});
});
