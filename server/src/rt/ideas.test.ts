import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LorebaseClient } from '../lorebase/client.ts';
import { careerFor, Company } from './company.ts';
import {
  aggregate, conflicted, exportMarkdown, filterIdeas, type IdeasConfig, IdeaBook, ideaFromRecord, ideaRow, sameScores, type Scores, scoresFrom, seesReviews, sourcesFrom,
  stageFromFields, weightedScore,
} from './ideas.ts';

const cfg: IdeasConfig = {
  enabled: true, kind: 'Idea', reviewKind: 'Review', evidenceKind: 'Evidence', evidenceMax: 3, writeOperation: 'import_records', branchPrefix: 'idea/', titleMaxChars: 90, textMaxChars: 500, tagsMax: 6,
  tagMaxChars: 30, historyMax: 30, commentMaxChars: 280, perceiveMax: 6, signalsMax: 3, sourcesMax: 2, sourceTitleMaxChars: 20, retries: 0, retryBaseMs: 1, committee: { groupName: 'Comitato', maxPerSession: 3 },
  policies: { conflictOfInterest: 'astensione_conflitto_interessi', independentReviews: 'revisioni_indipendenti', committeeNotAuthor: 'comitato_non_coautore', committeeAlternates: 'supplenti_comitato_per_anzianita', slotsExpire: 'slot_scadono_a_fine_trimestre' },
};

/** A Keeper stand-in that records the calls. */
function fakeClient() {
  const calls: string[] = [];
  const client = {
    createBranch: async (name: string) => (calls.push(`branch ${name}`), { name, head: 'h' }),
    execute: async (op: string, p: { kind: string }, o: { branch: string }) => (calls.push(`${op} ${p.kind} @${o.branch}`), { status: 'ok', revision: 'r', head: 'h', edit_count: 1 }),
    createProposal: async (src: string) => (calls.push(`proposal ${src}`), { id: 'prp_1', status: 'open' }),
    review: async (id: string, v: string) => (calls.push(`review ${id} ${v}`), { approval: { satisfied: true } }),
    merge: async (id: string) => (calls.push(`merge ${id}`), { result: 'merged', revision: 'r2' }),
    closeProposal: async (id: string) => (calls.push(`close ${id}`), {}),
    deleteBranch: async (name: string) => (calls.push(`delete ${name}`), {}),
  } as unknown as LorebaseClient;
  return { client, calls };
}

const at = { day: 1, minute: 600 };
const full = { problem: 'p', users: 'u', solution: 's', differentiation: 'd', feasibility: 'f', risks: 'r' };

test('stages follow the fields; scores aggregate and weigh risk inverted', () => {
  assert.equal(stageFromFields({ ...full, users: '', solution: '', differentiation: '', feasibility: '', risks: '' }), 'signal');
  assert.equal(stageFromFields({ ...full, solution: '', differentiation: '', feasibility: '', risks: '' }), 'insight');
  assert.equal(stageFromFields({ ...full, differentiation: '' }), 'concept');
  assert.equal(stageFromFields(full), 'proposal');
  const s: Scores = { impact: 8, feasibility: 6, novelty: 4, fit: 10, risk: 2 };
  const agg = aggregate([{ by: 'a', scores: s, comment: '', at }, { by: 'b', scores: { ...s, impact: 6 }, comment: '', at }])!;
  assert.equal(agg.impact, 7);
  assert.equal(weightedScore(s, { impact: 1, feasibility: 0, novelty: 0, fit: 0, risk: 1 }), 8);
  assert.deepEqual(scoresFrom({ impatto: 7, fattibilita: '5', novelty: 3, fit: 12, rischio: -1 }, { impatto: 'impact', fattibilita: 'feasibility', rischio: 'risk' }), { impact: 7, feasibility: 5, novelty: 3, fit: 10, risk: 0 });
  assert.deepEqual(scoresFrom({ impact: 1 }, {}), { missing: ['feasibility', 'novelty', 'fit', 'risk'] });
});

test('idea lifecycle: branch per idea, peer reviews only, submit needs reviews, committee merges or closes', async () => {
  const { client, calls } = fakeClient();
  const events: string[] = [];
  const book = new IdeaBook(client, 'main', cfg, 's1', { changed: (i, a, by) => events.push(`${a}:${i.stage}:${by}`) });
  const idea = await book.create('Livia', { title: 'Audit AI', problem: 'p', users: 'u', solution: 's', tags: 'AI, Compliance' }, { at, quarter: 'Q1', signals: ['pain_x'], maxOpen: 1 });
  assert.ok(typeof idea !== 'string');
  assert.equal(idea.stage, 'concept');
  assert.deepEqual(idea.tags, ['ai', 'compliance']);
  assert.ok(idea.branch.startsWith('idea/audit-ai-'));
  assert.equal(await book.create('Livia', { title: 'Altra', problem: 'p' }, { at, quarter: 'Q1', signals: [], maxOpen: 1 }), 'too_many_ideas');
  assert.equal(book.review(idea.code, 'Livia', { impact: 5, feasibility: 5, novelty: 5, fit: 5, risk: 5 }, '', at), 'own_idea');
  assert.equal(await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2 }), 'not_complete');
  const enriched = book.enrich(idea.code, 'Giulia', { differentiation: 'd', feasibility: 'f', risks: 'r' }, { at, signals: [] });
  assert.ok(typeof enriched !== 'string' && enriched.stage === 'proposal' && enriched.authors.includes('Giulia'));
  assert.equal(book.review(idea.code, 'Giulia', { impact: 5, feasibility: 5, novelty: 5, fit: 5, risk: 5 }, '', at), 'own_idea');
  book.review(idea.code, 'Dario', { impact: 8, feasibility: 6, novelty: 7, fit: 8, risk: 3 }, 'bene', at);
  assert.equal(await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2 }), 'few_reviews');
  book.review(idea.code, 'Sara', { impact: 6, feasibility: 6, novelty: 5, fit: 7, risk: 4 }, 'ok', at);
  book.review(idea.code, 'Sara', { impact: 7, feasibility: 6, novelty: 5, fit: 7, risk: 4 }, 'meglio', at);
  assert.equal(book.get(idea.code)!.reviews.length, 2);
  assert.equal(await book.submit(idea.code, 'Dario', { at, clock: 0, minReviewers: 2 }), 'not_author');
  const pitched = await book.submit(idea.code, 'Livia', { at, clock: 5, minReviewers: 2 });
  assert.ok(typeof pitched !== 'string' && pitched.stage === 'pitch' && pitched.proposalId === 'prp_1');
  assert.deepEqual(book.pitches().map((i) => i.code), [idea.code]);
  assert.equal(book.enrich(idea.code, 'Sara', { risks: 'x' }, { at, signals: [] }), 'idea_closed');
  const done = book.decide(idea.code, 'approve', 'Solida', [{ member: 'a1', vote: 'approve', reason: 'ok' }], at, 'Livia');
  assert.ok(typeof done !== 'string' && done.stage === 'approved');
  await book.settle();
  assert.ok(calls.includes('merge prp_1') && calls.some((c) => c.startsWith('import_records Review @idea/')));
  assert.ok(events.includes('approved:approved:Livia'));
  const killed = await book.create('Matteo', { title: 'Debole', ...full }, { at, quarter: 'Q1', signals: [], maxOpen: 3 });
  assert.ok(typeof killed !== 'string');
  book.review(killed.code, 'Dario', { impact: 2, feasibility: 2, novelty: 2, fit: 2, risk: 9 }, 'no', at);
  book.review(killed.code, 'Sara', { impact: 3, feasibility: 2, novelty: 2, fit: 2, risk: 9 }, 'no', at);
  await book.submit(killed.code, 'Matteo', { at, clock: 6, minReviewers: 2 });
  book.decide(killed.code, 'kill', 'Debole', [], at, 'Livia');
  await book.settle();
  assert.ok(calls.includes('close prp_1'));
  assert.deepEqual(filterIdeas(book.list(), { stage: 'killed' }).map((i) => i.title), ['Debole']);
  assert.deepEqual(filterIdeas(book.list(), { author: 'giulia' }).map((i) => i.title), ['Audit AI']);
  const md = exportMarkdown(book.list(), (k) => k, { impact: 1, feasibility: 1, novelty: 1, fit: 1, risk: 1 }, { name: 'Hub', quarter: 'Q1' });
  assert.ok(md.includes('Audit AI') && md.includes('Debole'));
  const back = ideaFromRecord({ key: idea.code, values: JSON.parse(JSON.stringify(ideaRow(book.get(idea.code)!, 's1'))) });
  assert.equal(back.stage, 'approved');
  assert.equal(back.decision?.decision, 'approve');
});

test('company: quarters turn with stats, slots, careers never go down', () => {
  const c = new Company({ name: 'Hub', themeCategory: 'strategy', careers: [{ code: 'junior' }, { code: 'senior', rule: 'promotion_senior_fame' }, { code: 'principal', rule: 'promotion_principal_fame' }], startCareer: { agent: 'senior' } });
  assert.equal(c.track(1, 1), undefined);
  c.stats.approved = 2;
  assert.equal(c.slotsLeft(3), 1);
  assert.equal(c.track(1, 1), undefined);
  const turn = c.track(1, 2)!;
  assert.equal(turn.ended, 'Q1');
  assert.equal(turn.stats.approved, 2);
  assert.equal(c.slotsLeft(3), 3);
  // Policy slot_scadono_a_fine_trimestre off: the unused slots pass to the next quarter.
  c.stats.approved = 1;
  c.track(1, 3, 3);
  assert.equal(c.carried, 2);
  assert.equal(c.slotsLeft(3), 5);
  assert.equal(c.slotsTotal(3), 5);
  c.track(1, 4);
  assert.equal(c.slotsLeft(3), 3);
  const r = (k: string) => ({ promotion_senior_fame: 2, promotion_principal_fame: 6 })[k] ?? 0;
  assert.equal(careerFor(c.cfg.careers, 7, 'junior', r as never), 'principal');
  assert.equal(careerFor(c.cfg.careers, 0, 'principal', r as never), 'principal');
  assert.equal(c.startCareer('agent'), 'senior');
  assert.deepEqual(c.themes([{ key: 'tema', value: 1, text: 'AI', category: 'strategy', unit: '' }, { key: 'x', value: 1, text: 'no', category: 'ideas', unit: '' }]), ['AI']);
});

test('ideas: sources keep http/https URLs only, without duplicates, titled by hostname when untitled', () => {
  const out = sourcesFrom(['https://a.example.org/x', { title: 'B', url: 'http://b.example.org' }, 'javascript:alert(1)', 'https://a.example.org/x', 'https://c.example.org'], 5, 20);
  assert.deepEqual(out, [{ title: 'a.example.org', url: 'https://a.example.org/x' }, { title: 'B', url: 'http://b.example.org/' }, { title: 'c.example.org', url: 'https://c.example.org/' }]);
  assert.equal(sourcesFrom('ftp://x.org', 5, 20).length, 0);
  assert.equal(sourcesFrom(undefined, 5, 20).length, 0);
});

test('conflicts, review visibility and copied scores are facts on the idea', async () => {
  const { client } = fakeClient();
  const book = new IdeaBook(client, 'main', cfg, 's1', { changed: () => undefined });
  const idea = await book.create('Livia', { title: 'Triage', ...full }, { at, quarter: 'Q1', signals: [], maxOpen: 3 });
  assert.ok(typeof idea !== 'string');
  book.enrich(idea.code, 'Matteo', { risks: 'r2' }, { at, signals: [] });
  assert.deepEqual(conflicted(idea), ['Livia', 'Matteo']);
  // Policy comitato_non_coautore: a committee member's edit is a contribution, not co-authorship.
  const contributed = book.enrich(idea.code, 'Dario', { risks: 'r3' }, { at, signals: [], asAuthor: false });
  assert.ok(typeof contributed !== 'string');
  assert.deepEqual(contributed.authors, ['Livia', 'Matteo']);
  assert.equal(contributed.history.at(-1)!.action, 'contributed');
  assert.equal(seesReviews(idea, 'Matteo'), true);
  assert.equal(seesReviews(idea, 'Irene'), false);
  const s: Scores = { impact: 5, feasibility: 6, novelty: 3, fit: 6, risk: 6 };
  book.review(idea.code, 'Dario', s, 'ok', at);
  assert.equal(seesReviews(idea, 'Dario'), true);
  book.review(idea.code, 'Irene', { ...s }, 'idem', at);
  assert.deepEqual(sameScores(idea.reviews, idea.reviews.at(-1)!), ['Dario']);
  assert.deepEqual(idea.history.at(-1), { at, by: 'Irene', action: 'scores_match', note: 'Dario' });
  book.review(idea.code, 'Giulia', { ...s, impact: 7 }, 'diverso', at);
  assert.equal(idea.history.at(-1)!.action, 'reviewed');
  await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2 });
  const out = book.decide(idea.code, 'defer', 'dati', [], at, 'Dario', ['Livia', 'Matteo']);
  assert.ok(typeof out !== 'string');
  assert.deepEqual(out.decision!.recused, ['Livia', 'Matteo']);
  assert.deepEqual(out.history.slice(-2).map((h) => h.action), ['recused', 'deferred']);
});

test('evidence: written on the idea branch, one per URL, a validation per person and role, the gate refuses with its reason', async () => {
  const { client, calls } = fakeClient();
  const events: string[] = [];
  const book = new IdeaBook(client, 'main', cfg, 's1', { changed: (i, a) => events.push(`${a}:${i.evidence.length}`) });
  const idea = await book.create('Livia', { title: 'Prove', ...full }, { at, quarter: 'Q1', signals: [], maxOpen: 3 });
  assert.ok(typeof idea !== 'string');
  const base = { source: 'hackernews' as const, title: 't', metric: 10, metric_name: 'points', excerpt: '', collected_by: 'Dario', collected_at: at, weight: 1, label: '' };
  const ev = book.addEvidence(idea.code, { ...base, type: 'public_signal', url: 'https://news.ycombinator.com/item?id=1' });
  assert.ok(typeof ev !== 'string' && ev.idea === idea.code);
  assert.equal(book.addEvidence(idea.code, { ...base, type: 'public_signal', url: 'https://news.ycombinator.com/item?id=1' }), 'duplicate_evidence');
  const v = { ...base, type: 'human_validation' as const, source: 'player' as const, url: '', collected_by: 'Antonio', role: 'cliente', weight: 2 };
  book.addEvidence(idea.code, { ...v, verdict: 'neutro' });
  book.addEvidence(idea.code, { ...v, verdict: 'positivo' });
  assert.deepEqual(book.get(idea.code)!.evidence.map((e) => e.verdict ?? ''), ['', 'positivo']);
  book.review(idea.code, 'Dario', { impact: 8, feasibility: 6, novelty: 7, fit: 8, risk: 3 }, 'bene', at);
  book.review(idea.code, 'Sara', { impact: 6, feasibility: 6, novelty: 5, fit: 7, risk: 4 }, 'ok', at);
  assert.equal(await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2, gate: () => 'prove reali 1 di 3' }), 'prove reali 1 di 3');
  const pitched = await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2, gate: () => undefined });
  assert.ok(typeof pitched !== 'string' && pitched.stage === 'pitch');
  await book.settle();
  assert.ok(calls.some((c) => c.startsWith('import_records Evidence @idea/')));
  assert.ok(events.includes('evidence:1'));
});

test('a deferred idea keeps the committee run that waits for its resubmission, in its record', async () => {
  const { client } = fakeClient();
  const book = new IdeaBook(client, 'main', cfg, 's1', { changed: () => undefined });
  const idea = await book.create('Livia', { title: 'Rinvio', ...full }, { at, quarter: 'Q1', signals: [], maxOpen: 3 });
  assert.ok(typeof idea !== 'string');
  book.review(idea.code, 'Dario', { impact: 8, feasibility: 6, novelty: 7, fit: 8, risk: 3 }, 'bene', at);
  book.review(idea.code, 'Sara', { impact: 6, feasibility: 6, novelty: 5, fit: 7, risk: 4 }, 'ok', at);
  await book.submit(idea.code, 'Livia', { at, clock: 0, minReviewers: 2 });
  // An idea that never had a run writes none.
  book.setCommitteeRun(idea.code, null);
  assert.equal(book.get(idea.code)!.committeeRun, undefined);
  assert.ok(!('committee_run' in ideaRow(book.get(idea.code)!, 's1')));
  const run = { runId: 'g1:1:0:abc', configHash: 'f00dfeed', wait: 'call#0' };
  book.setCommitteeRun(idea.code, run);
  const out = book.decide(idea.code, 'defer', 'dati', [], at, 'Dario');
  assert.ok(typeof out !== 'string' && out.stage === 'proposal');
  assert.deepEqual(book.get(idea.code)!.committeeRun, run);
  // The record carries the run, and the idea read back after a restart waits on it.
  const row = JSON.parse(JSON.stringify(ideaRow(out, 's1')));
  assert.deepEqual(row.committee_run, run);
  assert.deepEqual(ideaFromRecord({ key: idea.code, values: row }).committeeRun, run);
  // Let go: the record says so, and a malformed run reads back as none.
  book.setCommitteeRun(idea.code, null);
  assert.equal(book.get(idea.code)!.committeeRun, null);
  const cleared = JSON.parse(JSON.stringify(ideaRow(book.get(idea.code)!, 's1')));
  assert.deepEqual(cleared.committee_run, {});
  assert.equal(ideaFromRecord({ key: idea.code, values: cleared }).committeeRun, undefined);
  assert.equal(ideaFromRecord({ key: idea.code, values: { ...cleared, committee_run: '{"runId":5}' } }).committeeRun, undefined);
  assert.deepEqual(ideaFromRecord({ key: idea.code, values: { ...cleared, committee_run: JSON.stringify(run) } }).committeeRun, run);
  book.setCommitteeRun('unknown', run);
});
