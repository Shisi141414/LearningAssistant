# Pix2Text 依赖链诊断 与 双击启动入口（2026-11-12）

> 撰写：claude · 背景：用户实测报错 `ImportError: cannot import name 'resolve_model_key' from 'rapidocr.utils.model_resolver'` + 需求「双击即用的软件入口」

## 一、rapidocr 依赖链错位（用户实测踩中）

**调用链**：pix2text → cnocr（新版）→ `rapidocr>=3.9.1`。`resolve_model_key` 是 rapidocr 3.9.x 引入的 API；用户机器（Python 3.14，pip 解析出旧版 rapidocr）上 cnocr 新代码 import 旧 rapidocr 即崩——「装好了 pix2text，一识别就 ImportError」。

社区调研结论（PyPI 元数据核实）：pix2text 1.1.7 自身不依赖 rapidocr；cnocr 最新版 `requires_dist` 含 `cnstd>=1.2.8` 与 `rapidocr>=3.9.1`；rapidocr 最新 3.10.0（2026-10），纯 Python wheel（py3-none-any，requires_python >=3.8），Python 3.14 可装。

**用户侧修复**：`python -m pip install -U rapidocr`（可加清华源）。

**代码侧（本批）——让 app 自己诊断依赖链错位**，不靠用户贴报错：

- `pix2textStatus` 一次 spawn 查全链元数据（importlib.metadata，毫秒级）：pix2text / cnocr / rapidocr 三包版本
- 新增 `issue` 字段：rapidocr < 3.9.1 → 「rapidocr 版本过旧（x.y.z，需 ≥3.9.1）…请执行 python -m pip install -U rapidocr」；缺 cnocr/rapidocr → force-reinstall 指引
- `startMaterialOcr` 入口与 `ensurePix2TextSidecar` 都检查 issue 并抛可操作报错；UI 引导框优先显示 issue

注：rapidocr ≥3.9.1 是 cnocr 的声明约束，硬编码于本仓库并在代码注释记录来源——若 cnocr 未来改约束需同步（依赖链检查随 pix2textStatus 每次检测刷新，版本阈值只需此处一处调整）。

**遗留疑问**：用户提到「其他引擎解析似乎也有这个问题」——ppocr/tesseract 为纯 Node 引擎（onnxruntime-node / tesseract.js），不可能产生 Python ImportError；若确实失败，是另一类问题（最可能 onnxruntime-node 二进制或模型路径），待用户提供具体报错文案再定位。

## 二、双击启动入口

现状：日常使用要开终端跑 `npm run dev`（开发模式，带 DevTools/HMR）。用户要「双击即用」。

**方案取舍**：正式打包（electron-builder NSIS，`build:win` 脚本已备）是 M5 的事——原生模块（better-sqlite3/sherpa-onnx/onnxruntime）的 asarUnpack、图标、安装器体验需专门一批处理。当前阶段用**启动器脚本**走已构建产物，即时可用：

- `启动学习助手.bat`（仓库根）：npm 检查 → `npm run build`（每次构建，防多 AI 协作下的陈旧产物——比省 10 秒更重要）→ `start electron .` 以生产模式启动（无 DevTools、渲染层走 file: 加载，主进程已按此分支处理 CSP/trustedRenderer）→ 控制台自动关闭
- `创建桌面快捷方式.bat`（一次性）：PowerShell WScript.Shell 在桌面建 .lnk（图标暂用 electron.exe，M5 换正式图标）
- 两个脚本均无 goto/label（LF 行尾下 cmd 解析安全；.gitattributes 已有 `*.bat eol=crlf`，checkout 后自动 CRLF）

设计说明：控制台窗口在构建阶段保留（进度可见、失败可截图），启动后即退出；不选「快捷方式直指 electron.exe」是因为会跳过构建、跑旧代码。

## 验证与验收

typecheck / build 通过。Windows 验收：

1. 双击 `启动学习助手.bat`：先见构建输出，随后应用窗口打开、控制台消失；功能与 dev 模式一致（笔记/课堂/材料数据同库——userData 路径不变）
2. 双击 `创建桌面快捷方式.bat` 后，桌面出现「学习助手」；以后双击它即可
3. Pix2Text：按 UI 提示执行 `python -m pip install -U rapidocr -i https://pypi.tuna.tsinghua.edu.cn/simple` 后点「重新检测」，状态应转绿并可识别
