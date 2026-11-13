# LearningAssistant 学习助手

面向大学生的 AI 学习助手桌面应用：课堂实时转写整理、双视图笔记、知识网络、习题库、FSRS 复习调度，接入可切换的智能体 API。

## 功能概览

- **课堂模式**（M1 / R2）：左材料右转写、PDF 原页、课前起点、手动校准、段落来源与教材回链、课堂恢复；语音转写与段落级 AI 整理保留原文；右侧默认统一文档，新来源合并更新，草稿/历史/导出暂停刷新，点击来源不离开课堂
- **智能体对话**（M0）：多供应商 API 接入（ccswitch 风格配置），流式对话，引用笔记作为上下文
- **笔记与标注**（M0 / 统一格式）：段落类型标记、重点/疑问标注与备注；课堂整理与人工保存生成内部来源快照，统一阅读与检索、原文/教材位置对照、历史修订；共用教材的结构及公式编辑，新来源变化保护人工整理并提供同步预览；教材与笔记均可导出所选修订 PDF；笔记 AI 结构候选核对后采纳，人工内容与旧修订受保护；可导出/预览导入含原始口述的笔记文档包，重复导入保留人工修改，外部教材出处不误连本机记录
- **知识与概念**（R1 补充 / R3）：主名称与确认别名管理、正文自动关联、同名多义候选、概念卡片与反向查找；教材语义条目/笔记可引用到知识点并保留历史证据；AI 可提议知识候选，逐条审核后新建或引用已有知识点；知识图谱支持前置/推广/相关关系、跨学科筛选、手动与自动排布，以及知识点到习题和任务的回链；实体合并仍待实现
- **材料库**（R1）：PDF、DOCX、PPTX 按学科导入，旧 DOC/PPT 通过本地 LibreOffice 转换；原件、转换记录与版本保留；扫描 PDF 按页 OCR 与校正；学习文档支持人工整理、AI 分类/拆分建议审核、证明归属、章节层级/目录/筛选、公式校正、Word/PPT 嵌入配图与 PDF 原页选区、人工图文归属、类型排版和历史修订
- **项目与日程**（R4/R5）：项目目标、里程碑、任务与知识用途；日/周/月时间轴、冲突检查及 ICS 导入导出；版本化要求/计划书/报告、固定来源、知识回链与 PDF；任务关联教材/笔记/习题/项目文档条目并记录应用方法；自动安排学习时间支持分段、依赖、锁定、预览确认与撤销；提醒中心支持提前量、稍后、免打扰、重启补发和去重，可选系统通知及托盘后台。持续自动调整、彻底退出后的系统级提醒仍待构建
- **习题库**：与教材共用内置格式，分区记录思路、标准答案、用户答案与错因；支持状态、题型、复习知识点、教材转入、历史、回收站和 PDF 导出
- **作业与复习**（M4 规划）：网络学堂（learnx）DDL 同步、FSRS 遗忘曲线调度

上述包含规划中的模块；当前已实现对话、笔记、活动、灵感、课堂转写管线、材料库、OCR、旧格式转换、人工语义条目、AI 整理建议审核及概念别名关联，M3 习题库已支持录入、教材条目转入、检索与修订，见 [习题库交付记录](docs/40-exercise-library.md)；原复习入口已接统一日程，FSRS 复习尚待接入。可靠性修复见 [R0 构建记录](docs/06-build-progress-2026-11-11.md)，材料能力边界见 [R1 交付记录](docs/07-material-library.md)与 [学习文档记录](docs/12-semantic-entries.md)；[体检报告](docs/05-health-check-2026-11-11.md) 保留初始审查基线。

新增规划：项目系统（要求/计划书/文档/进度/截止时间与知识应用）、日程自动排程和提醒、备忘智能归档，以及 Word/PDF/PPT 教材条目化与“左教材、右转写”的课堂联动。课堂整理笔记已接入内部格式及结构编辑，教材与笔记的 [固定修订 PDF 导出](docs/26-learning-pdf-export.md)已实现；[课堂实时统一阅读](docs/27-classroom-learning-format.md)已接通；[笔记 AI 结构建议与审核](docs/28-note-ai-structure.md)已接通；自动图文/数学识别和真实模型质量仍待完善。需求、依赖和验收见 [扩展规格](docs/04-product-expansion.md)；优先级见 [路线图 R0–R6](docs/03-roadmap.md)。

## 技术栈

Electron + React + TypeScript · electron-vite · better-sqlite3 · zustand · openai SDK（多供应商兼容）

## 开发

开发 Node 版本须满足 `package.json` 的 `engines`（建议 24.22.1 以上的 24.x），以符合 OfficeParser 的运行要求。应用内 Electron 自带兼容的 Node。长篇材料解析使用工作线程，不依赖单独 Python 环境。

```bash
git pull --ff-only     # 修改前检查工作区，再拉取最新
npm install            # 安装依赖
npm run rebuild        # 首次安装后必跑：将 better-sqlite3 重编译为 Electron ABI
npm run dev            # 开发模式（HMR）
npm run typecheck      # 类型检查
npm run test:db        # 数据库迁移冒烟测试
npm test               # 全部回归；包含构建及两轮隔离 Electron 材料集成检查
npm run test:task-resources # 单独验证任务资料、固定条目往返与重启
npm run test:graph     # 单独验证知识图谱与习题/任务回链
npm run test:materials # 单独验证材料导入、定位、版本与重启恢复
npm run build          # 构建
npm run build:win      # 打包 Windows 安装包（NSIS）
```

> **Windows 首次运行排坑**
>
> 1. `npm run dev` 报 `Error: Electron uninstall`：npm 12+ 的安装脚本白名单拦截了 electron 的 postinstall，二进制没下载。执行
>    `npm install-scripts approve electron better-sqlite3`，然后
>    `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules\electron\install.js`
> 2. 报 `NODE_MODULE_VERSION mismatch`：执行 `npm run rebuild`（重编译 better-sqlite3 为 Electron ABI，需要 Python 3 与 VS Build Tools）
>
> （详见 docs/01-research.md §1.2）

## 语音引擎（课堂模式）

课堂实时转写走本地引擎（离线优先），首次使用：

1. `npm install`（自动安装可选依赖 sherpa-onnx-node 及平台二进制）
2. 下载流式中英双语模型：GitHub `k2-fsa/sherpa-onnx` 的 **asr-models** Release 页，用
   `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2`（488MB，transducer 结构、支持热词；压缩包含 int8 量化，CPU 可实时），解压到任意目录
3. 应用内：设置 → 语音引擎 → 模型目录选择解压目录 → 保存（状态应显示"模型就绪"）
4. 课堂页 → 开始课堂 → 🎤 开始录音

推荐同时填写热词表（每行一个学科术语，如"柯西中值定理"），可显著提升专有名词识别率（需 transducer 系模型）。

## 文档

- [任务学习资料、用途与双向条目引用](docs/43-task-learning-resources.md)
- [自动安排学习时间、分段与预览撤销](docs/45-auto-schedule.md)
- [持久提醒、系统通知与后台驻留](docs/46-durable-reminders.md)
- [习题集文件导入与自动切分](docs/44-exercise-set-import.md)
- [项目要求、计划书与版本化文档](docs/42-project-documents.md)
- [知识图谱与学习应用回链](docs/41-knowledge-graph.md)
- [产品总览](docs/00-overview.md)
- [社区调研与选型决策](docs/01-research.md)
- [技术架构](docs/02-architecture.md)
- [开发路线图](docs/03-roadmap.md)
- [项目、日程、备忘与教材课堂联动](docs/04-product-expansion.md)
- [代码库体检（2026-11-11）](docs/05-health-check-2026-11-11.md)
- [可靠性修复记录](docs/06-build-progress-2026-11-11.md)
- [材料库选型、使用边界与交付记录](docs/07-material-library.md)
- [课堂材料联动与格式转换方案](docs/08-classroom-material-link.md)
- [统一学习文档格式草案、结构示例与建设顺序](docs/09-learning-document-format.md)
- [概念别名自动关联、使用说明与真实教材验收](docs/10-concept-alias-links.md)
- [扫描 PDF 本地识别、人工校正与验收](docs/11-local-ocr.md)
- [学习文档来源、人工语义条目与修订](docs/12-semantic-entries.md)
- [AI 语义拆分建议、人工审核与保护](docs/13-ai-semantic-review.md)
- [旧版 DOC/PPT 转换、配置与验收](docs/14-legacy-office-conversion.md)
- [知识点与教材/笔记的固定证据引用](docs/15-knowledge-evidence.md)
- [AI 知识候选、来源校验与人工采纳](docs/16-knowledge-suggestions.md)
- [学习文档章节层级、目录与范围归属](docs/17-learning-outline.md)
- [学习文档公式校正、内容节点与来源保留](docs/18-learning-formulas.md)
- [学习文档嵌入配图、人工归属与附件来源](docs/19-learning-figures.md)
- [PDF 原页选区配图、坐标来源与回链](docs/20-pdf-figure-crops.md)
- [可移植学习文档包：契约、后台校验与所选修订导出](docs/21-portable-learning-package.md)
- [学习文档包预览、确认导入与中断恢复](docs/22-portable-learning-import.md)
- [课堂笔记统一格式：来源快照、阅读与历史](docs/24-note-learning-format.md)
- [笔记结构与公式编辑、后续课堂来源同步保护](docs/25-note-learning-editor.md)
- [教材与笔记 PDF 导出：中文、公式、配图与固定修订](docs/26-learning-pdf-export.md)
- [课堂实时统一阅读、来源跳转与草稿保护](docs/27-classroom-learning-format.md)
- [笔记 AI 结构建议、审核与来源保护](docs/28-note-ai-structure.md)
- [笔记文档包契约与固定修订导出](docs/29-portable-notes.md)
- [中断恢复、笔记导入与项目/日程/数学输入复核](docs/32-resumed-validation.md)
- [OCR 实际运行复核、公式依赖冲突与修复](docs/37-ocr-runtime-validation.md)
- [教材管理、日历视图、分类配色与课表冲突检查](docs/38-material-calendar-management.md)
- [正文与公式在输入区直接混排编辑](docs/39-visual-math-input.md)
- [真实 PDF、旧 DOC/PPT 文档包跨目录验收](docs/23-real-portable-materials.md)

## 开发约定

- 修改前拉取，完成一批代码后测试、类型检查和构建，通过后及时提交并 push；保留协作者的未提交改动，禁止默认强推
- 具体协作要求见 [AGENTS.md](AGENTS.md)；语音模型压缩包与解压目录仅存本地，不进入 Git
- 复杂功能先查 GitHub 和社区，遵循“直接使用 → 迁移 → 修改 → 自己写”优先序，决策记录见 docs/01-research.md
- schema 变更必须走 migration

---
规划与初始实现：claude（2026-11）
