// Which provider a model runs on and whether it can run live. Model ids are reinloop specs (`anthropic/<id>`,
// `ollama/<model>`, `openai/<id>`, ...); a bare id is an Anthropic model, as the tier models of config/sim.json are.
// The mock provider is the offline fallback the game takes when a model it needs cannot run.
import { missingCredentials, resolveModel, splitModel } from 'reinloop';
import type { RosterEntry, SimConfig } from './config.ts';

export const MOCK_PROVIDER = 'mock';
export const DEFAULT_PROVIDER = 'anthropic';

/** `provider/model`; a bare model id gets the `anthropic/` prefix. */
export const modelSpec = (model: string): string => (model.includes('/') ? model : `${DEFAULT_PROVIDER}/${model}`);

/** Provider name of a model (`ollama` for `ollama/qwen3:4b`). */
export const providerOf = (model: string): string => splitModel(modelSpec(model))?.provider ?? DEFAULT_PROVIDER;

export interface Availability {
  provider: string;
  /** The model can be called: a provider reinloop knows whose API key, when it needs one, is set. */
  live: boolean;
  /** Why not, when it cannot. */
  reason?: string;
}

/** Whether a model can run live in this environment (nothing is called: presets and their keys only). */
export function availability(model: string, env: Record<string, string | undefined> = process.env): Availability {
  const spec = modelSpec(model);
  const provider = providerOf(spec);
  if (provider === MOCK_PROVIDER) return { provider, live: false, reason: `${spec} is the mock provider` };
  try {
    resolveModel(spec, env);
  } catch (err) {
    return { provider, live: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const missing = missingCredentials({ agents: { model: { model: spec } } }, env);
  if (missing.length) return { provider, live: false, reason: `${spec} needs ${missing[0]!.replace(/^.*? but /, '').replace(/ is not set.*$/, '')}` };
  return { provider, live: true };
}

/** The models a run calls: the override, or the tier models and the roster's own model ids. */
export function modelsInUse(cfg: Pick<SimConfig, 'models' | 'modelOverride'> & { roster?: Pick<RosterEntry, 'model'>[] }): string[] {
  if (cfg.modelOverride) return [cfg.modelOverride];
  return [...new Set([...Object.values(cfg.models), ...(cfg.roster ?? []).map((e) => e.model).filter((m): m is string => !!m)])];
}

/** Provider names of the models, without repeats. */
export const providersOf = (models: readonly string[]): string[] => [...new Set(models.map(providerOf))];

export interface ModeChoice {
  mock: boolean;
  /** Provider label of the run: `mock`, or the providers of the models in use (`anthropic`, `ollama`, ...). */
  provider: string;
  /** Why the run is offline, when it is. */
  reason?: string;
}

/** Live or mock for a run: mock when asked (`--mock`, `SIM_MOCK=1`) or when any model in use cannot run. */
export function chooseMode(cfg: Parameters<typeof modelsInUse>[0] & Pick<SimConfig, 'forceMock'>, env: Record<string, string | undefined> = process.env): ModeChoice {
  if (cfg.forceMock) return { mock: true, provider: MOCK_PROVIDER, reason: 'requested (--mock or SIM_MOCK=1)' };
  const models = modelsInUse(cfg);
  const offline = models.map((m) => availability(m, env)).find((a) => !a.live);
  if (offline) return { mock: true, provider: MOCK_PROVIDER, reason: offline.reason };
  return { mock: false, provider: providersOf(models).join('+') };
}
