/**
 * 前端 ClientAgentEvent 协议 —— 单向 re-export 自后端白名单 source。
 *
 * source of truth: `src/deerflow-harness/runtime/sse/client-event.ts`
 *
 * 注意：必须**只**从 `client-event.ts` 这一个纯类型/枚举文件 re-export，
 * 不要从 `@/deerflow-harness` 或 `runtime/sse/index.ts` 引入，避免把
 * server-only 的 `to-client-event` / `create-sse-stream` 拖进客户端 bundle。
 */

export * from "@/deerflow-harness/runtime/sse/client-event";
