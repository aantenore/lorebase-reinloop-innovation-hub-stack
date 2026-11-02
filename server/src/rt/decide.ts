// One person's decisions through the agent stack of the hub (see stack/index.ts): a PLAN run (tools commit_plan,
// say, form_group, join_group, leave_group; the run ends as soon as a plan is committed) and a quick REPLY run when
// spoken to (streamed text, optional `rethink`). Each person has its own stack and model; the offline model
// (`hub-mock`) plays the scripts below.
import { resolve } from 'node:path';
import type { CallPart, Message as StackMessage, RunInput, RunResult as StackRunResult } from '@agent-layers/core';
import { type Message, type MockTurn, mockProvider, type ModelRef, type ModelRequest, type RunResult, type Sink, type Tool, tool } from 'reinloop';
import { ROOT, type SimConfig } from '../config.ts';
import type { Translate } from '../i18n.ts';
import type { Role, RuleChange } from '../lorebase/rules.ts';
import type { Brain, ConsultEvent } from './brain.ts';
import { type Capacity, type CapResult, StackFeed, StackHub } from '../stack/index.ts';
import type { Tier } from '../world/types.ts';
import { AGENT_PATTERNS, cacheParams, type GameConfig, type TierDecision } from './config.ts';
import type { PlanData } from './groups.ts';
import { flatSteps, mockSteps, needsOf } from './mock.ts';
import { SIGNAL_TOOL } from './evidence.ts';
import { mockSignalUrl } from './signals.ts';
import type { TokenUsage } from './observatory.ts';
import { MODEL_ACTIONS, normalizeStep, type PlanStep } from './plan.ts';
import {
  doingLine, type GroupView, groupLine, inboxBlock, look, memoryBlock, type PromptLimits, recalledBlock, rtInstructions, rtObservation, selfLine, timeLine,
} from './prompt.ts';
import type { ActResult, RtEntity, RtWorld } from './world.ts';

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export interface DecideHost {
  world(): RtWorld;
  t: Translate;
  cfg: GameConfig;
  sim: SimConfig;
  mock: boolean;
  brain: Brain;
  roleOf(code: string): Role | undefined;
  roleTitle(code: string): string;
  groups(): GroupView[];
  /** Laws changed since this person last decided (and marks them as seen). */
  changedLaws(e: RtEntity): RuleChange[];
  say(e: RtEntity, to: string, text: string): ActResult;
  formGroup(e: RtEntity, name: string, pattern: string): ToolOutcome;
  joinGroup(e: RtEntity, name: string): ToolOutcome;
  leaveGroup(e: RtEntity): ToolOutcome;
  shareInsight(e: RtEntity, text: string, confidence: number, evidence: string): Promise<ToolOutcome>;
  reviewInsights(e: RtEntity): string;
  judgeInsight(e: RtEntity, code: string, verdict: 'approve' | 'reject', reason: string): Promise<ToolOutcome>;
  /** A group member said something while the group deliberated (reinloop pattern trace). */
  deliberated(g: { id: string; pattern: string }, memberId: string, role: string, text: string): void;
  /** Sinks every model run reports to (run logs kept in mnemo). */
  runSinks(): Sink[];
  /** The agent stacks of the world's people; when absent a hub of its own is built on first use (see `stackHub`). */
  stacks?: StackHub;
  /** A plan run needed its closing run (counted); `committed`: it ended with a plan. */
  closed?(e: RtEntity, committed: boolean): void;
  /** A model run ended (usage and cost per agent, for the Observatory). */
  ranModel(who: { id: string; name: string; model: string; tier: string }, res: { status: string; usage?: TokenUsage; costUsd?: number }): void;
  /** A person consulted Lorebase (shown to clients). */
  consulted(e: RtEntity, ev: ConsultEvent): void;
  /** The model's reasoning summary behind a decision (privileged clients only). */
  reasoned(e: RtEntity, text: string): void;
  /** What the person's private memory brings back for `query` (formatted lines; empty when none or unavailable). */
  recall(e: RtEntity, query: string): Promise<string[]>;
  /** Barter: propose an exchange, answer one addressed to you. */
  offer(e: RtEntity, to: string, give: unknown, want: unknown): ToolOutcome;
  answerOffer(e: RtEntity, id: string, accept: boolean): ToolOutcome;
  /** Ask for something without offering anything (answered like an offer). */
  ask(e: RtEntity, to: string, item: string, amount: number): ToolOutcome;
  /** A witness's account of a social law kept or broken by someone. */
  testify(e: RtEntity, input: { chi?: unknown; legge?: unknown; rispettata?: unknown; motivo?: unknown }): ToolOutcome;
  /** An opinion about someone (kept in the judge's private memory and in the society). */
  judge(e: RtEntity, who: string, score: number, reason: string): ToolOutcome;
  /** A law proposal (a Lorebase Proposal reviewed by humans). */
  proposeLaw(e: RtEntity, input: { key?: unknown; text?: unknown; category?: unknown; value?: unknown }): Promise<ToolOutcome>;
  /** Weight of a person's vote and claim to lead a group (from esteem). */
  voteWeight(id: string): number;
  /** Society in perception: what is said about a person, offers, hearsay (factual lines, no numbers). */
  perceived: PerceivedSociety;
  /** Ideas: propose, enrich, review, submit to the committee, read one in full. */
  ideas: IdeaDesk;
  /** Web research (web_search, web_fetch) under the company policies; undefined when off. */
  research?: { tools(who: { id: string; name: string }, budget?: { left: number }): Tool[] };
  /** Public signals, evidence and simulated interviews (searches share the decision's web budget); undefined when off. */
  evidence?: { tools(who: { id: string; name: string }, budget?: { left: number }): Tool[] };
}

/** What a person can do with ideas (tools); results are factual lines. */
export interface IdeaDesk {
  propose(e: RtEntity, input: Record<string, unknown>): Promise<ToolOutcome>;
  enrich(e: RtEntity, input: Record<string, unknown>): ToolOutcome;
  review(e: RtEntity, input: Record<string, unknown>): ToolOutcome;
  submit(e: RtEntity, code: string): Promise<ToolOutcome>;
  read(e: RtEntity, code: string): string;
  /** The ideas as the mock sees them (offline stand-in only). */
  briefs(e: RtEntity): IdeaBrief[];
}

export interface IdeaBrief {
  code: string;
  title: string;
  stage: string;
  mine: boolean;
  reviewedByMe: boolean;
  reviews: number;
  minReviewers: number;
  missing: string[];
  openByMe: number;
  maxOpen: number;
  /** Pieces of evidence attached, and whether the candidacy requirements are met. */
  evidence: number;
  gatePass: boolean;
}

export interface PerceivedSociety {
  /** What `e` has heard of `b` (empty when nothing). */
  about(e: RtEntity, b: RtEntity): string;
  /** Extra observation blocks for `e` (age, offers, hearsay). */
  blocks(e: RtEntity): string[];
  /** Pending offers addressed to `e` (ids), for the mock. */
  offersFor(e: RtEntity): Array<{ id: string; want: Record<string, number> }>;
}

/** Why a decision produced nothing (logged and counted by the caller). */
export interface Failure {
  error: string;
}

export const isFailure = (v: unknown): v is Failure => !!v && typeof v === 'object' && typeof (v as Failure).error === 'string';

/** Lorebase read tools (bounded per decision) and the private memory of one person. */
export function faculties(host: DecideHost, e: RtEntity, tc: Pick<TierDecision, 'maxConsults' | 'maxWebCalls'>): Tool[] {
  const web = tc.maxWebCalls === undefined ? undefined : { left: tc.maxWebCalls };
  return [
    ...host.brain.lorebaseTools({ left: tc.maxConsults, onConsult: (ev) => host.consulted(e, ev) }),
    ...host.brain.memoryTools(e.name, () => ({ day: host.world().day, minute: host.world().minute }), host.cfg.memory.ingest.remember ?? { importance: 0.5, emotion: 0 }),
    // Web calls of one decision are bounded (tier `maxWebCalls`) so the run keeps turns to commit its plan.
    ...(host.research?.tools(e, web) ?? []),
    ...(host.evidence?.tools(e, web) ?? []),
  ];
}

export interface Decision {
  steps: PlanStep[];
  reason: string;
}

/** Tier used for decisions: players never decide here; crowd extras use the crowd tier. */
export function decisionTier(e: RtEntity, cfg: GameConfig): Tier {
  return e.tier === 'human' ? cfg.crowd.tier : e.tier;
}

export function tierConfig(e: RtEntity, cfg: GameConfig): TierDecision {
  return cfg.decisions.tiers[decisionTier(e, cfg)];
}

/** Real milliseconds per game minute at the current time scale (rule game_minutes_per_real_second). */
export function realMsPerGameMinute(w: Pick<RtWorld, 'r' | 'timeScale'>): number {
  return 1000 / Math.max(1e-6, w.r('game_minutes_per_real_second') * w.timeScale);
}

/**
 * How long a decision may take: `decisions.timeoutGameMinutes` of game time, in real time between
 * `timeoutMinMs` (a model call needs that long whatever the time scale) and `timeoutMs`.
 */
export function decisionTimeoutMs(cfg: GameConfig, w: Pick<RtWorld, 'r' | 'timeScale'>): number {
  const d = cfg.decisions;
  const game = d.timeoutGameMinutes * realMsPerGameMinute(w);
  return Math.round(Math.min(d.timeoutMs, Math.max(d.timeoutMinMs, game)));
}

export function limitsOf(cfg: GameConfig): PromptLimits {
  return { lookMaxTiles: cfg.decisions.lookMaxTiles, lookMaxPeople: cfg.decisions.lookMaxPeople, nearbyGroupsMax: cfg.decisions.nearbyGroupsMax, ...cfg.decisions.perception };
}

/**
 * Model reference for tool-internal calls that stay on reinloop (interviews, group members until their systems move):
 * its own model, or a scripted mock when offline. The mock's delay is in
 * game time (divided by the time scale), so a sped-up world does not leave people idle while it "thinks".
 */
export function modelRef(host: Pick<DecideHost, 'mock' | 'world'>, model: string, script: (req: ModelRequest, i: number) => MockTurn, delayMs: number): string | ModelRef {
  if (host.mock) {
    return { provider: mockProvider([(req, i) => ({ delayMs: delayMs / Math.max(1, host.world().timeScale), ...script(req, i) })], { loop: true, name: 'mock' }), model: `mock/${model}` };
  }
  // `anthropic/<model>` resolves through reinloop's preset (ANTHROPIC_WORKSPACE_ID becomes the workspace header).
  return model;
}

/** JSON Schema of the commit_plan tool. The step count is a suggestion (`maxSteps` only caps what is kept). */
export function planSchema(t: Translate, textMax: number, withWho = false, maxSteps?: number): Record<string, unknown> {
  const step: Record<string, unknown> = {
    type: 'object',
    properties: {
      ...(withWho ? { who: { type: 'string' } } : {}),
      action: { enum: [...MODEL_ACTIONS] },
      x: { type: 'integer' },
      y: { type: 'integer' },
      to: { type: 'string' },
      resource: { type: 'string', description: t('rt.tools.stepResource') },
      item: { type: 'string', description: t('rt.tools.stepItem') },
      items: { type: 'array', items: { type: 'string' }, description: t('rt.tools.stepItems') },
      recipe: { type: 'string', description: t('rt.tools.stepRecipe') },
      give: { type: 'object', additionalProperties: { type: 'integer' }, description: t('rt.tools.offerGive') },
      want: { type: 'object', additionalProperties: { type: 'integer' }, description: t('rt.tools.offerWant') },
      amount: { type: 'integer' },
      text: { type: 'string', maxLength: textMax },
      minutes: { type: 'number' },
      label: { type: 'string', description: t('rt.tools.stepLabel') },
    },
    required: ['action', 'label'],
  };
  return {
    type: 'object',
    properties: {
      reason: { type: 'string', description: t('rt.tools.planReason') },
      steps: { type: 'array', items: step, description: maxSteps ? t('rt.tools.planStepsUpTo', { maxSteps }) : t('rt.tools.planSteps') },
    },
    required: ['reason', 'steps'],
  };
}

export function normalizeSteps(raw: unknown, textMax: number, max: number): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => normalizeStep(s, textMax)).filter((s): s is PlanStep => !!s).slice(0, max);
}

/** Tools on ideas (individual decisions and group members who propose or write plans). */
export function ideaTools(host: Pick<DecideHost, 't' | 'ideas'>, e: RtEntity): Tool[] {
  const t = host.t;
  const field = (k: string) => ({ type: 'string', description: t(`rt.tools.idea.${k}`) });
  const fields = {
    title: field('title'), problem: field('problem'), users: field('users'), solution: field('solution'), differentiation: field('differentiation'),
    feasibility: field('feasibility'), risks: field('risks'),
    tags: { type: 'array', items: { type: 'string' }, description: t('rt.tools.idea.tags') },
    signals: { type: 'array', items: { type: 'string' }, description: t('rt.tools.idea.signals') },
    sources: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
      description: t('rt.tools.idea.sources'),
    },
  };
  const score = (k: string) => ({ type: 'integer', minimum: 0, maximum: 10, description: t(`rt.tools.idea.score.${k}`) });
  const out = (o: ToolOutcome) => ({ content: o.text, isError: !o.ok });
  return [
    tool<Record<string, unknown>>('proponi_idea', t('rt.tools.idea.propose'), {
      type: 'object', properties: fields, required: ['title', 'problem'],
    }, async (args) => out(await host.ideas.propose(e, args ?? {}))),
    tool<Record<string, unknown>>('arricchisci_idea', t('rt.tools.idea.enrich'), {
      type: 'object', properties: { code: { type: 'string', description: t('rt.tools.idea.code') }, ...fields }, required: ['code'],
    }, (args) => out(host.ideas.enrich(e, args ?? {}))),
    tool<Record<string, unknown>>('valuta_idea', t('rt.tools.idea.review'), {
      type: 'object',
      properties: {
        code: { type: 'string', description: t('rt.tools.idea.code') }, impact: score('impact'), feasibility: score('feasibility'), novelty: score('novelty'), fit: score('fit'),
        risk: score('risk'), comment: { type: 'string', description: t('rt.tools.idea.comment') },
      },
      required: ['code', 'impact', 'feasibility', 'novelty', 'fit', 'risk', 'comment'],
    }, (args) => out(host.ideas.review(e, args ?? {}))),
    tool<{ code: string }>('candida_al_comitato', t('rt.tools.idea.submit'), { code: `string: ${t('rt.tools.idea.code')}` }, async ({ code }) => out(await host.ideas.submit(e, String(code ?? '')))),
    tool<{ code: string }>('leggi_idea', t('rt.tools.idea.read'), { code: `string: ${t('rt.tools.idea.code')}` }, ({ code }) => host.ideas.read(e, String(code ?? '')), { risk: 'read' }),
  ];
}

/** Social, idea and insight tools of a person. */
export function socialTools(host: DecideHost, e: RtEntity): Tool[] {
  const t = host.t;
  const max = host.cfg.decisions.textMaxChars;
  return [
    tool<{ to: string; text: string }>('say', t('rt.tools.say'), { to: `string: ${t('rt.tools.sayTo')}`, text: `string: ${t('rt.tools.sayText')}` }, ({ to, text }) => {
      const out = host.say(e, String(to ?? 'all'), String(text ?? '').slice(0, max));
      return out.ok ? t('rt.act.said', { text: String(text).slice(0, max) }) : { content: t(`rt.reason.${out.reason ?? 'failed'}`), isError: true };
    }),
    tool<{ name: string; pattern: string }>('form_group', t('rt.tools.formGroup'), { name: `string: ${t('rt.tools.groupName')}`, pattern: AGENT_PATTERNS }, ({ name, pattern }) => {
      const out = host.formGroup(e, String(name ?? ''), String(pattern ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ name: string }>('join_group', t('rt.tools.joinGroup'), { name: `string: ${t('rt.tools.groupName')}` }, ({ name }) => {
      const out = host.joinGroup(e, String(name ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool('leave_group', t('rt.tools.leaveGroup'), {}, () => {
      const out = host.leaveGroup(e);
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ text: string; confidence: number; evidence?: string }>('share_insight', t('rt.tools.shareInsight'), {
      text: `string: ${t('rt.tools.insightText')}`, confidence: `number: ${t('rt.tools.insightConfidence')}`, evidence: `string?: ${t('rt.tools.insightEvidence')}`,
    }, async ({ text, confidence, evidence }) => {
      const out = await host.shareInsight(e, String(text ?? ''), Number(confidence), String(evidence ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ to: string; give: unknown; want: unknown }>('scambia', t('rt.tools.offer'), {
      to: `string: ${t('rt.tools.offerTo')}`,
      give: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: t('rt.tools.offerGive') },
      want: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: t('rt.tools.offerWant') },
    }, ({ to, give, want }) => {
      const out = host.offer(e, String(to ?? ''), give, want);
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ a: string; item: string; amount: number }>('chiedi', t('rt.tools.ask'), {
      a: `string: ${t('rt.tools.offerTo')}`, item: `string: ${t('rt.tools.askItem')}`, amount: `integer: ${t('rt.tools.askAmount')}`,
    }, ({ a, item, amount }) => {
      const out = host.ask(e, String(a ?? ''), String(item ?? ''), Number(amount ?? 1));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ offer: string; accept: boolean }>('rispondi_scambio', t('rt.tools.answerOffer'), {
      offer: `string: ${t('rt.tools.offerId')}`, accept: `boolean: ${t('rt.tools.offerAccept')}`,
    }, ({ offer, accept }) => {
      const out = host.answerOffer(e, String(offer ?? ''), accept === true || String(accept) === 'true');
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ chi: string; voto: number; motivo: string }>('giudica', t('rt.tools.judge'), {
      chi: `string: ${t('rt.tools.judgeWho')}`, voto: `number: ${t('rt.tools.judgeScore')}`, motivo: `string: ${t('rt.tools.judgeReason')}`,
    }, ({ chi, voto, motivo }) => {
      const out = host.judge(e, String(chi ?? ''), Number(voto), String(motivo ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ chi: string; legge: string; rispettata: boolean; motivo: string }>('testimonia', t('rt.tools.testify'), {
      chi: `string: ${t('rt.tools.judgeWho')}`, legge: `string: ${t('rt.tools.testifyLaw')}`, rispettata: `boolean: ${t('rt.tools.testifyKept')}`, motivo: `string: ${t('rt.tools.judgeReason')}`,
    }, (args) => {
      const out = host.testify(e, args ?? {});
      return { content: out.text, isError: !out.ok };
    }),
    tool<{ key?: string; text: string; category: string; value?: number }>('proponi_legge', t('rt.tools.proposeLaw'), {
      key: `string?: ${t('rt.tools.lawKey')}`, text: `string: ${t('rt.tools.lawText')}`, category: host.sim.lorebase.ruleCategories, value: `number?: ${t('rt.tools.lawValue')}`,
    }, async (args) => {
      const out = await host.proposeLaw(e, args ?? {});
      return { content: out.text, isError: !out.ok };
    }),
    ...ideaTools(host, e),
    tool('review_insights', t('rt.tools.reviewInsights'), {}, () => host.reviewInsights(e), { risk: 'read' }),
    tool<{ code: string; verdict: 'approve' | 'reject'; reason: string }>('judge_insight', t('rt.tools.judgeInsight'), {
      code: `string: ${t('rt.tools.insightCode')}`, verdict: ['approve', 'reject'], reason: `string: ${t('rt.tools.insightReason')}`,
    }, async ({ code, verdict, reason }) => {
      const out = await host.judgeInsight(e, String(code ?? ''), verdict === 'approve' ? 'approve' : 'reject', String(reason ?? ''));
      return { content: out.text, isError: !out.ok };
    }),
  ];
}

/** Mock decision: sometimes a Lorebase consultation first, then social moves and a plan. */
function mockDecision(host: DecideHost, e: RtEntity, tc: TierDecision, req: ModelRequest): MockTurn {
  const consulted = req.messages.some((m) => m.role === 'tool');
  const seed = [...`${e.id}${host.world().minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  if (!consulted && host.brain.connected && tc.maxConsults > 0 && seed % 3 === 0) {
    return { toolCalls: [{ name: 'lorebase_search', args: { query: host.t('rt.mock.consult'), kinds: ['Rule'], limit: 3 } }] };
  }
  return mockPlanTurn(host, e, tc);
}

function mockPlanTurn(host: DecideHost, e: RtEntity, tc: TierDecision): MockTurn {
  const t = host.t;
  const w = host.world();
  const calls: Array<{ name: string; args: unknown }> = [];
  const groups = host.groups();
  if (!e.groupId && e.kind === 'agent') {
    const invite = groups.find((g) => g.pattern !== 'crowd' && e.inbox.some((m) => m.text.includes(g.name)));
    const hash = [...`${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const partner = w.living().find((b) => b.id !== e.id && b.kind === 'agent' && !b.groupId && Math.hypot(b.x - e.x, b.y - e.y) <= w.r('speech_radius'));
    if (invite) {
      calls.push({ name: 'say', args: { to: 'all', text: t('rt.mock.say.accept', { group: invite.name }) } });
      calls.push({ name: 'join_group', args: { name: invite.name } });
    } else if (partner && e.tier !== 'haiku' && hash % 3 === 0) {
      const name = t('rt.mock.groupName', { name: e.name });
      calls.push({ name: 'say', args: { to: partner.name, text: t('rt.mock.say.invite', { group: name }) } });
      calls.push({ name: 'form_group', args: { name, pattern: AGENT_PATTERNS[hash % AGENT_PATTERNS.length] } });
    }
  }
  // Barter, opinions and laws (a stand-in for a model: deterministic chances from config).
  const roll = (salt: string) => ([...`${salt}${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11) % 1000) / 1000;
  const m = host.cfg.mock;
  for (const o of host.perceived.offersFor(e)) {
    const can = Object.entries(o.want).every(([k, n]) => (e.inventory[k] ?? 0) >= n);
    calls.push({ name: 'rispondi_scambio', args: { offer: o.id, accept: can } });
  }
  const near = w.living().filter((b) => b.id !== e.id && b.kind !== 'player' && Math.hypot(b.x - e.x, b.y - e.y) <= w.r('speech_radius'));
  // What my recipes use and I lack, and what a neighbour carries of it.
  const needs = needsOf(w, e.role);
  const lacking = (b: RtEntity) => Object.keys(b.inventory).filter((k) => needs.has(k) && (b.inventory[k] ?? 0) >= 1 && (e.inventory[k] ?? 0) < 2);
  if (e.kind === 'agent' && near.length && roll('offer') < m.offerChance) {
    const b = near.find((x) => lacking(x).length) ?? near[Math.floor(roll('who') * near.length)]!;
    const mine = Object.keys(e.inventory).filter((k) => (e.inventory[k] ?? 0) >= 1);
    const theirNeeds = needsOf(w, b.role);
    const theirs = Object.keys(b.inventory).filter((k) => (b.inventory[k] ?? 0) >= 1 && !mine.includes(k));
    const give = mine.find((k) => theirNeeds.has(k) && !needs.has(k)) ?? mine.find((k) => k !== 'food') ?? mine[0];
    const want = lacking(b)[0] ?? theirs[0] ?? Object.keys(b.inventory).find((k) => k !== give && (b.inventory[k] ?? 0) >= 1);
    if (give && want && give !== want) calls.push({ name: 'scambia', args: { to: b.name, give: { [give]: 1 }, want: { [want]: 1 } } });
  } else if (e.kind === 'agent' && roll('ask') < m.askChance) {
    const b = near.find((x) => lacking(x).length);
    if (b) calls.push({ name: 'chiedi', args: { a: b.name, item: lacking(b)[0], amount: 1 } });
  }
  if (e.kind === 'agent' && near.length && roll('judge') < m.judgeChance) {
    const b = near[Math.floor(roll('whom') * near.length)]!;
    const pair = [...`${e.id}>${b.id}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 5) % 5;
    const score = [-0.6, 0.2, 0.5, 0.8, 1][pair]!;
    calls.push({ name: 'giudica', args: { chi: b.name, voto: score, motivo: t(`rt.mock.opinion.${score > 0 ? 'good' : 'bad'}`, { name: b.name }) } });
  }
  if (e.kind === 'agent' && roll('law') < m.lawChance) {
    calls.push({ name: 'proponi_legge', args: { text: t('rt.mock.law', { name: e.name }), category: 'society' } });
  }
  if (e.kind === 'agent') calls.push(...mockIdeaCalls(host, e, roll));
  // Shared consciousness: judge a peer's pending idea, or now and then share one.
  const pendingCode = /^- (\S+):/m.exec(host.reviewInsights(e))?.[1];
  const seed = [...`${e.id}${w.day}${w.minute}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 3);
  if (e.kind === 'agent' && pendingCode) calls.push({ name: 'judge_insight', args: { code: pendingCode, verdict: 'approve', reason: t('rt.mock.judgeOk') } });
  else if (e.kind === 'agent' && seed % 3 === 0) {
    const f = w.tiles.filter((x) => x.food >= 3 && Math.hypot(x.x - e.x, x.y - e.y) < 8)[0];
    if (f) calls.push({ name: 'share_insight', args: { text: t('rt.mock.insight', { x: f.x, y: f.y }), confidence: 0.6, evidence: t('rt.mock.insightEvidence', { day: w.day }) } });
  }
  const plan = mockSteps(t, w, e, { min: Math.min(host.cfg.mock.planSteps, tc.maxSteps), max: tc.maxSteps }, host.cfg.mock);
  calls.push({ name: 'commit_plan', args: { reason: plan.reason, steps: flatSteps(plan.steps) } });
  return { text: plan.reason, toolCalls: calls };
}

const hashOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 17);

/** Offline scores of an idea: a quality from its code (2-8), a little different for each reviewer. */
export function mockScores(code: string, reviewer: string): Record<'impact' | 'feasibility' | 'novelty' | 'fit' | 'risk', number> {
  const q = (hashOf(code) % 7) + 2;
  const j = (salt: string) => (hashOf(`${salt}${code}${reviewer}`) % 3) - 1;
  const c = (n: number) => Math.max(0, Math.min(10, n));
  return { impact: c(q + j('i')), feasibility: c(q + j('f')), novelty: c(q + j('n')), fit: c(q + j('t')), risk: c(10 - q + j('r')) };
}

/** Field each role fills first when it enriches an idea offline. */
const MOCK_FIELD: Record<string, string> = {
  architetto: 'feasibility', security: 'risks', critico: 'risks', ux_designer: 'users', venture_lead: 'differentiation', product_strategist: 'differentiation',
  data_scientist: 'solution', ricercatore: 'solution',
};

/** Offline idea moves: submit a ready idea of mine, review one of others, enrich one, now and then propose one. */
function mockIdeaCalls(host: DecideHost, e: RtEntity, roll: (salt: string) => number): Array<{ name: string; args: unknown }> {
  const t = host.t;
  const m = host.cfg.mock;
  const calls: Array<{ name: string; args: unknown }> = [];
  const briefs = host.ideas.briefs(e);
  const seedOf = (title: string) => {
    for (let k = 0; k < m.ideaSeeds; k++) if (title.startsWith(t(`rt.mock.ideas.${k}.title`))) return k;
    return hashOf(title) % Math.max(1, m.ideaSeeds);
  };
  // Evidence: a public signal on an open idea short of the requirements (the search, then the attachment of its
  // first result), now and then a simulated interview.
  const short = briefs.find((b) => !b.gatePass && ['concept', 'proposal'].includes(b.stage));
  if (short && host.evidence && roll('evidence') < m.evidenceChance) {
    const sources = host.cfg.evidence.signals.sources;
    const source = sources[(hashOf(`${e.id}${short.code}`) + short.evidence) % sources.length]!;
    calls.push({ name: SIGNAL_TOOL[source], args: { query: short.title } });
    calls.push({ name: 'allega_prova', args: { idea: short.code, tipo: 'segnale_pubblico', url: mockSignalUrl(source, short.title, short.evidence % 3) } });
    if (roll('interview') < m.interviewChance) calls.push({ name: 'intervista_simulata', args: { idea: short.code, persona: 'cliente', domande: [t('rt.mock.interviewQuestion')] } });
  }
  const ready = briefs.find((b) => b.mine && b.stage === 'proposal' && b.reviews >= b.minReviewers && b.gatePass);
  if (ready) calls.push({ name: 'candida_al_comitato', args: { code: ready.code } });
  const toReview = briefs.find((b) => !b.mine && !b.reviewedByMe && ['concept', 'proposal', 'pitch'].includes(b.stage));
  if (toReview && roll('review') < m.reviewChance) {
    const s = mockScores(toReview.code, e.name);
    calls.push({ name: 'valuta_idea', args: { code: toReview.code, ...s, comment: t(`rt.mock.review.${s.impact >= 6 ? 'good' : s.impact >= 4 ? 'mixed' : 'bad'}`) } });
  }
  const toEnrich = briefs.find((b) => b.missing.length && ['signal', 'insight', 'concept'].includes(b.stage));
  if (toEnrich && roll('enrich') < m.enrichChance) {
    const want = MOCK_FIELD[e.role];
    const field = want && toEnrich.missing.includes(want) ? want : toEnrich.missing[0]!;
    calls.push({ name: 'arricchisci_idea', args: { code: toEnrich.code, [field]: t(`rt.mock.ideas.${seedOf(toEnrich.title)}.${field}`) } });
  }
  const openByMe = briefs[0]?.openByMe ?? 0;
  const maxOpen = briefs[0]?.maxOpen ?? 1;
  if (openByMe < maxOpen && (briefs.length === 0 || roll('idea') < m.ideaChance)) {
    const taken = new Set(briefs.map((b) => b.title));
    const start = hashOf(`${e.id}${host.world().day}${host.world().minute}`) % Math.max(1, m.ideaSeeds);
    for (let i = 0; i < m.ideaSeeds; i++) {
      const k = (start + i) % m.ideaSeeds;
      const seed = t(`rt.mock.ideas.${k}.title`);
      // Seeds already used come back as new versions.
      let title = seed;
      for (let n = 2; taken.has(title); n++) title = t('rt.mock.ideaVersion', { title: seed, n });
      const signals = Object.keys(e.inventory).filter((code) => (e.inventory[code] ?? 0) >= 1 && host.cfg.ideas.attachCategories.includes(host.world().catalog.resources.get(code)?.category ?? '')).slice(0, 2);
      calls.push({ name: 'proponi_idea', args: {
        title, problem: t(`rt.mock.ideas.${k}.problem`), users: t(`rt.mock.ideas.${k}.users`), solution: t(`rt.mock.ideas.${k}.solution`),
        tags: t(`rt.mock.ideas.${k}.tags`).split(',').map((x) => x.trim()), ...(signals.length ? { signals } : {}),
      } });
      break;
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------------------------------------------
// The stack behind decide and reply

/** Static tool catalog of a person (what `StackHub` lists when a run brings no tools): faculties and social tools. */
export function personCatalog(host: DecideHost, e: RtEntity): Tool[] {
  const tc = tierConfig(e, host.cfg);
  return [...faculties(host, e, { maxConsults: 0, ...(tc.maxWebCalls === undefined ? {} : { maxWebCalls: tc.maxWebCalls }) }), ...socialTools(host, e)];
}

const ownHubs = new WeakMap<object, StackHub>();

/**
 * The hub the host's decisions run on: `host.stacks`, else one built on first use for this world (its feed is not
 * listened to elsewhere: decide and reply read usage and reasoning of their own runs from it).
 */
export function stackHub(host: DecideHost): StackHub {
  if (host.stacks) return host.stacks;
  const key = host.world();
  let hub = ownHubs.get(key);
  if (!hub) {
    hub = new StackHub(host, { mock: host.mock, feed: new StackFeed(), dataDir: process.env.HUB_DATA_DIR ?? resolve(ROOT, 'data'), catalog: (e) => personCatalog(host, e) });
    ownHubs.set(key, hub);
  }
  return hub;
}

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens'] as const;

interface Metered {
  usage: TokenUsage;
  costUsd: number;
  thoughts: string[];
}

/** Usage, price and reasoning the model tap reports to the feed, summed per run. */
function watchRuns(feed: StackFeed) {
  const runs = new Map<string, Metered>();
  const offs = [
    feed.on('usage', (u) => {
      const m = runs.get(u.runId);
      if (!m) return;
      for (const k of TOKEN_KEYS) if (u.usage[k]) m.usage[k] = (m.usage[k] ?? 0) + u.usage[k]!;
      m.costUsd += u.costUsd;
    }),
    feed.on('reasoning', (r) => void runs.get(r.runId)?.thoughts.push(r.text)),
  ];
  return {
    track(runId: string): void {
      runs.set(runId, { usage: {}, costUsd: 0, thoughts: [] });
    },
    take(runId: string): Metered {
      const m = runs.get(runId) ?? { usage: {}, costUsd: 0, thoughts: [] };
      runs.delete(runId);
      return m;
    },
    close(): void {
      for (const off of offs) off();
    },
  };
}

let runSeq = 0;
const runIdOf = (e: Pick<RtEntity, 'id'>, cap: string) => `${e.id}:${cap}:${Date.now().toString(36)}${(++runSeq).toString(36)}`;

const textMessage = (role: 'system' | 'user', text: string): StackMessage => ({ role, parts: [{ type: 'text', text }] });

/** Why a run ended other than completed, as the callers log it (`stopped: timeout`). */
function whyNot(run: Pick<StackRunResult, 'status' | 'reason'>): string {
  const r = run.reason;
  return `${run.status}${r ? `: ${r.detail ?? r.code}` : ''}`;
}

/** A run that failed before or outside the stack's own error handling (config, build, abort). */
function failedRun(runId: string, err: unknown): CapResult {
  return { run: { runId, status: 'failed', output: '', reason: { code: 'error', detail: err instanceof Error ? err.message : String(err) } } };
}

/** What a tool did in a run (for the closing run, which needs the results of the calls the budget cut off). */
interface Executed {
  name: string;
  content: string;
  isError: boolean;
}

interface ToolLog {
  /** Once set, only `commit_plan` answers; the other tools say the decision is closed. */
  closing: boolean;
  refused: string;
  ran: Executed[];
}

/** The run's tools, recording what they answered and refusing everything but `commit_plan` once the run is closing. */
function logged(tools: Tool[], log: ToolLog): Tool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args, ctx) => {
      if (log.closing && t.name !== 'commit_plan') return { content: log.refused, isError: true };
      try {
        const raw = await t.run(args, ctx);
        const out = (typeof raw === 'string' ? { content: raw } : raw) as { content: string; isError?: boolean };
        log.ran.push({ name: t.name, content: out.content, isError: !!out.isError });
        return raw;
      } catch (err) {
        log.ran.push({ name: t.name, content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
        throw err;
      }
    },
  }));
}

/** A plan run that may get a closing run: it ended on its own, or on its turn or tool-call budget. Pure. */
export function closableRun(run: Pick<StackRunResult, 'status' | 'reason'>): boolean {
  return run.status === 'completed' || (run.status === 'stopped' && run.reason?.code === 'limit' && /^(maxTurns|maxToolCalls)$/.test(run.reason.detail ?? ''));
}

/**
 * The conversation of a run followed by the closing notice. The calls of the last model reply that the run cut off
 * (budget) get their results first: what the tools answered, or `refused` for calls that never ran. Pure.
 */
export function closingMessages(transcript: StackMessage[], ran: Executed[], notice: string, refused: string): StackMessage[] {
  const out = [...transcript];
  const last = out.at(-1);
  const calls = last?.role === 'assistant' ? last.parts.filter((p): p is CallPart => p.type === 'call') : [];
  if (calls.length) {
    const pool = [...ran];
    out.push({
      role: 'tool',
      parts: calls.map((c) => {
        const i = pool.findIndex((r) => c.tool === r.name || c.tool.endsWith(`__${r.name}`));
        const r = i >= 0 ? pool.splice(i, 1)[0] : undefined;
        return { type: 'result', callId: c.id, ok: r ? !r.isError : false, text: r ? r.content : refused };
      }),
    });
  }
  out.push(textMessage('user', notice));
  return out;
}

/** Asks one person what it will do next; a Failure says why no plan was committed. */
export async function decide(host: DecideHost, e: RtEntity, why: string, stop?: AbortSignal): Promise<Decision | Failure> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  const horizon = w.r('plan_horizon_minutes') * tc.horizonFactor;
  const textMax = cfg.decisions.textMaxChars;
  const commit = tool<{ reason: string; steps: unknown[] }>('commit_plan', t('rt.tools.commitPlan'), planSchema(t, textMax, false, tc.maxSteps), (args) => {
    const steps = normalizeSteps(args?.steps, textMax, tc.maxSteps);
    if (!steps.length) return { content: t('rt.act.noSteps'), isError: true };
    // The plan is all this call is for: the run ends without another model turn, and the plan comes out of the run.
    return { content: t('rt.act.planned', { n: steps.length }), stop: true, data: { summary: String(args?.reason ?? '').slice(0, textMax), steps } satisfies PlanData };
  });
  // The same tools in both runs (the cached prompt prefix stays valid); in the closing run only commit_plan answers.
  const log: ToolLog = { closing: false, refused: t('rt.act.decisionClosed'), ran: [] };
  const tools = logged([commit, ...socialTools(host, e), ...faculties(host, e, tc)], log);
  const instructions = rtInstructions(t, e, host.roleOf(e.role), { horizon }, !!host.research, !!host.evidence);
  const prompt = rtObservation(t, w, e, why, host.groups(), host.roleTitle, limitsOf(cfg), host.changedLaws(e), host.perceived);
  // What the body went through is counted again from this thought on.
  w.resetBody(e);
  const signal = AbortSignal.any([AbortSignal.timeout(decisionTimeoutMs(cfg, w)), ...(stop ? [stop] : [])]);
  const hub = stackHub(host);
  const watch = watchRuns(hub.feed);
  const delayMs = cfg.mock.thinkDelayMs / Math.max(1, w.timeScale);
  const once = async (cap: 'decide' | 'decide_close', input: RunInput): Promise<CapResult> => {
    const runId = runIdOf(e, cap);
    watch.track(runId);
    let out: CapResult;
    try {
      const ps = await hub.stackFor(e);
      // `decide_close` is the closing budget of the same person (agent of the person config; see Capacity in stack/index.ts).
      const s = ps.stream(cap as Capacity, input, {
        sessionId: runId, runId, signal, tools,
        ...(host.mock ? { mock: (req, i) => ({ delayMs, ...mockDecision(host, e, tc, req) }) } : {}),
      });
      for await (const _ of s) { /* the events are not needed; the run is driven by reading them */ }
      out = await s.result;
    } catch (err) {
      out = failedRun(runId, err);
    }
    const metered = watch.take(runId);
    host.ranModel(e, { status: out.run.status, usage: metered.usage, costUsd: metered.costUsd });
    // With thinking display `omitted` (config) there is no summary: the plan reason is the visible thought (commitPlan).
    const thought = metered.thoughts.join('\n').trim();
    if (thought) host.reasoned(e, thought.slice(0, textMax));
    return out;
  };
  try {
    let out = await once('decide', { messages: [textMessage('system', instructions), textMessage('user', prompt)] });
    const ct = cfg.decisions.closingTurn;
    if (!out.plan && ct?.enabled && closableRun(out.run) && out.transcript && !signal.aborted) {
      log.closing = true;
      out = await once('decide_close', { messages: closingMessages(out.transcript, log.ran, t('rt.observation.closingTurn'), log.refused) });
      host.closed?.(e, !!out.plan);
    }
    if (out.plan) return { steps: out.plan.steps as PlanStep[], reason: out.plan.summary };
    return { error: out.run.status === 'completed' ? 'no plan committed' : whyNot(out.run) };
  } finally {
    watch.close();
  }
}

/** Closing helpers in reinloop's message form, kept until the group runs move to the stack. */
/** A reinloop plan run that may get a closing run: it ended on its own, or on its turn or tool-call budget. Pure. */
export function closable(res: Pick<RunResult, 'status' | 'reason'>): boolean {
  return res.status === 'completed' || (res.status === 'stopped' && /^budget:(maxTurns|maxToolCalls)$/.test(res.reason ?? ''));
}

/** The conversation of a run followed by the closing notice (providers merge it with trailing tool results). Pure. */
export function closingInput(messages: Message[], notice: string): Message[] {
  return [...messages, { role: 'user', parts: [{ type: 'text', text: notice }] }];
}

export interface Reply {
  text: string;
  rethink: boolean;
  /** Why the reply run did not complete (timeout, max_tokens, provider error): a failure. */
  error?: string;
}

/** What the speaker last said to this person (to recall related memories). */
export function lastHeard(e: Pick<RtEntity, 'inbox'>, speaker: Pick<RtEntity, 'id'>): string {
  return [...e.inbox].reverse().find((m) => m.from === speaker.id)?.text ?? '';
}

/**
 * Quick spoken reply, streamed through `onDelta`. The person may consult Lorebase (bounded by
 * `conversation.replyMaxConsults`) before answering; memories related to what was said are recalled first.
 */
export async function reply(host: DecideHost, e: RtEntity, speaker: RtEntity, onDelta: (delta: string) => void, stop?: AbortSignal): Promise<Reply> {
  const t = host.t;
  const cfg = host.cfg;
  const w = host.world();
  const tc = tierConfig(e, cfg);
  let rethink = false;
  const rethinkTool = tool('rethink', t('rt.tools.rethink'), {}, () => {
    rethink = true;
    return { content: t('rt.act.rethink'), stop: true };
  });
  const mockReply = (): MockTurn => {
    const n = Number(String(e.id).replace(/\D/g, '')) || 0;
    const state = e.hunger >= w.r('critical_hunger') ? t('rt.mock.stateHungry') : e.groupId ? t('rt.mock.stateGroup', { group: host.groups().find((g) => g.id === e.groupId)?.name ?? '' }) : t('rt.mock.stateOk');
    return { text: t(`rt.mock.reply.${(n + w.minute) % 3}`, { name: speaker.name, me: e.name, role: host.roleTitle(e.role), state }) };
  };
  const consults = Math.max(0, cfg.conversation.replyMaxConsults);
  const lorebase = consults > 0 ? host.brain.lorebaseTools({ left: consults, onConsult: (ev) => host.consulted(e, ev) }) : [];
  const instructions = `${rtInstructions(t, e, host.roleOf(e.role), { horizon: w.r('plan_horizon_minutes') * tc.horizonFactor }, !!host.research, !!host.evidence)}\n${t('rt.replyInstructions')}`;
  const recalled = await host.recall(e, `${speaker.name}: ${lastHeard(e, speaker)}`).catch(() => []);
  const prompt = [
    timeLine(t, w),
    selfLine(t, w, e),
    groupLine(t, w, e, host.groups()),
    doingLine(t, e),
    t('rt.observation.why', { why: t('rt.why.spokenTo', { name: speaker.name }) }),
    t('rt.observation.perceive', { look: look(t, w, e, host.groups(), host.roleTitle, limitsOf(cfg), (b) => host.perceived.about(e, b)) }),
    ...host.perceived.blocks(e),
    memoryBlock(t, e),
    recalledBlock(t, recalled),
    inboxBlock(t, e),
  ].filter(Boolean).join('\n\n');
  let text = '';
  const signal = AbortSignal.any([AbortSignal.timeout(cfg.conversation.replyTimeoutMs), ...(stop ? [stop] : [])]);
  const hub = stackHub(host);
  const watch = watchRuns(hub.feed);
  const runId = runIdOf(e, 'reply');
  watch.track(runId);
  const delayMs = cfg.mock.replyDelayMs / Math.max(1, w.timeScale);
  let out: CapResult;
  try {
    const ps = await hub.stackFor(e);
    const s = ps.stream('reply', { messages: [textMessage('system', instructions), textMessage('user', prompt)] }, {
      sessionId: runId, runId, signal, tools: [rethinkTool, ...lorebase],
      ...(host.mock ? { mock: () => ({ delayMs, ...mockReply() }) } : {}),
    });
    // Speech before and after a consultation is one answer (a model reply with tool calls is the turn boundary);
    // nothing is said after rethink.
    let rethought = false;
    let boundary = false;
    for await (const ev of s) {
      if (rethought) continue;
      if (ev.type === 'tool.call') rethought = /(^|__)rethink$/.test(String(ev.tool));
      else if (ev.type === 'model.reply') boundary = Number(ev.calls) > 0;
      else if (ev.type === 'text') {
        const d = String(ev.text ?? '');
        if (!d) continue;
        if (boundary && text && !/\s$/.test(text)) {
          text += ' ';
          onDelta(' ');
        }
        boundary = false;
        text += d;
        onDelta(d);
      }
    }
    out = await s.result;
  } catch (err) {
    out = failedRun(runId, err);
  } finally {
    watch.close();
  }
  const metered = watch.take(runId);
  host.ranModel(e, { status: out.run.status, usage: metered.usage, costUsd: metered.costUsd });
  const said = text.trim();
  // A run cut short (max_tokens is reported as such) is a failure; a completed run without words is a silence.
  const cut = out.run.reason?.detail === 'max_tokens';
  const error = out.run.status === 'completed' && !cut ? undefined : whyNot(out.run);
  return { text: said, rethink: rethink || !!out.rethink, ...(error ? { error } : {}) };
}
