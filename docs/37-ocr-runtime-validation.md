# OCR 中断恢复与运行验证

撰写：**codex** · 2026-11-13

## 恢复基线

昨晚交接保存在本地 `out-tmp/nightly-close-2026-11-12.md`。今早恢复时，工作区干净，`main` 和远端均已包含 `b963729`（昨晚交接后，5 个增量提交已进入远端）。先完成快进拉取，再复核这些增量，不把旧基线 `499a68c` 的检查结果当作新代码的运行证据。

本批不改数据库结构，不修改教材原件、已有用户数据库或全局 Python 安装。测试使用独立数据目录，模型与临时依赖均不进入 Git。

## 已修复的问题

1. **默认 PP-OCR 无法启动。** 锁定的 `ppu-paddle-ocr 6.7.0` 不导出 `package.json` 子路径，旧代码在读取版本时抛出 `ERR_PACKAGE_PATH_NOT_EXPORTED`。现在从公开入口定位同目录的元数据，实际任务验证版本记录可用。
2. **模型准备和读取。** 按上游区分模型的 Git LFS 媒体地址与字典的普通 raw 地址；拒绝 LFS 指针、HTML 错误页、空文件与超限内容。队列真正开始时再核对本地摘要，防止排队期间文件损坏仍被使用。摘要用于本地完整性检查，尚不是上游签名或固定发布摘要。
3. **输入字节与引擎归属。** 只传 PNG 的有效字节，避免 Buffer 的底层内存包含额外内容；缺少所选引擎配置时明确失败。拉丁字母模型的说明移除了未经支持的俄文承诺。
4. **公式结果被丢弃。** Pix2Text 默认返回字符串，旧代码按字典列表遍历，可能产生空结果。现在复用上游 `TextFormulaOCR.from_config()` 与 `recognize(..., return_text=False)`，不额外加载本批不需要的版面模型。支持上游 `embedding` 行内公式类型；分数取自模型返回值，移除固定的 88/90 分。
5. **识别服务生命周期。** 健康探测只查包元数据；推理加锁串行执行；并发启动复用一个进程。启动超时结束尚未登记端口的子进程，任务运行期间不参与五分钟空闲回收；取消、失败和应用退出停止相应服务，清理计时器。
6. **启动入口。** 启动脚本清除继承的 Electron 调试环境变量，防止误进 Node 模式或打开遗留开发地址。快捷方式脚本通过 PowerShell 语法检查，UTF-8 BOM 与外层批处理的纯 ASCII 编码均核对通过。本批没有重新创建或覆盖用户桌面快捷方式，未把静态检查当作双击验收。

## 开源依据与依赖边界

继续直接使用现有开源引擎，只修适配层，不自写文字或公式识别模型。核对了安装版本的源码、[PP-OCR 上游说明](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr/blob/main/README.md)、[Pix2Text 使用说明](https://github.com/breezedeus/Pix2Text/blob/main/docs/usage.md)、[CnSTD 发布记录](https://github.com/breezedeus/CnSTD/releases) 和 [RapidOCR 发布记录](https://github.com/RapidAI/RapidOCR/releases)，并检索相关社区问题。

本机 `Python 3.14.8 / Pix2Text 1.1.7 / CnSTD 1.2.8 / RapidOCR 3.10.0` 实际导入报错：`resolve_model_key` 已从 RapidOCR 对应模块移除。旧指引中的“无条件升级 rapidocr”会碰到新的不兼容组合，不能继续采用。界面现在显示已确认的冲突；“包已安装”也不再等同于“推理环境已验证”。

在忽略目录中解包 RapidOCR 3.9.1，仅给一次子进程设置 `PYTHONPATH` 后，真实 `from pix2text import TextFormulaOCR` 成功。它证明这组依赖能够导入，**尚未证明公式模型下载、加载或真实教材公式识别成功**。未降级系统包，未把临时覆盖设置写入应用配置；下一批应建立独立 Python 环境，再跑真实公式样例。

## 验证结果

| 范围 | 结果与证据 |
| --- | --- |
| 完整回归 | `npm test` 通过；142 项逻辑/协议检查，无跳过；包含真实 Electron 的材料、笔记、PDF、课堂、文档包、项目和日程回归。日志 `out-tmp/ocr-fixed-full.log` |
| 类型与构建 | `npm run typecheck`、`npm run build` 通过；完整回归也重新构建。日志 `out-tmp/ocr-fixed-types.log`、`out-tmp/ocr-fix-build.log` |
| PP-OCR 实际推理 | 使用已有本地 v6-tiny 模型，在独立数据目录导入纯图像三页夹具和用户工程热力学 PDF；第 26–27 页实际识别、文字检索、学习文档准备及概念反向引用通过。两页识别约 3.38 秒，仅为本机该样例耗时。日志 `out-tmp/ppocr-native.log` |
| Tesseract 回归 | 同一夹具和教材页范围通过，两页约 5.42 秒；不据此宣称整体速度或准确率优势。日志 `out-tmp/tesseract-native.log` |
| 数据与恢复 | 两种文字引擎均验证原件摘要不变、旧课堂引用保留、人工校正版独立保存、空白页、取消重试和真实应用重启后继续任务 |
| 公式适配协议 | 实际 Python HTTP 子进程配合伪识别器，验证懒导入、结构化参数、公式类型/坐标/分数、并发串行和无效图片报错；这是协议验收，不是模型质量验收。日志 `out-tmp/pix2text-protocol.log` |
| 生命周期 | 模拟 Python 子进程和时钟，验证重复启动、长任务保活、释放后回收、启动超时清理及版本冲突提示。日志 `out-tmp/pix2text-lifecycle.log` |
| Python 导入诊断 | 原环境冲突与隔离依赖导入成功均有实测。日志 `out-tmp/pix2text-local-status.log`、`out-tmp/pix2text-import.log`、`out-tmp/pix2text-compat-import.log` |

运行完整协议验收时设置 `OCR_TEST_PYTHON` 为测试用 Python 的路径；需要 Pillow。未设置时，该项明确标为跳过，常规检查不会自行安装 Python 或下载识别模型。真实文字 OCR 的配置约定见 `scripts/test-ocr.cjs`：不填 `engine` 默认测试 Tesseract；`engine: "ppocr"` 时 `modelDirectory` 指向本地 v6-tiny 模型目录。配置、真实教材路径和日志保留在本机忽略目录。

## 学习要点与下一步

类型检查只能确认接口形状，无法发现包导出限制、Python 依赖缺失或实际模型返回值。这里采用三层验证：逻辑检查约束数据，协议检查约束跨进程适配，真实推理检查验证整个导入链路。测试覆盖的范围必须与交付声明一致。

下一批优先完成独立公式识别环境与真实教材公式验收；再扩展日文、韩文、拉丁字母模型的真实样例，以及长篇教材与复杂版面的质量对照。本批不宣称这些已完成，也不宣称识别分数等于正确率。

本机统一收尾规则继续生效：北京时间周日至周四 23:50 停止新任务，保存与交接，23:55 前安全结束自有可中止任务；不更改关机设置。
