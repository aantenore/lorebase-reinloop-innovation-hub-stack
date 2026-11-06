// The simulation: reads the rules snapshot kept by the Lorebase watcher, runs every living
// person's reinloop agent concurrently each tick, resolves the world and publishes events.
import { ROOT, type RosterEntry, type SimConfig } from '../config.ts';
import { cleanEntry, loadRosterFile, saveRosterFile, validateEntry, validateRoster } from '../roster.ts';
import { loadTemplates, type Translate, translator } from '../i18n.ts';
import { AgentRegistry, type RegisteredAgent } from '../agents/registry.ts';
import { observation } from '../agents/prompt.ts';
import { LorebaseClient } from '../lorebase/client.ts';
import { diffRules, type Role, type RoleChange, type Rule, type RuleChange, ruleValues } from '../lorebase/rules.ts';
import { RuleWatcher } from '../lorebase/watcher.ts';
import { missingRules, seasonOf, World } from '../world/engine.ts';
import { type ActionResult, type AgentState, type Rules, type Stats, type Tile, type WorldEvent } from '../world/types.ts';

export interface SimStatus {
  running: boolean;
  tick: number;
  tickMs: number;
  /** `mock`, or the provider of the models (`anthropic`, `ollama`, ...). */
  provider: string;
  model: string;
  lorebase: { connected: boolean; url: string; domain: string; branch: string; revision: string };
}

export type SimEvent = { type: string; [key: string]: unknown };
type Listener = (event: SimEvent) => void;

const short = (v: unknown) => {
  const s = JSON.stringify(v ?? {});
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

export class Simulation {
  readonly cfg: SimConfig;
  readonly client: LorebaseClient;
  world: World;
  roster: RosterEntry[];
  history: Stats[] = [];
  running = false;
  private readonly registry: AgentRegistry;
  private readonly watcher: RuleWatcher;
  private readonly listeners = new Set<Listener>();
  readonly t: Translate;
  private laws: Rule[] = [];
  private roles: Role[] = [];
  private revision = '';
  private values: Rules = {};
  /** Rules frozen for the tick in progress: changes apply from the next tick. */
  private tickValues: Rules = {};
  private tickInFlight: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private loopRunning = false;

  constructor(cfg: SimConfig) {
    this.cfg = cfg;
    this.t = translator(loadTemplates(ROOT, cfg.language));
    this.client = new LorebaseClient(cfg.lorebase.url, cfg.lorebase.domain);
    this.world = this.newWorld();
    this.roster = this.cfg.roster;
    const host = { world: () => this.world, rules: () => this.tickValues, t: this.t };
    this.registry = new AgentRegistry(
      cfg,
      this.t,
      () => this.roles,
      { ...host, lookMaxTiles: cfg.agents.lookMaxTiles, messageMaxChars: cfg.agents.messageMaxChars, onAction: (id, tool, args, res) => this.onAction(id, tool, args, res) },
      { ...host, reserveFoodTicks: cfg.mock.reserveFoodTicks },
    );
    const lb = cfg.lorebase;
    this.watcher = new RuleWatcher(this.client, { ruleKind: lb.ruleKind, roleKind: lb.roleKind, branch: lb.branch, pollMs: lb.pollMs, reconnectMs: lb.reconnectMs }, {
      onChange: (snapshot, changes, roleChanges, event) => this.applyRules(snapshot.rules, snapshot.roles, snapshot.revision, changes, roleChanges, event?.message),
      onStatus: (connected, detail) => {
        console.log(`[lorebase] ${connected ? 'connected' : 'disconnected'}: ${detail}`);
        this.emit({ type: 'status', status: this.status() });
      },
    });
  }

  // ---- events ---------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: SimEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('listener failed', err);
      }
    }
  }

  // ---- lifecycle --------------------------------------------------------------

  /** Connects to Lorebase (retrying until the first snapshot loads) and spawns the roster. */
  async init(): Promise<void> {
    for (;;) {
      try {
        const snap = await this.watcher.start();
        this.applyRules(snap.rules, snap.roles, snap.revision, [], [], undefined, true);
        console.log(`[lorebase] ${snap.rules.length} rules and ${snap.roles.length} roles loaded from ${this.cfg.lorebase.url} ${this.cfg.lorebase.domain}/${this.cfg.lorebase.branch} @ ${snap.revision.slice(0, 12)}`);
        break;
      } catch (err) {
        console.error(`[lorebase] cannot load rules (${err instanceof Error ? err.message : err}); retrying in ${this.cfg.lorebase.pollMs} ms`);
        await new Promise((r) => setTimeout(r, this.cfg.lorebase.pollMs));
      }
    }
    this.roster = this.loadRoster();
    this.populate();
    if (this.cfg.autoStart) this.start();
  }

  shutdown(): void {
    this.pause();
    this.registry.clear();
    this.watcher.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit({ type: 'status', status: this.status() });
    if (!this.loopRunning) void this.loop();
  }

  pause(): void {
    this.running = false;
    this.wake?.();
    this.emit({ type: 'status', status: this.status() });
  }

  setSpeed(tickMs: number): void {
    this.cfg.tickMs = tickMs;
    this.wake?.();
    this.emit({ type: 'status', status: this.status() });
  }

  async reset(seed?: number): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.wake?.();
    for (const r of this.registry.all()) r.controller?.abort(new Error('reset'));
    await this.tickInFlight?.catch(() => undefined);
    this.registry.clear();
    if (seed !== undefined) this.cfg.seed = seed;
    this.world = this.newWorld();
    this.history = [];
    this.populate();
    this.emit(this.snapshot());
    if (wasRunning) this.start();
  }

  private populate(): void {
    for (const entry of this.roster) this.spawn(entry);
    this.history = [this.world.stats()];
  }

  private async loop(): Promise<void> {
    this.loopRunning = true;
    try {
      while (this.running) {
        const t0 = Date.now();
        this.tickInFlight = this.tick();
        await this.tickInFlight.catch((err) => console.error('tick failed', err));
        this.tickInFlight = undefined;
        // Always yield to the event loop, even at tickMs 0, so IO (SSE, logs, HTTP) keeps flowing.
        const wait = Math.max(0, this.cfg.tickMs - (Date.now() - t0));
        if (this.running) await new Promise<void>((r) => ((this.wake = r), setTimeout(r, wait)));
        this.wake = undefined;
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private newWorld(): World {
    const w = new World(this.cfg.world, this.t, this.cfg.seed);
    w.roleTitle = (code) => this.roles.find((r) => r.key === code)?.title ?? code;
    return w;
  }

  // ---- rules ----------------------------------------------------------------

  private applyRules(rules: Rule[], roles: Role[], revision: string, changes: RuleChange[], roleChanges: RoleChange[], message?: string, initial = false): void {
    const values = ruleValues(rules);
    const missing = missingRules(values);
    if (missing.length) console.warn(`[lorebase] rules missing in revision ${revision.slice(0, 12)}: ${missing.join(', ')}; keeping previous values`);
    this.values = { ...this.values, ...values };
    this.laws = rules;
    this.roles = roles;
    this.revision = revision;
    if (initial) return;
    if (roleChanges.length) this.registry.refreshInstructions((id) => this.world.get(id));
    console.log(`[lorebase] rules_changed @ ${revision.slice(0, 12)}${message ? ` "${message}"` : ''}: ${changes.map((c) => `${c.key} ${c.old} -> ${c.new}`).join(', ') || 'no rule value change'}${roleChanges.length ? `; roles: ${roleChanges.map((r) => r.key).join(', ')}` : ''}`);
    this.emit({ type: 'rules_changed', revision, source: 'lorebase', changes, ...(roleChanges.length ? { roleChanges } : {}) });
    if (changes.length) {
      const list = changes.map((c) => `${c.key} ${c.old ?? '-'} → ${c.new ?? '-'}`).join(', ');
      this.emit({ type: 'world_event', tick: this.world.tick, kind: 'rules', text: this.t('events.rules', { changes: list }) });
    }
    this.emit({ type: 'status', status: this.status() });
  }

  // ---- people ---------------------------------------------------------------

  private spawn(entry: RosterEntry, at?: { x: number; y: number }): AgentState {
    const model = this.registry.modelFor(entry);
    const state = this.world.spawn({ id: entry.id, name: entry.name, role: entry.role, tier: entry.tier, model, personality: entry.personality }, this.values, { at });
    this.registry.create(state, entry);
    return state;
  }

  private roleKeys(): string[] {
    return this.roles.map((r) => r.key);
  }

  validateRoster(entries: unknown): string | undefined {
    return validateRoster(entries, this.roleKeys(), this.cfg);
  }

  validateEntry(e: unknown): string | undefined {
    return validateEntry(e, this.roleKeys(), this.cfg);
  }

  private clean(e: RosterEntry): RosterEntry {
    return cleanEntry(e);
  }

  async setRoster(entries: RosterEntry[]): Promise<string | undefined> {
    const err = this.validateRoster(entries);
    if (err) return err;
    this.roster = entries.map((e) => this.clean(e));
    this.saveRoster();
    await this.reset();
    return undefined;
  }

  addAgent(entry: RosterEntry): { agent?: ReturnType<Simulation['agentDto']>; error?: string } {
    const err = this.validateEntry(entry);
    if (err) return { error: err };
    if (this.world.living().some((a) => a.name.toLowerCase() === entry.name.trim().toLowerCase())) return { error: `"${entry.name}" already lives here` };
    if (this.world.living().length >= this.cfg.agents.maxRoster) return { error: `at most ${this.cfg.agents.maxRoster} people` };
    const state = this.spawn(this.clean(entry));
    const agent = this.agentDto(state);
    this.emit({ type: 'agent_update', agent });
    this.emit({ type: 'world_event', tick: this.world.tick, kind: 'birth', text: this.t('events.joined', { name: state.name }) });
    return { agent };
  }

  removeAgent(id: string): boolean {
    const a = this.world.get(id);
    if (!a || !a.alive) return false;
    this.registry.dispose(id);
    const ev = this.world.kill(id, 'left');
    this.emit({ type: 'agent_update', agent: this.agentDto(a) });
    if (ev) this.emit({ type: 'world_event', ...ev });
    return true;
  }

  private loadRoster(): RosterEntry[] {
    return loadRosterFile(this.cfg, this.roleKeys());
  }

  private saveRoster(): void {
    saveRosterFile(this.cfg, this.roster);
  }

  // ---- tick -----------------------------------------------------------------

  private async tick(): Promise<void> {
    this.tickValues = { ...this.values };
    const rules = this.tickValues;
    for (const ev of this.world.beginTick(rules)) this.emit({ type: 'world_event', ...ev });
    const alive = this.world.living();
    await Promise.all(alive.map((a) => this.runAgent(a)));
    const out = this.world.endTick(rules);
    for (const ev of out.events) this.emit({ type: 'world_event', ...ev });
    for (const d of out.deaths) this.registry.dispose(d.id);
    for (const b of out.births) {
      const parentEntry = { name: b.name, role: b.role, tier: b.tier, model: b.model, personality: b.personality };
      this.registry.create(b, parentEntry);
    }
    for (const t of out.tiles) this.emitTile(t);
    for (const a of this.world.agents.values()) {
      if (a.alive) a.status = 'idle';
      this.emit({ type: 'agent_update', agent: this.agentDto(a) });
    }
    const stats = this.world.stats();
    this.history.push(stats);
    if (this.history.length > this.cfg.agents.historyLimit) this.history.splice(0, this.history.length - this.cfg.agents.historyLimit);
    this.emit({ type: 'tick', tick: this.world.tick, season: seasonOf(this.world.tick, rules), stats });
    this.emit({ type: 'status', status: this.status() });
  }

  private async runAgent(a: AgentState): Promise<void> {
    const reg = this.registry.get(a.id);
    if (!reg) return;
    const changed = reg.lastLaws ? diffRules(reg.lastLaws, this.laws) : [];
    reg.lastLaws = this.laws;
    const look = this.world.look(a.id, this.tickValues, this.cfg.agents.lookMaxTiles).text;
    const prompt = observation(this.t, this.world, a, this.tickValues, this.laws, this.revision, look, changed);
    a.status = 'thinking';
    a.thought = '';
    this.emit({ type: 'agent_update', agent: this.agentDto(a) });
    const controller = new AbortController();
    reg.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.cfg.agents.timeoutMs)]);
    try {
      const handle = reg.runner.stream(prompt, { runId: reg.runId, signal });
      for await (const ev of handle) {
        if (ev.type === 'text_delta') {
          const delta = (ev.data as { text: string }).text;
          a.thought = (a.thought + delta).slice(-1000);
          this.emit({ type: 'agent_thought', agentId: a.id, delta });
        } else if (ev.type === 'tool_start' && a.status !== 'acting' && a.alive) {
          a.status = 'acting';
          this.emit({ type: 'agent_update', agent: this.agentDto(a) });
        }
      }
      const res = await handle.result;
      // A cut-off run may hold unexecuted tool calls: start a fresh session next tick instead.
      reg.runId = res.status === 'completed' || res.status === 'stopped' ? res.runId : undefined;
      if (res.status === 'failed' || res.status === 'interrupted') {
        console.warn(`[agent ${a.name}] run ${res.status}: ${res.reason}`);
        if (!a.thought) a.thought = `(${res.status}: ${res.reason ?? 'unknown'})`;
      }
    } catch (err) {
      reg.runId = undefined;
      console.warn(`[agent ${a.name}] ${err instanceof Error ? err.message : err}`);
    } finally {
      if (reg.controller === controller) reg.controller = undefined;
    }
  }

  private onAction(id: string, tool: string, args: unknown, res: ActionResult): void {
    const a = this.world.get(id);
    if (!a) return;
    if (tool !== 'look') a.lastAction = `${tool} ${short(args)} → ${res.ok ? 'ok' : 'failed'}`;
    this.emit({ type: 'agent_action', agentId: id, tick: this.world.tick, tool, args, result: res.text, ok: res.ok });
    for (const t of res.tiles ?? []) this.emitTile(t);
    for (const ev of res.events ?? []) this.emit({ type: 'world_event', ...ev });
    if (res.message) this.emit({ type: 'message', tick: res.message.tick, from: res.message.from, to: res.message.to, text: res.message.text });
    this.emit({ type: 'agent_update', agent: this.agentDto(a) });
  }

  private emitTile(t: Tile): void {
    this.emit({ type: 'tile_update', x: t.x, y: t.y, food: t.food, wood: t.wood, shelter: t.shelter });
  }

  // ---- views ----------------------------------------------------------------

  agentDto(a: AgentState) {
    return {
      id: a.id, name: a.name, role: a.role, tier: a.tier, model: a.model, x: a.x, y: a.y, hp: a.hp, maxHp: a.maxHp, hunger: a.hunger,
      inventory: { ...a.inventory }, alive: a.alive, sheltered: a.alive && this.world.isSheltered(a), status: a.status,
      thought: a.thought, lastAction: a.lastAction, generation: a.generation,
    };
  }

  rules(): Rule[] {
    return this.laws;
  }

  status(): SimStatus {
    const models = [...new Set(this.registry.all().map((r: RegisteredAgent) => r.model))];
    return {
      running: this.running,
      tick: this.world.tick,
      tickMs: this.cfg.tickMs,
      provider: this.registry.provider,
      model: this.cfg.modelOverride ?? (models.join(', ') || this.cfg.models.haiku),
      lorebase: { connected: this.watcher.connected, url: this.cfg.lorebase.url, domain: this.cfg.lorebase.domain, branch: this.cfg.lorebase.branch, revision: this.revision },
    };
  }

  snapshot(): SimEvent {
    const w = this.world;
    return {
      type: 'snapshot',
      tick: w.tick,
      season: this.laws.length ? seasonOf(w.tick, this.values) : 'spring',
      world: { w: w.width, h: w.height, tiles: w.tiles.map((t) => ({ ...t })) },
      agents: [...w.agents.values()].map((a) => this.agentDto(a)),
      rules: this.laws,
      history: this.history,
      status: this.status(),
      roster: this.roster,
    };
  }

  rosterView() {
    return { agents: this.roster, models: this.cfg.models, roles: this.roles.map((r) => r.key), roleDetails: this.roles };
  }
}

export type { WorldEvent };
