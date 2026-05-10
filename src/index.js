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
function pad2(n) { return String(n).padStart(2, "0"); }

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readYaml(filePath)  { return yaml.load(fs.readFileSync(filePath, "utf8")); }
function readText(filePath)  { return fs.readFileSync(filePath, "utf8"); }

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
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v ?? "");
  return out;
}

function mentionList(userIds) {
  return (userIds || []).map((id) => `<@${id}>`).join(" ");
}

function parseMentions(str) {
  return [...str.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
}

function testFlag(interaction) {
  return interaction.options.getBoolean("test") ?? false;
}

function testLabel(isTest) {
  return isTest ? " **(TEST)**" : "";
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
          if (team.subs != null && !Array.isArray(team.subs))
            errs.push(`Map ${m.mapNumber} theatre ${th.id}: team.subs must be array when provided`);
          if (team.countryPool && cfg.countryPools && !cfg.countryPools[team.countryPool])
            errs.push(`Map ${m.mapNumber} theatre ${th.id}: unknown countryPool "${team.countryPool}"`);
          if (Array.isArray(team.players) && Number.isInteger(cfg.event?.teamSize) &&
              team.players.length > cfg.event.teamSize)
            errs.push(`Map ${m.mapNumber} theatre ${th.id} (${team.teamName}): has ${team.players.length} players but teamSize is ${cfg.event.teamSize}`);
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
  .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without creating anything"));

const teardownCommand = new SlashCommandBuilder()
  .setName("teardown")
  .setDescription("Delete channels/threads created by /setup")
  .addStringOption((o) =>
    o.setName("config").setDescription("Config file base name in src/config (without extension)").setRequired(true)
  )
  .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without deleting anything"))
  .addBooleanOption((o) => o.setName("delete_state").setDescription("Delete state file after teardown"));

const lobbyCommand = new SlashCommandBuilder()
  .setName("lobby")
  .setDescription("Manage the matchmaking lobby")
  .addSubcommand((s) =>
    s.setName("add").setDescription("Add a player to the lobby")
      .addUserOption((o) => o.setName("player").setDescription("Player to add").setRequired(true))
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("remove").setDescription("Remove a player from the lobby")
      .addUserOption((o) => o.setName("player").setDescription("Player to remove").setRequired(true))
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("list").setDescription("Show who is currently in the lobby")
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("clear").setDescription("Clear the lobby")
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  );

const seasonCommand = new SlashCommandBuilder()
  .setName("season")
  .setDescription("Manage seasons")
  .addSubcommand((s) =>
    s.setName("create").setDescription("Create a new season")
      .addStringOption((o) => o.setName("name").setDescription("Season name e.g. S1").setRequired(true))
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("start").setDescription("Start a season (ends any currently active season)")
      .addStringOption((o) => o.setName("name").setDescription("Season name to activate").setRequired(true))
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("end").setDescription("End the currently active season")
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("list").setDescription("List all seasons")
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  );

const syncMembersCommand = new SlashCommandBuilder()
  .setName("sync_members")
  .setDescription("Sync all non-bot guild members into the Elo players table")
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const createMatchCommand = new SlashCommandBuilder()
  .setName("create_match")
  .setDescription("Create a pending match between two teams (up to 5v5; use /matchmake save:True for larger)")
  .addUserOption((o) => o.setName("team1_p1").setDescription("Team 1 — Player 1").setRequired(true))
  .addUserOption((o) => o.setName("team2_p1").setDescription("Team 2 — Player 1").setRequired(true))
  .addUserOption((o) => o.setName("team1_p2").setDescription("Team 1 — Player 2"))
  .addUserOption((o) => o.setName("team2_p2").setDescription("Team 2 — Player 2"))
  .addUserOption((o) => o.setName("team1_p3").setDescription("Team 1 — Player 3"))
  .addUserOption((o) => o.setName("team2_p3").setDescription("Team 2 — Player 3"))
  .addUserOption((o) => o.setName("team1_p4").setDescription("Team 1 — Player 4"))
  .addUserOption((o) => o.setName("team2_p4").setDescription("Team 2 — Player 4"))
  .addUserOption((o) => o.setName("team1_p5").setDescription("Team 1 — Player 5"))
  .addUserOption((o) => o.setName("team2_p5").setDescription("Team 2 — Player 5"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const recordResultCommand = new SlashCommandBuilder()
  .setName("record_result")
  .setDescription("Record the result of a pending match")
  .addStringOption((o) =>
    o.setName("match").setDescription("Select a pending match").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName("result").setDescription("Match outcome").setRequired(true)
      .addChoices(
        { name: "Team 1 wins", value: "team1" },
        { name: "Team 2 wins", value: "team2" },
        { name: "Walkover",    value: "walkover" }
      )
  )
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const ratingsCommand = new SlashCommandBuilder()
  .setName("ratings")
  .setDescription("Show the current Elo leaderboard")
  .addBooleanOption((o) => o.setName("save").setDescription("Save the suggested matchup as a pending match"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const leagueCommand = new SlashCommandBuilder()
  .setName("league")
  .setDescription("Show the league table for a season")
  .addStringOption((o) => o.setName("season").setDescription("Season name (defaults to active season)"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const matchmakeCommand = new SlashCommandBuilder()
  .setName("matchmake")
  .setDescription("Split lobby players into balanced teams and create pending matches")
  .addIntegerOption((o) =>
    o.setName("team_size").setDescription("Players per team").setRequired(true).setMinValue(1)
  )
  .addIntegerOption((o) =>
    o.setName("round").setDescription("Round number e.g. 1").setRequired(true).setMinValue(1)
  )
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

// ---------------------------
// Permission helpers
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
  const missingPerms = requiredPerms
    .filter((p) => !category.permissionsFor(botMember).has(p))
    .map((p) => PermissionsBitField.resolve(p).toString());
  if (missingPerms.length > 0)
    throw new Error(`Bot missing permissions on category: ${missingPerms.join(", ")}`);
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
  const found  = active.threads.find((t) => t.name === threadName);
  if (found) return found;
  const archived = await mapChannel.threads.fetchArchived({ type: "private" }).catch(() => null);
  return archived?.threads?.find((t) => t.name === threadName) || null;
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
    lobbyCommand,
    seasonCommand,
    createMatchCommand,
    recordResultCommand,
    ratingsCommand,
    leagueCommand,
    matchmakeCommand,
  ]);
  console.log("Registered slash commands");
});

// ---------------------------
// Interaction handler
// ---------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    // Autocomplete for /record_result match field
    if (interaction.isAutocomplete()) {
      if (!isStaff(interaction)) return interaction.respond([]);
      const isTest  = interaction.options.get("test")?.value ?? false;
      const focused = interaction.options.getFocused().toLowerCase();
      const pending = await db.getPendingMatches(isTest);
      const choices = pending
        .filter((m) => m.label.toLowerCase().includes(focused))
        .map((m) => ({ name: m.label.slice(0, 100), value: m.match_id }));
      return interaction.respond(choices);
    }

    if (!interaction.isChatInputCommand()) return;

    if (!isStaff(interaction)) {
      return interaction.reply({ content: "Staff only.", ephemeral: true });
    }

    const guild = interaction.guild;
    if (!guild) throw new Error("This command must be run inside a server.");

    await interaction.deferReply({ ephemeral: true });

    const isTest = testFlag(interaction);

    // ---- /sync_members ----
    if (interaction.commandName === "sync_members") {
      await db.initSchema(isTest);
      const members = await guild.members.fetch();
      let humans = 0, bots = 0;
      for (const [, member] of members) {
        if (member.user.bot) { bots++; continue; }
        await db.upsertPlayer(member.id, member.displayName || member.user.username, isTest);
        humans++;
      }
      return interaction.editReply(
        `✅ Synced players${testLabel(isTest)}.\nTotal: ${members.size} | Humans: ${humans} | Bots skipped: ${bots}`
      );
    }

    // ---- /lobby ----
    if (interaction.commandName === "lobby") {
      const sub = interaction.options.getSubcommand();

      if (sub === "add") {
        const user = interaction.options.getUser("player");
        const dbP  = await db.getPlayers([user.id], isTest);
        if (!dbP.length)
          return interaction.editReply(`❌ ${user.displayName} is not in the DB. Run \`/sync_members\` first.`);
        await db.lobbyAdd(user.id, dbP[0].discord_name, isTest);
        const lobby = await db.lobbyList(isTest);
        return interaction.editReply(`✅ **${dbP[0].discord_name}** added to lobby${testLabel(isTest)}. Players in lobby: **${lobby.length}**`);
      }

      if (sub === "remove") {
        const user    = interaction.options.getUser("player");
        const removed = await db.lobbyRemove(user.id, isTest);
        if (!removed) return interaction.editReply(`❌ That player is not in the lobby.`);
        const lobby = await db.lobbyList(isTest);
        return interaction.editReply(`✅ Removed from lobby${testLabel(isTest)}. Players remaining: **${lobby.length}**`);
      }

      if (sub === "list") {
        const lobby = await db.lobbyList(isTest);
        if (lobby.length === 0) return interaction.editReply(`Lobby is empty${testLabel(isTest)}.`);
        const lines = lobby.map((p, i) => `${i + 1}. ${p.discord_name} — ${Math.round(p.elo)}`);
        return interaction.editReply(`**Lobby${testLabel(isTest)} (${lobby.length} players)**\n${lines.join("\n")}`);
      }

      if (sub === "clear") {
        const hasPending = await db.lobbyHasPendingMatches(isTest);
        if (hasPending)
          return interaction.editReply(`⚠️ There are still pending matches involving lobby players. Record all results before clearing.`);
        await db.lobbyClear(isTest);
        return interaction.editReply(`✅ Lobby cleared${testLabel(isTest)}.`);
      }
    }

    // ---- /season ----
    if (interaction.commandName === "season") {
      const sub = interaction.options.getSubcommand();

      if (sub === "create") {
        const name = interaction.options.getString("name");
        await db.createSeason(name, isTest);
        return interaction.editReply(`✅ Season **${name}** created${testLabel(isTest)}. Use \`/season start name:${name}\` to activate it.`);
      }

      if (sub === "start") {
        const name   = interaction.options.getString("name");
        const season = await db.getSeasonByName(name, isTest);
        if (!season) return interaction.editReply(`❌ Season **${name}** not found. Create it first with \`/season create\`.`);
        await db.startSeason(name, isTest);
        return interaction.editReply(`✅ Season **${name}** is now active${testLabel(isTest)}. All new matches will be tagged to this season.`);
      }

      if (sub === "end") {
        const season = await db.endSeason(isTest);
        if (!season) return interaction.editReply(`❌ No active season to end.`);
        return interaction.editReply(`✅ Season **${season.name}** ended${testLabel(isTest)}.`);
      }

      if (sub === "list") {
        const seasons = await db.listSeasons(isTest);
        if (seasons.length === 0) return interaction.editReply("No seasons created yet.");
        const lines = seasons.map((s) => {
          const status = s.active ? "🟢 Active" : s.ended_at ? "⚫ Ended" : "⚪ Not started";
          const started = s.started_at ? new Date(s.started_at).toDateString() : "—";
          const ended   = s.ended_at   ? new Date(s.ended_at).toDateString()   : "—";
          return `**${s.name}** ${status} | Started: ${started} | Ended: ${ended}`;
        });
        return interaction.editReply(`**Seasons${testLabel(isTest)}**\n${lines.join("\n")}`);
      }
    }

    // ---- /create_match ----
    if (interaction.commandName === "create_match") {
      const slots   = [1, 2, 3, 4, 5];
      const t1Users = slots.map((n) => interaction.options.getUser(`team1_p${n}`)).filter(Boolean);
      const t2Users = slots.map((n) => interaction.options.getUser(`team2_p${n}`)).filter(Boolean);

      const overlap = t1Users.filter((u) => t2Users.some((v) => v.id === u.id));
      if (overlap.length > 0)
        return interaction.editReply(`❌ A player cannot be in both teams: ${overlap.map((u) => u.displayName).join(", ")}`);

      const allIds    = [...t1Users, ...t2Users].map((u) => u.id);
      const dbPlayers = await db.getPlayers(allIds, isTest);
      const byId      = Object.fromEntries(dbPlayers.map((p) => [p.player_id, p]));
      const missing   = allIds.filter((id) => !byId[id]);
      if (missing.length > 0)
        return interaction.editReply(`❌ Not in DB (run /sync_members first): ${missing.map((id) => `<@${id}>`).join(", ")}`);

      const toPlayer  = (u) => ({ playerId: u.id, discordName: byId[u.id].discord_name });
      const { label, seasonName } = await db.createMatch(t1Users.map(toPlayer), t2Users.map(toPlayer), isTest);

      const seasonStr = seasonName ? ` | Season: **${seasonName}**` : " | ⚠️ No active season";
      return interaction.editReply(
        `✅ Match created${testLabel(isTest)}${seasonStr}.\n**${label}**\nUse \`/record_result\` when the match is complete.`
      );
    }

    // ---- /record_result ----
    if (interaction.commandName === "record_result") {
      const matchId = interaction.options.getString("match");
      const result  = interaction.options.getString("result");

      const winningTeam = result === "team1" ? 1 : result === "team2" ? 2 : null;
      const { results, walkover, team1, team2 } = await db.completeMatch(matchId, winningTeam, elo, isTest);

      if (walkover) {
        const t1 = team1.map((p) => `<@${p.playerId}>`).join(", ");
        const t2 = team2.map((p) => `<@${p.playerId}>`).join(", ");
        return interaction.editReply(
          `✅ Walkover recorded${testLabel(isTest)}. No Elo changes.\n**Team 1:** ${t1}\n**Team 2:** ${t2}`
        );
      }

      const lines = results.map(
        (r) => `<@${r.playerId}> (rank ${r.rank}): ${r.eloBefore} → **${r.eloAfter}** (${r.deltaElo >= 0 ? "+" : ""}${r.deltaElo})`
      );
      return interaction.editReply(`✅ Result recorded${testLabel(isTest)}.\n${lines.join("\n")}`);
    }

    // ---- /ratings ----
    if (interaction.commandName === "ratings") {
      const rows = await db.getRatings(isTest);
      if (rows.length === 0)
        return interaction.editReply("No players in the DB yet. Run /sync_members first.");

      const lines = rows.map(
        (r, i) => `${i + 1}. ${r.discord_name} — **${Math.round(r.elo)}**`
      );
      const header = `**Elo Leaderboard${testLabel(isTest)}**\n`;
      const chunks = [];
      let chunk = header;
      for (const line of lines) {
        if (chunk.length + line.length > 1900) { chunks.push(chunk); chunk = ""; }
        chunk += line + "\n";
      }
      chunks.push(chunk);
      await interaction.editReply(chunks[0]);
      for (const c of chunks.slice(1)) await interaction.followUp({ content: c, ephemeral: true });
      return;
    }

    // ---- /league ----
    if (interaction.commandName === "league") {
      const seasonName = interaction.options.getString("season");
      const season = seasonName
        ? await db.getSeasonByName(seasonName, isTest)
        : await db.getActiveSeason(isTest);

      if (!season) {
        return interaction.editReply(
          seasonName ? `❌ Season **${seasonName}** not found.` : "❌ No active season. Use \`/season start\` or specify a season name."
        );
      }

      const rows = await db.getLeagueTable(season.season_id, isTest);
      if (rows.length === 0)
        return interaction.editReply(`No matches recorded for season **${season.name}** yet.`);

      const header = `# Player              W  L  GP  ±Elo\n${"─".repeat(36)}\n`;

      const lines = rows.map((r, i) => {
        const pos  = String(i + 1).padStart(2);
        const name = r.discord_name.padEnd(20).slice(0, 20);
        const w    = String(r.wins).padStart(2);
        const l    = String(r.losses).padStart(2);
        const gp   = String(r.games_played).padStart(3);
        const d    = (r.elo_delta >= 0 ? "+" : "") + r.elo_delta;
        return `${pos} ${name} ${w} ${l} ${gp}  ${d}`;
      });

      return interaction.editReply(
        `**League Table — ${season.name}${testLabel(isTest)}**\n\`\`\`\n${header}${lines.join("\n")}\n\`\`\``
      );
    }

    // ---- /matchmake ----
    if (interaction.commandName === "matchmake") {
      const teamSize  = interaction.options.getInteger("team_size");
      const round     = interaction.options.getInteger("round");
      const lobby     = await db.lobbyList(isTest);

      if (lobby.length < 2)
        return interaction.editReply(`❌ Lobby has ${lobby.length} player(s). Add at least 2 with \`/lobby add\`.`);

      const totalSlots = Math.floor(lobby.length / teamSize) * teamSize;
      const leftover   = lobby.length - totalSlots;
      const numMatches = totalSlots / (teamSize * 2);

      if (numMatches < 1)
        return interaction.editReply(`❌ Not enough players for a single match. Need at least ${teamSize * 2}, have ${lobby.length}.`);

      const players = lobby.map((p) => ({
        playerId:    p.player_id,
        discordName: p.discord_name,
        elo:         parseFloat(p.elo),
      }));

      const season     = await db.getActiveSeason(isTest);
      const seasonStr  = season ? ` | Season: **${season.name}**` : " | ⚠️ No active season";
      const seasonSlug = season ? slugify(season.name) : "no-season";
      const toPlayer   = (p) => ({ playerId: p.playerId, discordName: p.discordName });

      const categoryId = process.env.EVENT_CATEGORY_ID;

      // Sort by Elo desc, snake-draft into matches
      const sorted  = [...players].sort((a, b) => b.elo - a.elo);
      const matches = Array.from({ length: numMatches }, () => ({ t1: [], t2: [] }));

      let mi = 0, dir = 1;
      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const m = matches[mi];
        if (m.t1.length <= m.t2.length) m.t1.push(p);
        else m.t2.push(p);
        mi += dir;
        if (mi >= numMatches) { mi = numMatches - 1; dir = -1; }
        else if (mi < 0)      { mi = 0;               dir =  1; }
      }

      const lines = [];
      for (let i = 0; i < matches.length; i++) {
        const { t1, t2 } = matches[i];
        const avg1 = Math.round(t1.reduce((s, p) => s + p.elo, 0) / t1.length);
        const avg2 = Math.round(t2.reduce((s, p) => s + p.elo, 0) / t2.length);
        const { matchId, label } = await db.createMatch(t1.map(toPlayer), t2.map(toPlayer), isTest);

        // Short suffix from matchId e.g. "M1234567890-abc12" → "abc12"
        const shortId     = matchId.split("-").pop();
        const channelName = `${seasonSlug}-r${round}-${shortId}`;

        // Create match channel under EVENT_CATEGORY_ID (skip if no category configured)
        if (categoryId) {
          try {
            const matchChannel = await guild.channels.create({
              name:   channelName,
              type:   ChannelType.GuildText,
              parent: categoryId,
              reason: `Match ${matchId}`,
            });

            const t1Mentions = t1.map((p) => `<@${p.playerId}>`).join(" ");
            const t2Mentions = t2.map((p) => `<@${p.playerId}>`).join(" ");
            await matchChannel.send(
              `**Match created** | ${season ? `Season: **${season.name}** | ` : ""}Round: **${round}**\n\n` +
              `**Team 1** (avg ${avg1} Elo): ${t1Mentions}\n` +
              `**Team 2** (avg ${avg2} Elo): ${t2Mentions}\n\n` +
              `Match ID: \`${matchId}\``
            );
          } catch (e) {
            console.error(`Failed to create channel ${channelName}:`, e);
          }
        }

        lines.push(`**Match ${i + 1}** — ${label}\nTeam 1 avg: ${avg1} | Team 2 avg: ${avg2} | Channel: #${channelName}`);
      }

      const leftoverMsg = leftover > 0
        ? `\n\n⚠️ ${leftover} player(s) left out due to uneven numbers: ${sorted.slice(totalSlots).map((p) => p.discordName).join(", ")}`
        : "";

      return interaction.editReply(
        `✅ **${numMatches} match(es) created**${testLabel(isTest)}${seasonStr}\n\n` +
        lines.join("\n\n") +
        leftoverMsg +
        `\n\nUse \`/record_result\` to record each result. Clear lobby with \`/lobby clear\` when all done.`
      );
    }

    // ---- /setup ----
    if (interaction.commandName === "setup") {
      const categoryId  = process.env.EVENT_CATEGORY_ID;
      if (!categoryId) throw new Error("Missing EVENT_CATEGORY_ID in .env");

      const configBase   = interaction.options.getString("config");
      const dryrun       = interaction.options.getBoolean("dryrun") ?? false;
      const configPath   = path.join(__dirname, "config", `${configBase}.yml`);
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
          if (dryrun) { planLines.push(`  - would create channel`); }
          else {
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
              const body = renderTemplate(template, {
                EVENT_NAME: cfg.event.name, EVENT_ROUND: String(cfg.event.round),
                EVENT_KEY: cfg.event.key, MAP_NUMBER: String(map.mapNumber),
                MAP_NUMBER_PAD2: pad2(map.mapNumber), THEATRE_ID: theatre.id,
                THEATRE_NAME: theatre.name, TEAM_NAME: team.teamName,
                COUNTRY_POOL_KEY: poolKey, COUNTRY_POOL_LABEL: pool.label || poolKey,
                COUNTRY_POOL_COLOUR: pool.colour || "",
                PLAYABLE_COUNTRIES: playable || "- (none)", AI_COUNTRIES: ai || "- (none)",
                PLAYERS_MENTIONS: mentionList(team.players), SUBS_MENTIONS: mentionList(team.subs) || "- None",
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
      if (dryrun)
        return interaction.editReply(`Dry-run ✅\n\nPlan:\n${planLines.map((l) => `• ${l}`).join("\n")}`);
      return interaction.editReply(
        `Done ✅\nCreated: ${createdChannels} channels, ${createdThreads} threads\n` +
        `Reused: ${reusedChannels} channels, ${reusedThreads} threads`
      );
    }

    // ---- /teardown ----
    if (interaction.commandName === "teardown") {
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

      if (dryrun)
        return interaction.editReply(`Dry-run ✅\nThreads: ${toDeleteThreads.length}\nChannels: ${toDeleteChannels.length}`);

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
      if (interaction.deferred || interaction.replied) await interaction.editReply(`❌ Error: ${msg}`);
      else await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
    } catch (e) { console.error("Failed to reply to interaction:", e); }
  }
});

client.login(process.env.DISCORD_TOKEN);
