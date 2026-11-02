// The agent stack of the hub: one agent-layers stack per person (model, tools, runtime, telemetry composed from
// config/stacks/person.json), reached through `StackHub.stackFor(entity)`. A person acts in capacities (decide, reply,
// propose, ...); each capacity is an agent of the person's stack.
import {
  compose, type CallContext, type Message, type RunEvent, type RunInput, type RunResult, type Stack,
} from '@agent-layers/core';
import type { Tool } from 'reinloop';
import type { Ballot, ChairDecision } from '../rt/committee.ts';
import { decisionTier, faculties, ideaTools, tierConfig, type DecideHost } from '../rt/decide.ts';
import type { PlanData } from '../rt/groups.ts';
import type { RtEntity } from '../rt/world.ts';
import { gameAgents, loadPersonConfig } from './configs.ts';
import { feedTelemetry, type PersonRef, type StackFeed } from './feed.ts';
import { MockScripts, modelAdapters, Transcripts, type MockScript } from './model.ts';
import { CAPTURE, Scratch, ScratchEntry, toolAdapters, worldToolDefs } from './tools.ts';

export { StackFeed, feedTelemetry, type PersonRef, type ReasoningEvent, type TelemetryEvent, type UsageEvent } from './feed.ts';
export { loadPersonConfig } from './configs.ts';

/** What a person can do in a stack; each one is an agent of `config/stacks/person.json`. */
export type Capacity = 'decide' | 'reply' | 'propose' | 'write' | 'write_member' | 'vote' | 'ballot' | 'chair' | 'judge' | 'route' | 'lead';

export interface RunOpts {
  /** Session of the run: with the capacity it keys the run's scratch (tool instances, captured results). */
  sessionId: string;
  /** Run id (at most 128 characters, unique); generated when absent. */
  runId?: string;
  signal?: AbortSignal;
  /** Offline script for this run (used when the stack is built with the mock model). */
  mock?: MockScript;
  /** The run's own tool instances, with their budgets; when absent the person's static catalog is offered. */
  tools?: Tool[];
}

export interface CapResult {
  run: RunResult;
  /** Plan of the `commit_plan` call that ended the run. */
  plan?: PlanData;
  /** Ballot or chair decision of the record tool that ended the run. */
  record?: Ballot | ChairDecision;
  verdict?: { pass: boolean; feedback: string };
  delegate?: { member: string; input?: string };
  handoff?: string;
  rethink?: boolean;
  /** The conversation of the run's last model call (request messages and reply), for a closing turn. */
  transcript?: Message[];
}

export type CapStream = AsyncIterable<RunEvent> & { result: Promise<CapResult> };

export interface PersonStack {
  readonly person: PersonRef;
  readonly stack: Stack;
  readonly scratch: Scratch;
  run(cap: Capacity, input: RunInput, o: RunOpts): Promise<CapResult>;
  stream(cap: Capacity, input: RunInput, o: RunOpts): CapStream;
}

export interface StackHubOptions {
  /** Offline model instead of the Anthropic one. */
  mock: boolean;
  feed: StackFeed;
  /** Data directory (telemetry file). */
  dataDir: string;
  /** Static tool catalog of a person (default: faculties and idea tools). Run-specific tools come with each run. */
  catalog?: (e: RtEntity) => Tool[];
  /** Config file of the person stack (default: `STACK_PERSON_CONFIG` or `config/stacks/person.json`). */
  configFile?: string;
}

const MAX_RUN_ID = 128;

class Person implements PersonStack {
  readonly person: PersonRef;
  readonly stack: Stack;
  readonly scratch: Scratch;
  readonly #scripts: MockScripts;
  readonly #transcripts: Transcripts;
  #seq = 0;

  constructor(person: PersonRef, stack: Stack, scratch: Scratch, scripts: MockScripts, transcripts: Transcripts) {
    this.person = person;
    this.stack = stack;
    this.scratch = scratch;
    this.#scripts = scripts;
    this.#transcripts = transcripts;
  }

  #runId(cap: Capacity, o: RunOpts): string {
    const id = o.runId ?? `${this.person.id}:${cap}:${Date.now().toString(36)}${(++this.#seq).toString(36)}`;
    if (id.length > MAX_RUN_ID) throw new RangeError(`run id longer than ${MAX_RUN_ID} characters: ${id.slice(0, 40)}...`);
    return id;
  }

  /** Opens the run's scratch (and mock script), runs `go`, and builds the capacity result from what the run captured. */
  async #drive(cap: Capacity, o: RunOpts, runId: string, go: (init: Partial<CallContext>) => Promise<RunResult>): Promise<CapResult> {
    const { entry, release } = await this.scratch.acquire(o.sessionId, cap, o.tools);
    if (o.mock) this.#scripts.set(runId, o.mock);
    try {
      const run = await go({ runId, sessionId: o.sessionId, ...(o.signal ? { signal: o.signal } : {}) });
      return { run, ...captured(entry), ...this.#transcript(runId) };
    } finally {
      this.#scripts.delete(runId);
      this.#transcripts.forget(runId);
      release();
    }
  }

  #transcript(runId: string): { transcript?: Message[] } {
    const transcript = this.#transcripts.take(runId);
    return transcript ? { transcript } : {};
  }

  async run(cap: Capacity, input: RunInput, o: RunOpts): Promise<CapResult> {
    const runId = this.#runId(cap, o);
    return this.#drive(cap, o, runId, async (init) => (await this.stack.agent(cap)).run(input, init));
  }

  stream(cap: Capacity, input: RunInput, o: RunOpts): CapStream {
    const runId = this.#runId(cap, o);
    const buffer: RunEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: { error: unknown } | undefined;
    const notify = () => wake?.();
    const finish = () => {
      ended = true;
      notify();
    };
    const result = this.#drive(cap, o, runId, async (init) => {
      const agent = await this.stack.agent(cap);
      if (!agent.stream) return agent.run(input, init);
      let output = '';
      let end: Extract<RunEvent, { type: 'run.end' }> | undefined;
      const events: RunEvent[] = [];
      for await (const ev of agent.stream(input, init)) {
        events.push(ev);
        buffer.push(ev);
        notify();
        if (ev.type === 'text') output += String(ev.text ?? '');
        else if (ev.type === 'run.end') end = ev as typeof end;
      }
      return {
        runId, status: end?.status ?? 'failed', output,
        ...(end?.reason ? { reason: end.reason } : {}), ...(end?.usage ? { usage: end.usage } : {}), ...(end?.costUsd !== undefined ? { costUsd: end.costUsd } : {}),
        events,
      };
    });
    // The consumer may read only the events or only the result.
    result.then(finish, (error: unknown) => {
      failure = { error };
      finish();
    });
    return {
      result,
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (buffer.length) yield buffer.shift()!;
          else if (ended) break;
          else await new Promise<void>((r) => { wake = r; if (buffer.length || ended) r(); });
        }
        if (failure) throw failure.error;
      },
    };
  }
}

/** The capacity result fields filled by the calls that ended the run. */
function captured(entry: ScratchEntry): Omit<CapResult, 'run' | 'transcript'> {
  const out: Omit<CapResult, 'run' | 'transcript'> = {};
  for (const s of entry.stops) {
    const slot = CAPTURE[s.tool];
    if (slot === 'plan') {
      if (s.data) out.plan = s.data as PlanData;
    } else if (slot === 'rethink') out.rethink = true;
    else if (slot === 'record') out.record = s.data as Ballot | ChairDecision;
    else if (slot === 'verdict') out.verdict = s.data as { pass: boolean; feedback: string };
    else if (slot === 'delegate') out.delegate = (s.data as { member: string; input?: string } | undefined) ?? { member: s.text };
    else if (slot === 'handoff') out.handoff = typeof s.data === 'string' ? s.data : s.text;
  }
  return out;
}

/** Builds and keeps the stacks of the world's people. */
export class StackHub {
  readonly host: DecideHost;
  readonly feed: StackFeed;
  readonly mock: boolean;
  readonly dataDir: string;
  readonly #catalog: (e: RtEntity) => Tool[];
  readonly #configFile: string | undefined;
  readonly #stacks = new Map<string, Promise<PersonStack>>();

  constructor(host: DecideHost, o: StackHubOptions) {
    this.host = host;
    this.feed = o.feed;
    this.mock = o.mock;
    this.dataDir = o.dataDir;
    this.#configFile = o.configFile;
    this.#catalog = o.catalog ?? ((e) => {
      const tc = tierConfig(e, host.cfg);
      return [...faculties(host, e, { maxConsults: 0, ...(tc.maxWebCalls === undefined ? {} : { maxWebCalls: tc.maxWebCalls }) }), ...ideaTools(host, e)];
    });
  }

  /** The stack of a person; built on first use, kept while the person lives (key: id, tier, mock). */
  stackFor(e: RtEntity): Promise<PersonStack> {
    const tier = decisionTier(e, this.host.cfg);
    const key = `${e.id}|${tier}|${this.mock ? 'mock' : 'live'}`;
    let stack = this.#stacks.get(key);
    if (!stack) {
      stack = this.#build(e, tier);
      this.#stacks.set(key, stack);
      stack.catch(() => this.#stacks.delete(key));
    }
    return stack;
  }

  async #build(e: RtEntity, tier: ReturnType<typeof decisionTier>): Promise<PersonStack> {
    const person: PersonRef = { id: e.id, name: e.name, model: e.model, tier };
    const scratch = new Scratch();
    const scripts = new MockScripts();
    const transcripts = new Transcripts();
    const config = await loadPersonConfig(tier, this.mock, {
      model: e.model, dataDir: this.dataDir, ...(this.#configFile ? { file: this.#configFile } : {}),
      agents: (current) => gameAgents(this.host.cfg, this.host.sim, tier, current),
    });
    const defs = worldToolDefs(e, this.#catalog(e), scratch);
    const stack = await compose(config, {
      adapters: [
        ...modelAdapters({ person, feed: this.feed, scripts, transcripts }),
        ...toolAdapters({ scratch, defs, lorebase: this.host.cfg.brain.tools }),
      ],
      telemetry: [feedTelemetry(this.feed, person)],
    });
    return new Person(person, stack, scratch, scripts, transcripts);
  }

  async close(): Promise<void> {
    const all = await Promise.allSettled([...this.#stacks.values()]);
    this.#stacks.clear();
    await Promise.allSettled(all.map((r) => (r.status === 'fulfilled' ? r.value.stack.close() : undefined)));
  }
}
