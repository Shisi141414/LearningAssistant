# R4 首批：项目与统一任务模型（2026-11-12）

> 撰写：claude · 依赖：无（R4 起步批次）· 验收状态：逻辑冒烟通过，真机验收待 Windows 端 `npm test`

## 范围

R4 的地基批次：项目实体、里程碑、**统一任务模型**（`tasks` 表，migration 020）。任务模型按总路线图为 R5 日程（assignment/review kind 扩展）与 R6 备忘分流（manual 收件箱）复用而设计，本批只接 `project_task` 与 `manual` 两种 kind。

## 交付

- **migration 020**：`projects`（可空 subject_id = 跨学科；status: active/paused/done/archived）、`project_milestones`（due_at/sort_order/status）、`tasks`（kind: project_task|manual；status: open/doing/blocked/done；blocked_reason 要求非空——业务层校验；due_at 截止与 planned_at 时间块分离，对应 R5 的"区分截止时间与时间块"）。
- **知识点引用**：`tasks.knowledge_refs_json`（`{concept_id, why}[]`），服务层校验知识点存在性防悬挂引用——实现路线图"任务引用知识点并展示学习/应用路径"的基础；详情页显示引用计数，编辑入口下一批接知识选择器。
- **服务层** `services/projects.ts`：CRUD + `projectDetail` 聚合（里程碑带各自任务统计）+ 手动任务收件箱 `listManualTasks`。约束：里程碑任务必须挂项目且里程碑属于该项目；阻塞状态必须填原因；项目删除级联里程碑与项目任务，手动任务不受影响。
- **IPC**（12 通道）+ security.ts 载荷白名单（项目/里程碑/任务输入的标题长度、状态枚举、知识引用数组上限 32 等）。
- **页面**：项目页（列表+创建+统计）、项目详情（目标卡、里程碑勾选、任务四状态分组列、阻塞标记带原因、状态流转）。
- **冒烟**：smoke-db 第 9 组断言（三表创建、kind CHECK 拒绝未登记类型、删里程碑任务退回项目级、删项目级联与手动任务保留）。

## 明确不做（本批）

- 版本化项目文档（计划书修订历史）——等统一学习文档格式接入项目描述。
- 任务知识引用的编辑 UI（选择器）与"学习/应用路径"展示——下一批接知识页联动。
- R5 的 planned_at 时间块编辑、assignment/review kind、自动排程。
- 跨学科项目"双向回链验收"（路线图 R4 验收项）——需要知识引用 UI 就绪后在真实项目里验收。

## 验收清单（Windows 端）

1. `npm run test:db`（含第 9 组新断言）
2. 应用内：新建跨学科项目 → 加里程碑 → 加任务（挂/不挂里程碑）→ 状态流转 → 标阻塞（验证原因必填）→ 删项目验证级联
