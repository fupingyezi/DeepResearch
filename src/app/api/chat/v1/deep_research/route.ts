import { createDeepResearchWorkflow } from "@/app/agents";
import { handleStateUpdate } from "@/utils/handleStateUpdate";
import { createSSEStream } from "@/app/api/utils/createSSEStream";

export async function POST(request: Request) {
  const { input, sessionId } = await request.json();
  const deepResearchWorkflow = await createDeepResearchWorkflow();
  if (!input) {
    return new Response(JSON.stringify({ error: "Missing input" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const readableStream = createSSEStream(request, async (enqueue) => {
    let lastState: any = null;
    enqueue({ type: "start", timeStamp: Date.now() });

    for await (const state of await deepResearchWorkflow.stream(
      {
        input: input,
        simpleAnalysis: "",
        messages: [],
        tasks: [],
        nextAction: "",
        report: "",
      },
      {
        configurable: { thread_id: `dr-${sessionId}-${Date.now()}` },
        streamMode: "values",
        recursionLimit: 200,
      }
    )) {
      const updateState = handleStateUpdate(lastState, state);
      if (updateState) {
        enqueue(updateState);
        lastState = state;
      }
    }
  });

  return new Response(readableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
