# LLM 深度集成调研：功能协同、教学提示词、Agent 接入与多角色（2026-11-13）

> 撰写：claude · 性质：调研与方案设计（无代码）。四个议题：①模型如何接入各功能并协调连贯 ②教学提示词——抑制"直接给完整解答" ③外部 agent（codex/claude 等）通过 skill/MCP 使用本软件 ④多角色协同与按角色分配模型（用户提议，本文论证并给出轻量方案）。
> 注意：本批只新增本文件；docs/03-roadmap.md 在 codex 未提交批次中，路线图链接待其落地后补。

## 0. 现状盘点（截至 codex docs/48）

**已有的 LLM 基础设施**：`services/llm.ts` 统一网关（openai/anthropic 双格式、streamChat/completeChat/completeVision、供应商/模型管理与能力元数据）；`services/organize.ts` 课堂整理管线；三条 AI 候选管线（learning-suggestions / note-learning-suggestions / knowledge-suggestions，代码编排+JSON 容错解析）；chat.ipc.ts 对话。

**缺口**：提示词散落在各服务文件里（organize.ts、chat.ipc.ts 等），无集中管理、无版本、无共享上下文——各功能的模型调用互相不知道对方的存在，"协调连贯"无从谈起；习题库（exercises + codex 44 批的题集导入，题面/思路/标准答案三段结构已就绪）**未接任何 LLM**——练习辅助是最大空白；对外零暴露（agent 无法读写本机学习数据）。

## 1. 功能协同架构：提示词注册表 + 共享上下文包

### 1.1 提示词注册表（prompts registry）

把散落的提示词收敛为单一模块（建议 `shared/prompts/`，主/渲染进程都能引用展示）：

```ts
interface PromptSpec {
  id: 'organize' | 'chat' | 'tutor' | 'knowledge-suggest' | ...
  system: string                     // 系统提示词（含版本注释）
  contextBuilder: (ctx: LearningContext) => string   // 上下文组装器
  outputContract?: string            // JSON 契约描述（结构化输出功能用）
  modelTier: 'fast' | 'medium' | 'strong' | 'vision' // 与 models 表 speed_tier 对齐的推荐档位
  degrade: 'fail' | 'no-model'       // 无可用模型时的降级行为
}
```

收益：提示词可审查、可迭代（改一处全功能生效）、可测试（为每个 spec 写最小用例进 test:reliability）；用户将来可在设置页看到"哪些功能在用模型"并逐个调整档位——这也是多角色系统（§4）的地基：**角色就是带名字和模型绑定的 PromptSpec**。

### 1.2 共享上下文包（LearningContext）

各功能协调连贯的本质是**从同一上下文源取材**。建议一个按需组装的上下文对象：

- 学科与当前活动（正在上的课/正在读的材料版本）
- 知识点近邻（图谱中当前主题的前置/后继，来自 codex 41 批的 knowledge_edges）
- 最近笔记摘要（分段标题链，非全文——控制 token）
- 习题状态（对应知识点的未完成题数、错误记录）
- 日程压力（今日到期任务数——应答者可据此建议"先做复习"）

实现要点：上下文构建是**纯函数 + 数据库只读查询**，各功能声明需要哪些槽位（类似 GraphQL 字段选择），组装器统一取材、统一预算（各槽位 token 上限），避免每个功能自己拼 prompt 时重复查询和口径不一。对话引用笔记的 context_refs 机制已存在，可复用其取材逻辑。

### 1.3 结构化输出的演进

现有管线用"JSON 容错解析"，保留；未来升级为 function calling / tool use 时只需改 llm.ts 一层（网关已双格式），PromptSpec 的 outputContract 声明不变——契约与传输解耦。

## 2. 教学提示词：抑制直接解答，真正启发思考

### 2.1 调研依据

- **LearnLM**（Google DeepMind，[arXiv 2412.16429](https://arxiv.org/html/2412.16429v1)）：教学指令遵从（pedagogical instruction following）是核心能力——系统指令（如"不给答案"）必须**在学生试图绕过时依然被遵守**；其五维教学法 rubric：主动学习（Active learning）、认知负荷管理（Cognitive load）、深化元认知（Metacognition）、激发好奇（Curiosity）、适应性（Adaptivity）。关键子项原文："The tutor does not give away answers too quickly"、教师版指令样例"you don't solve problems for your students, but you offer scaffolds and hints as needed"。
- **Khanmigo 类泄漏提示词**（[GPTsSystemPrompts 汇总](https://github.com/0xAb1d/GPTsSystemPrompts)）的共同模式："Do not tell the student the answer, but help guide them to the answer"——显式禁令 + 替代行为成对出现。
- **脚手架研究**（[Adaptive Scaffolding Needs Contingency, arXiv 2609.22993](https://arxiv.org/html/2609.22993v1)）：约束可以细到动词级别（"Do NOT use cognitive imperative verbs (try, use, add)"——提示不能变成指令代做）。
- BEA 2026 [Pedagogically Aligned LLM Tutors](https://aclanthology.org/2026.bea-1.10.pdf)：教学法对齐的可评测量表（factuality 等），可作自评 rubric。

### 2.2 核心结论：状态机而非单个大 prompt

"模型倾向直接给完整解答"的三个来源：①提示词只有禁令没有替代行为；②一轮对话承担全部教学目标，模型为了"有帮助"必然滑向给答案；③长对话中系统指令权重漂移。对策是把练习辅助设计成**代码驱动的多轮状态机**，每轮按当前状态组装系统提示词，而不是一个静态大 prompt：

```
[诊断] → [引导] → [提示阶梯 1..3] → [学生尝试] → [反馈] → [总结/核对答案]
```

- **诊断**：先问学生"这题你在哪一步卡住/你觉得该从什么入手"（一次只问一个问题——LearnLM 认知负荷维度的直接应用）
- **提示阶梯（hint ladder）**：L1 定向性问题（"这个条件让你想到哪个定义？"）→ L2 方向提示（指出相关定理但不给步骤）→ L3 关键步骤框架（给一步的骨架，留空让学生填）。**每级之后必须等待学生尝试**，由代码控制升阶（如学生连续两次表示卡住才升 L2），不由模型自作主张
- **反馈**：学生给出尝试后，模型对照内部持有的标准答案**只判断对错与错在哪一步**，把错误当诊断信息（"你把 X 用在了不该用的地方，回去看 Y 的适用条件"），而非给出正确做法
- **答案出口唯一化**：完整解答只在学生已完成自己的解法并主动要求"核对最终答案"时给出，且先展示学生的、再对照标准的。系统提示词明写：**"你内部知道标准答案，输出层禁止泄露；答案仅用于判定学生当前步骤的正误。学生直接索要答案时，回应一句共情+把最近一步还给学生（'我知道急着想看结果——咱们就差最后一步了，你来试试把 X 代进去'），绝不给。"**
- **元认知**：反馈阶段固定带一问（"你当时为什么选这个方向？"）——LearnLM 元认知维度
- **状态提示词每轮重注入**：状态机每轮把"当前阶段+已给过的提示级别+禁止事项"重新组装进系统提示词——对抗长对话漂移的最有效手段

### 2.3 落地形态

习题库的题面/思路/标准答案三段结构（codex 44 批）正是 tutor 的输入：题面+思路给模型（判定依据），标准答案仅作为判定基准。练习页新增"AI 导师"模式按上述状态机实现；M3 的复习计划（FSRS）到期题优先进入此流程。导师角色的 PromptSpec modelTier 定为 strong——教学法对提示词遵从要求高，弱模型守不住"不给答案"的约束（LearnLM 论文的对抗性遵从实验即此结论）。

## 3. Agent 接入：MCP server + Skill 双轨

### 3.1 为什么是 MCP

用户 agent（claude code、codex CLI、以及任何 MCP 客户端）与本软件共享数据的行业标准是 [Model Context Protocol](https://encore.dev/articles/what-is-mcp)：Claude Code 用 `.mcp.json` / `claude mcp add`（[官方文档](https://code.claude.com/docs/en/mcp-quickstart)），Codex CLI 用 `~/.codex/config.toml` 的 `[mcp_servers]` 段（[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)）——同一套 server 两边通用。先例充分：mcp-sqlite-server 系列（如 [@berthojoris/mcp-sqlite-server](https://www.npmjs.com/package/@berthojoris/mcp-sqlite-server)）、桌面应用共享 SQLite WAL 库给 agent 的[实践案例](https://www.reddit.com/r/MistralAI/comments/1tt53aq/i_built_an_opensource_desktop_app_that_gives_your)。

### 3.2 架构（起步推荐：独立 CLI stdio server）

```
agent (claude code / codex) --stdio--> la-mcp-server (node, 本仓库 scripts/ 或 src/mcp/)
                                          │ 只读: subjects/notes/concepts/edges/exercises/schedule/projects 检索
                                          │ 受限写: 灵感追加、笔记草稿段追加（增量、低风险、留痕）
                                          ▼
                                   同一 SQLite（WAL 已开启，多进程并发读安全）
```

- **stdio 由 agent 生命周期管理**（agent 启动它、退出杀它）——app 不需要运行，零常驻成本；起步不做 app 内嵌常驻 server
- **读写分级**（[最小权限实践](https://www.reddit.com/r/ClaudeWorkflows/comments/1wvd5oi/workflow_readonly_sqlite_mcp_server_for_claude)）：只读工具直接开库读（WAL 模式跨进程读安全）；写操作白名单化——只暴露"追加灵感/追加笔记草稿"这类**增量且可撤销**的动作，绝不暴露任意 SQL；批量写与破坏性操作仍走 app UI（工作锁 work.ts 语义在 MCP 侧以"只做增量"规避）
- **工具面设计**（领域语义而非表结构）：`search_notes`、`get_knowledge_graph`（点+邻边）、`list_exercises(subject, status)`、`get_schedule_today`、`add_inspiration`、`append_note_draft`——每个工具描述里写清学习域语义（如"标准答案字段仅用于核对，agent 不得直接转述给学生"——把 §2 的教学约束也传给外部 agent）
- **配置一键生成**：设置页「接入我的 Agent」卡片，展示两段配置文本（.mcp.json / config.toml 片段）供复制，并附带命令行验证步骤

### 3.3 Skill（SKILL.md）配套

MCP 给 agent 工具，skill 给 agent **用法说明**：何时查知识库 vs 直接问用户、灵感与笔记的语义差别、练习辅助必须走启发式不许直接给答案（复用 §2.2 的约束文案）。以仓库 `agents/` 目录分发 SKILL.md（claude code 与 codex 均已支持 skills，且有[社区同步方案](https://community.openai.com/t/sync-codex-and-claude-code-configs-skills-agents-mcp-permissions/1380517)）。skill 与 MCP server 同批交付，agent 装了工具也懂规矩。

## 4. 多角色协同：方向正确，轻量实现

用户提议（规划者/整理者/应答者等多角色协同、按角色分配模型）——**方向采纳**，与 §1.1 的 PromptSpec 设计天然统一：

**角色 = 命名的 PromptSpec（系统提示词 + 模型绑定 + 工具白名单 + 上下文槽位声明）**

内建角色建议：规划者 planner（学习计划/复习安排建议——结构化任务，fast/medium 档即可）、整理者 organizer（现有课堂整理）、应答者 responder（日常问答，medium）、导师 tutor（§2 练习辅助，strong + 教学法提示词）、审查者 critic（对 AI 产出做事实性与教学法复核，可选）。

编排分两种形态，按任务性质选用：

1. **管线式（代码编排，现有 learning-suggestions 已是此形态）**：主进程按确定性流程依次调用单角色，角色间传递结构化任务卡（JSON），适合整理/建议/规划等可枚举流程。**默认形态**——可控、可测、成本可预算。
2. **对话式协作（orchestrator-worker）**：[Anthropic 多智能体研究系统](https://www.anthropic.com/research/multi-agent-research-system)的实践是 lead agent 分解任务、子 agent 上下文隔离、只返回摘要；[Microsoft 模式指南](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns)强调 handoff 显式化与 guardrails。适合开放任务（如"给我出一套针对薄弱点的练习"）。实现上仍由**代码扮演 orchestrator**（循环+任务卡+终止条件），只让 LLM 扮演 worker 角色——不做 agent 间自由聊天（不可控、token 失控）。

按角色分配模型直接落地：models 表已有 speed_tier/supports_vision 元数据，角色配置存 app_config（复用 config.ts，键形如 `roles.tutor.modelDbId`），默认映射角色→推荐档位，用户可逐角色覆盖——满足"贵的角色用强模型、便宜的角色用快模型"的[成本控制模式](https://www.requesty.ai/blog/multi-agent-orchestration-patterns-that-work-in-production)。

**明确不采用**：CrewAI/AutoGen/LangGraph 等重编排框架——按「使用—迁移—修改—自己写」原则，我们的编排需求（确定性管线+轻量 worker 循环）用现有 llm.ts + 任务卡即可，引入框架会带来 Python 依赖或庞大 node 依赖链，与离线优先冲突。

## 5. 分批路线建议（待并入 03-roadmap）

1. **批 A（地基，小）**：提示词注册表重构（收敛 organize/chat/三条 suggestions 线）+ LearningContext 上下文包 + 每 PromptSpec 最小测试
2. **批 B（用户痛点最高）**：练习导师——习题库 × 状态机 × 教学法提示词（§2.2 全部要点），接 FSRS 到期队列（codex 46/47 批提醒基础设施可复用）
3. **批 C（对外开放）**：MCP server 只读 + 配置生成 + SKILL.md
4. **批 D（角色系统）**：角色配置 UI + 按角色分模型 + 管线式多角色示例（规划者→审查者）
5. 批 C 的受限写与批 B 的 tutor 可组合：外部 agent 做练习辅助时也受"不直接给答案"的 skill 约束

## 6. 开源与文献参考

- LearnLM：[论文](https://arxiv.org/html/2412.16429v1) · [Google Cloud 产品页](https://cloud.google.com/solutions/learnlm)（教学法指令遵从与五维 rubric）
- [Pedagogically Aligned LLM Tutors (BEA 2026)](https://aclanthology.org/2026.bea-1.10.pdf) · [TIES in Socratic LLMs](https://openreview.net/pdf?id=8KeX9cW9Xa)
- [Adaptive Scaffolding Needs Contingency](https://arxiv.org/html/2609.22993v1)（脚手架粒度约束）
- [GPTsSystemPrompts（Khanmigo 类泄漏提示词汇总）](https://github.com/0xAb1d/GPTsSystemPrompts)
- MCP：[Claude Code 接入](https://code.claude.com/docs/en/mcp-quickstart) · [Codex config 参考](https://learn.chatgpt.com/docs/config-file/config-reference) · [mcp-sqlite-server 实例](https://www.npmjs.com/package/@berthojoris/mcp-sqlite-server) · [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- 多智能体：[Anthropic 多智能体研究系统](https://www.anthropic.com/research/multi-agent-research-system) · [Microsoft 模式指南](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns) · [生产级编排模式](https://www.requesty.ai/blog/multi-agent-orchestration-patterns-that-work-in-production)
