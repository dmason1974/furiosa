#!/usr/bin/env node
// Lets @everyone View + Read Message History on a fixed set of read-only info
// channels (needed so Discord onboarding can list them). Only the @everyone
// overwrite on those channels is touched; every other bit and overwrite stays.
// Usage: node open-info-channels.js <env-file> [--apply] [--prod]
// Dry run by default. Reads DISCORD_TOKEN and GUILD_ID from the env file.
"use strict";

const fs = require("fs");

const API = "https://discord.com/api/v10";
const TEST_GUILD = "Fury road testing";
const PROD_GUILD = "Fury Road";
const CHANNELS = ["📚-event-rules", "⚖️-sanctions", "code-of-conduct"];
const VIEW = 1n << 10n;
const READ_HISTORY = 1n << 16n;
const OPEN = VIEW | READ_HISTORY;
// Same @everyone denies as #start-here: read-only, no reactions, no threads.
const LOCK = (1n << 11n) | (1n << 6n) | (1n << 35n) | (1n << 36n);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [envPath] = args.filter((a) => !a.startsWith("--"));
const APPLY = flags.has("--apply");
const PROD = flags.has("--prod");

const die = (m) => { console.error("ABORT: " + m); process.exit(1); };
if (!envPath) die("usage: open-info-channels.js <env-file> [--apply] [--prod]");

const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const TOKEN = env.DISCORD_TOKEN;
const GUILD_ID = env.GUILD_ID;
if (!TOKEN || !GUILD_ID) die("DISCORD_TOKEN / GUILD_ID missing from env file");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, attempt = 0) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json", "User-Agent": "DiscordBot (open-info-channels, 1.0)" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 5) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil(((j.retry_after ?? 1) + 0.25) * 1000));
    return api(method, path, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const t = await res.text();
  const d = t ? JSON.parse(t) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return d;
}

async function main() {
  const guild = await api("GET", `/guilds/${GUILD_ID}`);
  if (guild.name === PROD_GUILD) {
    if (!PROD) die(`guild is "${PROD_GUILD}" (production); --prod flag is required`);
  } else if (guild.name !== TEST_GUILD) {
    die(`guild name is "${guild.name}", expected exactly "${TEST_GUILD}"`);
  }
  console.log(`Guild: ${guild.name}  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const channels = await api("GET", `/guilds/${GUILD_ID}/channels`);
  const missing = CHANNELS.filter((n) => !channels.some((c) => c.name === n));
  if (missing.length) die("channels not found: " + missing.join(", "));

  for (const name of CHANNELS) {
    const ch = channels.find((c) => c.name === name);
    const ev = (ch.permission_overwrites || []).find((o) => o.id === guild.id);
    const allow = BigInt(ev?.allow ?? 0);
    const deny = BigInt(ev?.deny ?? 0);
    const newAllow = (allow | OPEN) & ~LOCK;
    const newDeny = (deny & ~OPEN) | LOCK;
    if (newAllow === allow && newDeny === deny) {
      console.log(`#${name} (${ch.id}): already open, no change`);
      continue;
    }
    console.log(`#${name} (${ch.id}): @everyone allow ${allow} -> ${newAllow}, deny ${deny} -> ${newDeny}`);
    if (APPLY) {
      await api("PUT", `/channels/${ch.id}/permissions/${guild.id}`, {
        type: 0, allow: newAllow.toString(), deny: newDeny.toString(),
      });
      console.log("  applied");
    }
  }
  if (!APPLY) console.log("\nDry run: nothing changed. Re-run with --apply to act.");
}

main().catch((e) => die(e.message.replace(TOKEN, "[redacted]")));
