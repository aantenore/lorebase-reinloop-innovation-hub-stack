# Port plan: innovation hub onto agent-layers 0.4 + agent-plexus 0.2

Target: the realtime game path (server/src/game-main.ts + server/src/rt/*); server/src/sim/ is legacy and stays untouched. Paths below are relative to the repository root.

## Dependencies
- agent-layers 0.4.0 (`@agent-layers/core`, `@agent-layers/adapters`) and agent-plexus 0.2.0 (`@agent-plexus/core`, `@agent-plexus/adapters`) are not on npm yet. They are vendored as tarballs in `vendor/agent-layers` and `vendor/agent-plexus` and referenced with `file:` dependencies.
- `npm run stack:pin` (scripts/stack-pin.sh) rebuilds and refreshes those tarballs from the sibling checkouts (`AGENT_LAYERS_DIR`, `AGENT_PLEXUS_DIR`; `STACK_PIN_REF` builds a committed ref instead of the working tree) and rewrites package.json.
- Once the packages are published, replace the `file:` entries with `^0.4.0` (agent-layers) and `^0.2.0` (agent-plexus), delete `vendor/agent-layers`, `vendor/agent-plexus` and the pin script.
- reinloop comes from npm (`^0.3.0`), the version the agent-layers reinloop adapter takes as its optional peer: one copy for the hub and the adapter.

## Decisions
- Model now: hub-local ModelPort `hub-anthropic` registered via compose(config,{adapters}), wrapping reinloop's `anthropic/<model>` provider (keeps prompt caching, thinking/effort, workspace header, cache-token usage). openai-compatible against the Anthropic compat endpoint = fallback profile only. Native agent-layers anthropic adapter later (lift from hub-anthropic).
- No plexus `vote` kind: tally = domain logic (esteem weights, criteria ballots, quorum, freeze) -> `parallel` + app `merge` function-member. Upstream candidate later: parallel.join:"settled".
- Memory: keep mnemo app-side (recall used in prompt build decide.ts, society, run-store). No MemoryPort adapter now.
- Mock: `hub-mock` ModelPort calling existing world-aware scripts (mockDecision decide.ts:334, mocks in groups.ts, CommitteeMock). mock-model only in stack unit tests.
- Knowledge: Lorebase via agent-layers `mcp` adapter wrapped by hub decorator `lorebase-mcp`: builds createMcpTools(...), wraps callTool to pin domain/branch and strip branchArgs (security invariant, brain.ts:103-130), charge consult budget from per-run scratch, emit `consulted`.
- agent-layers patch (U0), packages/adapters/src/reinloop: (a) per-agent ext["reinloop.budget"] tightening runtime budget (one stack holds decide/reply/vote with different maxTurns); (b) governed.ts:82: ToolResult with ext["reinloop.stop"]===true -> {stop:true} (commit_plan/ballots end the run); (c) convert.ts:38/72: round-trip thinking signature via ReasoningPart.ext["anthropic.signature"] (else thinking+tool loops -> 400).
- Plexus: no changes.

## 1. Seam (hub call sites)
| File:line | Today | Becomes |
| rt/decide.ts:175-182 modelRef | mockProvider or anthropic/... | removed; profile + hub-mock decide |
| rt/decide.ts:479-530 decide() (agent( 496, .stream 511) | reinloop agent + closing turn | stackFor(e).stream('decide',...); plan from scratch; closing turn uses transcript from model tap |
| rt/decide.ts:557-620 reply() (574,599) | text_delta->onDelta | stackFor(e).stream('reply'); text events; model.reply with calls>0 = turn boundary |
| rt/groups.ts:364-395 member(), 421-519 build(), 525-617 patterns | reinloop team/definePattern | systemFor(g, members) (section 2) |
| rt/groups.ts:769-830 decide() (runner.run 811) | sink trace | system.run(situation,{runId,sessionId}); trace from member wrapper |
| rt/groups.ts:666-765 reviewIdea() (a.run 681) | parallel ballots then chair | committee graph; returns {...outcome, runId, waiting} |
| rt/game.ts:2024 | groups.reviewIdea(...) | run, or resumeReview(idea.committeeRun, brief) when waiting run exists |
| rt/game.ts:346-362 | runSinks, ranModel, reasoned | fed by StackFeed |
| rt/game.ts:282, 1211-1248 | GroupManager, mindHost | unchanged signatures; mind.ts untouched |
| rt/mnemo.ts:166 runSinks | reinloop Sink | feedTelemetry record -> mnemo run-store |
| rt/brain.ts:103 lorebaseTools | reinloop Tools | lorebase-mcp (Brain keeps its client for other uses) |
Kept on reinloop as tool-internal calls: research.ts (230, anthropicFetcher 131), evidence.ts:391 interviews; cost via existing searchUsage.

New server/src/stack/:
```ts
class StackHub { constructor(host: DecideHost, o:{mock:boolean; feed:StackFeed; dataDir:string})
  stackFor(e: RtEntity): Promise<PersonStack>        // cache key id+tier+mock; profile = tier
  systemFor(g: Group, members: RtEntity[], kind: GroupPattern|'committee'): Promise<System> // cache key membership hash
  close(): Promise<void> }
type Capacity = 'decide'|'reply'|'propose'|'write'|'write_member'|'vote'|'ballot'|'chair'|'judge'|'route'|'lead';
interface PersonStack { stack: Stack; scratch: Scratch;
  run(cap: Capacity, input: RunInput, o: RunOpts): Promise<CapResult>;
  stream(cap: Capacity, input: RunInput, o: RunOpts): AsyncIterable<RunEvent> & { result: Promise<CapResult> } }
interface RunOpts { sessionId: string; runId?: string; signal?: AbortSignal; mock?: (req, i) => MockTurn; tools?: Tool[] }
interface CapResult { run: RunResult; plan?: PlanData; record?: Ballot|ChairDecision; verdict?: {pass:boolean; feedback:string};
  delegate?: {member:string; input?:string}; handoff?: string; rethink?: boolean; transcript?: Message[] }
```
- tools.ts: worldToolDefs(e): ToolDef[] static specs via functionTools; reuses faculties (decide.ts:127), ideaTools (222), social, research, evidence through fromReinloopTool(t: Tool): ToolDef. Each run delegates to the per-run instance in scratch.get(ctx.sessionId, ctx.agent) so budgets and commit capture stay as today. {content,isError,stop,data} -> {ok,text,data,ext:{'reinloop.stop'}}.
- model.ts: hubAnthropic + hubMock descriptors, both wrapped by tap(port, person, feed): emits reasoning + usage (incl cache read/write), keeps last request+reply per run for the closing turn. Params from agent ext["anthropic.params"] (cache, cacheTtl, thinking, effort). No temperature.
- members.ts: `hub-person {person, capacity}` wraps memberFromStack: before invoke opens scratch + role template; after invoke sets output (plan JSON when committed) and ext (hub.decision, hub.verdict, plexus.delegate, plexus.handoff); coerces non-completed into completed (partial text, abstain, judge failure = pass); records lastPlan[sessionId]; calls host.deliberated. `hub-fn {fn}` = function-member with ballot-box, tally, committee-tally (repairSteps, tally, weightedWinner). `hub-revision` capabilities {waits,resume}: invoke returns waiting needs_input with taskRef = idea code + outcome as output; resume(ref,input) completes with revised brief.
- topologies.ts: pure topologyFor(kind, roster): SystemConfigRaw; systems via resolveConfig then assemble(cfg,{resolveAdapter: hubLoader, quiet:true}).
- feed.ts: StackFeed (EventEmitter) + feedTelemetry() on recordingTelemetry.
- configs.ts: loadPersonConfig(tier, mock): loadConfig('config/stacks/person.json',{profile:tier}) + mergeLayers model overlay when mock.
- config/stacks/person.json: runtime reinloop, model hub-anthropic, tools world + lorebase, telemetry jsonl -> data/telemetry/stack.jsonl, profiles opus|sonnet|haiku; one agent per capacity with tool globs + ext["reinloop.budget"]; propose/vote/write_member use groups.memberTier model.
- config/plexus/base.json: basic-topology, sqlite-execution data/plexus/journal.db, limits.

## 2. Pattern -> plexus topology (member id <pid>-<cap>)
- orchestrator: supervise{supervisor: lead-lead, members: workers-propose}; `delega` tool -> plexus.delegate; plan from scratch
- council: loop{body: sequence[parallel{branches: proposers-propose, merge: elder-write}, elder-judge], until:{ext:{"hub.verdict":"pass"}}, maxIterations: groups.maxRounds}; on limit use lastPlan
- router: handoff{start: lead-route, members: cands-write, maxHandoffs:1}; `instrada` tool -> plexus.handoff
- chain: sequence[scout-propose, planners-propose..., doer-write]
- mentor: loop{body: sequence[appr-write, mentor-judge], until verdict pass, maxIterations: maxRounds}
- assembly: graph{proposals: parallel{voting-write_member, merge: fn:ballot-box}, ballots: parallel{voting-vote, merge: fn:tally}; edges proposals->ballots when ext hub.vote; end [proposals, ballots]}
- crowd: no system: stackFor(crowdLeader).run('write')
- committee: graph{ballots: parallel{seats-ballot (unseated person abstains without model call), merge: fn:committee-tally}, chair: chair-chair, revision: revision}; edges ballots->revision when hub.decision defer; ballots->chair when hub.chair; chair->revision when defer; revision->ballots; end [ballots, chair]
Committee flow: defer -> run ends waiting; app applies deferral (slots, Lorebase history) from output, stores {runId, configHash} on the idea. Resubmission: system.resume(runId,{input:newBrief, wait: token}); old ballots replay; maxIterations caps deferrals. Judges/voters/routers use record tools (verdetto, vota_idea, instrada, decide_idea) ending with reinloop.stop, checked by checkBallot/checkChair.

## 3-5. Model, memory, streaming
Pricing for Observatory from the tap (raw usage + pricingFor incl cache); ignore RunResult.costUsd. Streaming into existing WS/SSE (no protocol change): reply text -> say_delta; tap reasoning -> reasoned; commit_plan -> commitPlan; tool runs -> consulted/agent_action from tool fns; member wrapper -> deliberated; telemetry spans (agent.*, plexus.*) -> mnemo run-store + optional privileged {type:'stack'} message.

## 6. Units. Order: U0 || U1, then U2 || U3, then U4, then U5
- U0 agent-layers patch (packages/adapters/src/reinloop index/governed/convert + tests + changelog). Tests: reinloop adapter tests + RuntimePort conformance only.
- U1 hub foundation: package.json, scripts/stack-pin.sh, stack/{index,configs,model,feed,tools}.ts, config/stacks/person.json, config/plexus/base.json. Repin reinloop ^0.3.0; vendor agent-layers/plexus tgz. Accept: stackFor composes 3 tiers x mock; mock decide commits a plan via scratch; tap emits usage+reasoning. Tests: stack/{model,stack,tools}.test.ts, rt/rt.test.ts.
- U2 person thinking: rt/decide.ts (decide, reply, remove modelRef). Same Decision/Reply contracts; closing turn; rethink; deny after closing via scratch flag. Tests rt/lifecycle.test.ts, rt/rt.test.ts.
- U3 group systems: stack/{members,topologies}.ts, rt/groups.ts build/decide/member. Every pattern under hub-mock returns valid JointPlan + trace; failing member doesn't fail a parallel node. Tests stack/topologies.test.ts, stack/groups.test.ts.
- U4 committee + waits: reviewIdea in groups.ts, game.ts:1987-2050, committeeRun in rt/ideas.ts, scripts/world-reset.ts (delete journal). defer->waiting->resume->approve; survives restart (same sqlite); config-hash mismatch cancels and starts fresh. Tests rt/committee.test.ts, rt/ideas.test.ts, stack/committee.test.ts.
- U5 feed + verification: game.ts:346-362, mnemo.ts:166, observatory.ts input, remove remaining direct reinloop agent( in decide/groups. Then once: npm test, npm run game:mock -- --seconds 60, one live npm run game -- --seconds 120.

## 7. Risks
1 thinking signature loss -> 400 (U0-c; fallback thinking off). 2 cache-token cost lost in RunResult; use tap. 3 two reinloop copies (vendored vs peer); repin first, check research/evidence/signals imports. 4 parallel join:all returns first failure; coerce tolerant roles in hub-person. 5 committee resume with changed membership/config -> replay mismatch; stable seats + stored config hash. 6 sqlite journal leaseMs vs long waits, maxRuns, world:reset deletes it. 7 scratch keyed (sessionId, agent): add hopId, serialize per key. 8 cache stacks per person, systems per membership hash, close on change. 9 structured output -> record tools; tests assert behaviour not text. 10 Lorebase pinning security-critical: test that model-supplied branch is ignored. 11 Node runs .ts directly: vendor built dist tgz (or --conditions=@agent-layers/source). 12 run ids <=128 chars, unique: ${g.id}:${day}:${minute}:${n}.
