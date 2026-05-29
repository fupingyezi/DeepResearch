import { FileItemsProps } from '@/types';
import React from 'react';
import { LoadingOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { formatFileSize } from '@/utils/files/file-info-handler';

const FileItem: React.FC<FileItemsProps> = React.memo(
  ({ id, fileName, ImgComponent, parsedStatus, sizeBytes, removeFile, canClose }) => {
    const handleDelete = () => {
      if (removeFile) {
        removeFile(id);
      }
    };

    const renderState = () => {
      if (parsedStatus === 'success') {
        return (
          <div className="font-sans text-xs text-gray-500">{formatFileSize(sizeBytes || 0)}</div>
        );
      } else if (parsedStatus === 'failed') {
        return <div className="font-sans text-xs text-red-700">解析失败</div>;
      } else {
        return (
          <div className="font-sans text-xs text-sky-400">
            <LoadingOutlined />
            {parsedStatus === 'pending' ? '等待解析' : '正在解析'}
          </div>
        );
      }
    };

    return (
      <div className="relative flex h-12 w-full items-center gap-2 rounded-2xl border-2 border-gray-100 p-2">
        <ImgComponent className="h-full" style={{ fontSize: 24 }} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="w-2/3 truncate font-sans text-[14px]">{fileName}</div>
          {renderState()}
        </div>

        {canClose && (
          <div className="absolute top-2 right-2 bg-white">
            <CloseCircleOutlined onClick={() => handleDelete()} />
          </div>
        )}
      </div>
    );
  },
);

export default FileItem;
