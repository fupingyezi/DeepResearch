import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import apiClient from '@/utils/request/api';
import { UploadedFile } from '@/types';
import { formatFileSize, getFileIcon } from '@/utils/files/file-info-handler';
import { useFileUploadStore } from '@/store';

export interface UseFileUploadOptions {
  maxFileSizeMB?: number; // 默认 10 MB
}

const DEFAULT_MAX_FILE_SIZE_MB = 10;
const SUPPORTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/markdown',
  'text/plain',
  'text/x-markdown',
];

const useFileUpload = (options: UseFileUploadOptions = {}) => {
  const { maxFileSizeMB = DEFAULT_MAX_FILE_SIZE_MB } = options;
  const [localUploadedFiles, setLocalUploadedFiles] = useState<UploadedFile[]>([]);
  const { addUploadedFile, removeUploadedFile } = useFileUploadStore();

  // 校验单个文件
  const validateFile = (file: File): boolean => {
    const isTypeSupported = SUPPORTED_TYPES.includes(file.type) || /\.(md|txt)$/i.test(file.name);
    if (!isTypeSupported) {
      alert(`不支持的文件类型: ${file.name}`);
      return false;
    }

    const maxSizeBytes = maxFileSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      alert(`文件过大（>${formatFileSize(maxSizeBytes)}）: ${file.name}`);
      return false;
    }

    return true;
  };

  // 解析并上传单个文件
  const parseFile = async (fileId: string, file: File) => {
    setLocalUploadedFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, parsedStatus: 'parsing' } : f)),
    );

    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileId', fileId);

    try {
      const result = await apiClient.post('/files/upload', formData);

      const updatedFile: UploadedFile = {
        id: fileId,
        file,
        parsedStatus: result.error ? 'failed' : 'success',
        sizeBytes: file.size,
        error: result.error,
      };

      setLocalUploadedFiles((prev) => prev.map((f) => (f.id === fileId ? updatedFile : f)));

      addUploadedFile({
        fileId: result.fileId,
        minioKey: result.minioKey,
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        content: result.content,
        error: result.error,
      });
    } catch (error: any) {
      console.error('Parse failed:', error);
      setLocalUploadedFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? {
                ...f,
                parsedStatus: 'failed',
                error: error.message || '解析失败',
              }
            : f,
        ),
      );
    }
  };

  // 处理文件选择
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const validFiles: { id: string; file: File }[] = [];

    // 先校验并生成 pending 状态
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!validateFile(file)) continue;

      const fileId = uuidv4();
      validFiles.push({ id: fileId, file });

      setLocalUploadedFiles((prev) => [
        ...prev,
        {
          id: fileId,
          file,
          parsedStatus: 'pending',
        },
      ]);
    }

    // 逐个上传
    for (const { id, file } of validFiles) {
      await parseFile(id, file);
    }
  };

  // 删除文件
  const removeFile = async (id: string) => {
    setLocalUploadedFiles((prev) => prev.filter((f) => f.id !== id));
    removeUploadedFile(id);

    try {
      await apiClient.delete('/files/delete', {
        body: JSON.stringify({ fileId: id }),
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      console.error('Failed to delete file from server:', error);
    }
  };

  return {
    localUploadedFiles,
    handleFiles,
    removeFile,
    clearFiles: () => setLocalUploadedFiles([]),
    getFileIcon, // 方便外部使用图标
  };
};

export default useFileUpload;
