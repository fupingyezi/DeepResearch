import type { taskType, searchResultItem } from "@/types";

export function handleStateUpdate(prevState: any, currentState: any) {
  const delta: Record<string, any> = {};
  // console.log("currentState:", currentState);

  if (currentState.simpleAnalysis && !prevState?.simpleAnalysis) {
    delta.type = "start_analyse";
    delta.payload = {
      simpleAnalysis: currentState.simpleAnalysis,
      researchTarget: currentState.researchTarget,
    };
  } else if (
    currentState.tasks?.length &&
    (!prevState?.tasks || prevState.tasks.length === 0)
  ) {
    delta.type = "tasks_initial";
    delta.payload = currentState.tasks;
  } else if (currentState.tasks?.length && prevState?.tasks?.length) {
    const updatedTask = currentState.tasks.find(
      (task: taskType) =>
        task.status !==
        prevState.tasks.find(
          (pretask: taskType) => pretask.taskId === task.taskId
        )?.status
    );
    if (updatedTask) {
      delta.type = "task_update";
      delta.payload = updatedTask;
    }
  }

  if (currentState.summary && !prevState?.summary) {
    delta.type = "summary";
    delta.payload = currentState.summary;
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
