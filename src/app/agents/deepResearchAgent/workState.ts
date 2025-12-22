import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "langchain";

import { taskType } from "@/types";

const ResearchStateAnnotation = Annotation.Root({
  input: Annotation<string>(),
  researchTarget: Annotation<string>(),
  simpleAnalysis: Annotation<string>(),
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
  }),
  tasks: Annotation<taskType[]>(),
  nextAction: Annotation<string>(),
  curAction: Annotation<string>(),
  report: Annotation<string>(),
  needsHumanReview: Annotation<boolean>(),
});

export default ResearchStateAnnotation;
