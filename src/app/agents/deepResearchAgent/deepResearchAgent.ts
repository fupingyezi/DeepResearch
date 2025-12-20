import { StateGraph, START, END } from "@langchain/langgraph";
import { supervisor } from "./node/supervisor";
import { simpleAnalyser } from "./node/simpleAnalyser";
import { taskDecomposer } from "./node/taskDecomposer";
import { taskHandler } from "./node/taskHandler";
import { reportGenerationAssitant } from "./node/reportGenerationAssitant";
import { humanDecision } from "./node/humanDecision";

import { getCheckpointer } from "@/lib";
import ResearchStateAnnotation from "./workState";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function createDeepResearchWorkflow() {
  const checkpointer = await getCheckpointer();
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
      { humanDecision: "humanDecision", supervisor: "supervisor" }
    )

    .addEdge("simpleAnalyser", "supervisor")
    // .addEdge("taskDecomposer", "supervisor")
    .addEdge("taskHandler", "supervisor")
    .addEdge("reportGenerationAssitant", "supervisor")

    .compile({ checkpointer });

  return workflow;
}

export { createDeepResearchWorkflow };
