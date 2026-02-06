require("dotenv").config();

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

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
  const raw = fs.readFileSync(filePath, "utf8");
  return yaml.load(raw);
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
  // Simple {{KEY}} replacement
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v ?? "");
  }
  return out;
}

function mentionList(userIds) {
  return (userIds || []).map((id) => `<@${id}>`).join(" ");
}

// Validate YAML structure so we fail fast with helpful messages
function validateConfig(cfg) {
  const errs = [];

  if (!cfg || typeof cfg !== "object") errs.push("Config is empty or invalid YAML.");

  if (!cfg.event?.key) errs.push("Missing event.key");
  if (!cfg.event?.name) errs.push("Missing event.name");
  if (!Number.isInteger(cfg.event?.round)) errs.push("event.round must be an integer");
  if (!Number.isInteger(cfg.event?.teamSize)) errs.push("event.teamSize must be an integer");

  if (!cfg.countryPools || typeof cfg.countryPools !== "object") {
    errs.push("Missing countryPools object");
  }

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
        if (!th.id) errs.push(`Map ${m.mapNumber}: theatre missing id`);
        if (!th.name) errs.push(`Map ${m.mapNumber}: theatre missing name`);
        if (!Array.isArray(th.teams) || th.teams.length !== 2) {
          errs.push(`Map ${m.mapNumber} theatre ${th.id}: must have exactly 2 teams`);
          continue;
        }

        for (const team of th.teams) {
          if (!team.teamName) errs.push(`Map ${m.mapNumber} theatre ${th.id}: team missing teamName`);
          if (!team.countryPool) errs.push(`Map ${m.mapNumber} theatre ${th.id}: team missing countryPool`);
          if (!Array.isArray(team.players)) errs.push(`Map ${m.mapNumber} theatre ${th.id}: team.players must be array`);

          if (team.countryPool && cfg.countryPools && !cfg.countryPools[team.countryPool]) {
            errs.push(`Map ${m.mapNumber} theatre ${th.id}: unknown countryPool "${team.countryPool}"`);
          }

          // Optional: warn if too many players listed (you can choose to hard fail instead)
          if (Array.isArray(team.players) && Number.isInteger(cfg.event?.teamSize)) {
            if (team.players.length > cfg.event.teamSize) {
              errs.push(
                `Map ${m.mapNumber} theatre ${th.id} (${team.teamName}/${team.countryPool}): has ${team.players.length} players but teamSize is ${cfg.event.teamSize}`
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

// Slash commands
const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Create map channels and private team threads from YAML config")
  .addStringOption((o) =>
    o
      .setName("config")
      .setDescription("Config file base name in src/config (without extension), e.g. bt-r1-flagship")
      .setRequired(true)
  )
  .addBooleanOption((o) =>
    o.setName("dryrun").setDescription("If true, prints what would be created without creating anything")
  );

const teardownCommand = new SlashCommandBuilder()
  .setName("teardown")
  .setDescription("Delete channels/threads created by /setup using the saved state file")
  .addStringOption((o) =>
    o
      .setName("config")
      .setDescription("Config file base name in src/config (without extension), e.g. bt-r1-flagship")
      .setRequired(true)
  )
  .addBooleanOption((o) =>
    o.setName("dryrun").setDescription("If true, prints what would be deleted without deleting anything")
  )
  .addBooleanOption((o) =>
    o
      .setName("delete_state")
      .setDescription("If true, deletes the state file after teardown completes")
  );


client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guildId = process.env.GUILD_ID;
  if (!guildId) throw new Error("Missing GUILD_ID in .env");

  const guild = await client.guilds.fetch(guildId);

  // Register commands in this guild
  await guild.commands.create(setupCommand);
  await guild.commands.create(teardownCommand);

  console.log("Registered /setup and /teardown commands");
});

// Permission check: staff only
function isStaff(interaction) {
  const staffRoleId = process.env.EVENT_STAFF_ROLE_ID;
  if (!staffRoleId) return false;
  return interaction.member?.roles?.cache?.has(staffRoleId);
}

// Ensure bot can see/use the category and create channels/threads
async function assertBotAccess(guild, categoryId) {
  const category = await guild.channels.fetch(categoryId);
  if (!category) throw new Error(`EVENT_CATEGORY_ID not found: ${categoryId}`);
  return category;
}

// Add members to private thread, best-effort
async function addPlayersToThread(guild, thread, playerIds) {
  for (const userId of playerIds || []) {
    try {
      // Ensure the member exists in guild cache/api
      let member = guild.members.cache.get(userId);
      if (!member) member = await guild.members.fetch(userId);

      // Private thread membership add
      await thread.members.add(member.id);
    } catch (e) {
      const msg = String(e?.message || e);
      console.log(`Failed to add ${userId} to ${thread.name}: ${msg}`);
    }
  }
}

// Find channel by name under a category (idempotency)
async function findChannelByNameInCategory(guild, categoryId, channelName) {
  const channels = await guild.channels.fetch();
  return channels.find(
    (c) => c && c.type === ChannelType.GuildText && c.parentId === categoryId && c.name === channelName
  );
}

// Find thread by name inside a channel (idempotency)
async function findThreadByName(mapChannel, threadName) {
  // Fetch active threads
  const active = await mapChannel.threads.fetchActive();
  const foundActive = active.threads.find((t) => t.name === threadName);
  if (foundActive) return foundActive;

  // Also check archived threads (private threads can be archived)
  const archived = await mapChannel.threads.fetchArchived({ type: "private" }).catch(() => null);
  if (archived?.threads) {
    const foundArchived = archived.threads.find((t) => t.name === threadName);
    if (foundArchived) return foundArchived;
  }

  return null;
}

// ---------------------------
// Interaction handler
// ---------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    // Staff only
    if (!isStaff(interaction)) {
      return interaction.reply({ content: "Staff only.", ephemeral: true });
    }

    const categoryId = process.env.EVENT_CATEGORY_ID;
    if (!categoryId) throw new Error("Missing EVENT_CATEGORY_ID in .env");

    const guild = interaction.guild;
    if (!guild) throw new Error("This command must be run inside a server.");

    const configBase = interaction.options.getString("config");
    const dryrun = interaction.options.getBoolean("dryrun") ?? false;

    const configPath = path.join(__dirname, "config", `${configBase}.yml`);
    const templatePath = path.join(__dirname, "config", `${configBase}.thread.md`);

    if (!fs.existsSync(configPath)) {
      return interaction.reply({ content: `Config not found: ${configPath}`, ephemeral: true });
    }
    if (!fs.existsSync(templatePath)) {
      return interaction.reply({ content: `Thread template not found: ${templatePath}`, ephemeral: true });
    }

    const cfg = readYaml(configPath);
    const template = readText(templatePath);

    const errors = validateConfig(cfg);
    if (errors.length) {
      return interaction.reply({
        content: `Config validation failed:\n- ${errors.join("\n- ")}`,
        ephemeral: true,
      });
    }

    // State file is keyed to event.key so you can re-run safely
    const statePath = path.join(process.cwd(), "data", `state-${cfg.event.key}.json`);
    const state = loadState(statePath);

    if (interaction.commandName === "setup") {
      await interaction.deferReply({ ephemeral: true });

      await assertBotAccess(guild, categoryId);

      const planLines = [];
      let createdChannels = 0;
      let createdThreads = 0;
      let reusedChannels = 0;
      let reusedThreads = 0;

      for (const map of cfg.maps) {
        const channelName = `${slugify(cfg.event.key)}-map${pad2(map.mapNumber)}`; // bt-r1-flagship-map01

        planLines.push(`Map ${map.mapNumber}: channel #${channelName}`);

        // Idempotency: prefer state, else search by name under category
        let mapChannelId = state.channels?.[channelName]?.id;
        let mapChannel = mapChannelId ? await guild.channels.fetch(mapChannelId).catch(() => null) : null;

        if (!mapChannel) {
          mapChannel = await findChannelByNameInCategory(guild, categoryId, channelName);
        }

        if (!mapChannel) {
          if (dryrun) {
            planLines.push(`  - would create channel`);
          } else {
            mapChannel = await guild.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              parent: categoryId,
              reason: "Event setup",
            });
            createdChannels++;
            state.channels[channelName] = { id: mapChannel.id };
          }
        } else {
          reusedChannels++;
          state.channels[channelName] = { id: mapChannel.id };
        }

        // For each theatre, create 2 threads (teams)
        for (const theatre of map.theatres) {
          for (const team of theatre.teams) {
            const poolKey = team.countryPool;
            const pool = cfg.countryPools[poolKey];

            const threadName = `${slugify(team.teamName)}-${slugify(poolKey)}`; // <team-name>-<zone>
            planLines.push(`  - theatre ${theatre.id}: would ensure private thread "${threadName}"`);

            if (!mapChannel) continue; // dryrun before creation

            let threadId = state.threads?.[`${channelName}:${threadName}`]?.id;
            let thread = threadId ? await guild.channels.fetch(threadId).catch(() => null) : null;

            if (!thread) {
              // Try to find existing thread by name
              thread = await findThreadByName(mapChannel, threadName);
            }

            if (!thread) {
              if (dryrun) {
                // no-op
              } else {
                thread = await mapChannel.threads.create({
                  name: threadName,
                  type: ChannelType.PrivateThread,
                  autoArchiveDuration: 10080,
                  reason: "Event setup",
                });
                createdThreads++;

                state.threads[`${channelName}:${threadName}`] = { id: thread.id };
              }
            } else {
              reusedThreads++;
              state.threads[`${channelName}:${threadName}`] = { id: thread.id };
            }

            // Post the thread message (only once). Idempotent approach:
            // If we created the thread, post; if it existed, do not spam.
            if (!dryrun && thread && (state.threads[`${channelName}:${threadName}`]?.posted !== true)) {
              const playable = (pool.playableCountries || []).map((c) => `- ${c}`).join("\n");
              const ai = (pool.aiCountries || []).map((c) => `- ${c}`).join("\n");
              const mentions = mentionList(team.players);

              const body = renderTemplate(template, {
                EVENT_NAME: cfg.event.name,
                EVENT_ROUND: String(cfg.event.round),
                EVENT_KEY: cfg.event.key,
                MAP_NUMBER: String(map.mapNumber),
                MAP_NUMBER_PAD2: pad2(map.mapNumber),
                THEATRE_ID: theatre.id,
                THEATRE_NAME: theatre.name,
                TEAM_NAME: team.teamName,
                COUNTRY_POOL_KEY: poolKey,
                COUNTRY_POOL_LABEL: pool.label || poolKey,
                COUNTRY_POOL_COLOUR: pool.colour || "",
                PLAYABLE_COUNTRIES: playable || "- (none)",
                AI_COUNTRIES: ai || "- (none)",
                PLAYERS_MENTIONS: mentions || "",
                TEAM_SIZE: String(cfg.event.teamSize),
              });

              await thread.send(body);

              // Add players to the private thread (best-effort)
              await addPlayersToThread(guild, thread, team.players);

              state.threads[`${channelName}:${threadName}`].posted = true;
            }
          }
        }

        // Optional: post a single message in map channel (only if we created it)
        if (!dryrun && mapChannel) {
          // Don’t spam on rerun: only post if we created the channel and haven't posted yet
          const chanState = state.channels[channelName] || {};
          if (chanState.posted !== true) {
            await mapChannel.send(
              `**${cfg.event.name}**\nMap ${pad2(map.mapNumber)} set up. Private team threads created.`
            );
            chanState.posted = true;
            state.channels[channelName] = chanState;
          }
        }
      }

      if (!dryrun) saveState(statePath, state);

      const summary =
        `Done ✅\n` +
        `Created: ${createdChannels} channels, ${createdThreads} threads\n` +
        `Reused: ${reusedChannels} channels, ${reusedThreads} threads\n` +
        `State: ${statePath}`;

      // If dryrun, show plan
      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅ Nothing created.\n\nPlan:\n${planLines.map((l) => `• ${l}`).join("\n")}`
        );
      }

      return interaction.editReply(summary);
    }

    if (interaction.commandName === "teardown") {
      await interaction.deferReply({ ephemeral: true });

      const statePath = path.join(process.cwd(), "data", `state-${cfg.event.key}.json`);
      const state = loadState(statePath);

      const toDeleteThreads = Object.values(state.threads || {}).map((x) => x.id).filter(Boolean);
      const toDeleteChannels = Object.values(state.channels || {}).map((x) => x.id).filter(Boolean);

      if (dryrun) {
        return interaction.editReply(
          `Dry-run ✅ Nothing deleted.\nThreads: ${toDeleteThreads.length}\nChannels: ${toDeleteChannels.length}\nState: ${statePath}`
        );
      }

      let deletedThreads = 0;
      let deletedChannels = 0;

      // Delete threads first (they live under channels)
      for (const threadId of toDeleteThreads) {
        try {
          const ch = await guild.channels.fetch(threadId).catch(() => null);
          if (ch) {
            await ch.delete("Event teardown");
            deletedThreads++;
          }
        } catch (e) {
          console.log(`Failed to delete thread ${threadId}: ${String(e?.message || e)}`);
        }
      }

      // Delete channels
      for (const channelId of toDeleteChannels) {
        try {
          const ch = await guild.channels.fetch(channelId).catch(() => null);
          if (ch) {
            await ch.delete("Event teardown");
            deletedChannels++;
          }
        } catch (e) {
          console.log(`Failed to delete channel ${channelId}: ${String(e?.message || e)}`);
        }
      }

      // Keep state file by default (safer). You can delete manually if you want.
      return interaction.editReply(
        `Teardown complete ✅\nDeleted ${deletedThreads} threads and ${deletedChannels} channels.\nState file retained: ${statePath}`
      );
    }
  } catch (err) {
    const msg = String(err?.message || err);

    // Avoid crashing the bot due to an unhandled exception
    console.error("Command error:", err);

    // Try to respond safely
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
