"use client";

import { Button } from "antd";
import { chatWithAgent } from "@/utils/chat";
import { useConversationStore } from "@/store";

/**
 * 中断决策（human-in-the-loop）按钮组。
 *
 * 由 MessageTimeline 在 status === 'interrupt' 时挂载本组件。
 * 决策结果通过 chatWithAgent + callingMode='resume' 续接同一会话，
 * 后端 checkpointer 会自动取出上一轮 messages（含 plan/clarification）。
 */
export const HumanDecision: React.FC<{
  onDecide?: (accept: boolean) => void;
}> = ({ onDecide }) => {
  const handleInterrupt = async (decision: boolean) => {
    onDecide?.(decision);
    await chatWithAgent({
      // v3 route 校验 input 非空；用决策文本作为 user 下一轮消息。
      inputValue: decision ? "确认" : "拒绝",
      callingMode: "resume",
      isResume: decision,
      // 事件回调里取最新 store 快照，避免不带 selector 订阅整个 store
      // 在流式 setCurrentMessages 高频触发时引发级联 re-render。
      ...useConversationStore.getState(),
    });
  };

  return (
    <div className="flex gap-2 justify-end mt-1">
      <Button type="primary" onClick={() => handleInterrupt(true)}>
        accept
      </Button>
      <Button color="danger" onClick={() => handleInterrupt(false)}>
        reject
      </Button>
    </div>
  );
};
