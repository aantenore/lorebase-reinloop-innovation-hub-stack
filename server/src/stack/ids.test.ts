import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSafeRunId, MAX_RUN_ID, runIdFrom, safePart } from './ids.ts';

test('run ids join their parts with dots and pass the run-id check', () => {
  assert.equal(runIdFrom(['p1', 'decide'], 'abc1'), 'p1.decide.abc1');
  assert.ok(isSafeRunId(runIdFrom(['Zoë Müller', 3, 12], 'x1')));
  assert.ok(!isSafeRunId('grp:1:2:abc'));
});

test('a changed part keeps a digest so two names never merge', () => {
  assert.notEqual(safePart('a b'), safePart('a:b'));
  assert.equal(safePart('ok-1_2'), 'ok-1_2');
  assert.ok(isSafeRunId(safePart('.hidden')));
});

test('a long head is shortened to a digest and the tail stays whole', () => {
  const id = runIdFrom(['x'.repeat(300), 'y'.repeat(300)], 'tail9');
  assert.ok(id.length <= MAX_RUN_ID);
  assert.ok(id.endsWith('.tail9'));
  assert.ok(isSafeRunId(id));
  assert.notEqual(id, runIdFrom(['x'.repeat(300), 'z'.repeat(300)], 'tail9'));
});
