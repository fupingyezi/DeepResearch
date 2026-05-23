import Image from "next/image";
import React, { useState } from "react";
import { Tooltip, Popover } from "antd";

import {
  MessageToolType,
  SupportDownloadFileType,
  MessageToolBarProps,
} from "@/types";

const OperatorToTextMap = (op: MessageToolType | SupportDownloadFileType) => {
  switch (op) {
    case "copy":
      return "复制";
    case "edit":
      return "编辑";
    case "recall":
      return "重新生成";
    case "download":
      return "下载";
    case "pdf":
      return "PDF";
    case "word":
      return "Word";
    case "md":
      return "Markdown";
    case "cancel":
      return "取消";
  }
};

const MessageToolBar: React.FC<MessageToolBarProps> = ({
  tools,
  supportDownloadFiles,
  handleToolAction,
  handleDownloadFiles,
  className,
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState<boolean>(false);

  const handleToolOperator = (tool: MessageToolType) => {
    if (handleToolAction) {
      if (tool === "download" && isPopoverOpen === false)
        setIsPopoverOpen(true);
      handleToolAction(tool);
      return;
    }
  };

  const handleDownloadFilesOperator = (fileType: SupportDownloadFileType) => {
    if (handleDownloadFiles) {
      handleDownloadFiles(fileType);
      setIsPopoverOpen(false);
      return;
    }
  };

  return (
    <>
      {tools.map((tool, index) => (
        <Tooltip
          key={index}
          title={`${OperatorToTextMap(tool)}`}
          placement="bottom"
        >
          {tool === "download" ? (
            <Popover
              content={
                <div onClick={(e) => e.stopPropagation()}>
                  {supportDownloadFiles.map((fileType) => {
                    return (
                      <div
                        key={fileType}
                        className="flex gap-2 items-center px-2 py-1 hover:bg-gray-100 hover:cursor-pointer rounded-md"
                        onClick={() => handleDownloadFilesOperator(fileType)}
                      >
                        {fileType}
                      </div>
                    );
                  })}
                </div>
              }
              placement="right"
              open={isPopoverOpen}
            >
              <Image
                src={`/${tool}.svg`}
                alt={`${tool}`}
                width={20}
                height={20}
                className={`w-7 h-7 rounded-xl p-1 m-0.5 mb-2 hover:bg-[#e7e7e7] hover:cursor-pointer ${className}`}
                onClick={() => handleToolOperator(tool)}
              ></Image>
            </Popover>
          ) : (
            <Image
              src={`/${tool}.svg`}
              alt={`${tool}`}
              width={20}
              height={20}
              className={`w-7 h-7 rounded-xl p-1 m-0.5 mb-2 hover:bg-[#e7e7e7] hover:cursor-pointer ${className}`}
              onClick={() => handleToolOperator(tool)}
            ></Image>
          )}
        </Tooltip>
      ))}
    </>
  );
};

export default MessageToolBar;
