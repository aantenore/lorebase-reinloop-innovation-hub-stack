// Model ports of the hub: `hub-anthropic` (reinloop's Anthropic provider behind the agent-layers ModelPort, so
// prompt caching, thinking, effort and the workspace header stay as they were) and `hub-mock` (the world-aware offline
// scripts). Both are wrapped by `tap`, which reports usage and reasoning to the feed and keeps the last conversation of
// each run for the closing turn.
import {
  assembleDeltas, defineAdapter, messageText, PORT_VERSIONS, replyToDeltas,
  type AnyAdapter, type CallContext, type Message, type ModelDelta, type ModelPort, type ModelReply, type ModelRequest, type Part, type ToolInfo, type Usage,
} from '@agent-layers/core';
import {
  costOf, pricingFor, resolveModel,
  type MockTurn, type ModelParams, type ModelRef, type ModelRequest as LoopRequest, type ModelResponse, type Message as LoopMessage, type Part as LoopPart, type Usage as LoopUsage,
} from 'reinloop';
import type { TokenUsage } from '../rt/observatory.ts';
import type { PersonRef, StackFeed } from './feed.ts';

/** Model name an agent config uses for "the model of this stack" (the adapter's `model` option). */
export const DEFAULT_MODEL = 'default';

/** ext keys of the `anthropic` namespace carried on model shapes. */
export const EXT = Object.freeze({
  signature: 'anthropic.signature',
  redacted: 'anthropic.redacted',
  params: 'anthropic.params',
  cacheRead: 'anthropic.cacheReadTokens',
  cacheWrite: 'anthropic.cacheWriteTokens',
  cacheWrite1h: 'anthropic.cacheWrite1hTokens',
});

// ---------------------------------------------------------------------------------------------------------------
// Tool names. The stack prefixes every tool with its source (`world__commit_plan`); the model keeps seeing the plain
// names the prompts talk about, as long as they stay unique inside one request.

const SEP = '__';

export interface ToolAlias {
  /** Name the model sees for a stack tool name. */
  toModel(name: string): string;
  /** Stack tool name for a name the model used. */
  fromModel(name: string): string;
}

export function toolAlias(tools: readonly Pick<ToolInfo, 'name'>[] = []): ToolAlias {
  const full = new Set(tools.map((t) => t.name));
  const shortToFull = new Map<string, string>();
  const clashes = new Set<string>();
  for (const { name } of tools) {
    const i = name.indexOf(SEP);
    const short = i > 0 ? name.slice(i + SEP.length) : '';
    if (!short || full.has(short)) continue;
    if (shortToFull.has(short)) clashes.add(short);
    else shortToFull.set(short, name);
  }
  for (const c of clashes) shortToFull.delete(c);
  const fullToShort = new Map([...shortToFull].map(([s, f]) => [f, s]));
  return { toModel: (n) => fullToShort.get(n) ?? n, fromModel: (n) => shortToFull.get(n) ?? n };
}

// ---------------------------------------------------------------------------------------------------------------
// Thinking blocks. Anthropic wants the thinking of a tool-using turn back (signature included), and a streamed reply
// loses it on the way through the ModelPort deltas. The port keeps the blocks by tool call id and puts them back.

type Thinking = Extract<LoopPart, { type: 'thinking' }>;

export class ThinkingMemory {
  readonly #byCall = new Map<string, Thinking[]>();
  readonly #max: number;

  constructor(max = 512) {
    this.#max = max;
  }

  remember(callIds: readonly string[], blocks: Thinking[]): void {
    for (const id of callIds) {
      this.#byCall.delete(id);
      this.#byCall.set(id, blocks);
    }
    while (this.#byCall.size > this.#max) this.#byCall.delete(this.#byCall.keys().next().value!);
  }

  /** The remembered thinking of an assistant message that calls tools replaces whatever thinking it carries. */
  restore(parts: LoopPart[]): LoopPart[] {
    for (const p of parts) {
      if (p.type !== 'tool_call') continue;
      const blocks = this.#byCall.get(p.id);
      if (blocks) return [...blocks, ...parts.filter((x) => x.type !== 'thinking')];
    }
    return parts;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Conversion between the ModelPort language and reinloop's provider shapes.

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Settings that reach the provider: sampling from the request, Anthropic params from `ext["anthropic.params"]` (no temperature unless asked). */
function paramsOf(req: ModelRequest): ModelParams {
  const s = req.settings ?? {};
  const a = (req.ext?.[EXT.params] ?? {}) as Partial<ModelParams>;
  return {
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.maxOutputTokens !== undefined ? { maxTokens: s.maxOutputTokens } : {}),
    ...(s.stop ? { stop: s.stop } : {}),
    ...(a.thinking ? { thinking: a.thinking } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.cache !== undefined ? { cache: a.cache } : {}),
    ...(a.cacheTtl ? { cacheTtl: a.cacheTtl } : {}),
  };
}

export function toLoopRequest(req: ModelRequest, alias: ToolAlias, memory: ThinkingMemory = new ThinkingMemory()): LoopRequest {
  const system: string[] = [];
  const names = new Map<string, string>();
  const messages: LoopMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      system.push(messageText(m));
      continue;
    }
    let parts: LoopPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') parts.push({ type: 'text', text: (p as { text: string }).text });
      else if (p.type === 'call') {
        const c = p as { id: string; tool: string; args: Record<string, unknown>; invalid?: string };
        const name = alias.toModel(c.tool);
        names.set(c.id, name);
        parts.push(c.invalid !== undefined
          ? { type: 'tool_call', id: c.id, name, args: {}, argsIssue: { error: 'arguments must be a JSON object', repaired: false } }
          : { type: 'tool_call', id: c.id, name, args: c.args });
      } else if (p.type === 'result') {
        const r = p as { callId: string; ok: boolean; text: string };
        parts.push({ type: 'tool_result', callId: r.callId, name: names.get(r.callId) ?? '', content: r.text, ...(r.ok ? {} : { isError: true }) });
      } else if (p.type === 'reasoning') {
        const r = p as { text: string; ext?: Record<string, unknown> };
        const signature = str(r.ext?.[EXT.signature]);
        const redacted = str(r.ext?.[EXT.redacted]);
        parts.push({ type: 'thinking', text: r.text, ...(signature ? { signature } : {}), ...(redacted ? { redacted } : {}) });
      }
    }
    if (m.role === 'assistant') parts = memory.restore(parts);
    messages.push({ role: m.role as LoopMessage['role'], parts });
  }
  const params = paramsOf(req);
  return {
    model: req.model,
    ...(system.length ? { instructions: system.join('\n\n') } : {}),
    messages,
    tools: (req.tools ?? []).map((t) => ({ name: alias.toModel(t.name), description: t.description ?? '', schema: t.params })),
    ...(Object.keys(params).length ? { params } : {}),
  };
}

const FINISH: Record<string, string> = { end: 'end', tool_calls: 'tools', max_tokens: 'limit', refusal: 'refused' };

function usageOf(u: LoopUsage | undefined): Usage {
  const ext: Record<string, unknown> = {
    ...(u?.cacheReadTokens ? { [EXT.cacheRead]: u.cacheReadTokens } : {}),
    ...(u?.cacheWriteTokens ? { [EXT.cacheWrite]: u.cacheWriteTokens } : {}),
    ...(u?.cacheWrite1hTokens ? { [EXT.cacheWrite1h]: u.cacheWrite1hTokens } : {}),
  };
  return { inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, ...(Object.keys(ext).length ? { ext } : {}) };
}

/** Usage as the game counts it (`inputTokens` includes the cache counts). */
export function tokenUsage(u: Usage | undefined): TokenUsage {
  const n = (k: string) => Number(u?.ext?.[k] ?? 0) || 0;
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    ...(n(EXT.cacheRead) ? { cacheReadTokens: n(EXT.cacheRead) } : {}),
    ...(n(EXT.cacheWrite) ? { cacheWriteTokens: n(EXT.cacheWrite) } : {}),
    ...(n(EXT.cacheWrite1h) ? { cacheWrite1hTokens: n(EXT.cacheWrite1h) } : {}),
  };
}

export function fromLoopResponse(res: ModelResponse, alias: ToolAlias, memory: ThinkingMemory, model: string): ModelReply {
  const parts: Part[] = [];
  const thinking: Thinking[] = [];
  const calls: string[] = [];
  for (const p of res.message.parts) {
    if (p.type === 'thinking') {
      thinking.push(p);
      parts.push({ type: 'reasoning', text: p.text, ...(p.signature || p.redacted ? { ext: { ...(p.signature ? { [EXT.signature]: p.signature } : {}), ...(p.redacted ? { [EXT.redacted]: p.redacted } : {}) } } : {}) });
    } else if (p.type === 'text') parts.push({ type: 'text', text: p.text });
    else if (p.type === 'tool_call') {
      calls.push(p.id);
      const bad = p.argsIssue && !p.argsIssue.repaired;
      const args = p.args && typeof p.args === 'object' && !Array.isArray(p.args) ? (p.args as Record<string, unknown>) : {};
      parts.push({ type: 'call', id: p.id, tool: alias.fromModel(p.name), args: bad ? {} : args, ...(bad ? { invalid: p.argsIssue!.error } : {}) });
    }
  }
  if (calls.length && thinking.some((t) => t.signature || t.redacted)) memory.remember(calls, thinking);
  return {
    model: res.model || model,
    message: { role: 'assistant', parts },
    finish: calls.length ? 'tools' : FINISH[res.stopReason] ?? 'other',
    usage: usageOf(res.usage),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// hub-anthropic

export interface AnthropicPortOptions {
  /** Model used when an agent asks for `default`: `anthropic/<id>` (a bare id gets the `anthropic/` prefix). */
  model: string;
  env?: Record<string, string | undefined>;
  /** Resolves a model spec to a provider (reinloop's `resolveModel`; replaced in tests). */
  resolve?: (spec: string, env?: Record<string, string | undefined>) => ModelRef;
}

const specOf = (model: string) => (model.includes('/') ? model : `anthropic/${model}`);

export function hubAnthropicPort(o: AnthropicPortOptions, name = 'hub-anthropic'): ModelPort {
  const memory = new ThinkingMemory();
  const refs = new Map<string, ModelRef>();
  const resolve = o.resolve ?? ((spec, env) => resolveModel(spec, env));
  const refOf = (requested: string): ModelRef => {
    const spec = specOf(!requested || requested === DEFAULT_MODEL ? o.model : requested);
    let ref = refs.get(spec);
    if (!ref) refs.set(spec, (ref = resolve(spec, o.env)));
    return ref;
  };
  const call = async (req: ModelRequest, ctx: CallContext, hooks: { onText?: (t: string) => void; onThinking?: (t: string) => void } = {}): Promise<ModelReply> => {
    const ref = refOf(req.model);
    const alias = toolAlias(req.tools);
    const loop = { ...toLoopRequest(req, alias, memory), model: ref.model };
    const res = await ref.provider.generate(loop, { signal: ctx.signal ?? new AbortController().signal, ...hooks });
    return fromLoopResponse(res, alias, memory, ref.model);
  };
  return {
    name,
    chat: (req, ctx) => call(req, ctx),
    async *stream(req, ctx): AsyncGenerator<ModelDelta> {
      const queue: ModelDelta[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      let streamedText = false;
      let streamedThinking = false;
      const push = (d: ModelDelta) => {
        queue.push(d);
        wake?.();
      };
      const work = call(req, ctx, {
        onText: (text) => { streamedText = true; push({ type: 'text', text }); },
        onThinking: (text) => { streamedThinking = true; push({ type: 'reasoning', text }); },
      }).finally(() => {
        finished = true;
        wake?.();
      });
      work.catch(() => undefined);
      while (!finished || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((r) => { wake = r; if (finished || queue.length) r(); });
      }
      const reply = await work;
      // Whatever the provider did not stream (non-streaming backends, thinking shown only at the end) comes from the reply.
      for (const d of replyToDeltas(reply)) {
        if (d.type === 'end') yield { ...d, ...(reply.usage ? { usage: reply.usage } : {}) };
        else if ((d.type === 'text' && streamedText) || (d.type === 'reasoning' && streamedThinking)) continue;
        else yield d;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// hub-mock

/** The scripted turns of a run, as the offline mocks of the game write them (reinloop request in, mock turn out). */
export type MockScript = (req: LoopRequest, i: number) => MockTurn;

/** Scripts by run id: the stack registers one for the run it starts, the mock port plays it. */
export class MockScripts {
  readonly #scripts = new Map<string, { script: MockScript; calls: number }>();

  set(runId: string, script: MockScript): void {
    this.#scripts.set(runId, { script, calls: 0 });
  }

  delete(runId: string): void {
    this.#scripts.delete(runId);
  }

  /** Next turn of the run, or undefined when it has no script. */
  next(runId: string, req: LoopRequest): MockTurn | undefined {
    const s = this.#scripts.get(runId);
    return s ? s.script(req, s.calls++) : undefined;
  }
}

const abortError = () => new DOMException('This operation was aborted', 'AbortError');

function wait(ms: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const chars = (m: LoopMessage) => m.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : p.type === 'tool_result' ? p.content.length : 0), 0);
const tokensOf = (n: number) => Math.ceil(n / 4);

/** Without a script the mock answers like an echo of the last user message. */
const echo = (req: LoopRequest): MockTurn => {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  return { text: last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '' };
};

export function hubMockPort(o: { model?: string; scripts: MockScripts }, name = 'hub-mock'): ModelPort {
  const model = o.model ?? 'mock';
  let seq = 0;
  const answer = async (req: ModelRequest, ctx: CallContext): Promise<ModelReply> => {
    const alias = toolAlias(req.tools);
    const loop = toLoopRequest(req, alias);
    const turn = o.scripts.next(ctx.runId, loop) ?? echo(loop);
    await wait(turn.delayMs, ctx.signal);
    if (turn.error) throw Object.assign(new Error(turn.error.message ?? `mock model error ${turn.error.status}`), { status: turn.error.status });
    const n = ++seq;
    const parts: Part[] = [];
    for (const p of turn.parts ?? []) {
      if (p.type === 'thinking') parts.push({ type: 'reasoning', text: p.text });
      else if (p.type === 'text') parts.push({ type: 'text', text: p.text });
    }
    if (turn.text) parts.push({ type: 'text', text: turn.text });
    const calls = (turn.toolCalls ?? []).map((c, k) => ({
      type: 'call' as const, id: c.id ?? `mock_${n}_${k}`, tool: alias.fromModel(c.name),
      args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {},
    }));
    parts.push(...calls);
    const outChars = parts.reduce((s, p) => s + (p.type === 'text' || p.type === 'reasoning' ? String((p as { text: string }).text).length : p.type === 'call' ? JSON.stringify((p as { args: unknown }).args).length : 0), 0);
    const usage = {
      inputTokens: turn.usage?.inputTokens ?? tokensOf(loop.messages.reduce((s, m) => s + chars(m), 0) + (loop.instructions?.length ?? 0)),
      outputTokens: turn.usage?.outputTokens ?? tokensOf(outChars),
    };
    return {
      id: `mock-${n}`, model, message: { role: 'assistant', parts },
      finish: calls.length ? 'tools' : FINISH[turn.stopReason ?? 'end'] ?? 'other', usage,
    };
  };
  return {
    name,
    chat: answer,
    async *stream(req, ctx): AsyncGenerator<ModelDelta> {
      const reply = await answer(req, ctx);
      for (const d of replyToDeltas(reply)) {
        if (d.type !== 'text') {
          yield d;
          continue;
        }
        for (const word of d.text.match(/\s*\S+|\s+/g) ?? []) {
          if (ctx.signal?.aborted) throw abortError();
          yield { type: 'text', text: word };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// tap

/** Last conversation of each run (request messages and the reply), kept until the stack takes it. */
export class Transcripts {
  readonly #byRun = new Map<string, Message[]>();
  readonly #max: number;

  constructor(max = 64) {
    this.#max = max;
  }

  set(runId: string, messages: Message[]): void {
    this.#byRun.delete(runId);
    this.#byRun.set(runId, messages);
    while (this.#byRun.size > this.#max) this.#byRun.delete(this.#byRun.keys().next().value!);
  }

  /** The conversation and forgets it. */
  take(runId: string): Message[] | undefined {
    const m = this.#byRun.get(runId);
    this.#byRun.delete(runId);
    return m;
  }

  forget(runId: string): void {
    this.#byRun.delete(runId);
  }
}

export type TappedPort = ModelPort & { readonly transcripts: Transcripts };

/** Reasoning text of a reply. */
const reasoningOf = (reply: ModelReply) => reply.message.parts.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('\n').trim();

/** Price of a reply in USD (0 for models without a price, such as the mock). */
function priceOf(reply: ModelReply, requested: string): number {
  const id = reply.model || requested;
  const pricing = pricingFor(id.slice(id.indexOf('/') + 1));
  if (!pricing || !reply.usage) return 0;
  const u = tokenUsage(reply.usage);
  return costOf(pricing, { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, ...(u.cacheReadTokens ? { cacheReadTokens: u.cacheReadTokens } : {}), ...(u.cacheWriteTokens ? { cacheWriteTokens: u.cacheWriteTokens } : {}), ...(u.cacheWrite1hTokens ? { cacheWrite1hTokens: u.cacheWrite1hTokens } : {}) });
}

/**
 * Wraps a ModelPort: every call reports its usage (with cache counts and price) and its reasoning to the feed, and the
 * conversation of the run is kept for `transcripts.take(runId)`.
 */
export function tap(port: ModelPort, person: PersonRef, feed: StackFeed, transcripts: Transcripts = new Transcripts()): TappedPort {
  const record = (req: ModelRequest, reply: ModelReply, ctx: CallContext) => {
    transcripts.set(ctx.runId, [...req.messages, reply.message]);
    const text = reasoningOf(reply);
    if (text) feed.emit('reasoning', { person, runId: ctx.runId, agent: ctx.agent, text });
    if (reply.usage) feed.emit('usage', { person, runId: ctx.runId, agent: ctx.agent, model: reply.model || req.model, usage: tokenUsage(reply.usage), costUsd: priceOf(reply, req.model) });
  };
  return {
    ...(port.name ? { name: port.name } : {}),
    ...(port.native ? { native: () => port.native!() } : {}),
    ...(port.close ? { close: () => port.close!() } : {}),
    transcripts,
    async chat(req, ctx) {
      const reply = await port.chat(req, ctx);
      record(req, reply, ctx);
      return reply;
    },
    ...(port.stream ? {
      async *stream(req: ModelRequest, ctx: CallContext): AsyncGenerator<ModelDelta> {
        const seen: ModelDelta[] = [];
        for await (const d of port.stream!(req, ctx)) {
          seen.push(d);
          yield d;
        }
        record(req, assembleDeltas(seen, req.model), ctx);
      },
    } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Adapter descriptors, registered with `compose(config, { adapters })` for each person.

export interface ModelKit {
  person: PersonRef;
  feed: StackFeed;
  scripts: MockScripts;
  transcripts: Transcripts;
  /** Provider resolution of `hub-anthropic` (tests replace it). */
  resolve?: AnthropicPortOptions['resolve'];
}

const EXT_DECLARATION = {
  namespace: 'anthropic',
  produces: [EXT.signature, EXT.redacted, EXT.cacheRead, EXT.cacheWrite, EXT.cacheWrite1h],
} as const;

export function modelAdapters(kit: ModelKit): AnyAdapter[] {
  const common = {
    layer: 'llm', port: 'ModelPort', direction: 'outbound', portVersion: PORT_VERSIONS.ModelPort, tiers: ['prototype', 'production'], ext: EXT_DECLARATION,
  } as const;
  return [
    defineAdapter<'ModelPort', { model: string }>({
      ...common,
      name: 'hub-anthropic',
      maps: { technology: 'Anthropic Messages API (reinloop provider)' },
      description: 'Anthropic through reinloop\'s provider: prompt caching, thinking, effort and the workspace header; usage and reasoning go to the stack feed.',
      optionsSchema: { type: 'object', required: ['model'], properties: { model: { type: 'string', minLength: 1 } }, additionalProperties: false },
      create: (options, ctx) => tap(hubAnthropicPort({ model: options.model, env: ctx.env, ...(kit.resolve ? { resolve: kit.resolve } : {}) }, ctx.name), kit.person, kit.feed, kit.transcripts),
    }),
    defineAdapter<'ModelPort', { model?: string }>({
      ...common,
      name: 'hub-mock',
      maps: { technology: 'scripted offline model' },
      description: 'Offline model that plays the scripts of the game (world-aware stand-ins); no network.',
      optionsSchema: { type: 'object', properties: { model: { type: 'string', minLength: 1 } }, additionalProperties: false },
      create: (options, ctx) => tap(hubMockPort({ ...(options.model ? { model: options.model } : {}), scripts: kit.scripts }, ctx.name), kit.person, kit.feed, kit.transcripts),
    }),
  ];
}
