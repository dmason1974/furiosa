"use strict";

const DEFAULT_ELO        = 1000;
const K                  = 32;
const K_PROVISIONAL      = 40;
const PROVISIONAL_GAMES  = 10;

function getK(gamesPlayed) {
  return gamesPlayed < PROVISIONAL_GAMES ? K_PROVISIONAL : K;
}

// Expected score for one team against all others.
// Fix vs Python: skip by index, not by value, so equal-rated teams are handled correctly.
function expectedScore(selfIndex, teamElos) {
  const n = teamElos.length;
  if (n <= 1) return 1;
  let exp = 0;
  for (let i = 0; i < n; i++) {
    if (i === selfIndex) continue;
    exp += 1 / (1 + Math.pow(10, (teamElos[i] - teamElos[selfIndex]) / 400));
  }
  return exp / (n - 1);
}

// Finishing-position score: 1st = 1.0, last = 0.0, linear in between.
function positionScore(rank, totalTeams) {
  if (totalTeams <= 1) return 1;
  return (totalTeams - rank) / (totalTeams - 1);
}

/**
 * Calculate Elo deltas for a match.
 *
 * teams: array of arrays of { playerId, discordName, elo, gamesPlayed }
 *        ordered by finishing rank (index 0 = 1st place)
 *
 * Returns array of result objects ready for db.recordMatch.
 */
function calculateMatch(teams) {
  const teamElos = teams.map((team) => {
    const avg = team.reduce((s, p) => s + p.elo, 0) / team.length;
    return avg;
  });

  const results = [];

  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const rank = i + 1;
    const avgK = team.reduce((s, p) => s + getK(p.gamesPlayed), 0) / team.length;
    const score = positionScore(rank, teams.length);
    const exp   = expectedScore(i, teamElos);
    const teamDelta = avgK * (score - exp);
    const share = teamDelta / team.length;

    for (const player of team) {
      const eloBefore   = player.elo;
      const eloAfter    = eloBefore + share;
      const gamesPlayed = player.gamesPlayed + 1;
      results.push({
        playerId:    player.playerId,
        discordName: player.discordName,
        rank,
        eloBefore:   Math.round(eloBefore  * 10) / 10,
        eloAfter:    Math.round(eloAfter   * 10) / 10,
        deltaElo:    Math.round(share       * 10) / 10,
        gamesPlayed,
        kUsed:       Math.round(avgK * 10) / 10,
      });
    }
  }

  return results;
}

// --- Matchmaker ---

function teamAvgElo(team) {
  return team.reduce((s, p) => s + p.elo, 0) / team.length;
}

// Expected score for team1 in a head-to-head.
function headToHeadExpected(elo1, elo2) {
  return 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
}

// Match quality for a 2-team split: 1.0 = perfectly balanced, 0.0 = one-sided.
function matchQuality(teams) {
  if (teams.length !== 2) return null;
  const e1 = teamAvgElo(teams[0]);
  const e2 = teamAvgElo(teams[1]);
  const exp = headToHeadExpected(e1, e2);
  return Math.round(4 * exp * (1 - exp) * 1000) / 1000;
}

// Greedy snake-draft split by descending Elo into teams of given sizes.
function greedySplit(players, teamSizes) {
  const sorted = [...players].sort((a, b) => b.elo - a.elo);
  const teams  = teamSizes.map(() => []);
  let ti = 0;
  for (const p of sorted) {
    while (teams[ti].length >= teamSizes[ti]) {
      ti = (ti + 1) % teams.length;
    }
    teams[ti].push(p);
    ti = (ti + 1) % teams.length;
  }
  return teams;
}

// Try N random shuffles, return the split with best match quality.
function bestSplit(players, teamSizes, trials = 100) {
  const total = teamSizes.reduce((s, n) => s + n, 0);
  if (total > players.length) {
    throw new Error(`Need ${total} players but only ${players.length} available.`);
  }

  let bestQ     = -1;
  let bestTeams = null;

  for (let t = 0; t < trials; t++) {
    const shuffled  = [...players].sort(() => Math.random() - 0.5).slice(0, total);
    const candidate = greedySplit(shuffled, teamSizes);
    const q         = matchQuality(candidate);
    if (q !== null && q > bestQ) {
      bestQ     = q;
      bestTeams = candidate;
    }
  }

  // For >2 teams, just return the greedy split directly
  if (bestTeams === null) {
    bestTeams = greedySplit(players.slice(0, total), teamSizes);
  }

  return { teams: bestTeams, quality: bestQ >= 0 ? bestQ : null };
}

module.exports = { DEFAULT_ELO, calculateMatch, matchQuality, bestSplit };
