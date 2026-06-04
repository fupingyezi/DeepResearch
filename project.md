# project.md — mini-DeepResearch AI 协作规范

> 本文件面向 AI 协作者（Claude / Codex / Cursor / CodeBuddy 等）。在本仓库
> 进行**任何**代码改动前，必须先阅读并遵守本文件的全部约定。

---

## 0. 前置须知

- 项目概览、架构、运行命令请阅读 `CLAUDE.md`，本文件**只**约束代码风格与
  协作规范，不重复架构说明。
- 改动前先在脑中评估：① 当前修改是否破坏既有契约（详见 §6）；② 是否引入
  新依赖；③ 注释、断言、命名是否符合本规范。

---

## 1. 注释规范

### 1.1 该写

- 模块/函数顶部一句话职责注释（说明"做什么"）。
- 关键不变量、并发/异步边界（如 fire-and-forget、AsyncLocalStorage 透传）。
- 外部协议字段（SSE 字段、PG schema、API request/response 形态）。
- 非显然的坑位规避（必须含触发条件 + 后果 + 对策三要素）。

### 1.2 该删

- "思考过程"型注释（"我之前是这样写的，后来改了"、"先尝试 X 失败回退 Y"）。
- "版本迭代"型注释（"v1 这样、v2 改成那样"、"旧版兼容"、"deer-flow 1.0
  时…"、"位序 N"等开发期演化痕迹）。
- 与代码字面同义的"翻译式"注释。
- 隔断式分隔符注释（`// ====== xxx ======`、`// ──────── xxx ────────`、
  `/* ----------- xxx ----------- */`、`// -------------------- xxx --------------------`、
  连续 5 个以上的 `=` / `-` / `─` / `*`）。

### 1.3 兼容性 = 删除

**本仓库不维护任何兼容层。** 凡是注释里出现以下任一字眼：

- `legacy` / `deprecated` / `兼容` / `向后兼容` / `旧版` / `历史原因`

必须**同时**：

1. 删掉对应注释；
2. 删掉对应代码路径；
3. 把仍要保留的逻辑迁移到主路径。

唯一例外：当"兼容"指**协议层事实**时（例如"OpenAI 兼容协议"、"多模态
content blocks 兼容"），属于技术陈述，可以保留。

### 1.4 检查清单

```bash
# 必须为 0
rg -n "legacy|deprecated|向后兼容|旧版" src
# 必须为 0
rg -nP "^\s*//\s*[-=─━*]{5,}|^\s*/\*+\s*[-=─━*]{5,}" src
```

---

## 2. 类型断言（`as`）准则

### 2.1 禁止

- `as断言` —— 只有在类型报错必要时按需使用，不要滥用，如已经声明类型，又用as声明一遍。
- `as unknown as T` 双层断言 —— 仅在跨结构性类型转换且无更优解时可用，且
  **必须**同行或紧邻位置写注释解释"为什么必须双层"。
- 连续 `as A as B` —— 视同双层断言，同上。

### 2.2 允许

- 外部数据边界处的**单层** `as T`：
  - PostgreSQL `res.rows[0] as RunRow`（schema 已约束列形态）；
  - `JSON.parse(s) as T`（上游已校验或在文档说明来源）；
  - LangChain 第三方对象的字段访问（如 `(msg as { content?: unknown }).content`）。
- 用 `as const` 做字面量收窄。

### 2.3 替换套路

| 模式                                      | 推荐替换                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `(err as Error & { code?: string }).code` | 自定义错误类 `class AppError extends Error { constructor(msg, public code: string) { super(msg); } }` |
| `(x as any).field`                        | 定义本地接口 `interface X { field?: T }` 后用 `as X`                                                  |
| `setTimeout(...) as unknown as number`    | 显式包装函数返回 `Number(setTimeout(...))` 或用 `ReturnType<typeof setTimeout>`                       |

能用any优先any，减少过度防御

### 2.4 检查清单

```bash
# 必须有解释性注释，否则视为违规
rg -nP "as\s+unknown\s+as" src
```

---

## 3. 命名规范

### 3.1 业务缩写必须改全名

| 缩写                                       | 替换                      |
| ------------------------------------------ | ------------------------- |
| `tc` / `tcId` / `Tc`                       | `toolCall` / `toolCallId` |
| `lc` / `Lc`（LangChain 上下文）            | `langChain`               |
| `cfg` / `Cfg`                              | `config`                  |
| `msg` / `msgs`（LangChain message 上下文） | `message` / `messages`    |
| `tmp`                                      | `temp` 或具体语义         |
| 含义不明的 `arr` / `obj` / `val`           | 按上下文具体化            |

例外：`lc` 若是第三方类型来源（如 `LcMessage`），保留并加注释说明。

### 3.2 通用工程惯例（保留，不改）

- `opts` / `ctx` / `req` / `res` / `err` / `cb` / `fn`
- `id` / `url` / `api` / `db` / `el` / `btn`
- `idx` / `len` / `i` / `j` / `k`

### 3.3 检查清单

```bash
# 必须为 0（注意词边界）
rg -nw "tc|tcId|Tc|TcId|cfg|Cfg" src
```

---

## 4. 目录与文件命名

- 文件名一律 kebab-case：`thread-meta.ts`、`stream-bridge.ts`。
- 不得再次出现拼写错误（如已修正的 `clinet.ts → client.ts`）。
- React 组件文件可用 PascalCase 或 kebab-case，目录内保持一致即可。

---

## 5. 验收标准

任何一次代码改动提交前，以下脚本均须通过：

```bash
pnpm lint           # 0 error
pnpm format:check   # 通过
pnpm build          # 生产构建成功

# 黑名单字符串
rg -n "legacy|deprecated|向后兼容|旧版" src     # = 0
rg -n "as\s+any\b" src                          # = 0
rg -nP "^\s*//\s*[-=─━*]{5,}" src               # = 0
rg -nP "^\s*/\*+\s*[-=─━*]{5,}" src             # = 0
rg -nw "cfg|tcId|Tc" src                        # = 0
```

剩余的 `as unknown as` 必须每处都有解释性注释。

---

## 6. 不可破坏的契约（碰之前先思考三遍）

1. **SSE `ClientAgentEvent` 协议**（`src/deerflow-harness/runtime/sse/client-event.ts`）
   - 10 种事件类型枚举、payload 字段名前后端共享，前端通过 re-export 复用。
   - 增字段 OK；删/改字段需联动前端 EventBus 与组件。
2. **API 路由路径**：`/api/threads`、`/api/v3/chat/[threadId]`、
   `/api/files/*`、`/api/conversations/*`。
3. **PostgreSQL schema**：`threads_meta`、`runs`、checkpoint 系列表（由
   `@langchain/langgraph-checkpoint-postgres` 管理）。
4. **Zustand store 字段名**：前端组件直接消费，改字段名需全量重构组件。
5. **LangGraph runtime 配置 key**：`thread_id`、`currentModelConfig`、
   `agentName`、`userId` 透传链路。

---

## 7. 写代码前的最小心智清单

- [ ] 我是不是在改 §6 列出的契约？如果是，请先与维护者沟通。
- [ ] 我是否新增了注释？这些注释里是否有"思考过程/版本迭代/兼容性"内容？
- [ ] 我是否引入了不必要的 `as`断言 或 `as unknown as`？能否用类型守卫替代？
- [ ] 我是否引入了业务缩写？是否在 §3.1 黑名单中？
- [ ] 我是否引入了新依赖？必须先与维护者沟通。
- [ ] 我是否破坏了现有 SSE 协议字段、API 路由、PG schema？
- [ ] 我是否改完之后跑过 §5 的全部检查脚本？

---

## 8. 修改 ThreadService / DeerFlowClient 的特别约束

- `submitRun` 必须保持 fire-and-forget（立刻返回 run_id）。
- 执行体必须 `try / catch / finally` 三段式，`finally` 中**始终** publish END。
- `DeerFlowClient.stream()` 必须在第一帧 LIFECYCLE start 之前完成 agent 构建。
- Memory 子系统的 LLM invoke 必须显式传 `callbacks: []`，否则会向已关闭的
  ReadableStream 写入触发 `ERR_INVALID_STATE`。

---

## 9. 当 AI 无法判断"该不该改"时

按以下顺序处理：

1. 先读 `CLAUDE.md` 与本文件；
2. 仍不确定 → 在 PR / commit message 中**显式列出疑虑**，让维护者拍板；
3. **绝不**自行扩大改动范围或自行决定保留兼容层。

## 10， 文件代码结构

类型和常量放在文件顶部，函数和类放在文件底部，不要间杂。
