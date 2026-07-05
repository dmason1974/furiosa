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
- The category + 5 standing channels (`event-chat`, `rules`,
  `registered-teams`, `registration`, `applications`) belong to the **event**
  and are shared across all its rounds. Map channels/threads belong to a
  **round** (or to the event directly, if it has no rounds). `applications`
  is staff-only (hidden from `@everyone`, visible to `EVENT_STAFF_ROLE_ID`
  and the bot) — it's where Approve/Reject team-ready notifications post;
  see the `/register` entry below.

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
  - All three are covered by the same RDS automated backups as the
    matchmaking tables (see "Known constraints" below) — this was the whole
    point of the move, replacing the old unbacked-up local JSON files.
    `resolveEventCategory`'s name-based fallback (searching Discord by
    category *name* if there's no stored ID) is unchanged and still the
    recovery path for a stale/missing row, same as before.

### Commands

- `/setup event event:<key> [dryrun]` — creates the category + 5 standing
  channels if missing. Idempotent. Also publishes the rules index (below) as
  its last step every time it runs.
- `/setup maps event:<key> [round:<key>] [dryrun]` — creates map channels +
  private team threads (the original, longest-standing feature). Requires
  the category to already exist (via `/setup event`) — errors with a clear
  message instead of silently creating one.
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
  systemd's `Restart=on-failure` brought it back in ~5s. Root cause not
  investigated/fixed; if it recurs, the outer `catch` in `interactionCreate`
  needs to swallow failures from the *success-path* `editReply` too, not
  just the error-path one.

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
  stale before assuming both are intentionally separate events.
- **`Restart=on-failure` vs `Restart=always`** in `deploy/furiosa.service`:
  current setting won't restart the service on a clean-exit crash (e.g. an
  unhandled rejection handler calling `process.exit(0)`). Flagged as a
  tradeoff, not changed.
- **Discord "how to use Furiosa" post** — drafted this session (staff-facing
  usage guide covering the two-tier role model, the 5 standing channels, the
  registrations workflow, and the rules-index behavior) but not yet posted
  by the user; the draft isn't saved anywhere in-repo, only in this
  session's chat history.
