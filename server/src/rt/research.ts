// Web research for the people of the hub: reinloop's `web_search` / `web_fetch` behind a desk that applies the
// company policies (daily searches and daily page reads, each per person and in total; excluded domains), caches
// results server-side and reports every call as a `research` event. Web content is untrusted: it is only text handed back to the model,
// never an input to any write.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ANTHROPIC_SERVER_TOOL_USD, anthropicWebProvider, costOf, defineTool, hostedTool, type ModelRef, pricingFor, resolveModel, type Tool, type Usage, userMessage, type WebProvider, webTools } from 'reinloop';
import type { Translate } from '../i18n.ts';
import { availability } from '../models.ts';

export type ResearchProvider = 'tavily' | 'anthropic-native' | 'off';

export interface ResearchConfig {
  /** Search backend; `off` gives nobody the web tools. */
  provider: ResearchProvider;
  /** Results per search the backend returns (the model may ask for fewer, up to `maxResultsCap`). */
  maxResults: number;
  maxResultsCap: number;
  /** Characters kept per snippet and per fetched page (what the model reads). */
  maxChars: number;
  maxFetchChars: number;
  /** Server-side cache of results: lifetime and size. A cached answer does not count against the quotas. */
  cacheTtlMs: number;
  cacheMax: number;
  /** `anthropic-native` only: the model tier that runs the hosted search and page reads (resolved through sim.json `models`). */
  anthropicTier: string;
  /**
   * `anthropic-native` only: page reads through Anthropic's hosted `web_fetch` (`type`, `beta` header, longest page
   * in tokens, output tokens of the call). Absent: no `web_fetch` with that provider.
   */
  anthropicFetch?: { type: string; beta: string; maxContentTokens: number; maxOutputTokens: number };
  /**
   * `web_fetch` hardening: pages may only be read when they came back from the same agent's own searches, or when
   * they are the official source (`url`) of a Signal record the person carries or has read on an idea.
   */
  fetch: {
    /** `search-results-only` (default) | `off` (the tool refuses every call). */
    mode: 'search-results-only' | 'off';
    /** How long a search result stays fetchable, how many are kept per agent, longest URL accepted. */
    allowTtlMs: number;
    allowMax: number;
    maxUrlChars: number;
  };
  /**
   * Policy keys (Lorebase `Rule` records) behind the quotas and the excluded domains: `perPerson` / `total` count
   * searches, `readsPerPerson` / `readsTotal` page reads (without them, reads count against the search quotas).
   */
  policies: { perPerson: string; total: string; readsPerPerson?: string; readsTotal?: string; excludedDomains: string };
  /** Snippets carried by an event (privileged clients only) and their length. */
  eventSnippetChars: number;
  /** Research kept per person for the inspector, and in the run's log (GET /api/research). */
  recentMax: number;
  logMax: number;
}

export interface ResearchSource {
  title: string;
  url: string;
}

/** One search or fetch, as the world reports it (`snippets` are for privileged clients only). */
export interface ResearchEvent {
  tool: 'web_search' | 'web_fetch';
  query?: string;
  url?: string;
  results: ResearchSource[];
  snippets: string[];
  cached: boolean;
}

export interface ResearchHost {
  /** The current value and text of a policy, undefined when it does not exist. */
  policy(key: string): { value: unknown; text: string } | undefined;
  /** Day of the world (quotas are per day). */
  day(): number;
  researched(who: { id: string; name: string }, ev: ResearchEvent): void;
  /** Official source URLs of the Signal records a person carries or has read on an idea (readable with web_fetch). */
  officialUrls?(who: { id: string; name: string }): string[];
  /** The results a person's search returned (title, URL, snippet): they may become evidence. */
  found?(who: { id: string; name: string }, results: Array<{ title: string; url: string; snippet: string }>): void;
  /**
   * `anthropic-native` only: the hosted search's (or page read's) own model call (tokens and per-search fee), booked
   * to the person who searched or read; its cost is not part of that person's run.
   */
  searchUsage?(who: { id: string; name: string }, model: string, usage: Usage, costUsd: number, tool?: ResearchEvent['tool']): void;
}

/** Cost of a hosted search call: tokens at the model's price plus the per-request fees of server tools. Pure. */
export function hostedSearchCost(model: string, usage: Usage): number {
  const p = pricingFor(model.replace(/^[^/]+\//, '')) ?? pricingFor(model);
  if (!p) return Object.entries(usage.serverToolUse ?? {}).reduce((s, [k, n]) => s + n * (ANTHROPIC_SERVER_TOOL_USD[k] ?? 0), 0);
  return costOf({ ...p, serverToolUsd: { ...ANTHROPIC_SERVER_TOOL_USD, ...p.serverToolUsd } }, usage);
}

/** A model whose every call reports its usage (the hosted search runs outside any agent run). */
function metered(ref: ModelRef, onUsage: (model: string, usage: Usage) => void): ModelRef {
  const inner = ref.provider;
  const provider = new Proxy(inner, {
    get(target, key) {
      if (key === 'generate') {
        return async (...args: Parameters<typeof inner.generate>) => {
          const res = await target.generate(...args);
          if (res.usage) onUsage(ref.model, res.usage);
          return res;
        };
      }
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...ref, provider };
}

type WebTools = { web_search: Tool; web_fetch?: Tool };

/** The readable text of a hosted `web_fetch` result block, or an error code. Pure. */
export function hostedFetchText(content: unknown): { url: string; title?: string; text: string } | { error: string } {
  const c = content as { type?: string; error_code?: string; url?: string; content?: { title?: string; source?: { type?: string; media_type?: string; data?: string } } } | undefined;
  if (!c || typeof c !== 'object') return { error: 'no_result' };
  if (c.error_code || /_error$/.test(String(c.type ?? ''))) return { error: String(c.error_code ?? c.type) };
  const src = c.content?.source;
  if (!src || src.type !== 'text' || typeof src.data !== 'string') return { error: `unsupported_${src?.media_type ?? src?.type ?? 'content'}` };
  return { url: String(c.url ?? ''), ...(c.content?.title ? { title: String(c.content.title) } : {}), text: src.data };
}

/**
 * A page reader through Anthropic's hosted `web_fetch`: one small model call per page, restricted to the page's own
 * host (`allowed_domains`); the page text comes from the tool result, not from the model's words.
 */
function anthropicFetcher(ref: ModelRef, opt: NonNullable<ResearchConfig['anthropicFetch']>): NonNullable<WebProvider['fetch']> {
  return async (url, { signal }) => {
    const host = new URL(url).hostname;
    const tool = hostedTool({ provider: 'anthropic', type: opt.type, name: 'web_fetch', beta: opt.beta, params: { max_uses: 1, allowed_domains: [host], max_content_tokens: opt.maxContentTokens } });
    const res = await ref.provider.generate({
      model: ref.model,
      instructions: 'Fetch the URL in the message with web_fetch, then reply with one word: done.',
      messages: [userMessage(url)],
      tools: [{ name: tool.name, description: tool.description, schema: tool.schema, hosted: tool.hosted }],
      params: { ...ref.params, maxTokens: opt.maxOutputTokens },
    }, { signal });
    const part = res.message.parts.find((p) => p.type === 'hosted_result' && p.name === 'web_fetch') as { content?: unknown } | undefined;
    const page = hostedFetchText(part?.content);
    if ('error' in page) throw new Error(`web_fetch: ${page.error}`);
    return { url: page.url || url, ...(page.title ? { title: page.title } : {}), content: page.text };
  };
}

const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

/** Domains named in a policy text (lower case). Pure. */
export function domainsIn(text: string): string[] {
  return [...new Set((text.match(DOMAIN) ?? []).map((d) => d.toLowerCase()))];
}

/** Whether `url` is on one of `domains` (the domain itself or a subdomain). Pure. */
export function excluded(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const PRIVATE_HOST = /(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/;
const IPV4_LIKE = /^[0-9a-fx.]+$/;

/**
 * The canonical form of a URL a page may be fetched from, or undefined when it must never be: only http(s), no
 * credentials, no IP literals (which covers private and link-local ranges), no localhost / `.local` / `.internal` /
 * single-label hosts, no URL longer than `maxChars`. The fragment is dropped. Pure.
 */
export function normalizeFetchUrl(raw: string, maxChars: number): string | undefined {
  const input = raw.trim();
  if (!input || input.length > maxChars) return undefined;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password) return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || IPV4_LIKE.test(host) || PRIVATE_HOST.test(host)) return undefined;
  u.hash = '';
  const out = u.toString();
  return out.length > maxChars ? undefined : out;
}

const text = (out: unknown): string => (typeof out === 'string' ? out : String((out as { content?: unknown })?.content ?? ''));
const isErr = (out: unknown): boolean => typeof out === 'object' && !!out && (out as { isError?: boolean }).isError === true;

export class ResearchDesk {
  private readonly cfg: ResearchConfig;
  private readonly host: ResearchHost;
  private readonly t: Translate;
  private readonly web: WebTools;
  private readonly cache = new Map<string, { expires: number; value: string }>();
  /** Calls that reached the backend, per kind (search, read), day and person. */
  private readonly used = new Map<string, number>();
  /** Per agent: the normalized URLs its own searches returned, with their expiry (what `web_fetch` may read). */
  private readonly allowed = new Map<string, Map<string, number>>();
  /** Who is searching or reading right now (for the hosted call's usage). */
  searcher: AsyncLocalStorage<{ id: string; name: string; tool: ResearchEvent['tool'] }> | undefined;
  /**
   * `capped`: calls refused because the run had used its per-decision web calls (not counted in `refused`).
   * `refusals`: every refusal (capped included) by `tool:reason` (e.g. `web_fetch:person_quota`).
   */
  readonly stats = { searches: 0, fetches: 0, cached: 0, refused: 0, errors: 0, capped: 0, refusals: {} as Record<string, number> };

  constructor(cfg: ResearchConfig, host: ResearchHost, t: Translate, web: WebTools) {
    this.cfg = cfg;
    this.host = host;
    this.t = t;
    this.web = web;
  }

  /** The desk for a configuration, or undefined when research is off or the backend cannot be built (logged). */
  static create(cfg: ResearchConfig | undefined, host: ResearchHost, t: Translate, models: Record<string, string>): ResearchDesk | undefined {
    if (!cfg || cfg.provider === 'off') return undefined;
    try {
      // The hosted search is a model call of its own: its usage is booked to whoever searched (async context).
      const searcher = new AsyncLocalStorage<{ id: string; name: string; tool: ResearchEvent['tool'] }>();
      let provider: 'tavily' | WebProvider = 'tavily';
      if (cfg.provider === 'anthropic-native') {
        const spec = models[cfg.anthropicTier] ?? cfg.anthropicTier;
        const can = availability(spec);
        if (!can.live) throw new Error(`the hosted search runs on ${spec}: ${can.reason}`);
        const model = metered(resolveModel(spec), (m, usage) => {
          const who = searcher.getStore();
          if (who) host.searchUsage?.({ id: who.id, name: who.name }, m, usage, hostedSearchCost(m, usage), who.tool);
        });
        const search = anthropicWebProvider({ model });
        provider = { name: search.name, search: search.search.bind(search), ...(cfg.anthropicFetch ? { fetch: anthropicFetcher(model, cfg.anthropicFetch) } : {}) };
      }
      // The desk applies its own allowlist (own search results, official sources of signals) across runs.
      const web = webTools({
        provider,
        fetchPolicy: 'any',
        maxResults: cfg.maxResults, maxResultsCap: cfg.maxResultsCap, maxChars: cfg.maxChars, maxFetchChars: cfg.maxFetchChars, maxUrlLength: cfg.fetch.maxUrlChars,
      });
      const desk = new ResearchDesk(cfg, host, t, web);
      desk.searcher = searcher;
      return desk;
    } catch (err) {
      console.warn(`[research] off: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private num(key: string): number {
    const v = Number(this.host.policy(key)?.value);
    return Number.isFinite(v) ? v : 0;
  }

  private domains(): string[] {
    const p = this.host.policy(this.cfg.policies.excludedDomains);
    return p ? domainsIn(p.text) : [];
  }

  /** The quota a call counts against: reads have their own policies when configured, else they share the searches'. */
  private quota(kind: ResearchEvent['tool']): { bucket: string; perPerson: string; total: string } {
    const p = this.cfg.policies;
    return kind === 'web_fetch' && p.readsPerPerson && p.readsTotal
      ? { bucket: 'read', perPerson: p.readsPerPerson, total: p.readsTotal }
      : { bucket: 'search', perPerson: p.perPerson, total: p.total };
  }

  /** Why a person may not reach the backend now (a refusal reason code), or undefined. */
  private quotaError(name: string, kind: ResearchEvent['tool']): string | undefined {
    const day = this.host.day();
    const q = this.quota(kind);
    const prefix = q.bucket === 'read' ? 'read_' : '';
    if ((this.used.get(`${q.bucket}\u0000${day}`) ?? 0) >= this.num(q.total)) return `${prefix}total_quota`;
    if ((this.used.get(`${q.bucket}\u0000${day}\u0000${name}`) ?? 0) >= this.num(q.perPerson)) return `${prefix}person_quota`;
    return undefined;
  }

  private count(name: string, kind: ResearchEvent['tool']): void {
    const day = this.host.day();
    const { bucket } = this.quota(kind);
    for (const k of [`${bucket}\u0000${day}`, `${bucket}\u0000${day}\u0000${name}`]) this.used.set(k, (this.used.get(k) ?? 0) + 1);
    // Older days are not needed any more.
    for (const k of this.used.keys()) if (Number(k.split('\u0000')[1]) < day) this.used.delete(k);
  }

  private refusal(kind: ResearchEvent['tool'], reason: string): void {
    const k = `${kind}:${reason}`;
    this.stats.refusals[k] = (this.stats.refusals[k] ?? 0) + 1;
  }

  private cached(key: string): string | undefined {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (hit) this.cache.delete(key);
    return undefined;
  }

  private store(key: string, value: string): void {
    if (this.cfg.cacheTtlMs <= 0) return;
    this.cache.set(key, { expires: Date.now() + this.cfg.cacheTtlMs, value });
    while (this.cache.size > this.cfg.cacheMax) this.cache.delete(this.cache.keys().next().value!);
  }

  private allow(agentId: string, urls: string[]): void {
    const mine = this.allowed.get(agentId) ?? new Map<string, number>();
    this.allowed.set(agentId, mine);
    const expires = Date.now() + this.cfg.fetch.allowTtlMs;
    for (const url of urls) {
      const n = normalizeFetchUrl(url, this.cfg.fetch.maxUrlChars);
      if (!n) continue;
      mine.delete(n);
      mine.set(n, expires);
    }
    const now = Date.now();
    for (const [k, exp] of mine) if (exp <= now) mine.delete(k);
    while (mine.size > this.cfg.fetch.allowMax) mine.delete(mine.keys().next().value!);
  }

  private isAllowed(who: { id: string; name: string }, url: string): boolean {
    if ((this.allowed.get(who.id)?.get(url) ?? 0) > Date.now()) return true;
    // The official source of a signal the person carries or has read: same normalization and checks.
    return (this.host.officialUrls?.(who) ?? []).some((u) => normalizeFetchUrl(u, this.cfg.fetch.maxUrlChars) === url);
  }

  /** Runs one call through the cache, the quotas and the backend; returns the content for the model. */
  private async call(who: { id: string; name: string }, tool: Tool, kind: ResearchEvent['tool'], args: Record<string, unknown>, ctx: Parameters<Tool['run']>[1]): Promise<string | { content: string; isError: true }> {
    let target = kind === 'web_search' ? String(args.query ?? '').trim() : String(args.url ?? '').trim();
    const refuse = (reason: string) => {
      this.stats.refused++;
      this.refusal(kind, reason);
      return { content: this.t('rt.act.researchFailed', { reason: this.t(`rt.researchReason.${reason}`) }), isError: true as const };
    };
    if (!target) return refuse('empty');
    const domains = this.domains();
    if (kind === 'web_fetch') {
      if (this.cfg.fetch.mode === 'off') return refuse('fetch_off');
      if (excluded(target, domains)) return refuse('excluded_domain');
      // Only pages this agent's own searches returned, or the official source of a signal it carries or has read,
      // byte for byte (query string included): nothing the model composes, or a page tells it to compose, can reach
      // another host.
      const url = normalizeFetchUrl(target, this.cfg.fetch.maxUrlChars);
      if (!url || !this.isAllowed(who, url)) return refuse('not_from_search');
      target = url;
      args = { ...args, url };
    }
    const key = `${kind}\u0000${args.max_results ?? ''}\u0000${target}`;
    let raw = this.cached(key);
    const cached = raw !== undefined;
    if (!cached) {
      const quota = this.quotaError(who.name, kind);
      if (quota) return refuse(quota);
      this.count(who.name, kind);
      try {
        const out = await (this.searcher ? this.searcher.run({ ...who, tool: kind }, () => tool.run(args, ctx)) : tool.run(args, ctx));
        if (isErr(out)) {
          this.stats.errors++;
          return { content: text(out), isError: true };
        }
        raw = text(out);
      } catch (err) {
        this.stats.errors++;
        return refuse(err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'unavailable');
      }
      this.store(key, raw);
    } else this.stats.cached++;
    if (kind === 'web_search') this.stats.searches++;
    else this.stats.fetches++;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw!) as Record<string, unknown>;
    } catch {
      return raw!;
    }
    const all = Array.isArray(body.results) ? (body.results as Array<Record<string, unknown>>) : [];
    const results = all.filter((r) => !excluded(String(r.url ?? ''), domains));
    if (Array.isArray(body.results)) body.results = results;
    if (kind === 'web_search') {
      this.allow(who.id, results.map((r) => String(r.url ?? '')));
      this.host.found?.(who, results.map((r) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.snippet ?? '') })));
    }
    const cut = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').slice(0, this.cfg.eventSnippetChars);
    this.host.researched(who, {
      tool: kind,
      ...(kind === 'web_search' ? { query: target } : { url: target }),
      results: kind === 'web_search' ? results.map((r) => ({ title: String(r.title ?? ''), url: String(r.url ?? '') })) : [{ title: String(body.title ?? ''), url: target }],
      snippets: kind === 'web_search' ? results.map((r) => cut(r.snippet)) : [cut(body.content)],
      cached,
    });
    return JSON.stringify(body);
  }

  /**
   * The web tools of one person (same names and schemas as reinloop's, descriptions in the world's language).
   * `budget`: calls left to this run (searches and reads together); past it a call is refused and costs no quota.
   */
  tools(who: { id: string; name: string }, budget?: { left: number }): Tool[] {
    const wrap = (inner: Tool, kind: ResearchEvent['tool']) => defineTool<Record<string, unknown>>({
      name: inner.name,
      description: this.t(`rt.tools.${kind}`),
      schema: inner.schema,
      risk: 'read',
      run: (args, ctx) => {
        if (budget) {
          if (budget.left <= 0) {
            this.stats.capped++;
            this.refusal(kind, 'decision_cap');
            return { content: this.t('rt.act.researchFailed', { reason: this.t('rt.researchReason.decision_cap') }), isError: true };
          }
          budget.left--;
        }
        return this.call(who, inner, kind, args ?? {}, ctx);
      },
    });
    return [wrap(this.web.web_search, 'web_search'), ...(this.web.web_fetch ? [wrap(this.web.web_fetch, 'web_fetch')] : [])];
  }
}
