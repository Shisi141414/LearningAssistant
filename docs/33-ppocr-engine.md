# OCR 引擎替换：PP-OCR 双引擎与语言路由（2026-11-12）

> 撰写：claude · 背景：tesseract.js 实测中文乱码+公式差（docs/01-research 第二轮调研）· 验收：typecheck/build 通过，真机识别质量待 Windows 端

## 方案

**ppu-paddle-ocr@6.7**（MIT，PP-OCRv6/v5 的 onnxruntime-node 实现）为默认引擎，tesseract 保留为备选。**按语言路由模型**（用户需求）：

| language | 模型预设 | 说明 |
|---|---|---|
| zh-en（默认） | v6-tiny | PP-OCRv6 统一模型，单模型覆盖 50+ 语言（简繁中英日+拉丁），中文准确率显著优于 tesseract |
| ja | v5-ja | 日文专用 rec |
| ko | v5-ko | 韩文专用 rec |
| latin | v5-latin | 法德西俄等拉丁/西里尔 |
| （备选引擎） | tesseract chi_sim+eng | 沿用原管线 |

## 实现

- `services/ppocr-models.ts`：预设清单（URL 硬编码，GitHub raw 镜像优先/HF 回退）、显式准备 IPC 才联网下载、原子写+SHA256 记录+大小上限（模型 96MB/词典 4MB）、状态查询。与 tesseract 语言包管理模式一致：**识别 worker 只读本地文件，不联网**
- `services/material-ocr.ts`：双引擎——PDF→canvas 渲染共用，识别调用二选一；ppocr 行分组结果（词项矩形 box+置信度）合并为行记录，包围盒转 tesseract 四点格式，confidence 0-1×100 对齐；model_json 记录引擎/预设/版本（出处可溯源）
- 派发层（materials.ts）：主进程按 language 解析 preset 并预检模型路径，路径+版本传入 worker；tesseract 分支保持原校验
- UI（MaterialOcrPanel）：引擎选择（PP-OCR 推荐/Tesseract 备选）+ 语言选择；对应模型就绪状态与下载按钮；ocrStart 携带 engine/language（security 白名单校验枚举）
- 依赖：ppu-paddle-ocr ^6.7.0 + onnxruntime-node ^1.23.2（peer，各平台 npm install 解析原生二进制；Electron 打包时需 asarUnpack，M5 批次处理）

## 明确不做（本批）

- 公式识别（OCR→LaTeX）：Pix2Text MFR Python sidecar 下一批（见 01-research §方案）
- v6-small/medium 档位选择 UI（当前固定 tiny；档案级材料可后续加"高精度"选项换 medium 模型）
- onnxruntime 的 Electron 打包配置（M5）

## 验收清单（Windows 端）

1. `npm install`（装 onnxruntime-node win32 二进制）→ `npm run typecheck && npm test`
2. 材料库 → 扫描材料 → 扫描页识别：引擎默认 PP-OCR → 下载模型（首次约 30–60MB）→ 识别之前乱码的那份材料，对比文字质量
3. 语言切日文/韩文验证路由（各自模型分别下载）
4. 切 Tesseract 引擎确认旧路径仍可用
5. 识别后按页校正、派生版本、检索与概念回链等既有管线不受影响
