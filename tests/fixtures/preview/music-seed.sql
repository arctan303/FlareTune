INSERT OR REPLACE INTO Songs (id,title,artist,album,duration,audio_url,cover_url,language,created_at)
VALUES ('fixture-song','Preview Song','Preview Artist','Fixture Album',30,'http://127.0.0.1:18790/media/fixture-song.wav','http://127.0.0.1:18790/media/fixture-song.svg','en',1700000000000);
INSERT OR REPLACE INTO Playlists (id,name,description,author,type,has_cover,cover_url,preview_covers,order_index,created_at)
VALUES ('fixture-playlist','Preview Playlist','Local fixture only','Preview','normal',1,'cover/fixture-song.svg','["cover/fixture-song.svg"]',1,1700000000000);
INSERT OR REPLACE INTO Playlist_Songs (playlist_id,song_id,sort_order) VALUES ('fixture-playlist','fixture-song',0);
INSERT OR REPLACE INTO music_assistant_configs (
  id,name,description,avatar_icon,persona,welcome_message,system_rules,provider,model,temperature,revision,created_at,updated_at,updated_by
) VALUES (
  'xiaoa','小A','Tune 本地预览助手','bot','你是 Tune 本地预览环境中的音乐助手小A。','你好，我是小A。','仅依据当前用户事实、音乐数据库和真实工具结果回答，不编造查询或执行结果。',
  'deepseek','deepseek-v4-flash',0.7,1,1700000000000,1700000000000,'preview-fixture'
);
