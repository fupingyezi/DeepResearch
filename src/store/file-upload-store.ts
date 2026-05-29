import { create } from 'zustand';

export interface UploadedFileInfo {
  fileId: string;
  minioKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content?: string; // 解析后的内容预览
  error?: string; // 解析错误信息
}

interface FileUploadState {
  uploadedFiles: UploadedFileInfo[];
  addUploadedFile: (file: UploadedFileInfo) => void;
  removeUploadedFile: (fileId: string) => void;
  clearUploadedFiles: () => void;
  getUploadedFiles: () => UploadedFileInfo[];
}

const useFileUploadStore = create<FileUploadState>((set, get) => ({
  uploadedFiles: [],

  addUploadedFile: (file: UploadedFileInfo) => {
    set((state) => ({
      uploadedFiles: [...state.uploadedFiles, file],
    }));
  },

  removeUploadedFile: (fileId: string) => {
    set((state) => ({
      uploadedFiles: state.uploadedFiles.filter((f) => f.fileId !== fileId),
    }));
  },

  clearUploadedFiles: () => {
    set({ uploadedFiles: [] });
  },

  getUploadedFiles: () => {
    return get().uploadedFiles;
  },
}));

export default useFileUploadStore;
