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
