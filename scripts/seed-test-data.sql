-- Test players with a spread of Elo ratings
-- Use fake Discord IDs (000000000000000001 etc) that won't clash with real members

INSERT INTO players (player_id, discord_name, ingame_name, elo, games_played) VALUES
  ('000000000000000001', 'steampunk74',    'steampunk74',    1120, 15),
  ('000000000000000002', 'lovetolag',      'lovetolag',      1085, 12),
  ('000000000000000003', 'Jjtheamazing96', 'Jjtheamazing96', 1040, 8),
  ('000000000000000004', 'mc_johnson',     'mc_johnson',     1010, 6),
  ('000000000000000005', 'lahm',           'lahm',           990,  5),
  ('000000000000000006', 'PrrckDckr',      'PrrckDckr',      970,  4),
  ('000000000000000007', 'testplayer7',    'testplayer7',    955,  3),
  ('000000000000000008', 'testplayer8',    'testplayer8',    940,  2)
ON CONFLICT (player_id) DO NOTHING;
