# CLAUDE.md

Guardrails and context for working on the Furiosa Discord bot. Read this on
every session.

## What this project is

Furiosa is a Node.js (discord.js v14, CommonJS) Discord bot that creates and
manages event categories, map channels, and private team threads from a
per-event config directory. Staff-only, safe to re-run, idempotent by design.

Hosted on a single AWS Lightsail instance (`furiosa-prod`-equivalent, us-east-1,
Ubuntu 24.04, 1GB RAM) as a systemd service. See `deploy/README.md` for the
full setup/redeploy runbook and `deploy/bootstrap.sh` for the idempotent
install/redeploy script — re-running it is the standard way to ship new code.

## Architecture

### Event / round model

Each event is a directory under `src/config/`:

```
src/config/
  bop/                          # single-round event
    config.yml
    thread.md
  beyond-thunderdome/            # multi-round event
    r1-flagship/
      config.yml
      thread.md
    r2-homeland/
      config.yml
      thread.md
```

- **The directory name is the canonical event key.** It's what staff type
  into every command's `event:` option, and it is *verbatim* the name the bot
  gives the event's Discord category — there is no separate display-name
  field, no fallback. Don't reintroduce one without a good reason.
- Multi-round events nest each round in its own subdirectory; single-round
  events keep `config.yml`/`thread.md` directly in the event directory.
- The category + 7 standing channels (`applications`, `event-chat`,
  `looking-for-team`, `registered-teams`, `registration`, `rules`, `zones`)
  belong to the **event** and are shared across all its rounds. Map
  channels/threads belong to a **round** (or to the event directly, if it
  has no rounds). `looking-for-team` (2026-11-16) is open to everyone to post
  in (1-minute slowmode) — it's where players without a team find one before
  using `/register`; `/setup event` creates it on existing events the next
  time it's re-run, and `/teardown event` removes it with the rest.
  `applications` is staff-only (hidden from `@everyone`, visible to
  `EVENT_STAFF_ROLE_ID` and the bot) — it's where Approve/Reject team-ready
  notifications post; see the `/register` entry below. `STANDING_CHANNEL_NAMES`
  is declared alphabetically (2026-07-05) and `/setup event` re-enforces that
  order via `guild.channels.setPositions()` every run — not just creation
  order — so a category whose channels exist in some other order (e.g. from
  before `zones` was added) self-corrects on the next `/setup event`.

### Config vs. runtime state — kept deliberately separate

- `src/config/` is a **pure, git-managed tree** — only `config.yml`/`thread.md`,
  human-authored, committed. Never write generated/runtime data here again;
  we did this once (category/state JSON living inside `src/config/`) and
  reverted it because it broke the "config directory = what's in git"
  invariant.
- All bot-generated runtime state now lives in Postgres (`src/db.js`), not
  local JSON — this replaced the old `data/<event>/*.json` tree (2026-07-05):
  - `event_category_state` — event-level state (`categoryId`,
    `standingChannels`, `maxTeamSize`), written by `/setup event`.
  - `event_round_state` — round-level state (`channels`, `threads`), written
    by `/setup maps`, keyed by `(event_key, round_key)` (`round_key = ''` for
    single-round events).
  - `registrations`, `registration_pending_reviews`, `event_registration_state`
    — player self-registration state, written by `/register`/`/registrations`.
  - `event_zone_definitions` (`zones` JSONB keyed by zone number, plus
    `admin_countries`) and `event_zones_index` (`header_message_id`,
    `zone_messages` — message IDs per zone number) — zone Homeland/AI data
    imported by `/setup zones` and the message IDs `#zones` posts to. See
    the `/setup zones` entry below.
  - All these are covered by the same RDS automated backups as the
    matchmaking tables (see "Known constraints" below) — this was the whole
    point of the move, replacing the old unbacked-up local JSON files.
    `resolveEventCategory`'s name-based fallback (searching Discord by
    category *name* if there's no stored ID) is unchanged and still the
    recovery path for a stale/missing row, same as before.

### Commands

- `/setup event event:<key> [dryrun]` — creates the category + 7 standing
  channels if missing, and re-enforces their alphabetical order. Idempotent.
  Also publishes the rules index and the zones index (both below) as its
  last steps every time it runs.
- `/setup maps event:<key> [round:<key>] [dryrun]` — creates map channels +
  private team threads (the original, longest-standing feature). Requires
  the category to already exist (via `/setup event`) — errors with a clear
  message instead of silently creating one. For zones (see below), a
  `config.yml` zone entry may omit `homeland`/`ai` — if so, they're looked
  up from that event's imported zone data by `zoneNumber`; if neither source
  has them, that zone errors clearly instead of posting an empty "(none)"
  into the private team thread.
  - **DB-driven zones mode, no `config.yml` (2026-07-09)**: if a round has
    **no `config.yml` at all**, `/setup maps` no longer errors — it builds a
    single map channel (`<event>[-<round>]-map01`) with one private thread
    per zone already imported via `/setup zones` (`event_zone_definitions`),
    using that zone's `/draw` assignment (`event_zone_assignments`) for the
    team and that team's *approved* `/registrations` for the roster. Only
    `thread.md` needs to exist as a file — `EVENT_NAME`/`EVENT_KEY` render
    as the event key itself, `EVENT_ROUND` as the `round:` option or `"1"`,
    `TEAM_SIZE` as `maxTeamSize` from `event_category_state` (already set by
    `/setup event`'s `max_team_size`) — no config-file-only field is needed.
    A zone with no `/draw` assignment yet errors clearly in the plan rather
    than being silently skipped. `blood-pact` is the first (and, as of
    2026-07-09, only) event using this path — 30 zones imported, no
    `config.yml`, `src/config/blood-pact/thread.md` only. This is additive:
    any event/round that still has a `config.yml` (`balance-of-power`,
    `bop`, etc.) keeps using the original path unchanged, including its
    multi-map-channel splitting, which this DB-driven path doesn't support
    (always exactly one map channel) — that's a deliberate scope limit, not
    a bug, see the `/draw`-adjacent config.yml-minimization Future plan note.
    `/teardown maps`'s previously-hardcoded `config.yml`-must-exist check
    was also removed — it never actually read the file, so it was
    accidentally blocking teardown of exactly the round state this new path
    creates.
- **Zone import (2026-07-05)**: `/setup zones event:<key> sheet_url:<url>
  [dryrun]` imports a staff Google Sheet's `Country`/`Type`/`Zone` columns
  (matched by header name, any column order/extras ignored; `Type` is
  `Homeland`/`AI`/`admin`; blank `Type`+`Zone` rows are the unassigned
  country pool and are skipped) into `event_zone_definitions`, then
  publishes/updates that event's `#zones` channel: a pinned "🌐 Map
  Division" legend + admin-countries header (wording matches the original
  hand-authored `#map-zones` reference channel, admin countries populated
  dynamically instead of hardcoded), followed by one message per zone
  (`## Zone N` / `### Homeland` / `### AI`, Homeland first) — **not** a
  links-index (an earlier version posted a pinned links-index instead; it
  overflowed Discord's 2000-char limit once a single event has 30+ zones,
  and was dropped in favor of matching the original channel's format).
  Idempotent — re-running edits existing zone messages/header rather than
  duplicating, and a zone present in an old import but missing from a new
  one gets its message edited to note removal rather than deleted (avoids
  a broken link) or silently left stale. **The sheet must be shared "Anyone
  with the link can view"** — the bot fetches it as a plain CSV export, no
  OAuth/service account is set up; this is a real, easy-to-forget
  precondition (a sheet copied from another loses its sharing settings).
  **Keep it to one tab (2026-11-16).** A zones sheet is one tab with just the
  `Country`/`Type`/`Zone` columns, and any link to it works — with no `gid` in
  the link the bot exports the first tab. (It used to default to `gid=0`,
  which returns HTTP 400 for a sheet made by uploading a CSV, since that
  first tab has a random gid.) Only add a `gid` if a sheet ever has several tabs.
  **An active (non-view-only) filter on the sheet also breaks the CSV
  export** — confirmed 2026-07-11: a shared-and-public sheet still returned
  HTTP 400 from Google's `/export?format=csv` endpoint while a regular
  filter was applied to the tab; removing the filter fixed it immediately.
  The bot surfaces this as `Couldn't fetch that sheet (HTTP 400)...` with
  no server-side log line (it's a handled response-status check, not a
  crash) — if that error recurs, check for an active filter before
  assuming it's a sharing-permission problem (that fails with 401, not
  400). A Filter *view* (as opposed to a plain Filter) is unaffected since
  it doesn't change what other viewers/exports see.
  Zone data is intentionally decoupled from *which team* plays *which
  zone* — that "draw" is still a manual step, hand-authored into a round's
  `config.yml` (`zoneNumber` + `team: {...}`, no `homeland`/`ai` needed
  anymore). Implemented and verified end-to-end on `furiosa-test` for both
  `blood-pact` (30 zones, real sheet import) and `balance-of-power` (11
  zones, reverse-engineered from the original `#map-zones` channel — see
  below); code is deployed to prod and `balance-of-power`'s zone data is in
  the prod DB, but **`/setup event` has not yet been run on prod for either
  event** — that's the deliberate "go live" step, left for the user to
  trigger in the real Discord server when ready, not something to run
  proactively.
  - **Known open item**: `balance-of-power`'s Group 3 AI country "Urumqi"
    (a city) has no clean equivalent in the `blood-pact` sheet — closest is
    "Uyghur" (an ethnic/region label, not the same kind of name) — left
    unchanged pending a decision, everything else in that zone data had its
    spelling standardized to match `blood-pact`'s sheet (e.g. "Carribean
    States" → "Caribbean States", "USA" → "United States").
  - **Next planned work (not started)**: an "image import" feature — the
    original `#map-zones` channel also had a map graphic image attachment
    (`Country_Groups_3.png`) that isn't reproduced anywhere yet.
- **Theatres can hold 2+ teams — free-for-all support (2026-11-16)**: a
  theatre with exactly 2 teams is a duel (original behaviour, e.g.
  `beyond-thunderdome`); 3 or more is a free-for-all (battle royale) in that
  theatre. `validateConfig` only requires `>= 2` teams per theatre now, and
  rejects two teams in one theatre sharing a `countryPool` (they would be
  handed the same countries). `/setup maps` needed no other
  change — it already loops `theatre.teams`. First user is **`water-wars`**
  (the Capture the Flagship event, 16 teams of 5, 3 rounds, 4 maps): each
  ocean is a 4-team free-for-all and the last 2 flagships per ocean advance;
  the final is one map, one theatre, whole ocean, last flagship wins.
  **Rounds `r1-map1`, `r1-map2` and `r2` have no `config.yml`, only a
  `thread.md`**, so `/setup maps` uses the DB-driven zones path (one map
  channel per round key): the 8 zones and their homeland countries come from
  the zones sheet (`/setup zones`, 5 countries each, zones 1-4 Pacific and 5-8
  Indo-Atlantic, port-drafted as in `flagship-8team`), teams come from approved
  `/registrations`, and who plays which zone comes from the draw sheet
  (`/setup draw`, below). Round 1 is two map channels because the DB path makes
  exactly one per round key. **Channel naming (2026-11-16)**: a round key like
  `r1-map2` means "map 2 of round r1" and gives `<event>-r1-map02` (not
  `<event>-r1-map2-map01`); any other key keeps `<event>-<round>-map01` (`r2` gives
  `water-wars-r2-map01`). Channels made under the old name must be torn down with
  `/teardown maps` before re-running `/setup maps`, or both sets will exist.
  `r3-final` still has a hand-authored `config.yml`
  (one 4-team theatre, no ocean split) and its pools are empty on purpose:
  **which countries each finalist plays is not decided**. **While testing, all
  22 non-pool, non-admin countries are AI and non-conquerable**, so the zones
  sheet has no AI rows (12 were listed as conquerable AI in earlier drafts, and
  the 10 Sub-Saharan countries were never listed). The free-for-all end
  condition, tie-breaker and diplomacy rule were still open with staff on
  2026-11-16, so `thread.md` says only that the rules are being finalised.
  `flagship-4team` and `flagship-8team` are the earlier duel templates and are
  left as they were.
- **`/setup draw event:<key> sheet_url:<url> [dryrun]` (2026-11-16)** — the
  draw is compiled in a Google Sheet **during the live draw event** and
  imported here; it **replaces `/draw`**. One tab, columns `Round`, `Team`,
  `Zone` (header names, any case; `Round` optional, blank for an event without
  rounds): `Round` is a round folder name such as `r1-map1`, `Team` is a
  registered team name, `Zone` a zone number from the zones sheet. A row with a
  blank `Team` is an unfilled slot and is skipped, so a half-filled sheet can be
  imported at any point and re-imported as it fills up. Everything is checked
  before anything is written (team approved, zone imported, round folder
  exists, no zone or team used twice in a round) and any error means nothing is
  changed. It only adds or changes assignments, never deletes: a team or zone
  that is in the DB but not in the sheet is left alone and reported. A changed
  row is flagged ⚠️ in the plan (`replaces <team>` / `moves from Zone N`).
  Writes via `db.setZoneAssignment`, the same store `/draw` used, so
  `/setup maps` reads it unchanged. **Verified with mocked unit tests only
  (new draw, re-run, swap, blank sheet, six error cases); not yet run against
  the real bot and Discord.**
- **Per-event rules, `src/config/<event>/rules.md` (2026-11-16, part of
  `/setup event`)**: event-specific rules live in git next to the event's
  config and are posted into that event's `#rules` after the definitions index.
  A line with only `<!-- split -->` starts a new Discord message, and a section
  over Discord's 2000-char limit is split further on blank lines (then on
  lines). Message IDs are stored in the new `event_rules_index.event_rules_message_ids`
  column (added by `ADD COLUMN IF NOT EXISTS` in `initSchema`, which runs on
  **both** the prod and test databases at startup), so a re-run edits messages in
  place only when their text changed, and drops trailing messages if the file
  got shorter. An event with no `rules.md` is skipped; a failure here doesn't
  block the zones index. `water-wars/rules.md` has five sections, **in this order (set by staff,
  2026-11-16): Format, Win Condition, Prizes, Schedule, Rules**, and is posted
  as five messages. Format: 16 teams of 5, round 1 = 2 maps of 8 teams, round 2
  = 1 map of 8, final = 1 map of 4 across the whole ocean, 4 teams per ocean on
  the round 1/2 maps. Win Condition: Capture the Flagship, last 2 flagships per
  ocean advance, early finish at 2, and an explicit **Tiebreaker** (surviving
  teams ranked by enemy ships sunk, weighted by ship class). Prizes: gold and SC
  only (officers can't be a prize). Schedule: Registration, Draw, Map start
  (truce, opens on a Sunday, 6 days), War start (the following Saturday, 8
  hours). **Rules is deliberately one short bullet list of the event's own rules,
  not a copy of content held elsewhere**: it links the definitions and sanctions
  page and only says which of the 14 terms are enforced (all event: Conspiracy,
  Espionage, Gold usage, Market blocking, Restricted unit usage; truce only: Act
  of war, Failing to make peace, Unjustified engagement, Flyover, Nation's
  territory, Territorial waters), with no sanction amounts. Win conditions are
  event-specific and are deliberately not on the global definitions page
  (2026-11-26). That enforcement was inferred from the definitions page and
  staff discussion, not confirmed. **Still open (kept out of the player-facing
  channel on purpose):** prize amounts and who is paid; registration, draw and
  war dates and the start time; the tiebreaker's ship-class weights and how
  kills are counted and checked, and ties on kills; whether every team must
  declare war on every other team in its theatre at the start of war; whether
  air units, missiles and coastal batteries may attack ships; whether the
  flyover and territorial-waters rules apply while ships sail into their
  theatres during the truce; sanctions for breaking the event's own rules
  (bombarding cities, invading provinces, the flagship rules); and which
  countries the finalists play. **Verified with mocked unit tests only; not yet
  run on the real bot.** **Layout
  convention (2026-11-16, chosen by staff after trying wide `ansi` code blocks
  and a narrow aligned table): plain Discord markdown in the style of another
  community's event post they liked.** A `#`/`##` header with an emoji for each
  section; bullets that start with 🔷 (information) or 🔶 (a restriction,
  prohibition or sanction); a **bold** lead-in on each bullet; **bold** sub-
  headings; `*italic*` notes; `➢` for a sub-point. Text wraps naturally, so there
  is no line-width limit to manage (two earlier code-block layouts wrapped badly
  at the window's width). **Spacing between sections:** Discord trims trailing
  blank lines and consecutive bot messages render as one block, so
  `publishEventRules` ends every posted message with a line holding U+2800 (a
  blank braille cell, which isn't whitespace so it survives). Don't rely on
  newlines at the end of a section in `rules.md`. Keep each `<!-- split -->` section under 2000
  characters. A section over the limit is split on blank lines but **never inside
  a code fence**, and a single code block over the limit is an error telling you
  to add a `<!-- split -->`. `{blue}`-style colour tags in an ```` ```ansi ````
  block are still supported by `renderAnsiMarkup()` if a future rules file wants
  coloured text, but `water-wars/rules.md` no longer uses any. Which definitions are
  enforced was inferred from the definitions page and earlier staff discussion,
  not confirmed with staff. **Verified with mocked unit tests only; not yet run
  on the real bot.**
- **No-AI events (2026-11-26)**: when no zone in an event has any conquerable
  AI (`water-wars`), `#zones` leaves out the green legend line and the per-zone
  `### AI` sections, and the closing line bans capturing non-homeland countries
  outright rather than "during truce". The `water-wars` `thread.md` files have no
  AI section either, so restore it there if conquerable AI is ever added.
  Events with AI are unchanged.
- **Event map graphic, `src/config/<event>/map.png`**: posted into `#zones` by
  `/setup zones` / `/setup event` (see `publishZonesIndex`). `water-wars/map.png`
  is the naval theatre map (Pacific 60°N, Indo-Atlantic 70°N, split at 80°E, south
  limit 56°S, with the Caspian, Black Sea and Great Lakes marked). It does not yet
  mark the Baltic, Persian Gulf and Red Sea, which `rules.md` also lists as no-go
  waters.
- **Registrations-driven team threads (2026-07-05)**: a map entry's `zones`/
  `theatres` array can instead be `teams: "registrations"` — `/setup maps`
  then creates one private thread per **approved** `registrations` team
  (grouped live from `db.getRegistrationEntries`, not hand-authored), for
  events with no zone/theatre division at all. Reuses the same
  create-or-reuse-thread logic as the other two modes; `thread.md` gets
  `TEAM_NAME`/`PLAYERS_MENTIONS`/`TEAM_SIZE` but no zone/theatre placeholders
  and no subs (`registrations` has no subs concept, unlike `config.yml`
  zones/theatres teams). Deployed to `furiosa-test`, not yet live-tested
  (needs a test event with approved registrations + a matching
  `config.yml`). **Likely to be revised** — see "Config.yml minimization +
  `/draw` command" under Future plan below; this mode's `config.yml` shape
  (a `maps:` array where each entry repeats `teams: "registrations"`) will
  probably collapse to just a map *count* once that's designed properly.
- **Rules index (2026-07-05, part of `/setup event`, not a separate
  command)**: reads the server-wide `definitions` category (one channel per
  rules term, e.g. `☢️-act-of-war`), publishes each as its own message in
  that event's `#rules` channel — heading is a markdown `#` (large text, not
  just bold) for the term name, followed by the concatenated text of every
  human-authored message in that definitions channel, and any image
  attachments are re-uploaded alongside it (re-uploaded, not linked, because
  Discord's attachment CDN URLs carry an expiring signed query string that
  would eventually break a pasted link) — and posts/pins an index message
  linking to all of them, with the index message created *first* (as a
  placeholder, then edited once every definition's message ID is known) so
  it's always the chronologically earliest message in `#rules`, not the
  last. Idempotent — message IDs are tracked in `event_rules_index`
  (Postgres) so re-running `/setup event` edits existing messages instead of
  duplicating them; the definition *text and images* are always re-read
  live from the `definitions` channels, never cached in Postgres. If no
  `definitions` category exists on that server (e.g. the test server, which
  only has 2 dummy definition channels for testing this feature, not the
  full 14), this step is skipped gracefully — noted in the reply, never
  fails `/setup event` itself. Factored as a standalone
  `publishRulesIndex()` helper (called from, but not entangled with, the
  `/setup event` handler) since this may get promoted to a server-level
  (non-event-scoped) command later. Requires the bot's `MessageContent`
  privileged intent (enabled 2026-07-05 on both bot applications) to read
  non-bot message content in the `definitions` channels — without it
  Discord silently redacts content to `""` for any message the bot didn't
  author. **Not yet reconfirmed working end-to-end after the last two
  fixes** (image re-upload, `#` heading) — next session should re-run
  `/setup event` against the test server's 2 dummy definitions and visually
  confirm both render correctly together in `#rules`.
- `/teardown maps event:<key> [round:<key>] [dryrun] [delete_state]` —
  deletes a round's map channels/threads. Optionally deletes its `state.json`.
- `/teardown event event:<key> [dryrun]` — deletes the category + standing
  channels and clears `category.json`. Warns (doesn't block) if any round
  under that event still has tracked map channels/threads.
- `/register team:<name> ign:<name>` — player self-registration for an event,
  usable by anyone with the **Warboy** role (not staff-only, not open to
  everyone). Must be run inside that event's `#registration` channel — the
  event is inferred from the channel's parent category name
  (`eventKeyForCategory`), not typed. Enforces `maxTeamSize` (set via
  `/setup event`'s `max_team_size` option, default 5); posts an Approve/Reject
  button notification to that event's own `#applications` standing channel
  when a team first reaches capacity.
- `/unregister` — withdraws the caller's own registration for the event
  inferred from the channel it's run in (same Warboy gating and channel
  inference as `/register`). Refreshes `#registered-teams` if they'd already
  been approved.
- `/registrations list|approve|approve_player|reject|reject_team|export
  event:<key>` — staff-only. Nothing reaches `#registered-teams` without
  going through `approve`/`approve_player` (bulk-per-team is the primary
  path). `export` dumps approved teams as a YAML snippet for pasting into a
  round's `config.yml` once zone/map allocation is decided.
  - **Known gap, deliberately deferred**: `/teardown event` does not delete
    `registrations.json`. Tearing down and recreating an event will resurface
    old registrations. Flagged, not fixed — revisit if it causes confusion.
- **`/draw zone:<n> team:<name> [round:<key>]` (2026-07-09) — DEPRECATED
  (2026-11-16) in favour of `/setup draw` (a sheet import, see the
  Water Wars entry above).** It still works and every reply now ends with a
  deprecation notice; remove it once `/setup draw` has run a real draw. Records which
  approved team is assigned to which zone number, for **zones-mode events
  only** (`blood-pact`, `balance-of-power`; theatres mode, e.g. `bop`, is
  explicitly out of scope for now — see below). Run inside that event's
  `#registered-teams` channel; the event is inferred from the channel's
  parent category, same as `/register`/`/unregister` — no `event:` option.
  The actual team↔zone draw happens externally on **random.org**; this
  command doesn't randomize anything, it just records a result staff already
  decided. Both `zone` and `team` are autocomplete options **restricted to
  what's valid for that event, as a reducing set**: `zone` only offers zone
  numbers already imported for that event via `/setup zones`
  (`event_zone_definitions` — deliberately **not** `config.yml`, since a
  zones-mode event may have zone country data imported without ever having
  a `config.yml`/map structure — `blood-pact` is exactly this case, 30
  imported zones and no `config.yml` at all) that **don't already have a
  `/draw` assignment**; `team` only offers that event's *approved*
  `/registrations` teams that **aren't already assigned to a zone**. Zone
  and team are each one-time picks — once assigned, `/draw` has no
  reassign/overwrite path (the handler hard-rejects both "zone already
  assigned" and "team already assigned elsewhere" before writing, on top of
  Discord not hard-enforcing autocomplete values in the first place —
  a client could still submit arbitrary text past the dropdown, so this
  validation matters even though the dropdown itself already excludes
  those options). `setZoneAssignment` in `src/db.js` still contains a
  vacate-old-zone-then-insert transaction from an earlier design where
  reassignment was allowed; it's unreachable in the current flow (the
  handler's checks mean it's only ever called with a genuinely new
  zone+team pair) — left in as a harmless no-op rather than stripped, in
  case a future `/draw unassign`-style correction command reintroduces
  reassignment. Backed by a new `event_zone_assignments` table
  (`event_key`, `round_key`, `zone_number` → `team_name`), read by
  `/setup maps`: a zone's `config.yml` entry may now omit `team` entirely —
  if so, `/setup maps` looks up the `/draw` assignment for that zone number,
  then builds the roster live from that team's *approved* `/registrations`
  entries (mirroring the fallback pattern already used for zone
  homeland/ai country data, and the `teams: "registrations"` mode's roster
  logic). If neither a hand-authored `config.yml` team nor a `/draw`
  assignment exists for a zone, that zone errors clearly in the `/setup
  maps` plan instead of silently skipping. `validateConfig()`'s zone `team`
  check is now optional accordingly (previously hard-required).
  `/setup maps` itself still hard-requires a `config.yml` to exist at all
  (map channel structure isn't DB-backed yet) — so `/draw` can now be fully
  exercised against `blood-pact` (real event, real imported zones, real
  approved registrations) even though `/setup maps` can't run for it yet
  without one being authored. **Live-tested against `furiosa-test` this
  session, two bugs caught and fixed in the process**: first pass had `zone`
  autocomplete reading `config.yml` (corrected above; caught because
  `blood-pact` has no `config.yml`, so the dropdown was silently empty);
  second pass had both dropdowns showing every zone/team rather than
  shrinking as the draw progressed, which made it possible to re-pick an
  already-assigned zone or team (corrected to the reducing-set + hard-reject
  behavior described above).
  - **Deliberately deferred**: theatres-mode draw (`bop`-style events).
    Theatres have two (or, for free-for-all, more) team slots per theatre plus a `countryPool` per slot —
    a meaningfully different shape than zones' one-team-per-zone — so it
    wasn't built speculatively alongside this. Same
    fallback-from-registrations pattern should extend cleanly when needed.
- `/lobby`, `/matchmake`, `/create_match`, `/record_result`, `/season`,
  `/league` — matchmaking/ELO system, **WIP, not load-bearing**. Backed by
  Postgres (`src/db.js`, `src/elo.js`). See "Known constraints" below.

## Discord quirks learned the hard way (don't re-litigate these)

- **A "reuse existing channel/thread" branch that does `state.X[key] = { id }`
  silently wipes any other tracked fields on that entry — in particular
  `posted`.** Found 2026-07-09 testing `/setup maps` against `blood-pact`:
  re-running the command re-sent the map channel's intro message every
  time, because the "channel already exists" branch overwrote
  `state.channels[channelName]` with a bare `{ id: mapChannel.id }`,
  dropping the `posted: true` flag a prior run had set — so the very next
  `if (chanState.posted !== true)` check always saw a channel that looked
  never-posted. The same pattern existed for threads in all three map
  modes (theatres/zones/registrations) and in the new DB-driven zones
  path — none of them had actually been idempotency-tested against a
  second run before this. Fixed everywhere by spreading the existing entry
  first: `state.X[key] = { ...state.X[key], id }`, so `posted` (and
  anything else tracked there) survives a "reused" pass. **Lesson**: when
  a piece of state is both "the ID to look up next time" and "a flag that
  guards a one-time side effect," never blindly overwrite the whole object
  on the lookup path — always merge.
- **Coloured text in bot posts: always use ```` ```ansi ```` blocks with explicit
  colour codes (the `ansiBlock()` / `ANSI` helpers in `src/index.js`), never a
  language guess.** The `#zones` legend and Homeland lists used to be ```` ```fix ````
  blocks and, on 2026-11-16, rendered as plain white text on the test server (the
  `yaml` AI block and `diff` admin block did colour, but only because Discord
  happened to highlight them). Convention: blue = homeland, green = conquerable
  AI, red = admin or not allowed. Desktop shows the colours; mobile may show plain
  text. Each line adds about 11 characters of escape codes toward Discord's
  2000-char limit.
- Map channel intro messages (`/setup maps`, both the `config.yml`-driven
  and DB-driven paths) are now pinned after sending, same reasoning as the
  zones-index header message and the rules-index message — the
  channel-setup announcement should be easy to find later, not scroll off.
- `mentionList()` (`src/index.js`) joins player/sub mentions with `\n`, not
  a space — each player's `<@id>` mention renders on its own line in
  `thread.md`'s `{{PLAYERS_MENTIONS}}`/`{{SUBS_MENTIONS}}` output. Changed
  2026-07-09 after the space-joined version rendered as one long run-on
  line; applies to every mode (theatres/zones/registrations/DB-driven)
  since they all go through the same helper.
- **Slash commands need `SendMessages`, not just `UseApplicationCommands`,
  in a channel that denies the former.** Tested directly: granting only
  `UseApplicationCommands` to the Warboy role in `#registration` did NOT let
  them run `/register` — `SendMessages` had to be granted too, despite
  `UseApplicationCommands` being the permission conceptually meant to gate
  slash commands. `standingChannelOverwrites()` now grants Warboys both in
  `#registration`. Side effect: Warboys can technically free-text chat there
  now too — mitigated with a 1-hour slowmode (`STANDING_CHANNEL_SLOWMODE`),
  which doesn't affect slash command usage (slowmode only throttles regular
  messages).
- **A channel topic starting with a bare `\n` gets silently trimmed by
  Discord's API** — it does not produce a visible line break before the
  topic content in the "Welcome to #channel!" card (which otherwise runs
  Discord's own "This is the start of..." sentence straight into your topic
  text with no separator). Fix: start the topic with `.` then `\n\n` — a
  leading non-whitespace character survives trimming, and the `.` reads as
  closing the boilerplate sentence.
- **Channel topics don't auto-format slash-command mentions.** Bold them
  manually — `STANDING_CHANNEL_TOPICS.registration`'s `/register`/`/unregister`
  lines use `***bold+italic***` — nothing auto-bolds plain `/command` text in
  a topic string.
- **A channel topic can't hardcode a link to another per-event channel.**
  `STANDING_CHANNEL_TOPICS.registration` (2026-07-05) is a *function*
  `(guildId, registeredTeamsChannelId) => topicString`, not a plain string,
  specifically so its `[#registered-teams](https://discord.com/channels/...)`
  masked link points at *that event's own* `#registered-teams` channel — a
  fixed string would only be correct for one specific event/server (this was
  caught before shipping: an earlier draft had a real but event-specific
  test-server URL pasted directly into what was about to become the shared
  template). Resolved at `/setup event` time using
  `state.standingChannels["registered-teams"].id`, which is always already
  known because `"registered-teams"` is processed earlier than
  `"registration"` in `STANDING_CHANNEL_NAMES`.
- **Command visibility vs. authorization are two separate systems, and only
  one is settable from the bot's own token.** Every command's actual gate is
  the in-code `isStaff`/`isWarboy` check in `interactionCreate` — that's the
  real authorization boundary and stays regardless of Discord-side settings.
  On top of that (2026-07-05), all staff-only commands (everything except
  `/register`/`/unregister`) now also set
  `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)`, so
  Discord itself hides them from non-admins in the UI — this works because
  both the live and test servers' `EVENT_STAFF_ROLE_ID` roles happen to carry
  `Administrator`. There's no clean equivalent for hiding `/register`/
  `/unregister` from non-Warboys: Discord's `default_member_permissions` only
  understands real permission bits, not arbitrary custom roles, and Warboy is
  just a general-member role with no distinguishing permission to hang that
  off of. The *other* Discord mechanism — per-guild "Integration Permissions"
  role-specific overrides — can't be set by the bot's own token at all since a
  2022 API change requires an OAuth2 Bearer token from a server admin; it'd
  have to be configured by hand per-server in Discord's UI, not automated by
  `/setup`.
- An uncaught `DiscordAPIError[10008] Unknown Message` (editing an
  interaction reply that no longer exists) crashed the whole process once
  this session — Node 20 terminates on unhandled promise rejections, and
  systemd's `Restart=on-failure` brought it back in ~5s. **Root cause found
  and fixed 2026-11-16**: it recurred as `/registrations list` with 80
  registrations (reply over Discord's 2000-char limit, `BASE_TYPE_MAX_LENGTH`).
  The handlers end with `return interaction.editReply(...)` *without* `await`,
  so a failing reply rejects outside the `try`/`catch` and nothing handles it.
  The handler is now `handleInteraction`, and the `interactionCreate` listener
  attaches a `.catch` that logs the error and tells the user (`❌ Error: ...`),
  so one failed reply can't kill the process. `/registrations list` also now
  splits its reply across messages (`editReplyChunked`). Still unfixed:
  `/registrations export` puts everything in one code block, so a big event
  will hit the 2000-char limit there and get the `❌ Error` reply instead.

## Reading Discord messages via the prod bot (2026-11-16)

Claude sessions can read live Fury Road server messages using the prod bot's
token. The token only exists in `/opt/furiosa/.env` on the Lightsail box
(there is no local `.env`), so run a read-only script *on the box* rather
than copying the token anywhere:

```
ssh furiosa-prod 'cd /opt/furiosa && sudo -u furiosa node -e "
require(\"dotenv\").config({quiet:true});
const {Client,GatewayIntentBits}=require(\"discord.js\");
const c=new Client({intents:[GatewayIntentBits.Guilds]});
c.once(\"clientReady\",async()=>{ /* fetch channels/messages here */ process.exit(0); });
c.login(process.env.DISCORD_TOKEN);"'
```

- `furiosa-prod` is an SSH host alias in `~/.ssh/config` (key
  `~/.ssh/id_ed25519_furiosa`). `GUILD_ID` is in the same `.env`.
- Add `GatewayIntentBits.GuildMessages` (and `MessageContent`, enabled on the
  bot application) when reading message history; `Guilds` alone only lists
  channels.
- **Never print, echo, copy or log the token.** Print only the messages
  asked for, to the terminal; don't write them to disk.
- **Only read the channels the user names.** Staff/sensitive channels
  (`admin`, `modlog`, `strike-list`, `support-tickets`, etc.) are not to be
  swept speculatively.
- The bot can see all channels, but only ones that currently exist: deleted
  channels (e.g. `#participant-roster`) can't be recovered. `channels.fetch()`
  returns `null` for channel types discord.js doesn't recognise (e.g.
  `server-hub`, type 20) — filter nulls, or use `c.rest.get("/guilds/<id>/channels")`
  for the raw list. Threads need `/guilds/<id>/threads/active` and
  `/channels/<id>/threads/archived/public`.
- This is prod, so keep it read-only: no sends, edits or deletes, and don't
  restart the service.

## Known constraints / non-negotiables

- **Postgres/RDS is co-located in us-east-1** (`furiosa-db`, RDS Postgres 17,
  `db.t4g.micro`), replacing a prior eu-west-2 instance that was torn down
  (2026-07-05). It's a publicly-accessible RDS instance with a security
  group restricted to the Lightsail box's static IP (no VPC peering), 7-day
  automated backups, holding two databases (`furyroad`/`furyroad_test`, via
  `PGDATABASE_PROD`/`PGDATABASE_TEST`) mirrored across both the prod and test
  systemd instances. This is now load-bearing for **all** bot runtime state,
  not just matchmaking/ELO — see "Config vs. runtime state" above. The prior
  non-negotiable ("`/setup event`/`/setup maps`/`/teardown` must never depend
  on Postgres") is **retired**: it existed because the DB used to be an
  unreliable, cross-region, WIP-only dependency; that's no longer true, and
  those commands now do depend on it. DB connection/schema-init failures at
  startup are still caught and logged rather than crashing the process, but
  a DB outage will now cause `/setup`/`/teardown`/`/register`/`/registrations`
  to error out on use, not just matchmaking commands.
- **`EVENT_CATEGORY_ID` env var was removed entirely.** It used to be a
  bot-level `.env` setting for something that's actually per-event — replaced
  by the category/round model above. `/lobby`/`/matchmake`/`/create_match`
  still read `process.env.EVENT_CATEGORY_ID` and will just see `undefined`
  until that feature is revisited — don't "fix" this by re-adding the env
  var; fix it by giving matchmake its own category resolution, consistent
  with `/setup event`.
- **`CHANNEL_PREFIX`/`THREAD_PREFIX` are gone** — confirmed dead (never
  referenced in code) and removed from `.env.example`.
- **One new required env var for the registration feature**: `WARBOY_ROLE_ID`
  (the general member role allowed to use `/register`/`/unregister`). Set on
  both the prod and test boxes' `.env` — will need a real value again for
  any other server.
  `EVENT_APPLICATIONS_CHANNEL_ID` used to be a second bot-level env var here
  but was removed: where team-ready Approve/Reject notifications post is now
  the per-event `#applications` standing channel (created by `/setup event`,
  same as `#registration` etc.), not a single bot-wide channel.
- **`DB_IS_TEST_INSTANCE` env var (2026-07-05)**: fixed per systemd instance
  (unset/`false` on `furiosa-prod`, `true` on `furiosa-test`), not a
  per-command flag like matchmaking's `test:` option. Routes that instance's
  registrations/category/round-state reads and writes to `PGDATABASE_TEST`
  instead of `PGDATABASE_PROD` on the shared `furiosa-db` instance.
- No automated Lightsail snapshots — deliberate cost decision for a hobby
  project. Rebuilding from git + a fresh instance is the accepted recovery
  path, not snapshot restore.
- Git commits in this repo must use the GitHub noreply email
  (`24211506+dmason1974@users.noreply.github.com`) — GitHub rejects pushes
  that would expose the real address. Already set as the global
  `user.email`, so this shouldn't recur, but flagging in case a different
  machine/environment picks this repo up.

## Definitions & sanctions web page: state at 2026-11-26

The 14 `definitions` channels and `#sanctions` have been **replaced by one GitHub
Pages page, on both servers** (prod done 2026-11-26, approved by the other owners).

- **Live page**: `docs/definitions.md` → https://dmason1974.github.io/furiosa/definitions.html
  (Jekyll via the repo's Pages setting, source `main` / `/docs`, legacy build, no
  `_config.yml`). Sections: Definitions, Map terms, Sanctions (all alphabetical;
  keep lists alphabetical, the user dislikes any other order). Title "Definitions &
  Sanctions" (no "Fury Road" in the H1: the logo carries it). Two intro paragraphs,
  both tagged `{: .plain}` so they are body-size, not the layout's pull-quote.
  Staff notes and the DRAFT line were removed from the live page. Sanction table is
  built from `#sanctions` (resource names confirmed by the user: Components, Rare
  materials, Electronics, Supplies, Fuel, Cash). Flyover = an act of war, same sanction.
- **Test copy**: `docs/definitions-test.md` (…/definitions-test.html) is a manual copy
  pointing at the **test** server (support-tickets link + its own invite), titled
  "(TEST)", and still carries the "Notes for staff" section with open questions
  (market-blocking wording/Conspiracy conflict; what the red line in the
  Nation's-territory image shows; optional "what this means for you" lines). It
  drifts from the live page, so regenerate it from `definitions.md` when that changes.
- **Layout**: `docs/_layouts/default.html` has two opt-ins set in front matter:
  `sidebar: true` (sticky nav built by JS from h2/h3, scrollspy, collapses on phones)
  and `theme: fury` (dark palette from the server icon, Oswald headings, gold h1,
  `docs/images/server-icon.png` above the nav and as favicon). `{: .plain}` resets
  the intro-paragraph style; `{: .side}` on an image floats it right at a uniform
  340x300 frame. `docs/server-review.md` does not opt in, so it keeps the original
  warm style. Jekyll is not installed locally, so pages can only be checked by
  pushing and loading the live URL (Pages rebuild takes ~1-2 minutes).
- **Discord links used by the page**: prod guild `1464807025815978110`,
  `#support-tickets` `1464887983332134933`, permanent bot-made invite to
  `#start-here` `https://discord.gg/Bkx8TbRhDZ`. Test guild `1209791658082705418`,
  `#support-tickets` `1569416428560588833`, permanent invite
  `https://discord.gg/AYDrmbgDpX`.
- **Posts**: `#start-here` is edited with `scripts/start-here.js` from
  `server/start-here.md`. `#event-rules` is one bot-authored message from
  `server/event-rules.md` (`SUPPORT_TICKETS_CHANNEL_ID` replaced when posted); there
  is no committed script for it. Both templates point at the **live** page. On test,
  `#event-rules` (message `1571844357193994274`) links the test page, while
  `#start-here` was seen linking the live one (2026-11-26).
- **Prod (done 2026-11-26)**: `#start-here` edited; `event draw` stage channel
  (`1575462649821659257`) created under `Thunderdome-general`; new `#event-rules`
  message `1575466116040622202`; `#sanctions` removed from onboarding default
  channels and the Server Guide (this is what "server resources" meant); the 14
  definition channels, `#sanctions` and the old human-authored rules post deleted.
  Deleting a Discord category does **not** delete its channels.
- **Win conditions** (Capture the Flagship, Homeland Supremacy, Sacred Ground) are
  event-specific and deliberately not on the page: state them in each event's rules.
- **A slow send can post twice**: a one-off discord.js script posting to prod
  `#event-rules` produced two identical messages 16 s apart, probably a REST retry
  after a timeout. Check the channel after any scripted post.
- **Old announcements** (2026-02-06 and 2026-07-11) still link to deleted channels;
  only their authors can edit them.
- **Still to do** (needs a bot deploy to prod, which is **not** approved yet because
  it would ship Water Wars): replace `publishRulesIndex` (it reads the
  `definitions` category, and skips gracefully when absent) with one pinned pointer
  message to the page in each event's `#rules`; then drop the dead code, the
  `event_rules_index.definitions` usage and update the "Rules index" entry above.

### Continuing on another machine

Git carries the repo (`git pull` is enough). Not in git, and needed for Discord/prod work:
- **SSH**: `~/.ssh/id_ed25519_furiosa` plus the `furiosa-prod` Host entry in
  `~/.ssh/config` (HostName `52.20.102.165`, User `ubuntu`, that IdentityFile). Copy
  the key over a safe channel; never commit it. Test it with `ssh furiosa-prod true`.
- **GitHub**: `gh auth login` and push access to `dmason1974/furiosa`; git
  `user.email` must be the noreply address (see "Known constraints").
- **Claude memory** is per machine (`~/.claude/projects/<path>/memory`) and does not
  travel; this section and the Discord-reading section above are the durable record.
- Bot tokens stay only on the Lightsail box (`/opt/furiosa/.env`, `/opt/furiosa-test/.env`);
  never copy them. Run the Discord helper scripts on the box over SSH (see "Reading
  Discord messages via the prod bot").
- **Water Wars bot work** (free-for-all theatres, `/setup draw`, per-event
  `rules.md`, the test-server state and the ordered next steps) has its own
  handoff in `HANDOFF-water-wars.md`. `HANDOFF.md` covers the separate server
  review / onboarding thread. Read both after this file.

## Future plan / open items

- **Postgres migration + rules index — implemented and deployed
  (2026-07-05), needs a final E2E pass next session.** Both `furiosa-prod`
  and `furiosa-test` are live on the new us-east-1 RDS instance and log `DB
  schema ready (prod + test)` cleanly. What's been individually verified
  this session: `/setup event` dry-run and real runs against the test
  server (including the dynamic `#registration` topic and skip-gracefully
  behavior with only 2 dummy `definitions` channels there); DBeaver
  connects via SSH tunnel and shows all expected tables in both `furyroad`/
  `furyroad_test`. **Not yet re-verified after the Postgres migration**:
  the full `/register` → `/registrations approve` → `#registered-teams`
  sync → `/unregister` player-facing flow end-to-end (it worked pre-migration
  against the old JSON files; the code path changed, but this hasn't been
  re-exercised against the new DB-backed tables). Also see the rules-index
  "not yet reconfirmed" note under Commands above — same next-session
  action, same test event.
- **Matchmake/ELO rearchitecture**: give `/lobby`/`/matchmake`/`/create_match`
  their own way to resolve a category (mirroring `/setup event`'s model)
  instead of the removed `EVENT_CATEGORY_ID`. Not started.
- **Duplicate-looking configs**: `src/config/bop/` and
  `src/config/balance-of-power/` both have `event.name: "Balance of Power"` —
  never reconciled/deduplicated. Worth checking with the user whether one is
  stale before assuming both are intentionally separate events. Note:
  2026-07-05's zone-import backfill used the `balance-of-power` event key
  specifically (user's explicit instruction), so that's now the one with
  real zone data in Postgres — a data point, not a resolution of which
  directory is canonical.
- **Zone import feature (2026-07-05)** — implemented, deployed to prod,
  verified end-to-end on `furiosa-test`. See the `/setup zones` entry under
  Commands above for full detail, the Urumqi/Uyghur open naming question,
  and the not-yet-started "image import" follow-up. **Not yet live**:
  `/setup event` hasn't been run on prod for `blood-pact` or
  `balance-of-power` since this shipped — that's an intentional "publish
  when ready" step for the user, not an oversight.
- **Config.yml minimization + `/draw` command — designed 2026-07-05, most
  of zones mode shipped 2026-07-09; theatres mode and shared templates
  still not started:**
  - **Done (zones mode, single-map events)**: `/draw` (see Commands above)
    records the team↔zone draw — a single-assignment slash command with
    event-restricted `zone`/`team` autocomplete (sourced from
    `event_zone_definitions`/approved `/registrations`, not `config.yml`),
    run in `#registered-teams`. Writes to `event_zone_assignments`
    (`event_key`, `round_key`, `zone_number` → `team_name`). `/setup maps`
    now has **two paths**: the original `config.yml`-driven one (unchanged,
    still needed for multi-map splits like `balance-of-power`, and for
    theatres mode), and — new — a fully DB-driven path (`setupMapsFromDb`
    in `src/index.js`) that kicks in when a round has **no `config.yml` at
    all**: single map channel, one thread per imported zone, team +
    roster from `/draw` + `/registrations`, only `thread.md` needed as a
    file. `blood-pact` (30 zones, real event) is the first event on this
    path — `config.yml` is genuinely eliminated for it, not just team data
    within it. Theatres mode (`theatre_id`/team pairing) is **not done** —
    deliberately deferred, see the `/draw` Commands entry for why.
  - Multi-map zones events (`balance-of-power`-style) and theatres mode
    still need `config.yml` for the map/zone-number structure — the
    DB-driven path only handles the "one map, all zones" shape. Extending
    it to a configurable map split (without reintroducing a config file)
    is the natural next step if a multi-map DB-driven event comes up.
  - For the **registrations-only mode** (this session's `teams:
    "registrations"`, see Commands above), `config.yml` should shrink
    further to just a map *count* — there's no per-map data left to
    specify once teams come live from `registrations` and there's no
    zone/theatre division. Revisit this session's implementation to match.
  - `thread.md` shouldn't be per-event/round either — once the above
    lands, the message body only depends on *mode* (theatres vs. zones vs.
    registrations-only), not on which event it is. Plan: **3 shared
    templates** (e.g. under a new `src/templates/` dir) selected by mode,
    replacing the current per-event/round `thread.md` file convention
    entirely.
  - Net effect once all of this ships: `config.yml` per event/round
    reduces to just `event.key`/`name`/`round`/`teamSize` and either a map
    count (registrations-only) or map/zone-number structure with no team
    data (zones/theatres) — everything else (country data, team↔zone
    assignment, team rosters, message templates) is DB-backed or shared.
- **`Restart=on-failure` vs `Restart=always`** in `deploy/furiosa.service`:
  current setting won't restart the service on a clean-exit crash (e.g. an
  unhandled rejection handler calling `process.exit(0)`). Flagged as a
  tradeoff, not changed.
- **Discord "how to use Furiosa" post** — drafted this session (staff-facing
  usage guide covering the two-tier role model, the 5 standing channels, the
  registrations workflow, and the rules-index behavior) but not yet posted
  by the user; the draft isn't saved anywhere in-repo, only in this
  session's chat history.
