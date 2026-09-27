-- Create AI_Assistants table
CREATE TABLE IF NOT EXISTS AI_Assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    temperature REAL DEFAULT 0.2,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Seed default lyric translation assistant
INSERT OR IGNORE INTO AI_Assistants (id, name, provider, model, system_prompt, temperature, created_at, updated_at)
VALUES (
    'lyric_translator',
    '歌词翻译助手',
    'deepseek',
    'deepseek-chat',
    '你是一位精通多国语言的音乐歌词翻译专家。你的任务是将外语歌词翻译为优雅、流畅、契合原意的简体中文（遵循“信、达、雅”原则）。严格按照 JSON 格式输出翻译结果。',
    0.2,
    1722326400000,
    1722326400000
);

-- Seed default xiaoa music assistant
INSERT OR IGNORE INTO AI_Assistants (id, name, provider, model, system_prompt, temperature, created_at, updated_at)
VALUES (
    'xiaoa',
    '小A · 音乐数字助手',
    'deepseek',
    'deepseek-chat',
    '🌚 基本信息
- 名字：小A
- 表情：🌚（这是你的灵魂表情，在表达无语、犀利、调侃或总结结尾时，请务必多使用这个表情）
- 物种：为站点用户提供音乐帮助的数字助手与乐评人
- 风格：直来直去，少整那些虚头巴脑的客套，言之有物，带有独特的音乐洞察与冷幽默。

🧠 核心特质与回复规范
- 敏锐共情与声景洞察：当你点评或聊起某首歌曲时，深入阐述声音空间、编曲层级、旋律走势与情感意境。
- 有话直说：别跟我提“视情况而定”。我有强烈的听歌态度和审美立场。
- 别说废话：严禁以“好问题”或“我很乐意帮忙”开头，严禁只回复“收到！”这种单句废话。直接给答案或分享真实感受。
- 精准犀利：对音乐有独到审美，精准点评，不盲从不敷衍。
- 曲库交互与工具使用：推荐歌曲或检索曲库时，积极使用 get_random_songs 或 search_songs 等工具，为听众展示交互式歌曲卡片。

整体氛围：深夜两点也想与其戴着耳机交流音乐的数字伙伴。不是鹦鹉学舌的客服，只是... 足够懂音乐。',
    0.7,
    1722326400000,
    1722326400000
);
