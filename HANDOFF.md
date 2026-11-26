# Handoff: server review and onboarding work (24 Nov 2026)

Written to continue this work on a new machine. Read `CLAUDE.md` first (it is
the bot's source of truth); this file covers the *server review* thread: the
`#start-here` post, onboarding, the definitions page and the fix list in
`docs/server-review.md`. Nothing here is secret: bot tokens live only in
`/opt/furiosa/.env` (prod) and `/opt/furiosa-test/.env` (test) on the Lightsail
box. There is no local `.env`.

## 1. Set up the new machine

- [ ] Node 20+, `git`, `gh` (`gh auth login`), Claude Code.
- [ ] SSH: copy `~/.ssh/id_ed25519_furiosa` (Lightsail box) and the personal GitHub
      key, plus the `~/.ssh/config` entries for the host aliases **`furiosa-prod`**
      and **`github.com-personal`**. Check: `ssh furiosa-prod 'echo ok'`.
- [ ] `git clone git@github.com-personal:dmason1974/furiosa.git && cd furiosa && npm install`
- [ ] Git identity must be the GitHub **noreply** address (see CLAUDE.md,
      "Known constraints"), or pushes are rejected.
- [ ] Claude's per-machine memory (`~/.claude/projects/.../memory/`) does not
      travel. The only entry is the user's Discord handle (steampunk); recreate it
      if wanted. Everything else is in `CLAUDE.md` and this file.
- [ ] GitHub Pages serves `docs/` (https://dmason1974.github.io/furiosa/):
      `server-review.html` and `definitions.html`. Changes appear after a push.

## 2. Servers and how the scripts run

| | Test | Prod |
|---|---|---|
| Server | Fury road testing (guild 1209791658082705418) | Fury Road (guild 1464807025815978110) |
| Env file on box | `/opt/furiosa-test/.env` | `/opt/furiosa/.env` |
| `#start-here` | channel 1571243772464074912, pinned message 1571243778264801471 | channel 1571340734119022652, pinned message 1571340735939219579 |

Scripts (all dry-run by default, `--apply` to act; each aborts unless the guild
name matches, and prod needs `--prod`):

```
scp scripts/start-here.js server/start-here.md furiosa-prod:/tmp/
ssh furiosa-prod 'sudo node /tmp/start-here.js /opt/furiosa-test/.env /tmp/start-here.md [--apply]'
ssh furiosa-prod 'rm -f /tmp/start-here.js /tmp/start-here.md'
```

- `scripts/start-here.js` creates/edits `#start-here` and its one pinned message
  from `server/start-here.md`. `{{channel-name}}` placeholders resolve by exact
  channel name; `{{GUILD_ID}}` is filled in. It reports "moved to position 0" on
  every run; that is cosmetic.
- `scripts/open-info-channels.js` makes `code-of-conduct`, `📚-event-rules` and
  `⚖️-sanctions` read-only and visible to @everyone (needed for onboarding).
- Bots never print the token. Never put it on a command line.

## 3. Where things stand

> **Update, 26 Nov 2026:** the new `#start-here` is live on prod, the `event draw`
> stage channel exists, and the definition channels and `#sanctions` are replaced by
> the web page. This supersedes open items 1 and 3 below and the older prod and
> `#rulebook-draft` notes in this section. See CLAUDE.md, "Definitions & sanctions
> web page". `scripts/rulebook-draft.js` has been deleted.

**Prod (Fury Road)**
- Onboarding is ON: one required pings question ("Yes" gives War Boy + Wastelanders,
  "Not right now" gives War Boy), `#start-here` and four other default channels,
  Server Guide with welcome sign, 3 to-dos and 4 resources. Tested with a fresh account.
- Carl-bot greeting and autorole are off (the integration still needs removing).
  ChannelBot, sesh and Reaction Roles are gone. Appy stays (support tickets).
  `#pings-for-update`, `#reception`, `#event discussion` are deleted.
- `#start-here` is live but is the **original version** (1,430 chars, never
  edited). The reworked wording is NOT on prod yet.
- The three info channels are open to @everyone (read-only). Verification level
  is High (10 min); the user was unsure whether that blocks onboarding for new members.

**Test (Fury road testing)**
- Carries the final `#start-here` wording: six steps (announced, show interest,
  sign up with `/register` + `/unregister` on their own lines, teams and starts,
  team thread, play), `#looking-for-team` for solos, link to the stage channel
  `event draw` (id 1571880333593415801), definitions page link.
- `#rulebook-draft` (id 1571351344881729606) holds the consolidated definitions
  for staff review (staff-only).

## 4. Open items, in order

1. **Prod `#start-here`:** create a **stage channel named exactly `event draw`** on
   prod (the script aborts on a missing name), dry-run `--prod`, show the user,
   then `--apply`. Then tick "Pick one sign-up method" in `docs/server-review.md`.
2. **Discord Events** for the Water Wars dates (dates not yet decided; see
   `src/config/water-wars/rules.md` Schedule). Last "Do first" fix-list item.
3. **Fix-list item "Merge the 14 definition channels into one #rulebook":**
   looks superseded by the live definitions page (`docs/definitions.md`). The user
   decides whether to tick it. **Copy-edit/market blocking** is still open: the page
   keeps the original "moved there by 0.1 steps" wording. Open staff questions
   (market blocking, Sacred Ground holy cities, grouping, images) are in the test
   draft and `docs/definitions-test.md`.
4. **`#announcements` dead links** (fix-list "per-event links") and `@everyone` use:
   content/habit jobs, nothing built.
5. **Announce Channels & Roles to existing members** (they never saw the pings question).
6. **Water Wars bot work** is being done in a separate session (free-for-all
   theatres, `/setup draw`, `looking-for-team` standing channel, per-event `rules.md`);
   see CLAUDE.md. It is mostly unit-tested only, not yet run on the real bot.
   `/register` -> approve -> `#registered-teams` -> `/unregister` has not been
   re-verified since the Postgres move.

## 5. Working rules the user set

- **Test server first**, then prod, and only with the user's explicit go-ahead.
- **Dry run first**, show the plan, apply only when told.
- **Ask before** committing, pushing, or deleting channels (check contents first).
- Never print or log the token; do not touch Carl-bot settings or other bots.
- Do not tick a fix-list item until it is live on prod. Elite maps was an
  event design choice, not a rule; that item was dropped.
