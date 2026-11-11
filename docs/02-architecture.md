# 技术架构

> 版本：v0.2（2026-11-11）· 初稿：claude · 扩展设计：codex
>
> 本文约定架构方向；实际数据库以 `src/main/db/migrations.ts` 为准，实际依赖以锁文件为准。第 8 节是待实现草案，不表示已有对应表或接口。

## 1. 技术栈

| 层 | 技术 | 版本策略 |
|----|------|---------|
| 运行时 | Electron 45.2.3（本机内置 Node 24.22.2） | 当前锁定版本；不是自动追新策略 |
| 构建 | electron-vite + electron-builder | 最新稳定 |
| 前端 | React 19.3.1 + TypeScript 7.0.2 + react-router | 当前锁定版本，以 package-lock.json 为准 |
| 状态 | zustand | 最新稳定 |
| 编辑器 | BlockNote（M0 先用轻量段落模型，M1 引入） | 最新稳定 |
| 图谱 | @xyflow/react | M2 引入 |
| 数据库 | better-sqlite3（主进程）+ @electron/rebuild | 最新稳定 |
| LLM | openai npm SDK（换 baseURL） | 最新稳定 |
| 密钥存储 | Electron safeStorage（DPAPI，Windows） | 内置 |
| ASR | sherpa-onnx-node / 讯飞 WebAPI | M1 引入 |

## 2. 进程模型与安全

```
┌────────────────────────────────────────────────┐
│ 渲染进程（Chromium, React）                      │
│  contextIsolation: true, nodeIntegration: false │
│  只能调 window.api.*（preload 暴露的类型化表面）  │
└───────────────┬────────────────────────────────┘
                │ IPC（通道白名单 + 参数校验）
┌───────────────┴────────────────────────────────┐
│ 预加载脚本（preload, contextBridge）             │
│  把 IPC 包装成类型化 API，不暴露 ipcRenderer     │
└───────────────┬────────────────────────────────┘
                │
┌───────────────┴────────────────────────────────┐
│ 主进程（Node.js）                                │
│  - 窗口管理、应用生命周期                         │
│  - services/db        SQLite 读写（唯一写入口）   │
│  - services/llm       LLM 代理（密钥只在此进程）  │
│  - services/safeStorage 密钥加解密               │
│  - services/asr       （M1）ASR Provider 管理    │
│  - ipc/* handlers      按域拆分的 IPC 处理器      │
└────────────────────────────────────────────────┘
```

安全红线：
1. API Key 用 `safeStorage.encryptString()` 加密后存 SQLite，明文只在主进程内存中短暂存在
2. 渲染进程通过 IPC 请求主进程代理调用 LLM；密钥永不过 IPC 下发
3. IPC handler 对入参做类型校验（shared/types 中的 zod schema，M0 手写守卫函数）
4. CSP 严格限制；渲染进程不加载任何远程内容

## 3. 目录结构

```
LearningAssistant/
├── docs/                      # 规划文档（本目录）
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 入口：窗口、生命周期
│   │   ├── ipc/
│   │   │   ├── index.ts       # handler 注册总装
│   │   │   ├── providers.ipc.ts
│   │   │   ├── chat.ipc.ts
│   │   │   ├── notes.ipc.ts
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── db.ts          # better-sqlite3 连接 + 迁移
│   │   │   ├── llm.ts         # openai SDK 封装、流式转发
│   │   │   └── secrets.ts     # safeStorage 加解密
│   │   └── db/
│   │       ├── schema.sql     # 建表语句（版本化迁移）
│   │       └── migrations/
│   ├── preload/
│   │   └── index.ts           # contextBridge API 表面
│   └── renderer/
│       └── src/
│           ├── app/           # 路由、全局布局、底部快捷栏
│           ├── pages/         # 课堂/笔记/对话/知识库/习题/复习/灵感/设置
│           ├── components/    # 通用组件
│           ├── stores/        # zustand stores
│           ├── api/           # window.api 封装（渲染侧）
│           └── styles/
├── shared/                    # 主/渲染共享（不依赖 electron）
│   ├── types.ts               # 全部业务实体与 DTO
│   └── ipc-channels.ts        # 通道名常量 + 请求/响应类型映射
├── resources/                 # 图标等静态资源
├── electron.vite.config.ts
├── package.json
└── tsconfig 系列
```

## 4. IPC 规范

通道命名：`域:动作`，如 `chat:send`、`providers:list`、`notes:updateSegment`。

```ts
// shared/ipc-channels.ts（示意）
export const IPC = {
  // 供应商与模型
  'providers:list':   Req<void>,              Res<Provider[]>,
  'providers:save':   Req<ProviderInput>,     Res<Provider>,
  'providers:test':   Req<{id: string}>,      Res<{ok: boolean, latencyMs: number, error?: string}>,
  'models:import':    Req<{providerId: string}>, Res<ModelInfo[]>,
  'models:save':      Req<ModelInput>,        Res<ModelInfo>,
  // 对话
  'chat:list':        Req<void>,              Res<ChatSession[]>,
  'chat:create':      Req<{subjectId?: ID}>,  Res<ChatSession>,
  'chat:send':        Req<ChatSendInput>,     Res<never> /* 流式经 llm:chunk 事件回推 */,
  'chat:abort':       Req<{messageId: ID}>,   Res<void>,
  // 笔记
  'notes:list' / 'notes:get' / 'notes:create' / 'notes:addSegments' /
  'notes:updateSegment' / 'notes:deleteSegment'
  // 标注
  'annotations:add' / 'annotations:update' / 'annotations:remove'
  // ...
} as const
```

约定：
- 所有 handler `try/catch`，错误以 `{ ok: false, error: string }` 返回，不 reject
- 流式（LLM）走 `webContents.send('llm:chunk', ...)` 事件推送，渲染侧订阅；`chat:abort` 中止
- 每个通道的 Req/Res 类型定义在 shared/ipc-channels.ts，preload 按同一映射生成类型化函数——**类型一处定义，三处共享**

## 5. 数据模型（SQLite schema v1）

> 命名：snake_case；主键 `id TEXT`（nanoid）；时间戳 INTEGER（epoch ms）；JSON 字段后缀 `_json`。
>
> 下文是初始模型示意，活动相关字段由迁移 v2 追加，`app_config` 由 v3 追加；当前实际为 v6、23 张表。v4 增加整理修订/任务状态，v5 增加材料版本与块，v6 增加课堂会话、当前位置、校准历史和段落来源。末尾简写不能直接执行；真实结构以 migrations.ts 为准。新增项目等实体尚无迁移。

```sql
-- 学科
CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,                -- 主题色（界面标识）
  description TEXT,
  created_at INTEGER NOT NULL
);

-- 活动（讲座/会议/讨论，ADR-5：与学科并列的一等分类实体）
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,           -- 如"XX院士力学前沿讲座"
  kind TEXT NOT NULL DEFAULT 'lecture',  -- lecture|seminar|meeting|other
  happened_at INTEGER,           -- 举行时间
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,  -- 可选关联学科（知识挂载）
  description TEXT,
  created_at INTEGER NOT NULL
);

-- API 供应商（ccswitch 风格）
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,        -- 显示名，如 "DeepSeek 官方"
  base_url TEXT NOT NULL,
  api_format TEXT NOT NULL DEFAULT 'openai',   -- openai | anthropic
  api_key_encrypted BLOB,    -- safeStorage 加密
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 模型（属于某供应商，可编辑能力备注）
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,    -- 调用时的 model 参数
  display_name TEXT NOT NULL,
  context_length INTEGER,    -- 上下文窗口（token）
  supports_vision INTEGER DEFAULT 0,
  speed_tier TEXT,           -- fast | medium | slow
  notes TEXT,                -- 自由备注
  created_at INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);

-- 笔记（挂学科或活动，二选一，ADR-5）
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source TEXT DEFAULT 'manual',   -- manual | class | import
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 笔记段落（双视图核心表）
CREATE TABLE note_segments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,     -- 段内排序
  seg_type TEXT DEFAULT 'other',   -- definition|proposition|example|proof|solution|note|other
  raw_text TEXT,                   -- 原文视图（转写规整后）
  organized_text TEXT,             -- 整理视图（AI 或手动整理的 markdown）
  image_path TEXT,                 -- 关联图片（M1）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 标注（挂在段落或选区上）
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES note_segments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- keypoint | question
  anchor_json TEXT,                -- 选区定位（BlockNote M1；M0 整段级）
  comment TEXT,                    -- 标注备注
  created_at INTEGER NOT NULL
);

-- 对话
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user | assistant | system
  content TEXT NOT NULL,
  context_json TEXT,               -- 本条消息挂载的笔记/知识库引用
  created_at INTEGER NOT NULL
);

-- 知识点（M2 启用，表先建好）
CREATE TABLE knowledge_points (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  summary TEXT,
  source_segment_id TEXT REFERENCES note_segments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE knowledge_edges (
  from_id TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  relation TEXT DEFAULT 'related', -- related | prerequisite | extends | cross-subject
  PRIMARY KEY (from_id, to_id)
);

-- 知识库材料 / 习题 / 灵感 / 作业复习（M3/M4，此处先定结构）
CREATE TABLE materials ( id, subject_id, title, kind/*textbook|supplement*/, file_path, parsed_path, tags_json, created_at );
CREATE TABLE exercises  ( id, subject_id, statement, user_solution, std_answer, approach_json, error_points_json, no_idea INTEGER DEFAULT 0, related_json, created_at, updated_at );
CREATE TABLE inspirations ( id, subject_id, content, context_text, created_at );
CREATE TABLE assignments ( id, subject_id, title, due_at, source/*manual|learnx*/, planned_at, status );
CREATE TABLE review_records ( id, item_type, item_id, fsrs_state_json, due_at );
```

迁移策略：`user_version` PRAGMA + 顺序编号的 migration 文件，启动时主进程自动执行。

## 6. 关键设计决策记录（ADR 摘要）

### ADR-0 离线优先（用户确认 2026-11-10）
基础功能（转写、笔记、标注、习题、复习调度、全部数据存取）**完全本地**，不依赖网络；智能体问答、网络检索、AI 整理为联网增值功能，无网时优雅降级（转写保留原文视图，整理标记 pending 待联网补跑）。默认 ASR Provider 为本地（sherpa-onnx），云端（讯飞）为用户可选。

### ADR-1 段落双视图用"两列文本"而非版本树
`note_segments.raw_text / organized_text` 一一对应。理由：课堂场景两者是"同一内容的两种呈现"，非编辑历史；AI 整理覆盖 organized_text 时保留用户手动修改标记（updated 字段区分 ai/user 来源，M1 加列）。代价：段落拆分错位时需对齐逻辑——由"转写→分段→整理"流水线保证段落粒度一致。

### ADR-2 LLM 上下文组装在主进程
`chat:send` 携带 `contextRefs`（笔记段 id / 材料 id），主进程查库拼装 system prompt（学科背景+选定内容），渲染进程只传引用不传全文。理由：渲染进程不重复持有全部数据，且后续预回答缓存、导学提示复用同一组装器。

### ADR-3 模型能力备注是数据不是代码
预设供应商/模型写进 seed 数据（首次启动插入，可删改），不硬编码在组件里。理由：模型迭代快，调研表（01-research.md §2.3）三个月就过时。

### ADR-4 v1 只实现 openai + anthropic 两种上游格式适配
覆盖 DeepSeek/Qwen/GLM/Kimi（openai 兼容）与 Claude 系（anthropic）。Gemini 官方兼容层亦可用 openai 格式接。其他格式待需求出现再加。

### ADR-5 活动是与学科并列的一等分类实体（2026-11-10 补充）
讲座、会议、讨论与课程共用全部功能管线（转写/笔记/整理/提问），但管理属性不同：课程主题一致、前后连贯（按学科累积知识）；活动次数多、主题跳跃（每场独立、互不连贯）。因此不把每场活动建成学科（否则学科列表爆炸、语义混乱），而是：
- `activities` 表：每场活动一条记录（标题、类型 lecture/seminar/meeting/other、日期）
- `activity.subject_id` 可空外键——活动**可关联**某学科，其内容产生的知识点可进入该学科知识网络（呼应"学科彼此不孤立"）
- `notes.subject_id` 与 `notes.activity_id` 双可空外键，二选一挂载（业务层校验）；chat_sessions 同理
- UI：学科选择器保持课程语义；活动在自己的页面按日期倒序管理，每场活动可挂笔记/发起课堂模式

## 7. 性能与体量预估

- 单条课程笔记 ≈ 500-2000 段落 × 平均 200 字 → SQLite 单表百万行级以内，索引 `note_id+sort_order`、`segment_id`
- LLM 流式首 token 目标 < 2s（取决于供应商）；本地 ASR 延迟目标 1-3s（M1 实测调优）
- 打包体积预估 150-250MB（Electron 基座 ~120MB + 依赖）；ASR 模型按需下载，不打进安装包

## 8. 扩展架构草案（2026-11-11，待分批实现）

完整行为与验收见 [04-product-expansion.md](04-product-expansion.md)，执行顺序见 [03-roadmap.md](03-roadmap.md)。

### ADR-6 项目跨学科，知识与任务共用引用

`projects` 通过显式关联表连接多个学科、知识点、材料、笔记与项目文档；不把项目当成一种学科或单次活动。任务到知识点的边说明“需要掌握/在此应用/产出证据”，支持从学习资料找到应用项目，也支持从项目任务回到学习来源。

统一引用协议扩展现有 `ContextRef`，由主进程展开上下文。具体关系优先采用有外键的表；关系有删除/失效策略，避免只保存无约束 JSON ID。

### ADR-7 统一任务、日程时间块与提醒

`tasks` 承接手动、项目、备忘及后续作业/复习任务；`schedule_blocks` 记录安排的工作时段，`reminders` 记录投递计划。截止时间与工作时段分开；提醒有持久化状态与幂等标识。先定义与现有 `assignments`、`review_records` 的映射，再追加迁移，保留旧数据。

自动排程尊重用户可用时段、固定课程、任务依赖和锁定块；变化保留原因，可撤销。应用退出后的提醒必须有真实后台或系统执行机制，不能只依赖渲染进程计时器。

### ADR-8 备忘先落库，智能识别异步执行

保存 `memos` 原文后再分类，状态包括待处理、已归档、需补全和失败；分类运行及衍生知识/任务关系可追踪。明确条目按启用规则自动归档，模糊条目进入待整理箱；重试幂等、离线可记、修正可更新、归档可撤销。现有灵感库作为关联目标或分类视图保留并迁移。

### ADR-9 材料原件、解析版本、稳定块与后台任务

R1 首批已实现：OfficeParser 负责 DOCX/PPTX，PDF.js 负责 PDF 页级文字提取；独立 worker 顺序解析，主进程维护数据库与工作锁。版本记录同时承载持久任务状态，取消/失败可重试，中断任务重启恢复；成功版本不原地重解析。位置暂为 PDF 整页、PPT 幻灯片、Word 逻辑结构条目；未交付精确段落框、OCR 和旧格式转换。选型与验证见 [R1 记录](07-material-library.md)。

扩展 `materials`，追加版本、带位置的块及导入任务。格式适配器负责 PDF/Word/PowerPoint 的扫描、转换与提取，统一输出可追溯块；扫描件接 OCR，旧 DOC/PPT 经转换后进入同一流程。复杂公式/图表保留原件引用与质量标记。

位置用“材料版本 + 稳定块 ID + 页/幻灯片/区域映射”；不能用可能随重新切块变化的数组下标当永久链接。解析、OCR、转换在后台 worker/独立进程执行，主进程保持 DB 与生命周期协调，不阻塞实时音频。

### ADR-10 课堂当前位置与历史段落引用分开保存

R2 已按此原则实施，验证记录见 [R2 报告](08-classroom-material-link.md)。PDF 原件通过只读 `study-material:` 协议按版本 ID 提供；资源仅允许托管 PDF 和 PDF.js 的指定静态文件，不接收任意磁盘路径。渲染复用 PDF.js 解析/绘制工作线程，同一版本翻页复用文档，取消旧页面任务并限制预览像素。课堂恢复需用户点击继续，启动时将上次未结束会话标记为 interrupted；此清理时间不视为准确的授课结束时间。

增加课堂会话、教材游标/校准事件以及段落到材料的多对多位置关系。左教材、右记录；课前起点、自动估计与人工校准分别保存，人工优先。段落保存生成时的位置快照，历史引用不随当前页移动而变化。

先交付人工位置与双向定位，再加自动对齐及置信度。附近材料上下文辅助整理术语和公式，但不得覆盖原始转写；教材补充与讲授内容分开标注来源。AI 整理的异步写回应有版本/手动编辑冲突保护，后台任务需要可重试状态。
