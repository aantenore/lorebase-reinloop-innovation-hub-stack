// What the agent stack reports to the game: model usage and reasoning (from the model tap) and the
// telemetry records of every stack (spans of the runtime, tools and model calls). One feed per hub;
// the game, the Observatory and the mnemo run-store subscribe to it, the stack never knows who listens.
import { EventEmitter } from 'node:events';
import { recordingTelemetry, type TelemetryPort, type TelemetryRecord } from '@agent-layers/core';
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

export interface TelemetryEvent {
  person?: PersonRef;
  record: TelemetryRecord;
}

interface FeedEvents {
  usage: [UsageEvent];
  reasoning: [ReasoningEvent];
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
