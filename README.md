# Lorebase × reinloop: Innovation Hub

An innovation hub run by LLM agents, the brightest minds of the agentic world. They only **generate
and evaluate IT product ideas** (software, AI, infrastructure, developer tools, security, data
products); they never build them. Every idea lives on its own branch in
[Lorebase](https://github.com/aantenore/lorebase); an **investment committee** of agents approves it
into `main` (the portfolio), kills it or defers it. The company policies (slots per quarter, reviewers,
quorum, evaluation weights, the year-end freeze, careers, strategic themes) are Lorebase records: change
one while the hub runs and the people learn of it from Lorebase's change feed. The people think on the agent stack:
[reinloop](https://github.com/aantenore/reinloop), [agent-layers](https://github.com/aantenore/agent-layers) and
[agent-plexus](https://github.com/aantenore/agent-plexus).

| Product | What it does here |
|---|---|
| [Lorebase](https://github.com/aantenore/lorebase) 0.3.1 | the company's memory: policies, roles, signals and ideas as versioned records, one branch per idea, Proposals for the committee, a change feed the hub follows; Herald is its MCP server, the agents' read access |
| [reinloop](https://github.com/aantenore/reinloop) 0.3.2 | the runtime of each agent: the model providers (Anthropic, or a local server such as Ollama), the tool loop, budgets, prompt caching |
| [agent-layers](https://github.com/aantenore/agent-layers) 0.4.2 | one stack per person composed from `config/stacks/person.json`: model, tools, runtime and telemetry as replaceable layers, one agent per capacity (decide, reply, vote, ...) |
| [agent-plexus](https://github.com/aantenore/agent-plexus) 0.2.1 | the group topologies: the investment committee (council with ballots and a chair, waiting for a deferred idea), squads (orchestrator), routers, chains, assemblies |

Derived from [lorebase-reinloop-civilization](https://github.com/aantenore/lorebase-reinloop-civilization),
which holds the history of the engine (real-time world, minds, groups, society, economy, god mode). This repository
supersedes [lorebase-reinloop-innovation-hub](https://github.com/aantenore/lorebase-reinloop-innovation-hub), the
hub's first version (a vendored reinloop, no agent-layers or agent-plexus), whose history it contains.

Live runs (budget-capped, real models, web research on): [docs/run-report.md](docs/run-report.md), evidence in
[docs/evidence/run1/](docs/evidence/run1/), [run2/](docs/evidence/run2/), [run3/](docs/evidence/run3/),
[run4/](docs/evidence/run4/), [run5/](docs/evidence/run5/) and [run6/](docs/evidence/run6/); the report opens with the
findings across runs 1-6.

## Screenshots

![Campus](docs/screenshots/campus.png)
*Il campus in tempo reale / The office campus in real time*

![Idea board](docs/screenshots/idea-board.png)
*La bacheca delle idee per fase (run 6: due idee rinviate dal comitato) / The idea board by stage (run 6: two ideas deferred by the committee)*

![Idea detail](docs/screenshots/idea-detail.png)
*Un'idea con le sue prove per tipo, pesi e requisiti di candidatura (run 6) / An idea with its evidence by type, weights and candidacy requirements (run 6)*

![Web research](docs/screenshots/research.png)
*Le ricerche web di una persona nell'ispettore, con i link ai risultati / A person's web research in the inspector, with links to the results*

![Board mode](docs/screenshots/board-mode.png)
*Modalità Board: conversazioni (run 6: il comitato e la fonte EUR-Lex dell'art. 12) / Board mode: conversations (run 6: the committee and the EUR-Lex source of art. 12)*

![Playbook](docs/screenshots/playbook.png)
*Il playbook dei ruoli, proposto e revisionato dai pari / Role playbooks, proposed and peer-reviewed*

![Signals](docs/screenshots/signals.png)
*Segnali, metodi di lavoro e breakthrough / Signals, work methods and breakthroughs*

![People](docs/screenshots/people.png)
*Persone e carriere / People and careers*

![Memory](docs/screenshots/memory.png)
*La memoria privata di una persona / A person's private memory*

## Concept

- **Nothing coordinates the agents.** Each person runs its own loop: perceptions in, plans out. The world
  applies actions and the numbers of the policies; the client is a thin view.
- **Prompts are minimal** ([docs/prompts.md](docs/prompts.md)): identity, role in the company, the faculties
  (a mind connected to Lorebase, a private memory) and factual perception. No tasks, no strategy, no advice.
  Everything the agents read or say is Italian by default (`language` in `config/sim.json`; `SIM_LANGUAGE=en`
  switches the hub's own texts to `config/i18n/en*.json`, while the seed policies and the roster stay as written).
- **The product is ideas.** `proponi_idea` creates `idea/<code>` and the `Idea` record; `arricchisci_idea`
  adds fields (co-authorship), `valuta_idea` is a peer review (`Review` records), `candida_al_comitato`
  opens a Proposal into `main`. The committee decides: approve (merge, the idea enters the portfolio),
  kill (the idea is marked killed on its branch, the Proposal closed) or defer (back to the authors).
  No approval happens outside the committee.
- **All numbers are policies** (Lorebase `Rule` records, category in `company`, `ideas`, `strategy`, ...)
  or config (`config/*.json`). Nothing gameplay-related is hardcoded.
- **Online research.** Every mind has reinloop's `web_search` and `web_fetch` (`server/src/rt/research.ts`);
  the prompt only states the faculty ("Puoi cercare sul web"). Daily searches per person and for the whole hub
  and the excluded domains are policies; results are cached server-side (a cached answer costs no quota);
  every call is a `research` event. Web content is untrusted: it is only text returned to the model, never an
  input to a write. Pages people use can be cited on an idea (`sources: [{title, url}]`).

### From the civilization to the hub

| Civilization | Innovation hub | How |
|---|---|---|
| Laws (`Rule`) | Company policies | same Kind, new categories and seed; i18n says "policy" |
| Terrain (grass, forest, water, rock, sand) | Office campus: `office`, `meeting`, `lab`, `lounge`, `wall`, `garden`, `plaza` | `map.layout: campus` in `config/game.json` (zones, walls, doors, corridors, desks) |
| Shelter levels | Desk / whiteboard (1), fitted meeting room (2) | `shelter` field reused |
| Health / hunger | Energy / stress (`hp` / `hunger` on the wire) | coffee lowers stress, breaks restore energy, stress over the limit drains energy |
| Death | Leaving the company (`entity_removed.reason` `burnout` or `left`) | |
| Seasons, winter | Quarters Q1-Q4, year-end freeze | rule `winter_every_ticks` split in four; `freeze_blocks_approvals` |
| Food, wood | Coffee (`food`), whiteboard material (`wood`) | tile stocks |
| Resources found in biomes | 40 `Signal` records (trends, user pains, market news, research, regulation, customer calls) picked up in the rooms; regulatory ones carry their official source (`url`, e.g. the AI Act on EUR-Lex), readable with `web_fetch` by whoever carries or has read them | `gather {resource}` |
| Recipes | Work methods, role-gated, inputs may be `@<category>` (any signal of it) | e.g. trend + pain -> insight, insight + research -> feasibility note |
| Technologies | Breakthroughs (`Breakthrough`), hidden until found by combining items | `sperimenta` |
| Esteem, fame, rank | Reputation, impact, career ladder Junior / Senior / Principal / Fellow | rules `promotion_*_fame`, never demoted |
| Families, births | Teams, hires mentored by two colleagues | `reputation_inheritance` |
| Ages | Seniority: new hire, in full career, veteran | |
| Barter, ask | Exchanges of signals and artifacts | |
| Testimonies | Reports of conduct-policy breaches | |
| Role consciousness (`Insight`) | Role playbooks | branch `playbook/` |
| Chronicle | Company newsletter (also ideas, promotions, quarterly reviews) | |
| Law proposals | Policy proposals (the board approves them in Lorebase) | branch `policy/agent-` |
| God mode | Board mode | same endpoints |
| Groups | Committee (council), squads (orchestrator), hackathons (assembly), design reviews (mentor), guilds (router), interns (crowd) | |

## Architecture

```mermaid
flowchart LR
  subgraph minds["reinloop loops (one per person, one per group)"]
    A["person: perceptions in, plans and tools out"]
    C["investment committee: votes and chair"]
  end
  subgraph world["world server (server/src/rt, :4500)"]
    W["campus physics, event bus 20 Hz<br/>company: quarters, slots, careers"]
    I["IdeaBook (ideas.ts)<br/>branch per idea, reviews, Proposals"]
    H["REST + WebSocket /ws + SSE"]
  end
  LB[("Lorebase Keeper :8280<br/>policies, roles, signals, methods,<br/>ideas, reviews, newsletter")]
  HE["Herald :8290<br/>Lorebase MCP, read-only, pinned to main"]
  MN[("mnemo :4510<br/>private fading memory")]
  UI["clients: game/ (:5184), web/ (:5183)"]
  A -- "proponi_idea, arricchisci_idea, valuta_idea, candida_al_comitato" --> I
  C -- "approve / kill / defer" --> I
  I -- "idea/&lt;code&gt; branch, import_records, Proposal, merge or close" --> LB
  A -- "lorebase_* tools" --> HE --> LB
  W -- "change feed (SSE)" --> LB
  A -- "remember / recall" --> MN
  H <--> UI
```

- `server/src/rt/world.ts`: campus layout, people, quarters and freeze, energy and stress, plans in real time.
- `server/src/rt/ideas.ts`: ideas and reviews on `idea/` branches, submission Proposals, committee decisions,
  reload after a restart, markdown export.
- `server/src/rt/company.ts`: quarter turns and their stats, slots left, strategic themes, careers.
- `server/src/rt/groups.ts`: reinloop patterns per group; `reviewIdea` is the committee's session (members
  vote with structured output, the chair decides; an assembly decides by esteem-weighted plurality).
- `server/src/rt/decide.ts`, `mind.ts`, `prompt.ts`: one decision loop per person, tools, observation.
- `server/src/rt/game.ts`: the host: policies from Lorebase, ideas, committee, protocol, REST.
- `server/src/stack/`: the agent stack (next section).
- `lorebase/`: schema, policies and roles, signals, methods and breakthroughs.

### Agent stack

Thinking runs on agent-layers and agent-plexus,
with reinloop as the runtime of each agent and Lorebase as the knowledge. `StackHub` (`server/src/stack/`) builds one
agent-layers stack per person from `config/stacks/person.json` (profile = tier; one agent per capacity: decide, reply,
propose, write, vote, ballot, chair, ...), with the model (`hub-reinloop`: any reinloop provider; on Anthropic the
prompt cache and thinking are kept), the world's tools, the Lorebase read tools (branch and domain pinned by the hub, never by the model) and
telemetry (`data/telemetry/stack.jsonl`). Group decisions are agent-plexus systems over the members' own stacks
(`stack/topologies.ts`: orchestrator, council, router, chain, mentor, assembly; the committee is a graph that waits
for the resubmission of a deferred idea; journal in `data/plexus/journal.db`, base config `config/plexus/base.json`).
The idea keeps its waiting committee run in its Lorebase record (`committee_run`), so a deferral survives a restart;
re-apply the schema (`npm run lorebase:seed`) once for that attribute.

What the stacks report (usage with cache counts and price, reasoning, finished runs, spans) goes through one
`StackFeed` to the usage ledger of the Observatory, the thoughts shown to privileged clients, the mnemo run store and a
privileged `{type:'stack'}` WebSocket message (span totals of `agent.*` and `plexus.*`).

- The stack packages come from npm (`@agent-layers/*` ^0.4.2, `@agent-plexus/*` ^0.2.1, `reinloop` ^0.3.2). To test
  unreleased sibling checkouts of agent-layers or agent-plexus, `npm run stack:pin` temporarily re-vendors them: it
  builds and packs the tarballs into `vendor/` (`AGENT_LAYERS_DIR`, `AGENT_PLEXUS_DIR`; `STACK_PIN_REF=HEAD` builds
  the committed state) and points `package.json` at them with `file:` entries. Do not commit that state:
  `git checkout package.json package-lock.json && rm -rf vendor` and `npm install` return to the registry ranges.
- Mock vs live is decided per provider. A run is offline (the `hub-mock` model, which calls the same scripted
  decisions as before and still goes through the whole stack: tools, plexus, feed) when asked with `--mock` or
  `SIM_MOCK=1`, or when a model it uses cannot be called: the Anthropic tier models without `ANTHROPIC_API_KEY`. Live
  uses `hub-reinloop` with the model's own provider: `SIM_MODEL_OVERRIDE=ollama/qwen3:4b` runs every agent on the local
  Ollama with no key (`OLLAMA_BASE_URL` for another host; `GAME_PROFILE=local` sizes the run for a small model). The
  start banner and `GET /api/status` name the provider in use, or why the run is offline. Files go to `stack.dataDir`
  (`config/game.json`, default `data/`; `HUB_DATA_DIR` replaces it).
- Where to look: `docs/agent-stack-port.md` (design and decisions).

## Quickstart

Requirements: Node >= 22.18 and Docker. Lorebase 0.3.1 runs from the published images
(`ghcr.io/aantenore/lorebase` and `lorebase-ml`, linux/amd64 and linux/arm64) in the hub's own compose project
`hub-lorebase`: Keeper on 8280, Herald on 8290, Postgres on 5543, apart from any other Lorebase on the machine. No
Lorebase checkout is needed. reinloop 0.3.2, agent-layers 0.4.2 and agent-plexus 0.2.1 come from npm (see Agent stack
for testing unreleased checkouts).

```bash
npm install
(cd services/mnemo && npm install)   # mnemo's own dependency, once
npm run lorebase:up        # pulls the images once; Postgres + Keeper on 127.0.0.1:8280 (deploy/lorebase.env secrets generated)
npm run lorebase:seed      # schema, policies, roles, signals, methods; breakthroughs on the hidden branch
npm run game               # Herald (:8290, docker) + mnemo (:4510) + the hub (:4500)
npm run game:mock          # same, offline mock provider (no model calls)
(cd game && npm install && npm run dev)   # the isometric client on http://localhost:5184
```

- **Lorebase images.** `LOREBASE_VERSION` in `deploy/lorebase.settings.env` names the release; the compose file and
  the configuration of that release are committed under `deploy/compose/` and `deploy/lorebase.yaml`
  (`bash scripts/lorebase-up.sh sync` refreshes them from a checkout at tag `v<version>`, then commit). A one-off
  image comes from the shell: `LOREBASE_TAG=<tag> npm run lorebase:up` (also `LOREBASE_IMAGE`, `LOREBASE_ML_IMAGE`,
  `LOREBASE_PULL_POLICY`, `LOREBASE_CONFIG_FILE`); `deploy/lorebase.env` keeps ports and secrets only. To run a
  checkout instead, `LOREBASE_FROM_SOURCE=1 npm run lorebase:up` builds from `../lorebase` (`LOREBASE_REPO`) with that
  checkout's compose file and example configuration. `bash scripts/lorebase-up.sh ps|logs|down|destroy` manage the
  project (`destroy` removes the data volume).
- **Offline still needs Docker.** `npm run game:mock` makes no model calls but needs Keeper and Herald, and starts
  mnemo, which downloads its embedding model (`Xenova/multilingual-e5-small`, `config/mnemo.json`, under
  `data/models/`) on its first start. `MNEMO_URL= npm run game:mock` runs without mnemo (no private memory, the
  society is not kept across restarts). Without `ANTHROPIC_API_KEY` mnemo rewrites memories with a heuristic instead
  of a model.
- **A free live run on a local model.** `SIM_MODEL_OVERRIDE=ollama/qwen3:4b GAME_PROFILE=local npm run game` runs
  every agent on the local Ollama (http://localhost:11434, `OLLAMA_BASE_URL` for another host; pull the model first).
  The `local` profile (`config/profiles/local.json`) runs one decision at a time with long time limits, a large
  output limit (a thinking model's reasoning counts toward it: qwen3:4b needs a few thousand tokens and two to three
  minutes per decision on a laptop), fewer turns, no interns and the hosted web research off; any reinloop spec works
  the same way (`openai/gpt-5-mini` with `OPENAI_API_KEY`, `lmstudio/<model>`, ...). The banner says which provider
  runs (`provider ollama`), or why the run is offline.
- **Time limits.** `--seconds N` stops the hub after N seconds, counted from the start even while Lorebase is still
  awaited. The first failed connection logs `[lorebase] <url> unreachable: start it with npm run lorebase:up`; by
  default the hub keeps retrying, `--lorebase-wait N` (or `LOREBASE_MAX_WAIT_MS`, `lorebase.maxWaitMs` in
  `config/sim.json`) makes it give up with exit code 1 when Lorebase or its seed is not there after N seconds.
- **Language.** `SIM_LANGUAGE` (default `it`, `language` in `config/sim.json`) picks the hub's texts in
  `config/i18n/<language>.json` and `<language>.rt.json`; `en` is complete, the seed policies and the roster
  personalities are written in Italian.

`.env` holds `ANTHROPIC_API_KEY` (the Anthropic models and, by default, web research) and optionally `TAVILY_API_KEY` (only for `research.provider: tavily`). Useful environment: `GAME_TIME_SCALE` (game time multiplier),
`GAME_BUDGET_USD` (model spend cap of a run; default `budget.maxUsd` = 2 in `config/game.json`; at the cap
every mind pauses), `SIM_MODEL_OVERRIDE=haiku` (every agent on one tier, or on any reinloop model spec), `SIM_ROSTER_FILE` (another roster),
`GAME_CROWD` (number of interns), `GAME_PROFILE` (cost profile, `config/profiles/<name>.json`: `economy`, `local`), `--seconds N` (stop after N seconds). Other variables as in the engine
(`SIM_API_TOKEN`, `HERALD_URL`, `MNEMO_URL`, ...).

`npm run world:reset -- --dry-run` shows what a reset would do: policies back to the seed, breakthroughs
hidden again, newsletter, playbooks, teams, ideas, reviews and evidence archived on the tag `archive/<stamp>`, stale
`idea/`, `playbook/`, `policy/`, `breakthrough/` branches closed, private memory wiped.
Archives are Lorebase tags (read-only history, not counted against the Keeper's materialized-branch cap
`keeper.branches.max_materialized_per_domain`); read one with the tag name as ref. Older resets left `archive/*`
branches: `npm run lorebase:archive-to-tags` lists them (dry run), `-- --apply` deletes each branch and tags its head
Revision under the same name (branches and tags share one namespace; idempotent, protected branches skipped).

### Ports

| Service | Port |
|---|---|
| Hub server (REST, `/ws`, SSE) | 4500 |
| mnemo | 4510 |
| Keeper | 8280 |
| Herald (MCP) | 8290 |
| Postgres | 5543 |
| game client (Vite) | 5184 |
| web dashboard (Vite) | 5183 |

Keeper, Herald and Postgres are the compose project `hub-lorebase` (`scripts/lorebase-up.sh`; `LOREBASE_COMPOSE_PROJECT`
renames it), separate from any other Lorebase running on the machine; `KEEPER_HOST_PORT`, `POSTGRES_HOST_PORT` in
`deploy/lorebase.env` and `HERALD_HOST_PORT` in `deploy/lorebase.settings.env` move the ports (then `LOREBASE_URL` and
`HERALD_URL` for the hub).

### Default team

Eight minds (config/sim.json `roster`): Livia (venture lead, opus), Matteo (product strategist, sonnet),
Giulia (architect, sonnet), Enea (researcher), Sara (UX designer), Bruno (data scientist), Irene (security),
Dario (critic), the last five on haiku. Groups (`groups.seeded`): the **Comitato Investimenti** (council,
chaired by Livia, with Matteo and Dario; it only decides on ideas, its members plan on their own and nobody
joins it by themselves) and the **Squadra Esplorazione** (orchestrator: Enea, Sara, Bruno). Three interns
share one mind (crowd "Stagisti").

### Research, prompt caching, cost profiles

- **Web research.** `research` in `config/game.json`: `provider`: `anthropic-native` (default: Anthropic's hosted
  web search run by a small model call on the `anthropicTier` model, only the Anthropic key needed, about $0.01 per
  search plus the call's tokens, booked in the run's cost and budget under `<person>/web_search`, tier `research`;
  page reads through Anthropic's hosted `web_fetch` tool when `anthropicFetch` is set (`type`, `beta`,
  `maxContentTokens`, `maxOutputTokens`: one small call per page restricted to the page's host, tokens only, booked
  under `<person>/web_fetch`)), `tavily` (needs `TAVILY_API_KEY`; search and page reads) or `off`;
  `maxResults`, `maxResultsCap`, `maxChars` (per snippet), `maxFetchChars`, `cacheTtlMs` / `cacheMax` (server-side
  cache), `anthropicTier` (the model of `anthropic-native`), `fetch` (see below), `policies` (the keys of the quota and domain
  policies), `eventSnippetChars`, `recentMax`, `logMax`. Offline (`game:mock`) research is off.
  **Security:** `web_fetch` is not a free-form browser (a prompt-injected page could make it call an attacker URL
  carrying memory or conversations in the query string). With `research.fetch.mode` = `search-results-only`
  (default) it reads only URLs that came back, exactly, from the same agent's own `web_search` (kept server-side
  for `allowTtlMs`, at most `allowMax` per agent), or the official source (`url`) of a `Signal` record the person
  carries, has read on an idea (`leggi_idea`) or brought into an idea of theirs (the same normalization and checks,
  excluded domains included); anything else is refused as `not_from_search`. URLs must be
  http(s), without credentials, not an IP literal, not localhost / `.local` / `.internal` / single-label hosts, at
  most `maxUrlChars` long; fragments are dropped. `mode: "off"` refuses every fetch. Hostnames that resolve to
  private addresses are not detected (no DNS check).
- **Public signals and evidence.** `evidence` in `config/game.json`. Four signal tools from reinloop's
  `signalTools` (no key needed), given Italian names: `cerca_discussioni` (Hacker News, points), `cerca_progetti`
  (GitHub, stars), `cerca_domande` (Stack Overflow, votes), `cerca_paper` (arXiv). They share the decision's web cap
  (`maxWebCalls`), have their own daily quotas (policies `segnali_pubblici_*`) and a server-side cache
  (`signals.cacheTtlMs`, a cached answer is free); results are untrusted text. `allega_prova {idea, tipo, url,
  titolo?, metrica?, estratto?}` turns a result into an `Evidence` Record on the idea's branch, but only when the URL
  came back from the same person's own signal or web searches (`signals.allowTtlMs`, `allowMax`); source, title and
  metric are taken from the result (a `metrica` the model writes is never recorded). `intervista_simulata {idea, persona: cliente|dpo|utente,
  domande}` is one cheap call (`interview.tier`, `maxOutputTokens`) whose answers are stored as `simulated_interview`
  evidence with weight 0 and the label `ipotesi`, prefixed "IPOTESI ...". A player in the hub, within speech range
  of a person, validates an idea from the game's "Valida idea" panel (`POST /api/ideas/:code/validation`, or
  `npm run idea:validate -- --role dpo --verdict neutro --comment "..."`): `human_validation` evidence with the
  policy weight. Weights, quotas and the candidacy requirements are policies (table below); `candida_al_comitato`
  checks the requirements and answers with the numbers missing; the committee brief lists the evidence and a score
  that mixes reviews and evidence (`peso_prove_nel_punteggio_comitato`). Offline the signal tools answer with
  deterministic results under `example.org`. Counters in `reinloop`: `signalSearches`, `signalCached`,
  `signalRefused`, `signalErrors`, `evidenceAttached`, `interviews`; `gateRefusals` and `validations` in the stats.
- **Prompt caching.** On Anthropic models reinloop caches the prompt prefix (tool catalog, instructions, then the
  latest message). Every call puts what does not change between decisions first: tools, then the person's
  instructions (identity, role, faculties, horizon); the perception of the moment is the message, last. Config
  `promptCache` (`enabled`, `ttl`, `groupTtl`: `5m` or `1h`). `/api/observatory/summary` reports
  `reinloop.cache` (`readTokens`, `writeTokens`, `hitRatio` = read share of all input tokens, `savedUsd` against
  the same calls uncached, also `byModel` and `byTier`), spend per tool in `reinloop.costUsd.byTool` (`minds`,
  `web_search`, `web_fetch`, `intervista_simulata`, `segnali_pubblici`: runs, USD, share; public signals are free
  APIs) and the research counters in `reinloop` (`webSearches`, `webFetches`, `webCached`, `webRefused`, `webErrors`,
  `signalSearches`, `signalRefused`, `signalErrors`), with every refusal split by tool and cause in `webRefusals` and
  `signalRefusals` (`{"web_fetch:read_person_quota": 3, "web_search:decision_cap": 2, "cerca_discussioni:signal_total_quota": 4, ...}`). Research
  and signal caches keep answers for a day (`cacheTtlMs` 86400000).
- **Cost profiles.** `GAME_PROFILE=<name>` applies `config/profiles/<name>.json` over the config files (`game`
  into `config/game.json`, `sim` into `config/sim.json`, `rosterTiers` by name, `"*"` for the rest). `economy`:
  every mind on haiku, the committee chair (Livia) included; committee voters and group proposers on haiku, no interns, replan cooldowns x2 (sonnet x3), one Lorebase consultation per haiku decision,
  replies capped at 500 tokens, 8 turns per decision with at most 2 web calls (haiku) or 3 (sonnet), game clock x3
  (`loop.timeScale`; `GAME_TIME_SCALE` still wins). `local`: for a small local model (`SIM_MODEL_OVERRIDE=ollama/<model>`):
  one decision at a time, decision time limit 5 to 10 minutes, 8000 output tokens, 4 turns and one consultation per
  decision, no web calls, no interns, hosted research off, game clock x3.
- **Closing run.** A plan run that ends without `commit_plan` (or on its turn or tool-call budget) gets one closing
  run on the same conversation where only `commit_plan` answers (`decisions.closingTurn`; counted in
  `reinloop.closingRuns`, `closingCommitted`).
- **Per-decision web cap.** `decisions.tiers.<tier>.maxWebCalls`: searches and page reads one decision may make
  (past it a call is refused as `decision_cap`, counted in `reinloop.webCapped`, no quota spent), so a run keeps
  turns to commit its plan. Failures are counted by reason in `reinloop.failureReasons`.
- **Language of thoughts.** The Messages API has no setting for the language of thinking summaries, and in run 2
  they came back in English. Plan calls now use `thinking.display: "omitted"` (`decisions.modelParams.plan`): the
  thought shown for a decision is the person's own plan reason, written in Italian; the working-language line is
  the first line of the instructions. A thought's language is guessed from marker words
  (`decisions.thoughtLanguage`) and recorded (`lang` on the `say` event of kind `thought`; plan reasons in
  `reinloop.reasonLangs`, summaries, when turned on, in `reinloop.thoughtLangs`); nothing is translated.

## Policies

Seeded from `lorebase/rules.seed.yaml` (Kind `Rule`). The ones about ideas and the company:

| Policy | Default | Effect |
|---|---|---|
| `quarter_idea_slots` | 3 | approvals per quarter; with none left an approval becomes a deferral |
| `slot_scadono_a_fine_trimestre` | 1 | unused approval slots are lost at the end of the quarter (0: they carry over); perception and the committee brief say how many are left and on which day and hour they expire |
| `min_idea_reviewers` | 2 | reviews by non-authors needed to submit |
| `committee_quorum` | 2 | committee members present for it to decide; every seated member votes (`ideas.committee.maxVoters`, 0 = all) |
| `criteri_comitato` | 1 | the committee votes on the criteria of the rules `criterio_comitato_*` with value 1: a ballot (`vota_idea`) gives a verdict per criterion, a kill or defer names an unmet one, demands outside the criteria are recorded as out of policy; the chair records the decision with `decide_idea` (0: free votes) |
| `criterio_comitato_prove_del_problema`, `_concorrenza`, `_fattibilita`, `_rischio`, `_coerenza_strategica` | 1 each | the criteria (their text is what the members read; set one to 0 to drop it, add a rule with the prefix to add one) |
| `fase_approvazione` | 1 | what an approval funds: 1 concept exploration (paying customers belong to the pilot stage, outside the committee's scope), 2 pilot, 3 scale (`ideas.committee.phases`) |
| `costo_del_rinvio` | 1 | approval slots of the quarter a deferral consumes when the idea meets the candidacy requirements (0: none) |
| `obiettivo_portfolio_trimestre` | 3 | concepts explored (approved ideas) the company expects per quarter; in perception with the portfolio counts |
| `weight_impact`, `weight_feasibility`, `weight_novelty`, `weight_fit`, `weight_risk` | 0.3, 0.2, 0.2, 0.2, 0.1 | the weighted score shown to the committee (risk counted inverted) |
| `freeze_blocks_approvals` | 1 | no approvals during the year-end freeze |
| `max_open_ideas_per_person` | 3 | open ideas one can champion |
| `fame_idea_proposed`, `fame_idea_approved`, `fame_review_given` | 0.5, 5, 0.5 | impact of each deed |
| `promotion_senior_fame`, `promotion_principal_fame`, `promotion_fellow_fame` | 2, 6, 12 | career steps |
| `risk_appetite` | 6 | read by people; not enforced by the world |
| `ricerche_web_per_persona_al_giorno` | 3 | web searches one person may do per game day (a cached answer is free) |
| `ricerche_web_totali_al_giorno` | 10 | the same for the whole hub (hosted search was the largest cost of run 3; public signals are free) |
| `letture_web_per_persona_al_giorno`, `letture_web_totali_al_giorno` | 12, 60 | page reads (`web_fetch`) per person and for the hub per game day, counted apart from searches (`research.policies.readsPerPerson`, `readsTotal`; without them reads count against the search quotas) |
| `cadenza_sedute_comitato_ore` | 2 | game hours between committee sessions, on a fixed grid from day 1 00:00; a session decides on the ideas waiting (`ideas.committee.maxPerSession`); perception says how long a submitted idea has waited and when the next session is (0: a session follows each submission) |
| `astensione_conflitto_interessi` | 1 | the champion and authors of an idea neither vote nor chair its committee session; a conflicted chair is replaced by the eligible member with the highest career step (then vote weight); quorum counts eligible members (enforced by the server) |
| `comitato_non_coautore` | 1 | members of the investment committee never become authors: they cannot propose ideas, and an edit of theirs is recorded as a reviewer's contribution (`contributed` in the idea's history), not co-authorship |
| `supplenti_comitato_per_anzianita` | 1 | when fewer committee members than the quorum may decide on an idea, people of the hub with no conflict on it sit as alternates by career step, then esteem, up to the quorum (0: the idea waits) |
| `revisioni_indipendenti` | 1 | a non-author reads the other reviews' scores and comments of an idea only after reviewing it (`leggi_idea` and perception filtered by the server); identical five scores to an existing review are noted in the idea's history (`scores_match`), never blocked |
| `segnali_pubblici_per_persona_al_giorno`, `segnali_pubblici_totali_al_giorno` | 16, 120 | public signal searches per person and for the hub per game day (cached answers are free) |
| `interviste_simulate_per_persona_al_giorno`, `interviste_simulate_totali_al_giorno` | 2, 10 | simulated interviews per person and for the hub per game day |
| `peso_prova_segnale_pubblico`, `peso_prova_fonte_web`, `peso_prova_validazione_umana` | 1, 0.5, 2 | weight of each kind of evidence (simulated interviews always 0) |
| `requisiti_candidatura_prove_reali`, `requisiti_candidatura_fonti_distinte` | 3, 2 | to submit, an idea needs this much real evidence (weight > 0, interviews excluded) from this many distinct sources... |
| `requisiti_candidatura_validazioni_umane` | 1 | ...or this many human validations instead (0: no such path) |
| `requisiti_candidatura_punteggio_minimo` | 0 | minimum weighted review score to submit (0: none) |
| `peso_prove_nel_punteggio_comitato`, `prove_per_punteggio_pieno` | 0.3, 6 | share of the evidence score (0-10, full at this sum of weights) in the score the committee reads |
| `domini_esclusi` | text | domains named in the text are dropped from results and never fetched |
| `tema_agenti_ai`, `tema_developer_experience`, `tema_sicurezza` | text | strategic themes (category `strategy`, in `company.themes`) |
| `orario_di_lavoro`, `regole_riunioni`, `giorni_remoti`, `zona_relax`, `codice_valutazione` | text | conduct policies people read and may report |
| `winter_every_ticks`, `winter_length_ticks`, `season_turn_minutes` | 16, 1, 45 | the year (four quarters) and its freeze |
| `dawn_minute`, `dusk_minute` | 420, 1260 | working hours (7-21, as in `orario_di_lavoro`); the rest is night |
| `food_per_tick`, `starvation_threshold`, `rest_heal` | 0.4, 8, 1 | stress per turn, burnout threshold, energy back from a break |

### Changing a policy

```bash
npm run rule -- quarter_idea_slots 1 --mode proposal -m "Tighter budget"
npm run rule -- min_idea_reviewers 3 --mode direct
npm run rule -- --new tema_dati --text "Prodotti sui dati per le PMI." --category strategy
npm run scenario -- budget-ridotto        # list: npm run scenario (crunch, innovazione-aperta, rischio-zero, defaults)
```

What to expect: the server logs `[lorebase] rules_changed ...`; everyone gets a company announcement in the
inbox and thinks again (`replanOn.rulesChanged`); the next committee session applies the new slots, quorum or
freeze rule; a `company` event carries the slots and themes as they are now (a new `strategy` policy is a theme from that moment).
Agents read the wording in Lorebase when they consult it. Agents esteemed enough propose policies themselves
(`proponi_legge`): those Proposals wait for the board (`POST /api/law-proposals/:id/approve|reject` or the
Lorebase review UI).

## Protocol

WebSocket `/ws` (JSON) and its SSE mirror `GET /api/stream`. Every message type and field of the engine is
kept (see the civilization README); the hub changes and adds:

- `tiles` / `hello.map.tiles`: `biome` in `office | meeting | lab | lounge | wall | garden | plaza` (`wall` is
  not walkable); `shelter` is the structure level: 0 none, 1 desk or whiteboard, 2 fitted meeting room.
- Entities: `hp` is energy, `hunger` is stress; `career: 'junior' | 'senior' | 'principal' | 'fellow'` (also in
  `reputation.people[]` and `GET /api/society`). `entity_removed.reason`: `'left' | 'burnout'`.
- `time`: adds `quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'` and `freeze: boolean` (`season` kept).
- `hello`: adds `company: {name, quarter, slotsLeft, themes: string[], freeze}` and `ideas: Idea[]`.
- `group`: adds `committee: boolean` and `jointPlans: boolean`.
- `Idea = {code, title, problem, users, solution, differentiation, feasibility, risks, tags: string[], stage, champion: string | null, authors: string[], scores: {impact, feasibility, novelty, fit, risk} | null, reviews: [{by, scores, comment, at: {day, minute}}], branch, proposalId: string | null, quarter, history: [{at: {day, minute}, by, action, note}], signals: string[], sources: [{title, url}], evidence: Evidence[], gate?: {pass, real, sources, human, hypotheses, missing: [{code, have, need}], need: {minReal, minSources, minHuman, minScore}}, decision: {decision, summary, at, votes} | null}`.
  `Evidence = {code, idea, type: 'public_signal' | 'human_validation' | 'simulated_interview' | 'web_source', source: 'hackernews' | 'github' | 'stackoverflow' | 'arxiv' | 'web' | 'player' | 'persona', url, title, metric: number | null, metric_name, excerpt, collected_by, collected_at: {day, minute}, weight, label ('ipotesi' on simulated interviews), role?, verdict?}`.
  `stage` in `signal | insight | concept | proposal | pitch | approved | killed`. People (champion, authors,
  reviewers, history `by`) are **names**. `scores` is the mean of the reviews (0-10, one decimal).
- `idea {idea, action}`: `action` in `created | updated | reviewed | submitted | approved | killed | stage | evidence`.
- `evidence {ideaCode, evidence}`: a piece of evidence was attached (the `idea` message that follows carries the full idea).
- `committee {groupId, ideaCode, decision: 'approve' | 'kill' | 'defer', votes: [{member, vote, reason}], summary}`:
  `member` is an entity id; with `SIM_API_TOKEN` set the votes go only to privileged connections (others get
  `votes: []`), the summary to everyone.
- `company {name, quarter, slotsLeft, themes, freeze}`: at every quarter turn, after each committee decision and when policies change.
- `world_event` kinds add `idea` and `company` (promotions, quarterly reviews).
- `research {agentId, tool: 'web_search' | 'web_fetch' | 'cerca_discussioni' | 'cerca_progetti' | 'cerca_domande' | 'cerca_paper', query?, url?, results: [{title, url}], cached, snippets?}`:
  a person searched the web or read a page; `snippets` only to privileged connections. `GET /api/agents/:id/mind`
  adds `research` (the person's latest, same fields without snippets).

REST:

- `GET /api/ideas?stage=&tag=&author=` → `Idea[]` (author matches authors and champion, by name).
- `GET /api/ideas/:code` → `Idea` (404 when unknown).
- `POST /api/ideas/:code/validation` `{player, role: 'cliente' | 'dpo' | 'utente', verdict: 'positivo' | 'neutro' | 'negativo', comment}` → `{ok, evidence}`; 403 when `player` is not a player entity, 409 when no person of the hub is within `speech_radius` (or the idea is decided). Same mutation guard as every POST.
- `GET /api/ideas/export.md` → the portfolio in markdown (approved, pipeline by stage, killed), `text/markdown`.
- `GET /api/research` → `{provider, stats, items: [{at, agentId, name, tool, query?, url?, results, cached}]}` (the run's searches, no snippets).
- `GET /api/company` → `{name, quarter, slotsLeft, themes, freeze, stats: {proposed, submitted, approved, killed}, slotsPerQuarter, committee}`.

## Exporting the ideas

```bash
curl -s http://127.0.0.1:4500/api/ideas/export.md > portafoglio.md
curl -s 'http://127.0.0.1:4500/api/ideas?stage=approved' | jq '.[].title'
```

Approved ideas are also Lorebase records on `main` (Kind `Idea`, with their `Review` records): the
portfolio survives restarts and is searchable by agents through Herald. Ideas still in the pipeline and
killed ones stay on their `idea/` branches and are reloaded at start.

## Evidence

Live run 1 (2026-10-26, 30 real minutes, $2.33, economy profile, Tavily research), report in
[docs/run-report.md](docs/run-report.md):

- [summary.json](docs/evidence/run1/summary.json): `/api/observatory/summary` at the end (cost, cache, decisions, failures, web counters)
- [portfolio.md](docs/evidence/run1/portfolio.md): `/api/ideas/export.md` at the end (also [docs/portfolio-run1.md](docs/portfolio-run1.md))
- [committee.md](docs/evidence/run1/committee.md): every committee decision with votes and reasons
- [conversations.md](docs/evidence/run1/conversations.md): curated thoughts, reviews and exchanges, including how search results were used
- [research.md](docs/evidence/run1/research.md): every search and page read, with the top result titles and links
- [lorebase-log.md](docs/evidence/run1/lorebase-log.md): `main` revision log, `idea/` branches and their Proposals
Live run 2 (2026-10-26, stopped by the $3 budget after 19 real minutes, conflict-of-interest and independent-review
policies on, clock x3), section "Run 2" of [docs/run-report.md](docs/run-report.md):

- [summary.json](docs/evidence/run2/summary.json) (adds `failureReasons`, `thoughtLangs`, `recusals`, `scoreMatches`, `webCapped`)
- [portfolio.md](docs/evidence/run2/portfolio.md) (also [docs/portfolio-run2.md](docs/portfolio-run2.md))
- [committee.md](docs/evidence/run2/committee.md): no session (nothing was submitted)
- [conversations.md](docs/evidence/run2/conversations.md), [research.md](docs/evidence/run2/research.md),
  [lorebase-log.md](docs/evidence/run2/lorebase-log.md)

Live run 3 (2026-10-26, 28 real minutes, $2.27, all minds on haiku, evidence and candidacy requirements), section
"Run 3" of [docs/run-report.md](docs/run-report.md): one idea met the requirements per policy with public signals and
web sources only, but the team held it back waiting for human interviews; no committee session.

- [evidence.md](docs/evidence/run3/evidence.md): every piece of evidence with its link, source, metric and weight
- [summary.json](docs/evidence/run3/summary.json) (adds `signalSearches`, `evidenceAttached`, `interviews`, `gateRefusals`, `validations`)
- [portfolio.md](docs/evidence/run3/portfolio.md) (also [docs/portfolio-run3.md](docs/portfolio-run3.md)),
  [committee.md](docs/evidence/run3/committee.md), [conversations.md](docs/evidence/run3/conversations.md),
  [research.md](docs/evidence/run3/research.md), [lorebase-log.md](docs/evidence/run3/lorebase-log.md)

Live run 4 (2026-10-26, 30 real minutes, $1.93: minds $1.46, hosted web search $0.48 (25%), public signals $0),
section "Run 4" of [docs/run-report.md](docs/run-report.md): committee kept out of authorship, expiring slots in
perception; the committee sat twice on one idea that met the requirements and deferred it twice, asking for a
verified customer spend no policy requires.

- [evidence.md](docs/evidence/run4/evidence.md), [summary.json](docs/evidence/run4/summary.json) (adds
  `reinloop.costUsd.byTool`, `alternates`), [portfolio.md](docs/evidence/run4/portfolio.md) (also
  [docs/portfolio-run4.md](docs/portfolio-run4.md)), [committee.md](docs/evidence/run4/committee.md) (votes and
  reasons), [conversations.md](docs/evidence/run4/conversations.md), [research.md](docs/evidence/run4/research.md),
  [lorebase-log.md](docs/evidence/run4/lorebase-log.md)

Live run 5 (2026-10-26, 30 real minutes, $1.89: minds $1.37, hosted web search $0.51, public signals $0), section
"Run 5" of [docs/run-report.md](docs/run-report.md): committee criteria, deferral cost and portfolio target as
policies, closing runs (0 plans lost, 27 in run 4), Hacker News answering 31 of 31 searches; the one idea meeting
the requirements was held back before submission, so the committee never sat.

- [evidence.md](docs/evidence/run5/evidence.md), [summary.json](docs/evidence/run5/summary.json) (adds
  `closingRuns`, `closingCommitted`, `criteriaMet`, `criteriaUnmet`, `outOfPolicy`, `deferralSlots`),
  [portfolio.md](docs/evidence/run5/portfolio.md) (also [docs/portfolio-run5.md](docs/portfolio-run5.md)),
  [committee.md](docs/evidence/run5/committee.md), [conversations.md](docs/evidence/run5/conversations.md),
  [research.md](docs/evidence/run5/research.md), [lorebase-log.md](docs/evidence/run5/lorebase-log.md)

Live run 6 (2026-10-26, 30 real minutes, $1.81: minds $1.32, hosted web search $0.48, page reads $0.004), section
"Run 6" of [docs/run-report.md](docs/run-report.md): page reads with their own quotas, refusals by tool and cause,
committee sessions on a schedule with waiting time and next session in perception, official sources on regulatory
signals; two submissions, two deferrals on `prove_del_problema` (6 of 6 ballots), every other criterion met.

- [committee.md](docs/evidence/run6/committee.md) (votes per criterion), [evidence.md](docs/evidence/run6/evidence.md),
  [summary.json](docs/evidence/run6/summary.json) (adds `webRefusals`, `signalRefusals`),
  [portfolio.md](docs/evidence/run6/portfolio.md) (also [docs/portfolio-run6.md](docs/portfolio-run6.md)),
  [research.md](docs/evidence/run6/research.md), [conversations.md](docs/evidence/run6/conversations.md),
  [lorebase-log.md](docs/evidence/run6/lorebase-log.md)

- [run-progress.log](docs/run-progress.log) and the screenshots above (idea board, idea detail and board mode are from
  run 6; the others from earlier live runs)

## Known limits

- The committee is the seeded group named in `ideas.committee.groupName`; if it dissolves, submitted ideas wait
  (below quorum, alternates sit by policy `supplenti_comitato_per_anzianita`).
- Ideas are written to Lorebase in the background (retried on 429 and 5xx); an idea created while Keeper is
  down is kept in memory for the run only.
- Offline, movement follows `mock.habits` (which company roles explore, gather, build or look after colleagues);
  idea work comes from the individual minds (committee members and people outside groups), squad members follow
  joint plans.
- Research, signal and interview quotas are counted in memory per game day: a restart starts the count again.
- A human validation is accepted from any player entity in speech range of a person of the hub; players are not
  authenticated beyond the API token.
- Herald pins agents to `main`: they read approved ideas there and see open ones through their perception and
  `leggi_idea`. Reviews of open ideas live on their `idea/` branches, out of reach of the agents' Lorebase tools, so
  `revisioni_indipendenti` is enforced where agents can read them (perception, `leggi_idea`).
