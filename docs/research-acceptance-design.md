# DeepResearch 结果验收与降级技术方案

> 状态：Draft
> 日期：2026-11-12
> 范围：研究型对话的运行时结果验收；不改变 thread/run 的产品边界
> 目标读者：Agent runtime、后端服务、前端事件流与评测模块的实现者

## 1. 背景

当前 Agent 具备单 run 内的 ReAct 工具循环，也可以多轮调用 `task`。但“执行循环结束”与“研究任务完成”被混为一谈：

1. 子 Agent 的 LangGraph stream 正常结束，`SubagentExecutor` 就发出 `completed`；
2. `taskTool` 把该事件包装成 `Task Succeeded`；
3. lead 收到看起来完整的 Markdown 报告后，通常不再产生 `tool_calls`；
4. graph 以“最后一条 AIMessage 没有工具调用”为退出条件，run 被标记为成功。

这条链路没有回答一个关键问题：**结果是否达到本次用户请求的验收标准？**

模型停止行动只是终止信号，不是质量证明。当前系统的主要失败模式因此是：

- 只派遣一批 subagent 就提前汇总；
- 没有覆盖用户要求的全部维度；
- 结论存在但引用不支撑结论；
- 来源过时或相互冲突，却没有披露；
- 模型发现资料不足，仍生成一份“看起来完整”的报告。

本方案把“执行结束”和“结果验收”拆开：只有结果通过冻结的验收契约，才允许作为完整答案输出；无法通过时进入补证，或在预算耗尽后明确降级为部分完成/证据不足。

## 2. 目标与非目标

### 2.1 目标

- 在 Agent 执行前生成并冻结 Research Contract，明确本次任务“什么叫完成”。
- 对结果执行确定性硬门槛、证据核验和有限质量评分。
- 未通过时自动补证并再次生成，不依赖模型自己记得剩余任务。
- 完整答案只在验收通过后进入 SSE 与持久化链路。
- 预算耗尽后允许显式返回 `partial` 或 `insufficient_evidence`，禁止把未验证结果标成完整成功。
- 保持现有 run 生命周期、取消、checkpoint、断线续流和多进程事件语义。
- 保持 `ClientAgentEvent` 的 10 种事件类型不变，通过现有 `task_progress` 扩展验收状态。

### 2.2 非目标

- 不实现跨用户 turn 持续自主运行的 Agent 守护进程。
- 不重写 LangGraph ReAct 循环。
- 不保证所有开放式研究都有客观真值；目标是让无法验证的结果可被识别和降级。
- 不在首版实现通用领域知识库或事实数据库。
- 不新增 run 状态枚举；`runs.status` 仍描述执行生命周期，验收结果另行表达。

### 2.3 反目标

- 用一个 LLM judge 自由打分后直接放行。
- 允许生成答案的模型在验收阶段修改验收标准。
- 验收失败后无限补证。
- 把候选答案实时推给前端，再在事后撤回。
- 因验收不可用而静默降级为“成功”。

## 3. 核心设计

### 3.1 总体链路

```text
用户请求
  → ContractBuilder
  → 冻结 ResearchContract
  → Research Agent / task / search_web
  → EvidenceLedger
  → CandidateAnswer
  → AcceptanceMiddleware
      ├─ pass          → FinalAnswer 放行 → END
      ├─ retry         → 注入未满足项 → 回到 model
      ├─ partial       → 输出带缺口披露的非完整结果
      ├─ insufficient  → 明确说明证据不足
      └─ failed        → ERROR / run failed
```

### 3.2 运行状态机

```text
contracting
  → researching
  → drafting
  → accepting
      ├─ passed
      ├─ repairing → researching / drafting
      ├─ partial
      ├─ insufficient
      └─ failed
```

状态存入 LangGraph checkpoint。取消信号在 contract、research、accept 任一阶段都必须能中断，并沿用现有 `ThreadService` 的取消收口逻辑。

### 3.3 两个不可混淆的状态

| 状态     | 含义                               | 载体                 |
| -------- | ---------------------------------- | -------------------- |
| 执行状态 | run 是否仍在执行、完成、取消或异常 | `runs.status`        |
| 验收状态 | 答案是否满足契约、是否只能部分交付 | `ResearchAcceptance` |

`runs.status='succeeded'` 仍表示执行体正常收口；完整答案、部分答案和证据不足分别是不同的 `acceptance.status`。这样做避免修改现有 DB CHECK 枚举和僵尸回收语义。

映射规则：

| acceptance     | run 收口                  | 用户可见结果                         |
| -------------- | ------------------------- | ------------------------------------ |
| `pass`         | `succeeded`               | 完整答案                             |
| `partial`      | `succeeded`               | 确定性缺口披露，不输出未验收完整报告 |
| `insufficient` | `succeeded`               | 明确的证据不足说明                   |
| `error`        | `failed`                  | 仅 ERROR，不输出候选正文             |
| 取消           | `failed` + cancelled 文案 | 按现有取消语义保留已验收内容（如有） |

## 4. Research Contract

### 4.1 设计原则

- **执行前生成**：不能等答案写完后再定义标准。
- **冻结不可变**：生成答案的 Agent 和 verifier 只能读取，不能修改。
- **任务特化**：所有问题共用少量全局不变量，具体维度来自用户请求。
- **有限规模**：必答项默认最多 8 个，避免模型把简单问题过度拆解。
- **可追溯**：记录 contract 版本、生成方式、哈希与冻结时间。

### 4.2 数据结构

```ts
export type ResearchRisk = 'low' | 'medium' | 'high';

export interface ResearchRequirement {
  id: string;
  question: string;
  required: boolean;
  /** 该问题至少需要多少条可追溯 evidence。 */
  minEvidence: number;
  /** 是否要求独立来源交叉验证。 */
  requireCrossSource?: boolean;
}

export interface ResearchContract {
  version: 'research-contract-v1';
  hash: string;
  runId: string;
  query: string;
  mode: 'direct' | 'research';
  risk: ResearchRisk;
  scope: {
    timeRange?: string;
    geography?: string;
    entities: string[];
    exclusions: string[];
  };
  requirements: ResearchRequirement[];
  answerRequirements: {
    mustAnswerDirectly: boolean;
    mustShowTradeoffs: boolean;
    mustCiteEvidence: boolean;
    mustDiscloseUncertainty: boolean;
    maxWords?: number;
  };
  policyVersion: string;
  createdAt: number;
}
```

### 4.3 生成与冻结

`ContractBuilder` 在 lead agent 第一次进入模型前运行：

1. 读取本轮用户输入和必要的历史上下文；
2. 使用严格 JSON schema 输出 contract 草案；
3. 合并全局不变量；
4. 校验必答项数量、空问题、重复项与 risk 取值；
5. 计算稳定哈希后写入 `ThreadState.research.contract`；
6. 同一次 run 的 retry、resume 只复用该 contract。

如果 contract builder 发现任务对象、时间范围或关键目标存在会显著改变结果的歧义，应先走现有 `ask_clarification`，用户回答后重新生成 contract。已经冻结的 contract 不允许答案模型通过工具调用或中间件改写。

ContractBuilder 是注入接口：

```ts
export interface ResearchContractBuilder {
  build(input: {
    runId: string;
    query: string;
    historyDigest?: string;
    signal?: AbortSignal;
  }): Promise<ResearchContract>;
}
```

首版默认实现使用当前模型、`temperature=0`、低 token 上限和严格 schema。后续可通过 wiring 替换为独立模型或规则模板，不改变验收器。

### 4.4 全局不变量

以下条件不依赖 contract builder，任何研究型任务都必须满足：

- 直接回应用户问题；
- 完整答案中的事实性结论必须绑定 evidence；
- 推断性结论必须与事实结论区分；
- 不得捏造来源、引文或访问时间；
- 未解决冲突必须披露；
- 验收基础设施失败不得静默视为通过。

### 4.5 示例

用户问题：“比较 AWS、Azure、GCP 当前的企业级 AI 平台能力。”

```json
{
  "mode": "research",
  "risk": "medium",
  "scope": {
    "timeRange": "最近 12 个月",
    "entities": ["AWS", "Azure", "GCP"],
    "exclusions": []
  },
  "requirements": [
    {
      "id": "model-capability",
      "question": "比较三家的托管模型与企业 AI 能力",
      "required": true,
      "minEvidence": 3,
      "requireCrossSource": true
    },
    {
      "id": "enterprise-controls",
      "question": "比较权限、审计、数据驻留和企业治理能力",
      "required": true,
      "minEvidence": 3
    },
    {
      "id": "tradeoffs",
      "question": "给出选型取舍与适用场景",
      "required": true,
      "minEvidence": 0
    }
  ]
}
```

## 5. Evidence Ledger

### 5.1 目标

报告中的 claim 必须引用工具实际返回过的 evidence，而不是模型在最终回答里临时生成的引用。

### 5.2 数据来源

EvidenceCollector 通过 middleware 包装工具调用，首版覆盖：

- `search_web_tool`：保存标题、URL、工具返回摘要、query、retrievedAt；
- `read_file` / `grep`：保存文件路径、行区间、片段哈希；
- subagent `final-report`：只用于 claim 映射，不单独作为事实来源。

子 Agent 的工具执行不写入父线程 checkpoint，因此 evidence 采用两级传递：

1. `SubagentExecutor` 在子 run 内收集 evidence；
2. `completed` 事件增加裁剪后的 `evidence` 数组；
3. `taskTool` 将其放入 `ToolMessage.additional_kwargs.researchEvidence`；
4. lead 侧 `EvidenceCollectorMiddleware` 读取该元数据并合并进父级 ledger。

若工具返回中没有该元数据，最终报告里的 `sources` 只能作为 claim 提示，不能冒充已经验证过的工具来源。

### 5.3 数据结构

```ts
export interface EvidenceItem {
  id: string;
  kind: 'web' | 'file';
  title: string;
  url?: string;
  snippet: string;
  sourceTaskId?: string;
  toolCallId?: string;
  retrievedAt: number;
  contentHash: string;
}

export interface ClaimEvidence {
  claimId: string;
  claim: string;
  kind: 'fact' | 'inference';
  evidenceIds: string[];
}
```

单条 snippet 默认截断到 500 字符；每个 run 最多保存 100 条 evidence。超过上限时优先保留：

1. 被 claim 引用的 evidence；
2. 不同域名来源；
3. 最新获取的 evidence。

### 5.4 禁止的引用

- evidenceId 不存在于 ledger；
- URL 仅出现在最终回答，未由工具返回；
- claim 与 snippet 无支持关系；
- 使用同一来源伪装成多个独立来源；
- 对时效敏感问题引用超出时间窗口的来源但不披露。

## 6. Acceptance Engine

### 6.1 分层判定

验收分为三层，不能合并成单一分数。

#### 第一层：硬门槛

任意硬门槛失败，必须返回 `retry`，不得输出完整答案。

| Gate               | 检查方式         | 默认规则                                   |
| ------------------ | ---------------- | ------------------------------------------ |
| coverage           | 结构化检查       | 所有 required requirement 均有 claim       |
| evidence-exists    | 结构化检查       | 每个 fact claim 至少一个 ledger evidenceId |
| evidence-support   | 语义核验         | snippet 支持 claim，反驳时 failed          |
| citation-integrity | 确定性检查       | evidenceId 存在、URL/snippet 非空          |
| time-scope         | 规则 + 语义核验  | 时效敏感事实满足 contract 时间范围         |
| contradiction      | 语义核验         | 冲突已解决或显式披露                       |
| direct-answer      | 规则 + 语义核验  | 输出直接回应原问题                         |
| safety-policy      | 规则 / guardrail | 不违反现有安全策略                         |

#### 第二层：质量分

硬门槛通过后，按 0、0.5、1 三档评分：

| 维度             | 检查内容                      | 建议权重 |
| ---------------- | ----------------------------- | -------- |
| completeness     | 是否覆盖要求之外的合理维度    | 0.25     |
| evidence-quality | 官方/一手来源占比、来源多样性 | 0.20     |
| synthesis        | 是否形成比较、取舍和结论      | 0.20     |
| consistency      | 报告内部和来源间是否一致      | 0.15     |
| recency          | 时间敏感信息是否足够新        | 0.10     |
| clarity          | 结构与可读性                  | 0.10     |

阈值是策略参数，不在代码中宣称为客观真理。首版建议：

```json
{
  "low": { "quality": 0.65, "maxRepairRounds": 1 },
  "medium": { "quality": 0.8, "maxRepairRounds": 2 },
  "high": { "quality": 0.9, "maxRepairRounds": 3, "requireHuman": true }
}
```

阈值必须通过离线标注数据校准，见第 11 节。

#### 第三层：运行预算

- 最大补证轮次；
- 最大 judge token；
- 最大验收耗时；
- 最大候选答案长度；
- 最大 evidence 数量。

任何预算耗尽都必须产生显式验收状态，不能直接放行。

### 6.2 候选答案协议

最终答案不能只有自由 Markdown，否则 acceptance engine 无法稳定建立 claim 与 evidence 的关系。research mode 的候选输出采用两段式：

1. 用户可读的 Markdown 正文；
2. 正文末尾一个不展示的 `acceptance-audit` JSON block。

```ts
export interface CandidateAnswer {
  markdown: string;
  claims: ClaimEvidence[];
}
```

````text
<Markdown 正文>

```acceptance-audit
{
  "claims": [
    {
      "claimId": "c1",
      "claim": "结论",
      "kind": "fact",
      "evidenceIds": ["ev-1", "ev-2"]
    }
  ]
}
```
````

约束：

- `acceptance-audit` 缺失、JSON 非法或 claimId 重复 → 硬门槛失败；
- 事实性 claim 必须绑定至少一个 ledger evidenceId；
- 引用 index 不再作为跨层唯一标识，统一使用稳定的 evidenceId；
- parser 在进入候选 buffer 时剥离 audit block，任何验收结果都不得把该 block 输出给用户；
- audit block 与 Markdown 的 candidateHash 一起计算，避免只验收正文却替换证据映射。

### 6.3 验收结果

```ts
export type AcceptanceDecision = 'pass' | 'retry' | 'partial' | 'insufficient' | 'error';

export interface AcceptanceCheck {
  key: string;
  level: 'hard' | 'quality' | 'operational';
  passed: boolean;
  score?: number;
  reason: string;
  requirementIds?: string[];
}

export interface AcceptanceReport {
  decision: AcceptanceDecision;
  candidateHash: string;
  contractHash: string;
  checks: AcceptanceCheck[];
  unmetRequirements: string[];
  repairHints: string[];
  qualityScore: number | null;
  evaluatorVersion: string;
  verifierModel: string | null;
  createdAt: number;
}
```

### 6.4 判定顺序

1. 校验 contract hash 与当前 run 一致；
2. 运行确定性 gate；
3. 任一硬门槛失败 → `retry`；
4. 运行 evidence-support 与 contradiction 核验；
5. 硬门槛仍失败 → `retry`；
6. 运行质量评分；
7. 质量分达到阈值 → `pass`；
8. 未达阈值但仍有补证预算 → `retry`；
9. 预算耗尽 → `partial` 或 `insufficient`，使用系统确定性模板生成缺口披露；
10. 验收基础设施异常 → `error`，不得视为 `pass`。

`partial` / `insufficient` 不再让模型重写一份“完整但带免责声明”的报告。系统直接根据 unmet requirements 输出覆盖项、缺口和下一步建议，避免二次生成再次产生假阳性。

### 6.5 LLM judge 的边界

- judge 不读取生成过程，只读取 contract、原始 evidence、候选答案和结构化 claim 映射；
- judge 输出严格 JSON，枚举值非法或字段缺失视为 `error`；
- judge 只负责语义支持和质量维度，不能覆盖确定性校验失败；
- 默认使用独立、`temperature=0` 的评测调用；
- 高风险任务优先使用不同 provider/model，缺少可用 judge key 时不得静默自评；
- 第一版允许使用当前模型完成 support 检查，但必须标记 `verifierModel`，并在基准中单独测量同模型偏差。

## 7. Runtime 集成

### 7.1 Harness 与产品层边界

以下内容放在 `packages/deerflow-harness/research/`，保持零 `@/` 依赖：

- contract / evidence / acceptance 类型与 zod schema；
- 确定性检查；
- ContractBuilder、ResearchVerifier 注入接口；
- AcceptanceMiddleware；
- 评分策略与重试预算纯函数。

以下内容留在 app：

- judge 模型和用户 key 解析；
- 外部 URL / 文件证据读取适配；
- 配置读取与 wiring；
- run outcome 持久化与前端展示。

### 7.2 Contract 阶段

新增 `ResearchContractMiddleware.beforeAgent`：

- lead agent 启用；
- `SUBAGENT_FEATURES` 禁用，避免子 Agent 重复生成 contract；
- `ThreadState.research.contract` 已存在时直接复用；
- 生成失败最多重试一次，仍失败则：
  - `mode='direct'` 使用保守 fallback contract；
  - `mode='research'` 产生 `RESEARCH_CONTRACT_UNAVAILABLE` 错误。

### 7.3 生成与证据阶段

`EvidenceCollectorMiddleware` 包装工具调用并写入 evidence ledger。现有 `task` 返回格式调整为明确的部分结果语义：

```text
Subagent Result
Task: <description>
Status: execution_completed
This is a partial research artifact. It is not final user-facing output.
```

这样避免 lead 把第一份 Markdown 直接理解为“全部研究成功”。

### 7.4 验收阶段

新增 `ResearchAcceptanceMiddleware.afterModel`：

1. 仅在最后一条 AIMessage 没有 `tool_calls` 且包含候选正文时触发；
2. 从 state 读取冻结 contract、evidence ledger 和候选答案；
3. 调用 AcceptanceEngine；
4. 写入 `research.acceptance`；
5. `retry` 时注入一条带未满足项的名称化 HumanMessage，并使用 `jumpTo: 'model'` 回到模型；
6. `pass` 时不跳转，允许 graph 正常结束；
7. 预算耗尽时不再请求模型生成完整报告；由服务端根据 contract 和 unmet requirements 生成确定性的 `partial/insufficient` 披露。

确定性披露由一个纯函数 `renderDegradedOutcome(contract, acceptance)` 生成，并作为最后一条 AIMessage 写回 state。该消息被视为“已验收的降级结果”，不是完整报告；它只列出已覆盖项、缺口、证据不足原因和建议的下一步。

`canJumpTo: ['model']` 的框架行为已有 loop detection 集成测试覆盖，本方案需新增同类端到端测试，不能只使用 mock middleware 单测。

### 7.5 输出门控

当前 `DeerFlowClient` 在检测到报告正文后立即发送 `STREAM_CHUNK`。为满足“达到标准才输出”：

1. research mode 下，最终候选正文先进入 client 内存 buffer；
2. reasoning、工具调用、task progress 继续实时下发；
3. 收到 `acceptance.pass` 后才 flush 候选正文；
4. `retry` 时丢弃旧候选 buffer；
5. `partial` / `insufficient` 只 flush 明确标记的降级文案；
6. `error` 不输出候选正文，转入现有 ERROR 路径；
7. 若流在候选尚未验收时异常结束，候选正文不得落库。

被 `retry` 拒绝的候选保留一份用于模型修订；更早的候选只保留 `candidateHash`、unmet requirements 和最多 500 字符摘要，防止多轮修复把整份报告反复写入 checkpoint。

这会让最终报告的首字节延迟到验收完成。取舍是接受的：研究场景优先正确性，验收期间通过 `task_progress` 展示“正在核验”。

### 7.6 取消、停机与重连

- ContractBuilder、Evidence support、judge 调用都接收同一个 `AbortSignal`；
- 取消优先于验收结果，已取消 run 不发布 acceptance pass；
- 验收状态是 checkpoint 的一部分，resume 后不得重复计费已完成且 hash 未变的 judge；
- 候选 hash 作为 judge 缓存键；
- 多进程下验收状态只通过 checkpoint 与事件总线传播，不使用进程内全局状态。

## 8. 状态、事件与持久化

### 8.1 ThreadState

在 `ThreadStateAnnotation` 增加：

```ts
research: Annotation<ResearchRuntimeState | null | undefined>({
  reducer: (_prev, next) => next,
});
```

```ts
export interface ResearchRuntimeState {
  /** 当前验收状态所属的 run；新 run 必须重置，resume 必须在同一 run 内复用。 */
  runId: string;
  contract: ResearchContract;
  evidence: EvidenceItem[];
  acceptance?: AcceptanceReport;
  repairRounds: number;
  status:
    | 'contracting'
    | 'researching'
    | 'drafting'
    | 'accepting'
    | 'passed'
    | 'partial'
    | 'insufficient'
    | 'failed';
}
```

evidence 必须裁剪并去重，禁止把完整网页、base64 或大段文件写入 checkpoint。

`ResearchContractMiddleware.beforeAgent` 在进入新 run 时检查 `runtime.run_id`：与 `research.runId` 不一致则清空 contract、evidence、acceptance 和 repairRounds；同一 run 的 resume 只复用状态，不重新冻结 contract。

### 8.2 SSE 协议

不新增 `ClientAgentEvent` 类型，复用 `task_progress` 的扩展字段：

```ts
{
  taskId: `acceptance:${runId}`,
  status:
    | 'contract_ready'
    | 'acceptance_started'
    | 'acceptance_passed'
    | 'acceptance_retry'
    | 'acceptance_partial'
    | 'acceptance_insufficient'
    | 'acceptance_failed',
  unmetRequirements: string[],
  qualityScore: number | null
}
```

最终结果可附加到 `END.payload.researchOutcome`：

```ts
{
  decision: 'pass' | 'partial' | 'insufficient' | 'error';
  qualityScore: number | null;
  unmetRequirements: string[];
}
```

前端只需把新 status 映射到 timeline 和结果状态，不改变现有事件分发主链路。

### 8.3 持久化

首版以 LangGraph checkpoint 作为验收状态真相源，不修改 `runs` 表。

第二阶段增加向后兼容列：

```sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome jsonb NOT NULL DEFAULT '{}'::jsonb;
```

`outcome` 只存 `candidateHash`、`decision`、`qualityScore`、`unmetRequirements` 和 evaluator 元数据，不存完整答案或 evidence 正文。run 列表和审计页面据此展示“执行成功但仅部分满足”。

Phase 1 尚未新增 `runs.outcome` 时，`ThreadService` 仍需监听最终 acceptance 事件：

- `pass/partial/insufficient` 正常收口；
- `acceptance.error` 在流结束后转换为 run 失败，不能因为 graph 正常返回就记 `succeeded`；
- 该映射必须通过 ThreadService 集成测试固定，避免 SSE 报错但 DB 显示成功。

## 9. 配置

`config.yaml` 增加严格校验块：

```yaml
research_acceptance:
  enabled: true
  max_requirements: 8
  max_repair_rounds: 2
  quality_threshold: 0.8
  allow_partial_output: true
  judge_model: null # null = 当前 run 模型；可配置独立 preset
  judge_timeout_ms: 60000
  max_evidence_items: 100
```

约束：

- 非法配置启动即报错；
- `max_requirements` 限制在 3 到 12；
- `max_repair_rounds` 限制在 0 到 4；
- `judge_model` 指向不可用 provider/key 时，在运行前预检，不能到验收阶段才静默降级；
- 该配置纳入现有 middleware config signature 与 `buildConfigKey`，使 agent 缓存正确失效。

### 9.1 文件级影响面

新增：

| 文件                                                          | 作用                                           |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `packages/deerflow-harness/research/types.ts`                 | contract、evidence、candidate、acceptance 类型 |
| `packages/deerflow-harness/research/schema.ts`                | zod schema、哈希与版本                         |
| `packages/deerflow-harness/research/contract-builder.ts`      | ContractBuilder 注入面与默认实现               |
| `packages/deerflow-harness/research/evidence-collector.ts`    | evidence 捕获、裁剪与合并                      |
| `packages/deerflow-harness/research/deterministic-checks.ts`  | coverage/citation/claim 等硬门槛               |
| `packages/deerflow-harness/research/acceptance-middleware.ts` | afterModel 验收与 retry jump                   |
| `packages/deerflow-harness/research/verifier.ts`              | 语义 support 与质量评分接口                    |
| `packages/deerflow-harness/research/degraded-output.ts`       | 确定性 partial/insufficient 文案               |
| `packages/deerflow-harness/research/__tests__/`               | 纯逻辑与 graph 集成测试                        |

修改：

| 文件                                                    | 改动                                                |
| ------------------------------------------------------- | --------------------------------------------------- |
| `packages/deerflow-harness/agents/thread-state.ts`      | 增加 run-scoped research state                      |
| `packages/deerflow-harness/agents/features.ts`          | 增加 lead-only research acceptance toggle           |
| `packages/deerflow-harness/agents/factory.ts`           | 按位序装配 contract/evidence/acceptance middleware  |
| `packages/deerflow-harness/agents/lead-agent/prompt.ts` | 产出 Markdown + `acceptance-audit`                  |
| `packages/deerflow-harness/agents/middlewares/index.ts` | 导出与位序登记                                      |
| `packages/deerflow-harness/client.ts`                   | 候选 buffer、acceptance state 识别与 SSE 门控       |
| `packages/deerflow-harness/subagents/executor.ts`       | 传播子 run evidence                                 |
| `packages/deerflow-harness/tools/builtins/task-tool.ts` | 部分结果语义与 evidence metadata                    |
| `packages/deerflow-harness/types/subagent.ts`           | completed 事件增加 evidence                         |
| `packages/deerflow-harness/config/middleware-config.ts` | research_acceptance 配置 schema                     |
| `packages/deerflow-harness/index.ts`                    | research 公共导出                                   |
| `src/backend/config/deerflow-config.ts`                 | YAML 映射、预检与 cache signature                   |
| `src/backend/wiring.ts`                                 | contract builder / verifier / evidence adapter 注入 |
| `src/backend/services/thread-service.ts`                | run outcome 捕获与 END 元数据                       |
| `src/utils/chat/parts-reducer.ts`                       | 验收状态 timeline 展示（不改变正文语义）            |
| `config.yaml`                                           | 默认验收策略                                        |
| `benchmarks/research-qa/evaluators.ts`                  | 增加离线 FAR/FRR 验收指标                           |

## 10. 分阶段落地

### Phase 1：契约与确定性门控

交付：

- contract/evidence/acceptance 类型与 schema；
- ContractBuilder；
- coverage、citation-integrity、evidence-exists、direct-answer 确定性检查；
- AcceptanceMiddleware；
- research mode 的候选答案 buffer 与 pass 后 flush；
- `retry` 注入缺口并回到模型；
- SSE `task_progress` 验收状态。

验收：

- 未生成候选答案前，contract 已存在且 hash 稳定；
- 新用户 turn 会清空上一 run 的 contract/evidence/acceptance，resume 不会清空；
- 缺失 required requirement 时不得 flush 正文；
- retry 后第二轮通过才输出；
- 取消发生在 acceptance 阶段时，不输出候选内容；
- 多进程重连可回放验收状态。

### Phase 2：证据语义核验与降级

交付：

- EvidenceCollector；
- evidence-support、time-scope、contradiction 检查；
- ResearchVerifier 注入与 judge 超时/错误语义；
- `partial` / `insufficient` 输出模板；
- subagent result 语义改为部分研究产物。

验收：

- 伪造引用不能通过；
- claim 与 snippet 不匹配时进入 retry；
- judge 不可用时不产生 pass；
- 预算耗尽后返回明确缺口，不生成伪完整答案。

### Phase 3：持久化与阈值校准

交付：

- `runs.outcome`；
- 前端验收 timeline 与结果标识；
- 离线 acceptance 数据集；
- 阈值、重试次数与成本基准；
- 高风险任务的人工确认策略。

验收：

- 刷新后仍可看到验收结论；
- 离线 false-accept rate 达到项目设定上限；
- 首版阈值在低/中风险样本上通过人工复核；
- 补证轮次和额外耗时/成本有 p50、p95 报告。

## 11. 测试与评测

### 11.1 单元测试

- contract schema、hash、冻结与非法输出；
- evidence 截断、去重、上限与引用完整性；
- 每个硬门槛的通过/失败边界；
- 质量分聚合和阈值策略；
- retry 预算、candidate hash 缓存；
- partial/insufficient/error 的状态转换。

### 11.2 Graph 集成测试

使用 `FakeToolCallingModel` 跑真实 graph：

1. 第一次生成缺 requirement 的候选；
2. middleware 判定 retry 并跳回 model；
3. 第二次生成通过候选；
4. 断言模型调用次数、最终消息、验收状态和输出顺序。

另需覆盖：

- 候选已生成但验收异常；
- 取消发生在 judge 调用中；
- resume 后复用 contract 和已缓存 judge；
- subagent 不生成嵌套 contract。

### 11.3 SSE 端到端测试

- `STREAM_CHUNK` 正文必须晚于 `acceptance_passed`；
- retry 候选不得泄漏到 SSE；
- `END.payload.researchOutcome` 与 checkpoint 一致；
- 断线重连续读后仍保持相同事件顺序。

### 11.4 离线评测

在现有 `benchmarks/research-qa` 基础上增加验收专用指标：

| 指标                   | 含义                                    |
| ---------------------- | --------------------------------------- |
| false-accept rate      | 不完整/错误答案被放行的比例，首要不变量 |
| false-reject rate      | 合格答案被错误拦截的比例                |
| requirement coverage   | required requirement 的覆盖率           |
| evidence precision     | 被引用 evidence 确实支持 claim 的比例   |
| repair success rate    | retry 后达到 pass 的比例                |
| abstention correctness | 应弃答时是否正确返回 insufficient       |
| added latency / tokens | 契约、核验与补证的成本                  |

阈值不凭经验拍定：先由人工标注一批 pass/partial/insufficient 样本，计算不同阈值下的 FAR/FRR，再按风险策略选取工作点。

## 12. 观测与诊断

每次验收记录一条结构化日志：

```json
{
  "runId": "...",
  "threadId": "...",
  "contractHash": "...",
  "candidateHash": "...",
  "decision": "retry",
  "failedGates": ["coverage", "evidence-support"],
  "repairRound": 1,
  "qualityScore": 0.62,
  "verifierModel": "deepseek-v4-pro",
  "latencyMs": 1840
}
```

禁止记录 API key、完整网页正文和用户上传文件内容。失败原因保留 requirement id 和 gate key，便于聚合统计。

## 13. 风险与取舍

| 风险                                   | 处理                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| contract 过宽，验收形同虚设            | 全局硬门槛 + 必答项上限 + 离线 FAR 校准               |
| contract 过窄，误杀合理答案            | 允许 analysis/inference 类型 claim，阈值按风险分级    |
| 同模型 judge 存在共同盲区              | 确定性检查优先；高风险任务使用独立模型或人工          |
| 验收延迟和成本增加                     | 只对 research mode 启用；简单直答走轻量确定性检查     |
| 候选答案被多次生成导致 checkpoint 膨胀 | 修复轮次封顶；candidate 只保留当前轮；evidence 截断   |
| judge 故障被误判为模型答错             | `error` 与低分分开，禁止静默 pass                     |
| 重连后重复 judge                       | candidateHash 缓存，checkpoint 持久化                 |
| 验收基础设施成为新单点                 | 超时、有限重试、显式 `error/insufficient`，不自动放行 |

## 14. 不可破坏的契约

- `ClientAgentEvent` 仍保留现有 10 种事件；
- `runs.status` 枚举不因本方案改变；
- `submitRun` fire-and-forget、`try/catch/finally` 收敛和 END 发布语义不变；
- 同一 thread 同时只允许一个 run；
- 取消经 `AbortSignal` 贯穿 ContractBuilder、Agent、judge；
- harness 不 import `@/*`；
- 验收状态与证据必须可跨进程恢复，不能依赖进程内 Map；
- 未通过验收的候选正文不得进入 `AssistantPartsCollector` 或数据库。

## 15. 首版完成定义

首版不是“让模型更少假阳性”，而是让系统不再把假阳性自动升级为成功：

1. 每个 research run 都有冻结 contract；
2. 每个完整答案都有 AcceptanceReport；
3. 缺 requirement、无 evidence 或不支持 claim 的候选不能通过；
4. retry 有明确预算；
5. 预算耗尽时只能返回明确的 partial/insufficient；
6. 前端、checkpoint、日志对同一 decision 保持一致；
7. 离线数据能测出 false-accept rate，而不是只展示平均分。

## 16. 留给实现阶段的决策

- 首版 ContractBuilder 使用当前 run 模型还是固定低成本模型；
- `partial` 默认返回多少正文，还是只返回覆盖项和缺口清单；
- 高风险任务的“人工确认”先走现有 `ask_clarification` 还是新增审批接口；
- `runs.outcome` 在 Phase 1 还是 Phase 3 落地；
- evidence support 首版采用同模型语义核验，还是先只做引用完整性。
