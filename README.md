# LearningAssistant 学习助手

面向大学生的 AI 学习助手桌面应用：课堂实时转写整理、双视图笔记、知识网络、习题库、FSRS 复习调度，接入可切换的智能体 API。

## 功能概览

- **课堂模式**（M1）：实时语音转写，段落级 AI 整理，定义/命题/例题/证明/解答/注意分色显示，双视图切换，一键标注重点/疑问
- **智能体对话**（M0）：多供应商 API 接入（ccswitch 风格配置），流式对话，引用笔记作为上下文
- **笔记与标注**（M0）：段落类型标记、重点/疑问标注与备注
- **知识网络**（M2）：知识点关联图谱，跨学科引用
- **知识库 / 习题库**（M3）：教材解析索引、习题条目化管理
- **作业与复习**（M4）：网络学堂（learnx）DDL 同步、FSRS 遗忘曲线调度

详见 [docs/00-overview.md](docs/00-overview.md)。

## 技术栈

Electron + React + TypeScript · electron-vite · better-sqlite3 · zustand · openai SDK（多供应商兼容）

## 开发

```bash
git pull               # 每次开工前拉取最新
npm install            # 安装依赖
npm run rebuild        # 首次安装后必跑：将 better-sqlite3 重编译为 Electron ABI
npm run dev            # 开发模式（HMR）
npm run typecheck      # 类型检查
npm run test:db        # 数据库迁移冒烟测试
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

- [产品总览](docs/00-overview.md)
- [社区调研与选型决策](docs/01-research.md)
- [技术架构](docs/02-architecture.md)
- [开发路线图](docs/03-roadmap.md)

## 开发约定

- 每次开工前 `git pull`，收尾时构建通过后提交并 push
- 选型遵循"使用 → 迁移 → 修改 → 自己写"优先序，决策记录见 docs/01-research.md
- schema 变更必须走 migration

---
规划与初始实现：claude（2026-11）
