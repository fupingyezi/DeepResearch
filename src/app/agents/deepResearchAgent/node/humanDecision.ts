import { Command, interrupt } from "@langchain/langgraph";
import ResearchStateAnnotation from "../workState";

export async function humanDecision(state: typeof ResearchStateAnnotation) {
  const nextNode = interrupt({
    question: "是否满意当前任务划分？",
    details: state,
  });

  return new Command({ goto: `${nextNode}` });
}
