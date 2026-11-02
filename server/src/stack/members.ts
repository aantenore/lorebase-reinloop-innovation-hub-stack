// Members of the group systems. `hub-person` is one person acting in one capacity of their own stack: it opens the
// briefing the group manager wrote for the seat, runs the capacity (the stack opens the run's scratch) and maps what the
// run ended with to a member result: the plan as output, the verdict, the delegation or the handoff as `ext`. Tolerant
// seats never fail the node they sit in: partial text counts, a voter who cannot answer abstains, a judge who cannot
// answer passes. `hub-fn` members are the pure steps between nodes (the ballot box, the tally).
import {
  defineAdapter, inputText, loadDescriptor, PORT_VERSIONS,
  type AdapterContext, type AdapterDescriptor, type DescriptorLoader, type Fills, type MemberCallContext, type MemberPort, type MemberResult, type RunInput,
} from '@agent-plexus/core';
import { createFunctionMember } from '@agent-plexus/adapters/function-member';
import type { Tool } from 'reinloop';
import { assemblyOutcome, DECISIONS, unionOf, type Ballot, type ChairDecision } from '../rt/committee.ts';
import type { PlanData, TraceRole } from '../rt/groups.ts';
import type { CommitteeDecision, CommitteeVote } from '../rt/ideas.ts';
import { weightedWinner } from '../rt/society.ts';
import { tally } from '../rt/vote.ts';
import type { RtEntity } from '../rt/world.ts';
import type { CapResult, PersonStack } from './index.ts';
import type { MockScript } from './model.ts';
import { memberId, parseMemberId, type Brief, type HubFnName, type PersonSpec } from './topologies.ts';

/** What the group manager prepares for one seat's call. */
export interface Briefing {
  /** Role template: who the person is in this group, what the seat does. */
  system?: string;
  /** What the person is asked. */
  task: string;
  /** The tools of this run (their budgets and closures belong to the run); the person's catalog when absent. */
  tools?: Tool[];
  /** Offline script of the run. */
  mock?: MockScript;
  /** Judges: the text a failed verdict sends back to the next round (`candidate`, `feedback`). */
  revise?(candidate: string, feedback: string): string;
}

export interface BriefCall {
  spec: PersonSpec;
  entity: RtEntity;
  /** Output of the node before (the situation at the start). */
  input: string;
}

/** The committee's session on one idea, as its members see it (set on the run of a committee system). */
export interface CommitteeRun {
  /** The idea's code: the handle of the wait for its resubmission. */
  idea: string;
  /** Who casts a ballot this time; the other seats abstain without a model call. */
  voters: readonly string[];
  /** The esteem-weighted plurality decides; otherwise the chair does. */
  assembly: boolean;
  /** Ballots carry a verdict per criterion (policy criteri_comitato). */
  criteria: boolean;
  /** Longest summary of an assembly's decision. */
  textMax: number;
  /** A person's name, for the minutes. */
  name(personId: string): string;
}

/** What the committee system hands on: the votes, and the decision once it is made. */
export interface CommitteeOutcomeData {
  decision?: CommitteeDecision;
  summary?: string;
  votes: CommitteeVote[];
  unmet?: string[];
  outOfPolicy?: string[];
}

/** One group decision, as the members of its system see it. Registered under the run's session id. */
export interface GroupRun {
  /** The living person with this id, if any. */
  entity(id: string): RtEntity | undefined;
  brief(call: BriefCall): Briefing;
  /** A member said something: kept in the decision's trace and told to the host. */
  said(personId: string, role: TraceRole, text: string): void;
  /** Last plan of a seat that keeps its plan (what stands when a loop gives up). */
  lastPlan?: PlanData;
  /** Assembly: the people who propose and vote; committee: the seats; in the order of the ballots. */
  voting: string[];
  /** The committee's session (committee systems only). */
  committee?: CommitteeRun;
  /** The proposals put to the vote (set by the ballot box). */
  proposals?: Array<{ author: string; plan: PlanData }>;
  /** A proposal against the plan schema: steps repaired or dropped, steps without a valid `who` go to the author; undefined when nothing valid is left. */
  repair(plan: { summary: unknown; steps: unknown }, authorId: string): PlanData | undefined;
  /** The ballot's list of proposals (one line each). */
  proposalLines(list: Array<{ author: string; summary: string }>): string;
  /** Weight of a person's vote. */
  weight(personId: string): number;
}

/** Runs of the group systems by session id: the members look up the decision they serve here. */
export class GroupRuns {
  readonly #runs = new Map<string, GroupRun>();

  /** Registers a run; the returned function removes it. */
  open(sessionId: string, run: GroupRun): () => void {
    this.#runs.set(sessionId, run);
    return () => {
      if (this.#runs.get(sessionId) === run) this.#runs.delete(sessionId);
    };
  }

  get(sessionId: string | undefined): GroupRun | undefined {
    return sessionId === undefined ? undefined : this.#runs.get(sessionId);
  }
}

/** What the members need from the hub. */
export interface MemberEnv {
  stackFor(e: RtEntity): Promise<PersonStack>;
  readonly runs: GroupRuns;
}

// ---------------------------------------------------------------------------------------------------------------
// Results

const ERR = (by: string, detail: string): MemberResult => ({ status: 'failed', output: '', reason: { code: 'error', layer: 'member', by, detail } });
const ABORTED = (by: string): MemberResult => ({ status: 'stopped', output: '', reason: { code: 'aborted', layer: 'member', by } });
const done = (output: string, ext?: Record<string, unknown>, res?: CapResult): MemberResult => {
  const usage = res?.run.usage;
  return {
    status: 'completed', output,
    ...(ext ? { ext } : {}),
    ...(usage ? { usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } } : {}),
  };
};

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** The outputs of a parallel node's branches (`[label]\n<output>` blocks joined by a blank line), by label, in order. */
export function blocksOf(text: string, labels: readonly string[]): string[] {
  const marks = labels.map((l) => `[${l}]\n`);
  const at: number[] = [];
  let from = 0;
  for (const m of marks) {
    const i = text.indexOf(m, from);
    at.push(i);
    if (i >= 0) from = i + m.length;
  }
  return labels.map((_, k) => {
    if (at[k]! < 0) return '';
    const next = at.slice(k + 1).find((i) => i >= 0);
    return text.slice(at[k]! + marks[k]!.length, next ?? text.length).replace(/\n\n$/, '');
  });
}

/** A JSON object in a text (the whole text, or the first {...} in it). */
function objectIn(text: string): Record<string, unknown> | undefined {
  const parse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  return parse(text.trim()) ?? (/\{[\s\S]*\}/.exec(text) ? parse(/\{[\s\S]*\}/.exec(text)![0]) : undefined);
}

// ---------------------------------------------------------------------------------------------------------------
// hub-person

type Kind = 'plan' | 'prose' | 'judge' | 'route' | 'vote' | 'ballot' | 'chair';

/** How each briefing's answer is read; `tolerant` seats never fail their node. */
const KINDS: Record<Brief, { kind: Kind; tolerant: boolean }> = {
  worker: { kind: 'prose', tolerant: true }, prose: { kind: 'prose', tolerant: true }, scout: { kind: 'prose', tolerant: true }, planner: { kind: 'prose', tolerant: true },
  lead: { kind: 'plan', tolerant: false }, merge: { kind: 'plan', tolerant: false }, plan: { kind: 'plan', tolerant: false }, doer: { kind: 'plan', tolerant: false },
  proposal: { kind: 'plan', tolerant: true },
  judge: { kind: 'judge', tolerant: true }, route: { kind: 'route', tolerant: false }, vote: { kind: 'vote', tolerant: true },
  ballot: { kind: 'ballot', tolerant: true }, chair: { kind: 'chair', tolerant: false },
};

const messagesOf = (b: Briefing): RunInput | string => (b.system
  ? { messages: [{ role: 'system', parts: [{ type: 'text', text: b.system }] }, { role: 'user', parts: [{ type: 'text', text: b.task }] }] } as never
  : b.task);

const isBallot = (r: unknown): r is Ballot => !!r && typeof r === 'object' && 'vote' in r && DECISIONS.includes((r as Ballot).vote);
const isChair = (r: unknown): r is ChairDecision => !!r && typeof r === 'object' && 'decision' in r && DECISIONS.includes((r as ChairDecision).decision);

/** What a committee step handed on, read back from its output (the votes cast, the decision once made). */
export function committeeData(text: string): CommitteeOutcomeData {
  const o = objectIn(text);
  const decision = DECISIONS.includes(o?.decision as CommitteeDecision) ? (o!.decision as CommitteeDecision) : undefined;
  const votes = (Array.isArray(o?.votes) ? (o!.votes as unknown[]) : []).filter((v): v is CommitteeVote => !!v && typeof v === 'object' && DECISIONS.includes((v as CommitteeVote).vote));
  return {
    votes, ...(decision ? { decision } : {}), ...(typeof o?.summary === 'string' ? { summary: o.summary } : {}),
    ...(Array.isArray(o?.unmet) ? { unmet: o.unmet.map(String) } : {}), ...(Array.isArray(o?.outOfPolicy) ? { outOfPolicy: o.outOfPolicy.map(String) } : {}),
  };
}

const choiceOf = (text: string): { choice: number; reason: string } | undefined => {
  const o = objectIn(text);
  const n = Number(o?.choice);
  return Number.isInteger(n) ? { choice: n, reason: String(o?.reason ?? '') } : undefined;
};

async function personCall(env: MemberEnv, spec: PersonSpec, input: RunInput, call: MemberCallContext): Promise<MemberResult> {
  const id = memberId(spec.person, spec.capacity);
  const run = env.runs.get(call.sessionId);
  if (!run) return ERR(id, 'no group run for this session');
  if (call.signal?.aborted) return ABORTED(id);
  const { kind, tolerant } = KINDS[spec.brief];
  const text = inputText(input);
  // A member unseated for this idea abstains: no briefing, no model call.
  if (spec.brief === 'ballot' && run.committee && !run.committee.voters.includes(spec.person)) return done('', { 'hub.vote': 'abstain' });
  const entity = run.entity(spec.person);
  let briefing: Briefing | undefined;
  let res: CapResult | undefined;
  let failure = entity ? '' : `${spec.person} is gone`;
  if (entity) {
    try {
      briefing = run.brief({ spec, entity, input: text });
      const ps = await env.stackFor(entity);
      res = await ps.run(spec.capacity, messagesOf(briefing) as never, {
        sessionId: call.sessionId,
        ...(call.signal ? { signal: call.signal } : {}),
        ...(briefing.tools ? { tools: briefing.tools } : {}),
        ...(briefing.mock ? { mock: briefing.mock } : {}),
      });
    } catch (err) {
      if (isAbort(err) || call.signal?.aborted) return ABORTED(id);
      failure = err instanceof Error ? err.message : String(err);
    }
  }
  const ended = res !== undefined && (res.run.status === 'completed' || res.run.status === 'stopped');
  if (res && !ended) failure = `${res.run.status}${res.run.reason ? ` (${res.run.reason.code})` : ''}`;
  if (call.signal?.aborted) return ABORTED(id);
  const say = (role: TraceRole, said: string) => {
    if (said.trim()) run.said(spec.person, role, said);
  };

  if (kind === 'plan') {
    if (res?.plan) {
      const plan: PlanData = { summary: res.plan.summary, steps: res.plan.steps };
      if (spec.keep) run.lastPlan = plan;
      say(spec.role, plan.summary);
      return done(JSON.stringify(plan), { 'hub.plan': 'yes' }, res);
    }
    if (spec.brief === 'lead' && res?.delegate) {
      const { member, input: task } = res.delegate;
      say(spec.role, res.run.output);
      return done(res.run.output, { 'plexus.delegate': { member, ...(task ? { input: task } : {}) } }, res);
    }
    if (tolerant) {
      say(spec.role, res?.run.output ?? '');
      return done('', { 'hub.plan': 'no' }, res);
    }
    return ERR(id, failure || 'no plan committed');
  }

  if (kind === 'prose') {
    const out = (res?.run.output ?? '').trim();
    say(spec.role, out);
    return done(out, undefined, res);
  }

  if (kind === 'judge') {
    const verdict = ended ? res?.verdict : undefined;
    // A judge who cannot answer does not block the plan.
    const pass = verdict ? verdict.pass !== false : true;
    const feedback = String(verdict?.feedback ?? '');
    say(spec.role, JSON.stringify({ pass, feedback }));
    const next = pass ? text : (briefing?.revise?.(text, feedback) ?? feedback);
    return done(next, { 'hub.verdict': pass ? 'pass' : 'revise' }, res);
  }

  if (kind === 'route') {
    if (!ended || !res?.handoff) return ERR(id, failure || 'no route chosen');
    say(spec.role, JSON.stringify({ route: parseMemberId(res.handoff).person }));
    // The next member reads the situation the router read.
    return done(text, { 'plexus.handoff': res.handoff }, res);
  }

  if (kind === 'ballot') {
    // The ballot recorded by the run's record tool; a voter who cannot cast one abstains.
    const b = ended && res && isBallot(res.record) ? res.record : undefined;
    if (!b) return done('', { 'hub.vote': 'abstain' }, res);
    const vote: CommitteeVote = {
      member: spec.person, name: entity?.name ?? spec.person, vote: b.vote, reason: b.reason,
      ...(run.committee?.criteria ? { criteria: b.criteria, unmet: b.unmet, outOfPolicy: b.outOfPolicy } : {}),
    };
    say(spec.role, `${b.vote}: ${b.reason}`);
    return done(JSON.stringify(vote), { 'hub.vote': 'cast' }, res);
  }

  if (kind === 'chair') {
    // The chair reads the votes the tally handed over and records the committee's decision.
    const d = ended && res && isChair(res.record) ? res.record : undefined;
    if (!d) return ERR(id, failure || 'no decision recorded');
    const votes = committeeData(text).votes;
    say(spec.role, `${d.decision}: ${d.summary}`);
    const out: CommitteeOutcomeData = {
      decision: d.decision, summary: d.summary, votes,
      ...(run.committee?.criteria ? { unmet: d.unmet, outOfPolicy: unionOf([d.outOfPolicy, ...votes.map((v) => v.outOfPolicy)]) } : {}),
    };
    return done(JSON.stringify(out), { 'hub.decision': d.decision }, res);
  }

  // vote: the choice and the reason as one line of JSON; no valid choice is an abstention
  const vote = choiceOf(res?.run.output ?? '');
  if (!vote) return done('', { 'hub.vote': 'abstain' }, res);
  const out = JSON.stringify(vote);
  say(spec.role, out);
  return done(out, { 'hub.vote': 'cast' }, res);
}

// ---------------------------------------------------------------------------------------------------------------
// hub-fn

/** A pure step between nodes: reads the joined outputs of the branches before it, answers a member result. */
export type HubFn = (input: string, run: GroupRun, call: MemberCallContext) => MemberResult;

const planIn = (text: string): { summary: unknown; steps: unknown } | undefined => {
  const o = objectIn(text);
  return o && Array.isArray(o.steps) ? { summary: o.summary, steps: o.steps } : undefined;
};

/** Collects the proposals of the assembly, checks them against the plan schema and puts them to the vote (when there are several). */
const ballotBox: HubFn = (input, run) => {
  const outs = blocksOf(input, run.voting.map((p) => memberId(p, 'write_member')));
  const proposals = outs.flatMap((out, i) => {
    const raw = planIn(out);
    const author = run.voting[i]!;
    const plan = raw && run.repair(raw, author);
    return plan ? [{ author, plan }] : [];
  });
  run.proposals = proposals;
  if (!proposals.length) return ERR('ballot-box', 'no valid proposal');
  if (proposals.length === 1) return done(JSON.stringify({ ...proposals[0]!.plan, winner: 1 }));
  return done(run.proposalLines(proposals.map((p) => ({ author: p.author, summary: String(p.plan.summary ?? '') }))), { 'hub.vote': 'yes' });
};

/** Counts the ballots: the plurality weighed by the voters' esteem wins. */
const tallyBallots: HubFn = (input, run) => {
  const proposals = run.proposals;
  if (!proposals?.length) return ERR('tally', 'no proposals to vote on');
  const outs = blocksOf(input, run.voting.map((p) => memberId(p, 'vote')));
  const votes = outs.map((out) => {
    const v = choiceOf(out);
    return v ? v.choice - 1 : null;
  });
  const result = tally(votes, proposals.length, [0]);
  const weighted = weightedWinner(votes, run.voting.map((p) => run.weight(p)), proposals.length);
  const win = proposals[weighted.winner]!;
  return done(JSON.stringify({ ...win.plan, votes: result.counts, weights: weighted.weights, winner: weighted.winner + 1, majority: result.majority }));
};

/**
 * Counts the committee's ballots (the blocks of the seats that voted; an abstention is an empty block). In an assembly the
 * esteem-weighted plurality decides here; otherwise the votes go to the chair (`hub.chair`).
 */
const committeeTally: HubFn = (input, run) => {
  const c = run.committee;
  if (!c) return ERR('committee-tally', 'no committee for this session');
  const votes = blocksOf(input, run.voting.map((p) => memberId(p, 'ballot'))).flatMap((out) => {
    const v = objectIn(out);
    return v && DECISIONS.includes(v.vote as CommitteeDecision) ? [v as unknown as CommitteeVote] : [];
  });
  if (!c.assembly) return done(JSON.stringify({ votes } satisfies CommitteeOutcomeData), { 'hub.chair': 'yes' });
  if (!votes.length) return ERR('committee-tally', 'no valid vote');
  const outcome = assemblyOutcome(votes, run.weight, { name: (v) => v.name ?? c.name(v.member), textMax: c.textMax, criteria: c.criteria });
  return done(JSON.stringify({ ...outcome, votes } satisfies CommitteeOutcomeData), { 'hub.decision': outcome.decision });
};

/** The `hub-fn` steps by name. */
export const HUB_FNS: Partial<Record<HubFnName, HubFn>> = { 'ballot-box': ballotBox, tally: tallyBallots, 'committee-tally': committeeTally };

// ---------------------------------------------------------------------------------------------------------------
// Adapters

const CAPACITIES = ['decide', 'reply', 'propose', 'write', 'write_member', 'vote', 'ballot', 'chair', 'judge', 'route', 'lead'];

function personAdapter(env: MemberEnv): AdapterDescriptor<'MemberPort', PersonSpec> {
  return defineAdapter<'MemberPort', PersonSpec>({
    fills: 'MemberPort',
    name: 'hub-person',
    maps: { technology: 'a person of the hub acting in one capacity of their stack' },
    portVersion: PORT_VERSIONS.MemberPort,
    tiers: ['prototype', 'production'],
    description: 'A person of the world in one capacity (propose, write, judge, vote, route, lead) of their own agent stack.',
    capabilities: { resume: false, cancel: false, checkpoint: false, waits: false },
    optionsSchema: {
      type: 'object',
      required: ['person', 'capacity', 'role', 'brief'],
      properties: {
        person: { type: 'string', minLength: 1 },
        capacity: { type: 'string', enum: CAPACITIES },
        role: { type: 'string', minLength: 1 },
        brief: { type: 'string', minLength: 1 },
        keep: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    create: (options, ctx) => createFunctionMember({ fn: (input, call) => personCall(env, options, input, call), name: `${options.person}/${options.capacity}` }, ctx),
  });
}

function fnAdapter(env: MemberEnv): AdapterDescriptor<'MemberPort', { fn: HubFnName }> {
  return defineAdapter<'MemberPort', { fn: HubFnName }>({
    fills: 'MemberPort',
    name: 'hub-fn',
    maps: { technology: 'in-process step of a group decision' },
    portVersion: PORT_VERSIONS.MemberPort,
    tiers: ['prototype', 'production'],
    description: 'A pure step between the nodes of a group decision (ballot box, tally).',
    capabilities: { resume: false, cancel: false, checkpoint: false, waits: false },
    optionsSchema: { type: 'object', required: ['fn'], properties: { fn: { type: 'string', minLength: 1 } }, additionalProperties: false },
    create: (options, ctx: Pick<AdapterContext, 'name' | 'cwd'>): Promise<MemberPort> => {
      const step = HUB_FNS[options.fn];
      if (!step) throw new TypeError(`hub-fn: unknown function "${options.fn}"`);
      return createFunctionMember({
        fn: (input, call) => {
          const run = env.runs.get(call.sessionId);
          return run ? step(inputText(input), run, call) : ERR(options.fn, 'no group run for this session');
        },
      }, ctx);
    },
  });
}

/**
 * The committee's revision: the idea was deferred, so the run waits (the outcome is its output, the idea's code its handle)
 * until the authors resubmit it. The reply is the revised brief; the ballots that follow read it.
 */
function revisionAdapter(env: MemberEnv): AdapterDescriptor<'MemberPort', Record<string, never>> {
  const waiting = (output: string, ref: string): MemberResult => ({
    status: 'waiting', output, taskRef: ref, reason: { code: 'needs_input', layer: 'member', by: 'revision' }, ext: { 'hub.decision': 'defer' },
  });
  return defineAdapter<'MemberPort', Record<string, never>>({
    fills: 'MemberPort',
    name: 'hub-revision',
    maps: { technology: 'wait for the revised brief of a deferred idea' },
    portVersion: PORT_VERSIONS.MemberPort,
    tiers: ['prototype', 'production'],
    description: 'Ends the call waiting for input (the resubmitted idea) and completes with the revised brief it is answered with.',
    capabilities: { resume: true, cancel: false, checkpoint: false, waits: true },
    optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
    create: async (_options, ctx: Pick<AdapterContext, 'name' | 'cwd'>): Promise<MemberPort> => {
      const base = await createFunctionMember({
        fn: (input, call) => waiting(inputText(input), env.runs.get(call.sessionId)?.committee?.idea || call.runId),
      }, ctx);
      return {
        ...base,
        // Answered with the revised brief: the run goes on with it. Without one there is nothing to continue.
        resume: async (taskRef, input) => (input === undefined ? waiting('', taskRef) : { status: 'completed', output: inputText(input) }),
      };
    },
  });
}

/** The adapters of the group systems, found by name; any other adapter is looked up as usual (`@agent-plexus/adapters/<name>`). */
export function hubLoader(env: MemberEnv): DescriptorLoader {
  const own = new Map<string, AdapterDescriptor>([personAdapter(env), fnAdapter(env), revisionAdapter(env)].map((d) => [d.name, d as unknown as AdapterDescriptor]));
  return async (fills: Fills, name: string, cwd: string) => {
    const mine = fills === 'MemberPort' ? own.get(name) : undefined;
    return mine ?? loadDescriptor(fills, name, cwd);
  };
}
