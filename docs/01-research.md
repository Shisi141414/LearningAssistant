# 社区调研与选型决策记录

> 调研日期：2026-11-10 · 调研方式：GitHub / 官方文档 / 技术社区（Reddit、知乎、腾讯云社区等）
> 决策原则：复杂功能先查 GitHub 和社区，按 **直接使用 → 迁移 → 修改 → 自己写** 选择方案 · 初稿：claude · R1 补充：codex

2026-11-11 R1 复查：[材料库方案比较与实际验证](07-material-library.md)。首批直接接入 OfficeParser 与 PDF.js；原表 MinerU 作为复杂扫描件后续候选，不再表示所有文件都通过它解析。

## 0. 决策总表

| 领域 | 决策 | 采纳方案 | 决策层级 | 状态 |
|------|------|---------|---------|------|
| 脚手架 | Electron + React + TS | electron-vite + electron-builder | 使用 | ✅ 已定 |
| 数据库 | SQLite | better-sqlite3 + @electron/rebuild | 使用 | ✅ 已定 |
| 状态管理 | - | zustand | 使用 | ✅ 已定 |
| 编辑器 | 块级双视图 | BlockNote（基于 ProseMirror/TipTap 内核） | 使用+修改 | ✅ 已定 |
| 知识图谱 | 交互式图 | @xyflow/react (React Flow) | 使用 | ✅ 已定 |
| LLM 调用 | 兼容多供应商 | openai SDK 换 baseURL + 主进程 IPC 代理 | 使用 | ✅ 已定 |
| API 配置 UI | ccswitch 风格 | 参考 farion1231/cc-switch + Cherry Studio | 迁移（借鉴设计） | ✅ 已定 |
| 实时 ASR（本地·默认） | 流式中文 | sherpa-onnx + 流式模型（transducer 系优先，见 §3.2 热词限制） | 使用 | 🔜 M1 验证 |
| 实时 ASR（云端·可选） | 流式中文 | 讯飞流式听写 WebAPI（备选：阿里云） | 使用 | 🔜 M1 验证 |
| 转写管线 | 动态修正体验 | 2-pass 架构（流式 partial + VAD 离线 final 修正，参考 cueflow/sherpa-onnx #2150） | 迁移（借鉴设计） | 🔜 M1 |
| 课后精转 | 整段音频高精度 | whisper.cpp 系（Buzz 同引擎；faster-whisper 备选） | 使用 | 🔜 M2 |
| 数学计算 | 符号推导/绘图 | SymPy + Pyodide（渲染进程 WASM，离线）；Wolfram API 作联网增强 | 使用 | 🔒 M2 调研后集成 |
| 网络学堂 | 作业 DDL | thu-learn-lib（MIT） | 使用（需验证兼容性） | 🔜 M4 |
| 遗忘曲线 | 复习调度 | ts-fsrs（open-spaced-repetition 官方） | 使用 | 🔜 M4 |
| PDF 解析 | 教材结构化 | MinerU（本地）/ pdfplumber（轻量纯文本） | 使用 | 🔜 M3 |
| 图片识别 | 板书/PPT | 直接走多模态 LLM（vision 模型） | 使用 | 🔜 M3 |

## 1. 应用框架层

### 1.1 electron-vite（vs Electron Forge + Vite 模板）
- 社区共识：Forge 官方 Vite 模板至今标记为**实验性**；electron-vite（alex8088 维护）以 DX 和 TS 优先成为 2026 主流
- 开箱即用：HMR、主/预加载/渲染三进程构建配置、TS 模板
- 打包用 electron-builder（NSIS 安装包，Windows 友好）
- 参考：electron-vite 官方 FAQ、r/electronjs 2025 工具链讨论

### 1.2 better-sqlite3 的 ABI 坑（重要）
原生模块必须针对 Electron 的 Node ABI 编译，否则启动报 `NODE_MODULE_VERSION mismatch`：
- 标准解法：`@electron/rebuild`（postinstall 自动执行）
- 注意 node-abi 需支持所用 Electron 版本，必要时升级
- 替代方案 node:sqlite（Node 22.5+ 内置）：Electron 35+ 仍需 flag 且 API 是子集，暂不采用；旧 node-sqlite3 包已废弃

### 1.3 Electron 安全模式（官方标准）
- `contextIsolation: true` + `nodeIntegration: false`
- preload 用 `contextBridge.exposeMainWorld` 暴露**类型化的最小 API 面**
- IPC 通道白名单校验；密钥只存主进程，渲染进程永不下发

## 2. AI 接入层

### 2.1 cc-switch（API 配置的参考原型）
farion1231/cc-switch：为 Claude Code 等工具一键切换 API 供应商的跨平台桌面应用。核心表单 = 供应商名 + baseURL + API Key + 上游格式（写回各 CLI 配置），支持测速与流式体检。
**借鉴**：供应商预设 + 自定义两层；添加即测试连通性。

### 2.2 Cherry Studio（Provider/Model 分离设计）
- 设置 → 模型服务 → 供应商列表；每供应商：API Key + API 地址 + 【管理】模型（从 `/v1/models` 拉取或手填）
- **借鉴**：Provider 与 Model 是两个实体；模型带能力标记（视觉/推理/工具）；内置 DeepSeek/Qwen/GLM/Kimi 预设开箱即用；一供应商多 Key 轮询（v1 不做）

### 2.3 2026 主流模型能力速查（写入模型预设库）

| 模型系 | 上下文 | 识图 | 速度档 | OpenAI 兼容 | 国内直连 |
|--------|--------|------|--------|-------------|---------|
| DeepSeek V 系列 | 128K | ❌ | 快 | ✅（另有 Anthropic 兼容） | ✅ |
| GLM（智谱）5 系列 | 128K（实测 ~35-40K 后衰减） | ✅ | 中 | ✅ | ✅ |
| Qwen 3.x Plus | 128K+ | 部分型号 ✅ | 快 | ✅（DashScope） | ✅ |
| Kimi K2.x | 256K（最长） | ❌ | 中 | ✅（OpenAI/Anthropic 双兼容） | ✅ |
| GPT 系列 | 128K~ | ✅ | 中 | ✅（官方） | ❌ 需中转 |
| Claude 系列 | 200K~ | ✅ | 中 | Anthropic 格式 | ❌ 需中转 |
| Gemini 系列 | 1M | ✅ | 快 | ✅（官方兼容层） | ❌ 需中转 |

> 预设库按此表预填，用户可在 UI 中改写（能力值会随版本演进过时，设计上必须可编辑）。

### 2.4 调用架构
- **主进程代理**：渲染进程 → IPC → 主进程 → openai SDK（baseURL 可换）→ 各供应商
  - 规避 CORS（主进程 Node 环境无 CORS 限制）
  - 密钥不进渲染进程，防 XSS/ASAR 提取泄露
- 上游格式适配器：v1 支持 OpenAI 格式（覆盖国内全部主流）+ Anthropic 格式（Claude 系）
- 模型导入：`GET {baseURL}/models`

## 3. 语音转写层（M1 落地，先定架构）

### 3.1 本地优先原则与双 Provider 架构（已确认决策）

**架构原则（用户确认，2026-11-10）：基础功能完全本地**——转写、笔记、标注、习题、复习调度全部离线可用且响应快；智能体问答、网络搜索、AI 整理等增值功能联网使用，**无网时优雅降级**（保留原文视图，联网后补整理）。

```
AsrProvider (接口：start/stop/feed/onPartial/onFinal/setHotwords?)
 ├── LocalAsrProvider（默认）—— sherpa-onnx（k2-fsa，Apache-2.0）
 │                          npm 包 sherpa-onnx-node 官方含 Electron 集成示例
 │                          流式模型：zipformer-transducer 系（支持热词）或 Paraformer（精度高、无热词）
 └── CloudAsrProvider（可选）—— 讯飞流式听写 WebAPI（动态修正，WebSocket）
                                备选：阿里云实时识别
```

### 3.2 关键限制与管线设计（第二轮调研，2026-11-10）

**热词（学科术语）限制**：sherpa-onnx 的 hotwords（Aho-Corasick 上下文偏置）**只支持 transducer 系模型**（需配 modified_beam_search 解码），Paraformer/SenseVoice 均不支持。力学专有名词（如"欧拉方程""哈密顿原理"）识别是硬需求 → M1 模型选型需在 zipformer-transducer（热词可用了精度略低）与 Paraformer（精度高但靠二遍纠错）之间实测权衡。

**2-pass 转写管线**（飞书妙记"动态修正"体验的开源实现路径，参考 cueflow 项目，sherpa-onnx 讨论 #2150）：
```
麦克风音频流 ──┬──> 流式 worker ──> partial 文本（实时上屏，低延迟）
               └──> VAD 切段 ──> 离线 worker（高精度模型重转写）──> final 文本
                                                              └──> 融合替换对应 partial（动态修正体验）
```

**中文识别质量共识**：FunASR 生态（Paraformer/SenseVoice）> faster-whisper > whisper。
**课后二次精转**：whisper.cpp 系（Buzz 同引擎，MIT，活跃维护，v1.3+ 有 Vulkan GPU 加速）。注意 Buzz 的"实时"是 VAD 分段模拟而非真流式，实时课堂场景仍以 sherpa-onnx 流式为优。
**云端备选**：讯飞有免费额度，约 ¥5-10/小时，中文效果业界标杆。

### 3.3 数学计算辅助（用户提议 Wolfram Alpha，调研后调整）

- **主路线：SymPy + Pyodide**（渲染进程加载 WASM，约 6.4MB + 首次初始化数秒，之后完全离线）。符合"基础功能本地化"原则，支持符号推导与绘图，无需 Python sidecar
- **增强路线：Wolfram Alpha API**（免费档历史为 2000 次/月，需国际网络）——作为 LLM 的 math tool，联网时可选启用
- 落点：M2 快速提问/习题库的"解答验证"辅助，届时先做技术验证

## 4. 学习管理层（M3/M4 落地，先记录结论）

### 4.1 thu-learn-lib（网络学堂）
- MIT 协议，learnX（RN App）与 thu-learn-cli 均基于它；可拉作业/DDL/文件
- ⚠️ 风险：网络学堂 2021.09 加 CSRF 验证曾致接口失效；learnX 维护放缓。**M4 动工前必须实测登录与接口可用性**（统一认证 SSO + 设备指纹注册流程繁琐）

### 4.2 ts-fsrs（遗忘曲线）
- open-spaced-repetition 官方 TS 实现，ESM/CJS 全支持，零依赖
- FSRS 基于大规模数据训练，记忆建模显著优于 Anki 的 SM-2，HN 社区公认

### 4.3 MinerU（教材 PDF 解析）
- 上海 AI Lab 开源，公式/表格/多栏处理强，输出带层级 Markdown/LaTeX
- 1.2B 小模型版 CPU 可本地跑；纯文本 PDF 用 pdfplumber 轻量方案兜底

## 5. 结论

本次调研覆盖了全部关键选型，**没有任何一项需要"自己写"**：框架层全部"使用"成熟方案，API 配置设计从 cc-switch/Cherry Studio"迁移"（借鉴设计），BlockNote 可能需要少量"修改"（自定义 block 类型）以支持双视图。风险集中在两处：better-sqlite3 的 ABI 编译（M0 内解决）与 thu-learn-lib 的现行兼容性（M4 前验证）。

## 附：关键链接

- electron-vite: https://electron-vite.org
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- BlockNote: https://github.com/TypeCellOS/BlockNote
- React Flow: https://github.com/xyflow/xyflow
- cc-switch: https://github.com/farion1231/cc-switch
- Cherry Studio: https://github.com/CherryHQ/cherry-studio
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx （nodejs-addon-examples 有 Electron 示例）
- 2-pass 转写管线讨论（cueflow）: https://github.com/k2-fsa/sherpa-onnx/discussions/2150
- sherpa-onnx 热词文档（仅 transducer 支持）: https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html
- Buzz（whisper.cpp 桌面转录，课后精转参考）: https://github.com/chidiwilliams/buzz
- Pyodide（SymPy WASM 集成）: https://pyodide.org
- Wolfram Alpha API: https://products.wolframalpha.com/api
- 飞书妙记（体验对标）: https://www.feishu.cn/product/minutes
- 讯飞流式听写: https://www.xfyun.cn/doc/asr/voicedictation/API.html
- thu-learn-lib: https://github.com/Harry-Chen/thu-learn-lib
- ts-fsrs: https://github.com/open-spaced-repetition/ts-fsrs
- MinerU: https://github.com/opendatalab/mineru
- DeepSeek API: https://api-docs.deepseek.com
- 智谱 OpenAI 兼容: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction

## OCR 与公式识别调研（2026-11-12，第二轮：实测 tesseract.js 中文乱码+公式差之后的替换方案）

**结论**：
1. **中文 OCR 换 PP-OCRv5 系**（社区共识全面碾压 Tesseract：中文手写 ~73% vs ~45% 准确率）。npm 生态已有纯 Node 集成：`ppu-paddle-ocr`（TS，Node/Bun/Deno，实测 99.22% 印刷体字符准确率）、`paddleocr`（v5+onnxruntime-node）。坑：Electron 打包后 onnxruntime 原生二进制 asar 解包与 ABI——与 sherpa-onnx/better-sqlite3 同类，已有经验可复用。→ **下一批首要工作：替换 tesseract.js**
2. **公式识别（OCR→LaTeX）用 Pix2Text MFR**（mfr-1.5，TrOCR 架构，社区评最准确开源公式模型，原生中英混排+公式一体）。集成路径：Python sidecar（自带 FastAPI HTTP server，PyInstaller onefile 随应用分发，参考 electron-python-example）；优化项：MFR onnx 导出 + onnxruntime-node 自实现自回归解码（免 Python，工作量大）
3. **MinerU 整管线不引入**：版面+公式+表格一体但重量级；我们已有切块/学习文档/公式校正管线，自组"文字 OCR + 公式模型"两段式更贴合
4. **云端可选**：Mathpix API（~$0.002/次，免费档约 20 页 PDF/月）作"高精度按钮"，符合离线优先+联网增强

链接：github.com/breezedeus/Pix2Text · npm: ppu-paddle-ocr · onnxruntime-node（官方支持 Electron）
