import {
  FilePdfOutlined,
  FileWordOutlined,
  FileMarkdownOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const getFileIcon = (type: string, name: string): React.ComponentType => {
  if (type.includes('pdf') || name.endsWith('.pdf')) return FilePdfOutlined;
  if (type.includes('word') || name.endsWith('.docx')) return FileWordOutlined;
  if (name.endsWith('.md')) return FileMarkdownOutlined;
  return FileTextOutlined; // default
};
