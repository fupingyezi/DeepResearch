import { buildLLM } from "@/lib/llm";
import ResearchStateAnnotation from "./workState";
import { ta } from "zod/v4/locales";

export async function supervisor(state: typeof ResearchStateAnnotation.State) {
  const tasksFinished = state.tasks.every(
    (task) => task.status === "processed",
  );

  let next;

  if (!state.simpleAnalysis) {
    next = "analyse";
  } else if (!state.tasks.length) {
    next = "taskDecomposer";
  } else if (!tasksFinished) {
    next = "process";
  } else if (!state.report) {
    next = "summarize";
  } else {
    next = "end";
  }

  const nodeMap: Record<string, string> = {
    analyse: "simpleAnalyser",
    taskDecomposer: "taskDecomposer",
    process: "taskHandler",
    summarize: "reportGenerationAssitant",
    end: "__end__",
  };

  const nextAction = nodeMap[next] ?? "__end__";
  console.log("Supervisor 决策:", { next, nextAction });

  return { nextAction };
}
