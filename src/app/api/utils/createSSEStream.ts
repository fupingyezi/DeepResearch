import { SSEEvent } from "@/types";

export function createSSEStream(
  request: Request,
  handler: (enqueue: (data: any) => boolean) => Promise<void>
) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let aborted = false;

      const cleanup = () => (aborted = true);
      request.signal?.addEventListener("abort", cleanup);

      const safeEnqueue = (data: SSEEvent): boolean => {
        if (aborted) return false;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
          return true;
        } catch (e) {
          console.error("Enqueue failed", e);
          aborted = true;
          return false;
        }
      };

      try {
        await handler(safeEnqueue);
        if (!aborted) {
          safeEnqueue({ type: "done", done: true });
        }
      } catch (error) {
        if (!aborted) {
          safeEnqueue({
            type: "error",
            content: "Stream error occurred",
            done: true,
          });
        }
      } finally {
        request.signal?.removeEventListener("abort", cleanup);
        if (!controller.desiredSize) controller.close();
      }
    },
  });
}
