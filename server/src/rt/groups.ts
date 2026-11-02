// Groups and how they decide. A group forms when its members say so (form_group / join_group
// tools) or from the roster config; its pattern is chosen by its founder. Each pattern is an agent-plexus
// system over the members' own stacks (stack/topologies.ts) producing ONE joint plan, split into each member's sub-plan:
//   orchestrator  the leader delegates to members (one worker per turn) and decides
//   council       members propose (a run cut short that said something still counts; with no proposal the
//                 elder decides alone), the elder harmonizes and judges (a judge that cannot answer does not
//                 block the council); when the rounds run out the last plan stands
//   router        the leader picks the member best suited to decide
//   chain         scout -> planner -> doer
//   mentor        the apprentice plans, the mentor critiques until satisfied
//   assembly      everyone proposes, everyone votes, the esteem-weighted plurality wins
//   crowd         one call plans for many extras (no system)
// Plans are committed with the commit_plan tool, which ends the writer's run (its data is the plan);
// verdicts, delegations and routes are tools that end the run too. Each role gets exactly the tools its text names:
// only plan writers see commit_plan and its format, prose proposers are asked for prose, judges, voters and
// routers get no faculties. The deciding role runs on the member's own model; the others (proposers, workers,
// voters) on `groups.memberTier`, and at most `groups.maxProposers` of them are consulted.
// The members of a system are stack/members.ts; this file writes their briefings (`groupRun`) and keeps the trace.
import {
  agent, type EasyAgent, type MockTurn, type ModelRequest, type RunResult, type Tool, tool,
} from 'reinloop';
import type { Translate } from '../i18n.ts';
import type { GameConfig, GroupPattern } from './config.ts';
import { AGENT_PATTERNS, cacheParams } from './config.ts';
import { type DecideHost, decisionTier, decisionTimeoutMs, type Failure, faculties, ideaTools, limitsOf, modelRef, normalizeSteps, planSchema, stackHub } from './decide.ts';
import type { CommitteeDecision, CommitteeVote } from './ideas.ts';
import { type Ballot, type BallotError, type BallotLabels, ballotSchema, type ChairDecision, chairSchema, checkBallot, checkChair, type Criterion, DECISIONS } from './committee.ts';
import type { Tier } from '../world/types.ts';
import { flatSteps, hasHabit, mockGroupPlan, mockSteps } from './mock.ts';
import type { PlanStep } from './plan.ts';
import { inboxBlock, look, memberLine, timeLine } from './prompt.ts';
import { weightedWinner } from './society.ts';
import type { RtEntity } from './world.ts';
import { blocksOf, type Briefing, type GroupRun } from '../stack/members.ts';
import { memberId, type Roster } from '../stack/topologies.ts';

export type TraceRole = 'proposer' | 'critic' | 'router' | 'leader' | 'voter';

export interface TraceEntry {
  member: string;
  role: TraceRole;
  text: string;
}

export interface GroupDecision {
  summary: string;
  trace: TraceEntry[];
}

export interface Group {
  id: string;
  name: string;
  pattern: GroupPattern;
  members: string[];
  leader: string | null;
  color: string;
  lastDecision?: GroupDecision;
  /** Reached the minimum size at least once (dropping below it then dissolves the group). */
  complete: boolean;
  memory: string[];
  /** False for a body that only decides on submitted ideas (the investment committee): its members plan on their own. */
  jointPlans: boolean;
  /** The investment committee (config ideas.committee.groupName). */
  committee: boolean;
}

/** What the committee decided on one idea, with each member's vote. */
export interface CommitteeOutcome {
  decision: CommitteeDecision;
  summary: string;
  votes: CommitteeVote[];
  /** Policy criteri_comitato: criteria the decision names as unmet, demands recorded outside the criteria. */
  unmet?: string[];
  outOfPolicy?: string[];
}

/** The committee's policy for one session: the criteria it votes on (empty: free votes). */
export interface CommitteePolicy {
  criteria: Criterion[];
}

/** Offline stand-ins for the committee's members and chair. */
export interface CommitteeMock {
  vote(m: RtEntity): { vote: CommitteeDecision; reason: string };
  chair(votes: CommitteeVote[]): { decision: CommitteeDecision; summary: string };
}

export interface JointPlan {
  summary: string;
  steps: PlanStep[];
  trace: TraceEntry[];
}

export interface GroupEvents {
  changed(g: Group): void;
  removed(g: Group): void;
  joined(g: Group, e: RtEntity): void;
  left(g: Group, e: RtEntity): void;
  formed(g: Group): void;
}

const SEP = '__';

/** Structured outputs of the judges and the voters. */
const VERDICT = { type: 'object', properties: { pass: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['pass', 'feedback'] };
/** Arguments of the supervisor's and the router's tools. */
const DELEGATE = { type: 'object', properties: { member: { type: 'string' }, task: { type: 'string' } }, required: ['member'] };
const ROUTE = { type: 'object', properties: { route: { type: 'string' }, reason: { type: 'string' } }, required: ['route'] };
/** Capacities that run on the members' tier (`groups.memberTier`) rather than the person's own model. */
const MEMBER_CAPS = new Set(['propose', 'write_member', 'vote']);
/** Structured outputs of the committee: a member's vote, the chair's decision. */
const IDEA_BALLOT = { type: 'object', properties: { vote: { enum: DECISIONS }, reason: { type: 'string' } }, required: ['vote', 'reason'] };
const IDEA_VERDICT = { type: 'object', properties: { decision: { enum: DECISIONS }, summary: { type: 'string' } }, required: ['decision', 'summary'] };
const asDecision = (v: unknown): CommitteeDecision | undefined => (DECISIONS.includes(v as CommitteeDecision) ? (v as CommitteeDecision) : undefined);

/** A joint plan as committed through commit_plan (the data of the writer's run). */
export interface PlanData {
  summary: string;
  steps: unknown[];
  /** Id of the member who wrote it (steps without a valid `who` are theirs). */
  author?: string;
}

/** The joint plan carried by a run or team result, if any. */
export function planOf(r: Pick<RunResult, 'status' | 'data'>): PlanData | undefined {
  const d = r.data as Partial<PlanData> | undefined;
  return (r.status === 'completed' || r.status === 'stopped') && d && Array.isArray(d.steps) && d.steps.length
    ? { summary: String(d.summary ?? ''), steps: d.steps, ...(typeof d.author === 'string' ? { author: d.author } : {}) }
    : undefined;
}

/** A member reference as models write it: id, name, or either inside a longer text ("Okon (a5)"). */
export function memberRef<M extends { id: string; name: string }>(ref: unknown, members: M[]): M | undefined {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return undefined;
  const esc = (x: string) => x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return members.find((m) => m.id.toLowerCase() === r || m.name.toLowerCase() === r)
    ?? members.find((m) => new RegExp(`(^|[^a-z0-9])(${esc(m.id)}|${esc(m.name)})([^a-z0-9]|$)`).test(r));
}

/**
 * Validates a joint plan's raw steps against the plan schema: a step whose `who` is missing or unknown
 * goes to `authorId` (or is dropped without one), a step that cannot be understood is dropped, and each
 * member keeps at most `maxPerMember` steps. Returns the valid steps and what was dropped (for the log).
 */
export function repairSteps<M extends { id: string; name: string }>(
  raw: unknown[], members: M[], authorId: string | undefined, textMax: number, maxPerMember: number,
): { steps: PlanStep[]; dropped: string[] } {
  const steps: PlanStep[] = [];
  const dropped: string[] = [];
  const perMember = new Map<string, number>();
  for (const s of raw) {
    const r = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const who = memberRef(r.who, members) ?? (authorId ? members.find((m) => m.id === authorId) : undefined);
    const what = String(r.action ?? '?');
    if (!who) {
      dropped.push(`${what}: who ${String(r.who ?? '-')}`);
      continue;
    }
    const n = perMember.get(who.id) ?? 0;
    if (n >= maxPerMember) continue;
    const [step] = normalizeSteps([s], textMax, 1);
    if (!step) {
      dropped.push(`${what}: invalid`);
      continue;
    }
    step.args.who = who.id;
    steps.push(step);
    perMember.set(who.id, n + 1);
  }
  return { steps, dropped };
}

/** A structured output (JSON text) as an object, or undefined for prose. */
export function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export class GroupManager {
  readonly groups = new Map<string, Group>();
  private nextId = 1;
  /** Run ids are unique across restarts (the journal keeps the runs of the last process too). */
  private readonly boot = Date.now().toString(36);
  private runSeq = 0;
  /** Model of each member run (by run name) of the decision being built, for cost booking. */
  private readonly models = new Map<string, string>();
  private readonly host: DecideHost;
  private readonly events: GroupEvents;

  constructor(host: DecideHost, events: GroupEvents) {
    this.host = host;
    this.events = events;
  }

  private get cfg(): GameConfig {
    return this.host.cfg;
  }

  private get t(): Translate {
    return this.host.t;
  }

  list(): Group[] {
    return [...this.groups.values()];
  }

  byName(name: string): Group | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((g) => g.name.toLowerCase() === n || g.id === name);
  }

  of(e: RtEntity): Group | undefined {
    return e.groupId ? this.groups.get(e.groupId) : undefined;
  }

  // ---- membership -------------------------------------------------------------

  create(name: string, pattern: GroupPattern, founders: RtEntity[], leader: RtEntity | null, opts: { jointPlans?: boolean; committee?: boolean } = {}): Group | string {
    const clean = name.trim().replace(new RegExp(SEP, 'g'), '_').slice(0, this.cfg.groups.nameMaxChars);
    if (!clean) return 'name';
    if (pattern !== 'crowd' && !AGENT_PATTERNS.includes(pattern)) return 'pattern';
    if (this.byName(clean)) return 'taken';
    if (founders.some((f) => f.groupId)) return 'member';
    const id = `g${this.nextId++}`;
    const colors = this.cfg.groups.colors;
    const g: Group = {
      id, name: clean, pattern, members: [], leader: leader?.id ?? null, color: colors[(this.nextId - 2) % colors.length] ?? '#888888',
      complete: false, memory: [], jointPlans: opts.jointPlans !== false, committee: opts.committee === true,
    };
    this.groups.set(id, g);
    for (const f of founders) this.attach(g, f);
    g.complete = g.members.length >= this.cfg.groups.minMembers;
    this.events.formed(g);
    this.events.changed(g);
    return g;
  }

  private attach(g: Group, e: RtEntity): void {
    g.members.push(e.id);
    e.groupId = g.id;
  }

  join(g: Group, e: RtEntity): string | undefined {
    if (e.groupId === g.id) return undefined;
    if (e.groupId) this.leave(e);
    if (g.members.length >= this.cfg.groups.maxMembers) return 'full';
    this.attach(g, e);
    if (g.members.length >= this.cfg.groups.minMembers) g.complete = true;
    this.events.joined(g, e);
    this.events.changed(g);
    return undefined;
  }

  leave(e: RtEntity): Group | undefined {
    const g = this.of(e);
    if (!g) return undefined;
    g.members = g.members.filter((id) => id !== e.id);
    e.groupId = null;
    // The most esteemed member takes the lead (rule esteem_vote_weight; ties: who joined first).
    if (g.leader === e.id) g.leader = g.pattern === 'crowd' ? null : ([...g.members].sort((a, b) => this.host.voteWeight(b) - this.host.voteWeight(a))[0] ?? null);
    this.events.left(g, e);
    if (!g.members.length || (g.complete && g.pattern !== 'crowd' && g.members.length < this.cfg.groups.minMembers)) this.dissolve(g);
    else this.events.changed(g);
    return g;
  }

  dissolve(g: Group): void {
    for (const id of g.members) {
      const m = this.host.world().entities.get(id);
      if (m) m.groupId = null;
    }
    g.members = [];
    this.groups.delete(g.id);
    this.events.removed(g);
  }

  /** A group decides jointly only when it has enough living members. */
  active(g: Group): boolean {
    return g.members.length >= (g.pattern === 'crowd' ? 1 : this.cfg.groups.minMembers);
  }

  // ---- decisions ----------------------------------------------------------------

  private livingMembers(g: Group): RtEntity[] {
    const w = this.host.world();
    const ms = g.members.map((id) => w.entities.get(id)).filter((m): m is RtEntity => !!m && m.alive);
    const lead = ms.find((m) => m.id === g.leader);
    return lead ? [lead, ...ms.filter((m) => m !== lead)] : ms;
  }

  /** Step counts per member: from the leader's (first member's) tier, or the given one. */
  private counts(members: RtEntity[], tier?: Tier): { min: number; max: number; horizon: number; maxTokens: number } {
    const tc = this.cfg.decisions.tiers[tier ?? decisionTier(members[0]!, this.cfg)];
    const horizon = this.host.world().r('plan_horizon_minutes') * tc.horizonFactor;
    return { min: Math.min(this.host.cfg.mock.planSteps, tc.maxSteps), max: tc.maxSteps, horizon, maxTokens: tc.maxOutputTokens };
  }

  /** The situation every member reads (the team's task). */
  private situation(g: Group, members: RtEntity[], why: string, crowd = false): string {
    const t = this.t;
    const w = this.host.world();
    const c = this.counts(members);
    const lead = members[0]!;
    const inbox = { ...lead, inbox: members.flatMap((m) => m.inbox).sort((a, b) => a.day - b.day || a.minute - b.minute).slice(-this.cfg.decisions.inboxItems) };
    return [
      crowd ? t('rt.group.crowdHeader', { horizon: Math.round(c.horizon) }) : t('rt.group.header', { name: g.name, pattern: t(`rt.pattern.${g.pattern}`), horizon: Math.round(c.horizon) }),
      timeLine(t, w),
      t('rt.group.members', { members: members.map((m) => memberLine(t, w, m, this.host.roleTitle)).join('\n') }),
      t('rt.observation.why', { why }),
      t('rt.observation.perceive', { look: look(t, w, lead, this.host.groups(), this.host.roleTitle, limitsOf(this.cfg), (b) => this.host.perceived.about(lead, b)) }),
      inboxBlock(t, inbox),
      t('rt.observation.memory', { memory: g.memory.length ? g.memory.map((m) => `- ${m}`).join('\n') : t('rt.observation.noMemory') }),
    ].join('\n\n');
  }

  /** How a plan writer commits the joint plan (only writers hold commit_plan). */
  private formatText(members: RtEntity[], tier?: Tier): string {
    const c = this.counts(members, tier);
    return this.t('rt.group.format', { minSteps: c.min, maxSteps: c.max });
  }

  private instructionsOf(m: RtEntity, g: Group, withFaculties: boolean): string {
    const role = this.host.roleOf(m.role);
    const vars = { name: m.name, personality: m.personality || '-', roleTitle: role?.title ?? m.role, role: m.role, group: g.name };
    return [this.t('rt.memberInstructions', vars), withFaculties ? this.t('rt.group.faculties') : '', withFaculties && this.host.research ? this.t('rt.webFaculty') : '', withFaculties && this.host.evidence ? this.t('rt.evidenceFaculty') : ''].filter(Boolean).join('\n');
  }

  /** The model tier a member uses in a capacity: its own when deciding, else `groups.memberTier` (when set). */
  private tierFor(m: RtEntity, deciding: boolean): Tier {
    const own = decisionTier(m, this.cfg);
    const cheap = this.cfg.groups.memberTier;
    return deciding || !cheap ? own : cheap;
  }

  private modelFor(m: RtEntity, deciding: boolean): string {
    const tier = this.tierFor(m, deciding);
    return tier === decisionTier(m, this.cfg) ? m.model : (this.host.sim.modelOverride ?? this.host.sim.models[tier]);
  }

  /**
   * Members consulted besides the one deciding: at most `groups.maxProposers`, the most esteemed
   * first (rule esteem_vote_weight; ties keep the group's order).
   */
  private consulted(members: RtEntity[], max = this.cfg.groups.maxProposers): RtEntity[] {
    if (!(max > 0) || members.length <= max) return members;
    return members.map((m, i) => ({ m, i, w: this.host.voteWeight(m.id) })).sort((a, b) => b.w - a.w || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.m);
  }

  /** commit_plan for whoever writes the joint plan: the call ends the writer's run with the plan as its data. */
  private planTool(max: number) {
    return tool<{ reason: string; steps: unknown[] }>('commit_plan', this.t('rt.group.commitPlan'), planSchema(this.t, this.cfg.decisions.textMaxChars, true, max), (args) => {
      if (!Array.isArray(args?.steps) || !args.steps.length) return { content: this.t('rt.act.noSteps'), isError: true };
      const summary = String(args.reason ?? '');
      return { content: summary || this.t('rt.group.planCaptured'), stop: true, data: { summary, steps: args.steps } satisfies PlanData };
    });
  }

  /**
   * One member acting in one capacity: its model (own when `deciding`, else `groups.memberTier`), identity,
   * tools and (when offline) a scripted mock. Plan writers (`json`) get commit_plan and its format; judges,
   * voters and routers (`structured`) get no tools; prose proposers get their faculties and the prose format.
   */
  private member(
    m: RtEntity, g: Group, role: TraceRole,
    opts: {
      json?: boolean; structured?: boolean; deciding?: boolean; output?: Record<string, unknown>; extra?: string; description?: string;
      mock: (req: ModelRequest, i: number) => MockTurn; turns?: number; members?: RtEntity[];
      /** These tools only (a ballot): no faculties, no format, `turns` turns. */
      only?: Tool[];
    },
  ): EasyAgent {
    const deciding = opts.deciding === true;
    const tier = this.tierFor(m, deciding);
    const model = this.modelFor(m, deciding);
    const counts = this.counts([m], tier);
    const tc = this.cfg.decisions.tiers[tier];
    const name = `${m.id}${SEP}${role}`;
    this.models.set(name, model);
    const bare = opts.structured === true || !!opts.only;
    const tools = opts.only ?? (bare ? [] : [...(opts.json ? [this.planTool(counts.max)] : []), ...faculties(this.host, m, tc), ...ideaTools(this.host, m)]);
    const format = bare ? '' : opts.json ? this.formatText(opts.members ?? [m], tier) : this.t('rt.group.proposeFormat');
    const p = this.cfg.decisions.modelParams;
    return agent({
      name,
      description: opts.description,
      model: modelRef(this.host, model, this.mockWithConsult(g, m, opts.json === true, opts.mock), this.cfg.mock.thinkDelayMs),
      params: { ...(opts.json ? p.plan : p.prose), ...cacheParams(this.cfg, true), maxTokens: opts.json ? counts.maxTokens : this.cfg.groups.proseMaxOutputTokens },
      ...(opts.output ? { output: opts.output } : {}),
      instructions: [this.instructionsOf(m, g, !bare), opts.extra, format].filter(Boolean).join('\n'),
      tools,
      budget: { maxTurns: (opts.turns ?? this.cfg.groups.maxTurns) + (bare ? 0 : tc.maxConsults) + (opts.json ? 1 : 0) },
    });
  }

  /** Offline only: members writing a joint plan sometimes consult Lorebase first. */
  private mockWithConsult(g: Group, m: RtEntity, json: boolean, mock: (req: ModelRequest, i: number) => MockTurn): (req: ModelRequest, i: number) => MockTurn {
    return (req, i) => {
      const consulted = req.messages.some((x) => x.role === 'tool');
      const seed = [...`${m.id}${this.host.world().minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
      if (json && g.pattern !== 'orchestrator' && !consulted && this.host.brain.connected && seed % 2 === 0) {
        return { toolCalls: [{ name: 'lorebase_search', args: { query: this.t('rt.mock.consult'), kinds: ['Rule'], limit: 3 } }] };
      }
      return mock(req, i);
    };
  }

  /** Offline: the joint plan writer commits a scripted plan. */
  private mockPlanCall(members: RtEntity[]): MockTurn {
    const c = this.counts(members);
    const p = mockGroupPlan(this.t, this.host.world(), members, { min: c.min, max: c.max }, this.cfg.mock);
    return { toolCalls: [{ name: 'commit_plan', args: { reason: p.summary, steps: flatSteps(p.steps).map((s) => ({ who: (s as { who?: string }).who, ...s })) } }] };
  }

  private mockProse(m: RtEntity): string {
    const p = mockSteps(this.t, this.host.world(), m, { min: 3, max: 3 }, { ...this.cfg.mock, experimentChance: 0 });
    return this.t('rt.mock.proposal', { label: p.steps[0]?.label ?? this.t('rt.mock.label.wait') });
  }

  /** The people of a pattern's seats (crowd has no system): who is consulted, who is elder, in the order the old patterns used. */
  private rosterFor(g: Group, members: RtEntity[]): Roster {
    const [lead, ...rest] = members;
    const maxRounds = this.cfg.groups.maxRounds;
    const ids = (ms: RtEntity[]) => ms.map((m) => m.id);
    switch (g.pattern) {
      case 'orchestrator':
        return { group: g.id, lead: lead!.id, workers: ids(this.consulted(rest)), maxRounds };
      case 'council': {
        const elder = members.find((m) => m.stage === 'elder') ?? lead!;
        const others = members.filter((m) => m !== elder);
        return { group: g.id, elder: elder.id, proposers: ids(this.consulted(others.length ? others : members)), maxRounds };
      }
      case 'router':
        return { group: g.id, lead: lead!.id, candidates: ids(this.consulted(members)), maxRounds };
      case 'chain': {
        const explores = (m: RtEntity) => Number(hasHabit(this.cfg.mock.habits, m.role, 'explore'));
        const ordered = [...members].sort((a, b) => explores(b) - explores(a));
        return { group: g.id, lead: lead!.id, before: ids(this.consulted(ordered.filter((m) => m !== lead))), maxRounds };
      }
      case 'mentor': {
        const mentor = members.find((m) => m.stage === 'elder') ?? lead!;
        return { group: g.id, mentor: mentor.id, apprentice: (members.find((m) => m !== mentor) ?? mentor).id, maxRounds };
      }
      case 'assembly':
        // No one decides alone: every consulted member proposes and votes, on the members' tier.
        return { group: g.id, voting: ids(this.consulted(members)), maxRounds };
      case 'crowd':
        return { group: g.id, maxRounds };
    }
  }

  /** A tool that ends the run with a recorded answer. */
  private stopTool<A>(name: string, description: string, schema: Record<string, unknown>, answer: (args: A) => { data: unknown; content: string } | { error: string }): Tool {
    return tool<A>(name, description, schema, (args) => {
      const out = answer((args ?? {}) as A);
      return 'error' in out ? { content: out.error, isError: true } : { content: out.content, stop: true, data: out.data };
    });
  }

  /**
   * One group decision as its system's members see it: the briefing of each seat (role template, task, tools, offline
   * script), the trace of what was said, and the checks of the assembly's ballot box.
   */
  private groupRun(g: Group, members: RtEntity[], roster: Roster, situation: string, trace: TraceEntry[]): GroupRun {
    const t = this.t;
    const tpl = (k: string) => t(`rt.group.tpl.${k}`);
    const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    const byId = new Map(members.map((m) => [m.id, m]));
    const people = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => byId.get(id) ?? []);
    const max = this.cfg.groups.traceMaxChars;
    const counts = new Map<string, number>();
    const nth = (key: string) => {
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return n;
    };
    const reports: string[] = [];
    const planCall = () => this.mockPlanCall(members);
    const slow = (script: (req: ModelRequest, i: number) => MockTurn) => (req: ModelRequest, i: number): MockTurn => ({
      delayMs: this.cfg.mock.thinkDelayMs / Math.max(1, this.host.world().timeScale), ...script(req, i),
    });
    const nameOf = (id: string) => byId.get(id)?.name ?? id;
    const run: GroupRun = {
      entity: (id) => {
        const m = byId.get(id);
        return m?.alive ? m : undefined;
      },
      voting: roster.voting ?? [],
      said: (personId, role, text) => {
        const said = this.traceText(text, members).slice(0, max);
        trace.push({ member: personId, role, text: said });
        this.host.deliberated(g, personId, role, said);
      },
      repair: (plan, authorId) => {
        const fixed = repairSteps(Array.isArray(plan.steps) ? plan.steps : [], members, authorId, this.cfg.decisions.textMaxChars, this.counts(members).max);
        if (fixed.dropped.length) console.warn(`[group ${g.name}] proposal by ${nameOf(authorId)}: dropped ${fixed.dropped.length} step(s): ${fixed.dropped.slice(0, 4).join('; ')}`);
        return fixed.steps.length ? { summary: String(plan.summary ?? ''), steps: fixed.steps as unknown[], author: authorId } : undefined;
      },
      proposalLines: (list) => list.map((p, k) => t('rt.group.proposalLine', { n: k + 1, name: nameOf(p.author), summary: p.summary })).join('\n'),
      weight: (id) => this.host.voteWeight(id),
      brief: ({ spec, entity: m, input }) => {
        const deciding = !MEMBER_CAPS.has(spec.capacity);
        const tier = this.tierFor(m, deciding);
        const tc = this.cfg.decisions.tiers[tier];
        const c = this.counts([m], tier);
        const vars = { name: m.name, id: m.id, group: g.name };
        const first = input === situation;
        const chain = () => (first ? input : fill(tpl('chain'), { task: situation, previous: input }));
        const system = (withFaculties: boolean, ...extra: Array<string | undefined>) => [this.instructionsOf(m, g, withFaculties), ...extra].filter(Boolean).join('\n');
        const faculty = () => [...faculties(this.host, m, tc), ...ideaTools(this.host, m)];
        const writer = (mock: (req: ModelRequest, i: number) => MockTurn, extra?: string, more: Tool[] = []) => ({
          system: system(true, extra, this.formatText(members, tier)),
          tools: [this.planTool(c.max), ...more, ...faculty()],
          mock: slow(this.mockWithConsult(g, m, true, mock)),
        });
        const prose = (task: string, mock: () => string, extra?: string): Briefing => ({
          system: system(true, extra, t('rt.group.proposeFormat')), task, tools: faculty(), mock: slow(this.mockWithConsult(g, m, false, () => ({ text: mock() }))),
        });
        switch (spec.brief) {
          case 'worker':
            return prose(t('rt.group.worker', { ...vars, task: input }), () => this.mockProse(m));
          case 'prose':
            return prose(input, () => this.mockProse(m));
          case 'scout':
            return prose(input, () => {
              const w = this.host.world();
              const f = w.tiles.find((x) => x.food >= 2 && Math.hypot(x.x - m.x, x.y - m.y) < 6) ?? { x: Math.round(m.x), y: Math.round(m.y) };
              const wd = w.tiles.find((x) => x.wood >= 2 && Math.hypot(x.x - m.x, x.y - m.y) < 8) ?? f;
              return t('rt.mock.scout', { x: f.x, y: f.y, wx: wd.x, wy: wd.y });
            }, t('rt.group.chainScout', vars));
          case 'planner':
            return prose(chain(), () => this.mockProse(m), t('rt.group.chainPlanner', vars));
          case 'lead': {
            // The supervisor delegates one worker per turn and sees the reports on its next one; the last turn it must commit.
            const turn = nth(`lead:${m.id}`);
            const workers = people(roster.workers);
            if (turn > 0) reports.push(input.replace(/^\[[^\]]*\]\n/, ''));
            const task = reports.length ? fill(tpl('aggregate'), { task: situation, results: reports.map((r, k) => `## ${workers[k]?.name ?? k + 1}\n${r}`).join('\n\n') }) : situation;
            const delegate = workers.length && turn < workers.length ? [this.delegateTool(workers, situation)] : [];
            return {
              ...writer((req, i) => (turn < workers.length ? { toolCalls: [{ name: 'delega', args: { member: workers[turn]!.id, task: situation } }] } : planCall()), undefined, delegate),
              task,
            };
          }
          case 'merge': {
            const proposers = roster.proposers ?? [];
            const outs = blocksOf(input, proposers.map((p) => memberId(p, 'propose')));
            const sections = outs.map((out, k) => ({ name: nameOf(proposers[k]!), out: out.trim() })).filter((x) => x.out).map((x) => `## ${x.name}\n${x.out}`).join('\n\n');
            // With no proposal the elder decides from the situation alone.
            return { ...writer(planCall), task: sections ? fill(tpl('aggregate'), { task: situation, results: sections }) : situation };
          }
          case 'plan':
          case 'proposal':
            return { ...writer(planCall), task: input };
          case 'doer':
            return { ...writer(planCall, t('rt.group.chainDoer', vars)), task: chain() };
          case 'judge': {
            const judged = nth(`judge:${m.id}`);
            const verdict = this.stopTool<{ pass?: unknown; feedback?: unknown }>('verdetto', t('rt.group.verdictTool'), VERDICT, (a) => (typeof a.pass === 'boolean'
              ? { content: t('rt.committee.ballot.recorded'), data: { pass: a.pass, feedback: String(a.feedback ?? '') } }
              : { error: t('rt.group.verdictTool') }));
            return {
              system: system(false), task: fill(tpl('evaluate'), { task: situation, candidate: input }), tools: [verdict],
              revise: (candidate, feedback) => fill(tpl('revise'), { task: situation, candidate, feedback }),
              mock: slow(() => ({ toolCalls: [{ name: 'verdetto', args: judged === 0 && roster.maxRounds > 1 ? { pass: false, feedback: t('rt.mock.judgeFix') } : { pass: true, feedback: t('rt.mock.judgeOk') } }] })),
            };
          }
          case 'route': {
            const candidates = people(roster.candidates);
            const route = this.stopTool<{ route?: unknown }>('instrada', t('rt.group.routeTool'), ROUTE, (a) => {
              const to = memberRef(a.route, candidates);
              return to ? { content: t('rt.group.routed', { name: to.name }), data: memberId(to.id, 'write_member') } : { error: t('rt.group.noMember', { members: candidates.map((x) => `${x.name} (${x.id})`).join(', ') }) };
            });
            const routes = candidates.map((x) => t('rt.group.route', { name: x.name, role: this.host.roleTitle(x.role), description: this.host.roleOf(x.role)?.description ?? '' })).join('\n');
            const pick = () => {
              const hungry = members.some((x) => x.hunger >= this.host.world().r('critical_hunger'));
              const want = hungry ? 'gather' : this.host.world().isNight() ? 'build' : 'explore';
              return candidates.find((x) => hasHabit(this.cfg.mock.habits, x.role, want)) ?? candidates[candidates.length - 1]!;
            };
            return {
              system: system(false), task: fill(tpl('route'), { routes, task: situation }), tools: [route],
              mock: slow(() => ({ toolCalls: [{ name: 'instrada', args: { route: pick().id, reason: t('rt.mock.routeReason', { name: pick().name }) } }] })),
            };
          }
          case 'vote': {
            const k = Math.max(0, (roster.voting ?? []).indexOf(m.id));
            const n = Math.max(1, Math.min(2, (roster.voting ?? []).length));
            return {
              system: system(false), task: [t('rt.group.vote', { group: g.name, proposals: input, name: m.name, id: m.id }), t('rt.group.voteFormat')].join('\n'), tools: [],
              mock: slow(() => ({ text: JSON.stringify({ choice: 1 + ((k + this.host.world().day) % n), reason: t('rt.mock.voteReason') }) })),
            };
          }
        }
      },
    };
    return run;
  }

  /** The supervisor's way to ask a worker: ends the supervisor's turn with the worker's member id and the task. */
  private delegateTool(workers: RtEntity[], situation: string): Tool {
    const t = this.t;
    return this.stopTool<{ member?: unknown; task?: unknown }>(
      'delega', `${t('rt.group.delegateTool')}\n${workers.map((w) => t('rt.group.workerTool', { name: `${w.name} (${w.id})`, role: this.host.roleTitle(w.role) })).join('\n')}`,
      DELEGATE,
      (a) => {
        const w = memberRef(a.member, workers);
        if (!w) return { error: t('rt.group.noMember', { members: workers.map((x) => `${x.name} (${x.id})`).join(', ') }) };
        return { content: t('rt.group.delegated', { name: w.name }), data: { member: memberId(w.id, 'propose'), input: String(a.task ?? '').trim() || situation } };
      },
    );
  }

  /** Labels of the ballot and chair tools (i18n). */
  private ballotLabels(): BallotLabels {
    const t = this.t;
    return {
      criteria: t('rt.committee.ballot.criteria'), criterion: (c) => c.text, met: t('rt.committee.ballot.met'), note: t('rt.committee.ballot.note'),
      vote: t('rt.committee.ballot.vote'), reason: t('rt.committee.ballot.reason'), outOfPolicy: t('rt.committee.ballot.outOfPolicy'),
      unmet: t('rt.committee.ballot.unmet'), summary: t('rt.committee.ballot.summary'),
    };
  }

  /** Why a ballot or a chair's decision cannot be recorded (a fact about the policy). */
  private ballotError(err: BallotError, criteria: Criterion[]): string {
    const t = this.t;
    const all = criteria.map((c) => c.key).join(', ');
    if (err.error === 'missing') return t('rt.committee.ballot.missing', { criteria: err.missing.join(', ') });
    if (err.error === 'unknown') return t('rt.committee.ballot.unknown', { names: err.unknown.join(', '), criteria: all });
    if (err.error === 'need_unmet') return t('rt.committee.ballot.needUnmet', { criteria: all });
    return t('rt.committee.ballot.badVote');
  }

  /** A tool whose valid call ends the run with its data; an invalid one says why (the run may try again). */
  private recordTool<T>(name: string, description: string, schema: Record<string, unknown>, check: (args: Record<string, unknown>) => T | BallotError, criteria: Criterion[]): Tool {
    return tool<Record<string, unknown>>(name, description, schema, (args) => {
      const out = check(args ?? {});
      if (out && typeof out === 'object' && 'error' in out) return { content: this.ballotError(out as BallotError, criteria), isError: true };
      return { content: this.t('rt.committee.ballot.recorded'), stop: true, data: out };
    });
  }

  /**
   * The committee decides on one submitted idea (`brief`: the idea, its reviews, the company's facts and the committee's
   * policy). Every seated member votes, up to `ideas.committee.maxVoters` (0: all), on the members' tier; in an assembly
   * the esteem-weighted plurality decides, otherwise the chair (the leader, own model) decides after reading the votes.
   * With policy criteria (`policy.criteria`), ballots and the chair's decision are tool calls checked against them
   * (committee.ts); without, they are structured outputs.
   * `seated`: who sits in this session, chair first (the host leaves out members with a conflict of interest);
   * default every living member, the leader first.
   */
  async reviewIdea(g: Group, brief: string, mock: CommitteeMock, seated?: RtEntity[], policy?: CommitteePolicy): Promise<CommitteeOutcome | Failure> {
    const members = seated ?? this.livingMembers(g);
    if (!members.length) return { error: 'no living members' };
    const t = this.t;
    const signal = AbortSignal.timeout(decisionTimeoutMs(this.cfg, this.host.world()));
    const sinks = this.host.runSinks();
    const cc = this.cfg.ideas.committee;
    const voting = this.consulted(members, cc.maxVoters ?? 0);
    const criteria = policy?.criteria ?? [];
    const withCriteria = criteria.length > 0;
    const max = this.cfg.groups.traceMaxChars;
    const limits = { maxChars: max, demandsMax: cc.demandsMax ?? 4 };
    const labels = this.ballotLabels();
    let costUsd = 0;
    const run = async (who: RtEntity, a: EasyAgent, task: string, role: TraceRole) => {
      const res = await a.run(task, { sinks, signal });
      costUsd += res.costUsd ?? 0;
      const model = this.models.get(a.name) ?? who.model;
      this.host.ranModel({ id: model === who.model ? `${g.id}/${who.id}` : `${g.id}/${who.id}:${model}`, name: `${g.name}/${who.name}`, model, tier: `group:${g.pattern}` }, res);
      return { res, role };
    };
    const mockBallot = (m: RtEntity) => {
      const v = mock.vote(m);
      const first = criteria[0]?.key;
      return { criteri: Object.fromEntries(criteria.map((c) => [c.key, { soddisfatto: v.vote === 'approve' || c.key !== first, nota: v.reason }])), voto: v.vote, motivo: v.reason };
    };
    const ballots = await Promise.all(voting.map((m) => {
      const voter = withCriteria
        ? this.member(m, g, 'voter', {
          only: [this.recordTool('vota_idea', t('rt.committee.ballot.tool'), ballotSchema(criteria, labels), (a) => checkBallot(a, criteria, limits), criteria)],
          turns: cc.ballotMaxTurns ?? 3,
          mock: () => ({ toolCalls: [{ name: 'vota_idea', args: mockBallot(m) }] }),
        })
        : this.member(m, g, 'voter', { structured: true, output: IDEA_BALLOT, mock: () => ({ text: JSON.stringify(mock.vote(m)) }) });
      return run(m, voter, t(withCriteria ? 'rt.committee.voteTaskCriteria' : 'rt.committee.voteTask', { brief, name: m.name, id: m.id, group: g.name }), 'voter');
    }));
    const votes: CommitteeVote[] = [];
    ballots.forEach(({ res }, k) => {
      const m = voting[k]!;
      const ok = res.status === 'completed' || res.status === 'stopped';
      if (withCriteria) {
        const b = ok ? (res.data as Ballot | undefined) : undefined;
        if (!b?.vote) return;
        votes.push({ member: m.id, name: m.name, vote: b.vote, reason: b.reason, criteria: b.criteria, unmet: b.unmet, outOfPolicy: b.outOfPolicy });
        this.host.deliberated(g, m.id, 'voter', `${b.vote}: ${b.reason}`.slice(0, max));
        return;
      }
      const d = res.status === 'completed' ? (res.data as { vote?: unknown; reason?: unknown } | undefined) : undefined;
      const vote = asDecision(d?.vote);
      if (!vote) return;
      const reason = String(d?.reason ?? '').slice(0, max);
      votes.push({ member: m.id, name: m.name, vote, reason });
      this.host.deliberated(g, m.id, 'voter', `${vote}: ${reason}`);
    });
    const named = (v: CommitteeVote) => v.name ?? members.find((m) => m.id === v.member)?.name ?? v.member;
    const union = (xs: Array<string[] | undefined>) => [...new Set(xs.flatMap((x) => x ?? []))];
    if (g.pattern === 'assembly') {
      if (!votes.length) return { error: 'no valid vote' };
      const weighted = weightedWinner(votes.map((v) => DECISIONS.indexOf(v.vote)), votes.map((v) => this.host.voteWeight(v.member)), DECISIONS.length);
      const decision = DECISIONS[weighted.winner] ?? 'defer';
      const side = votes.filter((v) => v.vote === decision);
      const summary = side.map((v) => `${named(v)}: ${v.reason}`).join(' ').slice(0, this.cfg.decisions.textMaxChars);
      console.log(`[committee ${g.name}] assembly: ${decision} (${votes.length} vote(s)), estimated cost $${costUsd.toFixed(4)}`);
      return { decision, summary, votes, ...(withCriteria ? { unmet: decision === 'approve' ? [] : union(side.map((v) => v.unmet)), outOfPolicy: union(votes.map((v) => v.outOfPolicy)) } : {}) };
    }
    const chair = members[0]!;
    const none = t('rt.committee.none');
    const lines = votes.length
      ? votes.map((v) => (withCriteria
        ? t('rt.committee.voteLineCriteria', { name: named(v), vote: t(`rt.committee.vote.${v.vote}`), reason: v.reason, unmet: v.unmet?.join(', ') || none, extra: v.outOfPolicy?.join('; ') || none })
        : t('rt.committee.voteLine', { name: named(v), vote: t(`rt.committee.vote.${v.vote}`), reason: v.reason }))).join('\n')
      : t('rt.committee.noVotes');
    const task = t(withCriteria ? 'rt.committee.chairTaskCriteria' : 'rt.committee.chairTask', { brief, votes: lines, name: chair.name, id: chair.id, group: g.name });
    if (withCriteria) {
      const mockChair = () => {
        const c = mock.chair(votes);
        const unmet = c.decision === 'approve' ? [] : union(votes.map((v) => v.unmet));
        return { decisione: c.decision, criteri_non_soddisfatti: unmet.length || c.decision === 'approve' ? unmet : criteria.slice(0, 1).map((x) => x.key), sintesi: c.summary };
      };
      const judge = this.member(chair, g, 'leader', {
        deciding: true, turns: cc.ballotMaxTurns ?? 3,
        only: [this.recordTool('decidi_idea', t('rt.committee.ballot.chairTool'), chairSchema(criteria, labels), (a) => checkChair(a, criteria, { ...limits, maxChars: this.cfg.decisions.textMaxChars }), criteria)],
        mock: () => ({ toolCalls: [{ name: 'decidi_idea', args: mockChair() }] }),
      });
      const { res } = await run(chair, judge, task, 'leader');
      const d = res.status === 'completed' || res.status === 'stopped' ? (res.data as ChairDecision | undefined) : undefined;
      if (!d?.decision) return { error: `chair ${chair.name}: ${res.status}${res.reason ? ` (${res.reason})` : ''}` };
      this.host.deliberated(g, chair.id, 'leader', `${d.decision}: ${d.summary}`.slice(0, max));
      console.log(`[committee ${g.name}] ${g.pattern}: ${d.decision} (${votes.length} vote(s)), estimated cost $${costUsd.toFixed(4)}`);
      return { decision: d.decision, summary: d.summary, votes, unmet: d.unmet, outOfPolicy: union([d.outOfPolicy, ...votes.map((v) => v.outOfPolicy)]) };
    }
    const judge = this.member(chair, g, 'leader', { structured: true, deciding: true, output: IDEA_VERDICT, mock: () => ({ text: JSON.stringify(mock.chair(votes)) }) });
    const { res } = await run(chair, judge, task, 'leader');
    const d = res.status === 'completed' ? (res.data as { decision?: unknown; summary?: unknown } | undefined) : undefined;
    const decision = asDecision(d?.decision);
    if (!decision) return { error: `chair ${chair.name}: ${res.status}${res.reason ? ` (${res.reason})` : ''}` };
    const summary = String(d?.summary ?? '').slice(0, this.cfg.decisions.textMaxChars);
    this.host.deliberated(g, chair.id, 'leader', `${decision}: ${summary}`.slice(0, max));
    console.log(`[committee ${g.name}] ${g.pattern}: ${decision} (${votes.length} vote(s)), estimated cost $${costUsd.toFixed(4)}`);
    return { decision, summary, votes };
  }

  /** Runs the group's pattern and returns the joint plan with the trace of how it was decided (or why there is none). */
  async decide(g: Group, why: string): Promise<JointPlan | Failure> {
    const members = this.livingMembers(g);
    if (!members.length) return { error: 'no living members' };
    const hub = stackHub(this.host);
    const w = this.host.world();
    const trace: TraceEntry[] = [];
    const roster = this.rosterFor(g, members);
    const situation = this.situation(g, members, why, g.pattern === 'crowd');
    const lead = members[0]!;
    const sessionId = `${g.id}:${w.day}:${w.minute}:${this.boot}${(this.runSeq++).toString(36)}`;
    const signal = AbortSignal.timeout(decisionTimeoutMs(this.cfg, w));
    const run = this.groupRun(g, members, roster, situation, trace);
    const closeRun = hub.runs.open(sessionId, run);
    let status: string = 'completed';
    let output = '';
    let problems: string[] = [];
    let hops = 1;
    try {
      if (g.pattern === 'crowd') {
        // One call plans for many extras: no system, the leader's stack writes.
        const c = this.counts(members);
        const planCall = () => this.mockPlanCall(members);
        const ps = await hub.stackFor(lead);
        const res = await ps.run('write', {
          messages: [
            { role: 'system', parts: [{ type: 'text', text: [this.t('rt.group.crowdHeader', { horizon: Math.round(c.horizon) }), this.formatText(members)].join('\n') }] },
            { role: 'user', parts: [{ type: 'text', text: situation }] },
          ],
        } as never, {
          sessionId, signal, tools: [this.planTool(c.max)],
          mock: (req, i) => ({ delayMs: this.cfg.mock.thinkDelayMs / Math.max(1, w.timeScale), ...planCall() }),
        });
        status = res.run.status;
        if (res.plan) {
          output = JSON.stringify(res.plan);
          run.said(g.id, 'leader', res.plan.summary);
        } else problems = [`${res.run.status}${res.run.reason ? ` (${res.run.reason.code})` : ''}`];
      } else {
        const system = await hub.systemFor(g, members, g.pattern, roster);
        const res = await system.run(situation, { runId: sessionId, sessionId, signal });
        status = res.status;
        output = res.output;
        hops = Math.max(1, res.record.length);
        problems = res.record.filter((h) => h.status !== 'completed').map((h) => `${h.member}: ${h.status}${h.reason ? ` (${h.reason.code})` : ''}`);
        if (res.status !== 'completed' && res.reason) problems.unshift(`${res.reason.code}${res.reason.by ? ` by ${res.reason.by}` : ''}`);
      }
    } catch (err) {
      status = 'failed';
      problems = [err instanceof Error ? err.message : String(err)];
    } finally {
      closeRun();
    }
    console.log(`[group ${g.name}] ${g.pattern} decision: ${status}, ${hops} hop(s)`);
    // The plan the system ended with, else (a loop that gave up, a failed revision) the last plan a keeping seat committed.
    const ended = status === 'completed' || status === 'stopped';
    const parsed = ended ? jsonOf(output) : undefined;
    const json = planOf({ status: 'completed', data: parsed }) ?? run.lastPlan;
    if (!json) {
      return { error: `${g.pattern} ${status}: ${problems.length ? `<- ${problems.slice(0, 4).join('; ')}` : 'no joint plan committed'}` };
    }
    if (problems.length) console.warn(`[group ${g.name}] ${g.pattern} decided despite: ${problems.slice(0, 4).join('; ')}`);
    const c = this.counts(members);
    // Steps without a valid `who` belong to whoever wrote the plan (or, unknown, to the lead).
    const { steps, dropped } = repairSteps(Array.isArray(json.steps) ? json.steps : [], members, json.author ?? lead.id, this.cfg.decisions.textMaxChars, c.max);
    if (dropped.length) console.warn(`[group ${g.name}] dropped ${dropped.length} step(s) of the joint plan: ${dropped.slice(0, 4).join('; ')}`);
    if (!steps.length) return { error: `${g.pattern}: the joint plan has no valid step` };
    const summary = String(json.summary ?? '').slice(0, this.cfg.decisions.textMaxChars) || steps[0]!.label;
    return { summary, steps, trace };
  }

  /** What a trace line shows: the gist of a member's output. */
  private traceText(out: string, members: RtEntity[]): string {
    const t = this.t;
    const j = jsonOf(out);
    if (!j) return out.trim();
    if (typeof j.route === 'string') {
      const id = j.route.split(SEP)[0];
      const name = members.find((m) => m.id === id)?.name ?? id;
      return `→ ${name}${j.reason ? `: ${String(j.reason)}` : ''}`;
    }
    if (j.choice !== undefined) return `#${String(j.choice)}${j.reason ? `: ${String(j.reason)}` : ''}`;
    if (typeof j.pass === 'boolean') return `${j.pass ? '✓' : '✗'} ${String(j.feedback ?? '')}`.trim();
    if (typeof j.summary === 'string') return j.summary;
    return t('rt.observation.none');
  }
}
