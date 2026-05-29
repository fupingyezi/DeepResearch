import type { AIMessage, BaseMessage } from '@langchain/core/messages';

/**
 * 一条工具调用完整性规则。
 *
 * 设计意图：把"消息层面的 tool_call/tool_result 修复"从一个个特化中间件
 * 抽离成可插拔规则。新增异常类型只需追加一个 Rule 实现，不再增加中间件。
 *
 * 钩子语义：
 *  - sanitizeHistory：在调用底层 model 之前清洗 `request.messages`。
 *    返回 null 表示不需要任何变更，避免无谓的浅拷贝；返回新数组则替换。
 *  - sanitizeOutput：在底层 model 返回之后、ToolNode 派发之前，
 *    直接 mutate 模型刚生成的 AIMessage（与 LangChain 内部对 AIMessage
 *    可写的约定一致）。规则若不关心模型出口可不实现。
 *
 * 规则按数组顺序串行执行；前一条规则的输出作为后一条规则的输入。
 */
export interface IntegrityRule {
  readonly name: string;
  sanitizeHistory?(
    messages: BaseMessage[],
    ctx: RuleContext,
  ): BaseMessage[] | null;
  sanitizeOutput?(message: AIMessage, ctx: RuleContext): void;
}

/**
 * 规则上下文：从 wrapModelCall 的 request 派生的不变量，按需扩展。
 */
export interface RuleContext {
  readonly knownToolNames: ReadonlySet<string>;
}
