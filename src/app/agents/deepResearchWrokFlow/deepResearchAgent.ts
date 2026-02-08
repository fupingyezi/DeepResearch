import { StateGraph, START, END } from "@langchain/langgraph";
import { supervisor } from "./supervisor";
import { simpleAnalyser } from "./simpleAnalyser";
import { taskDecomposer } from "./taskDecomposer";
import { taskHandler } from "./taskHandler";
import { reportGenerationAssitant } from "./reportGenerationAssitant";
import { humanDecision } from "./humanDecision";

// import { getCheckpointer } from "@/lib";
import ResearchStateAnnotation from "./workState";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function createDeepResearchWorkflow() {
  // 暂时注释掉数据库相关的checkpointer代码
  // const checkpointer = await getCheckpointer();
  const workflow = new StateGraph(ResearchStateAnnotation)
    .addNode("supervisor", supervisor)
    .addNode("simpleAnalyser", simpleAnalyser)
    .addNode("taskDecomposer", taskDecomposer)
    .addNode("taskHandler", taskHandler)
    .addNode("reportGenerationAssitant", reportGenerationAssitant)
    .addNode("humanDecision", humanDecision)

    .addEdge(START, "supervisor")

    .addConditionalEdges("supervisor", (state) => state.nextAction, {
      simpleAnalyser: "simpleAnalyser",
      taskDecomposer: "taskDecomposer",
      taskHandler: "taskHandler",
      reportGenerationAssitant: "reportGenerationAssitant",
      __end__: END,
    })

    .addConditionalEdges(
      "taskDecomposer",
      (state) => {
        if (state.needsHumanReview) {
          return "humanDecision";
        } else {
          return "supervisor";
        }
      },
      { humanDecision: "humanDecision", supervisor: "supervisor" },
    )

    .addEdge("simpleAnalyser", "supervisor")
    // .addEdge("taskDecomposer", "supervisor")
    .addEdge("taskHandler", "supervisor")
    .addEdge("reportGenerationAssitant", "supervisor")

    .compile();

  return workflow;
}

export { createDeepResearchWorkflow };
