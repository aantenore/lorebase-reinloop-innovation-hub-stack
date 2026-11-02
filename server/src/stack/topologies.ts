// Plexus topologies of the group patterns. Pure: a pattern and the people who sit in it (already chosen by the group
// manager: who is consulted, who is elder) give the members and the topology of a system config; no model, no host.
// Member ids are `<person>-<capacity>`, so one person can hold several seats of the same system.
import type { AdapterRef, LimitKey, TopologySpec } from '@agent-plexus/core';
import type { GroupPattern } from '../rt/config.ts';
import type { TraceRole } from '../rt/groups.ts';
import type { Capacity } from './index.ts';

/** What a hub-person member is asked to do; picks the briefing of the group manager and how the answer is mapped. */
export type Brief =
  | 'worker' | 'prose' | 'scout' | 'planner' // prose: tolerant (partial text counts, no answer is empty text)
  | 'lead' | 'merge' | 'plan' | 'doer' // plan writers: the run must commit a plan
  | 'proposal' // plan writer who may fail without failing the parallel node it sits in
  | 'judge' | 'route' | 'vote';

/** Options of a `hub-person` member. */
export interface PersonSpec {
  person: string;
  capacity: Capacity;
  /** Role the member's words are traced under. */
  role: TraceRole;
  brief: Brief;
  /** The plan it commits is kept as the system's last plan (what stands when a loop gives up). */
  keep?: boolean;
}

/** Names of the `hub-fn` members. */
export type HubFnName = 'ballot-box' | 'tally' | 'committee-tally';

/** The people of one group decision, by person id. Which fields a pattern reads is in `topologyFor`. */
export interface Roster {
  /** Group id. */
  group: string;
  /** Leader: supervisor (orchestrator), router (router), doer (chain). */
  lead?: string;
  /** Orchestrator: the workers the supervisor may delegate to. */
  workers?: string[];
  /** Council: who proposes and who harmonizes and judges. */
  proposers?: string[];
  elder?: string;
  /** Router: who may be chosen. */
  candidates?: string[];
  /** Chain: scout first, then the planners; the doer is `lead`. */
  before?: string[];
  /** Mentor. */
  apprentice?: string;
  mentor?: string;
  /** Assembly: everyone who proposes and votes, in the order of the ballots. */
  voting?: string[];
  /** Rounds of a council or a mentor (at least 1). */
  maxRounds: number;
}

/** What a pattern adds to the base system config. */
export interface TopologyDef {
  members: Record<string, AdapterRef>;
  topology: TopologySpec;
  /** `limits.system` values this topology needs beyond the base config. */
  limits?: Partial<Record<LimitKey, number>>;
}

/** Kinds of system the hub builds (`crowd` has none). */
export type SystemKind = Exclude<GroupPattern, 'crowd'> | 'committee';

export const memberId = (person: string, capacity: Capacity): string => `${person}-${capacity}`;

/** The person and capacity behind a member id (capacities have no dash). */
export function parseMemberId(id: string): { person: string; capacity: string } {
  const at = id.lastIndexOf('-');
  return at < 0 ? { person: id, capacity: '' } : { person: id.slice(0, at), capacity: id.slice(at + 1) };
}

const person = (p: string, capacity: Capacity, role: TraceRole, brief: Brief, keep = false): [string, AdapterRef] => [
  memberId(p, capacity),
  { adapter: 'hub-person', options: { person: p, capacity, role, brief, ...(keep ? { keep } : {}) } satisfies PersonSpec },
];

const fn = (name: HubFnName): AdapterRef => ({ adapter: 'hub-fn', options: { fn: name } });

function need<T>(value: T | undefined, what: string, kind: string): T {
  if (value === undefined || (Array.isArray(value) && !value.length)) throw new RangeError(`${kind} topology needs ${what}`);
  return value;
}

/** Member ids of the same capacity for a list of people. */
const ids = (people: readonly string[], capacity: Capacity): string[] => people.map((p) => memberId(p, capacity));

/** Rounds of a loop: whole, at least one. */
const rounds = (n: number): number => Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));

/**
 * The members and topology of a pattern:
 * - orchestrator: supervise { lead-lead, workers-propose }; the supervisor delegates (`plexus.delegate`) one worker per turn;
 * - council: loop { sequence [ parallel { proposers-propose, merge elder-write }, elder-judge ] } until the elder passes;
 * - router: handoff { start lead-route, candidates-write_member } (the router names one: `plexus.handoff`);
 * - chain: sequence [ scout-propose, planners-propose, doer-write ];
 * - mentor: loop { sequence [ apprentice-write, mentor-judge ] } until the mentor passes;
 * - assembly: graph { proposals: parallel { voting-write_member, merge ballot-box }, ballots: parallel { voting-vote, merge tally } }.
 */
export function topologyFor(kind: SystemKind, roster: Roster): TopologyDef {
  switch (kind) {
    case 'orchestrator': {
      const lead = need(roster.lead, 'a lead', kind);
      const workers = roster.workers ?? [];
      const supervisor = memberId(lead, 'lead');
      return {
        members: Object.fromEntries([person(lead, 'lead', 'leader', 'lead'), ...workers.map((w) => person(w, 'propose', 'proposer', 'worker'))]),
        // With no one to delegate to the supervisor is its own worker (the topology wants a member list).
        topology: { kind: 'supervise', supervisor, members: workers.length ? ids(workers, 'propose') : [supervisor] },
        limits: { maxHandoffs: Math.max(1, workers.length) },
      };
    }
    case 'council': {
      const elder = need(roster.elder, 'an elder', kind);
      const proposers = need(roster.proposers, 'proposers', kind);
      return {
        members: Object.fromEntries([
          ...proposers.map((p) => person(p, 'propose', 'proposer', 'prose')),
          person(elder, 'write', 'leader', 'merge', true),
          person(elder, 'judge', 'critic', 'judge'),
        ]),
        topology: {
          kind: 'loop',
          body: {
            kind: 'sequence',
            steps: [{ kind: 'parallel', branches: ids(proposers, 'propose'), merge: memberId(elder, 'write') }, memberId(elder, 'judge')],
          },
          until: { ext: { 'hub.verdict': 'pass' } },
          maxIterations: rounds(roster.maxRounds),
        },
      };
    }
    case 'router': {
      const lead = need(roster.lead, 'a lead', kind);
      const candidates = need(roster.candidates, 'candidates', kind);
      return {
        members: Object.fromEntries([person(lead, 'route', 'router', 'route'), ...candidates.map((c) => person(c, 'write_member', 'proposer', 'plan'))]),
        topology: { kind: 'handoff', start: memberId(lead, 'route'), members: ids(candidates, 'write_member'), maxHandoffs: 1 },
      };
    }
    case 'chain': {
      const doer = need(roster.lead, 'a doer (lead)', kind);
      const before = roster.before ?? [];
      return {
        members: Object.fromEntries([
          ...before.map((p, i) => person(p, 'propose', i === 0 ? 'proposer' : 'critic', i === 0 ? 'scout' : 'planner')),
          person(doer, 'write', 'leader', 'doer'),
        ]),
        topology: { kind: 'sequence', steps: [...ids(before, 'propose'), memberId(doer, 'write')] },
      };
    }
    case 'mentor': {
      const mentor = need(roster.mentor, 'a mentor', kind);
      const apprentice = need(roster.apprentice, 'an apprentice', kind);
      // The apprentice is the mentor themselves in a group of one: then they write on their own model.
      const capacity: Capacity = apprentice === mentor ? 'write' : 'write_member';
      return {
        members: Object.fromEntries([person(apprentice, capacity, 'proposer', 'plan', true), person(mentor, 'judge', 'critic', 'judge')]),
        topology: {
          kind: 'loop',
          body: { kind: 'sequence', steps: [memberId(apprentice, capacity), memberId(mentor, 'judge')] },
          until: { ext: { 'hub.verdict': 'pass' } },
          maxIterations: rounds(roster.maxRounds),
        },
      };
    }
    case 'assembly': {
      const voting = need(roster.voting, 'voters', kind);
      return {
        members: Object.fromEntries([
          ...voting.map((p) => person(p, 'write_member', 'proposer', 'proposal')),
          ...voting.map((p) => person(p, 'vote', 'voter', 'vote')),
          ['ballot-box', fn('ballot-box')],
          ['tally', fn('tally')],
        ]),
        topology: {
          kind: 'graph',
          start: 'proposals',
          nodes: {
            proposals: { kind: 'parallel', branches: ids(voting, 'write_member'), merge: 'ballot-box' },
            ballots: { kind: 'parallel', branches: ids(voting, 'vote'), merge: 'tally' },
          },
          // The ballot box puts a poll up only when there is more than one valid proposal.
          edges: [{ from: 'proposals', to: 'ballots', when: { ext: { 'hub.vote': 'yes' } } }],
          end: ['proposals', 'ballots'],
        },
      };
    }
    case 'committee':
      throw new RangeError('committee topology: built with the committee review');
  }
}
