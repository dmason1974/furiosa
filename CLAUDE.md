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
  `standingChannels`), written by `/setup event`. Gitignored.
- `data/<event>/[<round>/]state.json` — round-level state (`channels`,
  `threads`), written by `/setup maps`. Gitignored.
- Both are **not backed up**. If the Lightsail instance is ever lost again,
  this state is lost with it. Partial self-healing exists: `resolveEventCategory`
  falls back to searching Discord by category *name* if there's no cached ID,
  so `/setup event` re-run after a rebuild will re-discover an existing
  category. There's no equivalent name-based recovery for round-level map
  channels/threads.

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
- `/lobby`, `/matchmake`, `/create_match`, `/record_result`, `/season`,
  `/league` — matchmaking/ELO system, **WIP, not load-bearing**. Backed by
  Postgres (`src/db.js`, `src/elo.js`). See "Known constraints" below.

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
- No automated Lightsail snapshots — deliberate cost decision for a hobby
  project. Rebuilding from git + a fresh instance is the accepted recovery
  path, not snapshot restore.
- Git commits in this repo must use the GitHub noreply email
  (`24211506+dmason1974@users.noreply.github.com`) — GitHub rejects pushes
  that would expose the real address. Already set as the global
  `user.email`, so this shouldn't recur, but flagging in case a different
  machine/environment picks this repo up.

## Future plan / open items

- **Matchmake/ELO rearchitecture**: give `/lobby`/`/matchmake`/`/create_match`
  their own way to resolve a category (mirroring `/setup event`'s model)
  instead of the removed `EVENT_CATEGORY_ID`. Not started.
- **Runtime state durability**: `data/` is unbacked-up and self-healing only
  for the category (by name lookup), not for round-level map channels/threads.
  Possible fixes, not implemented: periodic sync of `data/` to S3, or move
  this tracking state into the existing RDS Postgres instance instead of
  local JSON files.
- **Duplicate-looking configs**: `src/config/bop/` and
  `src/config/balance-of-power/` both have `event.name: "Balance of Power"` —
  never reconciled/deduplicated this session. Worth checking with the user
  whether one is stale before assuming both are intentionally separate events.
- **`Restart=on-failure` vs `Restart=always`** in `deploy/furiosa.service`:
  current setting won't restart the service on a clean-exit crash (e.g. an
  unhandled rejection handler calling `process.exit(0)`). Flagged as a
  tradeoff, not changed.
