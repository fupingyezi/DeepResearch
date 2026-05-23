import Image from "next/image";
import { Button, message as antdMessage } from "antd";
import MessageToolBar from "../message-tool-bar/message-tool-bar";

import { useCopy } from "@/utils/hooks";
import {
  handleDownloadPDF,
  handleDownloadDOC,
  handleDownloadMD,
} from "@/utils/files/file-download";

import { MessageToolType, SupportDownloadFileType } from "@/types";

export interface ProcessHeaderProps {
  researchTarget: string;
  report: string;
  setIsOpen: (isOpen: boolean) => void;
  selectedTab: "report" | "process";
  setSelectedTab: (selectedTab: "report" | "process") => void;
}

export const ProcessHeader: React.FC<ProcessHeaderProps> = ({
  researchTarget,
  report,
  setIsOpen,
  selectedTab,
  setSelectedTab,
}) => {
  const { copyToClipboard } = useCopy();

  const renderOtherOperations = () => {
    const tools: MessageToolType[] = ["copy", "download"];
    const supportDownloadFiles: SupportDownloadFileType[] = [
      "pdf",
      "word",
      "md",
      "cancel",
    ];

    const handleOperator = async (
      op: "copy" | "edit" | "recall" | "download"
    ) => {
      switch (op) {
        case "copy": {
          copyToClipboard(report);
          return;
        }
      }
    };

    const handleDownloadFiles = (fileType: SupportDownloadFileType) => {
      switch (fileType) {
        case "pdf": {
          handleDownloadPDF(report);
          return;
        }
        case "word": {
          handleDownloadDOC(report);
          return;
        }
        case "md": {
          handleDownloadMD(report);
          return;
        }
        case "cancel": {
          return;
        }
      }
    };
    if (selectedTab === "process") return null;
    return (
      <MessageToolBar
        tools={tools}
        handleToolAction={handleOperator}
        supportDownloadFiles={supportDownloadFiles}
        handleDownloadFiles={handleDownloadFiles}
      />
    );
  };

  const handleSelect = () => {
    if (selectedTab === "process") setSelectedTab("report");
    else setSelectedTab("process");
  };
  return (
    <div className="w-full sticky top-0 flex justify-between items-center py-2 bg-white z-10">
      <div className="w-[70%] text-xl font-bold">课题：{researchTarget}</div>
      <div className="flex gap-2">
        <Button onClick={() => handleSelect()}>
          {selectedTab === "process" ? "查看结果" : "查看过程"}
        </Button>
        {renderOtherOperations()}
        <Image
          className="cursor-pointer"
          src="/close.svg"
          width={30}
          height={30}
          alt="关闭"
          onClick={() => setIsOpen(false)}
        />
      </div>
    </div>
  );
};
