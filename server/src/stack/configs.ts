// Stack configs of the hub. The shape of a person's stack lives in config/stacks/person.json (one profile per tier);
// the numbers the game already owns (tier budgets, model params, prompt cache) are laid over it from game.json.
import { resolve } from 'node:path';
import { deepMerge, loadConfig, mergeLayers, type AgentConfig, type ResolvedConfig } from '@agent-layers/core';
import { ROOT, type SimConfig } from '../config.ts';
import type { Tier } from '../world/types.ts';
import { cacheParams, type CallParams, type GameConfig } from '../rt/config.ts';
import { EXT } from './model.ts';

/** Default location of the person stack config; `STACK_PERSON_CONFIG` replaces it. */
export const PERSON_CONFIG = 'config/stacks/person.json';

/** Environment variable the config reads the data directory from (telemetry file). */
export const DATA_DIR_ENV = 'HUB_DATA_DIR';

export interface PersonOptions {
  /** Config file (default `STACK_PERSON_CONFIG` or `config/stacks/person.json`). */
  file?: string;
  /** Model of this person (replaces the profile's): a reinloop spec (`anthropic/<id>`, `ollama/<model>`, ...) or a bare Anthropic id. */
  model?: string;
  /** Data directory; the telemetry file goes under it. */
  dataDir?: string;
  /** Per-agent changes laid over the file's agents (deep merge); a function gets the file's agents. */
  agents?: Record<string, Partial<AgentConfig>> | ((current: Record<string, AgentConfig>) => Record<string, Partial<AgentConfig>>);
  env?: Record<string, string | undefined>;
}

/**
 * The stack config of one person: the profile of its tier, the offline model when `mock`, the person's own model and
 * the per-agent overlay.
 */
export async function loadPersonConfig(tier: Tier, mock: boolean, o: PersonOptions = {}): Promise<ResolvedConfig> {
  const env = { ...process.env, ...o.env, ...(o.dataDir ? { [DATA_DIR_ENV]: o.dataDir } : {}) };
  const file = resolve(ROOT, o.file ?? env.STACK_PERSON_CONFIG ?? PERSON_CONFIG);
  const config = await loadConfig(file, { profile: tier, env });
  let layers = config.layers;
  if (o.model) layers = mergeLayers(layers, { model: { options: { model: o.model } } });
  // The offline model reports `mock/<model>`, like the scripted provider it replaces.
  if (mock) layers = mergeLayers(layers, { model: { adapter: 'hub-mock', options: { model: `mock/${o.model ?? 'model'}` } } });
  const change = typeof o.agents === 'function' ? o.agents(config.agents) : o.agents;
  const agents = change ? deepMerge(config.agents, change) : config.agents;
  return { ...config, layers, agents };
}

const paramsOf = (cfg: GameConfig, kind: string): CallParams => (cfg.decisions.modelParams as Record<string, CallParams>)[kind] ?? {};

/** Group capacities that write (a plan, or a proposal in prose): they use the faculties; only the plan writers get the tier's output limit. */
const WRITING: Record<string, { plan: boolean }> = { lead: { plan: true }, write: { plan: true }, write_member: { plan: true }, propose: { plan: false } };
/** Group capacities that answer through one record tool: no faculties, the prose output limit. */
const RECORDING = new Set(['judge', 'route', 'vote']);

/**
 * Per-agent settings the game owns, for the agents of a person's config:
 * - `decide`, `decide_close` (the closing run of a decision) and `reply` budgets and output limits from the tier, the
 *   closing turn and the conversation settings;
 * - `ballot` and `chair` (the committee) turns from `ideas.committee.ballotMaxTurns`;
 * - model params of every agent from its `hub.params` ({ kind: plan|reply|prose, group }): thinking, effort, prompt cache;
 * - the model of the agents marked `hub.model: "member"` from `groups.memberTier`.
 * - the group capacities: output limit (`tier.maxOutputTokens` for those that write plans, `groups.proseMaxOutputTokens`
 *   for proposers in prose, judges, routers and voters) and turns (`groups.maxTurns`, plus the tier's consultations for those that use faculties,
 *   plus one for those that write a plan), on the tier of the model they run on (`groups.memberTier` for the members' ones).
 */
export function gameAgents(
  cfg: GameConfig, sim: Pick<SimConfig, 'models' | 'modelOverride'>, tier: Tier, agents: Record<string, AgentConfig>,
): Record<string, Partial<AgentConfig>> {
  const tc = cfg.decisions.tiers[tier];
  const out: Record<string, Partial<AgentConfig>> = {};
  for (const [name, a] of Object.entries(agents)) {
    const hub = (a.ext?.['hub.params'] ?? {}) as { kind?: string; group?: boolean };
    const p = paramsOf(cfg, hub.kind ?? 'prose');
    const anthropic = {
      ...(p.thinking ? { thinking: p.thinking } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
      ...cacheParams(cfg, hub.group === true),
    };
    const ext: Record<string, unknown> = {
      [EXT.params]: anthropic,
      ...(p.retryMaxTokens ? { 'reinloop.retryMaxTokens': p.retryMaxTokens } : {}),
    };
    const change: Partial<AgentConfig> = { ext };
    if (a.ext?.['hub.model'] === 'member' && cfg.groups.memberTier) change.model = sim.modelOverride ?? sim.models[cfg.groups.memberTier];
    if (name === 'decide') {
      ext['reinloop.budget'] = { maxTurns: tc.maxTurns, maxToolCalls: tc.maxConsults + tc.maxTurns * 4 };
      change.settings = { maxOutputTokens: tc.maxOutputTokens };
    } else if (name === 'decide_close') {
      ext['reinloop.budget'] = { maxTurns: cfg.decisions.closingTurn?.maxTurns ?? 1 };
      change.settings = { maxOutputTokens: tc.maxOutputTokens };
    } else if (name === 'reply') {
      const consults = Math.max(0, cfg.conversation.replyMaxConsults);
      // Consultations, plus rethink and one refused extra call, then the answer.
      ext['reinloop.budget'] = { maxTurns: cfg.conversation.replyMaxTurns, maxToolCalls: consults + 2 };
      change.settings = { maxOutputTokens: cfg.conversation.replyMaxOutputTokens };
    } else if (name === 'ballot' || name === 'chair') {
      // A ballot or decision the policy refuses can be recorded again.
      ext['reinloop.budget'] = { maxTurns: cfg.ideas.committee.ballotMaxTurns ?? 3 };
      change.settings = { maxOutputTokens: cfg.groups.proseMaxOutputTokens };
    }
    const writing = WRITING[name];
    if (writing || RECORDING.has(name)) {
      const own = a.ext?.['hub.model'] === 'member' && cfg.groups.memberTier ? cfg.groups.memberTier : tier;
      const gt = cfg.decisions.tiers[own];
      const turns = cfg.groups.maxTurns + (writing ? gt.maxConsults + (writing.plan ? 1 : 0) : 0);
      ext['reinloop.budget'] = { maxTurns: turns };
      change.settings = { maxOutputTokens: writing?.plan ? gt.maxOutputTokens : cfg.groups.proseMaxOutputTokens };
    }
    out[name] = change;
  }
  return out;
}
