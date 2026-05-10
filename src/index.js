"use strict";

require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

const db  = require("./db");
const elo = require("./elo");

// ---------------------------
// Helpers
// ---------------------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { channels: {}, threads: {} };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(statePath, state) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function renderTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v ?? "");
  }
  return out;
}

function mentionList(userIds) {
  return (userIds || []).map((id) => `<@${id}>`).join(" ");
}

// Extract Discord user IDs from a string containing <@id> or <@!id> mentions.
function parseMentions(str) {
  return [...str.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
}

function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== "object") errs.push("Config is empty or invalid YAML.");
  if (!cfg.event?.key)   errs.push("Missing event.key");
  if (!cfg.event?.name)  errs.push("Missing event.name");
  if (!Number.isInteger(cfg.event?.round))    errs.push("event.round must be an integer");
  if (!Number.isInteger(cfg.event?.teamSize)) errs.push("event.teamSize must be an integer");
  if (!cfg.countryPools || typeof cfg.countryPools !== "object") errs.push("Missing countryPools object");
  if (!Array.isArray(cfg.maps) || cfg.maps.length < 1) {
    errs.push("maps must be a non-empty array");
  } else {
    for (const m of cfg.maps) {
      if (!Number.isInteger(m.mapNumber)) errs.push("Each map must have mapNumber (integer)");
      if (!Array.isArray(m.theatres) || m.theatres.length < 1) {
        errs.push(`Map ${m.mapNumber}: theatres must be a non-empty array`);
        continue;
      }
      for (const th of m.theatres) {
        if (!th.id)   errs.push(`Map ${m.mapNumber}: theatre missing id`);
        if (!th.name) errs.push(`Map ${m.mapNumber}: theatre missing name`);
        if (!Array.isArray(th.teams) || th.teams.length !== 2) {
          errs.push(`Map ${m.mapNumber} theatre ${th.id}: must have exactly 2 teams`);
          continue;
        }
        for (const team of th.teams) {
          if (!team.teamName)    errs.push(`Map ${m.mapNumber} theatre ${th.id}: team missing teamName`);
          if (!team.countryPool) errs.push(`Map ${m.mapNumber} theatre ${th.id}: team missing countryPool`);
          if (!Array.isArray(team.players)) errs.push(`Map ${m.mapNumber} theatre ${th.id}: team.players must be array`);
          if (team.subs != null && !Array.isArray(team.subs)) {
            errs.push(`Map ${m.mapNumber} theatre ${th.id}: team.subs must be array when provided`);
          }
          if (team.countryPool && cfg.countryPools && !cfg.countryPools[team.countryPool]) {
            errs.push(`Map ${m.mapNumber} theatre ${th.id}: unknown countryPool "${team.countryPool}"`);
          }
          if (Array.isArray(team.players) && Number.isInteger(cfg.event?.teamSize)) {
            if (team.players.length > cfg.event.teamSize) {
              errs.push(
                `Map ${m.mapNumber} theatre ${th.id} (${team.teamName}/${team.countryPool}): ` +
                `has ${team.players.length} players but teamSize is ${cfg.event.teamSize}`
              );
            }
          }
        }
      }
    }
  }
  return errs;
}

// ---------------------------
// Discord client
// ---------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ---------------------------
// Slash commands
// ---------------------------
const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Create map channels and private team threads from YAML config")
  .addStringOption((o) =>
    o.setName("config").setDescription("Config file base name in src/config (without extension)").setRequired(true)
  )
  .addBooleanOption((o) =>
    o.setName("dryrun").setDescription("Print plan without creating anything")
  );

const teardownCommand = new SlashCommandBuilder()
  .setName("teardown")
  .setDescription("Delete channels/threads created by /setup")
  .addStringOption((o) =>
    o.setName("config").setDescription("Config file base name in src/config (without extension)").setRequired(true)
  )
  .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without deleting anything"))
  .addBooleanOption((o) => o.setName("delete_state").setDescription("Delete state file after teardown"));

const syncMembersCommand = new SlashCommandBuilder()
  .setName("sync_members")
  .setDescription("Sync all non-bot guild members into the Elo players table")
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const recordMatchCommand = new SlashCommandBuilder()
  .setName("record_match")
  .setDescription("Record a match result and update Elo ratings")
  .addStringOption((o) =>
    o.setName("rank1").setDescription("1st place — @mention one or more players").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("rank2").setDescription("2nd place — @mention one or more players").setRequired(true)
  )
  .addStringOption((o) => o.setName("rank3").setDescription("3rd place — @mention one or more players"))
  .addStringOption((o) => o.setName("rank4").setDescription("4th place — @mention one or more players"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const ratingsCommand = new SlashCommandBuilder()
  .setName("ratings")
  .setDescription("Show the current Elo leaderboard")
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const matchmakeCommand = new SlashCommandBuilder()
  .setName("matchmake")
  .setDescription("Split players into balanced teams")
  .addStringOption((o) =>
    o.setName("players").setDescription("@mention all players in the bracket").setRequired(true)
  )
  .addIntegerOption((o) =>
    o.setName("team_size").setDescription("Players per team (default 1)").setMinValue(1)
  )
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

// ---------------------------
// Permission check: staff only
// ---------------------------
function isStaff(interaction) {
  const staffRoleId = process.env.EVENT_STAFF_ROLE_ID;
  if (!staffRoleId) return false;
  return interaction.member?.roles?.cache?.has(staffRoleId);
}

async function assertBotAccess(guild, categoryId) {
  const category = await guild.channels.fetch(categoryId);
  if (!category) throw new Error(`EVENT_CATEGORY_ID not found: ${categoryId}`);
  const botMember = await guild.members.fetchMe();
  const requiredPerms = [
    PermissionsBitField.Flags.CreatePublicThreads,
    PermissionsBitField.Flags.CreatePrivateThreads,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.SendMessages,
  ];
  const botPerms    = category.permissionsFor(botMember);
  const missingPerms = requiredPerms
    .filter((p) => !botPerms.has(p))
    .map((p) => PermissionsBitField.resolve(p).toString());
  if (missingPerms.length > 0) {
    throw new Error(`Bot missing permissions on category: ${missingPerms.join(", ")}`);
  }
  return category;
}

async function addPlayersToThread(guild, thread, playerIds) {
  for (const userId of playerIds || []) {
    try {
      let member = guild.members.cache.get(userId);
      if (!member) member = await guild.members.fetch(userId);
      await thread.members.add(member.id);
    } catch (e) {
      console.log(`Failed to add ${userId} to ${thread.name}: ${String(e?.message || e)}`);
    }
  }
}

async function findChannelByNameInCategory(guild, categoryId, channelName) {
  const channels = await guild.channels.fetch();
  return channels.find(
    (c) => c && c.type === ChannelType.GuildText && c.parentId === categoryId && c.name === channelName
  );
}

async function findThreadByName(mapChannel, threadName) {
  const active = await mapChannel.threads.fetchActive();
  const foundActive = active.threads.find((t) => t.name === threadName);
  if (foundActive) return foundActive;
  const archived = await mapChannel.threads.fetchArchived({ type: "private" }).catch(() => null);
  if (archived?.threads) {
    const foundArchived = archived.threads.find((t) => t.name === threadName);
    if (foundArchived) return foundArchived;
  }
  return null;
}

// ---------------------------
// Bot ready
// ---------------------------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("Missing GUILD_ID in .env");

  await db.initSchema(false);
  await db.initSchema(true);
  console.log("DB schema ready (prod + test)");

  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([
    setupCommand,
    teardownCommand,
    syncMembersCommand,
    recordMatchCommand,
    ratingsCommand,
    matchmakeCommand,
  ]);
  console.log("Registered slash commands");
});

// ---------------------------
// Interaction handler
// ---------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (!isStaff(interaction)) {
      return interaction.reply({ content: "Staff only.", ephemeral: true });
    }

    const guild = interaction.guild;
    if (!guild) throw new Error("This command must be run inside a server.");

    await interaction.deferReply({ ephemeral: true });

    // ---- /sync_members ----
    if (interaction.commandName === "sync_members") {
      const isTest = interaction.options.getBoolean("test") ?? false;
      await db.initSchema(isTest);
      const members = await guild.members.fetch();
      let humans = 0, bots = 0;
      for (const [, member] of members) {
        if (member.user.bot) { bots++; continue; }
        await db.upsertPlayer(member.id, member.displayName || member.user.username, isTest);
        humans++;
      }
      return interaction.editReply(
        `✅ Synced players${isTest ? " **(TEST)**" : ""}.\nTotal: ${members.size} | Humans: ${humans} | Bots skipped: ${bots}`
      );
    }

    // ---- /record_match ----
    if (interaction.commandName === "record_match") {
      const isTest = interaction.options.getBoolean("test") ?? false;
      const rankInputs = [
        interaction.options.getString("rank1"),
        interaction.options.getString("rank2"),
        interaction.options.getString("rank3"),
        interaction.options.getString("rank4"),
      ].filter(Boolean);

      // Parse mentions per rank slot
      const rankGroups = rankInputs.map(parseMentions);
      if (rankGroups.some((g) => g.length === 0)) {
        return interaction.editReply("❌ Each rank must contain at least one @mention.");
      }

      // Flatten all player IDs and fetch from DB
      const allIds    = rankGroups.flat();
      const dbPlayers = await db.getPlayers(allIds, isTest);
      const byId      = Object.fromEntries(dbPlayers.map((p) => [p.player_id, p]));

      const missing = allIds.filter((id) => !byId[id]);
      if (missing.length > 0) {
        return interaction.editReply(
          `❌ These players are not in the DB (run /sync_members first): ${missing.map((id) => `<@${id}>`).join(", ")}`
        );
      }

      // Build teams array for elo.calculateMatch
      const teams = rankGroups.map((ids) =>
        ids.map((id) => ({
          playerId:    byId[id].player_id,
          discordName: byId[id].discord_name,
          elo:         byId[id].elo,
          gamesPlayed: byId[id].games_played,
        }))
      );

      const results  = elo.calculateMatch(teams);
      const matchId  = `M${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const label    = rankGroups.map((ids, i) => `Rank${i + 1}: ${ids.map((id) => byId[id].discord_name).join(", ")}`).join(" | ");

      await db.recordMatch(matchId, label, results, isTest);

      const lines = results.map(
        (r) => `<@${r.playerId}> (rank ${r.rank}): ${r.eloBefore} → **${r.eloAfter}** (${r.deltaElo >= 0 ? "+" : ""}${r.deltaElo})`
      );
      return interaction.editReply(`✅ Match recorded${isTest ? " **(TEST)**" : ""}.\n${lines.join("\n")}`);
    }

    // ---- /ratings ----
    if (interaction.commandName === "ratings") {
      const isTest = interaction.options.getBoolean("test") ?? false;
      const rows = await db.getRatings(isTest);
      if (rows.length === 0) {
        return interaction.editReply("No players in the DB yet. Run /sync_members first.");
      }
      const lines = rows.map(
        (r, i) => `${i + 1}. <@${r.player_id}> — **${Math.round(r.elo)}** (${r.games_played} games)`
      );
      const chunks = [];
      let chunk = "**Elo Leaderboard**\n";
      for (const line of lines) {
        if (chunk.length + line.length > 1900) {
          chunks.push(chunk);
          chunk = "";
        }
        chunk += line + "\n";
      }
      chunks.push(chunk);
      const header = `**Elo Leaderboard${isTest ? " (TEST)" : ""}**\n`;
      await interaction.editReply(chunks[0].replace("**Elo Leaderboard**\n", header));
      for (const c of chunks.slice(1)) {
        await interaction.followUp({ content: c, ephemeral: true });
      }
      return;
    }

    // ---- /matchmake ----
    if (interaction.commandName === "matchmake") {
      const isTest    = interaction.options.getBoolean("test") ?? false;
      const playerStr = interaction.options.getString("players");
      const teamSize  = interaction.options.getInteger("team_size") ?? 1;
      const ids       = parseMentions(playerStr);

      if (ids.length < 2) {
        return interaction.editReply("❌ Mention at least 2 players.");
      }

      const dbPlayers = await db.getPlayers(ids, isTest);
      const byId      = Object.fromEntries(dbPlayers.map((p) => [p.player_id, p]));
      const missing   = ids.filter((id) => !byId[id]);
      if (missing.length > 0) {
        return interaction.editReply(
          `❌ Not in DB (run /sync_members first): ${missing.map((id) => `<@${id}>`).join(", ")}`
        );
      }

      const players  = ids.map((id) => ({
        playerId:    byId[id].player_id,
        discordName: byId[id].discord_name,
        elo:         byId[id].elo,
      }));

      const numTeams  = Math.floor(players.length / teamSize);
      const teamSizes = Array(numTeams).fill(teamSize);
      const { teams, quality } = elo.bestSplit(players, teamSizes);

      const lines = teams.map((team, i) => {
        const avg  = Math.round(team.reduce((s, p) => s + p.elo, 0) / team.length);
        const names = team.map((p) => `<@${p.playerId}>`).join(" ");
        return `**Team ${i + 1}** (avg ${avg}): ${names}`;
      });

      const qualityStr = quality !== null ? `\nMatch quality: ${(quality * 100).toFixed(1)}%` : "";
      return interaction.editReply(lines.join("\n") + qualityStr);
    }

    // ---- /setup ----
    if (interaction.commandName === "setup") {
      const categoryId = process.env.EVENT_CATEGORY_ID;
      if (!categoryId) throw new Error("Missing EVENT_CATEGORY_ID in .env");

      const configBase  = interaction.options.getString("config");
      const dryrun      = interaction.options.getBoolean("dryrun") ?? false;
      const configPath  = path.join(__dirname, "config", `${configBase}.yml`);
      const templatePath = path.join(__dirname, "config", `${configBase}.thread.md`);

      if (!fs.existsSync(configPath))   return interaction.editReply(`Config not found: ${configPath}`);
      if (!fs.existsSync(templatePath)) return interaction.editReply(`Thread template not found: ${templatePath}`);

      const cfg      = readYaml(configPath);
      const template = readText(templatePath);
      const errors   = validateConfig(cfg);
      if (errors.length) return interaction.editReply(`Config validation failed:\n- ${errors.join("\n- ")}`);

      const statePath = path.join(process.cwd(), "data", `state-${cfg.event.key}.json`);
      const state     = loadState(statePath);

      await assertBotAccess(guild, categoryId);

      const planLines = [];
      let createdChannels = 0, createdThreads = 0, reusedChannels = 0, reusedThreads = 0;

      for (const map of cfg.maps) {
        const channelName = `${slugify(cfg.event.key)}-map${pad2(map.mapNumber)}`;
        planLines.push(`Map ${map.mapNumber}: channel #${channelName}`);

        let mapChannelId = state.channels?.[channelName]?.id;
        let mapChannel   = mapChannelId ? await guild.channels.fetch(mapChannelId).catch(() => null) : null;
        if (!mapChannel) mapChannel = await findChannelByNameInCategory(guild, categoryId, channelName);

        if (!mapChannel) {
          if (dryrun) {
            planLines.push(`  - would create channel`);
          } else {
            mapChannel = await guild.channels.create({
              name: channelName, type: ChannelType.GuildText, parent: categoryId, reason: "Event setup",
            });
            createdChannels++;
            state.channels[channelName] = { id: mapChannel.id };
          }
        } else {
          reusedChannels++;
          state.channels[channelName] = { id: mapChannel.id };
        }

        for (const theatre of map.theatres) {
          for (const team of theatre.teams) {
            const poolKey    = team.countryPool;
            const pool       = cfg.countryPools[poolKey];
            const threadName = `${slugify(team.teamName)}-${slugify(poolKey)}`;
            planLines.push(`  - theatre ${theatre.id}: would ensure private thread "${threadName}"`);

            if (!mapChannel) continue;

            let threadId = state.threads?.[`${channelName}:${threadName}`]?.id;
            let thread   = threadId ? await guild.channels.fetch(threadId).catch(() => null) : null;
            if (!thread) thread = await findThreadByName(mapChannel, threadName);

            if (!thread) {
              if (!dryrun) {
                thread = await mapChannel.threads.create({
                  name: threadName, type: ChannelType.PrivateThread,
                  autoArchiveDuration: 10080, reason: "Event setup",
                });
                createdThreads++;
                state.threads[`${channelName}:${threadName}`] = { id: thread.id };
              }
            } else {
              reusedThreads++;
              state.threads[`${channelName}:${threadName}`] = { id: thread.id };
            }

            if (!dryrun && thread && state.threads[`${channelName}:${threadName}`]?.posted !== true) {
              const playable     = (pool.playableCountries || []).map((c) => `- ${c}`).join("\n");
              const ai           = (pool.aiCountries || []).map((c) => `- ${c}`).join("\n");
              const mentions     = mentionList(team.players);
              const subsMentions = mentionList(team.subs);
              const body = renderTemplate(template, {
                EVENT_NAME: cfg.event.name, EVENT_ROUND: String(cfg.event.round),
                EVENT_KEY: cfg.event.key, MAP_NUMBER: String(map.mapNumber),
                MAP_NUMBER_PAD2: pad2(map.mapNumber), THEATRE_ID: theatre.id,
                THEATRE_NAME: theatre.name, TEAM_NAME: team.teamName,
                COUNTRY_POOL_KEY: poolKey, COUNTRY_POOL_LABEL: pool.label || poolKey,
                COUNTRY_POOL_COLOUR: pool.colour || "",
                PLAYABLE_COUNTRIES: playable || "- (none)", AI_COUNTRIES: ai || "- (none)",
                PLAYERS_MENTIONS: mentions || "", SUBS_MENTIONS: subsMentions || "- None",
                TEAM_SIZE: String(cfg.event.teamSize),
              });
              await thread.send(body);
              await addPlayersToThread(guild, thread, team.players);
              await addPlayersToThread(guild, thread, team.subs);
              state.threads[`${channelName}:${threadName}`].posted = true;
            }
          }
        }

        if (!dryrun && mapChannel) {
          const chanState = state.channels[channelName] || {};
          if (chanState.posted !== true) {
            await mapChannel.send(`**${cfg.event.name}**\nMap ${pad2(map.mapNumber)} set up. Private team threads created.`);
            chanState.posted = true;
            state.channels[channelName] = chanState;
          }
        }
      }

      if (!dryrun) saveState(statePath, state);

      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅ Nothing created.\n\nPlan:\n${planLines.map((l) => `• ${l}`).join("\n")}`
        );
      }
      return interaction.editReply(
        `Done ✅\nCreated: ${createdChannels} channels, ${createdThreads} threads\n` +
        `Reused: ${reusedChannels} channels, ${reusedThreads} threads`
      );
    }

    // ---- /teardown ----
    if (interaction.commandName === "teardown") {
      const categoryId  = process.env.EVENT_CATEGORY_ID;
      const configBase  = interaction.options.getString("config");
      const dryrun      = interaction.options.getBoolean("dryrun") ?? false;
      const deleteState = interaction.options.getBoolean("delete_state") ?? false;
      const configPath  = path.join(__dirname, "config", `${configBase}.yml`);

      if (!fs.existsSync(configPath)) return interaction.editReply(`Config not found: ${configPath}`);

      const cfg       = readYaml(configPath);
      const statePath = path.join(process.cwd(), "data", `state-${cfg.event.key}.json`);
      const state     = loadState(statePath);

      const toDeleteThreads  = Object.values(state.threads  || {}).map((x) => x.id).filter(Boolean);
      const toDeleteChannels = Object.values(state.channels || {}).map((x) => x.id).filter(Boolean);

      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅ Nothing deleted.\nThreads: ${toDeleteThreads.length}\nChannels: ${toDeleteChannels.length}`
        );
      }

      let deletedThreads = 0, deletedChannels = 0;
      for (const id of toDeleteThreads) {
        try {
          const ch = await guild.channels.fetch(id).catch(() => null);
          if (ch) { await ch.delete("Event teardown"); deletedThreads++; }
        } catch (e) { console.log(`Failed to delete thread ${id}: ${String(e?.message || e)}`); }
      }
      for (const id of toDeleteChannels) {
        try {
          const ch = await guild.channels.fetch(id).catch(() => null);
          if (ch) { await ch.delete("Event teardown"); deletedChannels++; }
        } catch (e) { console.log(`Failed to delete channel ${id}: ${String(e?.message || e)}`); }
      }

      if (deleteState && fs.existsSync(statePath)) fs.unlinkSync(statePath);

      return interaction.editReply(
        `Teardown complete ✅\nDeleted ${deletedThreads} threads and ${deletedChannels} channels.`
      );
    }

  } catch (err) {
    console.error("Command error:", err);
    const msg = String(err?.message || err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ Error: ${msg}`);
      } else {
        await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
      }
    } catch (e) {
      console.error("Failed to reply to interaction:", e);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
