import Image from "next/image";
import { Button, message as antdMessage } from "antd";
import MessageToolBar from "../MessageToolBar/MessageToolBar";

import copy from "copy-to-clipboard";
import { useEffect, useState } from "react";
import {
  handleDownloadPDF,
  handleDownloadDOC,
  handleDownloadMD,
} from "@/utils/files/fileDownload";

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
  const [showCopySuccess, setShowCopySuccess] = useState<boolean>(false);
  useEffect(() => {
    if (showCopySuccess) {
      antdMessage.success("Copy Success!");
      const timer = setTimeout(() => {
        setShowCopySuccess(false);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [showCopySuccess]);
  const renderOtherOperations = () => {
    const tools: MessageToolType[] = ["copy", "download"];
    const supportDownloadFiles: SupportDownloadFileType[] = [
      "pdf",
      "word",
      "md",
      "cancle",
    ];

    const handleOperator = async (
      op: "copy" | "edit" | "recall" | "download"
    ) => {
      switch (op) {
        case "copy": {
          copy(report);
          setShowCopySuccess(true);
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
        case "cancle": {
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
