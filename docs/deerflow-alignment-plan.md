# mini-DeepResearch 对齐 DeerFlow 2.0 技术方案

> 参照基准：`/Users/yokotu/code/agent/deer-flow`（DeerFlow 2.0，Python 后端 + Next.js 前端）
> 本文目标：系统性完善 mini-DeepResearch 的 **Agent 设置** 与 **消息流/事件流处理**，先给出差距分析与改进方案，再据此逐项落地代码。

---

## 1. 结论先行

mini-DeepResearch 与 DeerFlow 2.0 的**整体形态已经一致**：二者都是「单一 lead-agent（LangGraph ReAct）+ `task` 工具委派 general-purpose subagent」，没有 Planner/Researcher/Reporter/Coder 多节点 graph。

> 注：`README.md` 中关于「Planner/Researcher/Reporter/Coder 多节点」「走 `/api/chat/v2`」的描述已过时，应以 `CLAUDE.md` 与实际代码为准。真实主入口是 `src/app/api/v3/chat/route.ts`。

主要差距集中在**工程完成度**而非架构选型：

- 消息流存在一个**重大缺陷**（带模型配置时 Agent 被执行两次）。
- 三条「半成品 / 断链」路径：`state_update` 转发、`interrupt/resume` 闭环、`memory` 开关。
- 一批中间件是**占位空实现**，未真正装配。
- subagent 与 prompt 与 deer-flow 大体对齐，需做**差距校验 + 补强**。

---

## 2. 架构形态对照

| 维度             | DeerFlow 2.0                                                                                              | mini-DeepResearch                                                                 | 结论       |
| ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| 图入口           | `langgraph.json` 单图 `lead_agent` → `make_lead_agent`，基于 `create_agent`                               | `createBaseAgent()` → `createAgent()`（ReAct），单 agent                          | 一致       |
| 多智能体         | 无多节点；靠 subagent 并行委派                                                                            | 无多节点；靠 `taskTool` 委派                                                      | 一致       |
| 状态 schema      | `ThreadState`（sandbox/thread_data/title/artifacts/todos/uploaded_files/viewed_images）                   | `ThreadStateAnnotation`（字段更少）                                               | 部分缺字段 |
| Prompt 组装      | role+soul+memory+thinking+clarification+skills+deferred+subagent+working_dir+response+citations+reminders | 已有强 subagent / report schema，缺 clarification/skills/working_dir/citations 段 | 需补段     |
| 中间件           | 实际装配 16 个                                                                                            | 实际装配 7 个，其余占位                                                           | 需补齐     |
| 消息流           | astream_events → SSE，统一单路径                                                                          | 双路径（含缺陷），事件协议齐全                                                    | 需修复     |
| interrupt/resume | 完整闭环                                                                                                  | 前端就绪、后端半成品                                                              | 需打通     |

---

## 3. 中间件对照

DeerFlow 2.0（`backend/packages/harness/deerflow/agents/middlewares`，16 个，均真实现并装配）：
`clarification` · `dangling_tool_call` · `deferred_tool_filter` · `llm_error_handling` · `loop_detection` · `memory` · `sandbox_audit` · `subagent_limit` · `summarization` · `thread_data` · `title` · `todo` · `token_usage` · `tool_error_handling` · `uploads` · `view_image`

mini-DeepResearch（`src/deerflow-harness/agents/middlewares`）实际由 `assembleFromFeatures` 装配的中间件（按 `ORDERED_MIDDLEWARES` 位序）：

| 位序 | 中间件                            | 启用条件                                                  | 对应 deer-flow         |
| ---- | --------------------------------- | --------------------------------------------------------- | ---------------------- |
| —    | `qwenToolCallRecoveryMiddleware`  | `qwenToolCallRecovery===true` 或 `provider==='qwen'` 自动 | mini 特有（Qwen 适配） |
| 0    | `threadDataMiddleware`            | `features.threadData===true`（服务级默认 true）           | `thread_data`          |
| 1    | `uploadsMiddleware`               | `features.uploads===true`（服务级默认 true）              | `uploads`              |
| 3    | `toolCallIntegrityMiddleware`     | 始终                                                      | `dangling_tool_call`   |
| 5    | `toolErrorHandlingMiddleware`     | 始终                                                      | `tool_error_handling`  |
| 6    | `summarizationMiddleware`         | `features.summarization` = 实例（不允许 true）            | `summarization`        |
| 7    | `todoMiddleware`                  | `features.todo===true`                                    | `todo`                 |
| 8    | `titleMiddleware`                 | `features.autoTitle===true`（服务级默认 true）            | `title`                |
| 9    | `memoryMiddleware`                | `features.memory===true`（服务级默认 true）               | `memory`               |
| 10   | `viewImageMiddleware`             | `features.vision===true`（默认 false；当前为占位）        | `view_image`           |
| 11   | `createSubagentLimitMiddleware()` | 始终（每请求新建实例）                                    | `subagent_limit`       |
| 12   | `loopDetectionMiddleware`         | 始终                                                      | `loop_detection`       |

**占位 / 未装配**：`view_image`（占位 + 启用警告，等视觉模型适配再做）。
**mini 暂缺**：`deferred_tool_filter` · `llm_error_handling` · `token_usage`（本次不强制补，文档登记）。

---

## 4. 不足清单（按严重度）

### P0 — 重大缺陷

**#1 双路径执行（`src/app/api/v3/chat/route.ts`）**
`submitRun()` 始终被 fire-and-forget 后台执行（事件写入 StreamBridge channel）；当请求带 `configuration.model.value` 时，又构造 `dynamicClient` 并 `dynamicClient.stream()` 直连返回前端（line 227-229 / 307-315 / 372-379）。

- 后果：带模型配置时 **Agent 被执行两次**（后台一次无人订阅 + 直连一次），浪费 token、可能重复写 checkpoint；直连路径绕过 buffer，**断线无法回放**；两条路径行为不一致。

### P1 — 链路断裂 / 半成品

**~~#2 `state_update` 不转发~~**（已废弃 — 该链路整体移除）
`client.ts` 的 `handleCustomPayload` 仅处理 `task_*`，对 custom writer 推送的 `state_update` 走 `default` 丢弃（line 511-513）。而 `to-client-event.ts` 的 `STATE_UPDATE` 映射、前端 `applyStateUpdate`、`deep-research-process-store` 均已就绪——**链路只在后端被截断**。

> 决议：经 2026-06 评估，DeepResearch 进度面板（`deepResearchProcessStore`）已下线，`state_update` 通道不再有消费方。链路两端代码（前端 reducer 分支、协议类型/枚举、客户端事件映射、`handleCustomPayload` 'state_update' case）已全部删除。本条不再实施，方案 #2 同步作废。

**#3 interrupt/resume 闭环缺失**
`client.ts` 的 `stream()` 全程不检测 LangGraph interrupt、从不发 `HUMAN_INTERRUPT`；`ThreadService.resume()` 占位直接抛异常。但前端 `stream-chat-handler.ts` 已实现 `HUMAN_INTERRUPT` 处理与 `operation==='resume'` 分支（`resumeDecision`），`ClarificationMiddleware` 始终启用——**闭环只差后端**。

### P2 — 完成度 / 一致性

- **#4 buffer 无上限**：`ThreadChannel.buffer` 无裁剪，长线程内存膨胀（`CLAUDE.md` 已知限制 #3）。
- ~~**#5 memory 永不启用**~~（已落地）：`_service.ts` 注入 `baseOptions.memoryEnabled: true` 默认开启；`resolveRuntimeOptions` 接通 `metadata.memoryEnabled` 单次请求覆盖（仅 `typeof === 'boolean'` 才生效）；`route.ts` 透传 `body.configuration.memoryEnabled`。
- ~~**#6 中间件占位**~~（基本落地）：`title` / `uploads` / `thread-data` 已实装并由 `_service.ts` 服务级默认开启；`view-image` 仍为占位（首次启用时 `console.warn` 一次，等真有视觉模型适配再做）；`summarization` / `todo` 已接 LangChain 现成实现，未默认启用。
- **#7 Subagent 需核对**：`executor.ts` 已具超时/取消/终态一次/`inherit`/父子共享 checkpoint/`recursionLimit`；`subagent-limit-middleware.ts` 已具并发(默认3)+总量(默认8)双闸+LRU；`general-purpose.ts` 已 `disabledTools:['task']`+`model:'inherit'`。需对照 deer-flow 做差距校验与补强，**而非重写**。
- **#8 Prompt 缺澄清系统**：缺 deer-flow 的 CLARIFY→PLAN→ACT、skills_section、working_directory、统一 citations 段。

---

## 5. 逐项技术方案与取舍

### 方案 #1：统一消息流单路径（修复 P0）

将 `route.ts` 收敛为唯一路径 **`submitRun` → `service.subscribe`**，**删除 `dynamicClient.stream()` 直连分支**。模型配置改为**透传给 `submitRun`**：

- 扩展 `SubmitRunInput`（携带 `modelValue` / `modelConfig` 等），在 fire-and-forget 执行体内据此解析对应 `DeerFlowClient`（复用 `getDeerFlowClientWithModelConfig`），或将 `ModelConfig` 注入 `RuntimeContext.currentModelConfig` 供 `client.stream()` 使用。
- 保持 `submitRun` fire-and-forget、`finally` 始终 publish END 的不变量（`project.md` §8）。

> 取舍：也可保留 dynamicClient 但让 submitRun 不执行——但那样会丢失 StreamBridge 回放能力与状态收敛，违背既有架构。故选择「统一走 submitRun」。

收益：单次执行（约减半 token/LLM 调用）、断线可回放、行为一致。

### ~~方案 #2：打通 `state_update`（修复 P1）~~（已废弃）

参见上文 P1 #2 决议：链路两端已删除，方案不再实施。

### 方案 #3：interrupt/resume 闭环（修复 P1）

- **检测**：`stream()` 消费循环识别 LangGraph interrupt（`__interrupt__` updates / `agent.getState().tasks[].interrupts`），发出 `HUMAN_INTERRUPT`（question/details），并将 thread 状态置 `interrupted`。
- **续跑**：实现 `ThreadService.resume()`——以 `new Command({ resume: decision })` 作为输入再次 `client.stream`/`agent.stream`，复用同一 `thread_id`（共享 checkpoint），事件继续经 StreamBridge channel 推送；收敛 run/thread 状态。
- **路由**：`route.ts` 的 `operation==='resume'` 分支改为调用 `service.resume(...)`；前端 `resumeDecision` 已对接，无需改协议。

### 方案 #4：buffer 上限（修复 P2）

为 `ThreadChannel.buffer` 增加可配置上限（环境变量，默认约 2000 条）+ 超限丢弃最旧的**非关键帧**（保留 `START`/`ERROR`/`END`），并日志告警。注释遵循「触发条件 + 后果 + 对策」三要素。

### 方案 #5：中间件补齐（修复 P2，按用户选定项）

以 `[subagent:code-explorer]` 核对 deer-flow 对应 Python 实现的行为契约后，把占位中间件补为可用：

- **summarization**：超阈值历史消息摘要（`features` 维持「不允许 `true`」，必须显式传实现）。
- **todo**：维护 `ThreadState.todos`，提供 plan-mode 待办。
- **title**：首轮后异步生成线程标题（写 ThreadMeta；LLM invoke 必须 `callbacks:[]` 防 `ERR_INVALID_STATE`）。
- **uploads / thread-data**：注入上传文件 / 工作目录上下文。
- **view-image**：多模态图片查看（与 `vision` feature 协同）。

接入 `features.ts`（新增对应 `FeatureToggle` 键）与 `assembleFromFeatures`（按 deer-flow 位序，用 `Next/Prev` 锚点定位）。memory 开关：评估在 `resolveRuntimeOptions` 接通 metadata 透传（修复 #5），但**保持默认关闭**以不改既有行为。

### 方案 #6：Subagent 对齐（核对 #7）

以差距校验为主：核对 `max_concurrent_subagents` 默认值（mini=3，与 deer-flow 一致）、`disabledTools` 递归防护、`model='inherit'` 缺 `inheritedModelConfig` 时的告警兜底、超时/取消终态语义；必要处补强校验与注释，保持 `createSubagentLimitMiddleware()` 每请求新建实例的语义。

### 方案 #7：Prompt 对齐（#8）

在 `lead-agent/prompt.ts` 补齐：CLARIFY→PLAN→ACT 澄清系统（信息缺失/歧义/多方案/危险操作先 `ask_clarification`）、skills_section、working_directory、统一 citations 段；保留 mini 既有 final-report/task_summary schema。

---

## 6. 落地优先级与依赖

```
tech-doc (本文)
  ├─ fix-dual-path (P0)  ──► state-update (P1) ──► interrupt-resume (P1) ──► buffer-cap (P2)
  ├─ middlewares (P2)
  └─ subagent-prompt (P2)
        └─────────────► acceptance (lint/format/build/黑名单/命名)
```

执行顺序：先修 P0 消息流主干（单路径），再依次打通 state_update、interrupt/resume、buffer；中间件补齐与 subagent/prompt 对齐可并行推进；最后统一验收。

---

## 7. 改动影响面（文件清单）

| 文件                                                                                                              | 操作           | 说明                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `docs/deerflow-alignment-plan.md`                                                                                 | NEW            | 本技术方案文档                                                                                                                 |
| `src/app/api/v3/chat/route.ts`                                                                                    | MODIFY         | 删 dynamicClient 直连，统一 submitRun+subscribe；模型配置透传；resume 分支改调 `service.resume`                                |
| `src/app/api/threads/_service.ts`                                                                                 | MODIFY         | 按 modelConfig 解析 client 供 submitRun 执行体使用                                                                             |
| `src/deerflow-harness/client.ts`                                                                                  | MODIFY         | `handleCustomPayload` 增 `state_update`；`stream()` 检测 interrupt 发 `HUMAN_INTERRUPT`；`resolveRuntimeOptions` 接通 metadata |
| `src/deerflow-harness/runtime/service.ts`                                                                         | MODIFY         | 实现 `resume()`；submitRun 支持模型/metadata 透传；thread 状态 `interrupted`                                                   |
| `src/deerflow-harness/runtime/stream-bridge/stream-bridge.ts`                                                     | MODIFY         | buffer 上限 + 裁剪（保留 START/ERROR/END）                                                                                     |
| `src/deerflow-harness/agents/factory.ts`                                                                          | MODIFY         | 装配补齐后的中间件                                                                                                             |
| `src/deerflow-harness/agents/features.ts`                                                                         | MODIFY         | 新增 todo/title/uploads/threadData/viewImage 键；summarization/guardrail 维持「不允许 true」                                   |
| `src/deerflow-harness/agents/middlewares/{summarization,todo,title,uploads,thread-data,view-image}-middleware.ts` | MODIFY         | 占位 → 真实现                                                                                                                  |
| `src/deerflow-harness/agents/lead-agent/prompt.ts`                                                                | MODIFY         | 补 clarification/skills/working_dir/citations 段                                                                               |
| `src/deerflow-harness/agents/thread-state.ts`                                                                     | MODIFY（按需） | 新增 todos/title/uploads 等 state 字段                                                                                         |
| `src/deerflow-harness/subagents/{executor.ts,builtins/general-purpose.ts}`                                        | VERIFY/补强    | 差距核对                                                                                                                       |
| `src/utils/chat/stream-chat-handler.ts`                                                                           | VERIFY         | 确认前端 resume/interrupt 链路与后端新行为对齐（预计无需改）                                                                   |

---

## 8. 不可破坏契约（`project.md` §6/§8）

- ClientAgentEvent 10 种协议：仅**增**分支/字段，不删改既有字段名。
- API 路由路径、PostgreSQL schema、Zustand 字段名、LangGraph runtime key（`thread_id`/`currentModelConfig`/`agentName`/`userId`）。
- `submitRun` fire-and-forget + `finally` 始终 publish END。
- Memory 子系统 LLM invoke 必须显式 `callbacks:[]`。

---

## 9. 验收清单（`project.md` §5）

```bash
pnpm lint           # 0 error
pnpm format:check   # 通过
pnpm build          # 生产构建成功

rg -n "legacy|deprecated|向后兼容|旧版" src     # = 0
rg -nP "^\s*//\s*[-=─━*]{5,}" src               # = 0
rg -nP "^\s*/\*+\s*[-=─━*]{5,}" src             # = 0
rg -nw "cfg|tcId|Tc" src                        # = 0
```

- `as any` 非硬性要求（必要处可保留）；新增 `as unknown as` 须有解释性注释。
- 不引入新依赖；不新增兼容层。

---

## 10. 风险与回滚

| 风险                                             | 缓解                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| 单路径化后模型配置透传遗漏，导致非默认模型不生效 | 透传链路加日志；保留 `getDeerFlowClientWithModelConfig` 缓存键    |
| interrupt 检测依赖 LangGraph 版本行为            | 以 `__interrupt__` updates 与 `getState().tasks` 双重判定，加兜底 |
| 中间件补齐改动 prompt/state，影响既有对话        | 新中间件默认关闭（feature toggle），灰度开启                      |
| buffer 裁剪误删关键帧                            | 白名单保留 START/ERROR/END；仅裁剪中间增量帧                      |

每项改动相互独立、可单独回滚（git 粒度按 todo 提交）。
