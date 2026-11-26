# Handoff: Water Wars bot work (24 Nov 2026)

Written to continue this thread on a new machine. Read `CLAUDE.md` first (the bot's
source of truth, including "Continuing on another machine": SSH key, GitHub, noreply
email). `HANDOFF.md` covers a different thread (server review, onboarding, the
definitions page); this file covers **Water Wars**: the free-for-all event, the draw
import, the per-event rules and the test-server work. Nothing here is secret. Bot
tokens exist only in `/opt/furiosa/.env` and `/opt/furiosa-test/.env` on the Lightsail
box.

The user is **steampunk** (shows as `steampunk74` in Fury Road history). Staff in the
threads: jjtheamazing96 (lead organiser), lovetolag, davepicc.

## 1. On the new machine (in addition to CLAUDE.md's list)

- `git pull`, then `npm ci`. Node 20+ (the server runs 20; tests here used 26).
- Absolute paths in some notes say `/Users/david-mason/...`; use your own.
- Claude connectors (on the claude.ai account, so they should carry over): **Google
  Drive** to create and share sheets, and **Google Sheets** to edit them (it has to be
  switched on per chat). Without the Sheets one a sheet can only be replaced, not edited.
- Deploy to the test box (this is the standard way to ship; it never touches prod):
  `ssh furiosa-prod 'sudo APP_DIR=/opt/furiosa-test SERVICE_NAME=furiosa-test bash /opt/furiosa/deploy/bootstrap.sh'`
- Claude's memory does not travel. Its only entry: the user's handle is steampunk.

## 2. Where things stand (read from the servers on 24 Nov)

**Git:** `main` = `origin/main`. Water Wars commits, oldest first: `5a53ef1` free-for-all
theatres + `#looking-for-team` + configs, `5d3b147` `/setup draw` + `/draw` deprecated +
thread-only rounds, `1254b34` crash fix + chunked `/registrations list`, `fc9caa5`
natural team sort, `79b4b21` per-event `rules.md` + `map.png` + `r1-map2` channel naming,
`8f6224a` ansi colours for `#zones`, then `b48a065` to `1ea6c5a` the rules layout work
(final layout = emoji headers + diamond bullets, five sections, spacer line).

**Deployed:** furiosa-test runs `1ea6c5a` (active). **The prod bot is untouched** (still
`293327e`). One side effect: bot startup runs the schema init on *both* databases, so
the additive column `event_rules_index.event_rules_message_ids` now exists in prod's DB too.

**Test server, `water-wars` category (observed):**
- 7 standing channels plus `#water-wars-r1-map01` and `#water-wars-r1-map02`
  (8 private threads each, named after the drawn teams).
- `#rules`: 5 messages (Format, Win Condition, Prizes, Schedule, Rules), each ending with a
  spacer line. `#zones`: 13 messages (ansi legend, an image, Zone 1 to 8). `#registered-teams`:
  2 messages. `#looking-for-team`: empty.
- Test DB: **80 registrations, all approved, 16 teams** (`team1` to `team16`; 15 are
  fake players with ids like `000000000000000302`, `team2` also holds the real test
  account). Zones imported: 8. Draw: `r1-map1` 8 assigned, `r1-map2` 8, `r2` none.
- The two draft posts in `#upcoming-event` (threads `1569817151915692175` and
  `1569817153035567146`) are **outdated** (duel format, colour team names, AI lists).

**What was verified how:** logic was unit-tested with mocks (draw import, rules splitting,
publishing, naming). The user ran the commands on the test server and reported the
colours look right. I have **not** seen: a second run of `/setup draw` and `/setup maps`
proving "unchanged/reused", the `/setup draw` error paths against the real bot, or the
full `/register` flow end to end (a real second account was never available).

## 3. What exists (details are in CLAUDE.md under Commands)

`/setup draw` (sheet import; `/draw` is deprecated), `#looking-for-team`, free-for-all
theatres (2+ teams per theatre), thread-only rounds `r1-map1` / `r1-map2` / `r2`,
`r3-final` still a hand-written config with empty pools, `src/config/water-wars/rules.md`
published by `/setup event`, `map.png` posted to `#zones`, ansi helpers
(`ansiBlock` / `renderAnsiMarkup`), the crash fix (`handleInteraction` + `.catch`).

## 4. Decisions already made (don't re-ask)

- **Event:** key `water-wars`, Capture the Flagship, battle royale. 16 teams of 5. Round 1 =
  2 maps of 8 teams, round 2 = 1 map of 8, final = 1 map of 4 across the whole ocean. 4 teams
  per ocean (Pacific Theatre, Indo-Atlantic Theatre); the last 2 flagships per ocean advance;
  early finish at 2 flagships; the final is last flagship standing.
- **Time:** 6-day truce (map opens on a Sunday), war the following Saturday, 8 hours.
- **Tiebreaker:** surviving teams ranked by enemy ships sunk, weighted by ship class
  (weights and counting rules still open). The original event used naval units left (planned
  as VP gain), which caused patrol-boat spam.
- **Rules:** no bombardment of cities; no invading provinces; no capturing non-homeland
  countries; ships attackable anywhere at sea and in port; flagship stays at sea in its
  theatre, out of bounds in the Caspian, Black Sea, Great Lakes, Baltic, Persian Gulf, Red Sea
  and rivers/lakes; ships may move in to reinforce; satellites and AIP banned, naval patrol
  aircraft and AWACS allowed. Prizes are gold and SC only (no officer prize).
- **Countries:** 8 port-drafted pools of 5 (zones 1 to 4 Pacific, 5 to 8 Indo-Atlantic).
  All 22 other countries are AI and non-conquerable for testing (the sheet has no AI rows).
- **Process:** the draw is a Google Sheet filled live and imported (`/setup draw`); zones
  sheets are **one tab** (the bot takes the first tab, no `gid` needed); coloured bot text uses
  `ansi` blocks; rules style is emoji headers and diamond bullets; the Rules section stays a
  short list and links the definitions page instead of repeating it.

## 5. Next steps, in order

1. Prove idempotency on the test server: run `/setup draw` and `/setup maps` for
   `r1-map1` and `r1-map2` a second time (expect "unchanged" and "reused"), then try an
   error sheet (unapproved team, duplicate zone, wrong round name).
2. Test the real `/register` to `/registrations approve` to `#registered-teams` to
   `/unregister` flow. It has not been re-verified since the Postgres move.
3. Regenerate the theatre map with the Baltic, Persian Gulf and Red Sea marked (the rules list
   them; `map.png` does not).
4. Redo the two `#upcoming-event` drafts for the free-for-all format once dates exist, and
   create the Discord scheduled event.
5. `r3-final`: decide which countries the finalists play, then give it real pools (or move it
   to the DB path).
6. Staff decisions still open (kept out of the channel on purpose; full list in CLAUDE.md):
   prize amounts, registration/draw/war dates and start time, tiebreaker weights and kill
   counting, declaring war on every team, air units/missiles/coastal batteries vs ships,
   flyover/territorial waters during the truce, sanctions for the event's own rules.
7. **Coordinate with the other session:** it plans to replace `publishRulesIndex` (the
   definitions-channel index) with one pinned pointer to the definitions page, once the other
   server owners approve. `rules.md` already links that page, so the two fit.
8. **Production is not started.** Going live means deploying these commits to prod and the user
   running `/setup event` there. Only with the user's explicit go-ahead.
9. Housekeeping: no clean-up script exists for the 80 fake registrations on the test DB;
    the Drive sheet `water-wars-zones-no-ai` is redundant; `/registrations export` still builds
    one code block and fails over 2000 characters.

## 6. Links and ids (no secrets)

| What | Id / URL |
|---|---|
| Test guild / prod guild | `1209791658082705418` / `1464807025815978110` |
| Drive folder `furiosa-events` | `1JvJZ3ASAmrzTgMNmbrl7ZNX94ZPG22SC` |
| Sheet `water-wars-zones` (tab `Zones`, shared view-only by link) | `1Z22zNrevW3vL8ru6D03WDJKY2vbMb4tUCyHa0SP8nSI` |
| Sheet `water-wars-draw` (tab `Draw`, shared view-only by link) | `1icmrxslGtu7-VsS866gaRVNfMm-0LRnHFBGH003l-Yg` |
| Sheet `water-wars-zones-no-ai` (private, redundant) | `1j8GapSYoZ4TdRL4W9rMLQfcQyjKjz6vG3MXy_U92r0Y` |
| Reference data, "WW3 Based Games" (tab "World War 3", gid `1489317909`) | `1NtXhSArSxAc3uANUHqEL4HYU51YsJedvVWJwZWWr-Hw` |
| Definitions page | https://dmason1974.github.io/furiosa/definitions.html |

The reference sheet is a superset: 64 countries and 374 cities with start/max production,
ports, VP, doctrine and resources. The pools were balanced on start and max production,
ports and VP. It has no border data, so how exposed each team is to AI neighbours was
never measured.

## 7. Lost or only on the old Mac

- The scratch folder was cleared several times. **Gone:** the theatre-map generator (Python,
  Pillow, Natural Earth `ne_110m_land`, `ne_50m_lakes`, `ne_110m_rivers_lake_centerlines`),
  the 16-team bracket image, and the message-history dumps. `map.png` is committed. The
  boundaries were: Pacific to 60°N, Indo-Atlantic to 70°N, split at 80°E, south limit 56°S
  with the Cape Horn split at 68°W, Panama closed. Rebuild the generator if the map changes.
- `/tmp/refsheet` on the old Mac is a leftover download (harmless).

## 8. Working agreements (the user's)

- **Test server only.** Never change the prod bot or the real server without being asked.
- **Dry run first**, show the plan, then apply. The user runs the slash commands; say exactly
  what to run.
- **Ask before** every commit, push and deploy, each time, and before deleting anything.
- Never print or log a token. Read prod Discord only as CLAUDE.md describes, read-only.
- Report what was verified and what was not. Do not claim a Discord behaviour works until it
  has run on the real bot.

## 9. Gotchas learned here

- A `fix` code block renders as plain text. Use `ansi` with explicit colours.
- Discord trims trailing blank lines and merges consecutive bot messages, hence the U+2800
  spacer line in `publishEventRules`.
- Handlers that `return interaction.editReply(...)` without `await` escape the try/catch.
  `handleInteraction` now has a `.catch`, but keep awaiting.
- A sheet created by uploading a CSV has a random first-tab `gid`; one tab per sheet avoids it.
- The Edit tool can write an escape such as `⠀` as the literal invisible character.
  Check with a grep after editing.
