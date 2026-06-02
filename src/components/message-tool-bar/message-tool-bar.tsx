'use client';

import Image from 'next/image';
import React from 'react';
import { Tooltip, Popover } from 'antd';

import { MessageToolType, SupportDownloadFileType, MessageToolBarProps } from '@/types';
import { useDisclosure } from '@/hooks';

const OperatorToTextMap = (op: MessageToolType | SupportDownloadFileType) => {
  switch (op) {
    case 'copy':
      return '复制';
    case 'edit':
      return '编辑';
    case 'recall':
      return '重新生成';
    case 'download':
      return '下载';
    case 'pdf':
      return 'PDF';
    case 'word':
      return 'Word';
    case 'md':
      return 'Markdown';
    case 'cancel':
      return '取消';
  }
};

const MessageToolBar: React.FC<MessageToolBarProps> = ({
  tools,
  supportDownloadFiles,
  handleToolAction,
  handleDownloadFiles,
  className,
}) => {
  const { isOpen: isPopoverOpen, open: openPopover, close: closePopover } = useDisclosure(false);

  const handleToolOperator = (tool: MessageToolType) => {
    if (handleToolAction) {
      if (tool === 'download' && !isPopoverOpen) openPopover();
      handleToolAction(tool);
      return;
    }
  };

  const handleDownloadFilesOperator = (fileType: SupportDownloadFileType) => {
    if (handleDownloadFiles) {
      handleDownloadFiles(fileType);
      closePopover();
      return;
    }
  };

  return (
    <>
      {tools.map((tool, index) => (
        <Tooltip key={index} title={`${OperatorToTextMap(tool)}`} placement="bottom">
          {tool === 'download' ? (
            <Popover
              content={
                <div onClick={(e) => e.stopPropagation()}>
                  {supportDownloadFiles.map((fileType) => {
                    return (
                      <div
                        key={fileType}
                        className="flex items-center gap-2 rounded-md px-2 py-1 hover:cursor-pointer hover:bg-gray-100"
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
                className={`m-0.5 mb-2 h-7 w-7 rounded-lg p-1 transition-colors hover:cursor-pointer hover:bg-gray-100 ${className}`}
                onClick={() => handleToolOperator(tool)}
              ></Image>
            </Popover>
          ) : (
            <Image
              src={`/${tool}.svg`}
              alt={`${tool}`}
              width={20}
              height={20}
              className={`m-0.5 mb-2 h-7 w-7 rounded-lg p-1 transition-colors hover:cursor-pointer hover:bg-gray-100 ${className}`}
              onClick={() => handleToolOperator(tool)}
            ></Image>
          )}
        </Tooltip>
      ))}
    </>
  );
};

export default MessageToolBar;
