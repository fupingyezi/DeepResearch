# 记忆检索子系统 Review 归档

> 来源：2026-10-06 对 RAG 改动的并行 review（分支 `feat/rag-retrieval`，提交集中 10-05 → 10-06）。
> 用途：摊在代码旁做后续 review / 调参的清单。清单表内行号为修复前定位，已漂移；复查时以 grep 定位为准。
> 状态：**全部关闭**。P0-1 / P0-2 已修复（60b888d / 428dc02）；词面召回已替换为 **BM25**（9cda328）；P1 四条、P2 七条全部已修 / 已排除（状态见各清单表第三列）。

## 两条链路

```
检索链路（retrieve 模式）：
  buildMemoryContext(mode='retrieve')
    ├─ 词面 query = 近 3 轮拼接；语义 / rerank query = 本轮单句
    ├─ 路 A 向量：pgvector 余弦 top-50，门槛 0.6（4 个打分 section 单独 JS 过门槛并入）
    ├─ 路 B 词面：BM25 打分 facts + 4 section，top-50
    ├─ RRF(k=60) 按排名融合（路 A 先入 Map 保 tie 稳定序）
    ├─ 候选池：恒 max(topK, 20)
    ├─ rerank 精排池头 ≤20，池尾按 RRF 序；未注册 / 失败静默保持 RRF 序
    └─ 组装：final =（rerank 倒数排名分 or RRF 分）×（0.5 + 0.5×confidence）取 topK(8)
        双路全空 → null → 不注入

写入链路：
  run 结束 → queue（按 threadId 合并、debounce 30s）
    → updater（LLM 提取（60s 超时）→ 锁外预演嵌入 → 锁内 RMW 守卫合并；无变更轮次跳过落盘写）
    → storage.update（事务行锁 RMW）
```

## P0（已修复）

### P0-1｜embedding 请求被放在 PG 事务里 await — 已修复（60b888d）

- **原问题**：`updater.ts` 的 `storage.update()` mutator 内 `await embedMissingSections/Facts`（外部 HTTP，最多 2 批 × 64 条，慢则秒级）。`update` 是 `BEGIN → SELECT ... FOR UPDATE → mutator → UPSERT → COMMIT`，mutator 的 await 全程占行锁：同 scope 其它写全部阻塞、连接池被长事务占住、API 挂起时锁不释放。
- **证据**：同仓库 `embeddings.ts` 的 backfill 特意注释「嵌入在锁外进行」——两处风格相反，updater 这处是漏做。
- **修法**（照 backfill 的「锁外嵌入、锁内合并」）：
  1. 锁外：`reload` 最新快照 → `applyUpdates + stripUploadMentions` 预演得 draft → `embedMissingSections/Facts(draft)`（HTTP 不持锁）；
  2. 锁内：fresh 上重跑 `applyUpdates + strip`，`mergePreembeddedVectors` 只合并「内容未变」条目的预嵌向量——facts 按 **content key**（锁内重跑给同一批新 fact 生成的新 id 与 draft 不同，id 对不上）、sections 按槽位+summary；被并发写改动的条目旧向量作废，交检索侧回填重嵌；
  3. 预演失败（reload / 嵌入异常）→ `draft = null`，更新照常落盘、向量留待回填。
- **测试**：`updater.embeddings.test.ts` 新增「嵌入 HTTP 在 update 事务（mutator）之外发起」——包装 storage 记录 embed 调用是否发生在 mutator 执行期间，修复前必挂。

### P0-2｜`SELECT ... FOR UPDATE` 锁不住「还不存在的行」— 已修复（428dc02）

- **原问题**：`pg-storage.ts` `readLocked` 行不存在时返回空 schema 继续 UPSERT。两个进程（PM2 多进程）同时给**新 scope** 首写 → 都读不到行、都拿不到锁 → 都 UPSERT → 后提交者覆盖前者，**lost update**。`queue.ts` 是进程内单例挡不住跨进程；同一用户开两个对话就会撞上（scope = `userId::agentName`，不含 threadId）。
- **修法**：`readLocked` 改为先 `INSERT ... ON CONFLICT DO NOTHING` 造空行，再 `SELECT ... FOR UPDATE`。后到的 INSERT 撞唯一索引阻塞至先者提交，再走 DO NOTHING 读到对方已提交数据——首写真正串行化。mutator 返回未变更 / 抛错时整事务回滚，不残留空行；提交后空行与无行观测等价。
- **测试**：
  - `pg-storage.test.ts`：首写调用序断言（INSERT 造行必须先于 FOR UPDATE）；
  - `pg-storage.integration.test.ts`：「并发首写同一 scope 不丢更新」——两个 update 并发写不存在的 scope，断言两条 fact 都存活（修复前确定性丢一条；本地无 pgvector 跳过，CI 跑）。

## P1 清单（全部已修）

| 位置（修复前）                                          | 问题                                                                                                                                   | 状态            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `pg-storage.ts:184-196`                                 | `load()` 读 state 与读 vectors 是两条独立查询，不在同一快照 → 可能读到「新 jsonb + 旧 vectors」；后果只是漏召回，不崩                  | 已修（8c6e5f8） |
| `pg-storage.ts:188-196`                                 | PG 故障静默退化为空 memory → **分不出「没记忆」和「PG 挂了」**，用户看到记忆消失而日志只有一条 warnOnce                                | 已修（d6bf6e4） |
| `retrieval.ts:521-532`、`embeddings.ts`、`rerank.ts:22` | 降级告警只打一次后永久静默 → 生产上 rerank 一直失败也发现不了。建议加计数器（仓库已有 `memoryUpdateStats` 先例）                       | 已修（b5ef1cf） |
| `retrieval.ts:620`                                      | **不 rerank 时**池宽 = topK = 8，池里 4 个 section 会挤占 fact 名额 → **topK 取不满**；rerank 时池 = 20 无此问题。建议池宽与 topK 解耦 | 已修（ce83373） |

## P2 清单（全部已修 / 已排除）

| 位置（修复前）                         | 问题                                                                                                                                    | 状态                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `retrieval.ts:470`                     | `final` 混两种量纲（rerank 分 ~0.99 vs RRF 分 ~0.016）→ 结果不错，但预览里两个数**不可比**，会误读（代码注释已说明只做同轮相对排序）    | 已修（2130c79）——rerank 分转倒数排名分，与 RRF 同量纲；原始分存 `rerankRaw` |
| `retrieval.ts:547`                     | 预览的 `bm25` 只覆盖 top-50 召回，未进池者显示 0 → 调 debug 时误判「词面完全不匹配」                                                    | 已修（09248d4）                                                             |
| `queue.ts:77-93`                       | 按 threadId 去重只留最新 messages → 30s 内同 thread 多轮只留最后一轮（**待确认**调用方传的是全量历史还是增量）                          | 已排除——调用方传全量过滤历史，留最新不丢信息；语义前提已写入注释（cd2d958） |
| `queue.ts:132`                         | 记忆更新的 LLM 调用无超时 → 挂起则 `processing` 一直 true、队列堆积                                                                     | 已修（ff02e6a）——`updateTimeoutMs` 默认 60s，signal 中止走失败计数          |
| `config.ts:39`                         | `embeddingBackfillOnLoad` 命名与行为不符：实际每次 retrieve 都触发，不是「on load」                                                     | 已修（2835c70）——改名 `embeddingBackfillEnabled`，dict 蛇形键保留兼容       |
| `lib/db/index.ts:158-159`              | 换维度会 `DELETE FROM memory_vectors` 全表 + ALTER → 所有 scope 向量失效、全量重嵌。是设计意图，但要知道代价                            | 已文档化（d5a616c）——CLAUDE.md 已知限制 #10                                 |
| `updater.ts:319` + `pg-storage.ts:242` | `applyUpdates` 总是深拷贝返回新对象，而 `update` 用引用相等判「无变更」→ **每轮记忆更新都全量 DELETE+INSERT 向量行**（≤104 行，可接受） | 已修（8f75af3）——惰性拷贝，无变更返回原引用，判等生效跳过落盘写             |

## 顺带排除的四个误判

原本怀疑、读代码后确认**没问题**：

1. **rerank 返回分数变短会「缺位补 0」** —— 不会。`rerank.ts:63` 有长度校验，不等长直接返回 null 回落 RRF 序。
2. **DELETE+INSERT 重建会丢已有向量** —— 不会。`applyUpdates` 深拷贝的是 hydrate 过的 `current`，已有 fact 的 embedding 被带着重新插入。
3. **SQL 注入** —— 全参数化，`insertVectors` 动态拼的只有 `$n` 占位符。
4. **不水合导致每轮全量重嵌** —— `update` 内先 `hydrateVectors` 再交 mutator，守卫是对的。

## CLAUDE.md §8 核对结论

§8 记忆架构叙述逐条对过代码，**基本准确**（含「水合是硬约束」「0.6 是路 A 门槛」「rerank 只看相对序」这些容易写错的地方），不需要改。

## 词面路 BM25 替换（review 追加发现，9cda328）

review 时发现计划里写的是 **BM25**、实现却沿用旧的 `overlapRatio`（|交集|/|query| 启发式）。已彻底替换：

- JS 实现 BM25+：语料 = facts + 4 召回 section（≤104 篇全在内存，idf 查询时现算）；idf `ln(1+(N−df+0.5)/(df+0.5))` 恒非负；k1=1.5 tf 饱和、b=0.75 长度归一；query 按唯一 term 求和（多轮拼接不被未命中词稀释）；tokenize 复用（latin 词 + CJK 单字/二元组，STOP_WORDS 过滤）。
- 与 obsidian-rag 的 SQLite FTS5 内置 BM25 同语义；PG FTS 对中文无可用分词扩展，SQLite FTS5 不在本技术栈，故 JS 现算。
- 词面分字段 `lexical` → `bm25`（无上界，只做同轮相对排序——idf 随语料变化，跨轮不可比）。
