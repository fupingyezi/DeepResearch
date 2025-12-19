import {
  ArrowUpOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import CustomMarkdown from "../Markdown/CustomMarkdown";
import { Title } from "./Title";

import { taskType } from "@/types";

export const TaskProcessingItem: React.FC<{
  task: taskType;
  isShow: boolean;
}> = ({ task, isShow }) => {
  if (!isShow) return null;

  return (
    <div className="w-full mt-4 p-4">
      <div className="flex gap-2">
        <div>
          {task.result ? (
            <CheckCircleOutlined style={{ color: "green" }} />
          ) : (
            <LoadingOutlined />
          )}
        </div>
        <Title title={task.description} />
      </div>
      <div className="pl-6 mt-4">
        <CustomMarkdown content={task.result || ""} />
        <div className="bg-[#f4f4f4] rounded-xl p-3 mt-2">
          {task.searchResult && task.searchResult.length > 0 ? (
            <ul className="space-y-1.?('text-xs') text-gray-700  list-none">
              {task.searchResult.map((item, idx) => {
                const displayTitle = item.title || "未命名页面";
                return (
                  <a
                    key={idx}
                    href={item.sourceUrl}
                    target="_blank"
                    title={`来源: ${item.sourceUrl}`}
                  >
                    <li
                      key={idx}
                      className="flex items-center justify-between py-1 text-gray-500 hover:text-blue-600 hover:cursor-pointer transition-colors"
                    >
                      <span className="text-sm font-medium truncate max-w-[80%]">
                        {displayTitle}
                      </span>

                      <ArrowUpOutlined rotate={45} />
                    </li>
                  </a>
                );
              })}
            </ul>
          ) : (
            <div className="text-xs text-gray-500 italic">暂无相关搜索结果</div>
          )}
        </div>
      </div>
    </div>
  );
};
