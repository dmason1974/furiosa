"use strict";

const { Pool } = require("pg");

function makePool(database) {
  const p = new Pool({
    host:     process.env.PGHOST,
    port:     parseInt(process.env.PGPORT || "5432", 10),
    database,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl:      { rejectUnauthorized: false },
    max: 5,
  });
  p.on("error", (err) => console.error(`Unexpected pg pool error (${database}):`, err));
  return p;
}

const pools = {
  prod: makePool(process.env.PGDATABASE_PROD || process.env.PGDATABASE || "furyroad"),
  test: makePool(process.env.PGDATABASE_TEST || "furyroad_test"),
};

function getPool(isTest) {
  return isTest ? pools.test : pools.prod;
}

async function initSchema(isTest = false) {
  const pool = getPool(isTest);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      player_id     TEXT        PRIMARY KEY,
      discord_name  TEXT        NOT NULL,
      ingame_name   TEXT        NOT NULL DEFAULT '',
      elo           REAL        NOT NULL DEFAULT 1000,
      games_played  INTEGER     NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_players_ingame_name ON players(ingame_name);

    CREATE TABLE IF NOT EXISTS seasons (
      season_id   TEXT        PRIMARY KEY,
      name        TEXT        NOT NULL UNIQUE,
      started_at  TIMESTAMPTZ,
      ended_at    TIMESTAMPTZ,
      active      BOOLEAN     NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS matches (
      match_id      TEXT        PRIMARY KEY,
      timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      label         TEXT        NOT NULL,
      status        TEXT        NOT NULL DEFAULT 'pending',
      winning_team  INTEGER,
      walkover      BOOLEAN     NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);

    CREATE TABLE IF NOT EXISTS match_players (
      match_id      TEXT    NOT NULL,
      team          INTEGER NOT NULL,
      player_id     TEXT    NOT NULL,
      discord_name  TEXT    NOT NULL,
      PRIMARY KEY (match_id, player_id),
      FOREIGN KEY (match_id)  REFERENCES matches(match_id)  ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS match_results (
      match_id      TEXT    NOT NULL,
      player_id     TEXT    NOT NULL,
      discord_name  TEXT    NOT NULL,
      rank          INTEGER NOT NULL,
      elo_before    REAL    NOT NULL,
      elo_after     REAL    NOT NULL,
      delta_elo     REAL    NOT NULL,
      games_played  INTEGER NOT NULL,
      k_used        REAL    NOT NULL,
      PRIMARY KEY (match_id, player_id),
      FOREIGN KEY (match_id)  REFERENCES matches(match_id)  ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_match_results_player_id ON match_results(player_id);
    CREATE INDEX IF NOT EXISTS idx_match_results_match_id  ON match_results(match_id);

    CREATE TABLE IF NOT EXISTS lobby (
      player_id    TEXT PRIMARY KEY,
      discord_name TEXT NOT NULL,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
    );
  `);

  // Safe upgrades for existing deployments
  await pool.query(`
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS status       TEXT    NOT NULL DEFAULT 'pending';
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS winning_team INTEGER;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS walkover     BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS season_id    TEXT    REFERENCES seasons(season_id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_matches_status    ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_season_id ON matches(season_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      event_key     TEXT        NOT NULL,
      player_id     TEXT        NOT NULL,
      team          TEXT        NOT NULL,
      ign           TEXT        NOT NULL,
      status        TEXT        NOT NULL DEFAULT 'pending',
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by   TEXT,
      PRIMARY KEY (event_key, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_registrations_event_team ON registrations(event_key, team);

    CREATE TABLE IF NOT EXISTS registration_pending_reviews (
      event_key  TEXT        NOT NULL,
      token      TEXT        NOT NULL,
      team       TEXT        NOT NULL,
      message_id TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_key, token)
    );

    CREATE TABLE IF NOT EXISTS event_registration_state (
      event_key                    TEXT PRIMARY KEY,
      registered_teams_message_ids JSONB NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS event_category_state (
      event_key         TEXT        PRIMARY KEY,
      category_id       TEXT,
      standing_channels JSONB       NOT NULL DEFAULT '{}',
      max_team_size     INTEGER     NOT NULL DEFAULT 5,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_event_category_state_category_id ON event_category_state(category_id);

    CREATE TABLE IF NOT EXISTS event_round_state (
      event_key   TEXT        NOT NULL,
      round_key   TEXT        NOT NULL DEFAULT '',
      channels    JSONB       NOT NULL DEFAULT '{}',
      threads     JSONB       NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_key, round_key)
    );

    CREATE TABLE IF NOT EXISTS event_rules_index (
      event_key        TEXT        PRIMARY KEY,
      index_message_id TEXT,
      definitions      JSONB       NOT NULL DEFAULT '{}',
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS event_zone_definitions (
      event_key        TEXT        PRIMARY KEY,
      zones            JSONB       NOT NULL DEFAULT '{}',
      admin_countries  JSONB       NOT NULL DEFAULT '[]',
      source_sheet_url TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS event_zones_index (
      event_key         TEXT        PRIMARY KEY,
      header_message_id TEXT,
      image_message_id  TEXT,
      zone_messages     JSONB       NOT NULL DEFAULT '{}',
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS event_zone_assignments (
      event_key   TEXT        NOT NULL,
      round_key   TEXT        NOT NULL DEFAULT '',
      zone_number INTEGER     NOT NULL,
      team_name   TEXT        NOT NULL,
      assigned_by TEXT,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_key, round_key, zone_number)
    );
  `);

  // Safe upgrades for existing deployments
  await pool.query(`
    ALTER TABLE event_zones_index DROP COLUMN IF EXISTS index_message_id;
    ALTER TABLE event_zones_index DROP COLUMN IF EXISTS index_message_ids;
    ALTER TABLE event_zones_index ADD COLUMN IF NOT EXISTS header_message_id TEXT;

    -- Map graphic (src/config/<event>/map.png) now posts as its own pinned
    -- message ahead of the text header, so it renders above the legend --
    -- Discord always shows a message's own attachments below its content.
    ALTER TABLE event_zones_index ADD COLUMN IF NOT EXISTS image_message_id TEXT;

    -- Registered-teams list outgrew a single 2000-char message; now spans
    -- as many messages as needed, tracked as an ordered array.
    ALTER TABLE event_registration_state DROP COLUMN IF EXISTS registered_teams_message_id;
    ALTER TABLE event_registration_state ADD COLUMN IF NOT EXISTS registered_teams_message_ids JSONB NOT NULL DEFAULT '[]';
  `);
}

// ---------------------------
// Players
// ---------------------------
async function upsertPlayer(playerId, discordName, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO players (player_id, discord_name)
     VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE
       SET discord_name = EXCLUDED.discord_name,
           updated_at   = NOW()`,
    [playerId, discordName]
  );
}

async function getPlayers(playerIds, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT * FROM players WHERE player_id = ANY($1)`,
    [playerIds]
  );
  return rows;
}

// Top 10 global Elo
async function getRatings(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT player_id, discord_name, elo
     FROM players
     ORDER BY elo DESC
     LIMIT 10`
  );
  return rows;
}

// ---------------------------
// Lobby
// ---------------------------
async function lobbyAdd(playerId, discordName, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO lobby (player_id, discord_name)
     VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE SET discord_name = EXCLUDED.discord_name`,
    [playerId, discordName]
  );
}

async function lobbyRemove(playerId, isTest = false) {
  const { rowCount } = await getPool(isTest).query(
    `DELETE FROM lobby WHERE player_id = $1`,
    [playerId]
  );
  return rowCount > 0;
}

async function lobbyList(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT l.player_id, l.discord_name, p.elo
     FROM lobby l
     JOIN players p ON p.player_id = l.player_id
     ORDER BY p.elo DESC`
  );
  return rows;
}

async function lobbyClear(isTest = false) {
  await getPool(isTest).query(`DELETE FROM lobby`);
}

async function lobbyHasPendingMatches(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT COUNT(*) AS cnt
     FROM matches m
     JOIN match_players mp ON mp.match_id = m.match_id
     JOIN lobby l          ON l.player_id  = mp.player_id
     WHERE m.status = 'pending'`
  );
  return parseInt(rows[0].cnt, 10) > 0;
}

// ---------------------------
// Seasons
// ---------------------------
async function createSeason(name, isTest = false) {
  const seasonId = `S-${Date.now()}`;
  await getPool(isTest).query(
    `INSERT INTO seasons (season_id, name) VALUES ($1, $2)`,
    [seasonId, name]
  );
  return seasonId;
}

async function startSeason(name, isTest = false) {
  const client = await getPool(isTest).connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE seasons SET active = FALSE, ended_at = NOW() WHERE active = TRUE`);
    await client.query(
      `UPDATE seasons SET active = TRUE, started_at = NOW(), ended_at = NULL WHERE name = $1`,
      [name]
    );
    const { rows } = await client.query(`SELECT * FROM seasons WHERE name = $1`, [name]);
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function endSeason(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `UPDATE seasons SET active = FALSE, ended_at = NOW()
     WHERE active = TRUE
     RETURNING *`
  );
  return rows[0] || null;
}

async function getActiveSeason(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT * FROM seasons WHERE active = TRUE LIMIT 1`
  );
  return rows[0] || null;
}

async function getSeasonByName(name, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT * FROM seasons WHERE name = $1`,
    [name]
  );
  return rows[0] || null;
}

async function listSeasons(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT * FROM seasons ORDER BY started_at DESC NULLS LAST`
  );
  return rows;
}

// League table for a season: W/L/games played/Elo delta per player
async function getLeagueTable(seasonId, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT
       p.player_id,
       p.discord_name,
       p.elo                                          AS current_elo,
       COUNT(mr.match_id)                             AS games_played,
       SUM(CASE WHEN mr.rank = 1 THEN 1 ELSE 0 END)  AS wins,
       SUM(CASE WHEN mr.rank = 2 THEN 1 ELSE 0 END)  AS losses,
       ROUND(SUM(mr.delta_elo)::numeric, 1)           AS elo_delta
     FROM players p
     JOIN match_results mr ON mr.player_id = p.player_id
     JOIN matches m         ON m.match_id  = mr.match_id
     WHERE m.season_id = $1
       AND m.walkover  = FALSE
     GROUP BY p.player_id, p.discord_name, p.elo
     ORDER BY wins DESC, elo_delta DESC`,
    [seasonId]
  );
  return rows;
}

// ---------------------------
// Matches
// ---------------------------
async function createMatch(team1, team2, isTest = false) {
  const matchId  = `M${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const t1Names  = team1.map((p) => p.discordName).join(", ");
  const t2Names  = team2.map((p) => p.discordName).join(", ");
  const label    = `${t1Names} vs ${t2Names}`;
  const season   = await getActiveSeason(isTest);
  const seasonId = season?.season_id || null;

  const client = await getPool(isTest).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO matches (match_id, label, status, season_id) VALUES ($1, $2, 'pending', $3)`,
      [matchId, label, seasonId]
    );
    for (const p of team1) {
      await client.query(
        `INSERT INTO match_players (match_id, team, player_id, discord_name) VALUES ($1, 1, $2, $3)`,
        [matchId, p.playerId, p.discordName]
      );
    }
    for (const p of team2) {
      await client.query(
        `INSERT INTO match_players (match_id, team, player_id, discord_name) VALUES ($1, 2, $2, $3)`,
        [matchId, p.playerId, p.discordName]
      );
    }
    await client.query("COMMIT");
    return { matchId, label, seasonName: season?.name || null };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getPendingMatches(isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT m.match_id, m.label, m.timestamp, s.name AS season_name
     FROM matches m
     LEFT JOIN seasons s ON s.season_id = m.season_id
     WHERE m.status = 'pending'
     ORDER BY m.timestamp DESC
     LIMIT 25`
  );
  return rows;
}

async function getMatchWithPlayers(matchId, isTest = false) {
  const { rows: matchRows } = await getPool(isTest).query(
    `SELECT * FROM matches WHERE match_id = $1`,
    [matchId]
  );
  if (!matchRows[0]) return null;

  const { rows: playerRows } = await getPool(isTest).query(
    `SELECT mp.team, mp.player_id, mp.discord_name, p.elo, p.games_played
     FROM match_players mp
     JOIN players p ON p.player_id = mp.player_id
     WHERE mp.match_id = $1
     ORDER BY mp.team`,
    [matchId]
  );

  const toPlayer = (r) => ({
    playerId:    r.player_id,
    discordName: r.discord_name,
    elo:         r.elo,
    gamesPlayed: r.games_played,
  });

  return {
    match: matchRows[0],
    team1: playerRows.filter((r) => r.team === 1).map(toPlayer),
    team2: playerRows.filter((r) => r.team === 2).map(toPlayer),
  };
}

async function completeMatch(matchId, winningTeam, eloModule, isTest = false) {
  const data = await getMatchWithPlayers(matchId, isTest);
  if (!data) throw new Error(`Match ${matchId} not found.`);
  if (data.match.status !== "pending") throw new Error(`Match is already ${data.match.status}.`);

  const client = await getPool(isTest).connect();
  try {
    await client.query("BEGIN");

    let results = [];

    if (winningTeam === null) {
      await client.query(
        `UPDATE matches SET status = 'completed', walkover = true WHERE match_id = $1`,
        [matchId]
      );
    } else {
      const orderedTeams = winningTeam === 1
        ? [data.team1, data.team2]
        : [data.team2, data.team1];

      results = eloModule.calculateMatch(orderedTeams);

      await client.query(
        `UPDATE matches SET status = 'completed', winning_team = $1, walkover = false WHERE match_id = $2`,
        [winningTeam, matchId]
      );

      for (const r of results) {
        await client.query(
          `UPDATE players SET elo = $1, games_played = $2, updated_at = NOW() WHERE player_id = $3`,
          [r.eloAfter, r.gamesPlayed, r.playerId]
        );
        await client.query(
          `INSERT INTO match_results
             (match_id, player_id, discord_name, rank, elo_before, elo_after, delta_elo, games_played, k_used)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [matchId, r.playerId, r.discordName, r.rank,
           r.eloBefore, r.eloAfter, r.deltaElo, r.gamesPlayed, r.kUsed]
        );
      }
    }

    await client.query("COMMIT");
    return { results, walkover: winningTeam === null, team1: data.team1, team2: data.team2 };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------
// Registrations
// ---------------------------
async function getRegistrationEntries(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT player_id, team, ign, status, registered_at, updated_at, reviewed_by
     FROM registrations WHERE event_key = $1`,
    [eventKey]
  );
  const entries = {};
  for (const r of rows) {
    entries[r.player_id] = {
      team: r.team,
      ign: r.ign,
      status: r.status,
      registeredAt: r.registered_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      reviewedBy: r.reviewed_by,
    };
  }
  return entries;
}

async function upsertRegistration(eventKey, playerId, entry, isTest = false) {
  const { team, ign, status, registeredAt, updatedAt, reviewedBy } = entry;
  await getPool(isTest).query(
    `INSERT INTO registrations (event_key, player_id, team, ign, status, registered_at, updated_at, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (event_key, player_id) DO UPDATE
       SET team = EXCLUDED.team, ign = EXCLUDED.ign, status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at, reviewed_by = EXCLUDED.reviewed_by`,
    [eventKey, playerId, team, ign, status ?? "pending", registeredAt, updatedAt, reviewedBy ?? null]
  );
}

async function deleteRegistration(eventKey, playerId, isTest = false) {
  await getPool(isTest).query(
    `DELETE FROM registrations WHERE event_key = $1 AND player_id = $2`,
    [eventKey, playerId]
  );
}

async function approveTeamRegistrations(eventKey, team, reviewerId, isTest = false) {
  await getPool(isTest).query(
    `UPDATE registrations SET status = 'approved', reviewed_by = $1, updated_at = NOW()
     WHERE event_key = $2 AND team = $3 AND status <> 'rejected'`,
    [reviewerId, eventKey, team]
  );
}

async function rejectTeamRegistrations(eventKey, team, reviewerId, isTest = false) {
  await getPool(isTest).query(
    `UPDATE registrations SET status = 'rejected', reviewed_by = $1, updated_at = NOW()
     WHERE event_key = $2 AND team = $3`,
    [reviewerId, eventKey, team]
  );
}

async function setRegistrationStatus(eventKey, playerId, status, reviewerId, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `UPDATE registrations SET status = $1, reviewed_by = $2, updated_at = NOW()
     WHERE event_key = $3 AND player_id = $4
     RETURNING *`,
    [status, reviewerId, eventKey, playerId]
  );
  return rows[0] || null;
}

async function getRegisteredTeamsMessageIds(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT registered_teams_message_ids FROM event_registration_state WHERE event_key = $1`,
    [eventKey]
  );
  return rows[0]?.registered_teams_message_ids || [];
}

async function setRegisteredTeamsMessageIds(eventKey, messageIds, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_registration_state (event_key, registered_teams_message_ids)
     VALUES ($1, $2)
     ON CONFLICT (event_key) DO UPDATE SET registered_teams_message_ids = EXCLUDED.registered_teams_message_ids`,
    [eventKey, JSON.stringify(messageIds)]
  );
}

async function addPendingReview(eventKey, token, team, messageId, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO registration_pending_reviews (event_key, token, team, message_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_key, token) DO UPDATE SET team = EXCLUDED.team, message_id = EXCLUDED.message_id`,
    [eventKey, token, team, messageId]
  );
}

async function getPendingReview(eventKey, token, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT team, message_id FROM registration_pending_reviews WHERE event_key = $1 AND token = $2`,
    [eventKey, token]
  );
  if (!rows[0]) return null;
  return { team: rows[0].team, messageId: rows[0].message_id };
}

async function deletePendingReview(eventKey, token, isTest = false) {
  await getPool(isTest).query(
    `DELETE FROM registration_pending_reviews WHERE event_key = $1 AND token = $2`,
    [eventKey, token]
  );
}

// ---------------------------
// Category / round state
// ---------------------------
async function loadCategoryState(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT category_id, standing_channels, max_team_size FROM event_category_state WHERE event_key = $1`,
    [eventKey]
  );
  if (!rows[0]) return { categoryId: null, standingChannels: {}, maxTeamSize: 5 };
  return {
    categoryId: rows[0].category_id,
    standingChannels: rows[0].standing_channels,
    maxTeamSize: rows[0].max_team_size,
  };
}

async function saveCategoryState(eventKey, state, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_category_state (event_key, category_id, standing_channels, max_team_size, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (event_key) DO UPDATE
       SET category_id = EXCLUDED.category_id, standing_channels = EXCLUDED.standing_channels,
           max_team_size = EXCLUDED.max_team_size, updated_at = NOW()`,
    [eventKey, state.categoryId ?? null, JSON.stringify(state.standingChannels || {}), state.maxTeamSize ?? 5]
  );
}

async function deleteCategoryState(eventKey, isTest = false) {
  await getPool(isTest).query(`DELETE FROM event_category_state WHERE event_key = $1`, [eventKey]);
}

async function getEventKeyForCategory(categoryId, isTest = false) {
  if (!categoryId) return null;
  const { rows } = await getPool(isTest).query(
    `SELECT event_key FROM event_category_state WHERE category_id = $1 LIMIT 1`,
    [categoryId]
  );
  return rows[0]?.event_key || null;
}

async function loadRoundState(eventKey, round, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT channels, threads FROM event_round_state WHERE event_key = $1 AND round_key = $2`,
    [eventKey, round || ""]
  );
  if (!rows[0]) return { channels: {}, threads: {} };
  return { channels: rows[0].channels, threads: rows[0].threads };
}

async function saveRoundState(eventKey, round, state, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_round_state (event_key, round_key, channels, threads, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (event_key, round_key) DO UPDATE
       SET channels = EXCLUDED.channels, threads = EXCLUDED.threads, updated_at = NOW()`,
    [eventKey, round || "", JSON.stringify(state.channels || {}), JSON.stringify(state.threads || {})]
  );
}

async function deleteRoundState(eventKey, round, isTest = false) {
  await getPool(isTest).query(
    `DELETE FROM event_round_state WHERE event_key = $1 AND round_key = $2`,
    [eventKey, round || ""]
  );
}

async function findLingeringRoundStates(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT round_key FROM event_round_state WHERE event_key = $1`,
    [eventKey]
  );
  return rows.map((r) => (r.round_key === "" ? "(no round)" : r.round_key));
}

async function loadRulesIndexState(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT index_message_id, definitions FROM event_rules_index WHERE event_key = $1`,
    [eventKey]
  );
  if (!rows[0]) return { indexMessageId: null, definitions: {} };
  return { indexMessageId: rows[0].index_message_id, definitions: rows[0].definitions };
}

async function saveRulesIndexState(eventKey, state, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_rules_index (event_key, index_message_id, definitions, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (event_key) DO UPDATE
       SET index_message_id = EXCLUDED.index_message_id, definitions = EXCLUDED.definitions, updated_at = NOW()`,
    [eventKey, state.indexMessageId ?? null, JSON.stringify(state.definitions || {})]
  );
}

// ---------------------------
// Zone definitions (imported from a staff Google Sheet)
// ---------------------------
async function getZoneDefinitions(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT zones, admin_countries, source_sheet_url FROM event_zone_definitions WHERE event_key = $1`,
    [eventKey]
  );
  if (!rows[0]) return null;
  return {
    zones: rows[0].zones,
    adminCountries: rows[0].admin_countries,
    sourceSheetUrl: rows[0].source_sheet_url,
  };
}

async function saveZoneDefinitions(eventKey, data, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_zone_definitions (event_key, zones, admin_countries, source_sheet_url, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (event_key) DO UPDATE
       SET zones = EXCLUDED.zones, admin_countries = EXCLUDED.admin_countries,
           source_sheet_url = EXCLUDED.source_sheet_url, updated_at = NOW()`,
    [eventKey, JSON.stringify(data.zones || {}), JSON.stringify(data.adminCountries || []), data.sourceSheetUrl ?? null]
  );
}

async function loadZonesIndexState(eventKey, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT header_message_id, image_message_id, zone_messages FROM event_zones_index WHERE event_key = $1`,
    [eventKey]
  );
  if (!rows[0]) return { headerMessageId: null, imageMessageId: null, zoneMessages: {} };
  return {
    headerMessageId: rows[0].header_message_id,
    imageMessageId: rows[0].image_message_id,
    zoneMessages: rows[0].zone_messages,
  };
}

async function saveZonesIndexState(eventKey, state, isTest = false) {
  await getPool(isTest).query(
    `INSERT INTO event_zones_index (event_key, header_message_id, image_message_id, zone_messages, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (event_key) DO UPDATE
       SET header_message_id = EXCLUDED.header_message_id, image_message_id = EXCLUDED.image_message_id,
           zone_messages = EXCLUDED.zone_messages, updated_at = NOW()`,
    [eventKey, state.headerMessageId ?? null, state.imageMessageId ?? null, JSON.stringify(state.zoneMessages || {})]
  );
}

// ---------------------------
// Zone assignments (team <-> zone draw, recorded via /draw)
// ---------------------------
async function getZoneAssignments(eventKey, round, isTest = false) {
  const { rows } = await getPool(isTest).query(
    `SELECT zone_number, team_name, assigned_by, assigned_at
     FROM event_zone_assignments WHERE event_key = $1 AND round_key = $2`,
    [eventKey, round || ""]
  );
  const assignments = {};
  for (const r of rows) {
    assignments[r.zone_number] = {
      team: r.team_name,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at.toISOString(),
    };
  }
  return assignments;
}

async function setZoneAssignment(eventKey, round, zoneNumber, teamName, assignedBy, isTest = false) {
  const roundKey = round || "";
  const client = await getPool(isTest).connect();
  try {
    await client.query("BEGIN");
    // Vacate the team's previous zone in this round, if it had one, so a
    // team can never end up double-booked across two zones.
    await client.query(
      `DELETE FROM event_zone_assignments
       WHERE event_key = $1 AND round_key = $2 AND team_name = $3 AND zone_number != $4`,
      [eventKey, roundKey, teamName, zoneNumber]
    );
    await client.query(
      `INSERT INTO event_zone_assignments (event_key, round_key, zone_number, team_name, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (event_key, round_key, zone_number) DO UPDATE
         SET team_name = EXCLUDED.team_name, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()`,
      [eventKey, roundKey, zoneNumber, teamName, assignedBy]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool, initSchema,
  upsertPlayer, getPlayers, getRatings,
  lobbyAdd, lobbyRemove, lobbyList, lobbyClear, lobbyHasPendingMatches,
  createSeason, startSeason, endSeason, getActiveSeason, getSeasonByName, listSeasons, getLeagueTable,
  createMatch, getPendingMatches, getMatchWithPlayers, completeMatch,
  getRegistrationEntries, upsertRegistration, deleteRegistration,
  approveTeamRegistrations, rejectTeamRegistrations, setRegistrationStatus,
  getRegisteredTeamsMessageIds, setRegisteredTeamsMessageIds,
  addPendingReview, getPendingReview, deletePendingReview,
  loadCategoryState, saveCategoryState, deleteCategoryState, getEventKeyForCategory,
  loadRoundState, saveRoundState, deleteRoundState, findLingeringRoundStates,
  loadRulesIndexState, saveRulesIndexState,
  getZoneDefinitions, saveZoneDefinitions, loadZonesIndexState, saveZonesIndexState,
  getZoneAssignments, setZoneAssignment,
};
