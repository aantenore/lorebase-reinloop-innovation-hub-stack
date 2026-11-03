// Real-time world settings: config/game.json (GAME_CONFIG overrides the path). Gameplay numbers
// are Lorebase Rules; this file holds engine, decision, player and group knobs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelParams } from 'reinloop';
import { ROOT } from '../config.ts';
import { deepMerge, loadProfile } from '../profile.ts';
import type { Tier } from '../world/types.ts';
import type { CompanyConfig } from './company.ts';
import type { EconomyConfig } from './economy-book.ts';
import type { IdeasConfig } from './ideas.ts';
import type { ResearchConfig } from './research.ts';
import type { EvidenceConfig } from './evidence.ts';
import type { MapConfig, MovementConfig } from './world.ts';

export type GroupPattern = 'orchestrator' | 'council' | 'router' | 'chain' | 'mentor' | 'assembly' | 'crowd';
export const AGENT_PATTERNS: GroupPattern[] = ['orchestrator', 'council', 'router', 'chain', 'mentor', 'assembly'];

export interface TierDecision {
  /** Upper bound of the steps kept from one plan (cost control); the schema only suggests it. */
  maxSteps: number;
  /** Multiplies the Lorebase rule plan_horizon_minutes. */
  horizonFactor: number;
  /** Multiplies the Lorebase rule replan_cooldown_minutes. */
  cooldownFactor: number;
  maxTurns: number;
  maxOutputTokens: number;
  /** Lorebase consultations (MCP read tools) allowed per decision. */
  maxConsults: number;
  /** Web searches and page reads allowed per decision (absent: only the daily quota policies bound them). */
  maxWebCalls?: number;
}

export interface BrainConfig {
  /** Herald (Lorebase MCP server) endpoint; HERALD_URL overrides; empty disables. */
  mcpUrl: string;
  domain: string;
  tools: string[];
  cacheMs: number;
  callTimeoutMs: number;
  outputMaxChars: number;
  connectRetryMs: number;
  /** Tool arguments that would leave the pinned branch; removed from schemas and forced server-side. */
  branchArgs: string[];
}

export interface MemoryIngest {
  importance: number;
  emotion: number;
}

export interface MemoryConfig {
  /** mnemo, the private memory service; MNEMO_URL overrides; disabled: no private memory. */
  enabled: boolean;
  url: string;
  timeoutMs: number;
  pollMs: number;
  recallLimit: number;
  textMaxChars: number;
  /** Keep reinloop run logs in mnemo (best effort). */
  runStore: boolean;
  /** Run event types not kept (streamed deltas: many and redundant with the final messages). */
  runSkipEvents: string[];
  /** Batching delay of conversation lines and run events sent to mnemo. */
  runFlushMs: number;
  /** Retries of a request that found nothing listening, with exponential backoff from retryBaseMs. */
  retries: number;
  retryBaseMs: number;
  ingest: Record<string, MemoryIngest>;
}

export interface ServicesConfig {
  herald: { autoStart: boolean; script: string; healthUrl: string; stopOnExit: boolean };
  mnemo: { autoStart: boolean; entry: string; healthUrl: string; readyTimeoutMs: number; pollMs: number };
}

export interface InsightConfig {
  enabled: boolean;
  kind: string;
  operation: string;
  updateOperation: string;
  branchPrefix: string;
  autoAcceptMinutes: number;
  maxPendingPerRole: number;
  textMaxChars: number;
  listMax: number;
  /** At startup: `reload` open insight Proposals into the review queue (closing those older than maxAgeHours), or `close` them all. */
  reconcile: { mode: 'reload' | 'close'; maxAgeHours: number };
}

export interface BarterConfig {
  enabled: boolean;
  /** How often pending offers are checked for expiry (real ms). */
  checkMs: number;
  textMaxChars: number;
}

export interface SocietyConfig {
  enabled: boolean;
  /** `reputation` broadcast period (real ms); esteem, fame and ranks are recomputed then. */
  broadcastMs: number;
  maxOpinions: number;
  reasonMaxChars: number;
  /** What people hear about each other (bands of esteem and fame, never numbers). */
  hearsay: { perPerson: number; maxKept: number; lowBelow: number; highAbove: number; famousAbove: number };
  /** Laws proposed by agents: a branch + Proposal in Lorebase, never merged by the world. */
  lawProposals: { branchPrefix: string; textMaxChars: number; pollMs: number; maxOpen: number; defaultValue: number };
  /** Family records (Kind) written in batches like the Chronicle; `colors` is the palette (by founding order). */
  families: { kind: string; flushMs: number; colors: string[] };
  /**
   * Witnesses' accounts of social laws (laws that are not engine rules): one per witness, person and law
   * within `windowMinutes` (game); a breach told by `chronicleMinWitnesses` witnesses enters the Chronicle.
   */
  testimony: { windowMinutes: number; chronicleMinWitnesses: number; maxKept: number; reasonMaxChars: number };
  /**
   * Opinions, esteem, fame and skills kept in mnemo across restarts, per world id (empty: `<domain>/<branch>`
   * of Lorebase), flushed every `flushMs`.
   */
  persist: { enabled: boolean; world: string; flushMs: number };
}

export type ReplanTrigger = 'planExhausted' | 'stepFailed' | 'spokenTo' | 'critical' | 'nightfall' | 'dawn' | 'seasonChange' | 'rulesChanged' | 'offer' | 'offerAnswered'
  | 'ideaNews' | 'quarter';

/** Per-call model params taken from config. */
export type CallParams = Pick<ModelParams, 'thinking' | 'effort' | 'retryMaxTokens'>;

export interface GameConfig {
  ws: { path: string; maxPayloadBytes: number };
  /** `tiles` messages: changed tiles are coalesced and flushed at most every tileFlushMs. */
  net: { tileFlushMs: number };
  loop: { tickHz: number; stateHz: number; timeBroadcastMs: number; deadLingerMs: number; statusLogMs: number; timeScale: number };
  map: MapConfig;
  movement: MovementConfig;
  decisions: {
    tiers: Record<Tier, TierDecision>;
    /** A decision may take this much game time, but never less than `timeoutMinMs` nor more than `timeoutMs` real ms. */
    timeoutGameMinutes: number;
    timeoutMinMs: number;
    timeoutMs: number;
    /**
     * A plan run that ends (or runs out of turns or tool calls) without commit_plan gets one closing run on the same
     * conversation, of at most `maxTurns` turns, where only commit_plan answers (the other tools say the decision is closed).
     */
    closingTurn: { enabled: boolean; maxTurns: number };
    maxConcurrent: number;
    memoryItems: number;
    inboxItems: number;
    lookMaxTiles: number;
    lookMaxPeople: number;
    nearbyGroupsMax: number;
    /** Budget of the factual perception lines (items shown per person, recipes, gathering spots; smallest body change worth a line). */
    perception: {
      carriedMax: number; recipesMax: number; gatherSpotsMax: number; bodyMinDelta: number;
      /** Words one said to a named person and not answered by them since: shown after `pendingMinMinutes`, up to `pendingMaxMinutes` old, at most `pendingMax`, cut at `pendingTextChars`. */
      pendingMinMinutes: number; pendingMaxMinutes: number; pendingMax: number; pendingTextChars: number;
    };
    /** Language of a reasoning summary, guessed from marker words (`minHits` at least): recorded on the thought, never translated. */
    thoughtLanguage?: { expected: string; minHits: number; markers: Record<string, string[]> };
    textMaxChars: number;
    replanOn: Record<ReplanTrigger, boolean>;
    startStaggerMs: number;
    offersMax: number;
    /**
     * Model params per kind of call (reinloop `thinking`, `effort`, `retryMaxTokens`), so short answers are not
     * eaten by thinking; `maxTokens` comes from the tier or call settings.
     */
    modelParams: { plan: CallParams; reply: CallParams; prose: CallParams };
  };
  conversation: { replyMaxOutputTokens: number; replyTimeoutMs: number; replyMaxTurns: number; replyMaxConsults: number; agentReplyDepth: number; replanAfterReply: boolean };
  player: { speechMinIntervalMs: number; speechPerMinute: number; speechMaxChars: number; nameMaxChars: number; maxPlayers: number; inputMax: number };
  groups: {
    minMembers: number;
    maxMembers: number;
    nameMaxChars: number;
    replanDebounceMs: number;
    traceMaxChars: number;
    maxRounds: number;
    proseMaxOutputTokens: number;
    maxTurns: number;
    /** Tier of the members who only propose, work or vote (the deciding role keeps its own); empty: their own. */
    memberTier?: Tier;
    /** Members consulted per decision besides the one deciding (0: all). */
    maxProposers: number;
    /** A group decides at most once per this many game minutes (its first decision excepted). */
    minGameMinutesBetweenDecisions: number;
    colors: string[];
    /** `jointPlans: false`: the group only decides on submitted ideas (the committee); its members plan on their own. */
    seeded: Array<{ name: string; pattern: GroupPattern; members: string[]; leader: string | null; jointPlans?: boolean }>;
  };
  crowd: { count: number; tier: Tier; groupName: string; names: string[]; roles: string[]; personality: string };
  chronicle: { enabled: boolean; kind: string; operation: string; flushMs: number; maxBatch: number; maxQueue: number; retryBaseMs: number; retryMaxMs: number };
  mock: {
    thinkDelayMs: number; replyDelayMs: number; wanderRadius: number; planSteps: number; experimentChance: number; eatAtHunger: number; offerChance: number; askChance: number;
    judgeChance: number; lawChance: number;
    /** Ideas: chances of proposing, reviewing and enriching per decision; how many seeds `rt.mock.ideas.<n>` exist. */
    ideaChance: number; reviewChance: number; enrichChance: number; ideaSeeds: number;
    /** Evidence: chance of a public signal search and attachment, and of a simulated interview. */
    evidenceChance: number; interviewChance: number;
    /** Committee stand-in: approve from this weighted score, kill below that one, else defer. */
    committeeApproveAt: number; committeeKillBelow: number;
    /** Which company roles explore, gather, build or look after colleagues in offline plans. */
    habits: import('./mock.ts').MockHabits;
  };
  brain: BrainConfig;
  insights: InsightConfig;
  barter: BarterConfig;
  society: SocietyConfig;
  economy: EconomyConfig & { insightOnDiscovery: boolean; chronicleEvent: string };
  memory: MemoryConfig;
  services: ServicesConfig;
  observatory: import('./observatory.ts').ObservatoryConfig;
  god: { recentMax: number };
  /** Who a newborn is: `childTier` a tier name or 'random-parent'; at `maxAgentMinds` LLM minds a birth is blocked or becomes a crowd extra. */
  births: { maxAgentMinds: number; childTier: 'random-parent' | Tier; atCap: 'block' | 'crowd' };
  /** What a death frees: the private memory in mnemo (optionally leaving a one-line epitaph in the Chronicle). */
  death: { forgetMemories: boolean; epitaph: boolean };
  /** The body's reflex while it has no plan (reflex.ts). */
  reflex: import('./reflex.ts').ReflexConfig;
  /** Spending cap: when the model cost of this run reaches `maxUsd` (0: none) every mind is paused. */
  budget: { maxUsd: number };
  /** Ideas on Lorebase branches; `attachCategories`: categories of carried items an idea can take in (signals, artifacts). */
  ideas: IdeasConfig & { attachCategories: string[] };
  /** Quarters, slots, themes, careers. */
  company: CompanyConfig;
  /**
   * Provider prompt caching (reinloop `params.cache` / `params.cacheTtl`): the stable prefix (tools, instructions)
   * is cached and the volatile perception comes last. `groupTtl` applies to group members' runs (default `ttl`).
   */
  promptCache: { enabled: boolean; ttl: CacheTtl; groupTtl?: CacheTtl };
  /** Agent stack: where its files (telemetry, group run journal) live; `HUB_DATA_DIR` replaces it. */
  stack: { dataDir: string };
  /** Web research (reinloop web tools): backend, limits, cache; quotas and excluded domains are policies. */
  research: ResearchConfig;
  /** Evidence of ideas: public signals (reinloop signalTools), simulated interviews, human validations; numbers that bind are policies. */
  evidence: EvidenceConfig;
}

export type CacheTtl = '5m' | '1h';

/** Model params that turn prompt caching on or off for one call (`group`: a group member's run). */
export function cacheParams(cfg: Pick<GameConfig, 'promptCache'>, group = false): Pick<ModelParams, 'cache' | 'cacheTtl'> {
  const c = cfg.promptCache;
  if (!c?.enabled) return { cache: false };
  return { cache: true, cacheTtl: (group ? c.groupTtl : undefined) ?? c.ttl };
}

export function loadGameConfig(env: NodeJS.ProcessEnv = process.env): GameConfig {
  const path = resolve(ROOT, env.GAME_CONFIG ?? 'config/game.json');
  const cfg = deepMerge(JSON.parse(readFileSync(path, 'utf8')) as GameConfig, loadProfile(env).game ?? {});
  const n = Number(env.GAME_CROWD);
  if (env.GAME_CROWD !== undefined && Number.isInteger(n) && n >= 0) cfg.crowd.count = n;
  if (env.GAME_GROUPS === '0') cfg.groups.seeded = [];
  if (env.GAME_CHRONICLE === '0') cfg.chronicle.enabled = false;
  if (env.HERALD_URL !== undefined) cfg.brain.mcpUrl = env.HERALD_URL;
  cfg.brain.domain = env.LOREBASE_DOMAIN ?? cfg.brain.domain;
  if (env.MNEMO_URL !== undefined) cfg.memory.url = env.MNEMO_URL;
  if (env.MNEMO_URL === '') cfg.memory.enabled = false;
  const scale = Number(env.GAME_TIME_SCALE);
  if (env.GAME_TIME_SCALE !== undefined && Number.isFinite(scale) && scale > 0) cfg.loop.timeScale = scale;
  const maxUsd = Number(env.GAME_BUDGET_USD);
  if (env.GAME_BUDGET_USD !== undefined && Number.isFinite(maxUsd) && maxUsd >= 0) cfg.budget.maxUsd = maxUsd;
  const flows = Number(env.GAME_FLOWS_MS);
  if (env.GAME_FLOWS_MS !== undefined && Number.isFinite(flows) && flows > 0) cfg.economy.flowsMs = flows;
  return cfg;
}
