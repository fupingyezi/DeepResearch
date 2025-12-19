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
  tasks: Annotation<taskType[]>({
    reducer: (old, update) => {
      const map = new Map((old || []).map((t) => [t.taskId, t]));
      for (const t of update || []) {
        map.set(t.taskId, { ...map.get(t.taskId), ...t });
      }
      return Array.from(map.values());
    },
  }),
  nextAction: Annotation<string>(),
  report: Annotation<string>(),
});

export default ResearchStateAnnotation;
