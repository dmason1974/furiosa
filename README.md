# Furiosa Event Bot – Usage Guide

Furiosa is used to create and manage event map channels and private team threads from a YAML configuration file.

It is safe, repeatable, and staff-only.

---

## Who Can Use This Bot

Only users with the Event Staff role can run commands.

If you do not have the role, the bot will ignore the command.

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

Each event is defined by two files:

- `event-key.yml` – structure, maps, teams, players
- `event-key.thread.md` – message posted into each team thread

The event key is used in commands.

Example:
`bt-r1-flagship`

---

## Creating an Event

### Step 1: Dry Run (Always Do This First)

Shows what would be created without making any changes.

Command:
`/setup config: bt-r1-flagship dryrun:true`

Use this to:
- Validate the YAML
- Check channel and thread names
- Catch mistakes safely

---

### Step 2: Create Channels and Threads

Once the dry run looks correct:

Command:
`/setup config: bt-r1-flagship`

This will:
- Create map channels (e.g. `bt-r1-flagship-map01`)
- Create private team threads
- Add players to their threads
- Post the thread message
- Save a state file for teardown

You can safely re-run this command. No duplicates will be created.

---

## Re-running Setup

You may re-run setup at any time:

`/setup config: bt-r1-flagship`

The bot is idempotent:
- Existing channels are reused
- Existing threads are reused
- Nothing is duplicated

This is safe.

---

## Teardown (Remove an Event)

### Dry Run Teardown

See what would be deleted:

`/teardown config: bt-r1-flagship dryrun:true`

---

### Teardown (Keep State File)

Deletes channels and threads created by the bot, but keeps the state file.

`/teardown config: bt-r1-flagship`

Recommended if you may want to inspect or recreate later.

---

### Teardown + Delete State File (Full Reset)

Deletes everything and removes the state file.

`/teardown config: bt-r1-flagship delete_state:true`

Use this only when you are sure you want a clean slate.

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

1. Update YAML and Markdown
2. Run setup with dryrun
3. Run setup
4. Event runs
5. Run teardown when finished

---

## Philosophy

This bot is designed to be:

- Safe over clever
- Config-driven
- Re-runnable without fear

If something looks wrong: dry run, fix config, run again.