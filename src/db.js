"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl:      { rejectUnauthorized: false },
  max: 5,
});

pool.on("error", (err) => {
  console.error("Unexpected pg pool error:", err);
});

async function initSchema() {
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

    CREATE TABLE IF NOT EXISTS matches (
      match_id   TEXT        PRIMARY KEY,
      timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      label      TEXT        NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);

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
}

// Upsert a player from Discord member data. Does not overwrite elo/games_played.
async function upsertPlayer(playerId, discordName) {
  await pool.query(
    `INSERT INTO players (player_id, discord_name)
     VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE
       SET discord_name = EXCLUDED.discord_name,
           updated_at   = NOW()`,
    [playerId, discordName]
  );
}

async function getPlayer(playerId) {
  const { rows } = await pool.query(
    `SELECT * FROM players WHERE player_id = $1`,
    [playerId]
  );
  return rows[0] || null;
}

async function getPlayers(playerIds) {
  const { rows } = await pool.query(
    `SELECT * FROM players WHERE player_id = ANY($1)`,
    [playerIds]
  );
  return rows;
}

async function getRatings() {
  const { rows } = await pool.query(
    `SELECT player_id, discord_name, elo, games_played
     FROM players
     ORDER BY elo DESC`
  );
  return rows;
}

async function recordMatch(matchId, label, resultRows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO matches (match_id, label) VALUES ($1, $2)`,
      [matchId, label]
    );

    for (const r of resultRows) {
      // Update player elo + games_played
      await client.query(
        `UPDATE players
         SET elo = $1, games_played = $2, updated_at = NOW()
         WHERE player_id = $3`,
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

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, upsertPlayer, getPlayer, getPlayers, getRatings, recordMatch };
