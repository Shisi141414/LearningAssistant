# 公式识别：Pix2Text Python sidecar 接入 OCR 管线（2026-11-12）

> 撰写：claude · 背景：PP-OCR 批次（docs/33）后文字质量已改善，但数学公式识别效果不好（用户反馈）· 方案：docs/01-research 第二轮调研结论——Pix2Text（MIT，Mathpix 开源替代，内置 MFR 公式识别输出 LaTeX）

## 为什么是 Python sidecar

Pix2Text 依赖 PyTorch 生态（公式识别 MFR 模型 + 文字识别），没有可用的 Node 绑定；转写 ONNX 工程量大且模型链路难维护。Python sidecar 是社区常见的混合架构（类似 llama.cpp server / jupyter kernel 的做法）：

- 主进程把**内嵌 Python 脚本**写到 userData/sidecar/，spawn `python` 起常驻 HTTP 服务（仅绑 127.0.0.1 随机端口，stdout 首行回报端口号）
- OCR worker 线程直接 POST 整页 PNG（base64）；主进程负责生命周期
- 模型在**首个识别请求懒加载**（首次含约 200 MiB 下载，Pix2Text 自己缓存到用户目录），不预热
- 空闲 5 分钟自动回收；before-quit 强杀

用户前置：本机 Python 3.8+ 且 `pip install pix2text`。UI 提供检测与清华源安装指引。**不满足时引擎不可选，不阻塞其它引擎**——离线优先原则不破坏。

## 实现

- `services/pix2text.ts`（新增）：SIDECAR_PY 内嵌脚本（ThreadingHTTPServer，/ping 健康、/recognize 识别，position 四点转矩形）；`pix2textStatus()` 检测 python/pix2text 包（spawn `python -c` 探测，不动模型）；`ensurePix2TextSidecar()` 幂等启动+健康检查；`stopPix2TextSidecar()`；空闲回收计时器。配置键 `p2t.pythonPath`（自定义解释器，预留）
- `services/material-ocr.ts`：`recognizeMaterial` 增加 p2tBaseUrl 参数；`recognizeByPix2Text()`——返回块（text/embedded/isolated 三类）按 **y 中心聚类成行**（rowGap=行高中位数×0.6），行内按 x 排序拼接：
  - isolated（独立公式块，行内唯一）→ 独立 `$$latex$$` 行
  - embedded（行内公式）→ `$latex$` 与文字同线拼接
  - 行记录 bbox 取行包围盒（四点格式对齐 tesseract 管线）
  - 首请求超时 300s（模型下载+加载），后续页秒级
- 派发层（materials.ts）：`engine === 'pix2text'` 分支在主进程 `ensurePix2TextSidecar()`（worker 只发回环 HTTP，不做进程管理）；modelJson 记 `{engine:'pix2text', source:'python-sidecar', language:'zh-en+latex'}` 溯源
- **修正 `startMaterialOcr` 前置检查**：原无条件检查 tesseract 语言包就绪，对 ppocr/pix2text 是错误前置（ppocr 批次遗留）。现按引擎分流：tesseract→语言包；pix2text→python+pip 包；ppocr→对应语言 preset 就绪。入口直接报错，好过排队后失败
- 通道：`MaterialsPix2textStatus`（ipc-channels/security/materials.ipc/preload 四处登记）；`MaterialsOcrStart` 的 engine 枚举加 'pix2text'；before-quit 加 `stopPix2TextSidecar()`
- UI（MaterialOcrPanel）：引擎下拉第三项「文字+公式（Pix2Text，公式转 LaTeX）」；Pix2Text 不适用语言选择（默认中英+公式）；未就绪时给分步指引（装 Python→勾 PATH→pip 装 pix2text→重新检测），首次识别慢的说明；`.ocr-p2t-guide` 样式

## 授人以渔：sidecar 模式的取舍

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Python sidecar（本批） | 完整 Pix2Text 能力；模型自动管理；升级跟 pip | 需用户装 Python；进程管理复杂度 | ✅ 当前最优 |
| ONNX 转写进 Node | 无 Python 依赖；与 ppocr 引擎同栈 | MFR 模型无官方 onnx；转写维护成本高 | ❌ |
| Mathpix API | 质量天花板 | 云端收费；教育材料隐私 | 备选，未来作为云选项 |

进程管理要点（可复用的模式）：stdout 约定端口握手（`{"port":N}`）；启动超时与 stderr Traceback 即失败；`child.on('exit')` 清引用防僵尸句柄；幂等 ensure（并发请求复用同一实例）；空闲回收（sidecar 占内存数百 MB，不该常驻）。

## 明确不做（本批）

- Mathpix 云端引擎选项（将来 API 配置页成熟后加，走用户自己的 key）
- Pix2Text 的 languages 自定义（默认中英+公式已覆盖主场景；`p2t.pythonPath` 已预留自定义口）
- sidecar 的 Python venv 自动管理（检测失败时指引手动装；自动 venv 是打包阶段 M5 的事）

## 验收清单（Windows 端）

1. `npm install` → `npm run typecheck` → `npm test`
2. 本机装 Python 3.8+（勾 Add to PATH）→ `pip install pix2text -i https://pypi.tuna.tsinghua.edu.cn/simple`
3. 材料库 → 扫描材料 → 引擎选「文字+公式（Pix2Text）」→ 状态应显示 Python 与 pix2text 版本；未装时显示指引
4. 识别含公式的扫描页（1-2 页试跑）：首次请求慢（模型下载 ~200MiB）属预期；结果中独立公式应成 `$$..$$` 行、行内公式 `$..$`，材料块/笔记引用后 KaTeX 应正常渲染
5. 首次识别后等 5 分钟（空闲回收），再识别应自动重启 sidecar
6. 退出应用后任务管理器无残留 python 进程
7. PP-OCR / Tesseract 引擎回归不受影响（引擎切换各自前置检查正确报错或放行）
