// Read-only overview of the three systems behind the world (Lorebase, mnemo, reinloop), for the
// Observatory view. Server-side proxies only, each answer cached for `cacheMs` so a busy view
// never multiplies calls to Keeper or mnemo.
import { pricingFor } from 'reinloop';
import type { LorebaseClient } from '../lorebase/client.ts';
import type { Mnemo } from './mnemo.ts';

export interface ObservatoryConfig {
  cacheMs: number;
  maxLimit: number;
  /** Kinds whose Records may be listed through the proxy. */
  kinds: string[];
}

/** Token counts of one model run as reinloop reports them (`inputTokens` includes cache reads and writes). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Part of `cacheWriteTokens` written with the 1-hour lifetime. */
  cacheWrite1hTokens?: number;
}

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens'] as const;
type TokenCounts = Record<(typeof TOKEN_KEYS)[number], number>;
const zeroTokens = (): TokenCounts => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 });
const tokensOf = (u: TokenUsage | undefined): TokenCounts => Object.fromEntries(TOKEN_KEYS.map((k) => [k, u?.[k] ?? 0])) as TokenCounts;
/** Usage as reinloop shapes it: input and output always, cache counts only when present. */
const usageOf = (c: TokenCounts): TokenUsage => ({
  inputTokens: c.inputTokens, outputTokens: c.outputTokens,
  ...(c.cacheReadTokens && { cacheReadTokens: c.cacheReadTokens }),
  ...(c.cacheWriteTokens && { cacheWriteTokens: c.cacheWriteTokens }),
  ...(c.cacheWrite1hTokens && { cacheWrite1hTokens: c.cacheWrite1hTokens }),
});

/**
 * What prompt caching saved on one run, in USD, against the same tokens sent uncached: reads priced at the
 * cache-read rate instead of the input rate, minus the premium paid on cache writes. Unknown model: 0.
 */
export function cacheSavingsUsd(model: string, u: TokenUsage): number {
  const p = pricingFor(model.slice(model.indexOf('/') + 1));
  if (!p) return 0;
  const read = u.cacheReadTokens ?? 0;
  const written = u.cacheWriteTokens ?? 0;
  const written1h = Math.min(u.cacheWrite1hTokens ?? 0, written);
  const w5 = p.cacheWriteMultiplier ?? 1;
  const w1 = p.cacheWrite1hMultiplier ?? w5;
  const saved = read * (p.inputPerMTok - (p.cacheReadPerMTok ?? p.inputPerMTok)) - ((written - written1h) * (w5 - 1) + written1h * (w1 - 1)) * p.inputPerMTok;
  return saved / 1_000_000;
}

/** Model usage per agent, from the end of each reinloop run. */
export interface UsageRow extends TokenCounts {
  agentId: string;
  name: string;
  model: string;
  tier: string;
  /** What spent it: `minds` (decisions, replies, groups) or the tool that made its own model calls (web_search, intervista_simulata). */
  tool: string;
  runs: number;
  failures: number;
  costUsd: number;
  /** USD prompt caching saved (negative while writes have not been read back yet). */
  cacheSavedUsd: number;
}

type RunUsage = { status: string; usage?: TokenUsage; costUsd?: number };

export interface CacheStats {
  readTokens: number;
  writeTokens: number;
  write1hTokens: number;
  /** Share of all input tokens served from the cache. */
  hitRatio: number;
  savedUsd: number;
}

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;

type Who = { id: string; name: string; model: string; tier: string; tool?: string };

export class UsageLedger {
  readonly rows = new Map<string, UsageRow>();
  private row(who: Who): UsageRow {
    let row = this.rows.get(who.id);
    if (!row) {
      row = { agentId: who.id, name: who.name, model: who.model, tier: who.tier, tool: who.tool ?? 'minds', runs: 0, failures: 0, ...zeroTokens(), costUsd: 0, cacheSavedUsd: 0 };
      this.rows.set(who.id, row);
    }
    return row;
  }
  /** One run ended (failed unless it completed, was stopped or interrupted). */
  ended(who: Who, status: string): void {
    const row = this.row(who);
    row.runs++;
    if (!['completed', 'stopped', 'interrupted'].includes(status)) row.failures++;
  }
  /** One model call: its tokens (cache counts included), price and what caching saved on it. */
  called(who: Who, usage: TokenUsage | undefined, costUsd = 0): void {
    const row = this.row(who);
    const t = tokensOf(usage);
    for (const k of TOKEN_KEYS) row[k] += t[k];
    row.costUsd += costUsd;
    row.cacheSavedUsd += cacheSavingsUsd(who.model, t);
  }
  /** A whole run at once: for callers that only know its end (tools with a model call of their own). */
  track(who: Who, res: RunUsage): void {
    this.ended(who, res.status);
    this.called(who, res.usage, res.costUsd);
  }
  totalUsd(): number {
    let sum = 0;
    for (const r of this.rows.values()) sum += r.costUsd;
    return sum;
  }
  /** Totals grouped by a key (model, tier or tool). */
  by(key: 'model' | 'tier' | 'tool'): Record<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const out: Record<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
    for (const r of this.rows.values()) {
      const o = (out[r[key]] ??= { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      o.runs += r.runs;
      o.inputTokens += r.inputTokens;
      o.outputTokens += r.outputTokens;
      o.costUsd = round(o.costUsd + r.costUsd);
    }
    return out;
  }
  /** Prompt-cache totals over the given rows (default: all). */
  cache(rows: Iterable<UsageRow> = this.rows.values()): CacheStats {
    let input = 0, read = 0, write = 0, write1h = 0, saved = 0;
    for (const r of rows) {
      input += r.inputTokens;
      read += r.cacheReadTokens;
      write += r.cacheWriteTokens;
      write1h += r.cacheWrite1hTokens;
      saved += r.cacheSavedUsd;
    }
    return { readTokens: read, writeTokens: write, write1hTokens: write1h, hitRatio: input ? round(read / input, 4) : 0, savedUsd: round(saved) };
  }
  /** Prompt-cache totals grouped by a key (model or tier). */
  cacheBy(key: 'model' | 'tier'): Record<string, CacheStats> {
    const groups = new Map<string, UsageRow[]>();
    for (const r of this.rows.values()) groups.set(r[key], [...(groups.get(r[key]) ?? []), r]);
    return Object.fromEntries([...groups].map(([k, rows]) => [k, this.cache(rows)]));
  }
}

/**
 * Splits the usage of a team run among the model runs nested in it, so each member's model is
 * booked with its own cost. A member called again resumes its run and reports cumulative totals:
 * only the increase since its previous end is booked.
 */
export class NestedUsage {
  private readonly modelRuns = new Set<string>();
  private readonly last = new Map<string, { costUsd: number; tokens: TokenCounts }>();
  private readonly bookedTokens = zeroTokens();
  readonly booked = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

  /** Feeds one run event; returns the usage to book when a nested model run ends. */
  onEvent(ev: { type: string; runId: string; parentRunId?: string; data: unknown }): RunUsage | undefined {
    if (ev.type === 'model_request') this.modelRuns.add(ev.runId);
    if (ev.type !== 'run_end' || !ev.parentRunId || !this.modelRuns.has(ev.runId)) return undefined;
    const end = ev.data as RunUsage;
    const now = { costUsd: end.costUsd ?? 0, tokens: tokensOf(end.usage) };
    const prev = this.last.get(ev.runId) ?? { costUsd: 0, tokens: zeroTokens() };
    this.last.set(ev.runId, now);
    const d = zeroTokens();
    for (const k of TOKEN_KEYS) {
      d[k] = Math.max(0, now.tokens[k] - prev.tokens[k]);
      this.bookedTokens[k] += d[k];
    }
    const cost = Math.max(0, now.costUsd - prev.costUsd);
    this.booked.costUsd += cost;
    this.booked.inputTokens = this.bookedTokens.inputTokens;
    this.booked.outputTokens = this.bookedTokens.outputTokens;
    return { status: end.status, usage: usageOf(d), costUsd: cost };
  }

  /** What the whole run cost beyond the nested runs already booked. */
  remainder(res: RunUsage): RunUsage {
    const all = tokensOf(res.usage);
    const d = zeroTokens();
    for (const k of TOKEN_KEYS) d[k] = Math.max(0, all[k] - this.bookedTokens[k]);
    return { status: res.status, usage: usageOf(d), costUsd: Math.max(0, (res.costUsd ?? 0) - this.booked.costUsd) };
  }
}

export interface ObservatoryHost {
  client: LorebaseClient;
  mnemo: Mnemo;
  branch: string;
  revision(): string;
  agents(): Array<{ id: string; name: string; key: string }>;
  stats(): Record<string, number | Record<string, number>>;
  /** Spans of the agent stacks and group systems added up by name. */
  stack?(): Record<string, { count: number; errors: number; totalMs: number; maxMs: number }>;
  usage: UsageLedger;
}

const usd = (m: Record<string, { costUsd: number }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.costUsd]));

export class Observatory {
  private readonly host: ObservatoryHost;
  private readonly cfg: ObservatoryConfig;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(host: ObservatoryHost, cfg: ObservatoryConfig) {
    this.host = host;
    this.cfg = cfg;
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cfg.cacheMs) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private limit(raw: string | null, fallback: number): number {
    const n = Math.floor(Number(raw));
    return Math.max(1, Math.min(this.cfg.maxLimit, Number.isFinite(n) && n > 0 ? n : fallback));
  }

  private get base(): string {
    return `${this.host.client.url}/api/v1/domains/${encodeURIComponent(this.host.client.domain)}`;
  }

  /** Routes GET /api/observatory/*; undefined when the path is not one of ours. */
  async handle(path: string, q: URLSearchParams): Promise<{ status: number; body: unknown } | undefined> {
    const sub = path.replace(/^\/api\/observatory\/?/, '');
    try {
      if (sub === 'summary') return { status: 200, body: await this.cached('summary', () => this.summary()) };
      if (sub === 'log') {
        const limit = this.limit(q.get('limit'), 50);
        return { status: 200, body: await this.cached(`log:${limit}`, () => this.log(limit)) };
      }
      if (sub === 'proposals') {
        const status = q.get('status') ?? 'open';
        return { status: 200, body: await this.cached(`proposals:${status}`, () => this.host.client.request('GET', `${this.base}/proposals?${new URLSearchParams({ status, limit: String(this.cfg.maxLimit) })}`)) };
      }
      const rec = /^records\/([A-Za-z]+)$/.exec(sub);
      if (rec) {
        const kind = rec[1]!;
        if (!this.cfg.kinds.includes(kind)) return { status: 404, body: { ok: false, error: 'kind not exposed' } };
        const limit = this.limit(q.get('limit'), 100);
        return { status: 200, body: await this.cached(`records:${kind}:${limit}`, async () => (await this.host.client.listRecords(kind, this.host.branch)).items.slice(-limit).map((r) => r.values)) };
      }
      if (sub === 'memories') {
        const limit = this.limit(q.get('limit'), 50);
        const offset = Math.max(0, Math.floor(Number(q.get('offset')) || 0));
        const agents = this.host.agents().slice(offset, offset + limit);
        const body = await this.cached(`memories:${offset}:${limit}`, async () => ({
          offset, total: this.host.agents().length,
          agents: await Promise.all(agents.map(async (a) => ({ agentId: a.id, name: a.name, memories: await this.host.mnemo.list(a.key).catch(() => []) }))),
        }));
        return { status: 200, body };
      }
      return { status: 404, body: { ok: false, error: 'not found' } };
    } catch (err) {
      return { status: 502, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async log(limit: number): Promise<unknown> {
    const page = await this.host.client.request<{ items: Array<Record<string, unknown>> }>('GET', `${this.base}/branches/${encodeURIComponent(this.host.branch)}/log?limit=${limit}`);
    return page.items.map((r) => ({ revision: r.id, message: r.message, time: r.created_at, author: r.author, origin: (r.origin as { type?: string } | undefined)?.type ?? null, changes: (r.stats as { changes?: number } | undefined)?.changes ?? null }));
  }

  private async summary(): Promise<unknown> {
    const branch = await this.host.client.getBranch(this.host.branch);
    const counts: Record<string, number> = {};
    const c = await this.host.client.request<{ partitions: Array<{ element: string; name: string; count: number }> }>('GET', `${this.base}/revisions/${branch.head}/counts`).catch(() => ({ partitions: [] }));
    for (const p of c.partitions) if (p.element === 'kind' && this.cfg.kinds.includes(p.name)) counts[p.name] = p.count;
    const health = await this.host.mnemo.health().catch(() => undefined);
    const perAgent = await Promise.all(this.host.agents().map(async (a) => {
      const list = await this.host.mnemo.list(a.key).catch(() => []);
      const avg = list.length ? list.reduce((s, m) => s + m.fidelity, 0) / list.length : 0;
      return { agentId: a.id, name: a.name, count: list.length, avgFidelity: Math.round(avg * 1000) / 1000, gists: list.filter((m) => m.kind === 'gist').length };
    }));
    const u = this.host.usage;
    const rows = [...u.rows.values()];
    return {
      lorebase: { url: this.host.client.url, domain: this.host.client.domain, branch: this.host.branch, revision: branch.head, counts },
      mnemo: { connected: !!health, memories: health?.memories ?? null, perAgent, dbBytes: health?.dbBytes ?? null, lastCompaction: health?.lastCompaction ?? null, embedder: health?.embedder ?? null },
      reinloop: {
        ...this.host.stats(),
        runs: rows.reduce((s, r) => s + r.runs, 0),
        tokens: { input: rows.reduce((s, r) => s + r.inputTokens, 0), output: rows.reduce((s, r) => s + r.outputTokens, 0) },
        costUsd: { total: Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6, byModel: usd(u.by('model')), byTier: usd(u.by('tier')), byTool: this.byTool() },
        cache: { ...u.cache(), byModel: u.cacheBy('model'), byTier: u.cacheBy('tier') },
      },
      ...(this.host.stack ? { stack: { spans: this.host.stack() } } : {}),
    };
  }

  /** Spend per tool: the minds, each tool with model calls of its own, and the public signals (free APIs, calls only). */
  private byTool(): Record<string, { runs: number; costUsd: number; share: number }> {
    const by = this.host.usage.by('tool');
    const signals = Number(this.host.stats().signalSearches ?? 0);
    const total = Object.values(by).reduce((s, v) => s + v.costUsd, 0);
    const out: Record<string, { runs: number; costUsd: number; share: number }> = {};
    for (const [k, v] of Object.entries(by)) out[k] = { runs: v.runs, costUsd: v.costUsd, share: total > 0 ? Math.round((v.costUsd / total) * 1000) / 1000 : 0 };
    out.segnali_pubblici = { runs: signals, costUsd: 0, share: 0 };
    return out;
  }
}
