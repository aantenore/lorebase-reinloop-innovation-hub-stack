// Tools of a person's stack. The tools themselves stay what they are (reinloop Tool objects built for each run, with
// their own budgets and closures); the stack only needs their specs up front and a way to reach the run's instance.
// `scratch` is that way: the run puts its tool instances there, and the stack's tool sources call through to them.
import {
  matchesAny, type AnyAdapter, type CallContext, type ToolPort, type ToolResult, type ToolSpec, defineAdapter, PORT_VERSIONS,
} from '@agent-layers/core';
import { initialState, type Tool } from 'reinloop';
import type { RtEntity } from '../rt/world.ts';

/** `ToolResult.ext` key that ends the run (the reinloop adapter reads it as "stop after this call"). */
export const STOP_KEY = 'reinloop.stop';

/** A tool as a plain definition: spec fields and the function behind them. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  params: Record<string, unknown>;
  risk?: 'read' | 'write' | 'exec';
  run(args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>;
}

/** A call that ended the run (a tool answering with `stop`), as the run saw it. */
export interface Stop {
  tool: string;
  text: string;
  data?: unknown;
}

/** Everything one run keeps outside the stack: its tool instances, the calls that ended it, and an optional gate. */
export class ScratchEntry {
  /** Per-run tool instances by name. */
  readonly tools: Map<string, Tool>;
  /** True when the run named its tools: then only they are listed and callable. */
  readonly explicit: boolean;
  readonly stops: Stop[] = [];
  /** Tools the run still refuses to run: returns the reason shown to the model, or undefined to let the call through. */
  gate?: (tool: string) => string | undefined;

  constructor(tools?: readonly Tool[]) {
    this.explicit = tools !== undefined;
    this.tools = new Map((tools ?? []).map((t) => [t.name, t]));
  }
}

/**
 * Per-run state, keyed by (session id, agent). Runs of the same key are serialized, so two runs never share an entry;
 * runs of different keys go in parallel.
 */
export class Scratch {
  readonly #entries = new Map<string, ScratchEntry>();
  readonly #tails = new Map<string, Promise<unknown>>();

  static key(sessionId: string | undefined, agent: string): string {
    return `${sessionId ?? ''}\u0000${agent}`;
  }

  get(sessionId: string | undefined, agent: string): ScratchEntry | undefined {
    return this.#entries.get(Scratch.key(sessionId, agent));
  }

  /**
   * Opens an entry for (sessionId, agent) once the earlier run with the same key has released its own. The caller
   * releases it when the run ends.
   */
  async acquire(sessionId: string, agent: string, tools?: readonly Tool[]): Promise<{ entry: ScratchEntry; release(): void }> {
    const key = Scratch.key(sessionId, agent);
    const before = this.#tails.get(key) ?? Promise.resolve();
    let free!: () => void;
    const tail = before.then(() => new Promise<void>((r) => { free = r; }));
    this.#tails.set(key, tail);
    await before;
    const entry = new ScratchEntry(tools);
    this.#entries.set(key, entry);
    let released = false;
    return {
      entry,
      release: () => {
        if (released) return;
        released = true;
        this.#entries.delete(key);
        free();
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      },
    };
  }

  /** Runs `fn` with an entry open for (sessionId, agent). */
  async with<T>(sessionId: string, agent: string, tools: readonly Tool[] | undefined, fn: (entry: ScratchEntry) => Promise<T>): Promise<T> {
    const { entry, release } = await this.acquire(sessionId, agent, tools);
    try {
      return await fn(entry);
    } finally {
      release();
    }
  }
}

/** Minimal tool context for a tool called through the stack (tools read the signal; the run state is theirs only inside reinloop). */
const toolContext = (ctx: CallContext) => ({
  runId: ctx.runId,
  agent: ctx.agent,
  signal: ctx.signal ?? new AbortController().signal,
  state: initialState(ctx.runId, ctx.agent),
  emit: () => undefined,
  inherit: {},
});

const isAbort = (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Runs a reinloop tool and shapes its output as a ToolResult: `{content,isError,stop,data}` becomes `{ok,text,data,ext}`. */
export async function callReinloopTool(t: Tool, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
  try {
    const raw = await t.run(args, toolContext(ctx) as never);
    const out = typeof raw === 'string' ? { content: raw } : raw;
    return {
      ok: !out.isError,
      text: out.content,
      ...(out.data !== undefined ? { data: out.data } : {}),
      ...(out.stop && !out.isError ? { ext: { [STOP_KEY]: true } } : {}),
    };
  } catch (err) {
    if (isAbort(err) || ctx.signal?.aborted) throw err;
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * A reinloop tool as a definition. When the run keeps its own instance in `scratch` (budgets, captured results), the
 * call goes to that instance; otherwise to `t` itself.
 */
export function fromReinloopTool(t: Tool, scratch?: Scratch): ToolDef {
  return {
    name: t.name,
    description: t.description,
    params: t.schema,
    ...(t.risk ? { risk: t.risk } : {}),
    run: (args, ctx) => callReinloopTool(scratch?.get(ctx.sessionId, ctx.agent)?.tools.get(t.name) ?? t, args, ctx),
  };
}

/** Definitions of a person's tools (static catalog: used when a run does not bring its own tools). */
export function worldToolDefs(_e: Pick<RtEntity, 'id'>, tools: readonly Tool[], scratch?: Scratch): ToolDef[] {
  return tools.map((t) => fromReinloopTool(t, scratch));
}

const specOf = (name: string, description: string, params: Record<string, unknown>, risk?: string): ToolSpec => ({
  name, description, params, ...(risk ? { risk } : {}),
});

/**
 * A tool source over the scratch. It lists what the run brought (or the static catalog when it brought nothing) and
 * calls the run's instances, so each run keeps its own budgets and capture. `accepts` splits the run's flat tool list
 * between sources.
 */
export function scratchPort(source: string, accepts: (name: string) => boolean, defs: readonly ToolDef[], scratch: Scratch): ToolPort {
  const catalog = new Map(defs.filter((d) => accepts(d.name)).map((d) => [d.name, d]));
  return {
    name: source,
    async listTools(ctx) {
      const entry = scratch.get(ctx.sessionId, ctx.agent);
      if (entry?.explicit) return [...entry.tools.values()].filter((t) => accepts(t.name)).map((t) => specOf(t.name, t.description, t.schema, t.risk));
      return [...catalog.values()].map((d) => specOf(d.name, d.description, d.params, d.risk));
    },
    async callTool(name, args, ctx) {
      const entry = scratch.get(ctx.sessionId, ctx.agent);
      const denied = entry?.gate?.(name);
      if (denied) return { ok: false, text: denied };
      const live = entry?.tools.get(name);
      let result: ToolResult;
      if (live && accepts(name)) result = await callReinloopTool(live, args, ctx);
      else if (!entry?.explicit && catalog.has(name)) result = await catalog.get(name)!.run(args, ctx);
      else return { ok: false, text: `Tool "${name}" is not available to this run` };
      if (entry && result.ext?.[STOP_KEY] === true) entry.stops.push({ tool: name, text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) });
      return result;
    },
  };
}

/** Tool sources of a person's stack: `source` option of the `hub-tools` adapter. */
export interface ToolSources {
  scratch: Scratch;
  /** Static catalog (see `worldToolDefs`). */
  defs: readonly ToolDef[];
  /** Names of the Lorebase read tools (the `lorebase` source); everything else belongs to `world`. */
  lorebase: readonly string[];
}

export function toolAdapters(sources: ToolSources): AnyAdapter[] {
  const isLorebase = (name: string) => matchesAny(sources.lorebase, name);
  return [
    defineAdapter<'ToolPort', { source: 'world' | 'lorebase' }>({
      layer: 'tool',
      port: 'ToolPort',
      name: 'hub-tools',
      direction: 'outbound',
      maps: { technology: 'hub tools of one person (per-run instances)' },
      portVersion: PORT_VERSIONS.ToolPort,
      tiers: ['prototype', 'production'],
      description: 'The tools of the world (social, ideas, memory, research) or the Lorebase read tools, called through the run\'s own tool instances.',
      optionsSchema: { type: 'object', required: ['source'], properties: { source: { enum: ['world', 'lorebase'] } }, additionalProperties: false },
      ext: { namespace: 'reinloop', produces: [STOP_KEY] },
      create: (options, ctx) => scratchPort(ctx.name, options.source === 'lorebase' ? isLorebase : (n) => !isLorebase(n), sources.defs, sources.scratch),
    }),
  ];
}

/**
 * Tool calls that end a run, and what each one fills in the capacity result. The tools themselves belong to the call
 * sites; this table only says where their data goes.
 */
export const CAPTURE: Readonly<Record<string, 'plan' | 'rethink' | 'record' | 'verdict' | 'delegate' | 'handoff'>> = Object.freeze({
  commit_plan: 'plan',
  rethink: 'rethink',
  vota_idea: 'record',
  decide_idea: 'record',
  verdetto: 'verdict',
  delega: 'delegate',
  instrada: 'handoff',
});
