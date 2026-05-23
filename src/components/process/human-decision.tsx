import { Button, Alert } from "antd";
import { chatWithDeepResearch } from "@/utils/chat";
import { useDeepResearchProcessStore, useConversationStore } from "@/store";

export const HumanDecision = () => {
  const { interruptRequest, setStatus } = useDeepResearchProcessStore();
  const conversationStore = useConversationStore();
  const deepResearchStore = useDeepResearchProcessStore();
  const handleInterrupt = async (decision: boolean) => {
    setStatus("processing");
    await chatWithDeepResearch({
      // v3 route 校验 input 非空；用决策文本作为 user 下一轮消息，
      // 后端 checkpointer 自动续接上一轮 messages，模型能读到 plan/clarification 上下文。
      inputValue: decision ? "确认" : "拒绝",
      callingMode: "resume",
      ...conversationStore,
      ...deepResearchStore,
      isResume: decision,
    });
  };
  return (
    <div className="w-full flex flex-col items-end gap-2 my-2">
      <Alert
        className="w-full"
        message={interruptRequest?.question || ""}
        type="info"
      />
      <div className="flex gap-2">
        <Button type="primary" onClick={() => handleInterrupt(true)}>
          accept
        </Button>
        <Button color="danger" onClick={() => handleInterrupt(false)}>
          reject
        </Button>
      </div>
    </div>
  );
};
