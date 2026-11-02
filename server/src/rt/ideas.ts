// The product of the hub: IT product ideas. Each idea lives on its own Lorebase branch
// (`idea/<slug>`): the server writes the `Idea` Record (full state, upserted) and one `Review`
// Record per reviewer there. Submitting an idea opens a Proposal into main; the investment
// committee decides: approved -> the Proposal is merged (main is the portfolio), killed -> the
// idea is marked killed on its branch and the Proposal is closed, deferred -> back to proposal.
// Nothing here decides: agents propose, enrich, review and submit with their own tools; the
// committee (a group of agents) decides. All agents share one Keeper principal, so the rules
// (no review of one's own idea, one review per person) are enforced here.
import { randomUUID } from 'node:crypto';
import { type LorebaseClient, LorebaseError, type RecordItem } from '../lorebase/client.ts';
import { type Evidence, evidenceFromRecord, evidenceRow } from './evidence.ts';

export const IDEA_STAGES = ['signal', 'insight', 'concept', 'proposal', 'pitch', 'approved', 'killed'] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];
export const SCORE_KEYS = ['impact', 'feasibility', 'novelty', 'fit', 'risk'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number>;
/** Text fields of an idea besides the title, in the order they make it complete. */
export const IDEA_FIELDS = ['problem', 'users', 'solution', 'differentiation', 'feasibility', 'risks'] as const;
export type IdeaField = (typeof IDEA_FIELDS)[number];
export type IdeaAction = 'created' | 'updated' | 'reviewed' | 'submitted' | 'approved' | 'killed' | 'stage' | 'evidence';
export type CommitteeDecision = 'approve' | 'kill' | 'defer';

export interface At {
  day: number;
  minute: number;
}

export interface IdeaReview {
  /** Name of the reviewer. */
  by: string;
  scores: Scores;
  comment: string;
  at: At;
}

export interface IdeaEvent {
  at: At;
  by: string;
  action: string;
  note: string;
}

export interface CommitteeVote {
  /** Entity id of the committee member. */
  member: string;
  /** Name of the member (for the record). */
  name?: string;
  vote: CommitteeDecision;
  reason: string;
  /** Policy criteri_comitato: the member's verdict on each criterion, the unmet ones, demands outside the criteria. */
  criteria?: Record<string, { met: boolean; note: string }>;
  unmet?: string[];
  outOfPolicy?: string[];
}

/** The committee run that deferred an idea and waits for its resubmission (the journal keeps the ballots already cast). */
export interface CommitteeRunRef {
  runId: string;
  /** Hash of the committee system's config when the run began: another one cannot replay the run. */
  configHash: string;
  /** The wait the resubmission answers. */
  wait?: string;
}

export interface Idea {
  code: string;
  title: string;
  problem: string;
  users: string;
  solution: string;
  differentiation: string;
  feasibility: string;
  risks: string;
  tags: string[];
  stage: IdeaStage;
  /** Names (people of the company). */
  champion: string | null;
  authors: string[];
  /** Mean of the reviews, per dimension (0-10), null before the first review. */
  scores: Scores | null;
  reviews: IdeaReview[];
  branch: string;
  proposalId: string | null;
  /** Quarter label when the idea was created (e.g. Q2). */
  quarter: string;
  history: IdeaEvent[];
  /** Signal codes the authors brought in (consumed from what they carried). */
  signals: string[];
  /** Web pages its authors cite (title and http/https URL). */
  sources: IdeaSource[];
  /** Evidence behind it (Evidence Records on its branch), oldest first. */
  evidence: Evidence[];
  /** The committee run waiting on this idea's resubmission after a deferral (kept in the idea's record: it survives a restart). */
  committeeRun?: CommitteeRunRef | null;
  /**
   * The committee's last word on it (`recused`: members who abstained for a conflict of interest, names; `unmet`: the
   * policy criteria the decision names as unmet; `outOfPolicy`: demands recorded outside the policy criteria; `phase`:
   * what an approval funds, policy fase_approvazione; `slotsSpent`: slots a deferral consumed, policy costo_del_rinvio).
   */
  decision: {
    decision: CommitteeDecision; summary: string; at: At; votes: CommitteeVote[]; recused?: string[];
    unmet?: string[]; outOfPolicy?: string[]; phase?: string; slotsSpent?: number;
  } | null;
}

export interface IdeaSource {
  title: string;
  url: string;
}

export interface IdeasConfig {
  enabled: boolean;
  kind: string;
  reviewKind: string;
  /** Kind of the evidence Records (written on the idea's branch). */
  evidenceKind: string;
  /** Pieces of evidence one idea keeps. */
  evidenceMax: number;
  /** Built-in upsert Operation used for every write (`import_records`). */
  writeOperation: string;
  branchPrefix: string;
  titleMaxChars: number;
  textMaxChars: number;
  tagsMax: number;
  tagMaxChars: number;
  historyMax: number;
  commentMaxChars: number;
  /** Ideas listed in a person's perception. */
  perceiveMax: number;
  /** Signals an author may bring into one idea. */
  signalsMax: number;
  /** Web sources one idea keeps, and the length of their titles. */
  sourcesMax: number;
  sourceTitleMaxChars: number;
  /** A write refused with 429 or 5xx is retried up to `retries` times (backoff from `retryBaseMs`, Retry-After honoured). */
  retries: number;
  retryBaseMs: number;
  committee: {
    /** The seeded group that decides on submitted ideas (it does not make joint plans). */
    groupName: string;
    /** Ideas reviewed per committee session. */
    maxPerSession: number;
    /** Members who vote on an idea (0: every seated member). */
    maxVoters: number;
    /** Turns of a ballot or chair run (a ballot the policy refuses can be cast again). */
    ballotMaxTurns: number;
    /** Code prefix of the criterion policies (criteri_comitato). */
    criteriaPrefix: string;
    /** Phases an approval can fund, by value of policy fase_approvazione (1 = the first). */
    phases: string[];
    /** Demands outside the policy kept per ballot. */
    demandsMax: number;
    /** Deferrals one committee run keeps waiting for (the next one starts a new run). */
    maxDeferrals: number;
  };
  /**
   * Policy keys (Lorebase `Rule` records, value >= 1 means on): `conflictOfInterest` keeps the champion and the
   * authors of an idea out of the committee's session on it; `independentReviews` hides the other reviews of an
   * idea from a person until that person has reviewed it.
   */
  policies: {
    conflictOfInterest: string; independentReviews: string;
    /** Committee members never become authors: they cannot propose, and an edit of theirs is a reviewer's contribution. */
    committeeNotAuthor: string;
    /** Below quorum, non-conflicted people of the hub sit as alternates by seniority (career step, then esteem). */
    committeeAlternates: string;
    /** Unused approval slots are lost at the end of the quarter (off: they carry over). */
    slotsExpire: string;
    /** On: ballots give a verdict per criterion (rules `committee.criteriaPrefix*`), a vote that does not approve names an unmet one. */
    criteria: string;
    /** What an approval funds (value indexes `committee.phases`). */
    approvalPhase: string;
    /** Approval slots a deferral of an idea that meets the candidacy requirements consumes. */
    deferralCost: string;
    /** Approved ideas (concepts explored) the company expects from the portfolio in a quarter. */
    portfolioTarget: string;
    /** Game hours between committee sessions, on a fixed grid from day 1 00:00 (0: a session as soon as an idea is submitted). */
    sessionCadence?: string;
  };
}

export interface IdeaEvents {
  changed(idea: Idea, action: IdeaAction, by: string): void;
}

export type IdeaInput = Partial<Record<'title' | IdeaField, unknown>> & { tags?: unknown; sources?: unknown };

const ORDER: Record<IdeaStage, number> = { signal: 0, insight: 1, concept: 2, proposal: 3, pitch: 4, approved: 5, killed: 6 };
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'idea';
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The stage an idea's fields justify: problem -> signal, + users -> insight, + solution -> concept, all six -> proposal. Pure. */
export function stageFromFields(i: Pick<Idea, IdeaField>): IdeaStage {
  const has = (k: IdeaField) => !!i[k]?.trim();
  if (IDEA_FIELDS.every(has)) return 'proposal';
  if (has('problem') && has('users') && has('solution')) return 'concept';
  if (has('problem') && has('users')) return 'insight';
  return 'signal';
}

/** An idea is open while the committee has not decided on it and it is not under review by it. */
export const isOpen = (i: Pick<Idea, 'stage'>) => ORDER[i.stage] <= ORDER.proposal;
export const isClosed = (i: Pick<Idea, 'stage'>) => i.stage === 'approved' || i.stage === 'killed';

/** One score 0-10 (integer), or undefined when not a number. */
export function score(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : undefined;
}

/** Scores from a model's arguments (Italian or English names), or a list of the missing dimensions. Pure. */
export function scoresFrom(raw: Record<string, unknown>, aliases: Record<string, ScoreKey>): Scores | { missing: ScoreKey[] } {
  const out: Partial<Scores> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = (SCORE_KEYS as readonly string[]).includes(k) ? (k as ScoreKey) : aliases[k.toLowerCase()];
    const s = key ? score(v) : undefined;
    if (key && s !== undefined) out[key] = s;
  }
  const missing = SCORE_KEYS.filter((k) => out[k] === undefined);
  return missing.length ? { missing } : (out as Scores);
}

/** Mean of each dimension over the reviews (one decimal), null without reviews. Pure. */
export function aggregate(reviews: IdeaReview[]): Scores | null {
  if (!reviews.length) return null;
  const out = {} as Scores;
  for (const k of SCORE_KEYS) out[k] = round1(reviews.reduce((s, r) => s + r.scores[k], 0) / reviews.length);
  return out;
}

/** Reviewers (names) whose five scores equal those of `r`, by someone else. Pure. */
export function sameScores(reviews: IdeaReview[], r: IdeaReview): string[] {
  return reviews.filter((x) => x.by !== r.by && SCORE_KEYS.every((k) => x.scores[k] === r.scores[k])).map((x) => x.by);
}

/** Whether a person may read the other reviews of an idea: authors always, others once they reviewed it. Pure. */
export function seesReviews(i: Pick<Idea, 'authors' | 'champion' | 'reviews'>, name: string): boolean {
  return i.champion === name || i.authors.includes(name) || i.reviews.some((r) => r.by === name);
}

/** Names of the people with a conflict of interest on an idea: its champion and authors. Pure. */
export function conflicted(i: Pick<Idea, 'authors' | 'champion'>): string[] {
  return [...new Set([i.champion, ...i.authors].filter((x): x is string => !!x))];
}

/**
 * Weighted score 0-10 from the policy weights (`weight_*`): risk counts inverted (10 - risk). Pure.
 * Returns null without scores or when every weight is 0.
 */
export function weightedScore(scores: Scores | null, weights: Scores): number | null {
  if (!scores) return null;
  let sum = 0;
  let total = 0;
  for (const k of SCORE_KEYS) {
    const w = Math.max(0, weights[k]);
    sum += w * (k === 'risk' ? 10 - scores[k] : scores[k]);
    total += w;
  }
  return total > 0 ? round1(sum / total) : null;
}

/** Tags as clean lower-case words. Pure. */
export function tagsFrom(v: unknown, max: number, maxChars: number): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = list.map((x) => clean(String(x), maxChars).toLowerCase()).filter(Boolean);
  return [...new Set(out)].slice(0, max);
}

/**
 * Web sources from a tool argument: objects `{title, url}` or bare URL strings; only http/https URLs are kept,
 * without duplicates. Pure.
 */
export function sourcesFrom(v: unknown, max: number, titleMax: number): IdeaSource[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: IdeaSource[] = [];
  for (const x of list) {
    const raw = typeof x === 'string' ? { url: x } : x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
    let url: URL;
    try {
      url = new URL(String(raw.url ?? '').trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const href = url.toString();
    if (out.some((s) => s.url === href)) continue;
    out.push({ title: clean(raw.title, titleMax) || url.hostname, url: href });
  }
  return out.slice(0, max);
}

/** The Lorebase row of an idea (kind `Idea`), full state. */
export function ideaRow(i: Idea, session: string): Record<string, unknown> {
  return {
    code: i.code, title: i.title, problem: i.problem, users: i.users, solution: i.solution, differentiation: i.differentiation, feasibility: i.feasibility,
    risks: i.risks, tags: i.tags, stage: i.stage, champion: i.champion ?? '', authors: i.authors, scores: i.scores ?? {}, branch: i.branch,
    proposal_id: i.proposalId ?? '', quarter: i.quarter, signals: i.signals, sources: i.sources, history: i.history, decision: i.decision ?? {}, session,
    day: i.history[0]?.at.day ?? 0,
    // Written once an idea has had a run (an empty object once it is let go).
    ...(i.committeeRun !== undefined ? { committee_run: i.committeeRun ?? {} } : {}),
  };
}

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v ?? fallback) as T;
};

/** An idea read back from its Lorebase Record (reviews are attached separately). */
export function ideaFromRecord(r: Pick<RecordItem, 'key' | 'values'>): Idea {
  const v = r.values;
  const scores = json<Partial<Scores>>(v.scores, {});
  const decision = json<Idea['decision'] | Record<string, never>>(v.decision, {});
  const run = json<Partial<CommitteeRunRef>>(v.committee_run, {});
  const committeeRun = typeof run.runId === 'string' && run.runId && typeof run.configHash === 'string' ? { runId: run.runId, configHash: run.configHash, ...(typeof run.wait === 'string' && run.wait ? { wait: run.wait } : {}) } : undefined;
  return {
    code: String(v.code ?? r.key), title: String(v.title ?? ''), problem: String(v.problem ?? ''), users: String(v.users ?? ''), solution: String(v.solution ?? ''),
    differentiation: String(v.differentiation ?? ''), feasibility: String(v.feasibility ?? ''), risks: String(v.risks ?? ''),
    tags: json<string[]>(v.tags, []), stage: (IDEA_STAGES as readonly string[]).includes(String(v.stage)) ? (String(v.stage) as IdeaStage) : 'signal',
    champion: v.champion ? String(v.champion) : null, authors: json<string[]>(v.authors, []),
    scores: SCORE_KEYS.every((k) => typeof scores[k] === 'number') ? (scores as Scores) : null, reviews: [], branch: String(v.branch ?? ''),
    proposalId: v.proposal_id ? String(v.proposal_id) : null, quarter: String(v.quarter ?? ''), history: json<IdeaEvent[]>(v.history, []),
    signals: json<string[]>(v.signals, []), sources: json<IdeaSource[]>(v.sources, []), evidence: [], decision: decision && 'decision' in decision ? (decision as Idea['decision']) : null,
    ...(committeeRun ? { committeeRun } : {}),
  };
}

export function reviewFromRecord(v: Record<string, unknown>): { idea: string; review: IdeaReview } {
  const scores = {} as Scores;
  for (const k of SCORE_KEYS) scores[k] = score(v[k]) ?? 0;
  return { idea: String(v.idea ?? ''), review: { by: String(v.reviewer ?? ''), scores, comment: String(v.comment ?? ''), at: { day: Number(v.day ?? 0), minute: Number(v.minute ?? 0) } } };
}

export interface IdeaFilter {
  stage?: string;
  tag?: string;
  author?: string;
}

/** Ideas matching a filter (stage, tag, author or champion name, case-insensitive). Pure. */
export function filterIdeas(list: Idea[], f: IdeaFilter): Idea[] {
  const low = (s: string | undefined) => s?.trim().toLowerCase() || undefined;
  const stage = low(f.stage);
  const tag = low(f.tag);
  const author = low(f.author);
  return list.filter((i) => (!stage || i.stage === stage)
    && (!tag || i.tags.includes(tag))
    && (!author || i.authors.some((a) => a.toLowerCase() === author) || i.champion?.toLowerCase() === author));
}

export class IdeaBook {
  readonly ideas = new Map<string, Idea>();
  private readonly client: LorebaseClient;
  private readonly cfg: IdeasConfig;
  private readonly main: string;
  private readonly session: string;
  private readonly events: IdeaEvents;
  /** Writes of each idea run in order (one chain per idea). */
  private readonly chains = new Map<string, Promise<void>>();
  /** When each pitch was submitted (game clock), so the committee takes the oldest first. */
  private readonly submittedAt = new Map<string, number>();
  private seq = 0;
  writes = 0;
  lastError: string | undefined;

  constructor(client: LorebaseClient, main: string, cfg: IdeasConfig, session: string, events: IdeaEvents) {
    this.client = client;
    this.main = main;
    this.cfg = cfg;
    this.session = session;
    this.events = events;
  }

  list(f: IdeaFilter = {}): Idea[] {
    return filterIdeas([...this.ideas.values()], f);
  }

  get(code: string): Idea | undefined {
    return this.ideas.get(code.trim()) ?? [...this.ideas.values()].find((i) => i.code.toLowerCase() === code.trim().toLowerCase());
  }

  openBy(name: string): Idea[] {
    return [...this.ideas.values()].filter((i) => !isClosed(i) && i.champion === name);
  }

  /** Game clock at which a pitch was submitted (0 when it predates this run), undefined when it is not waiting. */
  submittedClock(code: string): number | undefined {
    return this.submittedAt.get(code);
  }

  /** Keeps (or, with null, forgets) the committee run that waits on an idea's resubmission. */
  setCommitteeRun(code: string, run: CommitteeRunRef | null): void {
    const i = this.get(code);
    // An idea that never had a run has nothing to forget (and nothing to write).
    if (i && (run || i.committeeRun)) i.committeeRun = run;
  }

  /** Ideas waiting for the committee, oldest submission first. */
  pitches(): Idea[] {
    return [...this.ideas.values()].filter((i) => i.stage === 'pitch').sort((a, b) => (this.submittedAt.get(a.code) ?? 0) - (this.submittedAt.get(b.code) ?? 0));
  }

  private note(i: Idea, at: At, by: string, action: string, note = ''): void {
    i.history.push({ at, by, action, note: note.slice(0, this.cfg.textMaxChars) });
    if (i.history.length > this.cfg.historyMax) i.history.splice(0, i.history.length - this.cfg.historyMax);
  }

  /** Queues a write of the idea's full state (and, optionally, one review) on its branch. */
  private persist(i: Idea, review?: IdeaReview, after?: () => Promise<void>, evidence?: Evidence): Promise<void> {
    const row = ideaRow(i, this.session);
    const reviewRow = review && {
      code: `${i.code}--${slug(review.by)}`, idea: i.code, reviewer: review.by, ...review.scores, comment: review.comment, day: review.at.day, minute: Math.floor(review.at.minute),
    };
    const evidenceRec = evidence && evidenceRow(evidence, this.session);
    const prev = this.chains.get(i.code) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await this.retry(() => this.client.execute(this.cfg.writeOperation, { kind: this.cfg.kind, rows: [row] }, { branch: i.branch, message: `Idea ${i.code}: ${i.stage}`, idempotencyKey: randomUUID() }));
        if (reviewRow) await this.retry(() => this.client.execute(this.cfg.writeOperation, { kind: this.cfg.reviewKind, rows: [reviewRow] }, { branch: i.branch, message: `Review of ${i.code} by ${review!.by}`, idempotencyKey: randomUUID() }));
        if (evidenceRec) await this.retry(() => this.client.execute(this.cfg.writeOperation, { kind: this.cfg.evidenceKind, rows: [evidenceRec] }, { branch: i.branch, message: `Evidence for ${i.code}: ${evidence!.type} by ${evidence!.collected_by}`, idempotencyKey: randomUUID() }));
        if (after) await this.retry(after);
        this.writes++;
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[ideas] write of ${i.code} failed: ${this.lastError}`);
      }
    });
    this.chains.set(i.code, next);
    return next;
  }

  /** Runs a Keeper call again after 429 or 5xx (rate limits, restarts), with backoff. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await fn();
      } catch (err) {
        const status = err instanceof LorebaseError ? err.status : 0;
        if (n >= this.cfg.retries || (status !== 429 && status < 500)) throw err;
        const after = Number((err as LorebaseError).body && ((err as LorebaseError).body as Record<string, unknown>).retry_after_s);
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : this.cfg.retryBaseMs * 2 ** n));
      }
    }
  }

  /** Waits for every queued write (shutdown, tests). */
  async settle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** A new idea on its own branch. Returns it, or an error code. */
  async create(author: string, input: IdeaInput, ctx: { at: At; quarter: string; signals: string[]; maxOpen: number }): Promise<Idea | string> {
    if (!this.cfg.enabled) return 'disabled';
    const title = clean(input.title, this.cfg.titleMaxChars);
    if (!title) return 'empty_title';
    const problem = clean(input.problem, this.cfg.textMaxChars);
    if (!problem) return 'empty_problem';
    if (this.openBy(author).length >= ctx.maxOpen) return 'too_many_ideas';
    if ([...this.ideas.values()].some((i) => i.title.toLowerCase() === title.toLowerCase())) return 'duplicate_idea';
    const code = `${slug(title)}-${Date.now().toString(36).slice(-4)}${(++this.seq).toString(36)}`;
    const fields = Object.fromEntries(IDEA_FIELDS.map((k) => [k, k === 'problem' ? problem : clean(input[k], this.cfg.textMaxChars)])) as Record<IdeaField, string>;
    const idea: Idea = {
      code, title, ...fields, tags: tagsFrom(input.tags, this.cfg.tagsMax, this.cfg.tagMaxChars), stage: stageFromFields(fields), champion: author, authors: [author],
      scores: null, reviews: [], branch: `${this.cfg.branchPrefix}${code}`, proposalId: null, quarter: ctx.quarter, history: [], signals: ctx.signals.slice(0, this.cfg.signalsMax),
      sources: sourcesFrom(input.sources, this.cfg.sourcesMax, this.cfg.sourceTitleMaxChars), evidence: [], decision: null,
    };
    this.note(idea, ctx.at, author, 'created');
    try {
      await this.client.createBranch(idea.branch, this.main);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.ideas.set(code, idea);
    void this.persist(idea);
    this.events.changed(idea, 'created', author);
    return idea;
  }

  /**
   * Adds or rewrites fields. The editor becomes a co-author, unless `asAuthor` is false (policy comitato_non_coautore):
   * then the edit is recorded as a reviewer's contribution and the authors stay as they are. Returns the idea or an error code.
   */
  enrich(code: string, by: string, input: IdeaInput, ctx: { at: At; signals: string[]; asAuthor?: boolean }): Idea | string {
    const i = this.get(code);
    if (!i) return 'unknown_idea';
    if (!isOpen(i)) return 'idea_closed';
    const changed: string[] = [];
    for (const k of ['title', ...IDEA_FIELDS] as const) {
      const v = clean(input[k], k === 'title' ? this.cfg.titleMaxChars : this.cfg.textMaxChars);
      if (v && v !== i[k]) {
        i[k] = v;
        changed.push(k);
      }
    }
    const tags = tagsFrom(input.tags, this.cfg.tagsMax, this.cfg.tagMaxChars).filter((x) => !i.tags.includes(x));
    if (tags.length) {
      i.tags = [...i.tags, ...tags].slice(0, this.cfg.tagsMax);
      changed.push('tags');
    }
    const signals = ctx.signals.filter((s) => !i.signals.includes(s));
    if (signals.length) {
      i.signals = [...i.signals, ...signals].slice(0, this.cfg.signalsMax * 2);
      changed.push('signals');
    }
    const sources = sourcesFrom(input.sources, this.cfg.sourcesMax, this.cfg.sourceTitleMaxChars).filter((x) => !i.sources.some((s) => s.url === x.url));
    if (sources.length) {
      i.sources = [...i.sources, ...sources].slice(0, this.cfg.sourcesMax);
      changed.push('sources');
    }
    if (!changed.length) return 'nothing_changed';
    const author = ctx.asAuthor !== false || i.authors.includes(by) || i.champion === by;
    if (author && !i.authors.includes(by)) i.authors.push(by);
    this.note(i, ctx.at, by, author ? 'updated' : 'contributed', changed.join(', '));
    const before = i.stage;
    const stage = stageFromFields(i);
    if (ORDER[stage] > ORDER[i.stage]) {
      i.stage = stage;
      this.note(i, ctx.at, by, 'stage', `${before} -> ${stage}`);
    }
    void this.persist(i);
    this.events.changed(i, 'updated', by);
    if (i.stage !== before) this.events.changed(i, 'stage', by);
    return i;
  }

  /** A peer review (one per reviewer, a new one replaces the old). Returns the idea or an error code. */
  review(code: string, by: string, scores: Scores, comment: string, at: At): Idea | string {
    const i = this.get(code);
    if (!i) return 'unknown_idea';
    if (isClosed(i)) return 'idea_closed';
    if (i.authors.includes(by) || i.champion === by) return 'own_idea';
    const r: IdeaReview = { by, scores, comment: clean(comment, this.cfg.commentMaxChars), at };
    i.reviews = [...i.reviews.filter((x) => x.by !== by), r];
    i.scores = aggregate(i.reviews);
    this.note(i, at, by, 'reviewed', r.comment);
    // A fact, not a block: the same five scores as a review already there.
    const same = sameScores(i.reviews, r);
    if (same.length) this.note(i, at, by, 'scores_match', same.join(', '));
    void this.persist(i, r);
    this.events.changed(i, 'reviewed', by);
    return i;
  }

  /**
   * A piece of evidence for an idea (anyone may bring it; the idea must not be decided). The same URL, or the same
   * person speaking for the same role, is kept once: a new validation replaces the old one. Returns it or an error code.
   */
  addEvidence(code: string, ev: Omit<Evidence, 'code' | 'idea'>): Evidence | string {
    const i = this.get(code);
    if (!i) return 'unknown_idea';
    if (isClosed(i)) return 'idea_closed';
    if (ev.url && i.evidence.some((x) => x.url === ev.url)) return 'duplicate_evidence';
    const same = (x: Evidence) => ev.type === 'human_validation' && x.type === 'human_validation' && x.collected_by === ev.collected_by && x.role === ev.role;
    const kept = i.evidence.filter((x) => !same(x));
    if (kept.length >= this.cfg.evidenceMax) return 'too_much_evidence';
    const prev = i.evidence.find(same);
    const e: Evidence = { ...ev, idea: i.code, code: prev?.code ?? `${i.code}--ev${(++this.seq).toString(36)}${Date.now().toString(36).slice(-3)}` };
    i.evidence = [...kept, e];
    this.note(i, ev.collected_at, ev.collected_by, 'evidence', `${ev.type}: ${ev.title}`);
    void this.persist(i, undefined, undefined, e);
    this.events.changed(i, 'evidence', ev.collected_by);
    return e;
  }

  /** Puts a complete, reviewed idea before the committee: opens its Proposal into main. */
  async submit(code: string, by: string, ctx: { at: At; clock: number; minReviewers: number; gate?: (i: Idea) => string | undefined }): Promise<Idea | string> {
    const i = this.get(code);
    if (!i) return 'unknown_idea';
    if (i.stage === 'pitch') return 'already_submitted';
    if (isClosed(i)) return 'idea_closed';
    if (i.stage !== 'proposal') return 'not_complete';
    if (!i.authors.includes(by) && i.champion !== by) return 'not_author';
    if (i.reviews.length < ctx.minReviewers) return 'few_reviews';
    // A deferred idea goes back only after something changed (a field or a review).
    if (i.history.at(-1)?.action === 'deferred') return 'unchanged_since_deferral';
    // Policy requisiti_candidatura_*: the evidence the idea must carry (the reason says what is missing).
    const gate = ctx.gate?.(i);
    if (gate) return gate;
    await (this.chains.get(i.code) ?? Promise.resolve());
    if (!i.proposalId) {
      try {
        const p = await this.client.createProposal(i.branch, this.main, `Idea: ${i.title}`.slice(0, 200), `${i.problem}\n\nChampion: ${i.champion ?? '-'}; authors: ${i.authors.join(', ')}.`);
        i.proposalId = p.id;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    i.stage = 'pitch';
    this.submittedAt.set(i.code, ctx.clock);
    this.note(i, ctx.at, by, 'submitted');
    void this.persist(i);
    this.events.changed(i, 'submitted', by);
    return i;
  }

  /**
   * The committee's decision. approve: stage approved, the Proposal approved and merged (portfolio);
   * kill: stage killed with the reason, the Proposal closed (the branch keeps the record); defer: back to
   * proposal (the Proposal stays open for a later submission).
   */
  decide(
    code: string, decision: CommitteeDecision, summary: string, votes: CommitteeVote[], at: At, by: string, recused: string[] = [],
    record: { unmet?: string[]; outOfPolicy?: string[]; phase?: string; slotsSpent?: number } = {},
  ): Idea | string {
    const i = this.get(code);
    if (!i) return 'unknown_idea';
    if (i.stage !== 'pitch') return 'not_submitted';
    const text = clean(summary, this.cfg.textMaxChars);
    const extra = Object.fromEntries(Object.entries(record).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '' && v !== 0)));
    i.decision = { decision, summary: text, at, votes, ...(recused.length ? { recused } : {}), ...extra };
    if (recused.length) this.note(i, at, by, 'recused', recused.join(', '));
    this.submittedAt.delete(i.code);
    const proposal = i.proposalId;
    if (decision === 'defer') {
      i.stage = 'proposal';
      this.note(i, at, by, 'deferred', text);
      void this.persist(i);
      this.events.changed(i, 'stage', by);
      return i;
    }
    i.stage = decision === 'approve' ? 'approved' : 'killed';
    this.note(i, at, by, i.stage, text);
    const note = `Investment committee: ${decision}${text ? ` - ${text}` : ''}`.slice(0, 500);
    void this.persist(i, undefined, async () => {
      if (!proposal) return;
      if (decision === 'approve') {
        await this.client.review(proposal, 'approve', note);
        await this.client.merge(proposal, `Idea approved: ${i.title}`.slice(0, 200));
        // In main now (the portfolio): the branch has done its work. A killed idea keeps its branch.
        await this.client.deleteBranch(i.branch).catch(() => undefined);
      } else {
        await this.client.review(proposal, 'request_changes', note).catch(() => undefined);
        await this.client.closeProposal(proposal);
      }
    });
    this.events.changed(i, decision === 'approve' ? 'approved' : 'killed', by);
    return i;
  }

  /**
   * After a restart: approved ideas (and their reviews) from main, the others from their `idea/` branches,
   * with the open Proposals of submitted ones. Returns counts.
   */
  async reconcile(): Promise<{ portfolio: number; pipeline: number }> {
    const out = { portfolio: 0, pipeline: 0 };
    if (!this.cfg.enabled) return out;
    const read = async (kind: string, branch: string) => (await this.client.listRecords(kind, branch).catch(() => ({ items: [] as RecordItem[] }))).items;
    const attach = (items: RecordItem[]) => {
      for (const r of items) {
        const { idea, review } = reviewFromRecord(r.values);
        const i = this.ideas.get(idea);
        if (i && !i.reviews.some((x) => x.by === review.by)) i.reviews.push(review);
      }
    };
    for (const r of await read(this.cfg.kind, this.main)) {
      const i = ideaFromRecord(r);
      this.ideas.set(i.code, i);
      out.portfolio++;
    }
    attach(await read(this.cfg.reviewKind, this.main));
    const attachEvidence = (items: RecordItem[]) => {
      for (const r of items) {
        const ev = evidenceFromRecord(r.values);
        const i = this.ideas.get(ev.idea);
        if (i && !i.evidence.some((x) => x.code === ev.code)) i.evidence.push(ev);
      }
    };
    attachEvidence(await read(this.cfg.evidenceKind, this.main));
    const open = await this.client.listProposals('open').catch(() => []);
    for (const b of await this.client.listBranches().catch(() => [])) {
      if (!b.name.startsWith(this.cfg.branchPrefix)) continue;
      const rec = (await read(this.cfg.kind, b.name)).find((r) => String(r.values.branch ?? '') === b.name);
      if (!rec) continue;
      const i = ideaFromRecord(rec);
      if (this.ideas.has(i.code)) continue;
      i.proposalId = open.find((p) => p.source_ref === b.name && p.target_ref === this.main)?.id ?? (i.stage === 'pitch' ? null : i.proposalId);
      if (i.stage === 'pitch' && !i.proposalId) i.stage = 'proposal';
      this.ideas.set(i.code, i);
      attach((await read(this.cfg.reviewKind, b.name)).filter((r) => String(r.values.idea) === i.code));
      attachEvidence((await read(this.cfg.evidenceKind, b.name)).filter((r) => String(r.values.idea) === i.code));
      out.pipeline++;
    }
    for (const i of this.ideas.values()) {
      i.scores = aggregate(i.reviews) ?? i.scores;
      if (i.stage === 'pitch') this.submittedAt.set(i.code, 0);
    }
    return out;
  }
}

/** Labels of the markdown export (from i18n). */
export type ExportLabel = (key: string, vars?: Record<string, string | number>) => string;

/** The portfolio as markdown: approved ideas, then the pipeline by stage, then the killed ones. Pure. */
export function exportMarkdown(ideas: Idea[], l: ExportLabel, weights: Scores, company: { name: string; quarter: string }): string {
  const out: string[] = [l('title', { name: company.name, quarter: company.quarter }), ''];
  const block = (i: Idea) => {
    const lines = [`### ${i.title} (\`${i.code}\`)`, ''];
    lines.push(`- ${l('stage')}: ${l(`stages.${i.stage}`)}; ${l('champion')}: ${i.champion ?? '-'}; ${l('authors')}: ${i.authors.join(', ') || '-'}; ${l('quarter')}: ${i.quarter || '-'}`);
    if (i.tags.length) lines.push(`- ${l('tags')}: ${i.tags.join(', ')}`);
    for (const k of IDEA_FIELDS) if (i[k]) lines.push(`- **${l(`fields.${k}`)}**: ${i[k]}`);
    if (i.scores) {
      const w = weightedScore(i.scores, weights);
      lines.push(`- ${l('scores')}: ${SCORE_KEYS.map((k) => `${l(`score.${k}`)} ${i.scores![k]}`).join(', ')}${w === null ? '' : `; ${l('weighted')} ${w}`} (${l('reviews', { n: i.reviews.length })})`);
    }
    for (const r of i.reviews) lines.push(`  - ${r.by}: ${r.comment || '-'}`);
    if (i.sources?.length) lines.push(`- ${l('sources')}: ${i.sources.map((s) => `[${s.title.replace(/[[\]]/g, '')}](${s.url})`).join(', ')}`);
    if (i.evidence?.length) {
      lines.push(`- ${l('evidence', { n: i.evidence.length })}:`);
      for (const e of i.evidence) {
        const what = e.url ? `[${e.title.replace(/[[\]]/g, '')}](${e.url})` : e.title;
        const metric = e.metric !== null ? `, ${e.metric_name} ${e.metric}` : '';
        lines.push(`  - ${l(`evidenceType.${e.type}`)} (${e.source}${metric}; ${l('weight')} ${e.weight}${e.label ? `; ${e.label}` : ''}): ${what}${e.excerpt ? ` - ${e.excerpt.slice(0, 200)}` : ''} (${e.collected_by})`);
      }
    }
    if (i.decision) {
      const d = i.decision;
      lines.push(`- ${l('decision')}: ${l(`decisions.${d.decision}`)}${d.summary ? ` - ${d.summary}` : ''}`);
      if (d.phase) lines.push(`  - ${l('phase')}: ${d.phase}`);
      if (d.unmet?.length) lines.push(`  - ${l('unmet')}: ${d.unmet.join(', ')}`);
      if (d.slotsSpent) lines.push(`  - ${l('slotsSpent', { n: d.slotsSpent })}`);
      for (const v of d.votes) {
        const crit = v.criteria ? Object.entries(v.criteria).map(([k, c]) => `${k} ${c.met ? l('met') : l('notMet')}`).join(', ') : '';
        lines.push(`  - ${l('vote', { member: v.name ?? v.member, vote: l(`decisions.${v.vote}`) })}${crit ? ` (${crit})` : ''}: ${v.reason || '-'}`);
        for (const x of v.outOfPolicy ?? []) lines.push(`    - ${l('outOfPolicy')}: ${x}`);
      }
      for (const x of d.outOfPolicy ?? []) lines.push(`  - ${l('outOfPolicy')}: ${x}`);
    }
    lines.push('');
    return lines.join('\n');
  };
  const approved = ideas.filter((i) => i.stage === 'approved');
  out.push(`## ${l('approved')} (${approved.length})`, '');
  out.push(...(approved.length ? approved.map(block) : [`${l('none')}`, '']));
  const pipeline = ideas.filter((i) => !isClosed(i)).sort((a, b) => ORDER[b.stage] - ORDER[a.stage]);
  out.push(`## ${l('pipeline')} (${pipeline.length})`, '');
  out.push(...(pipeline.length ? pipeline.map(block) : [`${l('none')}`, '']));
  const killed = ideas.filter((i) => i.stage === 'killed');
  out.push(`## ${l('killed')} (${killed.length})`, '');
  out.push(...(killed.length ? killed.map(block) : [`${l('none')}`, '']));
  return out.join('\n');
}
