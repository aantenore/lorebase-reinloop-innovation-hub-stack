import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalPhase, assemblyOutcome, checkBallot, checkChair, checkFreeBallot, checkFreeChair, criteriaFrom, criteriaTally, demandsFrom, unionOf } from './committee.ts';
import { Company } from './company.ts';
import { closable, closingInput } from './decide.ts';
import { hackerNewsSource, queryWords } from './signals.ts';

const laws = [
  { key: 'criteri_comitato', value: 1, text: 'on' },
  { key: 'criterio_comitato_prove_del_problema', value: 1, text: 'prove' },
  { key: 'criterio_comitato_rischio', value: 1, text: 'rischio' },
  { key: 'criterio_comitato_spento', value: 0, text: 'off' },
  { key: 'criterio_comitato_', value: 1, text: 'no key' },
];
const criteria = criteriaFrom(laws, 'criterio_comitato_');
const limits = { maxChars: 50, demandsMax: 2 };

test('committee: criteria are the rules with the prefix and value >= 1, in rule order', () => {
  assert.deepEqual(criteria.map((c) => c.key), ['prove_del_problema', 'rischio']);
  assert.equal(criteria[0]!.code, 'criterio_comitato_prove_del_problema');
  assert.equal(approvalPhase(1, ['concept', 'pilot']), 'concept');
  assert.equal(approvalPhase(2, ['concept', 'pilot']), 'pilot');
  assert.equal(approvalPhase(9, ['concept', 'pilot']), 'concept');
  assert.deepEqual(demandsFrom(['a', ' a ', 'b', 'c'], 2, 10), ['a', 'b']);
});

test('committee: a ballot has a verdict per criterion; kill or defer names an unmet one; extra demands are kept apart', () => {
  const all = (met: boolean) => ({ prove_del_problema: { soddisfatto: met, nota: 'x' }, rischio: { soddisfatto: true, nota: 'y' } });
  assert.deepEqual(checkBallot({ voto: 'maybe', criteri: all(true) }, criteria, limits), { error: 'vote' });
  assert.deepEqual(checkBallot({ voto: 'approve', criteri: { rischio: { soddisfatto: true } } }, criteria, limits), { error: 'missing', missing: ['prove_del_problema'] });
  assert.deepEqual(checkBallot({ voto: 'defer', criteri: all(true), motivo: 'pilota' }, criteria, limits), { error: 'need_unmet' });
  const b = checkBallot({ voto: 'defer', criteri: all(false), motivo: 'm', richieste_fuori_policy: ['un cliente pagante', 'un pilota', 'altro'] }, criteria, limits);
  assert.ok(!('error' in b));
  if ('error' in b) return;
  assert.deepEqual(b.unmet, ['prove_del_problema']);
  assert.deepEqual(b.outOfPolicy, ['un cliente pagante', 'un pilota']);
  // An approval may still judge a criterion unmet; criteria may be named by rule code, booleans as strings.
  const a = checkBallot({ voto: 'approve', criteri: { criterio_comitato_prove_del_problema: { soddisfatto: 'false' }, rischio: { soddisfatto: true } } }, criteria, limits);
  assert.ok(!('error' in a) && a.unmet.length === 1);
  assert.deepEqual(criteriaTally([b, a as typeof b]), { prove_del_problema: { met: 0, unmet: 2 }, rischio: { met: 2, unmet: 0 } });
});

test('committee: the chair names known unmet criteria for a kill or defer', () => {
  assert.deepEqual(checkChair({ decisione: 'defer', criteri_non_soddisfatti: [], sintesi: 's' }, criteria, limits), { error: 'need_unmet' });
  assert.deepEqual(checkChair({ decisione: 'kill', criteri_non_soddisfatti: ['domanda pagante'], sintesi: 's' }, criteria, limits), { error: 'unknown', unknown: ['domanda pagante'] });
  const ok = checkChair({ decisione: 'defer', criteri_non_soddisfatti: ['rischio', 'rischio'], sintesi: 's', richieste_fuori_policy: 'pilota' }, criteria, limits);
  assert.deepEqual(ok, { decision: 'defer', summary: 's', unmet: ['rischio'], outOfPolicy: ['pilota'] });
  assert.ok(!('error' in checkChair({ decisione: 'approve', criteri_non_soddisfatti: [], sintesi: 's' }, criteria, limits)));
});

test('committee: free votes need only a valid vote and a reason; the summary is cut', () => {
  assert.deepEqual(checkFreeBallot({ vote: 'defer', reason: ' no pilot ' }, { maxChars: 50 }), { vote: 'defer', reason: 'no pilot', criteria: {}, unmet: [], outOfPolicy: [] });
  assert.deepEqual(checkFreeBallot({ voto: 'maybe' }, { maxChars: 50 }), { error: 'vote' });
  assert.deepEqual(checkFreeChair({ decision: 'kill', summary: 'abcdef' }, { maxChars: 3 }), { decision: 'kill', summary: 'abc', unmet: [], outOfPolicy: [] });
  assert.deepEqual(checkFreeChair({ decision: 'later' }, { maxChars: 3 }), { error: 'vote' });
});

test('committee: an assembly is decided by the esteem-weighted plurality, the winning side explains', () => {
  const vote = (member: string, v: 'approve' | 'kill' | 'defer', unmet?: string[], outOfPolicy?: string[]) => ({ member, vote: v, reason: `r-${member}`, unmet, outOfPolicy });
  const votes = [vote('a', 'approve'), vote('b', 'kill', ['x'], ['pilot']), vote('c', 'kill', ['y'])];
  const o = { name: (v: { member: string }) => v.member.toUpperCase(), textMax: 100, criteria: true };
  // two lighter kills lose to one heavy approval, then win once they weigh more
  assert.deepEqual(assemblyOutcome(votes, (m) => (m === 'a' ? 5 : 1), o), { decision: 'approve', summary: 'A: r-a', unmet: [], outOfPolicy: ['pilot'] });
  assert.deepEqual(assemblyOutcome(votes, () => 1, o), { decision: 'kill', summary: 'B: r-b C: r-c', unmet: ['x', 'y'], outOfPolicy: ['pilot'] });
  assert.deepEqual(assemblyOutcome(votes, () => 1, { ...o, criteria: false, textMax: 6 }), { decision: 'kill', summary: 'B: r-b' });
  assert.deepEqual(unionOf([['a', 'b'], undefined, ['b', 'c']]), ['a', 'b', 'c']);
});

test('company: a deferral spends approval slots, never below zero', () => {
  const c = new Company({ name: 'x', themeCategory: 's', careers: [], startCareer: {} });
  assert.equal(c.spendSlots(3, 1), 1);
  assert.equal(c.slotsLeft(3), 2);
  c.stats.approved = 1;
  assert.equal(c.spendSlots(3, 5), 1);
  assert.equal(c.slotsLeft(3), 0);
});

test('decide: a run ended on its own or on its budget gets a closing run with the notice last', () => {
  assert.equal(closable({ status: 'completed' }), true);
  assert.equal(closable({ status: 'stopped', reason: 'budget:maxTurns' }), true);
  assert.equal(closable({ status: 'stopped', reason: 'budget:maxCostUsd' }), false);
  assert.equal(closable({ status: 'interrupted', reason: 'timeout' }), false);
  const msgs = closingInput([{ role: 'user', parts: [{ type: 'text', text: 'a' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'b' }] }], 'fine');
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.at(-1), { role: 'user', parts: [{ type: 'text', text: 'fine' }] });
});

test('signals: Hacker News asks again with optional words when no story has them all, results marked partial', async () => {
  assert.deepEqual(queryWords('triage, alert  sicurezza'), ['triage', 'alert', 'sicurezza']);
  const urls: string[] = [];
  const get = async (url: string) => {
    urls.push(url);
    return url.includes('optionalWords') ? { hits: [{ objectID: '7', title: 'Alert &amp; triage', points: 3, num_comments: 1, created_at: '2026-01-01' }] } : { hits: [] };
  };
  const src = hackerNewsSource(true);
  const out = await src.search('triage alert sicurezza', { maxResults: 3, get, maxChars: 80, signal: new AbortController().signal });
  assert.equal(urls.length, 2);
  assert.ok(new URL(urls[1]!).searchParams.get('optionalWords') === 'triage alert sicurezza');
  assert.deepEqual(out[0], { title: 'Alert & triage', url: 'https://news.ycombinator.com/item?id=7', points: 3, comments: 1, created_at: '2026-01-01', hn_url: 'https://news.ycombinator.com/item?id=7', match: 'partial' });
  urls.length = 0;
  assert.deepEqual(await hackerNewsSource(false).search('triage alert', { maxResults: 3, get, maxChars: 80, signal: new AbortController().signal }), []);
  assert.equal(urls.length, 1);
});
