-- Remove test players and any match data involving them
DELETE FROM match_results WHERE player_id LIKE '00000000000000000%';
DELETE FROM matches WHERE match_id NOT IN (SELECT DISTINCT match_id FROM match_results);
DELETE FROM players   WHERE player_id LIKE '00000000000000000%';
