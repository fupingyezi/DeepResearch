import type { taskType, searchResultItem } from "@/types";

/**
 * @deprecated 此函数已被 v2 事件驱动架构中的 EventStreamAdapter + dispatchCustomEvent 替代。
 * 新架构下，工作流节点通过 dispatchCustomEvent 直接发射事件，无需手动做状态 diff。
 * 保留此函数仅用于 v1 路由的向后兼容。
 */
export function handleStateUpdate(prevState: any, currentState: any) {
  const delta: Record<string, any> = {};
  // console.log("currentState:", currentState);

  if (
    currentState?.curAction === "simpleAnalyse" &&
    !prevState?.simpleAnalysis
  ) {
    delta.type = "start_analyse";
    delta.payload = {
      simpleAnalysis: currentState.simpleAnalysis,
      researchTarget: currentState.researchTarget,
    };
  } else if (currentState?.curAction === "taskDecompose") {
    delta.type = "tasks_initial";
    delta.payload = currentState.tasks;
  } else if (currentState?.curAction === "taskHandle") {
    const updatedTask = currentState.tasks.find(
      (task: taskType) =>
        task.status !==
        prevState?.tasks?.find(
          (pretask: taskType) => pretask.taskId === task.taskId,
        )?.status,
    );
    if (updatedTask) {
      delta.type = "task_update";
      delta.payload = updatedTask;
    }
  } else if (currentState?.curAction === "report" && !prevState?.report) {
    delta.type = "report";
    delta.payload = currentState.report;
  } else if (currentState.__interrupt__ && !prevState?.__interrupt__) {
    delta.type = "interrupt";
    const length = currentState.__interrupt__.length;
    delta.payload = currentState.__interrupt__[length - 1].value;
  }

  return Object.keys(delta).length ? delta : null;
}

export function parseSearchResult(searchResult: string): searchResultItem[] {
  if (!searchResult.trim()) return [];

  const rawBlocks = searchResult
    .split(/\s*---\s*/)
    .map((block) => block.trim())
    .filter(Boolean);

  const results: searchResultItem[] = [];

  for (const block of rawBlocks) {
    if (!block.includes("标题:")) continue;

    const extractField = (label: string): string => {
      const regex = new RegExp(`${label}:\\s*(.*?)(?=\\n|$)`, "s");
      const match = block.match(regex);
      return match ? match[1].trim() : "";
    };

    const title = extractField("标题");
    const sourceUrl = extractField("来源");
    let content = extractField("内容");
    const scoreStr = extractField("相关性评分");

    if (!content || content === "内容:") {
      content = "";
    }

    const relativeScore = parseFloat(scoreStr) || 0;

    results.push({
      title,
      sourceUrl,
      content,
      relativeScore,
    });
  }

  return results;
}
