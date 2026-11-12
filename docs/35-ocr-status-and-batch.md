# OCR 状态误报修复与批量页数放开（2026-11-12）

> 撰写：claude · 背景：用户反馈「已下载模型包但显示未就绪」+「删掉每次最多 20 页限制，改为显示预估转换时间」

## 问题一：已安装/已下载但显示未就绪

三处根因，全部修复：

1. **Pix2Text 检测方式必然误报**（最主要）：`pix2textStatus` 原用 `python -c "import pix2text"` 探测——该 import 会连 torch 一起加载，冷启动 30–60 秒，而探测超时 20 秒，超时即判"未安装"。**装好了也显示未就绪**，且运行按钮被客户端 `engineReady` 硬闸，形成死锁。
   修复：改查 `importlib.metadata`（读包元数据，毫秒级、不加载 torch）；
2. **解释器解析**：Windows 上 `python` 可能是商店占位符或不存在，依次探测 `python → py → python3`，命中后缓存供 sidecar 复用（保证检测、sidecar、pip 指向同一解释器）；
3. **pip 与 python 环境错位**（用户侧常见）：裸 `pip` 可能装进另一个环境。指引文案改为 `python -m pip install pix2text ...`，从根上保证一致。

配套调整：**Pix2Text 不再用客户端检测硬闸运行按钮**（检测是参考信号，曾误报）——服务端 `startMaterialOcr` 入口做权威检查并返回可操作报错；PP-OCR/Tesseract 仍闸（模型文件确定必需且应用内可下载）。

PP-OCR 侧顺带增强可诊断性：`ppocrStatus` 的 preset 增加缺失文件明细 `missing: string[]`（未下载或校验失败的文件名），UI 未就绪时显示「缺文件：X、Y」——语言路由切换预设、存储位置迁移、手工放文件缺校验记录这几类情况从此可分辨。

## 问题二：每次最多 20 页

20 页上限的本质是 pump 里**写死 10 分钟 OCR 超时**的保护性约束。放开方案（保护职能保留，体验改为预估）：

- `validateOcrRange` / `recognizeMaterial` / UI 输入框：移除页数上限（仍要求连续、≤3000 页、文档范围内）
- **超时自适应**：`基线 + 页数 × 每页耗时`——ppocr 5s/页、tesseract 9s/页、pix2text 30s/页 + 6 分钟基线（首次模型下载）；下限 10 分钟、**上限 2 小时**（挂死的 sidecar/网络不能无限占用解析队列）。超时报错带具体分钟数与分批建议
- **UI 显示预估用时**（取代"每次最多 20 页"）：按引擎与页数估算——ppocr 每页 2–5 秒、tesseract 5–10 秒、pix2text 首次另含模型下载加载 3–5 分钟 + 每页 15–40 秒。经验值来自社区 CPU 推理数据，标注"约"

## 验证

typecheck / build 通过；`test:reliability` 134 项全绿（office-conversion 的进程树清理测试在 VM 间歇性失败 1/3 次——真实 spawn 时序问题，与本次改动无关，Windows 端为权威环境，需留意是否也 flaky）。

## Windows 验收

1. 材料库 → OCR 面板：Pix2Text 引擎装好环境后应显示「Pix2Text 已就绪（Python 3.x（python）· pix2text x.x）」；若 pip 装过仍报未安装，按指引用 `python -m pip install pix2text -i https://pypi.tuna.tsinghua.edu.cn/simple` 重装
2. 页码范围输入超出 20 页（如 1–40）应可执行；范围下方显示预估用时；长任务超时提示带具体分钟数
3. PP-OCR 模型未就绪时应显示具体缺哪些文件
