import { StateGraph, START, END } from "@langchain/langgraph";
import { supervisor } from "./supervisor";
import { simpleAnalyser } from "./simpleAnalyser";
import { taskDecomposer } from "./taskDecomposer";
import { taskHandler } from "./taskHandler";
import { reportGenerationAssitant } from "./reportGenerationAssitant";
import { humanDecision } from "./humanDecision";

import { getCheckpointer } from "@/lib";
import ResearchStateAnnotation from "./workState";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

/**
 * DeepResearch 工作流节点名称常量
 * 用于 EventStreamAdapter 识别 node_enter/node_exit 事件
 */
export const DEEP_RESEARCH_NODE_NAMES = [
  "supervisor",
  "simpleAnalyser",
  "taskDecomposer",
  "taskHandler",
  "reportGenerationAssitant",
  "humanDecision",
];

async function createDeepResearchWorkflow() {
  const checkpointer = await getCheckpointer();
  const workflow = new StateGraph(ResearchStateAnnotation)
    // 为每个节点添加 metadata.tags 标注，以便 streamEvents 精确识别
    .addNode("supervisor", supervisor, {
      metadata: { tags: ["deep_research", "supervisor"] },
    })
    .addNode("simpleAnalyser", simpleAnalyser, {
      metadata: { tags: ["deep_research", "simpleAnalyser"] },
    })
    .addNode("taskDecomposer", taskDecomposer, {
      metadata: { tags: ["deep_research", "taskDecomposer"] },
    })
    .addNode("taskHandler", taskHandler, {
      metadata: { tags: ["deep_research", "taskHandler"] },
    })
    .addNode("reportGenerationAssitant", reportGenerationAssitant, {
      metadata: { tags: ["deep_research", "reportGenerationAssitant"] },
    })
    .addNode("humanDecision", humanDecision, {
      metadata: { tags: ["deep_research", "humanDecision"] },
    })

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
    .addEdge("taskHandler", "supervisor")
    .addEdge("reportGenerationAssitant", "supervisor")

    .compile({ checkpointer });

  return workflow;
}

export { createDeepResearchWorkflow };
