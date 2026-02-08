// import { NextRequest, NextResponse } from "next/server";
// import { SSEEvent } from "@/types";
// import { createSSEStream } from "../../utils/createSSEStream";

// export async function POST(request: NextRequest) {
//   try {
//     const { input, sessionId, stream = true } = await request.json();

//     if (!input) {
//       return NextResponse.json({ error: "input is empty" }, { status: 400 });
//     }

//     const response = await ChatAgentWithSearchTool(input, {
//       configuration: { thread_id: sessionId },
//     });

//     const assistantMessage = response.messages[response.messages.length - 1];
//     const responseContent = assistantMessage.content;

//     const readableStream = createSSEStream(request, async (enqueue) => {
//       enqueue({ type: "start", timeStamp: Date.now() });

//       const chunks = splitContentToChunks(responseContent as string);

//       for (let i = 0; i < chunks.length; i++) {
//         await new Promise((resolve) => setTimeout(resolve, 200));

//         const data = {
//           type: "content",
//           content: chunks[i],
//           role: "assistant",
//           id: i,
//           done: false,
//         } as SSEEvent;
//         if (!enqueue(data)) break;
//       }
//     });

//     return new Response(readableStream, {
//       headers: {
//         "Content-Type": "text/event-stream",
//         "Cache-Control": "no-cache",
//         Connection: "keep-alive",
//       },
//     });
//   } catch (err) {
//     return NextResponse.json(
//       { error: err instanceof Error ? err.message : "Internal server error" },
//       { status: 500 },
//     );
//   }
// }

// function splitContentToChunks(
//   content: string,
//   wordsPerChunk: number = 1,
// ): string[] {
//   const words = content.split(" ");
//   const chunks: string[] = [];

//   for (let i = 0; i < words.length; i += wordsPerChunk) {
//     const chunk = words.slice(i, i + wordsPerChunk).join(" ");
//     if (chunk) chunks.push(chunk + " ");
//   }

//   return chunks;
// }
