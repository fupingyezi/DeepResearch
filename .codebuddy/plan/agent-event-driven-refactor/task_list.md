# 任务跟踪

- [x] 1. 定义统一事件协议类型系统 — `src/types/agentEvent.ts` 已创建，`types/index.ts` 已导出
- [x] 2. 实现 EventStreamAdapter — `src/app/agents/eventStream/` 已创建
- [x] 3. 重构 Agent 基类为组合模式架构 — `BaseAgentServer.ts` + `modules/` 已完成
- [x] 4. 迁移 ChatAgentServer 和 SearchAgentServer 到新架构 — 已使用 StreamProcessor
- [x] 5. 改造 DeepResearch 工作流为事件驱动模式 — 所有节点已添加 dispatchCustomEvent
- [x] 6. 重构 AgentManager 支持事件总线和动态注册 — EventBus + registerAgent 已完成
- [x] 7. 构建统一 SSE 传输层和合并 API 路由 — `createAgentEventSSEStream.ts` + `v2/route.ts` 已创建
- [x] 8. 重构前端统一事件消费层 — `EventConsumer.ts` 已创建
- [x] 9. 迁移前端调用层到 v2 API — chatWithChatAssistant/chatWithSearchAssistant/chatWithDeepResearch 已迁移到 /api/chat/v2
- [x] 10. 端到端集成验证与旧代码清理 — handleStateUpdate 标记 deprecated，v1 路由标记 deprecated，ApiStream/ApiStreamChunk 标记 deprecated，createSSEStream 标记 deprecated，supervisor.ts 清理无用导入
