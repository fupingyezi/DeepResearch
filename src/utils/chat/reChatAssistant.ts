import { chatWithChatAssistant } from "./chatWithChatAssistant";
import { chatWithDeepResearch } from "./chatWithDeepResearch";
import { chatWithSearhAssistant } from "./chatWithSearchAssistant";
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
