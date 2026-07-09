"use strict";

require("dotenv").config();

const fs     = require("fs");
const path   = require("path");
const yaml   = require("js-yaml");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
} = require("discord.js");

const db  = require("./db");
const elo = require("./elo");

// ---------------------------
// Helpers
// ---------------------------
// Alphabetical order — both so the category displays them that way (see the
// setPositions call after standing channels are created/found in /setup
// event) and because "registered-teams" alphabetizes before "registration",
// which registration's topic template (below) already depends on.
const STANDING_CHANNEL_NAMES = ["applications", "event-chat", "registered-teams", "registration", "rules", "zones"];
// Staff-only standing channels: hidden from @everyone, visible only to
// EVENT_STAFF_ROLE_ID (plus the bot itself, so it can post there).
const STANDING_CHANNEL_STAFF_ONLY = new Set(["applications"]);
// Standing channels where @everyone may send messages; all others are view-only
// (e.g. "registration" is posted to only via its apply panel component, not free text).
const STANDING_CHANNEL_OPEN_POST = new Set(["event-chat"]);
// registration's topic is a function, not a plain string, because it links
// to that event's own #registered-teams channel — a different channel ID
// per event, so it can't be a fixed string shared across every event/server.
const STANDING_CHANNEL_TOPICS = {
  registration: (guildId, registeredTeamsChannelId) =>
    ".\n\n" +
    "***/register team:<name> ign:<name>*** — register yourself for your team (re-run to update; one entry per player)\n" +
    "***/unregister*** — withdraw your registration\n" +
    "\n" +
    `Staff must approve your team before it appears in [#registered-teams](https://discord.com/channels/${guildId}/${registeredTeamsChannelId})\n` +
    "\n" +
    "Note slowmode is enabled on this channel.",
};
// Slash commands aren't rate-limited by slowmode (only regular messages are),
// so this discourages free-text chatter now that Warboys have Send Messages
// there, without blocking /register or /unregister.
const STANDING_CHANNEL_SLOWMODE = {
  registration: 3600, // 1 hour, in seconds
};
const WARBOY_GATED_COMMANDS = new Set(["register", "unregister"]);

function pad2(n) { return String(n).padStart(2, "0"); }

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readYaml(filePath)  { return yaml.load(fs.readFileSync(filePath, "utf8")); }
function readText(filePath)  { return fs.readFileSync(filePath, "utf8"); }

// Runtime state (category/channel/thread IDs, registrations) all lives in
// Postgres — see src/db.js. Only config (src/config/) is a local file tree,
// and it's pure, git-managed, human-authored content, kept deliberately
// separate from anything the bot writes itself.
const DB_IS_TEST = process.env.DB_IS_TEST_INSTANCE === "true";

function eventDir(eventKey) {
  return path.join(__dirname, "config", eventKey);
}

function roundDir(eventKey, round) {
  return round ? path.join(eventDir(eventKey), round) : eventDir(eventKey);
}

// Reverse-resolves an event key from a channel's parent category ID via
// event_category_state.category_id.
async function eventKeyForCategory(categoryId) {
  return db.getEventKeyForCategory(categoryId, DB_IS_TEST);
}

async function findLingeringRoundStates(eventKey) {
  return db.findLingeringRoundStates(eventKey, DB_IS_TEST);
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

  const usesTheatres = Array.isArray(cfg.maps) && cfg.maps.some((m) => Array.isArray(m.theatres));
  if (usesTheatres && (!cfg.countryPools || typeof cfg.countryPools !== "object"))
    errs.push("Missing countryPools object");

  if (!Array.isArray(cfg.maps) || cfg.maps.length < 1) {
    errs.push("maps must be a non-empty array");
  } else {
    for (const m of cfg.maps) {
      if (!Number.isInteger(m.mapNumber)) errs.push("Each map must have mapNumber (integer)");

      const hasTheatres = Array.isArray(m.theatres);
      const hasZones    = Array.isArray(m.zones);
      const usesRegistrationsTeams = m.teams === "registrations";

      if (!hasTheatres && !hasZones && !usesRegistrationsTeams) {
        errs.push(`Map ${m.mapNumber}: must have either theatres, zones, or teams: registrations`);
        continue;
      }

      if (hasTheatres) {
        if (m.theatres.length < 1) { errs.push(`Map ${m.mapNumber}: theatres must be non-empty`); continue; }
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

      if (hasZones) {
        for (const z of m.zones) {
          if (!Number.isInteger(z.zoneNumber)) errs.push(`Map ${m.mapNumber}: zone missing zoneNumber (integer)`);
          // homeland/ai are optional here: if omitted, /setup maps falls back to
          // that zone's imported data (see /setup zones import, event_zone_definitions).
          if (z.homeland != null && !Array.isArray(z.homeland)) errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: homeland must be an array when provided`);
          if (z.ai != null && !Array.isArray(z.ai))             errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: ai must be an array when provided`);
          // team is optional here: if omitted, /setup maps falls back to a /draw
          // assignment (see event_zone_assignments) and that zone's approved
          // registrations for the roster.
          if (z.team != null) {
            if (typeof z.team !== "object") {
              errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: team must be an object when provided`);
            } else {
              if (!z.team.teamName) errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: team missing teamName`);
              if (!Array.isArray(z.team.players)) errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: team.players must be array`);
              if (z.team.subs != null && !Array.isArray(z.team.subs))
                errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber}: team.subs must be array when provided`);
              if (Array.isArray(z.team.players) && Number.isInteger(cfg.event?.teamSize) &&
                  z.team.players.length > cfg.event.teamSize)
                errs.push(`Map ${m.mapNumber} zone ${z.zoneNumber} (${z.team.teamName}): has ${z.team.players.length} players but teamSize is ${cfg.event.teamSize}`);
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
});

// ---------------------------
// Slash commands
// ---------------------------
const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Set up an event's Discord structure")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) =>
    s.setName("event").setDescription("Create the event's category and standing channels")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("max_team_size").setDescription("Max players per team for registration (default 5, preserved if omitted)")
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without creating anything"))
  )
  .addSubcommand((s) =>
    s.setName("maps").setDescription("Create map channels and private team threads from YAML config")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("round").setDescription("Round subdirectory name (omit if the event has no rounds)")
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without creating anything"))
  )
  .addSubcommand((s) =>
    s.setName("zones").setDescription("Import zone Homeland/AI country lists from a Google Sheet and publish #zones")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("sheet_url").setDescription("Google Sheet URL (must be shared \"Anyone with the link can view\")").setRequired(true)
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without creating anything"))
  );

const teardownCommand = new SlashCommandBuilder()
  .setName("teardown")
  .setDescription("Remove things /setup created")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) =>
    s.setName("event").setDescription("Delete the event's category and standing channels")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without deleting anything"))
  )
  .addSubcommand((s) =>
    s.setName("maps").setDescription("Delete channels/threads created by /setup maps")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("round").setDescription("Round subdirectory name (omit if the event has no rounds)")
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Print plan without deleting anything"))
      .addBooleanOption((o) => o.setName("delete_state").setDescription("Delete state file after teardown"))
  );

const registerCommand = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Register yourself and your team for this event (run in #registration)")
  .addStringOption((o) =>
    o.setName("team").setDescription("Your team name").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName("ign").setDescription("Your in-game name").setRequired(true)
  );

const unregisterCommand = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Withdraw your own registration for this event (run in #registration)");

const drawCommand = new SlashCommandBuilder()
  .setName("draw")
  .setDescription("Record which approved team is assigned to which zone (run in #registered-teams)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((o) =>
    o.setName("zone").setDescription("Zone number").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName("team").setDescription("Approved team name").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) =>
    o.setName("round").setDescription("Round subdirectory name (omit if the event has no rounds)")
  );

const registrationsCommand = new SlashCommandBuilder()
  .setName("registrations")
  .setDescription("Review and manage player registrations")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) =>
    s.setName("list").setDescription("List registrations for an event")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s.setName("approve").setDescription("Bulk-approve every pending registration for a team")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("team").setDescription("Team name").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((s) =>
    s.setName("approve_player").setDescription("Approve a single player's registration")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addUserOption((o) => o.setName("player").setDescription("Player to approve").setRequired(true))
  )
  .addSubcommand((s) =>
    s.setName("reject").setDescription("Reject a single player's registration")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addUserOption((o) => o.setName("player").setDescription("Player to reject").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Optional reason"))
  )
  .addSubcommand((s) =>
    s.setName("reject_team").setDescription("Bulk-reject every pending registration for a team")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("team").setDescription("Team name").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((s) =>
    s.setName("export").setDescription("Export approved teams as a YAML-ready snippet")
      .addStringOption((o) =>
        o.setName("event").setDescription("Event directory name in src/config").setRequired(true)
      )
  );

const lobbyCommand = new SlashCommandBuilder()
  .setName("lobby")
  .setDescription("Manage the matchmaking lobby")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const createMatchCommand = new SlashCommandBuilder()
  .setName("create_match")
  .setDescription("Create a pending match between two teams (up to 5v5; use /matchmake save:True for larger)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption((o) => o.setName("save").setDescription("Save the suggested matchup as a pending match"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const leagueCommand = new SlashCommandBuilder()
  .setName("league")
  .setDescription("Show the league table for a season")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) => o.setName("season").setDescription("Season name (defaults to active season)"))
  .addBooleanOption((o) => o.setName("test").setDescription("Use test database"));

const matchmakeCommand = new SlashCommandBuilder()
  .setName("matchmake")
  .setDescription("Matchmaking operations")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((s) =>
    s.setName("create").setDescription("Split lobby players into balanced teams and create pending matches")
      .addIntegerOption((o) =>
        o.setName("team_size").setDescription("Players per team").setRequired(true).setMinValue(1)
      )
      .addIntegerOption((o) =>
        o.setName("round").setDescription("Round number e.g. 1").setRequired(true).setMinValue(1)
      )
      .addBooleanOption((o) => o.setName("test").setDescription("Use test database"))
  )
  .addSubcommand((s) =>
    s.setName("teardown").setDescription("Delete match channels for a given season and round")
      .addStringOption((o) =>
        o.setName("season").setDescription("Season name e.g. S1").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("round").setDescription("Round number e.g. 1").setRequired(true).setMinValue(1)
      )
      .addBooleanOption((o) => o.setName("dryrun").setDescription("Preview what would be deleted without deleting"))
  );

// ---------------------------
// Permission helpers
// ---------------------------
function isStaff(interaction) {
  const staffRoleId = process.env.EVENT_STAFF_ROLE_ID;
  if (!staffRoleId) return false;
  return interaction.member?.roles?.cache?.has(staffRoleId);
}

function isWarboy(interaction) {
  const warboyRoleId = process.env.WARBOY_ROLE_ID;
  if (!warboyRoleId) return false;
  return interaction.member?.roles?.cache?.has(warboyRoleId);
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

// @everyone can view the category/standing channels, but can't create/delete channels —
// that stays admin-only via the guild's own role permissions.
function categoryOverwrites(guild) {
  return [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel],
      deny: [PermissionsBitField.Flags.ManageChannels],
    },
  ];
}

function standingChannelOverwrites(guild, channelName) {
  const staffOnly = STANDING_CHANNEL_STAFF_ONLY.has(channelName);
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      allow: staffOnly ? [] : [PermissionsBitField.Flags.ViewChannel],
      deny: staffOnly
        ? [PermissionsBitField.Flags.ViewChannel]
        : STANDING_CHANNEL_OPEN_POST.has(channelName) ? [] : [PermissionsBitField.Flags.SendMessages],
    },
  ];

  if (staffOnly) {
    // @everyone is denied ViewChannel above, so both staff and the bot need
    // explicit allows here to see/post in this channel at all.
    overwrites.push({
      id: guild.client.user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
    });
    const staffRoleId = process.env.EVENT_STAFF_ROLE_ID;
    if (staffRoleId) {
      overwrites.push({
        id: staffRoleId,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      });
    }
  }

  // Tested in practice: Use Application Commands alone was NOT sufficient to
  // let Warboys run /register here -- Send Messages is required too, despite
  // slash commands being conceptually gated by the former. Grant both rather
  // than relying on the documented-but-apparently-incomplete permission model.
  const warboyRoleId = process.env.WARBOY_ROLE_ID;
  if (channelName === "registration" && warboyRoleId) {
    overwrites.push({
      id: warboyRoleId,
      allow: [PermissionsBitField.Flags.UseApplicationCommands, PermissionsBitField.Flags.SendMessages],
    });
  }

  return overwrites;
}

async function resolveEventCategory(guild, state, categoryName, dryrun) {
  let category = state.categoryId
    ? await guild.channels.fetch(state.categoryId).catch(() => null)
    : null;

  if (!category) {
    const channels = await guild.channels.fetch();
    category = channels.find(
      (c) => c && c.type === ChannelType.GuildCategory && c.name === categoryName
    );
  }

  if (!category && !dryrun) {
    category = await guild.channels.create({
      name: categoryName, type: ChannelType.GuildCategory, reason: "Event setup",
      permissionOverwrites: categoryOverwrites(guild),
    });
  }

  if (category && !dryrun) {
    await category.permissionOverwrites.set(categoryOverwrites(guild), "Event setup - enforce permissions");
  }

  if (category) state.categoryId = category.id;
  return category ? category.id : null;
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

// ---------------------------
// Rules index (definitions -> #rules)
// ---------------------------
const DEFINITIONS_CATEGORY_NAME = "definitions";
const RULES_MESSAGE_MAX_LENGTH = 1900; // Discord's hard cap is 2000; leave headroom for the heading/ellipsis.

function definitionTermFromChannelName(name) {
  // Strip a leading emoji (any codepoints, incl. ZWJ sequences) + separator,
  // e.g. "☢️-act-of-war" -> "act-of-war". Emoji never contain a literal "-",
  // so the first hyphen is always the boundary.
  return name.replace(/^\S*?-/, "");
}

function titleCaseTerm(term) {
  return term.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Called from the /setup event handler (not a separate command) — kept as
// its own function so it can still be promoted to a server-level,
// non-event-scoped command later without rework. Never throws: a missing
// "definitions" category (e.g. the test server, which has none) is a
// graceful skip so it can't break /setup event itself.
async function publishRulesIndex(guild, eventKey, rulesChannelId, dryrun) {
  const allChannels = await guild.channels.fetch();
  const defCategory = allChannels.find(
    (c) => c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === DEFINITIONS_CATEGORY_NAME
  );
  if (!defCategory) {
    return { skipped: true, reason: `no "${DEFINITIONS_CATEGORY_NAME}" category found on this server` };
  }

  const defChannels = [...allChannels.values()]
    .filter((c) => c && c.type === ChannelType.GuildText && c.parentId === defCategory.id)
    .map((channel) => ({ channel, term: definitionTermFromChannelName(channel.name) }))
    .sort((a, b) => a.term.localeCompare(b.term));

  if (!rulesChannelId) return { skipped: true, reason: "#rules channel doesn't exist yet" };
  const rulesChannel = await guild.channels.fetch(rulesChannelId).catch(() => null);
  if (!rulesChannel) return { skipped: true, reason: "#rules channel could not be fetched" };

  const indexState = await db.loadRulesIndexState(eventKey, DB_IS_TEST);
  let created = 0, updated = 0;

  if (dryrun) {
    const planLines = defChannels.map(({ term }) => {
      const existingId = indexState.definitions?.[term]?.messageId;
      if (existingId) updated++; else created++;
      return `${existingId ? "update" : "create"}: ${term}`;
    });
    planLines.push(indexState.indexMessageId ? "update: index message (posted first)" : "create + pin: index message (posted first)");
    return { skipped: false, dryrun: true, planLines, created, updated, total: defChannels.length };
  }

  // 1. Ensure the index message exists FIRST (placeholder if new) so it's
  //    chronologically the earliest message in the channel — editing its
  //    content later (step 3) doesn't move its position.
  let indexMessage = indexState.indexMessageId
    ? await rulesChannel.messages.fetch(indexState.indexMessageId).catch(() => null)
    : null;
  let indexAction;
  if (!indexMessage) {
    indexMessage = await rulesChannel.send("**Definitions Index**\n\n_(generating…)_");
    await indexMessage.pin().catch((e) => console.log(`Failed to pin rules index message: ${String(e?.message || e)}`));
    indexAction = "created and pinned";
  } else {
    indexAction = "updated";
  }

  // 2. Create/update each definition message.
  const newDefinitions = {};
  for (const { channel, term } of defChannels) {
    const existingId = indexState.definitions?.[term]?.messageId;
    const existingMsg = existingId ? await rulesChannel.messages.fetch(existingId).catch(() => null) : null;

    const messages = [...(await channel.messages.fetch({ limit: 100 })).values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .filter((m) => !m.author.bot);

    const body = messages
      .map((m) => m.content)
      .filter(Boolean)
      .join("\n\n")
      .trim() || "_(no definition content found)_";

    // Re-upload image attachments rather than linking the source CDN URL —
    // those URLs carry a signed, expiring query string, so a pasted link
    // would eventually render as a broken image.
    const images = messages.flatMap((m) =>
      [...m.attachments.values()]
        .filter((a) => (a.contentType || "").startsWith("image/"))
        .map((a) => ({ attachment: a.url, name: a.name || "image.png" }))
    );

    let text = `# ${titleCaseTerm(term)}\n${body}`;
    if (text.length > RULES_MESSAGE_MAX_LENGTH) text = `${text.slice(0, RULES_MESSAGE_MAX_LENGTH - 3)}...`;

    const payload = { content: text, files: images };

    if (existingMsg) {
      await existingMsg.edit(payload);
      newDefinitions[term] = { messageId: existingMsg.id };
      updated++;
    } else {
      const sent = await rulesChannel.send(payload);
      newDefinitions[term] = { messageId: sent.id };
      created++;
    }
  }

  // 3. Now that every definition message exists, edit the (already-first)
  //    index message with the real links.
  const indexLines = defChannels.map(({ term }) => {
    const messageId = newDefinitions[term]?.messageId;
    const label = titleCaseTerm(term);
    return messageId
      ? `- [${label}](https://discord.com/channels/${guild.id}/${rulesChannelId}/${messageId})`
      : `- ${label} (pending)`;
  });
  const indexBody = ["**Definitions Index**", "", ...indexLines].join("\n");
  await indexMessage.edit(indexBody);

  await db.saveRulesIndexState(
    eventKey,
    { indexMessageId: indexMessage.id, definitions: newDefinitions },
    DB_IS_TEST
  );

  return { skipped: false, dryrun: false, created, updated, total: defChannels.length, indexAction };
}

// ---------------------------
// Zones index (event_zone_definitions -> #zones)
// ---------------------------
function countryBlock(fence, countries) {
  const body = (countries || []).map((c) => ` ${c}`).join("\n") || " (none)";
  return `\`\`\`${fence}\n${body}\n\`\`\``;
}

// Matches the wording/formatting of the original hand-written #map-zones
// reference channel's legend message (see map-zones-dump.txt from this
// session) — dynamic only in the admin countries list, which comes from
// whatever was imported for this event rather than being hardcoded.
function zonesHeaderBody(adminCountries) {
  const adminLines = (adminCountries || []).map((c) => `- ${c}`).join("\n") || "- (none)";
  return [
    "# 🌐 Map Division",
    "```fix",
    "Blue denotes Homeland playable",
    "```",
    "```yaml",
    "Green denotes conquerable AI",
    "```",
    "The following countries are Admin countries",
    "```diff",
    adminLines,
    "```",
    "",
    "Countries that are not denoted as homeland or conquerable AI are not to be captured during truce.",
  ].join("\n");
}

// Called from /setup zones import and from the /setup event handler (same
// place publishRulesIndex is called) so re-running /setup event also
// refreshes #zones if zone data already exists. Never throws: no zone data
// imported yet is a graceful skip, same idiom as publishRulesIndex's
// missing-"definitions"-category skip. One message per zone (Homeland
// first, then AI, matching the reference channel), preceded by a pinned
// legend/admin-countries header — no links index.
async function publishZonesIndex(guild, eventKey, zonesChannelId, dryrun) {
  const zoneData = await db.getZoneDefinitions(eventKey, DB_IS_TEST);
  if (!zoneData || !zoneData.zones || Object.keys(zoneData.zones).length === 0) {
    return { skipped: true, reason: "no zone data imported yet — run /setup zones import" };
  }

  if (!zonesChannelId) return { skipped: true, reason: "#zones channel doesn't exist yet" };
  const zonesChannel = await guild.channels.fetch(zonesChannelId).catch(() => null);
  if (!zonesChannel) return { skipped: true, reason: "#zones channel could not be fetched" };

  const zoneNumbers = Object.keys(zoneData.zones).sort((a, b) => Number(a) - Number(b));
  const indexState = await db.loadZonesIndexState(eventKey, DB_IS_TEST);
  let created = 0, updated = 0;

  if (dryrun) {
    const planLines = zoneNumbers.map((n) => {
      const existingId = indexState.zoneMessages?.[n]?.messageId;
      if (existingId) updated++; else created++;
      return `${existingId ? "update" : "create"}: Zone ${n}`;
    });
    const staleZones = Object.keys(indexState.zoneMessages || {}).filter((n) => !zoneNumbers.includes(n));
    for (const n of staleZones) planLines.push(`remove: Zone ${n} (no longer in latest import)`);
    planLines.unshift(indexState.headerMessageId ? "update: header message" : "create + pin: header message (posted first)");
    return { skipped: false, dryrun: true, planLines, created, updated, total: zoneNumbers.length };
  }

  // 1. Header message first (placeholder if new), same reasoning as rules
  //    index: stays the chronologically-earliest message in the channel.
  let headerMessage = indexState.headerMessageId
    ? await zonesChannel.messages.fetch(indexState.headerMessageId).catch(() => null)
    : null;
  const headerBody = zonesHeaderBody(zoneData.adminCountries);
  let headerAction;
  if (!headerMessage) {
    headerMessage = await zonesChannel.send(headerBody);
    await headerMessage.pin().catch((e) => console.log(`Failed to pin zones header message: ${String(e?.message || e)}`));
    headerAction = "created and pinned";
  } else {
    await headerMessage.edit(headerBody);
    headerAction = "updated";
  }
  await db.saveZonesIndexState(eventKey, { headerMessageId: headerMessage.id, zoneMessages: indexState.zoneMessages }, DB_IS_TEST);

  // 2. Create/update each zone's message.
  const newZoneMessages = {};
  for (const n of zoneNumbers) {
    const zone = zoneData.zones[n];
    const existingId = indexState.zoneMessages?.[n]?.messageId;
    const existingMsg = existingId ? await zonesChannel.messages.fetch(existingId).catch(() => null) : null;

    const body = [
      `## Zone ${n}`,
      "### Homeland",
      countryBlock("fix", zone.homeland),
      "### AI",
      countryBlock("yaml", zone.ai),
    ].join("\n");

    if (existingMsg) {
      await existingMsg.edit(body);
      newZoneMessages[n] = { messageId: existingMsg.id };
      updated++;
    } else {
      const sent = await zonesChannel.send(body);
      newZoneMessages[n] = { messageId: sent.id };
      created++;
    }

    // Saved per-zone (not just once at the end) so a later failure doesn't
    // cause a retry to re-create zones already successfully posted.
    await db.saveZonesIndexState(eventKey, { headerMessageId: headerMessage.id, zoneMessages: newZoneMessages }, DB_IS_TEST);
  }

  // 3. Stale zones: present in the previous import's tracked messages but
  //    absent from this one. Edit in place (don't delete — avoids a broken
  //    link for anything that already references the message) and drop
  //    from tracked state.
  const staleZones = Object.keys(indexState.zoneMessages || {}).filter((n) => !zoneNumbers.includes(n));
  for (const n of staleZones) {
    const staleId = indexState.zoneMessages[n]?.messageId;
    const staleMsg = staleId ? await zonesChannel.messages.fetch(staleId).catch(() => null) : null;
    if (staleMsg) await staleMsg.edit(`_(Zone ${n} removed in latest import)_`).catch(() => null);
  }

  return { skipped: false, dryrun: false, created, updated, total: zoneNumbers.length, indexAction: headerAction };
}

// Builds a Google Sheets CSV-export URL from any share-link form of the
// same doc (edit link, view link, with or without a gid for a specific tab).
function sheetCsvExportUrl(sheetUrl) {
  const idMatch = sheetUrl.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!idMatch) throw new Error("Couldn't find a spreadsheet ID in that URL.");
  const gidMatch = sheetUrl.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gid}`;
}

// Minimal CSV line parser handling double-quoted fields (incl. "" escapes),
// sufficient for a Google Sheets CSV export — no external dependency needed
// for the 3 columns (Country/Type/Zone) this feature actually reads.
function parseCsvLine(line) {
  const fields = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { fields.push(cur); cur = ""; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}

// Parses the zone sheet's CSV into { zones: {n: {homeland, ai}}, adminCountries, warnings }.
// Rows with a blank Zone (the unassigned country pool) are skipped entirely.
function parseZonesCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("Sheet CSV export was empty.");

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const countryIdx = header.indexOf("country");
  const typeIdx    = header.indexOf("type");
  const zoneIdx    = header.indexOf("zone");
  if (countryIdx === -1 || typeIdx === -1 || zoneIdx === -1) {
    throw new Error(`Sheet must have "Country", "Type", and "Zone" columns (found: ${header.join(", ")}).`);
  }

  const zones = {};
  const adminCountries = [];
  const warnings = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const country = (row[countryIdx] || "").trim();
    const type    = (row[typeIdx] || "").trim().toLowerCase();
    const zoneRaw = (row[zoneIdx] || "").trim().toLowerCase();
    if (!country || !zoneRaw) continue; // unassigned country pool

    if (zoneRaw === "admin") {
      adminCountries.push(country);
      continue;
    }

    const zoneNumber = Number(zoneRaw);
    if (!Number.isInteger(zoneNumber)) {
      warnings.push(`Row ${i + 1}: unrecognized Zone value "${row[zoneIdx]}" for ${country} — skipped.`);
      continue;
    }

    const key = String(zoneNumber);
    if (!zones[key]) zones[key] = { homeland: [], ai: [] };

    if (type === "homeland") zones[key].homeland.push(country);
    else if (type === "ai") zones[key].ai.push(country);
    else warnings.push(`Row ${i + 1}: unrecognized Type "${row[typeIdx]}" for ${country} (Zone ${zoneNumber}) — skipped.`);
  }

  return { zones, adminCountries, warnings };
}

// ---------------------------
// Registrations
// ---------------------------
async function syncRegisteredTeamsChannel(guild, eventKey) {
  const catState = await db.loadCategoryState(eventKey, DB_IS_TEST);
  const channelInfo = catState.standingChannels?.["registered-teams"];
  if (!channelInfo?.id) return;
  const channel = await guild.channels.fetch(channelInfo.id).catch(() => null);
  if (!channel) return;

  const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
  const approved = Object.entries(entries).filter(([, e]) => e.status === "approved");

  const byTeam = {};
  for (const [userId, entry] of approved) {
    (byTeam[entry.team] ||= []).push({ userId, ign: entry.ign });
  }
  const teamNames = Object.keys(byTeam).sort((a, b) => a.localeCompare(b));

  const lines = [`**Registered Teams — ${eventKey}**`, `_Last updated: ${new Date().toISOString()}_`, ""];
  if (teamNames.length === 0) {
    lines.push("_No teams approved yet._");
  } else {
    for (const team of teamNames) {
      lines.push(`**${team}**`);
      for (const p of byTeam[team]) {
        lines.push(p.ign ? `• <@${p.userId}> (IGN: ${p.ign})` : `• <@${p.userId}>`);
      }
      lines.push("");
    }
  }
  const body = lines.join("\n").trim();

  const registeredTeamsMessageId = await db.getRegisteredTeamsMessageId(eventKey, DB_IS_TEST);
  let message = registeredTeamsMessageId
    ? await channel.messages.fetch(registeredTeamsMessageId).catch(() => null)
    : null;

  if (message) {
    await message.edit(body);
  } else {
    message = await channel.send(body);
    await db.setRegisteredTeamsMessageId(eventKey, message.id, DB_IS_TEST);
  }
}

async function approveTeam(guild, eventKey, team, reviewerId) {
  await db.approveTeamRegistrations(eventKey, team, reviewerId, DB_IS_TEST);
  await syncRegisteredTeamsChannel(guild, eventKey);
}

async function rejectTeam(guild, eventKey, team, reviewerId) {
  await db.rejectTeamRegistrations(eventKey, team, reviewerId, DB_IS_TEST);
  await syncRegisteredTeamsChannel(guild, eventKey);
}

async function postTeamReadyNotification(guild, eventKey, team) {
  const catState = await db.loadCategoryState(eventKey, DB_IS_TEST);
  const channelId = catState.standingChannels?.applications?.id;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
  const members = Object.entries(entries).filter(
    ([, e]) => e.team === team && e.status !== "rejected"
  );

  const lines = members.map(([userId, e]) =>
    e.ign ? `• <@${userId}> (IGN: ${e.ign})` : `• <@${userId}>`
  );
  const body =
    `**Team "${team}" is ready for review — ${eventKey}**\n` +
    `${members.length} player(s) registered:\n${lines.join("\n")}`;

  const token = crypto.randomBytes(4).toString("hex");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reg:${eventKey}:${token}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reg:${eventKey}:${token}:reject`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );

  const message = await channel.send({ content: body, components: [row] });

  await db.addPendingReview(eventKey, token, team, message.id, DB_IS_TEST);
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

  try {
    await db.initSchema(false);
    await db.initSchema(true);
    console.log("DB schema ready (prod + test)");
  } catch (err) {
    console.error("DB schema init failed — setup/teardown/registration commands and matchmaking/ELO features will error until Postgres is reachable:", err.message);
  }

  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([
    setupCommand,
    teardownCommand,
    registerCommand,
    unregisterCommand,
    drawCommand,
    registrationsCommand,
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
    // Autocomplete for /register team, /registrations approve|reject_team team,
    // /draw zone|team, and /record_result match field
    if (interaction.isAutocomplete()) {
      const cmd = interaction.commandName;

      if (cmd === "draw") {
        if (!isStaff(interaction)) return interaction.respond([]);
        const eventKey = await eventKeyForCategory(interaction.channel?.parentId);
        if (!eventKey) return interaction.respond([]);
        const round     = interaction.options.getString("round") || null;
        const focusedOpt = interaction.options.getFocused(true);
        const focused    = String(focusedOpt.value).toLowerCase();

        if (focusedOpt.name === "zone") {
          const configPath = path.join(roundDir(eventKey, round), "config.yml");
          if (!fs.existsSync(configPath)) return interaction.respond([]);
          const cfg = readYaml(configPath);
          const zoneNumbers = [...new Set(
            (cfg.maps || []).flatMap((m) => (m.zones || []).map((z) => z.zoneNumber))
          )].sort((a, b) => a - b);
          const assignments = await db.getZoneAssignments(eventKey, round, DB_IS_TEST);
          const choices = zoneNumbers
            .filter((z) => String(z).includes(focused))
            .slice(0, 25)
            .map((z) => ({
              name: assignments[z] ? `Zone ${z} (currently: ${assignments[z].team})` : `Zone ${z} (unassigned)`,
              value: z,
            }));
          return interaction.respond(choices);
        }

        if (focusedOpt.name === "team") {
          const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
          const approvedTeams = [...new Set(
            Object.values(entries).filter((e) => e.status === "approved").map((e) => e.team)
          )];
          const assignments   = await db.getZoneAssignments(eventKey, round, DB_IS_TEST);
          const assignedTeams = new Map(Object.entries(assignments).map(([z, a]) => [a.team, z]));
          const choices = approvedTeams
            .filter((t) => t.toLowerCase().includes(focused))
            .sort((a, b) => (assignedTeams.has(a) ? 1 : 0) - (assignedTeams.has(b) ? 1 : 0))
            .slice(0, 25)
            .map((t) => ({
              name: assignedTeams.has(t) ? `${t} (zone ${assignedTeams.get(t)})` : t,
              value: t,
            }));
          return interaction.respond(choices);
        }

        return interaction.respond([]);
      }

      const isTeamAutocomplete =
        cmd === "register" ||
        (cmd === "registrations" && ["approve", "reject_team"].includes(interaction.options.getSubcommand()));

      if (isTeamAutocomplete) {
        let eventKey;
        if (cmd === "register") {
          if (!isWarboy(interaction) && !isStaff(interaction)) return interaction.respond([]);
          eventKey = await eventKeyForCategory(interaction.channel?.parentId);
        } else {
          if (!isStaff(interaction)) return interaction.respond([]);
          eventKey = interaction.options.getString("event");
        }
        if (!eventKey) return interaction.respond([]);

        const focused = interaction.options.getFocused().toLowerCase();
        const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
        const teams   = [...new Set(Object.values(entries).map((e) => e.team))];
        const choices  = teams
          .filter((t) => t.toLowerCase().includes(focused))
          .slice(0, 25)
          .map((t) => ({ name: t.slice(0, 100), value: t }));
        return interaction.respond(choices);
      }

      if (!isStaff(interaction)) return interaction.respond([]);
      const isTest  = interaction.options.get("test")?.value ?? false;
      const focused = interaction.options.getFocused().toLowerCase();
      const pending = await db.getPendingMatches(isTest);
      const choices = pending
        .filter((m) => m.label.toLowerCase().includes(focused))
        .map((m) => ({ name: m.label.slice(0, 100), value: m.match_id }));
      return interaction.respond(choices);
    }

    // Approve/Reject buttons on team-ready-for-review notifications
    if (interaction.isButton()) {
      const [prefix, eventKey, token, action] = interaction.customId.split(":");
      if (prefix !== "reg") return;
      if (!isStaff(interaction)) {
        return interaction.reply({ content: "Staff only.", ephemeral: true });
      }
      await interaction.deferUpdate();

      const pending = await db.getPendingReview(eventKey, token, DB_IS_TEST);
      if (!pending) {
        return interaction.followUp({ content: "Already handled.", ephemeral: true });
      }

      if (action === "approve") await approveTeam(interaction.guild, eventKey, pending.team, interaction.user.id);
      else if (action === "reject") await rejectTeam(interaction.guild, eventKey, pending.team, interaction.user.id);

      await db.deletePendingReview(eventKey, token, DB_IS_TEST);

      const outcome = action === "approve" ? "✅ Approved" : "❌ Rejected";
      return interaction.editReply({
        content: `${interaction.message.content}\n\n${outcome} by <@${interaction.user.id}>`,
        components: [],
      });
    }

    if (!interaction.isChatInputCommand()) return;

    if (WARBOY_GATED_COMMANDS.has(interaction.commandName)) {
      if (!isWarboy(interaction) && !isStaff(interaction)) {
        return interaction.reply({ content: "Warboy role required.", ephemeral: true });
      }
    } else if (!isStaff(interaction)) {
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
      const sub = interaction.options.getSubcommand();

      // -- teardown --
      if (sub === "teardown") {
        const seasonName = interaction.options.getString("season");
        const round      = interaction.options.getInteger("round");
        const dryrun     = interaction.options.getBoolean("dryrun") ?? false;
        const categoryId = process.env.EVENT_CATEGORY_ID;

        if (!categoryId)
          return interaction.editReply("❌ EVENT_CATEGORY_ID not set in .env");

        const prefix   = `${slugify(seasonName)}-r${round}-`;
        const channels = await guild.channels.fetch();
        const toDelete = channels.filter(
          (c) => c && c.type === ChannelType.GuildText && c.parentId === categoryId && c.name.startsWith(prefix)
        );

        if (toDelete.size === 0)
          return interaction.editReply(`No channels found matching \`${prefix}*\` in the event category.`);

        if (dryrun) {
          const names = [...toDelete.values()].map((c) => `#${c.name}`).join("\n");
          return interaction.editReply(`Dry-run: would delete **${toDelete.size}** channel(s):\n${names}`);
        }

        let deleted = 0;
        for (const [, ch] of toDelete) {
          try {
            await ch.delete(`Matchmake teardown: ${seasonName} round ${round}`);
            deleted++;
          } catch (e) {
            console.error(`Failed to delete ${ch.name}:`, e);
          }
        }
        return interaction.editReply(`✅ Deleted **${deleted}** channel(s) matching \`${prefix}*\`.`);
      }

      // -- create --
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

    // ---- /setup event ----
    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "event") {
      const eventKey      = interaction.options.getString("event");
      const maxTeamSizeIn = interaction.options.getInteger("max_team_size");
      const dryrun        = interaction.options.getBoolean("dryrun") ?? false;
      const state = await db.loadCategoryState(eventKey, DB_IS_TEST);

      const categoryName = eventKey;
      const categoryId   = await resolveEventCategory(guild, state, categoryName, dryrun);

      if (maxTeamSizeIn != null) state.maxTeamSize = maxTeamSizeIn;
      else if (state.maxTeamSize == null) state.maxTeamSize = 5;

      const planLines = [];
      let createdStanding = 0, reusedStanding = 0;

      if (!categoryId) {
        planLines.push(`Category "${categoryName}": would create`);
      } else {
        await assertBotAccess(guild, categoryId);
        planLines.push(`Category "${categoryName}": ready`);
      }

      for (const channelName of STANDING_CHANNEL_NAMES) {
        let channelId = state.standingChannels?.[channelName]?.id;
        let channel   = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
        if (!channel && categoryId) channel = await findChannelByNameInCategory(guild, categoryId, channelName);

        // "registered-teams" is created/resolved earlier in STANDING_CHANNEL_NAMES
        // than "registration", so its ID is already known by the time we need it.
        const topicTemplate = STANDING_CHANNEL_TOPICS[channelName];
        const topic = typeof topicTemplate === "function"
          ? topicTemplate(guild.id, state.standingChannels?.["registered-teams"]?.id)
          : topicTemplate;

        if (!channel) {
          if (dryrun) {
            planLines.push(`  - would create channel #${channelName}`);
          } else {
            channel = await guild.channels.create({
              name: channelName, type: ChannelType.GuildText, parent: categoryId, reason: "Event creation",
              permissionOverwrites: standingChannelOverwrites(guild, channelName),
              topic,
              rateLimitPerUser: STANDING_CHANNEL_SLOWMODE[channelName],
            });
            createdStanding++;
            state.standingChannels[channelName] = { id: channel.id };
            planLines.push(`  - created channel #${channelName}`);
          }
        } else {
          reusedStanding++;
          state.standingChannels[channelName] = { id: channel.id };
          planLines.push(`  - channel #${channelName}: ready`);
        }

        if (channel && !dryrun) {
          await channel.permissionOverwrites.set(
            standingChannelOverwrites(guild, channelName),
            "Event setup - enforce permissions"
          );
          if (topic && channel.topic !== topic) {
            await channel.edit({ topic });
          }
          if (
            STANDING_CHANNEL_SLOWMODE[channelName] != null &&
            channel.rateLimitPerUser !== STANDING_CHANNEL_SLOWMODE[channelName]
          ) {
            await channel.edit({ rateLimitPerUser: STANDING_CHANNEL_SLOWMODE[channelName] });
          }
        }
      }

      // Enforce alphabetical order within the category — STANDING_CHANNEL_NAMES
      // is declared alphabetically, but that only controls creation order for
      // brand-new channels; re-running against a category whose channels
      // already exist in some other order (or were created before this was
      // added) needs an explicit reorder every time to stay correct.
      if (!dryrun && categoryId) {
        await guild.channels.setPositions(
          STANDING_CHANNEL_NAMES.map((name, i) => ({ channel: state.standingChannels[name].id, position: i }))
        );
      }

      if (!dryrun) await db.saveCategoryState(eventKey, state, DB_IS_TEST);

      const rulesIndex = await publishRulesIndex(guild, eventKey, state.standingChannels?.rules?.id, dryrun);
      if (!rulesIndex.skipped && dryrun) {
        planLines.push("Rules index:", ...rulesIndex.planLines.map((l) => `  - ${l}`));
      }

      const zonesIndex = await publishZonesIndex(guild, eventKey, state.standingChannels?.zones?.id, dryrun);
      if (!zonesIndex.skipped && dryrun) {
        planLines.push("Zones index:", ...zonesIndex.planLines.map((l) => `  - ${l}`));
      }

      if (dryrun)
        return interaction.editReply(`Dry-run ✅\n\nPlan:\n${planLines.map((l) => `• ${l}`).join("\n")}`);

      const rulesIndexNote = rulesIndex.skipped
        ? `Rules index: skipped (${rulesIndex.reason}).`
        : `Rules index: ${rulesIndex.total} definition(s) — created ${rulesIndex.created}, updated ${rulesIndex.updated} (index ${rulesIndex.indexAction}).`;

      const zonesIndexNote = zonesIndex.skipped
        ? `Zones index: skipped (${zonesIndex.reason}).`
        : `Zones index: ${zonesIndex.total} zone(s) — created ${zonesIndex.created}, updated ${zonesIndex.updated} (index ${zonesIndex.indexAction}).`;

      return interaction.editReply(
        `Done ✅\nCategory "${categoryName}" ready. Max team size: ${state.maxTeamSize}.\n` +
        `Standing channels — created: ${createdStanding}, reused: ${reusedStanding}\n` +
        `${rulesIndexNote}\n${zonesIndexNote}`
      );
    }

    // ---- /setup maps ----
    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "maps") {
      const eventKey     = interaction.options.getString("event");
      const round        = interaction.options.getString("round") || null;
      const dryrun       = interaction.options.getBoolean("dryrun") ?? false;
      const configPath   = path.join(roundDir(eventKey, round), "config.yml");
      const templatePath = path.join(roundDir(eventKey, round), "thread.md");

      if (!fs.existsSync(configPath))   return interaction.editReply(`Config not found: ${configPath}`);
      if (!fs.existsSync(templatePath)) return interaction.editReply(`Thread template not found: ${templatePath}`);

      const cfg      = readYaml(configPath);
      const template = readText(templatePath);
      const errors   = validateConfig(cfg);
      if (errors.length) return interaction.editReply(`Config validation failed:\n- ${errors.join("\n- ")}`);

      const categoryState = await db.loadCategoryState(eventKey, DB_IS_TEST);
      const existingCategory = categoryState.categoryId
        ? await guild.channels.fetch(categoryState.categoryId).catch(() => null)
        : null;
      const categoryId = existingCategory?.id ?? null;
      if (!categoryId) return interaction.editReply("Category not set up yet — run `/setup event` first.");
      await assertBotAccess(guild, categoryId);

      const state = await db.loadRoundState(eventKey, round, DB_IS_TEST);

      const channelPrefix = round ? `${eventKey}-${round}` : eventKey;
      const planLines = [];
      let createdChannels = 0, createdThreads = 0, reusedChannels = 0, reusedThreads = 0;
      const zoneData = await db.getZoneDefinitions(eventKey, DB_IS_TEST);
      const zoneAssignments = await db.getZoneAssignments(eventKey, round, DB_IS_TEST);

      // For maps with `teams: registrations` (below) — team rosters come
      // live from approved /register entries instead of being hand-authored
      // in config.yml. Approval is already the trust boundary (staff only
      // approve teams via /registrations approve), so no further name
      // vetting happens here before using it as a thread name.
      const registrationEntries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
      const approvedTeams = {};
      for (const [playerId, entry] of Object.entries(registrationEntries)) {
        if (entry.status !== "approved") continue;
        (approvedTeams[entry.team] ||= []).push(playerId);
      }

      for (const map of cfg.maps) {
        const channelName = `${channelPrefix}-map${pad2(map.mapNumber)}`;
        planLines.push(`Map ${map.mapNumber}: channel #${channelName}`);

        let mapChannelId = state.channels?.[channelName]?.id;
        let mapChannel   = mapChannelId ? await guild.channels.fetch(mapChannelId).catch(() => null) : null;
        if (!mapChannel && categoryId) mapChannel = await findChannelByNameInCategory(guild, categoryId, channelName);

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

        if (Array.isArray(map.theatres)) {
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
                const playable = (pool.playableCountries || []).map((c) => `- ${c}`).join("\n");
                const ai       = (pool.aiCountries || []).map((c) => `- ${c}`).join("\n");
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
        }

        if (Array.isArray(map.zones)) {
          for (const zone of map.zones) {
            let team = zone.team;
            if (!team) {
              const assignedTeamName = zoneAssignments[zone.zoneNumber]?.team;
              if (!assignedTeamName) {
                planLines.push(
                  `  - zone ${zone.zoneNumber}: ERROR — no team in config.yml and no /draw assignment ` +
                  `(run /draw for this zone first)`
                );
                continue;
              }
              const players = Object.entries(registrationEntries)
                .filter(([, e]) => e.team === assignedTeamName && e.status === "approved")
                .map(([playerId]) => playerId);
              team = { teamName: assignedTeamName, players, subs: [] };
            }

            const dbZone = zoneData?.zones?.[String(zone.zoneNumber)];
            const homeland = zone.homeland ?? dbZone?.homeland;
            const ai       = zone.ai       ?? dbZone?.ai;
            if (!homeland || !ai) {
              planLines.push(
                `  - zone ${zone.zoneNumber}: ERROR — no homeland/ai data in config.yml or imported zone data ` +
                `(run /setup zones import for "${eventKey}" first)`
              );
              continue;
            }

            const threadName = slugify(team.teamName);
            planLines.push(`  - zone ${zone.zoneNumber}: would ensure private thread "${threadName}"`);
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
              const playableLines = (homeland || []).map((c) => `- ${c}`).join("\n");
              const aiLines       = (ai || []).map((c) => `- ${c}`).join("\n");
              const body = renderTemplate(template, {
                EVENT_NAME: cfg.event.name, EVENT_ROUND: String(cfg.event.round),
                EVENT_KEY: cfg.event.key, MAP_NUMBER: String(map.mapNumber),
                MAP_NUMBER_PAD2: pad2(map.mapNumber),
                ZONE_NUMBER: String(zone.zoneNumber),
                ZONE_NAME: zone.name || `Zone ${zone.zoneNumber}`,
                TEAM_NAME: team.teamName,
                PLAYABLE_COUNTRIES: playableLines || "- (none)",
                AI_COUNTRIES: aiLines || "- (none)",
                PLAYERS_MENTIONS: mentionList(team.players),
                SUBS_MENTIONS: mentionList(team.subs) || "- None",
                TEAM_SIZE: String(cfg.event.teamSize),
              });
              await thread.send(body);
              await addPlayersToThread(guild, thread, team.players);
              await addPlayersToThread(guild, thread, team.subs);
              state.threads[`${channelName}:${threadName}`].posted = true;
            }
          }
        }

        if (map.teams === "registrations") {
          for (const [teamName, playerIds] of Object.entries(approvedTeams)) {
            const threadName = slugify(teamName);
            planLines.push(`  - team "${teamName}": would ensure private thread "${threadName}"`);
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
              const body = renderTemplate(template, {
                EVENT_NAME: cfg.event.name, EVENT_ROUND: String(cfg.event.round),
                EVENT_KEY: cfg.event.key, MAP_NUMBER: String(map.mapNumber),
                MAP_NUMBER_PAD2: pad2(map.mapNumber),
                TEAM_NAME: teamName,
                PLAYERS_MENTIONS: mentionList(playerIds),
                SUBS_MENTIONS: "- None",
                TEAM_SIZE: String(cfg.event.teamSize),
              });
              await thread.send(body);
              await addPlayersToThread(guild, thread, playerIds);
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

      if (!dryrun) await db.saveRoundState(eventKey, round, state, DB_IS_TEST);
      if (dryrun)
        return interaction.editReply(`Dry-run ✅\n\nPlan:\n${planLines.map((l) => `• ${l}`).join("\n")}`);
      return interaction.editReply(
        `Done ✅\nCreated: ${createdChannels} channels, ${createdThreads} threads\n` +
        `Reused: ${reusedChannels} channels, ${reusedThreads} threads`
      );
    }

    // ---- /setup zones ----
    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "zones") {
      const eventKey  = interaction.options.getString("event");
      const sheetUrl  = interaction.options.getString("sheet_url");
      const dryrun    = interaction.options.getBoolean("dryrun") ?? false;

      const catState = await db.loadCategoryState(eventKey, DB_IS_TEST);
      if (!catState.categoryId) {
        return interaction.editReply(`Event "${eventKey}" has no category yet — run \`/setup event\` first.`);
      }

      let csvText;
      try {
        const csvUrl = sheetCsvExportUrl(sheetUrl);
        const res = await fetch(csvUrl);
        if (!res.ok) {
          return interaction.editReply(
            `Couldn't fetch that sheet (HTTP ${res.status}). Make sure it's shared "Anyone with the link can view".`
          );
        }
        csvText = await res.text();
      } catch (e) {
        return interaction.editReply(`Failed to fetch sheet: ${String(e?.message || e)}`);
      }

      let parsed;
      try {
        parsed = parseZonesCsv(csvText);
      } catch (e) {
        return interaction.editReply(`Failed to parse sheet: ${String(e?.message || e)}`);
      }

      const zoneCount = Object.keys(parsed.zones).length;
      const warningsNote = parsed.warnings.length ? `\nWarnings:\n${parsed.warnings.map((w) => `- ${w}`).join("\n")}` : "";

      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅\n\nWould import ${zoneCount} zone(s) and ${parsed.adminCountries.length} admin ` +
          `countr${parsed.adminCountries.length === 1 ? "y" : "ies"} for "${eventKey}".${warningsNote}`
        );
      }

      await db.saveZoneDefinitions(
        eventKey,
        { zones: parsed.zones, adminCountries: parsed.adminCountries, sourceSheetUrl: sheetUrl },
        DB_IS_TEST
      );

      const zonesIndex = await publishZonesIndex(guild, eventKey, catState.standingChannels?.zones?.id, false);
      const zonesIndexNote = zonesIndex.skipped
        ? `Zones index: skipped (${zonesIndex.reason}).`
        : `Zones index: ${zonesIndex.total} zone(s) — created ${zonesIndex.created}, updated ${zonesIndex.updated} (index ${zonesIndex.indexAction}).`;

      return interaction.editReply(
        `Done ✅\nImported ${zoneCount} zone(s) and ${parsed.adminCountries.length} admin ` +
        `countr${parsed.adminCountries.length === 1 ? "y" : "ies"} for "${eventKey}".\n${zonesIndexNote}${warningsNote}`
      );
    }


    // ---- /teardown ----
    // ---- /teardown event ----
    if (interaction.commandName === "teardown" && interaction.options.getSubcommand() === "event") {
      const eventKey  = interaction.options.getString("event");
      const dryrun    = interaction.options.getBoolean("dryrun") ?? false;
      const state = await db.loadCategoryState(eventKey, DB_IS_TEST);

      if (!state.categoryId) return interaction.editReply(`Nothing to tear down — no category found for "${eventKey}".`);

      const standingIds     = Object.values(state.standingChannels || {}).map((x) => x.id).filter(Boolean);
      const lingeringRounds = await findLingeringRoundStates(eventKey);
      const warning = lingeringRounds.length
        ? `\n⚠️ Round(s) still have tracked map channels/threads: ${lingeringRounds.join(", ")}. ` +
          `Run \`/teardown maps\` for those first if you want them cleaned up too — this won't touch them.`
        : "";

      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅\nWould delete category "${eventKey}" and ${standingIds.length} standing channel(s).${warning}`
        );
      }

      let deletedStanding = 0;
      for (const id of standingIds) {
        try {
          const ch = await guild.channels.fetch(id).catch(() => null);
          if (ch) { await ch.delete("Event teardown"); deletedStanding++; }
        } catch (e) { console.log(`Failed to delete standing channel ${id}: ${String(e?.message || e)}`); }
      }

      const category = await guild.channels.fetch(state.categoryId).catch(() => null);
      if (category) await category.delete("Event teardown").catch((e) => console.log(`Failed to delete category: ${String(e?.message || e)}`));

      await db.deleteCategoryState(eventKey, DB_IS_TEST);

      return interaction.editReply(
        `Teardown complete ✅\nDeleted category "${eventKey}" and ${deletedStanding} standing channel(s).${warning}`
      );
    }

    // ---- /teardown maps ----
    if (interaction.commandName === "teardown" && interaction.options.getSubcommand() === "maps") {
      const eventKey    = interaction.options.getString("event");
      const round       = interaction.options.getString("round") || null;
      const dryrun      = interaction.options.getBoolean("dryrun") ?? false;
      const deleteState = interaction.options.getBoolean("delete_state") ?? false;
      const configPath  = path.join(roundDir(eventKey, round), "config.yml");

      if (!fs.existsSync(configPath)) return interaction.editReply(`Config not found: ${configPath}`);

      const state = await db.loadRoundState(eventKey, round, DB_IS_TEST);

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

      if (deleteState) await db.deleteRoundState(eventKey, round, DB_IS_TEST);

      return interaction.editReply(
        `Teardown complete ✅\nDeleted ${deletedThreads} threads and ${deletedChannels} channels.`
      );
    }

    // ---- /draw ----
    if (interaction.commandName === "draw") {
      const eventKey = await eventKeyForCategory(interaction.channel?.parentId);
      if (!eventKey) {
        return interaction.editReply("Please run this in an event's #registered-teams channel.");
      }

      const round      = interaction.options.getString("round") || null;
      const zoneNumber = interaction.options.getInteger("zone");
      const team       = interaction.options.getString("team");

      const configPath = path.join(roundDir(eventKey, round), "config.yml");
      if (!fs.existsSync(configPath)) return interaction.editReply(`Config not found: ${configPath}`);
      const cfg = readYaml(configPath);
      const validZones = new Set(
        (cfg.maps || []).flatMap((m) => (m.zones || []).map((z) => z.zoneNumber))
      );
      if (validZones.size === 0) {
        return interaction.editReply("This round's config doesn't use zone-based teams.");
      }
      if (!validZones.has(zoneNumber)) {
        return interaction.editReply(`Zone ${zoneNumber} isn't defined in this round's config.`);
      }

      const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
      const approvedTeams = new Set(
        Object.values(entries).filter((e) => e.status === "approved").map((e) => e.team)
      );
      if (!approvedTeams.has(team)) {
        return interaction.editReply(`"${team}" isn't an approved team for this event.`);
      }

      await db.setZoneAssignment(eventKey, round, zoneNumber, team, interaction.user.id, DB_IS_TEST);

      const assignments = await db.getZoneAssignments(eventKey, round, DB_IS_TEST);
      const lines = [...validZones].sort((a, b) => a - b)
        .map((z) => `Zone ${z}: ${assignments[z]?.team ?? "_unassigned_"}`);

      return interaction.editReply(
        `✅ Assigned **${team}** to Zone ${zoneNumber}.\n\nCurrent draw:\n${lines.join("\n")}`
      );
    }

    // ---- /register ----
    if (interaction.commandName === "register") {
      const eventKey = await eventKeyForCategory(interaction.channel?.parentId);
      if (!eventKey) {
        return interaction.editReply("Please run this in an event's #registration channel.");
      }

      const team = interaction.options.getString("team");
      const ign  = interaction.options.getString("ign");
      const now  = new Date().toISOString();

      const catState = await db.loadCategoryState(eventKey, DB_IS_TEST);
      const maxTeamSize = catState.maxTeamSize ?? 5;

      const entries  = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
      const existing  = entries[interaction.user.id];
      // "Already on this team" means updating details (IGN, etc), not joining anew —
      // switching teams (or a fresh registration) is subject to the capacity check below.
      const alreadyOnThisTeam = existing?.team === team && existing?.status !== "rejected";

      const otherMembersCount = Object.entries(entries).filter(
        ([userId, e]) => e.team === team && e.status !== "rejected" && userId !== interaction.user.id
      ).length;

      if (!alreadyOnThisTeam && otherMembersCount >= maxTeamSize) {
        return interaction.editReply(`Team "${team}" is full (max ${maxTeamSize} players).`);
      }

      await db.upsertRegistration(eventKey, interaction.user.id, {
        team,
        ign,
        status: "pending",
        registeredAt: existing?.registeredAt ?? now,
        updatedAt: now,
        reviewedBy: null,
      }, DB_IS_TEST);

      // Only notify when a genuinely new member pushes the team to exactly the cap —
      // not on every re-registration of players already counted.
      if (!alreadyOnThisTeam && otherMembersCount + 1 === maxTeamSize) {
        await postTeamReadyNotification(guild, eventKey, team);
      }

      return interaction.editReply(`Registered for **${team}** — pending staff approval.`);
    }

    // ---- /unregister ----
    if (interaction.commandName === "unregister") {
      const eventKey = await eventKeyForCategory(interaction.channel?.parentId);
      if (!eventKey) {
        return interaction.editReply("Please run this in an event's #registration channel.");
      }

      const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
      const existing = entries[interaction.user.id];
      if (!existing) {
        return interaction.editReply("You're not registered for this event.");
      }

      const wasApproved = existing.status === "approved";
      const team = existing.team;
      await db.deleteRegistration(eventKey, interaction.user.id, DB_IS_TEST);

      if (wasApproved) await syncRegisteredTeamsChannel(guild, eventKey);

      return interaction.editReply(`Unregistered from **${team}**.`);
    }

    // ---- /registrations ----
    if (interaction.commandName === "registrations") {
      const sub      = interaction.options.getSubcommand();
      const eventKey = interaction.options.getString("event");

      if (sub === "list") {
        const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
        const byTeam = {};
        for (const [userId, e] of Object.entries(entries)) {
          (byTeam[e.team] ||= []).push({ userId, ...e });
        }
        const teamNames = Object.keys(byTeam).sort((a, b) => a.localeCompare(b));
        if (teamNames.length === 0) return interaction.editReply(`No registrations for "${eventKey}" yet.`);
        const lines = teamNames.map((team) => {
          const members = byTeam[team]
            .map((m) => `  - <@${m.userId}> (IGN: ${m.ign}) — ${m.status}`)
            .join("\n");
          return `**${team}**\n${members}`;
        });
        return interaction.editReply(lines.join("\n\n"));
      }

      if (sub === "approve") {
        const team = interaction.options.getString("team");
        await approveTeam(guild, eventKey, team, interaction.user.id);
        return interaction.editReply(`Approved team "${team}" for "${eventKey}".`);
      }

      if (sub === "reject_team") {
        const team = interaction.options.getString("team");
        await rejectTeam(guild, eventKey, team, interaction.user.id);
        return interaction.editReply(`Rejected team "${team}" for "${eventKey}".`);
      }

      if (sub === "approve_player") {
        const player = interaction.options.getUser("player");
        const updated = await db.setRegistrationStatus(eventKey, player.id, "approved", interaction.user.id, DB_IS_TEST);
        if (!updated) return interaction.editReply(`No registration found for ${player.tag}.`);
        await syncRegisteredTeamsChannel(guild, eventKey);
        return interaction.editReply(`Approved ${player.tag} for "${eventKey}".`);
      }

      if (sub === "reject") {
        const player = interaction.options.getUser("player");
        const reason = interaction.options.getString("reason");
        const updated = await db.setRegistrationStatus(eventKey, player.id, "rejected", interaction.user.id, DB_IS_TEST);
        if (!updated) return interaction.editReply(`No registration found for ${player.tag}.`);
        await syncRegisteredTeamsChannel(guild, eventKey);
        return interaction.editReply(
          `Rejected ${player.tag} for "${eventKey}".${reason ? ` Reason: ${reason}` : ""}`
        );
      }

      if (sub === "export") {
        const entries = await db.getRegistrationEntries(eventKey, DB_IS_TEST);
        const approved = Object.entries(entries).filter(([, e]) => e.status === "approved");
        const byTeam = {};
        for (const [userId, e] of approved) {
          (byTeam[e.team] ||= []).push({ userId, ign: e.ign });
        }
        const teamNames = Object.keys(byTeam).sort((a, b) => a.localeCompare(b));
        if (teamNames.length === 0) return interaction.editReply(`No approved teams for "${eventKey}" yet.`);
        const yamlLines = teamNames.map((team) => {
          const players = byTeam[team]
            .map((p) => `    - "${p.userId}"  # ${p.ign}`)
            .join("\n");
          return `- teamName: "${team}"\n  players:\n${players}`;
        });
        return interaction.editReply(`\`\`\`yaml\n${yamlLines.join("\n\n")}\n\`\`\``);
      }
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
