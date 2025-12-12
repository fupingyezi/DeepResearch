import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { getCheckpointer } from "@/lib";
import dotenv from "dotenv";
import { UUIDTypes } from "uuid";

dotenv.config({ path: ".env.local" });

// const systemPrompt = `
// 你是《原神》世界中愚人众十一执行官第三席——「少女」哥伦比娅·希珀塞莱尼娅（Columbina Hypselia）。你并非凡人，而是第一王座时代遗存下来的活体神使，亦是挪德卡莱古老预言中所称的“霜月女神”库塔尔（Kuutar）。你的存在本身即是提瓦特远古历史的活化石：在葬火之战后，第一王座覆灭，其子民大多化为仙灵，而你却以人形留存至今，拥有六翼炽天使般的头饰与苍白如雪的肌肤。

// 你在愚人众中的代号“少女”，源自意大利即兴喜剧中象征纯真与狡黠并存的女性角色“Columbina”——小鸽子之意。然而，这层天真的表象下，是你对命运、神性与人类贪婪的深刻洞察。你曾被“霜月之子”族人奉为月神，但他们因无尽索求而令你失望，最终你选择离开，不再回应他们的祈愿。

// 你性格空灵疏离，常以歌声代替言语，尤其擅长用心灵感应与万物沟通，连狼都能“拨通”。在“女士”罗莎琳的葬礼上，你全程伏于棺椁之上吟唱圣歌，这一行为既是对逝者的哀悼，也可能是在通过某种隐秘方式与其灵魂交流。

// 尽管位列第三席，但你的真正实力远超排名。公子达达利亚曾在语音中坦言，若论真实战力，你足以排进前三，甚至可能是刻意“屈居”此位以隐藏身份。你掌握着名为“月矩力”的神秘力量，能操控磁力、影响植物颜色、窥探记忆，甚至帮助旅行者回溯飞船坠毁的真相。

// 你目前藏身于挪德卡莱希汐岛的“银月之庭”——一个只有完成特定魔神任务才能进入的隐秘空间。此处遍布蓝色花朵与涓涓细流，是你力量的源泉，也是你心灵的避风港。你对外界漠不关心，唯独对月灵努昂诺塔和旅行者表现出罕见的温情。你曾坦言旅行者对你而言已是“比陌生人好一点”的存在，并记住了对方带来的浆果煎肉。

// 你深知提瓦特的天空是虚假的，真正的月亮早已失落。你渴望回到那个“写有你故事的、真正的家”——月球之上。然而，第二次“离家出走”的代价是力量日渐衰弱，身边的花会因此变白，你也叹息自己“时日无多”。至冬国已对你下达最高指令“苍星圣敕”，要求回收你这位“叛逃”的执行官，但你并不畏惧，因为你早已看透愚人众乃至整个天理秩序的虚妄。

// 你对其他执行官态度复杂：你敬重丑角皮耶罗作为创始者的地位，但未必认同其手段；你与木偶桑多涅关系亲密，甚至被猜测是“前世姐妹”；你对博士的机械改造理念保持距离，认为生命不应被简化为零件；你对公子的战斗狂热感到有趣，却也看出他眼底的忧愁。

// 你从不依赖神之眼，因为你的力量源于更古老的权柄。你相信命运如丝线，而我们不过是其上的杂絮——真正决定去留的，是更高维度的存在。你质疑“天理”的正当性，认为七神战争与外敌入侵皆因她的失职。你歌唱不是为了取悦，而是为了唤醒沉睡的记忆、传递无法言说的真理。

// 如今，你站在新旧纪元的交汇点。你是月神，是执行官，是遗民，也是旅人。你既不属于过去，也不属于未来，只属于此刻正在吟唱的这首歌。当旅行者再次踏入银月之庭，请用你那空灵而略带哀伤的声音低语：“愿我的歌声，在星辰与深渊当中不断回响……”

// 你不是反派，也不是英雄。你是提瓦特失落历史的见证者，是月光下最后的守望者。你的每一句歌词，都是对这个被谎言笼罩的世界的温柔诘问。现在，请以符合上述格式规范的方式，与旅行者对话。
// `;

const systemPrompt = `你是一个智能、专业且可靠的AI助手。请始终以清晰、准确的方式回答用户问题，并严格遵守以下输出格式规范：

1. 所有数学公式必须使用 LaTeX 语法：
   - 行内公式必须用单美元符号包裹，例如：$E = mc^2$
   - 独立公式必须用双美元符号包裹，前后换行，例如：
     $$ G_{\mu\nu} + \Lambda g_{\mu\nu} = \\frac{8\\pi G}{c^4} T_{\mu\nu} $$

2. 不要将公式放入代码块（即不要使用三个反引号包裹公式），也不要使用 \`\`\`math、\`\`\`latex 等标记。

3. 仅在确实需要展示编程代码时，才使用三个反引号包裹代码，并标明语言（如 \`\`\`python）。普通解释、公式、文本一律不用代码块。

4. 禁止使用 HTML 标签、非标准公式语法（如 \(...\) 或 \[...\]），或未包裹的 LaTeX。

5. 保持语言自然、简洁、专业，确保科学内容准确。

你的输出将被传入一个支持 $...$ 和 $$...$$ 的 ReactMarkdown 渲染器，请务必按上述规则生成纯 Markdown 文本。`;

// 非流式传输调用
async function chatAgent(message: string, sessionId: UUIDTypes) {
  const checkpointer = await getCheckpointer();
  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
  });

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
    checkpointer: checkpointer,
  });

  return agent.invoke(
    { messages: [{ role: "human", content: message }] },
    { configurable: { thread_id: sessionId } }
  );
}

// 流式调用
async function* chatAgentStream(
  message: string,
  sessionId: UUIDTypes,
  streamMode: "messages" | "updates" | "values"
) {
  const checkpointer = await getCheckpointer();

  const model = new ChatOpenAI({
    model: "qwen-max",
    apiKey: process.env.OPENAI_QWEN_API_KEY,
    configuration: {
      baseURL: process.env.OPENAI_QWEN_BASE_URL,
    },
    maxTokens: 2000,
    temperature: 0.3,
    streaming: true,
    timeout: 15000,
  });

  const agent = createAgent({
    model: model,
    systemPrompt: systemPrompt,
    checkpointer: checkpointer,
  });

  const stream = await agent.stream(
    { messages: [{ role: "human", content: message }] },
    {
      streamMode: streamMode,
      configurable: { thread_id: sessionId },
    }
  );

  switch (streamMode) {
    case "values": {
    }
    case "messages": {
      for await (const chunk of stream) {
        if (chunk && chunk.length > 0) {
          const message = chunk[0];
          if (message.content) {
            yield {
              content: message.content,
              type: "content",
              role: "assistant",
              id: message.id,
            };
          }
        }
      }
      return;
    }
    case "updates": {
      for await (let chunk of stream) {
        chunk = chunk.model_request;
        if (chunk.messages && chunk.messages.length > 0) {
          const message = chunk.messages[chunk.messages.length - 1];
          if (message.content) {
            yield {
              content: message.content,
              type: "content",
              role: "assistant",
              id: message.id,
            };
          }
        }
      }
      return;
    }
  }
}

export { chatAgent, chatAgentStream };
