import { useEffect, useState } from 'react';
import { message as antdMessage } from 'antd';
import copy from 'copy-to-clipboard';

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
  }, [isCopied]);

  return { copyToClipboard, isCopied };
};

export default useCopy;
