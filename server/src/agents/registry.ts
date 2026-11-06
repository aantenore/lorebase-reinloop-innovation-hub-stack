// Creates and disposes one reinloop agent per person, from a roster entry.
import { agent, type EasyAgent, memoryNotes, type MemoryStore, memoryStore, mockProvider, windowCompaction } from 'reinloop';
import type { RosterEntry, SimConfig } from '../config.ts';
import type { Translate } from '../i18n.ts';
import { availability, MOCK_PROVIDER } from '../models.ts';
import type { Role, Rule } from '../lorebase/rules.ts';
import type { AgentState } from '../world/types.ts';
import { type MockHost, mockStep } from './mock.ts';
import { instructions } from './prompt.ts';
import { notebookTools, type ToolHost, worldTools } from './tools.ts';

/** Provider of an agent: `mock`, or the provider of its model (`anthropic`, `ollama`, ...). */
export type ProviderKind = string;

export interface RegisteredAgent {
  id: string;
  entry: RosterEntry;
  model: string;
  provider: ProviderKind;
  runner: EasyAgent;
  /** Session id: every tick continues the same reinloop run. */
  runId?: string;
  controller?: AbortController;
  /** Laws as this person last saw them, to tell them what changed. */
  lastLaws?: Rule[];
}

export class AgentRegistry {
  private readonly cfg: SimConfig;
  private readonly toolHost: ToolHost;
  private readonly mockHost: MockHost;
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly t: Translate;
  private readonly roles: () => Role[];
  private notebooks: MemoryStore = memoryNotes();

  constructor(cfg: SimConfig, t: Translate, roles: () => Role[], toolHost: ToolHost, mockHost: MockHost) {
    this.cfg = cfg;
    this.t = t;
    this.roles = roles;
    this.toolHost = toolHost;
    this.mockHost = mockHost;
  }

  instructionsFor(state: AgentState): string {
    return instructions(this.t, state, this.roles().find((r) => r.key === state.role));
  }

  /** Role descriptions changed in Lorebase: every person reads the new one from the next turn. */
  refreshInstructions(states: (id: string) => AgentState | undefined): void {
    for (const reg of this.agents.values()) {
      const s = states(reg.id);
      if (s) reg.runner.instructions = this.instructionsFor(s);
    }
  }

  /** Model id for an entry: env override > explicit entry model > tier model from config. */
  modelFor(entry: Pick<RosterEntry, 'tier' | 'model'>): string {
    return this.cfg.modelOverride ?? entry.model ?? this.cfg.models[entry.tier];
  }

  providerFor(model: string): ProviderKind {
    // The mock provider is only an offline fallback: --mock / SIM_MOCK=1, or a model that cannot run (no API key).
    if (this.cfg.forceMock) return MOCK_PROVIDER;
    const a = availability(model);
    return a.live ? a.provider : MOCK_PROVIDER;
  }

  get provider(): ProviderKind {
    const any = [...this.agents.values()][0];
    return any?.provider ?? this.providerFor(this.cfg.modelOverride ?? this.cfg.models.haiku);
  }

  create(state: AgentState, entry: RosterEntry): RegisteredAgent {
    this.dispose(state.id);
    const model = state.model;
    const provider = this.providerFor(model);
    const a = this.cfg.agents;
    const runner = agent({
      name: state.id,
      model: provider === 'mock'
        ? { provider: mockProvider([(req) => ({ ...mockStep(this.mockHost, state.id)(req), delayMs: this.cfg.mock.thinkDelayMs })], { loop: true }), model }
        // `provider/<model>` through reinloop's presets (for Anthropic, ANTHROPIC_WORKSPACE_ID becomes the workspace header).
        : model,
      params: { maxTokens: a.maxOutputTokens },
      instructions: this.instructionsFor(state),
      tools: [...worldTools(this.toolHost), ...(a.memory ? notebookTools(this.t, this.notebooks) : [])],
      budget: { maxTurns: a.maxTurns },
      toolSettings: { concurrency: 1 },
      compaction: { strategy: windowCompaction({ keepFirst: 1, keepLast: a.compactionKeepLast }), thresholdTokens: a.compactionThresholdTokens },
      store: memoryStore(),
    });
    const reg: RegisteredAgent = { id: state.id, entry, model, provider, runner };
    this.agents.set(state.id, reg);
    return reg;
  }

  get(id: string): RegisteredAgent | undefined {
    return this.agents.get(id);
  }

  all(): RegisteredAgent[] {
    return [...this.agents.values()];
  }

  /** Aborts any in-flight run and forgets the agent. */
  dispose(id: string): void {
    const reg = this.agents.get(id);
    reg?.controller?.abort(new Error('agent removed'));
    this.agents.delete(id);
  }

  /** Disposes every agent and starts fresh notebooks (a reset world remembers nothing). */
  clear(): void {
    for (const id of [...this.agents.keys()]) this.dispose(id);
    this.notebooks = memoryNotes();
  }
}
