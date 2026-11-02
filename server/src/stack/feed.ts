// What the agent stack reports to the game: model usage and reasoning (from the model tap) and the
// telemetry records of every stack (spans of the runtime, tools and model calls). One feed per hub;
// the game, the Observatory and the mnemo run-store subscribe to it, the stack never knows who listens.
import { EventEmitter } from 'node:events';
import { type Attributes, recordingTelemetry, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';
import type { Attributes as PlexusAttributes, TelemetryHook } from '@agent-plexus/core';
import type { TokenUsage } from '../rt/observatory.ts';

/** The person a stack belongs to (the same shape `DecideHost.ranModel` takes). */
export interface PersonRef {
  id: string;
  name: string;
  model: string;
  tier: string;
}

/** One model call. `usage.inputTokens` includes cache reads and writes, as everywhere in the game. */
export interface UsageEvent {
  person: PersonRef;
  runId: string;
  /** Capacity (the agent name in the stack config). */
  agent: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

/** The reasoning summary of one model call (empty when the model shows none). */
export interface ReasoningEvent {
  person: PersonRef;
  runId: string;
  agent: string;
  text: string;
}

/** One run of a capacity ended (however it ended: a thrown error is `failed`). */
export interface RunEndEvent {
  person: PersonRef;
  runId: string;
  /** Capacity (the agent name in the stack config). */
  agent: string;
  /** Run status: completed, stopped, interrupted, failed, ... */
  status: string;
  reason?: { code: string; detail?: string };
  startedAt: number;
  durationMs: number;
}

export interface TelemetryEvent {
  person?: PersonRef;
  record: TelemetryRecord;
}

interface FeedEvents {
  usage: [UsageEvent];
  reasoning: [ReasoningEvent];
  run: [RunEndEvent];
  telemetry: [TelemetryEvent];
}

/** Typed event hub between the stacks and the game. A failing listener never reaches the stack. */
export class StackFeed {
  readonly #bus = new EventEmitter();

  on<K extends keyof FeedEvents>(event: K, listener: (...args: FeedEvents[K]) => void): () => void {
    this.#bus.on(event, listener as (...args: unknown[]) => void);
    return () => void this.#bus.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof FeedEvents>(event: K, ...args: FeedEvents[K]): void {
    for (const listener of this.#bus.listeners(event)) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.warn(`[stack] feed listener for "${event}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  close(): void {
    this.#bus.removeAllListeners();
  }
}

/**
 * Telemetry adapter instance that forwards every finished span, event and metric to the feed (tagged with the person).
 * Pass it to `compose(config, { telemetry: [...] })`; the configured recorders (jsonl) keep running beside it.
 */
export function feedTelemetry(feed: StackFeed, person?: PersonRef): TelemetryPort {
  return recordingTelemetry((record) => feed.emit('telemetry', { ...(person ? { person } : {}), record }), 'hub-feed');
}

/** What the finished spans of one name add up to. */
export interface SpanSummary {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

/** Spans of the stacks and group systems (`agent.*`, `plexus.*`) added up by name, for the Observatory. */
export class SpanTally {
  readonly #byName = new Map<string, SpanSummary>();

  add(record: TelemetryRecord): void {
    if (record.type !== 'span') return;
    const s = this.#byName.get(record.name) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    s.count++;
    if (record.status === 'error') s.errors++;
    s.totalMs += record.durationMs;
    s.maxMs = Math.max(s.maxMs, record.durationMs);
    this.#byName.set(record.name, s);
  }

  summary(): Record<string, SpanSummary> {
    return Object.fromEntries([...this.#byName].map(([name, s]) => [name, { ...s, totalMs: Math.round(s.totalMs), maxMs: Math.round(s.maxMs) }]));
  }
}

/**
 * Telemetry hook of a group system (host of `assemble`): its spans (`plexus.run`, `plexus.node`, `plexus.hop`, ...) go to the
 * feed as records, like those of the person stacks. Events and metrics are dropped.
 */
export function plexusTelemetry(feed: StackFeed): TelemetryHook {
  return {
    async span(name, attrs, fn) {
      const start = Date.now();
      const all: PlexusAttributes = { ...attrs };
      const events: Array<{ name: string; attrs?: PlexusAttributes }> = [];
      const done = (status: 'ok' | 'error', error?: string) => feed.emit('telemetry', {
        record: {
          type: 'span', name, layer: 'harness', start: new Date(start).toISOString(), durationMs: Date.now() - start, status,
          ...(error ? { error } : {}), attrs: all as Attributes, events: events as never,
        },
      });
      try {
        const out = await fn({ set: (a) => void Object.assign(all, a), event: (n, a) => void events.push({ name: n, ...(a ? { attrs: a } : {}) }) });
        done('ok');
        return out;
      } catch (err) {
        done('error', err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    event: () => undefined,
    metric: () => undefined,
  };
}
