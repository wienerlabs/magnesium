# Mythos-class Harness Reference (Claude Fable 5)

> Why this lives in the Magnesium repo: Magnesium's mission is scaffolding that makes
> Opus 4.8 approximate a Mythos-class autonomous system. The Claude Fable 5 consumer
> harness is a worked example of that tier's two layers: a rich, tightly-typed **tool
> action surface** and an always-on **behavioral / supervisory scaffold**. This file
> distills its tool schemas and patterns as design input for Magnesium's orchestrator,
> worker, verifier, and supervisor. Reference only, not executable. Schemas are given as
> compact signatures, not verbatim copies.

## 1. Tool action surface

The defining discipline: every tool carries a tight schema, an explicit "when to use",
an explicit "when NOT to use", and often a gating rule. That contract, not the tool
count, is what raises completion rates. Magnesium should hold its worker-facing tools to
the same contract.

| Tool | Purpose | Schema (compact) | Gating / when-to-use |
|---|---|---|---|
| `ask_user_input_v0` | Elicitation via tappable options | `{ questions: [{ question, options: string[2..4], type?: single_select\|multi_select\|rank_priorities }] (1..3) }` | For gathering preferences/constraints, NOT for "A or B?" opinion asks. One question ideal, three max. After calling, the turn ends. |
| `message_compose_v1` | Draft email/Slack/text, strategy-diverse | `{ kind: email\|textMessage\|other, summary_title?, variants: [{ label (2-4 word goal), body, subject? }] (>=1) }` | Multiple variants only when high-stakes / competing goals; variants differ by strategy not just tone. Single draft when transactional. |
| `image_search` | Inline visual augmentation | `{ query: string (3-6 words), max_results?: 3..5 }` | Use when visuals aid understanding; skip for code/text/data. Interleave inline next to the text they illustrate; never end on an image. Safety blocklist (gore, IP, celebrities, etc.). |
| `web_search` | Web search engine (top 10) | `{ query: string (1-6 words) }` | Scale call count to complexity (1 fact / 3-5 medium / 5-10 research). Search for current state, unknown entities, post-cutoff. Copyright hard limits apply to results. |
| `web_fetch` | Fetch a known URL | `{ url, allowed_domains?, blocked_domains?, html_extraction_method, text_content_token_limit?, ... }` | Only EXACT URLs from the user or prior results. Use to read full pages after a search snippet. |
| `search_mcp_registry` | Discover connectors | `{ keywords: string[] }` | First step when a connector might help, named or intent-based. Returns ranked UUIDs. |
| `suggest_connectors` | Present connector choices | `{ uuids: string[] }` | OPT-IN GATE. Third-party app tools go through suggest before any call, even when connected, even under time pressure. Never pick a partner the user did not name. |
| `present_files` | Surface deliverables to the user | `{ filepaths: string[] }` | After producing a file; first path = most relevant. Share files not folders; no postamble. |
| `create_file` | New file | `{ description, path, file_text }` | Computer-use primitive. Final outputs to the outputs dir; scratch elsewhere. |
| `str_replace` | Edit unique string in a file | `{ description, path, old_str (unique), new_str }` | Re-view before editing; old_str must match raw content exactly and once. |
| `view` | Read file / dir / image | `{ description, path, view_range? }` | Read before editing or asserting file state. |
| `bash_tool` | Run a shell command | `{ command, description }` | Code/bash tasks in the Linux container; verify tool availability first. |
| `places_search` | Find places (multi-query) | `{ queries: [{ query, max_results?: 1..10 }], location_bias_*? }` | Decompose broad asks into several queries; dedup across queries. |
| `places_map_display_v0` | Render markers or itinerary | `{ locations[] }` OR `{ days: [{ day_number, locations[], ... }], travel_mode?, show_route? }` | Always fetch place_id from places_search first; copy verbatim. |
| `recipe_display_v0` | Interactive scalable recipe | `{ title, ingredients[], steps[], base_servings? }` | Steps reference ingredient ids `{0001}`; add timers for wait steps. |
| `weather_fetch` | Weather card | `{ latitude, longitude, location_name }` | Units by home location (F for US). Skip for climate/history small talk. |
| `fetch_sports_data` | Scores / standings / box scores | `{ data_type: scores\|standings\|game_stats, league, team?, game_id? }` | Prefer over web search for scores; fetch scores then stats then answer. |
| `recommend_claude_apps` | Suggest Claude apps/extensions | `{ app_ids: [...] }` | When the task suits a different surface (Claude Code, Cowork, Excel, etc.). |

Two of these are the load-bearing patterns for Magnesium: `ask_user_input_v0` (structured
elicitation instead of prose questions) and `search_mcp_registry` + `suggest_connectors`
(discover then gate). Both are schema-validated and turn-ending, and both refuse to make a
high-agency choice on the user's behalf.

## 2. Behavioral / supervisory scaffold (the always-on critic)

Fable 5 is, in effect, a giant always-on critic wrapped around the model. Magnesium
externalizes that same function into a verification gate plus a supervisor. The notable
rules, framed as policies a Magnesium "policy critic" could enforce:

- Child safety (overriding, takes precedence over every other rule): never produce
  romantic or sexual content involving or directed at a minor, nor content that
  facilitates grooming, secrecy between an adult and a child, or isolating a minor from
  trusted adults; if a result only seems acceptable after reframing the request, refuse;
  protective content stays at the pattern level, never a usable script.
- Refusal handling: no weapon/explosive/illicit-drug-synthesis detail; no malicious code
  even "for education"; no real-public-figure persuasive content; say less when a thread
  feels risky.
- Wellbeing: never diagnose; never name self-harm methods even to advise removal; no
  pain/shock self-harm "substitutes"; eating-disorder resource is the National Alliance
  for Eating Disorders, not NEDA (disconnected); no precise diet numbers if disordered
  eating is signalled; do not foster reliance or solicit another turn.
- Evenhandedness: present the best case its defenders would make (framed as theirs), then
  opposing perspectives; decline only very extreme positions; decline forced yes/no on
  contested topics and give a nuanced answer instead.
- Copyright hard limits: under 15 words per quote, ONE quote per source, default to
  paraphrase, never reproduce lyrics/poems/haikus or article paragraphs, never mirror an
  article's structure.
- Search heuristics: scale tool calls to complexity; the unrecognized-entity rule (an
  unfamiliar capitalized name is probably post-cutoff: search, do not confabulate);
  search current-status questions (positions, policies) even when "stable".
- Tone/formatting: minimal formatting; prose by default; lists only when multifaceted;
  never bullets when declining; one question per turn at most.

## 3. Artifact + recursion layer

- Artifacts: files placed in the outputs dir with `.md/.html/.jsx/.mermaid/.svg/.pdf`
  render in-client. Single-file; Tailwind core classes only; NO browser storage
  (`localStorage`/`sessionStorage` fail) -- use in-memory state.
- Persistent storage: `window.storage.get/set/delete/list(key, shared?)`, hierarchical
  keys `table:id`, 5MB/key, last-write-wins, explicit `shared` flag. The durable,
  cross-session state primitive.
- Claudeception (AI-in-artifacts): an artifact can `fetch("https://api.anthropic.com/v1/messages")`
  (no API key passed; model id supplied; `web_search_20250305` tool available; structured
  JSON by prompting for JSON-only). Recursion: a model output that itself calls the model.
- Skills: before producing any file or running code, read the relevant `SKILL.md`. Skills
  encode environment-specific constraints that are not in training data. Several may apply.

## 4. Mapping to Magnesium

| Fable 5 pattern | Magnesium module | Adoption idea |
|---|---|---|
| Per-tool "when to use / when NOT / gating" contract | worker tool allowlist, `models/schemas.ts` | Hold every worker-facing tool and every orchestrator structured call to the same three-part contract; it is the agent-harness-construction lever for completion rate. |
| `ask_user_input_v0` structured elicitation | `ControlSurface`, Telegram surface (Phase 2) | The Telegram surface already emits structured commands; add tappable-option elicitation as a typed, turn-ending action instead of free prose. |
| `suggest_connectors` discover-then-gate, never auto-pick | `ConfirmationGate`, AIP dispatch | Irreversible/external actions go through human choice. The "named vs not-named" rule is a clean confirmation policy: a worker may use a connector the run named, never one it picked itself. |
| Skills: read `SKILL.md` first | worker prompt (`claude-invocation.ts`) | Ship a `skills/` dir of task playbooks; the worker reads the relevant one before acting. Workers are Claude Code, which already resolves skills. |
| Persistent storage + durable state | `LedgerRepository` | The ledger IS the server-side `window.storage`. Keep the same discipline: hierarchical keys, last-write-wins, explicit scope. |
| Claudeception recursion | orchestrator -> worker -> sub-model | The orchestrator-to-worker fan-out is the same recursion as AI-in-artifact; bound depth and cost explicitly (Magnesium already does via the budget cap). |
| Always-on behavioral critic | verification gate, supervisor | Add a "policy critic" verifier dimension that scores worker output against the distilled rules above, alongside the test verifier. |
| Scale tool calls to complexity | router triage (`route.ts`) | The router can set per-task tool-budget and `maxAttempts` from estimated complexity, mirroring "1 fact / 3-5 medium / 5-10 research". |
| Evenhandedness / opposing views | adversarial verify | Magnesium's multi-skeptic verify already embodies "present the case, then refute it"; keep diverse-lens verifiers. |

## 5. Prioritized recommendations for Magnesium

1. Adopt the three-part tool contract (when-to-use / when-NOT / gating) for every
   worker-facing tool and every orchestrator structured call. Highest leverage, lowest cost.
2. Extend the Phase 2 `ControlSurface` with an `ask_user_input`-style typed elicitation
   action (tappable, schema-validated, turn-ending). Reuses Telegram wiring.
3. Add a policy-critic dimension to the verification gate that enforces the section 2
   rules as acceptance criteria on worker output.
4. Have the router scale each task's tool-budget and retry cap to estimated complexity.
5. Skills-first workers: a `skills/` playbook dir the worker consults before acting.
6. Treat the ledger as the durable-state primitive with `window.storage`-grade discipline,
   and keep recursion depth + cost explicitly bounded (budget cap already does this).
