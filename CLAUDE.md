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
- The category + 4 standing channels (`event-chat`, `rules`,
  `registered-teams`, `registration`) belong to the **event** and are shared
  across all its rounds. Map channels/threads belong to a **round** (or to
  the event directly, if it has no rounds).

### Config vs. runtime state — kept deliberately separate

- `src/config/` is a **pure, git-managed tree** — only `config.yml`/`thread.md`,
  human-authored, committed. Never write generated/runtime data here again;
  we did this once (category/state JSON living inside `src/config/`) and
  reverted it because it broke the "config directory = what's in git"
  invariant.
- `data/<event>/category.json` — event-level state (`categoryId`,
  `standingChannels`, `maxTeamSize`), written by `/setup event`. Gitignored.
- `data/<event>/[<round>/]state.json` — round-level state (`channels`,
  `threads`), written by `/setup maps`. Gitignored.
- `data/<event>/registrations.json` — player self-registration state
  (`entries`, `registeredTeamsMessageId`, `pendingReviews`), written by
  `/register`/`/registrations`. Gitignored.
- None of these are **backed up**. If the Lightsail instance is ever lost
  again, this state is lost with it. Partial self-healing exists:
  `resolveEventCategory` falls back to searching Discord by category *name*
  if there's no cached ID, so `/setup event` re-run after a rebuild will
  re-discover an existing category. There's no equivalent name-based
  recovery for round-level map channels/threads or for registrations.

### Commands

- `/setup event event:<key> [dryrun]` — creates the category + 4 standing
  channels if missing. Idempotent.
- `/setup maps event:<key> [round:<key>] [dryrun]` — creates map channels +
  private team threads (the original, longest-standing feature). Requires
  the category to already exist (via `/setup event`) — errors with a clear
  message instead of silently creating one.
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
  button notification to `EVENT_APPLICATIONS_CHANNEL_ID` when a team first
  reaches capacity.
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
- `/lobby`, `/matchmake`, `/create_match`, `/record_result`, `/season`,
  `/league` — matchmaking/ELO system, **WIP, not load-bearing**. Backed by
  Postgres (`src/db.js`, `src/elo.js`). See "Known constraints" below.

## Discord quirks learned the hard way (don't re-litigate these)

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
  manually with `**/command**` if you want them visually distinct — nothing
  auto-bolds plain `/command` text in a topic string.
- An uncaught `DiscordAPIError[10008] Unknown Message` (editing an
  interaction reply that no longer exists) crashed the whole process once
  this session — Node 20 terminates on unhandled promise rejections, and
  systemd's `Restart=on-failure` brought it back in ~5s. Root cause not
  investigated/fixed; if it recurs, the outer `catch` in `interactionCreate`
  needs to swallow failures from the *success-path* `editReply` too, not
  just the error-path one.

## Known constraints / non-negotiables

- **Postgres/RDS stays in eu-west-2**, untouched, while the bot itself runs
  in us-east-1 (cross-region). Deliberate — the matchmaking/ELO feature set
  that depends on it is WIP and not worth migrating a database for yet. DB
  connection failures at startup are caught and logged, not fatal — `/setup
  event`/`/setup maps`/`/teardown` never depended on Postgres and must not
  start depending on it.
- **`EVENT_CATEGORY_ID` env var was removed entirely.** It used to be a
  bot-level `.env` setting for something that's actually per-event — replaced
  by the category/round model above. `/lobby`/`/matchmake`/`/create_match`
  still read `process.env.EVENT_CATEGORY_ID` and will just see `undefined`
  until that feature is revisited — don't "fix" this by re-adding the env
  var; fix it by giving matchmake its own category resolution, consistent
  with `/setup event`.
- **`CHANNEL_PREFIX`/`THREAD_PREFIX` are gone** — confirmed dead (never
  referenced in code) and removed from `.env.example`.
- **Two new required env vars for the registration feature**:
  `WARBOY_ROLE_ID` (the general member role allowed to use `/register`/
  `/unregister`) and `EVENT_APPLICATIONS_CHANNEL_ID` (where team-ready
  Approve/Reject notifications post). Both are set in `.env` on the current
  Fury Road server/box — will need real values again for any other server
  (see Future plan: test server below).
- No automated Lightsail snapshots — deliberate cost decision for a hobby
  project. Rebuilding from git + a fresh instance is the accepted recovery
  path, not snapshot restore.
- Git commits in this repo must use the GitHub noreply email
  (`24211506+dmason1974@users.noreply.github.com`) — GitHub rejects pushes
  that would expose the real address. Already set as the global
  `user.email`, so this shouldn't recur, but flagging in case a different
  machine/environment picks this repo up.

## Future plan / open items

- **Next session: deploy to a test Discord server.** The registration
  feature (`/register`, `/unregister`, `/registrations`, Approve/Reject
  buttons) has only been exercised on the live Fury Road server so far. Plan
  is to stand up a separate test server before going further, so iteration
  doesn't risk the real one. This will need its own `GUILD_ID`,
  `EVENT_STAFF_ROLE_ID`, `WARBOY_ROLE_ID`, and `EVENT_APPLICATIONS_CHANNEL_ID`
  — either a second `.env`/instance, or a documented way to swap servers on
  the existing box. Not started/designed yet.
- **Matchmake/ELO rearchitecture**: give `/lobby`/`/matchmake`/`/create_match`
  their own way to resolve a category (mirroring `/setup event`'s model)
  instead of the removed `EVENT_CATEGORY_ID`. Not started.
- **Runtime state durability**: `data/` is unbacked-up and self-healing only
  for the category (by name lookup), not for round-level map channels/threads
  or registrations. Possible fixes, not implemented: periodic sync of `data/`
  to S3, or move this tracking state into the existing RDS Postgres instance
  instead of local JSON files.
- **Registrations: JSON now, DB later.** `/register`/`/registrations` are
  deliberately built on `data/<event>/registrations.json` for a first
  iteration — fast, zero new infra, consistent with the rest of the bot's
  state model. A future iteration should likely move this to a proper
  database (the existing eu-west-2 RDS instance is the obvious candidate,
  though it's currently WIP/matchmaking-only). Not started.
- **Duplicate-looking configs**: `src/config/bop/` and
  `src/config/balance-of-power/` both have `event.name: "Balance of Power"` —
  never reconciled/deduplicated this session. Worth checking with the user
  whether one is stale before assuming both are intentionally separate events.
- **`Restart=on-failure` vs `Restart=always`** in `deploy/furiosa.service`:
  current setting won't restart the service on a clean-exit crash (e.g. an
  unhandled rejection handler calling `process.exit(0)`). Flagged as a
  tradeoff, not changed.
