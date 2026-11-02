[简体中文](README.md) | **English**

# dsh-memory-manager

A **DeepSeek Harness (DSH) plugin** adapted from
[lantern's memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org):
long-term memory that is **built around function areas and shared across sessions and projects**.

The one-line difference: it is not "notes per project" but an **iteration history per function area**
(login, build, deploy, UI panel, …). Whatever you will **re-run** settles into `functions/`, whatever you
will **re-apply** is distilled into `insights/`, whatever is **re-run and verified** crystallizes into a
callable procedure in `skills/`, the index keeps a single line per row, and every session starts with that
discipline injected into its system prompt.

- fourteen memory tools + an injected system-prompt discipline + a budgeted `agent/pre-step` recall hook + a read-only Web panel
- Writing is filing: `summary` and `currentState` are required parameters, so the index row never drifts
- Mechanical lint rules (R0–R25 plus temperature analysis; rule numbers grow, so no fixed count is claimed), so rot gets detected instead of remembered
- **Capability ledger**: every EXTERNAL CLI / MCP / local tool you used is filed in `capabilities/` — look before
  you rediscover it (harness built-ins and the project's own scripts/APIs are NOT capabilities)
- **Skill crystallization**: operations that keep being re-run and confirmed become callable procedures — each one
  a HOST bundle (`~/.dsh/skills/<kebab>/`, the exact directory the host `skill` tool and the panel library read;
  no memory-root copy). Mechanical nomination from usage signals; the model decides to crystallize; candidate →
  active → retired, and only active skills enter recall. Writing the procedure MUST follow the skill-creator flow
  (Step1-6 + Quality Bar). Each bundle carries `scope` (global/project) and `agent_created: true` marks it as
  ours — the panel splits the library on that frontmatter field. An `active` owned bundle is published through an
  optional bridge into the host skill catalog and becomes loadable by the `skill` tool; a host without that
  service degrades silently and the plugin's own recall keeps serving every skill
- **Granularity gate**: iteration blocks hold distilled conclusions only; a block over 900 chars or an index
  row over 110 chars warns at write time and is named by lint rule R14
- **Memory defence (Hindsight-borrowed)**: every plugin write path replaces credential shapes (API keys/tokens/
  private keys/JWTs) with `[REDACTED:kind]` before they reach disk and names them in the receipt; national ID /
  phone numbers are only reported by lint rule R21 — facts are never silently rewritten
- **Insight trust (Hindsight's observations, adapted)**: a principle is a belief that carries proof counts. The
  trust level (待验证 / 已验证 / 稳固 / 动摇) is COMPUTED from the positives and corrections in `.usage.jsonl`,
  written into the file head and refreshed on every distill; a shaken one is marked in recall and lint rule R22
  prompts refining or superseding it — never a silent replace
- **Temporal search (Hindsight's temporal recall)**: `memory_search` gains `after`/`before` date bounds, and every
  hit carries its attributed date (block tag → file head → filename → mtime), so "how was this solved last month"
  is a direct query
- Panel colors and sizes ride on the Host design tokens (`--dsw-alias-*` / `--dsw-radius-*`)

## Memory layout

The root defaults to `~/.dsh/memory/` (override it with the `DSH_HOME` environment variable or the plugin's
`memoryRoot` config):

```
memory/
├── MEMORY.md              # index: function + insight + capability + skill tables (one-line summary per row) + consensus + environment constants
├── functions/<area>.md    # one file per area, append-only iteration blocks (the date is just a tag)
├── insights/<theme>.md    # transferable principles, distilled upward from concrete areas, backlinked to their source
├── capabilities/<tool>.md # capability ledger: how to invoke an EXTERNAL CLI/MCP/local tool, prerequisites, what it solved (the project's own scripts/APIs belong in functions/)
├── skills/<skill>.md      # crystallized procedures: frontmatter router + numbered steps + verification (candidate → active → retired)
├── YYYY-MM-DD.md          # daily log: the raw layer — content & format unconstrained (first-hand task data)
└── legacy/                # prototype-era logs (must carry a "historical form" header)
```

Rule of thumb: an operation I will **re-run** → `functions/`; a principle I will **re-apply** → `insights/`;
a procedure I will **follow step by step again** → `skills/`.
Detail always stays in the function file; `MEMORY.md` carries only consensus, environment constants and
one-line summaries.

## Data flow: one direction, five layers — each layer consumes only the layer above

The core is not "one file per function" but **raw material first, refinement after** — data flows one
way, and every layer is grounded in the one above it:

```
Layer 0 · daily log YYYY-MM-DD.md (raw layer; the plugin imposes no format)
        first-hand task/conversation data: decisions, dialogue, dead ends, fragments — recorded freely by the model/harness
        │归纳 distilled (memory_write)
Layer 1 · functions/<area>.md iteration blocks: motivation / what changed / evidence / open questions (one line each)
        │ further distilled (memory_insight)
Layer 2 · insights/<theme>.md: re-appliable principles (backlinked to their source areas, gated on cross-domain + non-procedure)
        │ integrated for display (memory_index, once an area stabilizes)
Layer 3 · MEMORY.md index + panel overview: one-line summaries + counts — a derived retrieval surface
        │ crystallized into a procedure (memory_skill, once an operation is re-run and confirmed)
Layer 4 · skills/<skill>.md: callable procedures — the "use" step closes the flow (only active skills enter recall)
```

- **Principles have a verification gate** (the mechanically checkable half of a "four-gate" model):
  `memory_insight` warns at write time when ① it has fewer than **2 source areas** ("still a specialist
  experience — do not use it as a universal principle"), ② the principle reads like a **procedure**
  (numbered steps / command lines / click here), ③ the principle exceeds **200 chars**. All three are WARN,
  not FAIL: they are judgement inputs for the model, not automatic rejection.
- **The consensus layer must carry evidence**: the MEMORY.md 「决策共识 / 规范」 section is linted by **R19** —
  an entry over 150 chars, with no memory-file link, or claiming "cross-feature / global" while pointing at a
  single source area, is flagged. A constraint is not an opinion; it must point back at its evidence.

- **The daily log is the free raw layer**: the plugin dictates neither content nor form — it is the
  first-hand data of task and conversation, recorded however the model and harness decide. One light
  filter only: **do not copy execution logs** (command output, PIDs, exit codes) — the transcript and
  the log files already hold them; here they only dilute the distillation feed. What is worth recording
  is what the logs do not carry: judgements and trade-offs, the user's own words, the cause-and-effect
  of a pitfall, the next thing to verify. The plugin only reads it back when distilling
  (`memory_read kind=daily`), inducing the function division from it; every function area's
  reason-to-exist traces back to concrete daily entries.
- **Each layer is leaner and more universal than the last**: the daily layer holds process, the function
  layer conclusions, the insight layer universal principles, the index layer the retrieval surface. No
  layer copies the text of another — one fact is true in exactly one place.
- **The index is derived, not synchronized**: `memory_write` no longer auto-writes index rows or daily
  threads; an area is indexed with `memory_index` only once **stabilized** (≥2 iteration blocks, or
  clearly a standalone topic), its row summary distilled from the block summaries.
- **Scale has an escape hatch**: past ~40 function rows the table splits into `### 索引·<domain>` sub-sections
  (「基础设施」「业务功能」…), and `memory_index`'s `group` argument writes into the right sub-table — grouping
  is a migration, so the old flat row is moved rather than duplicated; `memory_check` nags while a big table
  is still flat.
- **Two gates**: a block body over 900 chars or a summary over 110 chars warns at write time, and
  `memory_check` reports **R14** at the same time. The system shrinks, it does not only grow.
- **Compaction**: past 30KB, `memory_fold` folds the oldest iteration blocks into an "early evolution"
  paragraph (one line each: date tag + title + any result other than `done`); folded tags still take part in

## Layer definitions: 道 / 法 / 术 / 器 (philosophy / rules / method / tool)

The memory is layered by **how universal a piece of content is**. Each layer answers ONE question first —
fail to answer it and the content belongs one layer down. That is the whole test:

| Layer | One-line definition | The question | Where it lives |
|---|---|---|---|
| **器 (tool)** | pointers to content and the retrieval surface | is this content, or a pointer to content? | MEMORY.md dual tables + panel |
| **术 (method)** | the full iteration history of how one area does its work | would I re-run this operation? | `functions/<area>.md` |
| **法 (rule)** | a principle lifted out of concrete work | does it still hold in another project/domain? | `insights/<theme>.md` |
| **道 (philosophy)** | a constraint every area must respect | would violating it cause an incident? | MEMORY.md consensus section |

### Boundaries: what must NOT be in each layer (counter-examples)

| Layer | Misplaced content looks like | Why it is wrong |
|---|---|---|
| **器** | derivation text written into an index row | the index is a lookup surface; stuffing it doubles maintenance |
| **术** | "every project from now on should…" inside an iteration block | a function area answers how THIS area works; a universal claim cannot be verified here |
| **法** | a principle written as "1. run X; 2. run Y" | if it rewrites into a manual it is not a principle — steps belong to 术 |
| **道** | a specific technology choice recorded as consensus | consensus is a constraint, not a log; the rationale stays in the area's blocks |

### Promotion: when content should move

```
daily log (raw layer, record it however you like)
   │ distill: the conclusion of one substantive piece of work
   ▼
术 · functions/<area>.md          ← memory_write's landing point
   │ lift: the same judgement held in ≥2 unrelated areas
   ▼
法 · insights/<theme>.md          ← memory_insight's landing point (three gates: cross-domain / not a procedure / ≤200 chars)
   │ converge: violating it causes an incident, with no domain exception
   ▼
道 · MEMORY.md consensus section  ← R19 guards it: evidence required, ≤150 chars, cross-domain claims need ≥2 sources
   │ integrate: indexed once stable (a derivative)
   ▼
器 · MEMORY.md tables + panel     ← memory_index's landing point
```

**Promotion is one-way; demotion happens only when content is overturned** (`supersedes`, or an R18/R19
finding). An overturned principle is never deleted — it keeps a "superseded" stamp where it lies, because it
records *why* we believed it then.

### Three signals that content is one layer off

1. **The context feels wrong when reading it**: a universal claim found inside a function area → promote to 法
2. **You are about to copy it**: wanting the same sentence in two areas → promote to 法
3. **It cannot be applied as-is**: a "principle" that only works with its steps attached → demote to 术
  the same-day numbering (so `补N` never collides), and early conclusions stay traceable in that paragraph.

## Tools

| Tool | What it does |
|---|---|
| `memory_read` | read the index / a function file / an insight file / a capability entry / a skill / a daily log (`kind=index` first, to judge relevance) |
| `memory_search` | **ranked full-text search** across the whole root: scans bodies, not just one-line summaries, and returns zone/file/line/section/snippet plus each hit's attributed date. Use it when you remember a fragment but not the area or the day; `after`/`before` filter by date range (block tag → file head → filename → mtime, in that order) |
| `memory_capability` | **the capability ledger**: `record` files an EXTERNAL CLI/MCP/local tool you used (invocation, prerequisites, what it solved — one file per tool, updated in place; never the harness's own tools or the project's own scripts); `list` before a task to see what is available; `read` for a tool's full entry |
| `memory_write` | **append one iteration block** (a conclusion distilled from the raw daily record) and refresh the head stable-state summary; `summary` is the block's one-line takeaway. **Writes no index row, never touches the daily log** |
| `memory_index` | **the integration layer**: once an area/theme stabilizes, upsert its row into the MEMORY.md index (row summary distilled from the block summaries); pass `group` to land in a `### 索引·<domain>` sub-table when the table has been split |
| `memory_insight` | distil a transferable principle from the function division into `insights/`, backlink its source areas, `supersedes` to replace an older idea; three soft gates at write time (≥2 source areas / not a procedure / ≤200 chars) |
| `memory_dao` | write the **道 layer** (`dao/`) — the most abstract guiding principle. HARD GATE: must be extracted from **>=5 laws**, the proposition must contain no concrete tech/project/file markers and no procedure phrasing, and the layer caps at 7 entries; a rejection states exactly what is missing |
| `memory_fold` | past 30KB, fold the oldest iteration blocks into an "early evolution" paragraph (conclusions and every date tag preserved) |
| `memory_rename` | rename / merge a function area, rewrite every reference and verify zero dangling links |
| `memory_check` | lint: index size, missing summaries, orphan files, backlinks, date ordering, dangling links, cold memory, head-summary guardrail, env-path liveness, over-long blocks/rows (R14), duplicated rows/sections (R15), correction-rate circuit breaker (R18), consensus entries without evidence / too long / fake cross-domain (R19), skill executability and lifecycle (R20/R20e) |
| `memory_usage` | **usage signals**: `record` logs one correction/confirmation (recalls and reads are logged automatically); `report` aggregates a window and suggests a layer (experiment / specialist / general) — advice only, it never moves files |
| `memory_federation` | **federation mode** (optional): `sync` copies each project's `MEMORY.md` into `sources/` and rebuilds the project index table; `check` lints F1–F5 (index present, links resolve, rows/copies complete, no orphans, absolute paths alive) |
| `memory_skill` | **the crystallization layer** (the "use" step the data flow was missing): `candidates` nominates mechanically from usage signals (≥6 uses, ≥1 confirmation, correction rate <20%, not yet crystallized); `crystallize` writes a callable procedure to `skills/<name>.md` (when-to-use / numbered steps / pitfalls / verification + frontmatter router); `activate`/`retire` drive the lifecycle (candidate → active → retired, only active enters recall); `list`/`read` inspect |

A discipline section is injected into the system prompt; the `agent/pre-step` hook scores the user's input
against index rows and injects the matching rows as a single `recall` message. Ranking is **lexical-first,
with usage as a bounded boost**:

- **Lexical (IDF-weighted)**: tokens nearly every row carries (「功能」「记忆」) weigh little, rare tokens
  (「逐帧」「懒加载」) dominate; name/filename hits are doubled; rows under 40% of the best score are dropped
  and one file is injected once.
- **Usage (`.usage.jsonl`)**: heat = real engagements + 2× confirmations, demoted by the correction rate.
  It applies as a **multiplicative boost capped at +15%** — enough to break ties and nudge close calls, but
  it can never overturn a real relevance gap (a 2× lexical win is not reversed by popularity).

> Why not RRF: RRF (`Σ 1/(60+rank)`) suits blending two *peer* retrievers (FTS5 + vectors), at the cost of
> discarding score magnitude and keeping only rank. Here one signal is the user's own words and the other is
> a popularity prior — they are not peers, and rank fusion lets the prior outvote the user. Before 5.29.1 the
> implementation was RRF, and a measured "lexical 4.0 vs 2.0" was flattened into adjacent ranks and reversed
> by heat.
>
> A second fix from the same root: **a `recall` is not a use.** Recall is the plugin's own action; counting it
> as `uses` let the plugin prove its own value with its own output (recalled → hotter → recalled more).
> Measured on a real root: 627 of 667 ledger lines were self-produced recalls, the hottest row was recalled
> 152 times against 8 real engagements, and a genuinely corrected memory had its bad rate diluted to 1%. Now
> `uses` counts **engagement** only (reads + verdicts) and recall is reported separately as **exposure**.

Three more behaviours: **decision repair** — an area corrected repeatedly in the last 7 days (≥2 corrections,
bad rate ≥30%) is forced into the NEXT step's recall even without a lexical hit, marked "read this before
acting"; **3s foreground budget** — the whole attempt has an absolute deadline, and a timeout injects
*nothing* (no partial recall, no added latency); config may shorten but never extend it; **recall preview** —
`GET /api/memory-org/recall-preview?q=…` runs the same pipeline and explains each row (name hits / lexical
score / usage signals) with its final score, so recall quality is debuggable instead of guessed at.

Once per batch per session, a failure there never affects the step, and files the user already cited are not
re-injected. The panel's `/search` and `memory_search` share the same ranker.

## Usage signals and self-sorting layers

"Written" and "actually used" are different signals — the former is the model's job, the latter can only be
recorded. Signals land in `<memory-root>/.usage.jsonl` (a dot-file: no zone listing, search or lint sees it):

| Signal | Source | Meaning |
|---|---|---|
| `recall` | logged by `agent/pre-step` injection | **exposure**, not use: the plugin put it in front of the model |
| `read` | logged when `memory_read` opens a specific file | **engagement**: the model went to look |
| `correction` | model calls `memory_usage(record, kind=correction)` | quality side: the user corrected/rejected it |
| `positive` | model calls `memory_usage(record, kind=positive)` | quality side: explicit confirmation ("that's it") |

**A `recall` counts as exposure, never as a use**: recall is the plugin's own action, and treating it as
"used" would let the plugin prove its own value with its own output. `memory_usage(report)` therefore shows
two columns — **engagement** (reads + verdicts) and **exposure** (recall injections) — and layer suggestions
plus heat read engagement only. The correction rate's denominator excludes recall too
(`corrections / (reads + corrections)`); otherwise a memory that is injected a lot and corrected occasionally
has its rate diluted to single digits and never trips any check.

`memory_usage(action=report)` aggregates and suggests a layer — the "let the data sort it" idea, deliberately
reduced to **advice, never automatic file moves**:

- **experiment**: fewer than 3 engagements
- **specialist**: ≥3 engagements and at least one confirmation
- **general**: ≥10 engagements, ≥2 confirmations, correction rate under 20%
- correction rate over 40% with ≥3 corrections → rebuild before appending; lint **R18** reports the breaker
- **verdict flips**: how often a memory goes back and forth between confirmation and correction.
  Two or more flips means the conclusion itself is unstable (not occasional bad luck) — the report names it:
  "settle which verdict holds, then decide which version to keep". It covers what the correction rate cannot:
  a memory with few corrections but repeated about-faces is still unusable as evidence.

Two deliberate limits: the tool never moves files (layer is human judgement plus data advice, not a script
shuffle), and corrections/confirmations cannot be inferred (only explicit ones count — no guessing at tone).

Low-frequency, high-value memories (security audits, key pitfalls, fallback rules) get hurt by the cold-memory
rule — mark them with `memory_write(guard=true)`, which stamps `🛡 守护型` into the file head and exempts them
from cold judgement: **"rarely written" is not "safe to drop"**.

## Install (as a profile bundle)

Install the package directory from your workspace with `plugin_manager` inside DSH:

```
plugin_manager install_bundle  <absolute path to this directory>
```

On success `plugin_manager` returns `application: applied`, and the panel shows up in the Harness Web UI
sidebar (the memory icon).

### Cache behavior when updating the plugin (measured)

| What changed | How it takes effect |
|---|---|
| `client.js` (the panel) | **a page refresh is enough**: the host derives the bundle rev from mtime/size, recomposes the module graph when it changes and hands the new `?rev=` to the page |
| `server.js` (tools, routes, injection) | **requires a DSH restart**: the module generation cache is keyed by realpath, so editing the file in place is not reloaded |

Only server-side changes need "a new physical directory + a new package name" (simpler: just restart dsh).
When renaming the package, disable the old bundle before enabling the new one so same-named tools are not
registered twice.

Configure it in the profile's `cordis.yml` when needed:

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: C:/Users/you/.dsh/memory   # default ~/.dsh/memory
    newFeatureGraceDays: 3                 # cold-memory grace window, in days
    maxIndexBytes: 10240                   # index comfort line
    maxIndexHardBytes: 15360               # index hard cap
    maxFunctionBytes: 30720                # function-file cap
    dshRoot: D:/dsh                        # usually unnecessary, see below
    federation:                            # optional three-tier federation (single root otherwise)
      root: D:/fed/memory                  # federation layer root
      projects:
        - { key: printpress, root: 'D:/dev/new-tools/.memory' }
        - { key: toolbox,    root: 'D:/rustbuild/.memory' }
```

### Federation mode (three tiers, optional)

One global root gets crowded past a few dozen function areas. With federation enabled the memory splits into
three tiers and **project detail never rises**:

| Tier | Location | Holds |
|---|---|---|
| Project truth source | each project's own memory root | that project's full `MEMORY.md` + `functions/` + `insights/`; detail lives only here |
| Federation layer | `federation.root` | `sources/<key>.MEMORY.md` (index copies) + a project index table + **a model-written cross-project consensus** |
| Global | `~/.dsh/memory` | cross-project consensus and env constants only |

`memory_federation(action=sync)` refreshes the copies and the mechanical project rows (it never touches the
consensus section you wrote); `memory_federation(action=check)` lints F1–F5: index present, links resolve,
project rows and copies complete, no orphan copies, absolute paths still exist. **The tool moves copies only —
cross-project consensus must be distilled by the model**, no fake fusion.

### Where the plugin finds Host packages

A profile-installed bundle is a pnpm link whose realpath points at the workspace source, so **a bare import
can never resolve the Host's `node_modules`**. This plugin uses `createRequire` to require files from the
Host installation directory (ESM + `require(esm)`, Node ≥ 22.12) and gets back the very same namespace the
Host already loaded.

The installation directory is **discovered automatically**, in this order: plugin config `dshRoot` →
environment variable `DSH_INSTALL_DIR` / `DSH_ROOT` → upward from the process CLI entry (`process.argv[1]`)
→ upward from `process.cwd()` → upward from `DSH_PROFILE_DIR` → the tree this file lives in. When none of
them matches, it fails with an explicit message telling you to set `DSH_INSTALL_DIR`.

## Web panel

Opened from the "记忆管理" (memory manager) icon in the sidebar; **read-only**, and built for long
accumulation (dozens of function areas, hundreds of daily threads) rather than as a file browser:

- **Overview**: health chips (FAIL / WARN / cold memory) + five zone count cards (functions / insights /
  capabilities / skills / daily) + an **environment card** (the RUNNING plugin version, whether the host
  supports hot reload, where the memory root and skill store live, an index-size fill meter against the comfort
  and hard lines) + a **recall self-check card** (type a sentence, see exactly which rows the real pipeline
  would inject, with per-row reasons and fused scores; a row opens its file) + a **cross-zone "recent
  changes" timeline** (mtime descending, with each row's index summary) — start by seeing how memory has been
  growing
- **Functions / Insights / Daily**: one row per file, showing the index summary directly (no need to open it
  to know what it is), relative time and size; sort by time or name, filter by name or summary; the daily zone
  groups by month, so it never turns into a wall
- **Skill library**: the skills page is a two-sided library behind ONE toggle — "crystallized / system" — but the
  two sides are ONE store seen through two lenses: every skill is a host bundle (`~/.dsh/skills/<kebab>/`); the
  ones whose frontmatter carries `agent_created: true` are ours (full lifecycle candidate/active/retired + scope,
  with an **enable switch (activate/retire) and a delete button per row**), everything else is installed (like
  skill-creator, read-only). Opening either side renders that skill's stored SKILL.md body plus its **file tree**
  (the `scripts/` and `references/` assets the bundle carries, readable one click away) — the panel shows stored
  content; invocation policy stays the host registry's surface. Panel writes go through the single
  `POST /skill-action` route, which runs the memory_skill tool's real executor (kebab-name guard, atomic write,
  index sync, host invalidation all still apply); crystallize is deliberately NOT panel-reachable (that is a model
  judgement)
- **Hot reload**: the header's 热重启 button (5.25.0) — replaces the running server half with the code on disk,
  no host process restart (the mechanism is borrowed from dsh-our-free-model's src/reload.js: snapshot the fibers,
  purge this package from the module caches, re-import through the host loader, re-register; on failure the caches
  and the old registration are restored and the swap reports it). This plugin dares to do it because it holds no
  long-running state (the memory root is disk, and tools/recall/routes rebuild with apply). A host without
  loader/registry gets an explicit 501, never a half-accepted swap. **Client-half changes still need a page
  refresh** (the swap replaces the client bundle registration)
- **Reader**: function files fold per iteration block — only the newest is expanded by default (short files
  open fully) — with a date jump strip and "expand all"; insights and daily files open per section; the index
  page renders the function-module and innovation-insight index tables as **clickable navigation tables** and folds the rest
- **Navigation**: `functions/x.md`, `insights/y.md` and `YYYY-MM-DD.md` links inside a body navigate within
  the panel, without leaving the memory view
- **Search**: global search in the header (350 ms debounce, ≥2 characters) sharing the `memory_search` ranker;
  each hit shows the **highlighted match**, zone tag, line number and section heading, and the **zone filter**
  (all / index / functions / insights / daily) re-queries with `zone` so it narrows the current keyword instead
  of replacing it; an empty filtered result says "check the other zones" rather than looking broken;
  `/` focuses the field, `Esc` clears or goes back, `↑`/`↓` move between rows
- A silent refresh every 30 seconds; the panel's own `<style>` applies only to the panel root and is removed
  on unmount
- **Visually host-native**: 14/22 type scale, 36/28px controls, a 32px search field on `--dsw-alias-border-l4`
  + `--dsw-alias-bg-layer-1`, 11/17 tags with `color-mix()` status tones, the `--dsw-focus-ring-*` focus ring,
  body links on `--dsw-alias-link`, and host-style hairline list rows instead of card boxes — you can find the
  same values in `dsh-client-ui-primitives`' CSS

## Panel HTTP API (read-only)

All panel data comes from the Host route `/api/memory-org/*`. **The memory root is resolved server-side; a
request cannot point anywhere else** (no `?path=`, so neither the panel nor a page request can be aimed at an
arbitrary directory):

| Route | What it does |
|---|---|
| `GET /api/memory-org/overview` | health findings + per-zone file counts (for the sidebar badges) |
| `GET /api/memory-org/check` | health only |
| `GET /api/memory-org/list?zone=functions\|insights\|daily` | zone file listing (the daily zone lists only `YYYY-MM-DD.md`, newest first) |
| `GET /api/memory-org/file?zone=functions&name=x.md` | read a memory file (omit `zone` to read the index) |
| `GET /api/memory-org/search?q=keyword` | search the whole root |

**The field names the two halves agreed on** (the client reads only these; renaming one would silently blank
the panel, so `api-test.mjs` pins them with contract assertions):

| Response | Fields |
|---|---|
| `overview` (array, single element) | `root`, `initialized`, `failCount`, `warnCount`, **`results`** (findings: `level`/`rule`/`message`; not `problems`), `counts{functions,insights,capabilities,skills,daily}`, `usage{signalCount,layers,hotspots}`, `env{version,canReload,hotReloadRunning,memoryRoot,skillRoot,indexBytes,indexComfortBytes,indexHardBytes}` |
| `list` | `files[]{name,bytes,mtime}` |
| `file` | `{name,text}` |
| `search` | `hits[]{zone,name,line,heading,snippet}` (the snippet is `snippet`, not `text`) |
| `skills` | `memory[]` (bundles whose frontmatter says `agent_created`, carrying `status/scope/files[]`) + `host[]` (the installed bundles, same shape) — ONE store, two lenses |
| `recall-preview` | `rows[]{href,zone,summary,fusedScore,reasons[]}` — what the real pipeline would inject for the query |

## Development and tests

```bash
DSH_INSTALL_DIR=<dsh install dir> npm test   # harness-test.mjs + api-test.mjs + ui-test.mjs
```

- `harness-test.mjs`: captures the tool definitions with a fake ctx and runs the full loop on a temp memory
  root (write / read / insight / fold / rename / check / recall)
- `api-test.mjs`: drives the panel HTTP handlers with stub req/res and asserts against the real global memory root
- `ui-test.mjs`: injects a **minimal React shim** (createElement + static hooks) into the panel, renders the
  six views to markup and asserts (index-table navigation, iteration-block folding, zone summary/sort/filter,
  daily month grouping, internal link resolution); pure parsing logic is tested directly via
  `__internalsForTest`

`DSH_INSTALL_DIR` is needed when the Host installation cannot be discovered (the test process's CLI entry is
not DSH itself, so auto-discovery fails).

## License

MIT, see [LICENSE](./LICENSE).