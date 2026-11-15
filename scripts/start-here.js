#!/usr/bin/env node
// Creates/updates the #start-here channel and its single pinned message.
// Usage: node start-here.js <env-file> <markdown-file> [--apply] [--prod]
// Dry run by default. Reads DISCORD_TOKEN and GUILD_ID from the env file;
// the token is never printed.
"use strict";

const fs = require("fs");

const API = "https://discord.com/api/v10";
const TEST_GUILD = "Fury road testing";
const PROD_GUILD = "Fury Road";
const CHANNEL_NAME = "start-here";
const TEMPLATE_CHANNEL = "code-of-conduct";

// Permission bits
const P = {
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  ReadMessageHistory: 1n << 16n,
  AddReactions: 1n << 6n,
  ManageChannels: 1n << 4n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  SendMessagesInThreads: 1n << 38n,
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [envPath, mdPath] = args.filter((a) => !a.startsWith("--"));
const APPLY = flags.has("--apply");
const PROD = flags.has("--prod");

function die(msg) {
  console.error("ABORT: " + msg);
  process.exit(1);
}

if (!envPath || !mdPath) die("usage: start-here.js <env-file> <md-file> [--apply] [--prod]");

function parseEnv(path) {
  const out = {};
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = parseEnv(envPath);
const TOKEN = env.DISCORD_TOKEN || env.BOT_TOKEN || env.TOKEN;
const GUILD_ID = env.GUILD_ID || env.DISCORD_GUILD_ID;
if (!TOKEN) die("no DISCORD_TOKEN found in env file");
if (!GUILD_ID) die("no GUILD_ID found in env file");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, attempt = 0) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bot " + TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (start-here-script, 1.0)",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 5) {
    const j = await res.json().catch(() => ({}));
    await sleep(Math.ceil(((j.retry_after ?? 1) + 0.25) * 1000));
    return api(method, path, body, attempt + 1);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${typeof data === "string" ? data : JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const flagNames = (bits) =>
  Object.entries(P).filter(([, b]) => (bits & b) === b).map(([n]) => n).join(", ") || "(none)";

async function main() {
  const guild = await api("GET", `/guilds/${GUILD_ID}`);
  if (guild.name === PROD_GUILD) {
    if (!PROD) die(`guild is "${PROD_GUILD}" (production); --prod flag is required`);
  } else if (guild.name !== TEST_GUILD) {
    die(`guild name is "${guild.name}", expected exactly "${TEST_GUILD}"`);
  }
  console.log(`Guild: ${guild.name} (${guild.id})  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  const me = await api("GET", "/users/@me");
  const channels = await api("GET", `/guilds/${GUILD_ID}/channels`);

  // Bot permission check (guild-level)
  const member = await api("GET", `/guilds/${GUILD_ID}/members/${me.id}`);
  const roles = await api("GET", `/guilds/${GUILD_ID}/roles`);
  const everyoneRole = roles.find((r) => r.id === guild.id);
  let perms = BigInt(everyoneRole.permissions);
  for (const r of roles) if (member.roles.includes(r.id)) perms |= BigInt(r.permissions);
  const isAdmin = (perms & (1n << 3n)) !== 0n;
  if (!isAdmin) {
    const missing = [];
    if ((perms & P.ManageChannels) === 0n) missing.push("Manage Channels");
    if ((perms & P.ManageMessages) === 0n) missing.push("Manage Messages");
    if (missing.length) die(`bot lacks guild permission(s): ${missing.join(", ")}. Not working around it.`);
  }

  // Resolve placeholders
  // {{GUILD_ID}} is replaced first so it isn't treated as a channel name.
  const raw = fs.readFileSync(mdPath, "utf8").replace(/\s+$/, "").replaceAll("{{GUILD_ID}}", guild.id);
  const names = [...new Set([...raw.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]))];
  const byName = new Map(channels.map((c) => [c.name, c]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) die("channel names did not resolve:\n  " + missing.join("\n  "));
  const content = raw.replace(/\{\{([^}]+)\}\}/g, (_, n) => `<#${byName.get(n).id}>`);
  if (content.length > 2000) die(`message is ${content.length} chars (limit 2000)`);

  // Template channel permissions
  const template = channels.find((c) => c.name === TEMPLATE_CHANNEL);
  if (!template) die(`template channel "${TEMPLATE_CHANNEL}" not found`);

  const overwrites = (template.permission_overwrites || []).filter((o) => o.id !== me.id).map((o) => ({
    id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny),
  }));
  let ev = overwrites.find((o) => o.id === guild.id);
  if (!ev) { ev = { id: guild.id, type: 0, allow: 0n, deny: 0n }; overwrites.push(ev); }
  const denied = P.SendMessages | P.AddReactions | P.CreatePublicThreads | P.CreatePrivateThreads;
  ev.deny |= denied;
  ev.allow &= ~denied;
  // @everyone can read (needed for onboarding default channels), never post.
  const readable = P.ViewChannel | P.ReadMessageHistory;
  ev.deny &= ~readable;
  ev.allow |= readable;
  overwrites.push({
    id: me.id, type: 1, deny: 0n,
    allow: P.ViewChannel | P.SendMessages | P.ManageMessages | P.ReadMessageHistory,
  });
  const overwritesPayload = overwrites.map((o) => ({
    id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString(),
  }));

  // Existing channel: text (type 0), no parent
  const existing = channels.find((c) => c.name === CHANNEL_NAME && c.type === 0 && !c.parent_id);
  const topPos = Math.min(...channels.filter((c) => !c.parent_id).map((c) => c.position));
  const top = channels.filter((c) => !c.parent_id).sort((a, b) => a.position - b.position)[0];

  console.log("\n== Channel ==");
  console.log(existing ? `Update existing #${CHANNEL_NAME} (${existing.id}), currently position ${existing.position}` : `Create #${CHANNEL_NAME} (text, no category)`);
  console.log(`Target position: 0 (current top-level channel at top: #${top.name}, position ${topPos})`);
  console.log(`Permission overwrites (copied from #${TEMPLATE_CHANNEL}, with changes):`);
  for (const o of overwrites) {
    const label = o.id === guild.id ? "@everyone" : o.id === me.id ? "bot (self)" : `${o.type === 0 ? "role" : "member"} ${o.id}${o.type === 0 ? " (" + (roles.find((r) => r.id === o.id)?.name ?? "?") + ")" : ""}`;
    console.log(`  ${label}\n    allow: ${flagNames(o.allow)}\n    deny:  ${flagNames(o.deny)}`);
  }

  // Find existing pinned bot message
  let existingMsg = null;
  if (existing) {
    const pins = await api("GET", `/channels/${existing.id}/pins`);
    existingMsg = pins.find((m) => m.author.id === me.id) || null;
  }
  console.log("\n== Message ==");
  console.log(existingMsg
    ? `Edit pinned message ${existingMsg.id}${existingMsg.content === content ? " (content already identical: no change)" : ""}`
    : "Send new message and pin it");
  console.log(`Length: ${content.length}/2000\n----- BEGIN MESSAGE -----\n${content}\n----- END MESSAGE -----`);

  if (!APPLY) {
    console.log("\nDry run: nothing changed. Re-run with --apply to act.");
    return;
  }

  const changes = [];
  let channel = existing;
  if (!channel) {
    channel = await api("POST", `/guilds/${GUILD_ID}/channels`, {
      name: CHANNEL_NAME, type: 0, permission_overwrites: overwritesPayload, position: 0,
    });
    changes.push("created channel");
  } else {
    const cur = JSON.stringify([...(existing.permission_overwrites || [])].map((o) => [o.id, o.type, String(o.allow), String(o.deny)]).sort());
    const want = JSON.stringify([...overwritesPayload].map((o) => [o.id, o.type, o.allow, o.deny]).sort());
    if (cur !== want) {
      await api("PATCH", `/channels/${channel.id}`, { permission_overwrites: overwritesPayload });
      changes.push("updated permission overwrites");
    }
  }

  // Position 0, top-level only
  const fresh = await api("GET", `/guilds/${GUILD_ID}/channels`);
  const me2 = fresh.find((c) => c.id === channel.id);
  const topLevel = fresh.filter((c) => !c.parent_id).sort((a, b) => a.position - b.position);
  if (topLevel[0].id !== channel.id || me2.position !== 0) {
    await api("PATCH", `/guilds/${GUILD_ID}/channels`, [{ id: channel.id, position: 0, parent_id: null }]);
    changes.push("moved to position 0");
  }

  let msg = existingMsg;
  if (msg) {
    if (msg.content !== content) {
      msg = await api("PATCH", `/channels/${channel.id}/messages/${msg.id}`, { content, flags: 4 });
      changes.push("edited message");
    }
  } else {
    msg = await api("POST", `/channels/${channel.id}/messages`, { content, flags: 4, allowed_mentions: { parse: [] } });
    await api("PUT", `/channels/${channel.id}/pins/${msg.id}`);
    changes.push("sent and pinned message");
  }

  console.log("\n== Result ==");
  console.log(`Channel ID: ${channel.id}`);
  console.log(`Message ID: ${msg.id}`);
  console.log(changes.length ? "Changes: " + changes.join("; ") : "No changes");
}

main().catch((e) => die(e.message.replace(TOKEN, "[redacted]")));
