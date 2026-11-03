import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import type { Tool } from 'reinloop';
import { callReinloopTool, fromReinloopTool, Scratch, scratchPort, STOP_KEY, worldToolDefs } from './tools.ts';

const ctx = (extra: Partial<CallContext> = {}): CallContext => ({ runId: 'r1', agent: 'decide', sessionId: 's1', ...extra });
const mk = (name: string, run: Tool['run'], extra: Partial<Tool> = {}): Tool => ({ name, description: `${name} tool`, schema: { type: 'object', properties: {} }, run, ...extra });

test('fromReinloopTool: text, errors, data and stop map to a ToolResult', async () => {
  assert.deepEqual(await callReinloopTool(mk('a', () => 'plain'), {}, ctx()), { ok: true, text: 'plain' });
  assert.deepEqual(await callReinloopTool(mk('a', () => ({ content: 'no', isError: true, stop: true })), {}, ctx()), { ok: false, text: 'no' });
  assert.deepEqual(
    await callReinloopTool(mk('a', () => ({ content: 'planned', stop: true, data: { summary: 's', steps: [1] } })), {}, ctx()),
    { ok: true, text: 'planned', data: { summary: 's', steps: [1] }, ext: { [STOP_KEY]: true } },
  );
  const thrown = await callReinloopTool(mk('a', () => { throw new Error('net down'); }), {}, ctx());
  assert.deepEqual(thrown, { ok: false, text: 'Error: net down' });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(callReinloopTool(mk('a', () => { throw new DOMException('x', 'AbortError'); }), {}, ctx({ signal: abort.signal })), /x/);
});

test('fromReinloopTool: the tool gets a usable context (signal, run id)', async () => {
  let seen: { runId: string; agent: string; aborted: boolean } | undefined;
  await callReinloopTool(mk('a', (_args, c) => { seen = { runId: c.runId, agent: c.agent, aborted: c.signal.aborted }; return 'ok'; }), {}, ctx());
  assert.deepEqual(seen, { runId: 'r1', agent: 'decide', aborted: false });
});

test('worldToolDefs: specs come from the tools; a call goes to the run instance in scratch when there is one', async () => {
  const scratch = new Scratch();
  const base = mk('count', () => 'static', { risk: 'read' });
  const [def] = worldToolDefs({ id: 'a1' }, [base], scratch);
  assert.deepEqual({ name: def!.name, description: def!.description, risk: def!.risk }, { name: 'count', description: 'count tool', risk: 'read' });
  assert.equal((await def!.run({}, ctx())).text, 'static');
  await scratch.with('s1', 'decide', [mk('count', () => 'per-run')], async () => {
    assert.equal((await def!.run({}, ctx())).text, 'per-run');
    // another session does not see it
    assert.equal((await def!.run({}, ctx({ sessionId: 's2' }))).text, 'static');
  });
  assert.equal((await fromReinloopTool(base, scratch).run({}, ctx())).text, 'static');
});

test('scratchPort: lists the run tools of its source, the static catalog without a run, and refuses what the run did not bring', async () => {
  const scratch = new Scratch();
  const catalog = worldToolDefs({ id: 'a1' }, [mk('say', () => 'static say'), mk('lorebase_search', () => 'static search')], scratch);
  const lore = (n: string) => n.startsWith('lorebase_');
  const world = scratchPort('world', (n) => !lore(n), catalog, scratch);
  const lorebase = scratchPort('lorebase', lore, catalog, scratch);

  assert.deepEqual((await world.listTools(ctx())).map((t) => t.name), ['say']);
  assert.deepEqual((await lorebase.listTools(ctx())).map((t) => t.name), ['lorebase_search']);
  assert.equal((await world.callTool('say', {}, ctx())).text, 'static say');

  await scratch.with('s1', 'decide', [mk('say', () => 'run say'), mk('rethink', () => 'r'), mk('lorebase_search', () => 'run search')], async () => {
    assert.deepEqual((await world.listTools(ctx())).map((t) => t.name), ['say', 'rethink']);
    assert.deepEqual((await lorebase.listTools(ctx())).map((t) => t.name), ['lorebase_search']);
    assert.equal((await world.callTool('say', {}, ctx())).text, 'run say');
    // a source never serves the other's tools
    assert.equal((await world.callTool('lorebase_search', {}, ctx())).ok, false);
    assert.equal((await world.callTool('nope', {}, ctx())).ok, false);
  });
  // a run that names no tools at all lists nothing from the catalog
  await scratch.with('s1', 'vote', [], async () => {
    assert.deepEqual((await world.listTools(ctx({ agent: 'vote' }))).map((t) => t.name), []);
    assert.equal((await world.callTool('say', {}, ctx({ agent: 'vote' }))).ok, false);
  });
});

test('scratchPort: calls that stop the run are captured; a gate refuses tools with its reason', async () => {
  const scratch = new Scratch();
  const port = scratchPort('world', () => true, [], scratch);
  const commit = mk('commit_plan', () => ({ content: 'ok', stop: true, data: { summary: 'x', steps: [] } }));
  const say = mk('say', () => 'said');
  await scratch.with('s1', 'decide', [commit, say], async (entry) => {
    const res = await port.callTool('commit_plan', {}, ctx());
    assert.equal(res.ext?.[STOP_KEY], true);
    assert.deepEqual(entry.stops, [{ tool: 'commit_plan', text: 'ok', data: { summary: 'x', steps: [] } }]);
    await port.callTool('say', {}, ctx());
    assert.equal(entry.stops.length, 1);
    // closing turn: only commit_plan still answers
    entry.gate = (tool) => (tool === 'commit_plan' ? undefined : 'decision closed');
    assert.deepEqual(await port.callTool('say', {}, ctx()), { ok: false, text: 'decision closed' });
    assert.equal((await port.callTool('commit_plan', {}, ctx())).ok, true);
  });
});

test('Scratch: runs with the same key are serialized, different keys run together, the entry is gone afterwards', async () => {
  const scratch = new Scratch();
  const log: string[] = [];
  const hold = (label: string, key: [string, string], ms: number) => scratch.with(key[0], key[1], undefined, async () => {
    log.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${label}:end`);
  });
  await Promise.all([hold('a', ['s', 'decide'], 20), hold('b', ['s', 'decide'], 1), hold('c', ['s', 'reply'], 1)]);
  assert.ok(log.indexOf('a:end') < log.indexOf('b:start'), log.join(','));
  assert.ok(log.indexOf('c:end') < log.indexOf('a:end'), log.join(','));
  assert.equal(scratch.get('s', 'decide'), undefined);
  // a failing run does not block the next one
  await assert.rejects(scratch.with('s', 'decide', undefined, async () => { throw new Error('x'); }), /x/);
  await scratch.with('s', 'decide', undefined, async () => undefined);
});
