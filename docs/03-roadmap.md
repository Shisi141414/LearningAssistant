# 开发路线图

> 版本：v0.1（2026-11-10）· 撰写：claude · 原则：每期结束都有可运行、可日常使用的版本

## M0 — 地基与核心闭环（本次会话）

**目标**：应用能跑起来，完成"配置 API → 与智能体对话 → 写笔记并标注"最小闭环。

| 任务 | 验收标准 |
|------|---------|
| 项目框架 | electron-vite + React + TS 启动无错；主/预加载/渲染三进程结构成型；better-sqlite3 经 @electron/rebuild 正常加载 |
| 数据库层 | schema v1 全部建表；迁移机制（PRAGMA user_version）工作；seed 预置学科与供应商预设 |
| API 配置（模块12） | 供应商 CRUD（名称/baseURL/上游格式/Key）；Key safeStorage 加密存储；连通性测试按钮；从 /models 导入模型；模型能力五字段（上下文/识图/速度/备注）可编辑；预设供应商（DeepSeek/Qwen/GLM/Kimi 等）一键添加 |
| 智能体对话（模块5基础） | 多会话管理；流式输出；中断生成；会话挂到学科；发送时可引用笔记段落作为上下文 |
| 笔记与标注（模块2基础+3） | 笔记 CRUD；段落级编辑（类型标记：定义/命题/例题/证明/解答/注意，分色显示）；整段"重点/疑问"标注 + 标注备注；原文/整理双字段存储与切换展示（M0 为手动编辑，M1 接 AI） |
| 灵感库（模块9） | 快速记录灵感条目，关联学科 |
| 全局快捷栏（模块9条） | 所有页面底部固定："询问智能体"输入框 + "重点" + "疑问"按钮；选中内容后可点击（M0：跳转对话页带上选中内容） |
| Git | 规范提交；推送到 GitHub |

**明确不做（M0）**：实时转写、图片上传、知识图谱、BlockNote 富文本（M0 段落用 textarea 级编辑，数据模型已为 BlockNote 预留）、预回答缓存、learnx、FSRS。

## M1 — 课堂模式（转写流水线）

**目标**：真实课堂可用的实时转写 + 段落整理。**本地优先**（用户确认）：转写默认走本地 Provider，完全离线可用。

- ⚠️ 风险项前置（动工前两周内完成）：
  - sherpa-onnx Windows 实测：zipformer-transducer（支持热词）vs Paraformer（精度高）的 CER、延迟、热词效果对比（力学术语表测试）
  - 讯飞/阿里 Key 申请（云端备选 Provider）
- AsrProvider 抽象 + LocalAsrProvider（默认，sherpa-onnx 流式，模型按需下载）+ CloudAsrProvider（可选，讯飞 WebAPI）
- 2-pass 转写管线：流式 partial 实时上屏 + VAD 切段离线精转 final 替换（飞书妙记式动态修正，参考 cueflow #2150）
- 课堂页：实时转写流显示（原文视图即时滚动）；标注在转写流上即时插入
- 转写→分段→AI 整理流水线：段落级纠改、seg_type 分类着色、公式规整；**无网降级**：保留原文，联网后补整理
- 双视图切换 UI 完善
- 图片上传 + vision 模型识别归位（依赖 supports_vision 模型）
- 快速提问面板（选中即问）

## M2 — 知识网络与预回答

- 知识点抽取（LLM 从笔记段落抽取候选，用户确认入库）
- 图谱页（@xyflow/react）：节点=知识点，边=关系，跨学科边高亮
- 快速提问的**预回答缓存**：非课堂时段，根据课堂进展预生成 Q&A 池；课堂提问先命中缓存（语义检索，可用 sqlite-vec 或简单关键词，届时调研定案）
- 数学计算辅助：SymPy + Pyodide 技术验证（渲染进程 WASM，离线符号推导），集成到快速提问与习题解答验证；Wolfram API 作为联网时的 LLM math tool
- 课后完整音频二次精转（whisper.cpp 系，Buzz 同引擎；可选）

## M3 — 知识库与习题库

- 材料 CRUD + PDF 文本提取（pdfplumber 轻量路线先行；MinerU 重解析作为可选增强，Python sidecar 或调用其 CLI）
- 解析结果贴标签、按标题层级索引、可被对话上下文引用
- 习题库 CRUD：题面/用户解答/标准答案/思路（结构化步骤）/错误点标记/无思路标记；关联知识点与教材位置
- 灵感库增强（关联知识点）

## M4 — 作业与复习（+导学助手）

- ⚠️ 前置：实测 thu-learn-lib 对现行网络学堂的兼容性（SSO 登录流程）
- 作业同步（learnx）+ 手动作业；DDL 列表视图
- ts-fsrs 接入：知识点/习题进入复习队列；每日复习清单页
- 导学助手 v1：课堂模式下基于当前讲授内容重要度的注意力提醒（规则+LLM 混合，先做规则版）

## M5 — 打磨与小组件

- Windows 桌面小组件（推送待复习知识点；Electron 透明置顶小窗 or Windows Widgets，届时调研）
- 导出（笔记→Markdown/PDF）
- 设置页完善、主题、快捷键
- electron-builder 打包 NSIS 安装包，发布 GitHub Release

## 里程碑间的工作约定

1. 每次会话开工：`git pull` 最新 main
2. 每次会话收尾：typecheck + 构建通过后提交并 push
3. 每期开始前：按 01-research.md 的"决策层级"复查选型是否过时（社区调研不是一次性的）
4. 破坏性 schema 变更走 migration，禁止改老 migration 文件
