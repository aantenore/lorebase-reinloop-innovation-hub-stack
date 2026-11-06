// Loads config/sim.json and applies environment overrides. Also loads `.env` (secrets stay in
// the environment; nothing here prints them).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyRosterTiers, deepMerge, loadProfile } from './profile.ts';
import type { Tier, WorldGenConfig } from './world/types.ts';

export const ROOT = resolve(import.meta.dirname, '../..');

export interface RosterEntry {
  id?: string;
  name: string;
  role: string;
  tier: Tier;
  model?: string;
  personality?: string;
}

export interface SimConfig {
  /** Language of everything people read and say: config/i18n/<language>.json. */
  language: string;
  seed: number;
  tickMs: number;
  autoStart: boolean;
  /** `host` is the bind address (default 127.0.0.1); `maxBodyBytes` caps JSON request bodies. */
  /**
   * `corsOrigins` also gets `http://localhost:<p>` and `http://127.0.0.1:<p>` for every port in `devOriginPorts`
   * ([from, to], inclusive: dev servers that moved to the next free port); SIM_DEV_ORIGIN_PORTS="from-to" (or one port) overrides it.
   */
  http: { host: string; port: number; corsOrigins: string[]; devOriginPorts?: [number, number]; staticDir: string; maxBodyBytes: number; allowedHosts?: string[] };
  lorebase: {
    url: string;
    domain: string;
    branch: string;
    ruleKind: string;
    roleKind: string;
    directOperation: string;
    updateOperation: string;
    enactOperation: string;
    createOperation: string;
    repealOperation: string;
    amendOperation: string;
    deleteOperation: string;
    /** Built-in bulk delete (one Revision per call) and the Keeper's per-call key cap (keeper.operations.max_bulk_delete_keys). */
    bulkDeleteOperation: string;
    maxBulkDeleteKeys: number;
    proposalBranchPrefix: string;
    pollMs: number;
    reconnectMs: number;
    /** How long the start waits for Lorebase (and its seed) before giving up; 0 waits forever. `LOREBASE_MAX_WAIT_MS` overrides it. */
    maxWaitMs: number;
    /** Categories a Rule (policy) may have (the schema's enum). */
    ruleCategories: string[];
  };
  models: Record<Tier, string>;
  /** Extra model ids a roster entry may name besides the tier models (no other id is accepted). */
  allowedModels?: string[];
  agents: {
    maxTurns: number;
    maxOutputTokens: number;
    timeoutMs: number;
    compactionThresholdTokens: number;
    compactionKeepLast: number;
    lookMaxTiles: number;
    messageMaxChars: number;
    historyLimit: number;
    minRoster: number;
    maxRoster: number;
    /** Gives every person a personal notebook (reinloop remember/recall, one per agent). */
    memory: boolean;
  };
  roster: RosterEntry[];
  world: WorldGenConfig;
  mock: { thinkDelayMs: number; reserveFoodTicks: number };
  /** Resolved at load time. */
  modelOverride?: string;
  forceMock: boolean;
  rosterFile: string;
  /** Tiers set by the cost profile (GAME_PROFILE), applied to the configured and to the saved roster. */
  rosterTiers?: Record<string, Tier>;
  /** SIM_API_TOKEN: when set, mutating routes and the WebSocket join require it. */
  apiToken?: string;
}

/** Model ids a roster entry may request: the tier models plus `allowedModels`. */
export function allowedModels(cfg: Pick<SimConfig, 'models' | 'allowedModels'>): string[] {
  return [...new Set([...Object.values(cfg.models), ...(cfg.allowedModels ?? [])])];
}

/** Error text when a requested per-agent model is not allowed, else undefined. */
export function checkModel(cfg: Pick<SimConfig, 'models' | 'allowedModels'>, model: unknown): string | undefined {
  if (model === undefined) return undefined;
  const allowed = allowedModels(cfg);
  if (typeof model !== 'string' || !allowed.includes(model)) return `model must be one of ${allowed.join(', ')}`;
  return undefined;
}

const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function loadEnvFile(): void {
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Loopback origins for a range of dev server ports (both loopback names). */
export function devOrigins(range: [number, number] | undefined): string[] {
  if (!range) return [];
  const [from, to] = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || to < from) return [];
  const out: string[] = [];
  for (let p = from; p <= to; p++) out.push(`http://localhost:${p}`, `http://127.0.0.1:${p}`);
  return out;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): SimConfig {
  loadEnvFile();
  const path = resolve(ROOT, env.SIM_CONFIG ?? 'config/sim.json');
  const profile = loadProfile(env);
  const cfg = deepMerge(JSON.parse(readFileSync(path, 'utf8')) as SimConfig, profile.sim ?? {});
  cfg.rosterTiers = profile.rosterTiers;
  cfg.roster = applyRosterTiers(cfg.roster, cfg.rosterTiers);
  cfg.language = env.SIM_LANGUAGE ?? cfg.language;
  cfg.seed = num(env.SIM_SEED) ?? cfg.seed;
  cfg.tickMs = num(env.SIM_TICK_MS) ?? cfg.tickMs;
  cfg.autoStart = env.SIM_AUTOSTART ? env.SIM_AUTOSTART === '1' : argv.includes('--start') || cfg.autoStart;
  cfg.http.port = num(env.PORT ?? env.SIM_PORT) ?? cfg.http.port;
  cfg.http.host = env.SIM_HOST ?? cfg.http.host ?? '127.0.0.1';
  cfg.http.maxBodyBytes ??= 64 * 1024;
  const devRange = /^(\d+)(?:-(\d+))?$/.exec(env.SIM_DEV_ORIGIN_PORTS ?? '');
  if (devRange) cfg.http.devOriginPorts = [Number(devRange[1]), Number(devRange[2] ?? devRange[1])];
  else if (env.SIM_DEV_ORIGIN_PORTS) console.warn(`SIM_DEV_ORIGIN_PORTS: expected a port or a range "from-to", got "${env.SIM_DEV_ORIGIN_PORTS}"`);
  cfg.http.corsOrigins = [...new Set([...(cfg.http.corsOrigins ?? []), ...devOrigins(cfg.http.devOriginPorts)])];
  cfg.apiToken = env.SIM_API_TOKEN || undefined;
  cfg.lorebase.url = env.LOREBASE_URL ?? cfg.lorebase.url;
  cfg.lorebase.domain = env.LOREBASE_DOMAIN ?? cfg.lorebase.domain;
  cfg.lorebase.branch = env.LOREBASE_BRANCH ?? cfg.lorebase.branch;
  cfg.lorebase.maxWaitMs = num(env.LOREBASE_MAX_WAIT_MS) ?? cfg.lorebase.maxWaitMs ?? 0;
  cfg.agents.maxTurns = num(env.SIM_MAX_TURNS) ?? cfg.agents.maxTurns;
  for (const t of ['opus', 'sonnet', 'haiku'] as const) {
    const v = env[`SIM_MODEL_${t.toUpperCase()}`];
    if (v) cfg.models[t] = v;
  }
  // SIM_MODEL_OVERRIDE forces every agent onto one model: a tier name or a full model id.
  const override = env.SIM_MODEL_OVERRIDE;
  cfg.modelOverride = override ? (cfg.models[override as Tier] ?? override) : undefined;
  cfg.forceMock = argv.includes('--mock') || env.SIM_MOCK === '1';
  cfg.rosterFile = resolve(ROOT, env.SIM_ROSTER_FILE ?? 'data/roster.json');
  return cfg;
}
