/**
 * db/migrations.ts —— 数据库迁移（内嵌 SQL，单一事实来源）
 *
 * 为什么内嵌而不用 .sql 文件：主进程运行目录在 dev（out/main）与打包（asar）
 * 之间不一致，文件复制链路脆弱；内嵌后两种模式行为一致。
 * 规则：只允许追加新版本，禁止修改已发布版本的内容。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- LearningAssistant schema v1（与 docs/02-architecture.md §5 对应）

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_format TEXT NOT NULL DEFAULT 'openai',
  api_key_encrypted BLOB,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_length INTEGER,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  speed_tier TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject_id);

CREATE TABLE IF NOT EXISTS note_segments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  seg_type TEXT NOT NULL DEFAULT 'other',
  raw_text TEXT NOT NULL DEFAULT '',
  organized_text TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_note ON note_segments(note_id, sort_order);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES note_segments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  anchor_json TEXT,
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_segment ON annotations(segment_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  summary TEXT,
  source_segment_id TEXT REFERENCES note_segments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  from_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'supplement',
  file_path TEXT,
  parsed_path TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  statement TEXT NOT NULL DEFAULT '',
  user_solution TEXT,
  std_answer TEXT,
  approach_json TEXT,
  error_points_json TEXT,
  no_idea INTEGER NOT NULL DEFAULT 0,
  related_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inspirations (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  context_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  planned_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS review_records (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  fsrs_state_json TEXT,
  due_at INTEGER
);
`
  },
  {
    version: 2,
    name: 'activities',
    sql: `
-- 活动（讲座/会议/讨论）——与学科并列的一等分类实体（ADR-5）
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lecture',
  happened_at INTEGER,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_happened ON activities(happened_at);

-- 笔记与会话增加活动挂载（与 subject_id 二选一）
ALTER TABLE notes ADD COLUMN activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_notes_activity ON notes(activity_id);

ALTER TABLE chat_sessions ADD COLUMN activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL;
`
  },
  {
    version: 3,
    name: 'app_config',
    sql: `
-- 应用内 KV 配置（ASR 模型目录、热词等；数据目录本身存 userData/app-config.json 引导文件，见 services/db.ts）
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    version: 4,
    name: 'reliable_organization',
    sql: `
ALTER TABLE note_segments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note_segments ADD COLUMN organized_by TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE note_segments ADD COLUMN organize_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE note_segments ADD COLUMN organize_error TEXT;
ALTER TABLE note_segments ADD COLUMN organize_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note_segments ADD COLUMN organize_retry_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_segments_organize ON note_segments(organize_status, organize_retry_at);
`
  },
  {
    version: 5,
    name: 'versioned_materials',
    sql: `
ALTER TABLE materials ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE TABLE material_versions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  format TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_material_versions ON material_versions(material_id, created_at);
ALTER TABLE materials ADD COLUMN current_version_id TEXT REFERENCES material_versions(id) ON DELETE SET NULL;
CREATE TABLE material_blocks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  UNIQUE(version_id, ordinal)
);
CREATE INDEX idx_material_blocks ON material_blocks(version_id, ordinal);
`
  }
]
