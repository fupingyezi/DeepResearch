/**
 * HumanReviewHook - 人工审核钩子
 *
 * 将现有的 humanDecision 节点功能迁移为 Harness PreExecute Hook。
 * 在 Sub-agent 执行前检查是否需要人工审核，
 * 当需要时发射 HumanInterruptEvent 并暂停执行。
 *
 * 迁移自 deepResearchWrokFlow/humanDecision.ts
 */

import { interrupt } from "@langchain/langgraph";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import {
  PreExecuteHook,
  HookPhase,
  HookScope,
  HookFailureStrategy,
  HookResult,
} from "../hooks";
import { HarnessContext } from "../types";

/**
 * HumanReviewHook
 *
 * 作为 PreExecuteHook，在 Sub-agent 执行前检查是否需要人工审核。
 * 当需要人工审核时：
 * 1. 发射 human_interrupt 自定义事件通知前端
 * 2. 调用 LangGraph 的 interrupt() 暂停执行
 * 3. 等待用户通过 Command({ resume }) 恢复
 */
export const HumanReviewHook: PreExecuteHook = {
  name: "HumanReviewHook",
  phase: HookPhase.PRE_EXECUTE,
  scope: HookScope.INSTANCE,
  priority: 50,
  onFailure: HookFailureStrategy.SKIP,
  target: "taskDecomposer",

  async execute(context: HarnessContext): Promise<HookResult<HarnessContext>> {
    // 检查上下文中是否标记需要人工审核
    const needsReview = context.state.needsHumanReview;

    if (!needsReview) {
      // 不需要人工审核，继续执行
      return { abort: false, data: context };
    }

    try {
      // 发射 human_interrupt 自定义事件，通知前端需要人工决策
      await dispatchCustomEvent("human_interrupt", {
        question: "是否满意当前任务划分？",
        details: {
          tasks: context.state.tasks,
          researchTarget: context.state.researchTarget,
        },
      });

      // 调用 LangGraph 的 interrupt() 暂停执行
      // 用户通过 Command({ resume }) 恢复后，nextNode 为恢复目标
      const nextNode = interrupt({
        question: "是否满意当前任务划分？",
        details: {
          tasks: context.state.tasks,
        },
      });

      // 将恢复决策存入上下文
      context.state.humanDecision = nextNode;

      return { abort: false, data: context };
    } catch (error: any) {
      console.error("[HumanReviewHook] Error during human review:", error.message);
      // 人工审核失败时跳过（onFailure=skip），继续执行
      return { abort: false, data: context };
    }
  },
};

/**
 * 创建 HumanReviewHook 实例的工厂函数
 *
 * 支持自定义审核问题和目标 Agent
 */
export function createHumanReviewHook(options?: {
  question?: string;
  target?: string;
  priority?: number;
}): PreExecuteHook {
  return {
    ...HumanReviewHook,
    target: options?.target || HumanReviewHook.target,
    priority: options?.priority || HumanReviewHook.priority,

    async execute(context: HarnessContext): Promise<HookResult<HarnessContext>> {
      const needsReview = context.state.needsHumanReview;

      if (!needsReview) {
        return { abort: false, data: context };
      }

      try {
        const question = options?.question || "是否满意当前任务划分？";

        await dispatchCustomEvent("human_interrupt", {
          question,
          details: {
            tasks: context.state.tasks,
            researchTarget: context.state.researchTarget,
          },
        });

        const nextNode = interrupt({
          question,
          details: { tasks: context.state.tasks },
        });

        context.state.humanDecision = nextNode;

        return { abort: false, data: context };
      } catch (error: any) {
        console.error("[HumanReviewHook] Error:", error.message);
        return { abort: false, data: context };
      }
    },
  };
}
