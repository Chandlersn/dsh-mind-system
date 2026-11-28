[简体中文](README.md) | **English**

# dsh-memory-manager

A **DeepSeek Harness (DSH) plugin** adapted from
[lantern's memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org):
long-term memory that is **built around function areas and shared across sessions and projects**.

The plugin keeps an iteration history for each function area, such as login, build or deployment. Procedures belong in host skill bundles, transferable principles in `insights/`, and summaries in the index.

- eighteen memory tools + an injected system-prompt discipline + a budgeted `agent/pre-step` recall hook + a Web panel
- `memory_write` requires a block `summary`. Supply `currentState` to update the file head. Use `memory_index` separately once the area stabilizes.
- Mechanical lint rules (R0–R28 plus temperature analysis; rule numbers grow, so no fixed count is claimed), so rot gets detected instead of remembered
- **Capability ledger**: every EXTERNAL CLI / MCP / local tool you used is filed in `capabilities/` — look before
  you rediscover it (harness built-ins and the project's own scripts/APIs are NOT capabilities)
- **Skills** live under `<dshHome>/skills/<kebab-name>/SKILL.md` by default. `agent_created: true` marks an owned bundle. Usage records nominate procedures. The plugin can write candidates with global or project scope. Existing active skills can enter recall and the optional host catalog. Candidate activation awaits independent execution evidence for the specific version and task.
- **Granularity gate**: iteration blocks hold distilled conclusions only; a block over 900 chars or an index
  row over 110 chars warns at write time and is named by lint rule R14
- The shared Markdown writer redacts recognized credential patterns. Direct daily edits have separate provenance and redaction properties. R21 can flag sensitive content on disk.
- Insight headers summarize declared positives and corrections. R22 flags a shaken insight for review. These counts cannot validate a principle.
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
├── dao/<name>.md          # formal propositions
├── dao/_candidates/       # candidates outside recall
├── YYYY-MM-DD.md          # raw daily material
├── daily/YYYY-MM.md       # existing monthly archives
└── legacy/                # prototype-era logs (must carry a "historical form" header)
```

Rule of thumb: an operation I will **re-run** → `functions/`; a principle I will **re-apply** → `insights/`;
a procedure I will **follow step by step again** → the host skill store.
Detail always stays in the function file; `MEMORY.md` carries only consensus, environment constants and
one-line summaries.

## Data flow: one direction, five layers — each layer consumes only the layer above

The core is not "one file per function" but **raw material first, refinement after** — data flows one
way, and every layer is grounded in the one above it:

```
Layer 0 · YYYY-MM-DD.md (editable daily material)
        │ select topic-related days and explain the selection (memory_write)
Layer 1 · functions/<area>.md iteration blocks: motivation / what changed / evidence / open questions (one line each)
        │ further distilled (memory_insight)
Layer 2 · insights/<theme>.md: re-appliable principles (backlinked to their source areas, gated on cross-domain + non-procedure)
        │ integrated for display (memory_index, once an area stabilizes)
Layer 3 · MEMORY.md index + panel overview: one-line summaries + counts — a derived retrieval surface
        │ crystallized into a procedure (memory_skill, once an operation is re-run and confirmed)
Layer 4 · <skillRoot>/<kebab-name>/SKILL.md (host skill bundle)
```

- `memory_insight` checks the principle and its source areas. A single source receives a specialist warning. Include the applicable scope and a case where the principle fails. Inspect the post-write artifact check for boundary findings.
- **The consensus layer must carry evidence**: the MEMORY.md 「决策共识 / 规范」 section is linted by **R19** —
  an entry over 150 chars, with no memory-file link, or claiming "cross-feature / global" while pointing at a
  single source area, is flagged. A constraint is not an opinion; it must point back at its evidence.

- **Daily capture** defaults off. Keep production capture off while pathname-based cleanup remains unresolved. With literal `captureUserTurns: true`, the pre-step hook queues capture after the downstream decision admits a step. Messages need user role, `source.kind=user`, a nonblank ID and usable text. Conflicting content for the same ID is excluded. Recognized credentials are masked across text blocks before truncation (default 160 code points). Assistant judgments require a separate entry.
- Capture checks the daily file against the ledger, serializes cooperating writers with SQLite and records a persistent pending intent before writing. An unresolved intent blocks later attempts. Cleanup moves the intent to a quarantine pathname, checks identity and removes it by path. Replacement between verification and removal remains possible. The append-only intent log is a prototype. Overview counters cover this plugin instance only. Metadata, hashes and direct daily edits cannot authenticate the source or guarantee delivery.
- Automatic monthly archiving and production usage compaction are paused. Archive timing settings cannot enable the scheduler. Existing monthly archives remain readable and searchable. `memory_write` preserves daily entries even when `resolve` is supplied.
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
- A block over 900 characters or a summary over 110 produces a write warning. R14 checks stored material during lint.
- Beyond 30 KiB, `memory_fold` can compress old blocks into dated summaries while retaining recent blocks. Folded dates still count toward same-day numbering.

## Layer definitions: 道 / 法 / 术 / 器 (philosophy / rules / method / tool)

The memory is layered by **how universal a piece of content is**. Each layer answers ONE question first —
fail to answer it and the content belongs one layer down. That is the whole test:

| Layer | One-line definition | The question | Where it lives |
|---|---|---|---|
| **器 (tool)** | pointers to content and the retrieval surface | is this content, or a pointer to content? | MEMORY.md dual tables + panel |
| **术 (method)** | the full iteration history of how one area does its work | would I re-run this operation? | `functions/<area>.md` |
| **法 (rule)** | a principle lifted out of concrete work | does it still hold in another project/domain? | `insights/<theme>.md` |
| **道 (philosophy)** | a descriptive proposition derived from at least five distinct laws | how do those laws jointly support it, and where does it cease to hold? | `dao/<name>.md` |

### Boundaries: what must NOT be in each layer (counter-examples)

| Layer | Misplaced content looks like | Why it is wrong |
|---|---|---|
| **器** | derivation text written into an index row | the index is a lookup surface; stuffing it doubles maintenance |
| **术** | "every project from now on should…" inside an iteration block | a function area answers how THIS area works; a universal claim cannot be verified here |
| **法** | a principle written as "1. run X; 2. run Y" | if it rewrites into a manual it is not a principle — steps belong to 术 |
| **道** | a project decision presented as a general proposition | keep the decision with its function area and operational constraints in the R19 consensus section |

### Promotion: when content should move

```
daily log (raw layer, record it however you like)
   │ distill selected topic-related days
   ▼
术 · functions/<area>.md          ← memory_write's landing point
   │ lift: the same judgement held in ≥2 unrelated areas
   ▼
法 · insights/<theme>.md          ← memory_insight
   │ derive a proposition from at least five existing laws
   ▼
道 · dao/<name>.md                ← memory_dao
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
| `memory_distill_review` | `list` reports material versions and source ranges. Read the cited passages, then `review` the exact version with a 1–4000 character conclusion. `receipt` retrieves a historical declaration. Only matching versions suppress reminders. Incomplete scans cannot be reviewed. |
| `memory_retention_inventory` | Bounded counts and bytes for the configured memory root and fixed default storage locations. Unknown counts are lower bounds. Runtime SQLite/WAL, system caches and custom storage can fall outside this inventory. |
| `memory_read` | Read index, function, insight, dao, capability, skill or daily material. `live_flow` shows current observations and `graph_evidence` historical checks. `operation` takes a request ID. `object_trace` and paged `adoption_evidence` take an object key. Records report observations and caller declarations. |
| `memory_sag` | Optional SAG passage search across indexed roots, with source paths and lines. `limit` defaults to 3 (max 10). Narrow with `paths` or directory `exclude`. `status` reports roots. Probe a file with `file` plus a distinctive `phrase`. Service failures are explicit. This release labels rendered hits experimental leads. Check each original source and retain its evidence status. |
| `memory_search` | **ranked full-text search** across the whole root: scans bodies, not just one-line summaries, and returns zone/file/line/section/snippet plus each hit's attributed date. Use it when you remember a fragment but not the area or the day; `after`/`before` filter by date range (block tag → file head → filename → mtime, in that order) |
| `memory_capability` | **the capability ledger**: `record` files an EXTERNAL CLI/MCP/local tool you used (invocation, prerequisites, what it solved — one file per tool, updated in place; never the harness's own tools or the project's own scripts); `list` before a task to see what is available; `read` for a tool's full entry |
| `memory_write` | Append a block from three distinct nonempty material days and explain the selection. Top-level daily files take precedence over archived day sections. For one or two days supply `cadenceException` beginning with `用户显式要求`, `当日踩坑因果` or `安全约束`, followed by a colon and a concrete reason. Zero days fail. Relevance is caller-declared. |
| `memory_index` | **the integration layer**: once an area/theme stabilizes, upsert its row into the MEMORY.md index (row summary distilled from the block summaries); pass `group` to land in a `### 索引·<domain>` sub-table when the table has been split |
| `memory_insight` | Write a principle, backlink its source areas, synchronize the insights index and optionally mark an older theme superseded. Check warnings and the disk-based `selfCheck`. |
| `memory_dao` | Candidate and formal writes share gates for ≥5 distinct existing laws, proposition shape, descriptive text, joint derivation, a boundary and a seven-active-entry limit. `candidate` writes under `dao/_candidates/`, `list_candidates` reads proposals. `active` or omitted status can write directly to `dao/`. The index requires a separate update. Direct writes carry no independent human approval. |
| `memory_fold` | past 30KB, fold the oldest iteration blocks into an "early evolution" paragraph (conclusions and every date tag preserved) |
| `memory_rename` | Rename and merge are paused. Valid requests fail before writing with `safe_rename_unavailable`. |
| `memory_delete` | Valid lower-layer deletion fails before archival or removal with `safe_delete_unavailable`. The tool refuses dao deletion. |
| `memory_check` | lint: index size, missing summaries, orphan files, backlinks, date ordering, dangling links, cold memory, head-summary guardrail, env-path liveness, over-long blocks/rows (R14), duplicated rows/sections (R15), correction-rate circuit breaker (R18), consensus entries without evidence / too long / fake cross-domain (R19), skill executability and lifecycle (R20/R20e) |
| `memory_usage` | **usage signals**: `record` logs one correction/confirmation (recalls and reads are logged automatically); `report` aggregates a window and suggests a layer (experiment / specialist / general) — advice only, it never moves files |
| `memory_federation` | **federation mode** (optional): `sync` copies each project's `MEMORY.md` into `sources/` and rebuilds the project index table; `check` lints F1–F5 (index present, links resolve, rows/copies complete, no orphans, absolute paths alive) |
| `memory_skill` | `candidates` nominates areas with ≥6 uses, ≥1 declared positive and <20% corrections. `crystallize` writes a candidate host bundle. `list`, `read` and `retire` are available. Valid `activate` fails with `verified_skill_execution_unavailable` and owned deletion with `safe_delete_unavailable`. |
| `memory_inbox` | List, post, update or delete issue records. Health findings can arrive automatically. Closing a record preserves its history. Deleting an inbox item is irreversible. |

The overview’s `closureEvidence` reports whether recall completion, an active tool or a completed tool appeared in a short activity window. The public query accepts neither a task ID nor a review answer. Task correlation and human review remain unverified. `memory_read(kind=live_flow)` returns live edges and drop counts in this release.

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
*nothing* (no partial recall); config may shorten but never extend it; **recall preview** —
`GET /api/memory-org/recall-preview?q=…` runs the same pipeline and explains each row (name hits / lexical
score / usage signals) with its final score, so recall quality is debuggable instead of guessed at.

Once per batch per session, a failure there never affects the step, and files the user already cited are not
re-injected. The panel's `/search` and `memory_search` share the same ranker.

## Usage signals and self-sorting layers

Usage records live in monthly `.usage/YYYY-MM.jsonl` shards. Legacy `.usage.jsonl` and existing archives remain readable.

| Signal | Source | Meaning |
|---|---|---|
| `recall` | logged by `agent/pre-step` injection | **exposure**, not use: the plugin put it in front of the model |
| `read` | logged when `memory_read` opens a specific file | **engagement**: the model went to look |
| `correction` | caller records a correction | declared negative signal |
| `positive` | caller records a positive | declared positive signal |

**A `recall` counts as exposure, never as a use**: recall is the plugin's own action, and treating it as
"used" would let the plugin prove its own value with its own output. `memory_usage(report)` therefore shows
two columns — **engagement** (reads + verdicts) and **exposure** (the aggregate `exposure` field counts recalls plus reads) — and layer suggestions
plus heat read engagement only. The correction rate's denominator excludes recall too
(`corrections / (reads + corrections)`); otherwise a memory that is injected a lot and corrected occasionally
has its rate diluted to single digits and never trips any check.

`memory_usage(action=report)` aggregates and suggests a layer — the "let the data sort it" idea, deliberately
reduced to **advice, never automatic file moves**:

- **experiment**: entries below the specialist and general thresholds
- **specialist**: ≥3 engagements and at least one confirmation
- **general**: ≥10 engagements, ≥2 confirmations, correction rate under 20%
- correction rate over 40% with ≥3 corrections → rebuild before appending; lint **R18** reports the breaker
- Repeated verdict flips warrant checking which conclusions the notes refer to. Counts cannot establish authorship, adoption or task success.

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

### Loading an updated plugin

Check the running version in the overview. On hosts with loader and registry services, the panel can request a server reload. Otherwise restart DSH. Refresh the page after the updated client bundle is available.

Configure it in the profile's `cordis.yml` when needed. Replace the angle-bracketed placeholders with absolute paths on your machine; omit optional settings you do not use:

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: '<absolute-path-to-memory-root>' # default ~/.dsh/memory
    newFeatureGraceDays: 3                 # cold-memory grace window, in days
    maxIndexBytes: 10240                   # index comfort line
    maxIndexHardBytes: 15360               # index hard cap
    maxFunctionBytes: 30720                # function-file cap
    dshRoot: '<absolute-path-to-DSH-installation>' # usually unnecessary, see below
    federation:                            # optional three-tier federation (single root otherwise)
      root: '<absolute-path-to-federation-root>'
      projects:
        - { key: project-a, root: '<absolute-path-to-project-a-memory>' }
        - { key: project-b, root: '<absolute-path-to-project-b-memory>' }
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

Open 心智管理 in the sidebar. The overview shows six zone counts, health findings, capture and SAG status, running version, storage paths and recall preview.
- **Functions / Insights / Daily**: one row per file, showing the index summary directly (no need to open it
  to know what it is), relative time and size; sort by time or name, filter by name or summary; the daily zone
  groups by month, so it never turns into a wall
- **Dao** shows formal entries and candidates with their sources. Candidate confirm, reject and delete controls and formal deletion reach validation. Valid requests stop before mutation with `safe_delete_unavailable`. Session authorization does not authenticate human decisions.
- **Skills** groups owned and installed host bundles. Open a bundle to inspect its procedure and assets. Activation is disabled, retirement is supported and owned deletion is paused.
- **Hot reload** requires loader/registry support. Acceptance starts a deferred swap. Check the terminal result and running version.
- **Reader**: function files fold per iteration block — only the newest is expanded by default (short files
  open fully) — with a date jump strip and "expand all"; insights and daily files open per section; the index
  page renders the function-module and innovation-insight index tables as **clickable navigation tables** and folds the rest
- **Navigation**: `functions/x.md`, `insights/y.md` and `YYYY-MM-DD.md` links inside a body navigate within
  the panel, without leaving the memory view
- **Search**: global search in the header (350 ms debounce, ≥2 characters) sharing the `memory_search` ranker;
  each hit shows the **highlighted match**, zone tag, line number and section heading, and the **zone filter**
  (all / index / functions / insights / dao / capabilities / skills / daily) re-queries with `zone` so it narrows the current keyword instead
  of replacing it; an empty filtered result says "check the other zones" rather than looking broken;
  `/` focuses the field, `Esc` clears or goes back, `↑`/`↓` move between rows
- Overview changes arrive by SSE with heartbeat freshness and a 30-second polling fallback.
- **Visually host-native**: 14/22 type scale, 36/28px controls, a 32px search field on `--dsw-alias-border-l4`
  + `--dsw-alias-bg-layer-1`, 11/17 tags with `color-mix()` status tones, the `--dsw-focus-ring-*` focus ring,
  body links on `--dsw-alias-link`, and host-style hairline list rows instead of card boxes — you can find the
  same values in `dsh-client-ui-primitives`' CSS

## Panel HTTP API

All panel data comes from the Host route `/api/memory-org/*`. **The memory root is resolved server-side; a
request cannot point anywhere else** (no `?path=`, so neither the panel nor a page request can be aimed at an
arbitrary directory):

| Route | What it does |
|---|---|
| `GET /api/memory-org/overview` | health findings + per-zone file counts (for the sidebar badges) |
| `GET /api/memory-org/check` | health only |
| `GET /api/memory-org/list?zone=functions` | Entries in the requested zone. |
| `GET /api/memory-org/stream` | Emits an overview object on change, heartbeat freshness and snapshot errors. |
| `POST /api/memory-org/{skill-action,inbox-action,axiom-action,dao-action,reload}` | Access is checked through the host connection service. Without it write routes return 501. Action-specific gates still apply. |
| `GET /api/memory-org/file?zone=functions&name=x.md` | read a memory file (omit `zone` to read the index) |
| `GET /api/memory-org/search?q=keyword` | search the whole root |

**The field names the two halves agreed on** (the client reads only these; renaming one would silently blank
the panel, so `api-test.mjs` pins them with contract assertions):

| Response | Fields |
|---|---|
| `overview` | `root`, `initialized`, `failCount`, `warnCount`, `results`, `counts` (including `dao` and `archived`), `usage`, `capture`, `sag`, `env` (including the resolved skill root and latest reload result) |
| `list` | `files[]{name,bytes,mtime}` |
| `file` | `{name,text}` |
| `search` | `hits[]{zone,name,line,heading,snippet}` (the snippet is `snippet`, not `text`) |
| `skills` | `memory[]` (bundles whose frontmatter says `agent_created`, carrying `status/scope/files[]`) + `host[]` (the installed bundles, same shape) — ONE store, two lenses |
| `recall-preview` | `rows[]{href,zone,summary,fusedScore,reasons[]}` — what the real pipeline would inject for the query |

## Development and tests

Run `npm test` in the package directory. `tests/run-all.mjs` discovers the DSH installation or accepts `DSH_INSTALL_DIR`. It fails when no host is available. The runner includes tool, HTTP, UI and focused regression suites for capture, archive scheduling, distillation and lifecycle gates.

## License

MIT, see [LICENSE](./LICENSE).
