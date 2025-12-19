import CustomMarkdown from "../Markdown/CustomMarkdown";
import { Title } from "./Title";

export const Report: React.FC<{ report: string }> = ({ report }) => {
  return (
    <div className="w-full flex flex-col gap-3 border-t-2 border-[#f4f4f4] py-4">
      <Title title="最终报告结果" className="font-bold text-2xl"></Title>
      <CustomMarkdown content={report} />
    </div>
  );
};
