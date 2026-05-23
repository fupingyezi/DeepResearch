import { FileItemsProps } from "@/types";
import React from "react";
import { LoadingOutlined, CloseCircleOutlined } from "@ant-design/icons";
import { formatFileSize } from "@/utils/files/file-info-handler";

const FileItem: React.FC<FileItemsProps> = React.memo(
  ({
    id,
    fileName,
    ImgComponent,
    parsedStatus,
    sizeBytes,
    removeFile,
    canClose,
  }) => {
    const handleDelete = () => {
      if (removeFile) {
        removeFile(id);
      }
    };

    const renderState = () => {
      if (parsedStatus === "success") {
        return (
          <div className="text-xs font-sans text-gray-500">
            {formatFileSize(sizeBytes || 0)}
          </div>
        );
      } else if (parsedStatus === "failed") {
        return <div className="text-xs font-sans text-red-700">解析失败</div>;
      } else {
        return (
          <div className="text-xs font-sans text-sky-400">
            <LoadingOutlined />
            {parsedStatus === "pending" ? "等待解析" : "正在解析"}
          </div>
        );
      }
    };

    return (
      <div className="flex relative gap-2 w-full h-12 rounded-2xl border-gray-100 border-2  items-center p-2">
        <ImgComponent className="h-full" style={{ fontSize: 24 }} />
        <div className="flex flex-col flex-1 min-w-0">
          <div className="text-[14px] w-2/3 font-sans truncate">{fileName}</div>
          {renderState()}
        </div>

        {canClose && (
          <div className="absolute top-2 right-2 bg-white">
            <CloseCircleOutlined onClick={() => handleDelete()} />
          </div>
        )}
      </div>
    );
  }
);

export default FileItem;
