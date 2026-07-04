# Furiosa Event Bot – Usage Guide

Furiosa is used to create and manage event map channels and private team threads from a YAML configuration file.

It is safe, repeatable, and staff-only.

---

## Who Can Use This Bot

Only users with the Event Staff role can run commands — with one exception:
`/register` can be run by anyone with the **Warboy** role (the server's
general member role), so players can self-register without staff access.

If you do not have the required role, the bot will ignore the command.

---

## What the Bot Does

For a given event config, Furiosa will:

- Create one channel per map
- Create private team threads inside each map channel
- Add the correct players to each private thread
- Post team information (countries, AI, rules)
- Ask players to acknowledge with a ✅
- Track everything it creates so it can be safely removed later

---

## Event Configuration

Each event is a directory under `src/config/`, named after the event itself —
that directory name is what you type into every command's `event:` option,
and it's also the exact name the bot gives the event's Discord category.

An event with a single round keeps its files directly in that directory:

```
src/config/bop/
  config.yml    – structure, maps, teams, players
  thread.md     – message posted into each team thread
```

An event with multiple rounds nests each round in its own subdirectory
instead:

```
src/config/beyond-thunderdome/
  r1-flagship/
    config.yml
    thread.md
  r2-homeland/
    config.yml
    thread.md
```

The category and standing channels belong to the **event** and are shared
across all its rounds. Map channels and threads belong to a **round** (or to
the event directly, if it has no rounds).

---

## Creating an Event

### Step 1: Create the Category

Every event needs its category and standing channels
(`event-chat`, `rules`, `registered-teams`, `registration`) created once,
before any maps are set up:

`/setup event event:bop`

Add `dryrun:true` first if you want to preview what would be created without
making changes. Safe to re-run — existing channels are reused, nothing is
duplicated.

---

### Step 1.5: Player Registration

Once the category exists, players can self-register in the event's
`#registration` channel (its topic explains this too):

`/register team:"Elite Corps" ign:YourIGN`

- Anyone with the **Warboy** role can run this — it must be run inside that
  event's `#registration` channel, since the event is inferred from which
  category the channel belongs to.
- The `team` field autocompletes against team names already registered for
  that event, but you can also type a brand-new name if you're the first on
  your team.
- Re-running `/register` updates your own entry (never creates a duplicate),
  and resets it back to pending if it had already been approved.
- Each event has a max players per team (`/setup event`'s `max_team_size`,
  default 5). Once a team hits that cap, further registrations are rejected
  with a "team is full" message, and staff get a notification with
  Approve/Reject buttons in the applications channel.

Staff review registrations with:

- `/registrations list event:bop` — see everything, grouped by team
- `/registrations approve event:bop team:"Elite Corps"` — bulk-approve a team
- `/registrations reject_team event:bop team:"Elite Corps"` — bulk-reject a team
- `/registrations approve_player event:bop player:@user` / `reject` — single-player overrides
- `/registrations export event:bop` — dumps approved teams as a YAML snippet
  ready to paste into that round's `config.yml` once zone/map allocation is
  decided, so you don't have to re-type every player's Discord ID by hand

Approved registrations are automatically compiled into the `#registered-teams`
channel — that message updates itself as approvals/rejections happen, it's
never a manual export step.

---

### Step 2: Dry Run the Maps (Always Do This Next)

Shows what would be created without making any changes.

- Single-round event: `/setup maps event:bop dryrun:true`
- Multi-round event: `/setup maps event:beyond-thunderdome round:r1-flagship dryrun:true`

Use this to:
- Validate the YAML
- Check channel and thread names
- Catch mistakes safely

---

### Step 3: Create Map Channels and Threads

Once the dry run looks correct, drop `dryrun:true`:

- Single-round event: `/setup maps event:bop`
- Multi-round event: `/setup maps event:beyond-thunderdome round:r1-flagship`

This will:
- Create map channels (e.g. `bop-map01`, or `beyond-thunderdome-r1-flagship-map01`)
- Create private team threads
- Add players to their threads
- Post the thread message
- Save a state file for teardown

You can safely re-run this command. No duplicates will be created. If the
category hasn't been created yet, it'll tell you to run `/setup event` first.

---

## Teardown (Remove a Round's Map Channels)

`/teardown maps` only removes a round's map channels and threads — it never
touches the event's category or standing channels, since those usually hold
history worth keeping across rounds.

### Dry Run Teardown

See what would be deleted:

- `/teardown maps event:bop dryrun:true`
- `/teardown maps event:beyond-thunderdome round:r1-flagship dryrun:true`

---

### Teardown (Keep State File)

Deletes channels and threads created by the bot, but keeps the state file.

`/teardown maps event:bop`

Recommended if you may want to inspect or recreate later.

---

### Teardown + Delete State File (Full Reset)

Deletes everything and removes the state file.

`/teardown maps event:bop delete_state:true`

Use this only when you are sure you want a clean slate.

---

## Removing an Event Entirely

`/teardown event` deletes the event's category and its 4 standing channels
(`event-chat`, `rules`, `registered-teams`, `registration`) — use this to
fully clean up a test or finished event. It does **not** touch any round's
map channels/threads; if those still exist, run `/teardown maps` for each
round first, or the command will warn you they're still there.

- `/teardown event event:blood-pact dryrun:true` — preview what would be deleted
- `/teardown event event:blood-pact` — actually deletes the category + standing channels

Safe to re-run — if the category is already gone, it reports there's nothing
to tear down instead of erroring.

---

## Private Threads – Important Notes

- Team threads are private
- Only:
  - Assigned players
  - Admins / moderators
  - The bot
  can see them
- Regular users cannot see other teams’ threads

Admins seeing all threads is expected behaviour.

---

## Player Acknowledgement

Each team thread asks players to:

React with ✅ to acknowledge their country allocation.

This is informational and for audit purposes.

---

## Common Gotchas

- Player IDs must be Discord User IDs, not usernames
- Player IDs must be quoted strings in YAML
- Players must already be members of the Discord server
- Always run dryrun first

---

## Recommended Workflow

1. Run `/setup event` to create the category and standing channels
2. Players self-register with `/register`; staff approve teams with `/registrations approve`
3. `/registrations export` once registration closes, paste into the round's YAML with zone/map allocation
4. Run `/setup maps` with dryrun
5. Run `/setup maps`
6. Event runs
7. Run `/teardown` when finished

---

## Philosophy

This bot is designed to be:

- Safe over clever
- Config-driven
- Re-runnable without fear

If something looks wrong: dry run, fix config, run again.

---

## Deployment

Furiosa runs as a systemd service on a single Ubuntu box. See
[`deploy/README.md`](deploy/README.md) for the full setup/redeploy runbook.