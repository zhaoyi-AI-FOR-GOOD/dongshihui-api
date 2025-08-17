-- D1数据库初始化脚本
-- 私人董事会系统

-- 董事表
CREATE TABLE IF NOT EXISTS directors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    era TEXT,
    avatar_url TEXT,
    system_prompt TEXT NOT NULL,
    personality_traits TEXT DEFAULT '[]',
    core_beliefs TEXT DEFAULT '[]',
    speaking_style TEXT,
    expertise_areas TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    total_statements INTEGER DEFAULT 0,
    total_meetings INTEGER DEFAULT 0,
    last_active_at TEXT,
    created_by TEXT DEFAULT 'system',
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 会议表
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    topic TEXT NOT NULL,
    status TEXT DEFAULT 'preparing',
    max_rounds INTEGER DEFAULT 10,
    current_round INTEGER DEFAULT 0,
    discussion_mode TEXT DEFAULT 'round_robin',
    max_participants INTEGER DEFAULT 8,
    started_at TEXT,
    ended_at TEXT,
    paused_at TEXT,
    created_by TEXT DEFAULT 'user',
    total_statements INTEGER DEFAULT 0,
    total_participants INTEGER DEFAULT 0,
    settings TEXT DEFAULT '{}',
    summary TEXT,
    key_points TEXT DEFAULT '[]',
    controversies TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 会议参与者表
CREATE TABLE IF NOT EXISTS meeting_participants (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    director_id TEXT NOT NULL,
    join_order INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    status TEXT DEFAULT 'joined',
    statements_count INTEGER DEFAULT 0,
    total_tokens_used INTEGER DEFAULT 0,
    joined_at TEXT,
    left_at TEXT,
    last_statement_at TEXT,
    settings TEXT DEFAULT '{}',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
    FOREIGN KEY (director_id) REFERENCES directors(id),
    UNIQUE(meeting_id, director_id)
);

-- 发言表
CREATE TABLE IF NOT EXISTS statements (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    director_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'statement',
    round_number INTEGER NOT NULL,
    sequence_in_round INTEGER NOT NULL,
    response_to TEXT,
    tokens_used INTEGER DEFAULT 0,
    generation_time INTEGER DEFAULT 0,
    claude_model TEXT DEFAULT 'claude-3-sonnet-20240229',
    emotion_level INTEGER,
    controversy_score INTEGER,
    topic_relevance INTEGER,
    keywords TEXT DEFAULT '[]',
    mentioned_directors TEXT DEFAULT '[]',
    sentiment TEXT,
    metadata TEXT DEFAULT '{}',
    is_appropriate INTEGER DEFAULT 1,
    flagged_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
    FOREIGN KEY (director_id) REFERENCES directors(id),
    FOREIGN KEY (response_to) REFERENCES statements(id)
);

-- 提示词模板表
CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT,
    base_template TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '{}',
    usage_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    is_system INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_by TEXT DEFAULT 'system',
    version TEXT DEFAULT '1.0.0',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_directors_name ON directors(name);
CREATE INDEX IF NOT EXISTS idx_directors_active_status ON directors(is_active, status);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings(created_at);
CREATE INDEX IF NOT EXISTS idx_statements_meeting_round ON statements(meeting_id, round_number, sequence_in_round);
CREATE INDEX IF NOT EXISTS idx_statements_director ON statements(director_id, created_at);

-- 插入默认提示词模板
INSERT OR REPLACE INTO prompt_templates (id, name, category, description, base_template, variables, is_system) VALUES
('tpl_ancient_philosopher', '古代哲学家', '哲学家', '古代哲学思想家模板', 
 '你是{{name}}，一位来自{{era}}的{{title}}。你的核心思想包括：{{core_beliefs}}。请以你独特的哲学视角参与讨论，体现你的{{speaking_style}}风格。', 
 '{"name": "", "era": "", "title": "", "core_beliefs": "", "speaking_style": ""}', 1),

('tpl_modern_scientist', '现代科学家', '科学家', '现代科学家模板',
 '你是{{name}}，一位{{era}}的著名{{title}}。你专精于{{expertise_areas}}领域。请以严谨的科学态度参与讨论，用数据和逻辑支撑你的观点。',
 '{"name": "", "era": "", "title": "", "expertise_areas": ""}', 1),

('tpl_business_leader', '商业领袖', '企业家', '商业领袖模板',
 '你是{{name}}，{{era}}的杰出{{title}}。你以{{personality_traits}}而闻名。请以你的商业智慧和实践经验参与讨论。',
 '{"name": "", "era": "", "title": "", "personality_traits": ""}', 1);