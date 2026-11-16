#!/usr/bin/env node
// Posts a staff-only draft of the consolidated rulebook to the TEST server.
// Usage: node rulebook-draft.js <env-file> <md-file> [--apply]
// Dry run by default. Test server only: aborts unless the guild is exactly
// "Fury road testing". Never prints the token.
"use strict";

const fs = require("fs");

const API = "https://discord.com/api/v10";
const TEST_GUILD = "Fury road testing";
const CHANNEL_NAME = "rulebook-draft";
const STAFF_ROLES = ["GO", "Road Marshal", "Mechanic"];
const VIEW = 1n << 10n, SEND = 1n << 11n, MANAGE_MSGS = 1n << 13n, HISTORY = 1n << 16n;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const [envPath, mdPath] = args.filter((a) => !a.startsWith("--"));
const die = (m) => { console.error("ABORT: " + m); process.exit(1); };
if (!envPath || !mdPath) die("usage: rulebook-draft.js <env-file> <md-file> [--apply]");

const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const TOKEN = env.DISCORD_TOKEN, GUILD_ID = env.GUILD_ID;
if (!TOKEN || !GUILD_ID) die("DISCORD_TOKEN / GUILD_ID missing from env file");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, attempt = 0) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json", "User-Agent": "DiscordBot (rulebook-draft, 1.0)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 5) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil(((j.retry_after ?? 1) + 0.25) * 1000));
    return api(method, path, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function main() {
  const guild = await api("GET", `/guilds/${GUILD_ID}`);
  if (guild.name !== TEST_GUILD) die(`guild is "${guild.name}"; this script only runs on "${TEST_GUILD}"`);
  console.log(`Guild: ${guild.name}  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const parts = fs.readFileSync(mdPath, "utf8").split(/^<!-- split -->\s*$/m).map((s) => s.trim()).filter(Boolean);
  const tooLong = parts.map((p, i) => [i + 1, p.length]).filter(([, n]) => n > 2000);
  if (tooLong.length) die("message part(s) over 2000 chars: " + tooLong.map(([i, n]) => `#${i}=${n}`).join(", "));
  console.log("Message parts:", parts.map((p) => p.length).join(", "), "characters");

  const me = await api("GET", "/users/@me");
  const roles = await api("GET", `/guilds/${GUILD_ID}/roles`);
  const channels = await api("GET", `/guilds/${GUILD_ID}/channels`);
  const staff = STAFF_ROLES.map((n) => roles.find((r) => r.name === n)).filter(Boolean);
  if (staff.length !== STAFF_ROLES.length) die("staff role(s) missing: " + STAFF_ROLES.filter((n) => !roles.some((r) => r.name === n)).join(", "));

  const overwrites = [
    { id: guild.id, type: 0, allow: "0", deny: VIEW.toString() },
    ...staff.map((r) => ({ id: r.id, type: 0, allow: (VIEW | HISTORY).toString(), deny: "0" })),
    { id: me.id, type: 1, allow: (VIEW | SEND | MANAGE_MSGS | HISTORY).toString(), deny: "0" },
  ];

  let channel = channels.find((c) => c.name === CHANNEL_NAME && c.type === 0);
  console.log(channel ? `Channel #${CHANNEL_NAME} exists (${channel.id})` : `Would create #${CHANNEL_NAME} (hidden from @everyone; visible to ${STAFF_ROLES.join(", ")})`);

  let mine = [];
  if (channel) {
    const ms = await api("GET", `/channels/${channel.id}/messages?limit=100`);
    mine = ms.filter((m) => m.author.id === me.id).reverse();
  }
  const sameCount = mine.length === parts.length;
  console.log(sameCount ? `Would edit ${mine.length} existing message(s) in place` : `Would ${mine.length ? "delete " + mine.length + " old message(s) and " : ""}post ${parts.length} new message(s)`);
  if (!APPLY) return console.log("\nDry run: nothing changed. Re-run with --apply to act.");

  const changes = [];
  if (!channel) {
    channel = await api("POST", `/guilds/${GUILD_ID}/channels`, { name: CHANNEL_NAME, type: 0, permission_overwrites: overwrites, topic: "DRAFT rulebook for staff review. Test server only." });
    changes.push("created channel");
  }
  if (sameCount) {
    for (let i = 0; i < parts.length; i++) {
      if (mine[i].content !== parts[i]) {
        await api("PATCH", `/channels/${channel.id}/messages/${mine[i].id}`, { content: parts[i], flags: 4 });
        changes.push(`edited message ${i + 1}`);
      }
    }
  } else {
    for (const m of mine) await api("DELETE", `/channels/${channel.id}/messages/${m.id}`);
    for (const p of parts) await api("POST", `/channels/${channel.id}/messages`, { content: p, flags: 4, allowed_mentions: { parse: [] } });
    changes.push(`posted ${parts.length} messages`);
  }
  console.log(`\nChannel ID: ${channel.id}`);
  console.log(changes.length ? "Changes: " + changes.join("; ") : "No changes");
}

main().catch((e) => die(e.message.replace(TOKEN, "[redacted]")));
