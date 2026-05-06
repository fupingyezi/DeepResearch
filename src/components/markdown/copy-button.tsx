import { useState } from "react";
import { Copy, Check } from "lucide-react";
import copy from "copy-to-clipboard";

const CopyButton = ({ id }: { id: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const element = document.getElementById(id);
    if (element) {
      const text = element.textContent || "";
      if (copy(text)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        console.error("Failed to copy text");
      }
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-200 hover:cursor-pointer dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {copied ? (
        <>
          <Check size={14} />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy size={14} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
};

export default CopyButton;
