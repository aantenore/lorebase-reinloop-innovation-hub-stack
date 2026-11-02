// What the investment committee decides on, as policy (Lorebase `Rule` records): the criteria it votes on (one rule
// per criterion, code `<prefix><key>`, on with value >= 1, its text is what the members read), the phase an approval
// funds (`fase_approvazione`) and what a deferral costs (`costo_del_rinvio`). Ballots and the chair's decision are
// tool calls checked here: every criterion gets a verdict, a vote that does not approve names an unmet criterion,
// demands outside the criteria are recorded as such. Pure: nothing here decides.
import type { Rule } from '../lorebase/rules.ts';
import type { CommitteeDecision, CommitteeVote } from './ideas.ts';
import { weightedWinner } from './society.ts';

export const DECISIONS: CommitteeDecision[] = ['approve', 'kill', 'defer'];

export interface Criterion {
  /** Rule code, e.g. criterio_comitato_concorrenza. */
  code: string;
  /** The code without the prefix (the ballot field), e.g. concorrenza. */
  key: string;
  text: string;
}

export interface CriterionVerdict {
  met: boolean;
  note: string;
}

/** A member's ballot as recorded. */
export interface Ballot {
  vote: CommitteeDecision;
  reason: string;
  criteria: Record<string, CriterionVerdict>;
  /** Keys of the criteria judged unmet. */
  unmet: string[];
  /** Demands that match no criterion of the policy (recorded as out of policy). */
  outOfPolicy: string[];
}

/** The chair's decision as recorded. */
export interface ChairDecision {
  decision: CommitteeDecision;
  summary: string;
  unmet: string[];
  outOfPolicy: string[];
}

export type BallotError = { error: 'vote' } | { error: 'missing'; missing: string[] } | { error: 'need_unmet' } | { error: 'unknown'; unknown: string[] };

/** The criteria in force: rules whose code starts with `prefix` and whose value is 1 or more, in rule order. Pure. */
export function criteriaFrom(laws: Pick<Rule, 'key' | 'value' | 'text'>[], prefix: string): Criterion[] {
  return laws
    .filter((r) => r.key.startsWith(prefix) && r.key.length > prefix.length && Number.isFinite(Number(r.value)) && Number(r.value) >= 1)
    .map((r) => ({ code: r.key, key: r.key.slice(prefix.length), text: r.text }));
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');
const asDecision = (v: unknown): CommitteeDecision | undefined => (DECISIONS.includes(v as CommitteeDecision) ? (v as CommitteeDecision) : undefined);
const asBool = (v: unknown): boolean | undefined => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);

/** Free-form demands as a clean list (array or a single string), at most `max`. Pure. */
export function demandsFrom(v: unknown, max: number, maxChars: number): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [];
  return [...new Set(list.map((x) => text(x, maxChars)).filter(Boolean))].slice(0, max);
}

/** Labels of the ballot fields (from i18n). */
export interface BallotLabels {
  criteria: string;
  criterion: (c: Criterion) => string;
  met: string;
  note: string;
  vote: string;
  reason: string;
  outOfPolicy: string;
  unmet: string;
  summary: string;
}

/** JSON Schema of a member's ballot (tool vota_idea): one verdict per criterion, the vote, the reason, demands out of policy. */
export function ballotSchema(criteria: Criterion[], l: BallotLabels): Record<string, unknown> {
  const verdict = (c: Criterion) => ({
    type: 'object', description: l.criterion(c),
    properties: { soddisfatto: { type: 'boolean', description: l.met }, nota: { type: 'string', description: l.note } },
    required: ['soddisfatto', 'nota'],
  });
  return {
    type: 'object',
    properties: {
      criteri: { type: 'object', description: l.criteria, properties: Object.fromEntries(criteria.map((c) => [c.key, verdict(c)])), required: criteria.map((c) => c.key) },
      voto: { enum: DECISIONS, description: l.vote },
      motivo: { type: 'string', description: l.reason },
      richieste_fuori_policy: { type: 'array', items: { type: 'string' }, description: l.outOfPolicy },
    },
    required: ['criteri', 'voto', 'motivo'],
  };
}

/** JSON Schema of the chair's decision (tool decidi_idea). */
export function chairSchema(criteria: Criterion[], l: BallotLabels): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      decisione: { enum: DECISIONS, description: l.vote },
      criteri_non_soddisfatti: { type: 'array', items: { enum: criteria.map((c) => c.key) }, description: l.unmet },
      sintesi: { type: 'string', description: l.summary },
      richieste_fuori_policy: { type: 'array', items: { type: 'string' }, description: l.outOfPolicy },
    },
    required: ['decisione', 'criteri_non_soddisfatti', 'sintesi'],
  };
}

/** A criterion named by a model: its key, its rule code, or either with spaces for underscores. */
function criterionKey(ref: unknown, criteria: Criterion[]): string | undefined {
  const r = String(ref ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  return criteria.find((c) => c.key === r || c.code === r)?.key;
}

/**
 * Checks a member's ballot against the policy: every criterion has a verdict, the vote is valid, and a vote that does
 * not approve names at least one unmet criterion. Returns the ballot or why it cannot be recorded. Pure.
 */
export function checkBallot(args: Record<string, unknown>, criteria: Criterion[], o: { maxChars: number; demandsMax: number }): Ballot | BallotError {
  const vote = asDecision(args.voto ?? args.vote);
  if (!vote) return { error: 'vote' };
  const raw = (args.criteri && typeof args.criteri === 'object' ? args.criteri : {}) as Record<string, unknown>;
  const given = new Map<string, CriterionVerdict>();
  for (const [k, v] of Object.entries(raw)) {
    const key = criterionKey(k, criteria);
    const r = (v && typeof v === 'object' ? v : { soddisfatto: v }) as Record<string, unknown>;
    const met = asBool(r.soddisfatto ?? r.met);
    if (key && met !== undefined) given.set(key, { met, note: text(r.nota ?? r.note, o.maxChars) });
  }
  const missing = criteria.filter((c) => !given.has(c.key)).map((c) => c.key);
  if (missing.length) return { error: 'missing', missing };
  const unmet = criteria.filter((c) => !given.get(c.key)!.met).map((c) => c.key);
  if (vote !== 'approve' && !unmet.length) return { error: 'need_unmet' };
  return {
    vote, reason: text(args.motivo ?? args.reason, o.maxChars), criteria: Object.fromEntries(criteria.map((c) => [c.key, given.get(c.key)!])), unmet,
    outOfPolicy: demandsFrom(args.richieste_fuori_policy, o.demandsMax, o.maxChars),
  };
}

/** Checks the chair's decision: a valid decision, known criteria, and a decision that does not approve names an unmet one. Pure. */
export function checkChair(args: Record<string, unknown>, criteria: Criterion[], o: { maxChars: number; demandsMax: number }): ChairDecision | BallotError {
  const decision = asDecision(args.decisione ?? args.decision);
  if (!decision) return { error: 'vote' };
  const named = Array.isArray(args.criteri_non_soddisfatti) ? args.criteri_non_soddisfatti : typeof args.criteri_non_soddisfatti === 'string' ? [args.criteri_non_soddisfatti] : [];
  const unknown = named.filter((x) => !criterionKey(x, criteria)).map(String);
  if (unknown.length) return { error: 'unknown', unknown };
  const unmet = [...new Set(named.map((x) => criterionKey(x, criteria)!))];
  if (decision !== 'approve' && !unmet.length) return { error: 'need_unmet' };
  return { decision, summary: text(args.sintesi ?? args.summary, o.maxChars), unmet, outOfPolicy: demandsFrom(args.richieste_fuori_policy, o.demandsMax, o.maxChars) };
}

/** A member's ballot when the policy sets no criteria: the vote and the reason (no verdicts, nothing unmet). Pure. */
export function checkFreeBallot(args: Record<string, unknown>, o: { maxChars: number }): Ballot | BallotError {
  const vote = asDecision(args.vote ?? args.voto);
  return vote ? { vote, reason: text(args.reason ?? args.motivo, o.maxChars), criteria: {}, unmet: [], outOfPolicy: [] } : { error: 'vote' };
}

/** The chair's decision when the policy sets no criteria: the decision and the summary. Pure. */
export function checkFreeChair(args: Record<string, unknown>, o: { maxChars: number }): ChairDecision | BallotError {
  const decision = asDecision(args.decision ?? args.decisione);
  return decision ? { decision, summary: text(args.summary ?? args.sintesi, o.maxChars), unmet: [], outOfPolicy: [] } : { error: 'vote' };
}

/** Ballots per criterion: how many judged it met and unmet. Pure. */
export function criteriaTally(ballots: Array<Pick<Ballot, 'criteria'>>): Record<string, { met: number; unmet: number }> {
  const out: Record<string, { met: number; unmet: number }> = {};
  for (const b of ballots) {
    for (const [k, v] of Object.entries(b.criteria ?? {})) {
      const c = (out[k] ??= { met: 0, unmet: 0 });
      if (v.met) c.met++;
      else c.unmet++;
    }
  }
  return out;
}

/** The phase an approval funds: policy value 1, 2, ... indexes `phases` (out of range: the first). Pure. */
export function approvalPhase(value: number | undefined, phases: string[]): string {
  const i = Math.round(Number(value)) - 1;
  return phases[i >= 0 && i < phases.length ? i : 0] ?? '';
}

/** The distinct entries of several optional lists, in order. Pure. */
export const unionOf = (lists: Array<string[] | undefined>): string[] => [...new Set(lists.flatMap((x) => x ?? []))];

/**
 * The decision of an assembly: the plurality of the votes weighed by the voters' esteem (`weight`); a tie keeps the first
 * of approve, kill, defer. The summary joins the reasons of the winning side (cut at `textMax`); with criteria, `unmet`
 * is what that side judged unmet (none for an approval) and `outOfPolicy` what everyone asked for outside the policy. Pure.
 */
export function assemblyOutcome(
  votes: CommitteeVote[], weight: (member: string) => number, o: { name: (v: CommitteeVote) => string; textMax: number; criteria: boolean },
): { decision: CommitteeDecision; summary: string; unmet?: string[]; outOfPolicy?: string[] } {
  const weighted = weightedWinner(votes.map((v) => DECISIONS.indexOf(v.vote)), votes.map((v) => weight(v.member)), DECISIONS.length);
  const decision = DECISIONS[weighted.winner] ?? 'defer';
  const side = votes.filter((v) => v.vote === decision);
  const summary = side.map((v) => `${o.name(v)}: ${v.reason}`).join(' ').slice(0, o.textMax);
  return { decision, summary, ...(o.criteria ? { unmet: decision === 'approve' ? [] : unionOf(side.map((v) => v.unmet)), outOfPolicy: unionOf(votes.map((v) => v.outOfPolicy)) } : {}) };
}
