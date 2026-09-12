import apiClient from '@/utils/request/api';

/**
 * 通知服务端取消该会话正在跑的 run —— 「停止」的另一半。
 *
 * 前端 abort 只能断掉本地 SSE：run 在服务端是 fire-and-forget，不显式取消的话它会继续
 * 生成、继续烧 token，并在结束时把**完整回答**落库（用户以为已经停住了，刷新后却看到
 * 完整的、自己已经取消掉的内容）。
 *
 * 失败只记日志：本地 UI 已经停了，一次取消失败不该弹错、也不该把用户卡在运行态。
 * 真正的「同一 thread 不允许两个 run」由服务端 submitRun 的抢占兜底（见 ThreadService）。
 */
export async function cancelRunOnServer(sessionId: string): Promise<void> {
  try {
    await apiClient.post('/conversations/cancel_run', { sessionId });
  } catch (error) {
    console.warn('[cancelRunOnServer] failed:', error);
  }
}

export default cancelRunOnServer;
