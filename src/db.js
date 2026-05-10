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

module.exports = {
  getPool, initSchema,
  upsertPlayer, getPlayers, getRatings,
  createSeason, startSeason, endSeason, getActiveSeason, getSeasonByName, listSeasons, getLeagueTable,
  createMatch, getPendingMatches, getMatchWithPlayers, completeMatch,
};
