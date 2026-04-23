import { Command, interrupt } from "@langchain/langgraph";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import ResearchStateAnnotation from "./workState";

export async function humanDecision(state: typeof ResearchStateAnnotation) {
  // 发射 human_interrupt 自定义事件，通知前端需要人工决策
  await dispatchCustomEvent("human_interrupt", {
    question: "是否满意当前任务划分？",
    details: state,
  });

  const nextNode = interrupt({
    question: "是否满意当前任务划分？",
    details: state,
  });

  return new Command({ goto: `${nextNode}` });
}
