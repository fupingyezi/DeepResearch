import { chatWithChatAssistant } from "./chat-with-chat-assistant";
import { chatWithDeepResearch } from "./chat-with-deep-research";
import { chatWithSearhAssistant } from "./chat-with-search-assistant";
import { reChatWithAssistantProps } from "@/types";

export async function reChatWithAssistant(
  reChatWithAssistantParmas: reChatWithAssistantProps
) {
  const { inputValue, mode, callingMode, ...props } = reChatWithAssistantParmas;
  const { resetState } = props;

  switch (mode) {
    case "chat": {
      await chatWithChatAssistant({
        inputValue,
        callingMode,
        ...props,
      });
      return;
    }
    case "search": {
      await chatWithSearhAssistant({
        inputValue,
        callingMode,
        ...props,
      });
      return;
    }
    case "deepResearch": {
      resetState();
      await chatWithDeepResearch({
        inputValue,
        callingMode,
        ...props,
      });
    }
  }
}
