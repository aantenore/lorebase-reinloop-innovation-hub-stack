# Prompts

What the people of the hub read. The prompt is minimal: identity, role in the company, faculties and
factual perception. No tasks, no goals, no strategy, no advice on when to use a tool. Everything
they read is Italian (`config/i18n/it.rt.json`, language in `config/sim.json`); code identifiers,
policy keys and logs stay in English. Policies are not in the prompt: they live in Lorebase and are
consulted with the `lorebase_*` tools.

## Parts

| Part | Source |
|------|--------|
| Instructions (system) | `rt.instructions`: name and personality, the hub (people here generate and evaluate IT product ideas, they do not build them), role code and title (Lorebase `Role`), the faculties (a mind connected to Lorebase: policies, the role's playbook, the newsletter, the portfolio of approved ideas; a private memory `remember`/`recall`; when research is on, `rt.webFaculty`: "Puoi cercare sul web (web_search) e leggere pagine web (web_fetch)."; when evidence is on, `rt.evidenceFaculty`: the signal tools, `allega_prova` and `intervista_simulata`, whose answers are generated hypotheses) and the plan interface; the first line is the working language (`Lingua di lavoro: italiano...`) (`commit_plan`, horizon of the tier) |
| Observation (user message, at each decision) | `rt.observation.*`, `rt.look.*`, `rt.recipes.*`, `rt.body.*`: day, hour, quarter and freeze; energy, stress, what the person carries (codes and names) and where; body changes since it last thought; group; current step; why it thinks again (a fact); what it sees within `vision_radius` (rooms, coffee, whiteboard material, desks, colleagues, signals to pick up); the work methods it knows and what it lacks; seniority; exchange offers; hearsay; the company line; the ideas block; what was said to it; what it lived; which policies changed |
| Tools | `commit_plan`, `say`, `form_group`, `join_group`, `leave_group`, `scambia`, `chiedi`, `rispondi_scambio`, `giudica`, `testimonia`, `proponi_legge` (a policy proposal), `share_insight` / `review_insights` / `judge_insight` (role playbook), the idea tools below; Lorebase read tools from Herald; private memory `remember` / `recall`; `web_search` / `web_fetch` (`rt.tools.web_search`, `rt.tools.web_fetch`: what they return, nothing on when); the evidence tools below |
| Spoken reply | same instructions + `rt.replyInstructions`; short observation; optional `rethink` |
| Group members | `rt.memberInstructions` + the group situation (`rt.group.*`); plan writers get `commit_plan`, proposers prose; both get the faculties line, the Lorebase and memory tools and the idea tools; judges, voters and routers answer with structured output and no tools |
| Committee | every seated member votes (`ideas.committee.maxVoters`, 0 = all; `groups.maxProposers` does not apply). With policy `criteri_comitato` on: `rt.committee.voteTaskCriteria` and the only tool `vota_idea` (`criteri`: `{<criterion>: {soddisfatto, nota}}` for every criterion, `voto`, `motivo`, `richieste_fuori_policy?`), then `rt.committee.chairTaskCriteria` and the only tool `decide_idea` (`decisione`, `criteri_non_soddisfatti`, `sintesi`, `richieste_fuori_policy?`); a call the policy refuses says why ("non registrato: per policy criteri_comitato un kill o un defer ha almeno un criterio non soddisfatto ...") and may be repeated (`ballotMaxTurns`). With the policy off: `rt.committee.voteTask` (tool `vota_idea` with `{vote, reason}`), `rt.committee.chairTask` (tool `decide_idea` with `{decision, summary}`). The brief is `rt.committee.idea` + `rt.committee.company` + the portfolio line + `rt.committee.policyBlock` (each criterion with its rule text, `fase_approvazione`, `costo_del_rinvio`) |
| Closing run | a plan run that ends without `commit_plan`, or on its turn or tool-call budget, gets one more run on the same conversation (`decisions.closingTurn`) with the user line `rt.observation.closingTurn` ("FINE DELLA RIFLESSIONE: ... nessun piano è fissato. In questo turno risponde solo commit_plan ..."); the same tools stay listed (cache prefix), the others answer `rt.act.decisionClosed` |

## Idea tools

Descriptions say what each tool does, never when or why to use it (`rt.tools.idea.*`):

| Tool | Arguments | Effect |
|------|-----------|--------|
| `proponi_idea` | `title`, `problem`, `users?`, `solution?`, `differentiation?`, `feasibility?`, `risks?`, `tags?`, `signals?`, `sources?` (`[{title, url}]`, http/https only) | a new idea on its own `idea/<code>` branch, the person as champion; carried items named in `signals` (signals, work artifacts) go into it |
| `arricchisci_idea` | `code` + any field | adds or rewrites fields of an open idea; the editor becomes a co-author, except a committee member under policy `comitato_non_coautore` (recorded as a reviewer's contribution, `rt.act.ideaContributed`) |
| `valuta_idea` | `code`, `impact`, `feasibility`, `novelty`, `fit`, `risk` (0-10), `comment` | a peer review (never of one's own idea; one per person, a new one replaces the old) |
| `candida_al_comitato` | `code` | an author submits a complete idea with enough reviews; a Proposal into `main` opens |
| `leggi_idea` | `code` | the idea in full (fields, authors, reviews, weighted score, history) |

## Evidence tools

| Tool | Arguments | Effect |
|------|-----------|--------|
| `cerca_discussioni`, `cerca_progetti`, `cerca_domande`, `cerca_paper` | `query`, `max_results?` | Hacker News, GitHub, Stack Overflow, arXiv through reinloop `signalTools`; compact JSON marked untrusted (`rt.tools.signal.*` say what each returns and the language each source indexes, "indicizza contenuti in inglese"). Hacker News: a query no story matches with every word is asked again with every word optional and no typo tolerance (`evidence.signals.hackernews.partialMatch`), those results carry `match: "partial"` |
| `allega_prova` | `idea`, `tipo` (`segnale_pubblico` / `fonte_web`), `url`, `titolo?`, `metrica?`, `estratto?` | an `Evidence` Record on the idea's branch, only for a URL from the person's own searches; source, title and metric come from the result |
| `intervista_simulata` | `idea`, `persona` (`cliente` / `dpo` / `utente`), `domande` | one call to a small model playing that persona (`rt.interview.*`); answers stored with weight 0, label `ipotesi`, prefixed "IPOTESI (intervista simulata ..., non è una prova)" |

Refusals are facts (`rt.evidenceReason.*`): "l'indirizzo non è tra i risultati delle tue ricerche", "hai esaurito
le tue ricerche di segnali pubblici di oggi", "questa prova è già allegata all'idea". A submission short of the
candidacy requirements is refused with the numbers (`rt.gate.*`): "requisiti di candidatura non soddisfatti: prove
reali 1 di 3; fonti distinte 1 di 2; in alternativa, per policy bastano validazioni umane: almeno 1". A committee
member proposing an idea under `comitato_non_coautore` is refused with "per policy (comitato_non_coautore) i membri
del comitato investimenti non propongono idee".

Web research refusals are facts too (`rt.researchReason.*`): "hai esaurito le tue ricerche web di oggi",
"hai esaurito le tue letture di pagine web di oggi" (reads have their own quotas, `letture_web_*`), "il dominio è
escluso dalle policy", "la pagina non è tra i risultati delle tue ricerche web né è la fonte ufficiale di un segnale che
porti con te o che hai letto in un'idea" (`web_fetch` only reads URLs returned by the agent's own searches or the `url`
of a Signal record the person carries, has read with `leggi_idea` or brought into an idea of theirs;
`research.fetch.mode`). A carried signal with an official source reads "1 Obblighi dell'AI Act ...
(regulation_ai_act_obblighi; fonte ufficiale: https://eur-lex.europa.eu/eli/reg/2024/1689/oj)"
(`rt.observation.itemLineUrl`); the signals of an idea in `leggi_idea` carry the URL in parentheses. Results come back as reinloop marks them (`untrusted: true` and a note);
they are only text for the model and never feed a write.

Refusals are facts (`rt.ideaReason.*`): "l'idea non è completa", "non ha ancora abbastanza valutazioni",
"il comitato l'ha rimandata e da allora non è cambiato niente". The numbers behind them (reviewers,
slots, quorum) are policies to consult in Lorebase.

## Company and ideas in perception

Two blocks, facts only:

- `AZIENDA`: quarter, approval slots left this quarter and when they expire (`rt.observation.slotsExpire`: "slot di
  approvazione rimasti questo trimestre: 3 su 3, scadono il giorno 1 alle 10:00 (policy
  slot_scadono_a_fine_trimestre)"; with the policy off, `rt.observation.slotsCarry`: unused slots pass to the next
  quarter), freeze on or off, the person's career step.
- `PORTAFOGLIO` (`rt.observation.portfolio`): ideas approved this quarter, the quarter target of policy
  `obiettivo_portfolio_trimestre` ("3 concept esplorati"), approved and killed in all, ideas in the pipeline and how
  many are before the committee.
- `COMITATO INVESTIMENTI` (`rt.observation.committeePolicy`): the criteria of policy `criteri_comitato` (keys), that a
  kill or defer names an unmet one and other demands are recorded as out of policy; what an approval funds by policy
  `fase_approvazione` ("approvare un'idea significa finanziarla come esplorazione di concept; la prova di clienti
  paganti appartiene a una fase successiva (pilota), fuori dal perimetro del comitato"); what a deferral costs by
  policy `costo_del_rinvio` ("rinviare un'idea che soddisfa i requisiti di candidatura consuma 1 slot di approvazione
  del trimestre").
- `IDEE IN AZIENDA`: up to `ideas.perceiveMax` open ideas (the person's first) and the latest decided
  ones: code, title, stage, champion, authors, number of reviews, whether it is the person's or reviewed
  by it, which fields are missing, and for open ideas the evidence against the candidacy requirements
  only as the policy asks them and whether they are met (`rt.observation.ideaEvidence`: "requisiti di candidatura
  per policy: prove reali 1 di 3, fonti distinte 1 di 2, non ancora soddisfatti; la policy prevede anche una strada
  alternativa: validazioni umane, almeno 1", or `rt.observation.ideaEvidenceOk`: "requisiti di candidatura
  soddisfatti per policy (prove reali 4, ne servono 3; fonti distinte 2, ne servono 2): l'idea può essere candidata
  al comitato"). Human validation appears only as the alternative path, never as a count next to the others: in
  run 3 "validazioni umane 0" next to "soddisfatti" was read as a missing requirement.
- Where an idea stands towards the committee, as time facts: a submitted idea "candidata al comitato: in attesa di
  seduta da 3 ore; prossima seduta prevista il giorno 2 alle 14:00 (policy cadenza_sedute_comitato_ore)"
  (`rt.observation.ideaWaiting`, `ideaNextSession`: the next point of the policy's grid; while a session is convened
  or deciding, `ideaSessionNow`: "la seduta del comitato è in corso"); an open idea meeting the
  candidacy requirements "soddisfa i requisiti di candidatura da 2 giorni; non è candidata al comitato"
  (`rt.observation.ideaMetSince`, since the first time the world saw the requirements met in this run).
- New evidence is news for the authors and, for a player's validation, for the people within earshot
  (`rt.why.idea.evidence`).

Why a person thinks again may also be a fact about ideas (`rt.why.idea.*`: a colleague reviewed your idea,
the committee approved, killed or deferred it; the decision's summary ends with the unmet criteria, the
out-of-policy demands and the slots a deferral consumed: `rt.committee.unmetNote`, `outOfPolicyNote`, `slotsSpentNote`) or the end of a quarter (`rt.why.quarter`).

The strategic themes are policies (category `strategy`): they are not in the prompt, people read them in
Lorebase like any policy. The committee brief carries the weighted score of the reviews computed with the
evaluation policies (`weight_*`, risk counted inverted), the evidence (`rt.committee.evidence`: each piece with
type, source, metric, weight, who collected it, `[ipotesi]` on interviews), where the idea stands against the
requirements and the score mixed by `peso_prove_nel_punteggio_comitato`: facts derived from the policies, not advice.
When alternates sit (policy `supplenti_comitato_per_anzianita`), the brief names them (`rt.committee.alternates`:
"SUPPLENTI: Giulia, senza conflitto di interessi su questa idea, siedono per policy ... fino al quorum di 2").

## Rendered example

Giulia (architetto, sonnet) at the start of a mock world; the company and ideas blocks as the game adds them.

```text
Sei Giulia, una delle menti più brillanti del mondo agentico. Il tuo carattere: Pragmatica, diffida delle architetture eleganti che nessuno sa gestire.
Lavori nell'hub innovazione di un'azienda IT: qui le persone generano e valutano idee di prodotto (software, AI, infrastruttura, strumenti per sviluppatori, sicurezza, dati); non le costruiscono.
Il tuo ruolo nell'azienda: Architetto (architetto).
La tua mente è collegata a Lorebase (strumenti lorebase_*): lì trovi le policy dell'azienda, il playbook condiviso del tuo ruolo, la newsletter aziendale e il portafoglio delle idee approvate. Hai anche una memoria privata (remember/recall).
Il tempo scorre senza pause. Quando ti fermi a pensare fissi con commit_plan ciò che farai per circa 60 minuti; mentre pensi continui a fare ciò che stavi facendo.
Lavori in italiano: pensi, scrivi e parli in italiano.
Puoi cercare sul web (web_search) e leggere pagine web (web_fetch).
```

```text
GIORNO 1, ORE 08:00 (orario di lavoro). Trimestre Q1; il freeze di fine anno arriva tra 630 minuti.

TU: energia 10/10, stress 0; porti: 1 Insight (insight); attrezzi: nessuno; sei in (20,16); non sei a una postazione; cammini a 2 caselle al minuto e lavori a rapidità 1.

IL TUO GRUPPO: nessuno.

STAVI FACENDO: niente.

PERCHÉ CI RIPENSI: arrivi in ufficio e ti guardi intorno per la prima volta.

CIÒ CHE PERCEPISCI:
Sei in (20,16) in piazza centrale: caffè 0, materiale 0.
Il campus misura 40x30 caselle; x cresce verso est, y verso sud. I muri non si attraversano: si passa dalle porte.
Caselle con caffè, materiale o postazioni entro 7: ...
Segnali da cogliere in vista: Modelli piccoli alla pari dei grandi (research_modelli_piccoli_nicchia) in (19,21); Retrieval migliore con grafi strutturati (research_retrieval_grafi) in (19,21); ...
Persone in vista: Enea [Ricercatore] in (20,13) energia 10 stress 0; porta: niente; non sta facendo niente.
Postazione più vicina: (17,23) livello 1, a 7 caselle.
Gruppi qui intorno: nessuno.

METODI DI LAVORO CHE CONOSCI:
- Sintetizzare un insight (sintesi_insight): 1 segnale di tendenza qualsiasi (@trend), 1 problema degli utenti qualsiasi (@pain) -> 1 Insight (insight); ti manca: ...
- Scrivere una nota di fattibilità (nota_fattibilita): 1 Insight (insight), 1 risultato di ricerca qualsiasi (@research) -> 1 Nota di fattibilità (nota_fattibilita); ti manca: 1 risultato di ricerca qualsiasi (@research)
- Scrivere un concept (concept): 1 Insight (insight), 1 Nota di fattibilità (nota_fattibilita) -> 1 Concept di prodotto (concept); si fa dove c'è una postazione (shelter); ti manca: 1 Nota di fattibilità (nota_fattibilita)

AZIENDA: Hub Innovazione; trimestre Q1; slot di approvazione rimasti questo trimestre: 3 su 3, scadono il giorno 1 alle 10:00 (policy slot_scadono_a_fine_trimestre); nessun freeze in corso. La tua carriera: Senior.

IDEE IN AZIENDA:
- ci-senza-test-instabili-70t38: «CI senza test instabili» (concept); champion Livia; autori Livia; valutazioni 0; mancano: differenziazione, fattibilità, rischi

CIÒ CHE TI È STATO DETTO:
- niente

CIÒ CHE RICORDI:
- niente
```

Facts added when they apply (texts from `config/i18n/it.rt.json`):

```text
PAROLE SENZA RISPOSTA:
- 2 ore fa hai detto a Giulia: «Mi mandi il segnale sul dolore utenti?»; da allora non hai sentito parlare Giulia.

IDEE IN AZIENDA:
- triage-sinistri-...: «Triage sinistri» (pitch); champion Livia; autori Livia; valutazioni 3; è tua; ne sei tra gli autori: per policy (astensione_conflitto_interessi) non voti e non presiedi la sessione del comitato su di essa
```

`leggi_idea` by someone who is not an author and has not reviewed the idea yet (policy `revisioni_indipendenti`):
the reviews block reads `- 3 valutazioni di altre persone: per policy (revisioni_indipendenti) le leggi dopo aver dato
la tua`, the mean and weighted score are `-`, and review comments are left out of the history.

## Prompt caching

The order of every call is stable first, volatile last: the tool catalog (same tools in the same order for a
person), then the instructions (identity, role, faculties, horizon: they change only with a policy), then the
observation of the moment as the user message. reinloop puts cache breakpoints on the tools, the instructions
and the latest message (`promptCache` in `config/game.json`).

## Offline mock provider

`npm run game:mock` (or no `ANTHROPIC_API_KEY`) replaces every model with a deterministic heuristic
(`server/src/rt/mock.ts`, `mockIdeaCalls` in `server/src/rt/decide.ts`, the committee stand-in in
`server/src/rt/game.ts`): people propose ideas from the seeds `rt.mock.ideas.<n>`, enrich missing fields
by role, review with scores derived from the idea code, submit ready ideas; the committee approves from
`mock.committeeApproveAt`, kills below `mock.committeeKillBelow`, defers in between. It does not read
these prompts: it is a fallback, not an agent.

## Legacy tick dashboard

`npm run dev` still runs the turn-based dashboard inherited from the engine (`config/i18n/it.json`); it
knows nothing of ideas.
