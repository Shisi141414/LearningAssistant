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
  },
  {
    version: 6,
    name: 'classroom_material_positions',
    sql: `
CREATE TABLE classroom_sessions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX idx_classroom_sessions_note ON classroom_sessions(note_id, started_at);
CREATE TABLE classroom_positions (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  block_id TEXT REFERENCES material_blocks(id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE classroom_calibrations (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES classroom_sessions(id) ON DELETE SET NULL,
  block_id TEXT REFERENCES material_blocks(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_calibrations_note ON classroom_calibrations(note_id, created_at);
CREATE TABLE segment_material_refs (
  segment_id TEXT PRIMARY KEY REFERENCES note_segments(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL REFERENCES material_blocks(id) ON DELETE RESTRICT
);
CREATE INDEX idx_segment_material_block ON segment_material_refs(block_id);
`
  },
  {
    version: 7,
    name: 'concept_aliases',
    sql: `
ALTER TABLE knowledge_points ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE concept_aliases (
  concept_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL,
  PRIMARY KEY (concept_id, normalized)
);
CREATE INDEX idx_concept_alias_name ON concept_aliases(normalized);
`
  },
  {
    version: 8,
    name: 'material_ocr_versions',
    sql: `
ALTER TABLE material_versions ADD COLUMN parent_version_id TEXT REFERENCES material_versions(id) ON DELETE RESTRICT;
ALTER TABLE material_versions ADD COLUMN derivation TEXT NOT NULL DEFAULT 'original';
ALTER TABLE material_versions ADD COLUMN processing_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE material_ocr_pages (
  version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  corrected_text TEXT,
  confidence REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  model_json TEXT NOT NULL,
  PRIMARY KEY(version_id, page)
);
`
  },
  {
    version: 9,
    name: 'learning_source_revisions',
    sql: `
CREATE TABLE learning_documents (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL UNIQUE REFERENCES material_versions(id) ON DELETE RESTRICT,
  current_revision_id TEXT REFERENCES learning_revisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);
CREATE TABLE learning_sources (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES learning_documents(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  heading TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  extraction TEXT NOT NULL,
  UNIQUE(document_id, ordinal)
);
CREATE TABLE learning_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES learning_documents(id) ON DELETE RESTRICT,
  parent_revision_id TEXT REFERENCES learning_revisions(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_learning_revisions_document ON learning_revisions(document_id, created_at);
`
  },
  {
    version: 10,
    name: 'learning_ai_suggestions',
    sql: `
CREATE TABLE learning_suggestions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES learning_documents(id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE RESTRICT,
  base_revision_id TEXT NOT NULL REFERENCES learning_revisions(id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  proposal_json TEXT,
  created_at INTEGER NOT NULL,
  applied_revision_id TEXT REFERENCES learning_revisions(id) ON DELETE RESTRICT
);
CREATE INDEX idx_learning_suggestions_document ON learning_suggestions(document_id, created_at);
`
  },
  {
    version: 11,
    name: 'legacy_office_conversions',
    sql: `
CREATE TABLE material_conversions (
  version_id TEXT PRIMARY KEY REFERENCES material_versions(id) ON DELETE RESTRICT,
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`
  },
  {
    version: 12,
    name: 'knowledge_source_evidence',
    sql: `
CREATE TABLE knowledge_evidence (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  version_id TEXT REFERENCES material_versions(id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES learning_revisions(id) ON DELETE RESTRICT,
  note_segment_id TEXT REFERENCES note_segments(id) ON DELETE SET NULL,
  source_json TEXT NOT NULL,
  source_lookup TEXT NOT NULL,
  source_key TEXT NOT NULL,
  role TEXT NOT NULL,
  memo TEXT NOT NULL,
  quote TEXT NOT NULL,
  quote_sha256 TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_subject_id TEXT,
  location TEXT NOT NULL,
  entry_title TEXT NOT NULL,
  entry_type TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(concept_id, source_key)
);
CREATE INDEX idx_evidence_source ON knowledge_evidence(source_lookup, created_at);
`
  },
  {
    version: 13,
    name: 'knowledge_suggestions',
    sql: `
CREATE TABLE knowledge_suggestions (
  id TEXT PRIMARY KEY,
  source_lookup TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  proposal_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_knowledge_suggestions_source ON knowledge_suggestions(source_lookup, created_at);
CREATE TABLE knowledge_suggestion_adoptions (
  suggestion_id TEXT NOT NULL REFERENCES knowledge_suggestions(id) ON DELETE RESTRICT,
  candidate_index INTEGER NOT NULL,
  concept_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE RESTRICT,
  evidence_id TEXT REFERENCES knowledge_evidence(id) ON DELETE SET NULL,
  decision_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(suggestion_id, candidate_index)
);
`
  },
  {
    version: 14,
    name: 'learning_image_assets',
    sql: `
CREATE TABLE learning_assets (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES learning_documents(id) ON DELETE RESTRICT,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  file_path TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  locator_json TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_learning_assets_document ON learning_assets(document_id, created_at);
CREATE TABLE learning_asset_extractions (
  document_id TEXT PRIMARY KEY REFERENCES learning_documents(id) ON DELETE RESTRICT,
  engine TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`
  },
  {
    version: 15,
    name: 'portable_learning_imports',
    sql: `
CREATE TABLE learning_package_imports (
  id TEXT PRIMARY KEY,
  package_sha256 TEXT NOT NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('staging','ready')),
  planned_version_id TEXT NOT NULL,
  directory_created INTEGER NOT NULL DEFAULT 0,
  owner_pid INTEGER NOT NULL,
  inventory_json TEXT NOT NULL,
  material_id TEXT REFERENCES materials(id) ON DELETE RESTRICT,
  version_id TEXT REFERENCES material_versions(id) ON DELETE RESTRICT,
  revision_id TEXT REFERENCES learning_revisions(id) ON DELETE RESTRICT,
  origin_document_id TEXT NOT NULL,
  origin_version_id TEXT NOT NULL,
  origin_revision_id TEXT NOT NULL,
  id_map_json TEXT NOT NULL DEFAULT '{}',
  include_concepts INTEGER NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(package_sha256, subject_id)
);
`
  },
  {
    version: 16,
    name: 'note_learning_snapshots',
    sql: `
ALTER TABLE note_segments ADD COLUMN organized_model TEXT;
CREATE TABLE note_learning_documents (
  id TEXT PRIMARY KEY,
  note_id TEXT UNIQUE REFERENCES notes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
-- 每次成功保存只写发生变化的段落；不复制整堂课，避免拖慢转写。
CREATE TABLE note_learning_blocks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES note_learning_documents(id) ON DELETE RESTRICT,
  segment_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(document_id, segment_id, fingerprint)
);
CREATE TABLE note_learning_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES note_learning_documents(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  subject_id TEXT,
  block_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_note_learning_history ON note_learning_revisions(document_id, created_at);
`
  },
  {
    version: 17,
    name: 'note_learning_semantic_revisions',
    sql: `
-- NULL 兼容迁移 16：按既有段落快照重建初始条目，无须改写旧快照。
ALTER TABLE note_learning_revisions ADD COLUMN state_json TEXT;
`
  },
  {
    version: 18,
    name: 'note_learning_suggestions',
    sql: `
CREATE TABLE note_learning_suggestions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES note_learning_documents(id) ON DELETE RESTRICT,
  base_revision_id TEXT NOT NULL REFERENCES note_learning_revisions(id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','ready','failed','cancelled','applied','dismissed')),
  proposal_json TEXT,
  error TEXT,
  applied_revision_id TEXT REFERENCES note_learning_revisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_note_learning_suggestions ON note_learning_suggestions(document_id, created_at);
`
  },
  {
    version: 19,
    name: 'note_package_import_receipts',
    sql: `
ALTER TABLE note_segments ADD COLUMN learning_heading TEXT NOT NULL DEFAULT '';
-- 只在完整事务成功后登记；原包与稳定映射保留，不跟随用户段落删除而丢失出处。
CREATE TABLE note_package_imports (
  id TEXT PRIMARY KEY,
  package_sha256 TEXT NOT NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  note_id TEXT UNIQUE REFERENCES notes(id) ON DELETE SET NULL,
  document_id TEXT NOT NULL REFERENCES note_learning_documents(id) ON DELETE RESTRICT,
  include_concepts INTEGER NOT NULL CHECK(include_concepts IN (0,1)),
  manifest_json TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(package_sha256, subject_id)
);
`
  },
  {
    version: 20,
    name: 'projects_and_tasks',
    sql: `
-- R4 项目管理：项目 / 里程碑 / 统一任务模型（R5 日程与 R6 备忘分流复用 tasks 表）
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done','archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_milestones_project ON project_milestones(project_id, sort_order);

-- 统一任务模型：kind 区分来源（project_task 项目任务 | manual 手动；
-- R5 计划接入 assignment 作业 | review 复习；R6 备忘可分流为 manual）
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('project_task','manual')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES project_milestones(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','doing','blocked','done')),
  blocked_reason TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  planned_at INTEGER,
  knowledge_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_tasks_due ON tasks(due_at) WHERE due_at IS NOT NULL;
`
  },
  {
    version: 21,
    name: 'calendar_time_ranges_and_import_receipts',
    sql: `
ALTER TABLE tasks ADD COLUMN planned_end_at INTEGER;
ALTER TABLE tasks ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0 CHECK(all_day IN (0,1));
ALTER TABLE tasks ADD COLUMN location TEXT NOT NULL DEFAULT '';
CREATE TABLE calendar_import_receipts (
  import_key TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_planned ON tasks(planned_at);
`
  },
  {
    version: 22,
    name: 'exercise_learning_documents',
    sql: `
ALTER TABLE exercises ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE exercises ADD COLUMN status TEXT NOT NULL DEFAULT 'unfinished' CHECK(status IN ('unfinished','correct','wrong'));
ALTER TABLE exercises ADD COLUMN question_type TEXT NOT NULL DEFAULT '';
ALTER TABLE exercises ADD COLUMN source_label TEXT NOT NULL DEFAULT '';
ALTER TABLE exercises ADD COLUMN review_concepts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE exercises ADD COLUMN head_revision_id TEXT;
ALTER TABLE exercises ADD COLUMN source_key TEXT;
ALTER TABLE exercises ADD COLUMN deleted_at INTEGER;
CREATE TABLE exercise_revisions (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_exercise_revisions ON exercise_revisions(exercise_id, created_at);
CREATE INDEX idx_exercises_subject_status ON exercises(subject_id, status, deleted_at);
CREATE UNIQUE INDEX idx_exercises_source ON exercises(source_key) WHERE source_key IS NOT NULL;
`
  },
  {
    version: 23,
    name: 'knowledge_graph_relations_and_layout',
    sql: `
ALTER TABLE knowledge_edges ADD COLUMN memo TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_edges ADD COLUMN revision TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE knowledge_edges ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_edges ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_knowledge_edges_target ON knowledge_edges(to_id);
CREATE TABLE concept_graph_positions (
  concept_id TEXT PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL
);
`
  },
  {
    version: 24,
    name: 'versioned_project_documents',
    sql: `
CREATE TABLE project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('requirements','plan','report','other')),
  head_revision_id TEXT NOT NULL,
  source_key TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_project_document_source ON project_documents(project_id,source_key) WHERE source_key IS NOT NULL;
CREATE INDEX idx_project_documents_project ON project_documents(project_id,deleted_at,updated_at);
CREATE TABLE project_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_project_document_history ON project_document_revisions(document_id);
`
  },
  {
    version: 25,
    name: 'task_learning_resources',
    sql: `
CREATE TABLE task_resource_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  material_revision_id TEXT REFERENCES learning_revisions(id) ON DELETE SET NULL,
  note_revision_id TEXT REFERENCES note_learning_revisions(id) ON DELETE SET NULL,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  exercise_revision_id TEXT REFERENCES exercise_revisions(id) ON DELETE SET NULL,
  project_document_revision_id TEXT REFERENCES project_document_revisions(id) ON DELETE SET NULL,
  concept_id TEXT REFERENCES knowledge_points(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK(role IN ('learn','apply','output','question','verify')),
  why TEXT NOT NULL,
  verification TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id,source_key),
  CHECK ((material_revision_id IS NOT NULL)+(note_revision_id IS NOT NULL)+(exercise_revision_id IS NOT NULL)+(project_document_revision_id IS NOT NULL)<=1)
);
CREATE INDEX idx_task_resource_source ON task_resource_links(source_key);
CREATE INDEX idx_task_resource_concept ON task_resource_links(concept_id);
`
  },
  {
    version: 26,
    name: 'automatic_schedule_blocks',
    sql: `
CREATE TABLE task_planning (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  options_json TEXT NOT NULL
);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id,depends_on_id),
  CHECK(task_id != depends_on_id)
);
CREATE INDEX idx_task_dependency_target ON task_dependencies(depends_on_id);
CREATE TABLE schedule_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision TEXT NOT NULL,
  value_json TEXT NOT NULL
);
CREATE TABLE schedule_blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK(end_at>start_at),
  locked INTEGER NOT NULL CHECK(locked IN (0,1)),
  revision TEXT NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE(task_id,start_at,end_at)
);
CREATE INDEX idx_schedule_blocks_time ON schedule_blocks(start_at,end_at);
CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_fingerprint TEXT NOT NULL,
  changed_json TEXT NOT NULL,
  undone_at INTEGER
);
`
  },
  {
    version: 27,
    name: 'durable_reminders_and_delivery_outbox',
    sql: `
CREATE TABLE reminder_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, value_json TEXT NOT NULL
);
CREATE TABLE task_reminder_options (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  start_lead_minutes INTEGER, due_lead_minutes INTEGER
);
CREATE TABLE reminder_change_counter(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL);
INSERT INTO reminder_change_counter VALUES(1,0);
CREATE TRIGGER reminder_tasks_insert AFTER INSERT ON tasks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_tasks_update AFTER UPDATE ON tasks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_tasks_delete AFTER DELETE ON tasks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_blocks_insert AFTER INSERT ON schedule_blocks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_blocks_update AFTER UPDATE ON schedule_blocks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_blocks_delete AFTER DELETE ON schedule_blocks BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_project_update AFTER UPDATE OF status ON projects BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_options_insert AFTER INSERT ON task_reminder_options BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_options_update AFTER UPDATE ON task_reminder_options BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_options_delete AFTER DELETE ON task_reminder_options BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_settings_insert AFTER INSERT ON reminder_settings BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TRIGGER reminder_settings_update AFTER UPDATE ON reminder_settings BEGIN UPDATE reminder_change_counter SET seq=seq+1; END;
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('start','due','block')),
  source_id TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  remind_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','published','dismissed','snoozed','cancelled','expired')),
  published_at INTEGER,
  revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(status,remind_at);
CREATE INDEX idx_reminders_task ON reminders(task_id,event_key);
CREATE TABLE reminder_deliveries (
  reminder_id TEXT PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','claimed','shown','failed','uncertain','skipped','cancelled')),
  attempt TEXT,
  attempted_at INTEGER,
  next_at INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_reminder_outbox ON reminder_deliveries(status,next_at);
`
  },
  {
    version: 28,
    name: 'continuous_schedule_control_and_audit',
    sql: `
ALTER TABLE schedule_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE schedule_runs ADD COLUMN reason TEXT NOT NULL DEFAULT '用户确认排程预览';
ALTER TABLE schedule_runs ADD COLUMN outcome_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE schedule_automation (
  id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  horizon_days INTEGER NOT NULL CHECK(horizon_days BETWEEN 1 AND 31),
  state TEXT NOT NULL DEFAULT 'paused', last_stamp TEXT NOT NULL DEFAULT '',
  checked_at INTEGER, retry_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', outcome_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE schedule_change_counter(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL);
INSERT INTO schedule_change_counter VALUES(1,0);
CREATE TRIGGER schedule_tasks_insert AFTER INSERT ON tasks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_tasks_update AFTER UPDATE ON tasks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_tasks_delete AFTER DELETE ON tasks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_blocks_insert AFTER INSERT ON schedule_blocks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_blocks_update AFTER UPDATE ON schedule_blocks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_blocks_delete AFTER DELETE ON schedule_blocks BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_project_update AFTER UPDATE OF status ON projects BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_options_insert AFTER INSERT ON task_planning BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_options_update AFTER UPDATE ON task_planning BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_options_delete AFTER DELETE ON task_planning BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_deps_insert AFTER INSERT ON task_dependencies BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_deps_delete AFTER DELETE ON task_dependencies BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_settings_insert AFTER INSERT ON schedule_settings BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_settings_update AFTER UPDATE ON schedule_settings BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
CREATE TRIGGER schedule_settings_delete AFTER DELETE ON schedule_settings BEGIN UPDATE schedule_change_counter SET seq=seq+1; END;
`
  },
  {
    version: 29,
    name: 'memo_capture_review_and_routing',
    sql: `
CREATE TABLE memos (
  id TEXT PRIMARY KEY, revision TEXT NOT NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  inspiration_id TEXT UNIQUE
);
CREATE TABLE memo_versions (
  id TEXT PRIMARY KEY, memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  content TEXT NOT NULL, subject_id TEXT, created_at INTEGER NOT NULL, timezone TEXT NOT NULL
);
CREATE INDEX idx_memo_versions ON memo_versions(memo_id,created_at);
CREATE TABLE memo_routes (
  id TEXT PRIMARY KEY, memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  revision TEXT NOT NULL REFERENCES memo_versions(id), request_key TEXT NOT NULL UNIQUE,
  decision_json TEXT NOT NULL, created_at INTEGER NOT NULL, undone_at INTEGER
);
CREATE INDEX idx_memo_routes_owner ON memo_routes(memo_id,revision,undone_at);
CREATE INDEX idx_memos_updated ON memos(archived,updated_at DESC,id);
CREATE TABLE memo_targets (
  id TEXT PRIMARY KEY, route_id TEXT NOT NULL REFERENCES memo_routes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('concept','task')),
  concept_id TEXT REFERENCES knowledge_points(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL, created INTEGER NOT NULL CHECK(created IN (0,1)), snapshot_json TEXT NOT NULL,
  CHECK((kind='concept' AND task_id IS NULL) OR (kind='task' AND concept_id IS NULL))
);
CREATE INDEX idx_memo_target_concept ON memo_targets(concept_id);
CREATE INDEX idx_memo_target_task ON memo_targets(task_id);
CREATE TABLE memo_recognitions (
  id TEXT PRIMARY KEY, memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  revision TEXT NOT NULL REFERENCES memo_versions(id),
  status TEXT NOT NULL CHECK(status IN ('running','ready','failed','cancelled')),
  provider_name TEXT NOT NULL, model_id TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '', proposal_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_memo_recognitions_owner ON memo_recognitions(memo_id,created_at DESC,id);
`
  },
  {
    version: 30,
    name: 'memo_automation_policy_and_durable_queue',
    sql: `
CREATE TABLE memo_auto_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, value_json TEXT NOT NULL
);
CREATE TABLE memo_auto_jobs (
  id TEXT PRIMARY KEY,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  revision TEXT NOT NULL UNIQUE REFERENCES memo_versions(id),
  policy_revision TEXT NOT NULL, policy_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','review','routed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
  next_at INTEGER NOT NULL, recognition_id TEXT REFERENCES memo_recognitions(id), model_stamp TEXT,
  reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memo_auto_due ON memo_auto_jobs(status,next_at);
`
  },
  {
    version: 31,
    name: 'classroom_automatic_alignment',
    sql: `
CREATE TABLE classroom_alignment_settings (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  revision TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  hold_segment INTEGER NOT NULL DEFAULT 1 CHECK(hold_segment IN (0,1))
);
CREATE TABLE classroom_alignment_jobs (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL UNIQUE REFERENCES note_segments(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES classroom_sessions(id), epoch TEXT NOT NULL,
  source_revision INTEGER NOT NULL, raw_hash TEXT NOT NULL,
  source_anchor_id TEXT NOT NULL REFERENCES material_blocks(id),
  version_id TEXT NOT NULL REFERENCES material_versions(id), hold_segment INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','applied','review','cancelled','failed')),
  applied_block_id TEXT REFERENCES material_blocks(id), candidates_json TEXT NOT NULL DEFAULT '[]',
  strong_match INTEGER NOT NULL DEFAULT 0 CHECK(strong_match IN (0,1)),
  reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_classroom_alignment_owner ON classroom_alignment_jobs(note_id,created_at DESC);
CREATE INDEX idx_classroom_alignment_pending ON classroom_alignment_jobs(status);
CREATE INDEX idx_classroom_alignment_applied ON classroom_alignment_jobs(applied_block_id) WHERE status='applied';
`
  }
]
