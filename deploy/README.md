# Deploying Furiosa

Furiosa runs as a systemd service on a single Ubuntu box (AWS Lightsail).
This directory holds the artifacts needed to (re)build that box from scratch.

- `furiosa.service.tmpl` — systemd unit template, rendered by `bootstrap.sh`
  (substituting `{{APP_USER}}`/`{{APP_DIR}}`) into `/etc/systemd/system/<service-name>.service`.
  Runs the bot as the non-root `furiosa` user from `/opt/furiosa` by default,
  auto-restarts on crash, starts on boot.
- `bootstrap.sh` — idempotent setup script. Safe to re-run: first run
  bootstraps a fresh box, later runs (e.g. after `git push`) redeploy new code.
  Accepts `APP_USER`/`APP_DIR`/`REPO_URL`/`NODE_MAJOR`/`SERVICE_NAME` env var
  overrides (all default to today's prod values) so the same script can also
  stand up a second, independent instance — see "Running a second (test)
  instance" below.

## A. Lightsail console (manual)

1. Create instance: **OS Only → Ubuntu 24.04 LTS (Noble)**, region **us-east-1**.

   **Optional — launch script:** Lightsail's create-instance page has an
   "Add launch script" field (runs once via cloud-init on first boot, as
   root). Paste this in to have the box bootstrap itself instead of doing
   step 8 by hand:
   ```bash
   #!/bin/bash
   curl -fsSL https://raw.githubusercontent.com/dmason1974/furiosa/main/deploy/bootstrap.sh | bash
   ```
   This installs Node, creates the `furiosa` user, clones the repo, creates a
   placeholder `.env` (no real secrets yet), installs deps, and starts the
   systemd service. It'll crash-loop until you drop in a real `.env` (step 9)
   — that's expected.
2. Size: use the **1 GB RAM** plan or larger. The previous instance was on
   512 MB and went unresponsive (likely OOM) — too tight for Node + a
   long-lived process with a Postgres connection pool.
3. Attach a **static IP** (Networking tab) and associate it with the
   instance. This avoids the public IP changing across stop/start and keeps
   SSH/DNS stable. It's free while attached to a running instance.
4. Leave the firewall at its default (SSH only). The bot has no inbound
   listener — it only makes outbound connections to the Discord gateway and
   to Postgres — so no other inbound port is needed.
5. Create or attach an SSH key pair for access.

## B. Discord Developer Portal (manual, easy to forget)

6. Confirm the **Server Members Intent** (privileged) is still toggled on
   for the bot application. The bot requests `GatewayIntentBits.GuildMembers`
   at login (`src/index.js`); without this toggle the gateway connection is
   rejected. Unrelated to the AWS rebuild, but worth checking since this is a
   from-scratch setup.

## C. Getting secrets onto the box

7. Locally, copy `.env.example` to a scratch file and fill in real values:
   `DISCORD_TOKEN`, `GUILD_ID`, `EVENT_STAFF_ROLE_ID`,
   `PGHOST`, `PGPORT`, `PGDATABASE_PROD`, `PGDATABASE_TEST`, `PGUSER`,
   `PGPASSWORD`. Never commit this file.

   Postgres still points at the existing eu-west-2 RDS instance
   (`fury-road-db.cpimu62k2scs.eu-west-2.rds.amazonaws.com`) — that hasn't
   moved and isn't required for `/setup`/`/teardown` to work, only for the
   in-progress matchmaking/ELO commands (`/lobby`, `/matchmake`,
   `/create_match`, `/record_result`, `/season`, `/league`).

8. **Skip this step if you used the launch script in A.1** — the repo is
   already cloned. Otherwise, get it onto the box once, manually, so
   `bootstrap.sh` exists to run:
   ```
   sudo git clone https://github.com/dmason1974/furiosa.git /opt/furiosa
   ```
9. Copy your filled-in env file directly to `/opt/furiosa/.env`, overwriting
   the launch script's placeholder if you used one:
   ```
   scp -i <lightsail-key>.pem local-real.env ubuntu@<static-ip>:/tmp/furiosa.env
   sudo mv /tmp/furiosa.env /opt/furiosa/.env
   sudo chmod 600 /opt/furiosa/.env
   ```
10. Run bootstrap (or just `sudo systemctl restart furiosa` if the launch
    script already ran it and the only thing that changed is `.env`):
    ```
    sudo bash /opt/furiosa/deploy/bootstrap.sh
    ```

## D. Verify

11. `sudo systemctl status furiosa` → should show `active (running)`.
12. `sudo journalctl -u furiosa -f` → confirm Discord login succeeds and the
    bot shows online in the server.
13. In Discord, run `/setup config:<existing-event-key> dryrun:true` to
    confirm end-to-end command handling works.

## Redeploying later

After pushing new code to `main`, just re-run bootstrap on the box:

```
sudo bash /opt/furiosa/deploy/bootstrap.sh
```

It pulls latest, reinstalls dependencies, and restarts the service. It will
never touch an existing `.env`.

## Running a second (test) instance on the same box

To iterate on features (e.g. registration) without risking the live Fury Road
server, run a second fully independent instance pointed at a separate Discord
test server + bot application. It reuses the same `furiosa` system user but
gets its own checkout, `.env`, `data/`, and systemd unit — `bootstrap.sh`'s
env var overrides make this the same script, not a fork of it.

1. First time only, install it:
   ```
   sudo APP_DIR=/opt/furiosa-test SERVICE_NAME=furiosa-test \
     bash /opt/furiosa/deploy/bootstrap.sh
   ```
   (Omitting `APP_USER` reuses the existing `furiosa` user/home; omitting
   `REPO_URL`/`NODE_MAJOR` reuses prod's values — override only if the test
   checkout genuinely needs a different fork/branch or Node version.)
2. This clones the repo fresh into `/opt/furiosa-test`, creates
   `/opt/furiosa-test/.env` from `.env.example` (a placeholder, since the dir
   is new), and installs+enables+starts a unit named `furiosa-test.service`.
3. Fill in `/opt/furiosa-test/.env` with the **test server's** own
   `DISCORD_TOKEN`, `GUILD_ID`, `EVENT_STAFF_ROLE_ID`, `WARBOY_ROLE_ID`,
   `EVENT_APPLICATIONS_CHANNEL_ID` — a separate bot application registered
   against the test Discord server (own token, Server Members Intent
   enabled, invited to that server). `PGHOST`/`PGDATABASE_*`/`PGUSER`/
   `PGPASSWORD` can simply mirror prod's `.env` values; the DB isn't
   exercised by registration/setup/teardown, and matchmaking commands (which
   do touch it) already fail non-fatally.
4. `sudo chmod 600 /opt/furiosa-test/.env` then `sudo systemctl restart furiosa-test`.
5. Verify: `sudo systemctl status furiosa-test`, `sudo journalctl -u
   furiosa-test -f` (confirm gateway login), then in the test Discord server
   exercise `/setup event ... dryrun:true`, `/register`, `/registrations`,
   `/unregister`.

**Redeploying the test instance later**, run from within the test checkout:
```
sudo APP_DIR=/opt/furiosa-test SERVICE_NAME=furiosa-test \
  bash /opt/furiosa-test/deploy/bootstrap.sh
```

**Redeploying prod is unchanged** — still just `sudo bash
/opt/furiosa/deploy/bootstrap.sh` with no env vars, exercising the same
defaults as before this feature existed.

## Known risks / follow-ups (not addressed by this setup)

- **`data/<event>/category.json`, `data/<event>[/<round>]/state.json`, and `data/<event>/registrations.json` are local-only and not backed up.** These files track the event's category/standing channels, each round's map channels/threads, and player registrations/approvals, for `/setup maps`, `/teardown`, `/register`, and `/registrations`. They live outside `src/config/` deliberately (config stays a pure, git-managed tree; `data/` is the bot's own generated state) and are gitignored, but that also means if this box is ever lost again, that tracking state is lost with it — the same failure mode as the previous incident. `registrations.json` is arguably the highest-stakes of the three, since it holds live player sign-ups rather than just regenerable tracking IDs. A future fix could sync `data/` to S3 on a schedule, or move this state into the existing RDS Postgres instance.
- **`Restart=on-failure`** won't restart the service on a clean exit (e.g. an
  unhandled rejection handler that calls `process.exit(0)`). Switch to
  `Restart=always` in `furiosa.service.tmpl` if that turns out to matter.
