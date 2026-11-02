// Returns the world data of Lorebase `main` to the seed state, through the governed flow only
// (Operations on a `reset/` branch, merged by a single Proposal; never direct DB access). Deletes go
// through the bulk `delete_records` Operation, one call (one Revision) per Kind and batch of at most
// lorebase.maxBulkDeleteKeys keys:
//   - laws not in lorebase/rules.seed.yaml are repealed, seed laws get their seed value and wording back
//     (missing ones are re-created), roles get their seed values back;
//   - breakthroughs made and their methods leave main (back to the hidden branch, rebuilt by the seed);
//   - Chronicle (newsletter), Insight (playbooks), Team, Idea, Review and Evidence records are archived on
//     tagged `archive/<timestamp>` (a read-only tag, not a branch: tags do not count against the Keeper's
//     materialized-branch cap) and removed from main (the portfolio starts empty again);
//   - stale branches (playbook/, policy/, breakthrough/, idea/, seed/, reset/, probe/) and their open
//     Proposals are closed.
// Then the private memory database of mnemo (config/mnemo.json db.path, MNEMO_DB) is deleted
// (the downloaded embedding model in data/models is kept), and so is the journal of the group systems
// (config/plexus/base.json, ports.execution.options.path): its waiting committee runs belong to the old ideas.
// Stop the game and mnemo first.
//   node scripts/world-reset.ts [--dry-run] [--keep-memory] [--force]
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml } from 'reinloop';
import { loadConfig, ROOT } from '../server/src/config.ts';
import { LorebaseClient, type RecordItem } from '../server/src/lorebase/client.ts';
import { loadGameConfig } from '../server/src/rt/config.ts';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const keepMemory = argv.includes('--keep-memory');
const force = argv.includes('--force');
const cfg = loadConfig([]);
const game = loadGameConfig();
const lb = cfg.lorebase;
const main = lb.branch;
const client = new LorebaseClient(lb.url, lb.domain);
const STALE_PREFIXES = [game.insights.branchPrefix, lb.proposalBranchPrefix, game.society.lawProposals.branchPrefix, game.economy.discoveryBranchPrefix, game.ideas.branchPrefix, 'seed/', 'reset/', 'probe/'];
const ARCHIVE_KINDS = [game.chronicle.kind, game.insights.kind, game.society.families.kind, game.ideas.kind, game.ideas.reviewKind, game.ideas.evidenceKind];
type Row = Record<string, unknown>;
const seed = parseYaml(readFileSync(resolve(ROOT, 'lorebase/rules.seed.yaml'), 'utf8')) as { rules: Row[]; roles: Row[] };

interface Action {
  op: string;
  params: Row;
  what: string;
}

/** Records of one Kind leaving main (one bulk delete per batch). */
interface Removal {
  kind: string;
  key: string;
  what: string;
}

const snake = (kind: string) => kind.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const records = async (kind: string): Promise<RecordItem[]> => (await client.listRecords(kind, main).catch(() => ({ items: [] as RecordItem[] }))).items;
const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '') || (typeof b === 'number' && Number(a) === b);

await client.ready().catch(() => {
  console.error(`Keeper is not reachable at ${lb.url}; run: npm run lorebase:up`);
  process.exit(1);
});

// ---- plan ----------------------------------------------------------------------
const actions: Action[] = [];
const removals: Removal[] = [];
const rules = await records(lb.ruleKind);
const seedRules = new Map(seed.rules.map((r) => [String(r.code), r]));
for (const r of rules) {
  const code = String(r.values.code ?? r.key);
  const s = seedRules.get(code);
  if (!s) {
    removals.push({ kind: lb.ruleKind, key: r.key, what: `repeal law ${code}` });
    continue;
  }
  const changed = (['value', 'text', 'category', 'unit'] as const).filter((k) => !same(r.values[k], s[k]));
  if (changed.length) actions.push({ op: lb.updateOperation, params: { key: r.key, value: s.value, text: s.text, category: s.category, unit: s.unit ?? null }, what: `restore law ${code} (${changed.join(', ')})` });
}
const have = new Set(rules.map((r) => String(r.values.code ?? r.key)));
for (const s of seed.rules) if (!have.has(String(s.code))) actions.push({ op: lb.createOperation, params: { code: s.code, value: s.value, text: s.text, category: s.category, ...(s.unit ? { unit: s.unit } : {}) }, what: `re-create law ${s.code}` });

const roleOp = `update_${snake(lb.roleKind)}`;
for (const r of await records(lb.roleKind)) {
  const s = seed.roles.find((x) => String(x.code) === String(r.values.code ?? r.key));
  if (!s) continue;
  const changed = (['title', 'description', 'move_factor', 'work_factor'] as const).filter((k) => s[k] !== undefined && !same(r.values[k], s[k]));
  if (changed.length) actions.push({ op: roleOp, params: { key: r.key, ...Object.fromEntries(changed.map((k) => [k, s[k]])) }, what: `restore role ${s.code} (${changed.join(', ')})` });
}

const eco = game.economy.kinds;
for (const t of await records(eco.technology)) removals.push({ kind: eco.technology, key: t.key, what: `re-hide technology ${t.key}` });
for (const r of await records(eco.recipe)) {
  if (String(r.values.tech ?? '')) removals.push({ kind: eco.recipe, key: r.key, what: `re-hide recipe ${r.key}` });
}
const archived: Record<string, number> = {};
for (const kind of ARCHIVE_KINDS) {
  const items = await records(kind);
  archived[kind] = items.length;
  for (const x of items) removals.push({ kind, key: x.key, what: `archive ${kind} ${x.key}` });
}

const branches = await client.listBranches();
const stale = branches.filter((b) => STALE_PREFIXES.some((p) => b.name.startsWith(p)));
const open = (await client.listProposals('open')).filter((p) => stale.some((b) => b.name === p.source_ref));

// ---- report ----------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').toLowerCase();
const byKind = (prefix: string) => [...actions, ...removals].filter((a) => a.what.startsWith(prefix));
// One bulk delete per Kind and batch of keys (the Keeper caps the keys of one call).
const batchSize = Math.max(1, lb.maxBulkDeleteKeys);
const batches: Array<{ kind: string; keys: string[] }> = [];
for (const kind of [...new Set(removals.map((x) => x.kind))]) {
  const keys = removals.filter((x) => x.kind === kind).map((x) => x.key);
  for (let i = 0; i < keys.length; i += batchSize) batches.push({ kind, keys: keys.slice(i, i + batchSize) });
}
console.log(`world reset of ${lb.domain}/${main}${dry ? ' (dry run)' : ''}:`);
for (const prefix of ['repeal law', 'restore law', 're-create law', 'restore role', 're-hide technology', 're-hide recipe']) {
  const list = byKind(prefix);
  if (list.length) console.log(`  ${prefix}: ${list.map((a) => a.what.slice(prefix.length + 1)).join('; ')}`);
}
for (const [kind, n] of Object.entries(archived)) console.log(`  archive ${kind}: ${n} record(s) -> tag archive/${stamp}, removed from ${main}`);
if (batches.length) console.log(`  ${lb.bulkDeleteOperation}: ${batches.map((b) => `${b.kind} ${b.keys.length}`).join(', ')} (${batches.length} call(s), at most ${batchSize} keys each)`);
console.log(`  close ${open.length} open Proposal(s) and delete ${stale.length} stale branch(es)${stale.length ? `: ${stale.map((b) => b.name).join(', ')}` : ''}`);
const mnemoDb = resolve(ROOT, process.env.MNEMO_DB || (JSON.parse(readFileSync(resolve(ROOT, process.env.MNEMO_CONFIG ?? 'config/mnemo.json'), 'utf8')) as { db: { path: string } }).db.path);
console.log(`  private memory: ${keepMemory ? 'kept' : `delete ${mnemoDb} (models kept)`}`);
// The journal path of the group systems: base.json's `${env:HUB_DATA_DIR:-<default>}/...`, relative to config/plexus.
const plexusFile = resolve(ROOT, process.env.STACK_PLEXUS_CONFIG ?? 'config/plexus/base.json');
const journal = resolve(dirname(plexusFile), String((JSON.parse(readFileSync(plexusFile, 'utf8')) as { ports: { execution: { options: { path: string } } } }).ports.execution.options.path)
  .replace(/\$\{env:(\w+)(?::-([^}]*))?\}/g, (_m, name: string, dflt?: string) => process.env[name] ?? dflt ?? ''));
console.log(`  group journal: delete ${journal}`);
if (dry) process.exit(0);

// ---- apply ----------------------------------------------------------------------
if (!keepMemory && !force) {
  const up = await fetch(game.services.mnemo.healthUrl, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (up) {
    console.error('mnemo is running: stop the game first (or pass --force, or --keep-memory)');
    process.exit(1);
  }
}
for (const p of open) await client.closeProposal(p.id).catch((err) => console.warn(`  close ${p.id}: ${err.message}`));
for (const b of stale) await client.deleteBranch(b.name).catch((err) => console.warn(`  delete ${b.name}: ${err.message}`));
const changes = actions.length + removals.length;
if (changes) {
  if (Object.values(archived).some((n) => n > 0)) await client.createTag(`archive/${stamp}`, { source: main });
  const work = `reset/${stamp}`;
  await client.createBranch(work, main);
  for (const a of actions) await client.execute(a.op, a.params, { branch: work, message: `World reset: ${a.what}` });
  for (const b of batches) {
    await client.execute(lb.bulkDeleteOperation, { kind: b.kind, keys: b.keys, skip_missing: true }, { branch: work, message: `World reset: remove ${b.keys.length} ${b.kind} record(s)` });
  }
  const pr = await client.createProposal(work, main, 'World reset', `Back to the seed state: ${changes} change(s) in ${actions.length + batches.length} Operation(s). History archived on tag archive/${stamp}.`);
  await client.review(pr.id, 'approve', 'World reset');
  const merged = await client.merge(pr.id, 'World reset');
  await client.deleteBranch(work).catch(() => undefined);
  console.log(`merged ${pr.id} into ${main}: ${merged.result} @ ${merged.revision.slice(0, 12)} (${actions.length + batches.length} Operation(s))`);
} else console.log(`${main} already matches the seed`);

// The hidden catalog is rebuilt from main (and anything missing is seeded back).
const seeded = spawnSync(process.execPath, [resolve(ROOT, 'scripts/lorebase-seed.ts')], { stdio: 'inherit', env: process.env });
if (seeded.status !== 0) console.warn('seed step failed: run npm run lorebase:seed');

for (const f of [journal, `${journal}-wal`, `${journal}-shm`]) if (existsSync(f)) rmSync(f);
console.log(`group journal deleted (${journal})`);

if (!keepMemory) {
  for (const f of [mnemoDb, `${mnemoDb}-wal`, `${mnemoDb}-shm`]) if (existsSync(f)) rmSync(f);
  console.log(`private memory deleted (${mnemoDb})`);
}
