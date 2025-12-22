import { Command, interrupt } from "@langchain/langgraph";
import ResearchStateAnnotation from "../workState";

export async function humanDecision(state: typeof ResearchStateAnnotation) {
  // const isApproved = interrupt({
  //   question: "是否执行下一步？",
  //   details: state,
  // });
  // console.log("isApproved:", isApproved);

  // if (isApproved) {
  //   return new Command({ goto: "supervisor" });
  // } else {
  //   return new Command({ goto: "taskDecomposer" });
  // }

  const nextNode = interrupt({
    question: "是否满意当前任务划分？",
    details: state,
  });

  return new Command({ goto: `${nextNode}` });
}
