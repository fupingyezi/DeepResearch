import { createDeepResearchWorkflow } from "@/app/agents";
import { handleStateUpdate } from "@/utils/handleStateUpdate";
import { createSSEStream } from "@/app/api/utils/createSSEStream";
import { Command } from "@langchain/langgraph";

export async function POST(request: Request) {
  const { input, deepResearchId, isResume } = await request.json();
  const deepResearchWorkflow = await createDeepResearchWorkflow();
  if (!input && isResume === undefined) {
    return new Response(
      JSON.stringify({ error: "Missing input or isResume" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const readableStream = createSSEStream(request, async (enqueue) => {
    let lastState: any = null;
    enqueue({ type: "start", timeStamp: Date.now() });

    const getStream = async () => {
      if (isResume === undefined) {
        return deepResearchWorkflow.stream(
          {
            input: input,
            simpleAnalysis: "",
            messages: [],
            tasks: [],
            nextAction: "",
            report: "",
          },
          {
            configurable: { thread_id: deepResearchId },
            streamMode: "values",
            recursionLimit: 200,
          }
        );
      } else {
        return deepResearchWorkflow.stream(new Command({ resume: isResume }), {
          configurable: { thread_id: deepResearchId },
          streamMode: "values",
          recursionLimit: 200,
        });
      }
    };

    for await (const state of await getStream()) {
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
