'use client';

import { useEffect, useState } from 'react';
import { message as antdMessage } from 'antd';
import copy from 'copy-to-clipboard';

/**
 * useCopy
 *
 * 复制文本到剪贴板，并通过 antd message 反馈复制成功；
 * 内部 isCopied 在 500ms 后自动复位。
 */
const useCopy = (successMessage = 'Copy success!') => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (text: string) => {
    copy(text);
    setIsCopied(true);
  };

  useEffect(() => {
    if (isCopied) {
      antdMessage.success(successMessage);
      const timer = setTimeout(() => {
        setIsCopied(false);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isCopied, successMessage]);

  return { copyToClipboard, isCopied };
};

export default useCopy;
