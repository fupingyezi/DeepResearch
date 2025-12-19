import Image from "next/image";

import { Button } from "antd";

export interface ProcessHeaderProps {
  researchTarget: string;
  setIsOpen: (isOpen: boolean) => void;
  selectedTab: "report" | "process";
  setSelectedTab: (selectedTab: "report" | "process") => void;
}

export const ProcessHeader: React.FC<ProcessHeaderProps> = ({
  researchTarget,
  setIsOpen,
  selectedTab,
  setSelectedTab,
}) => {
  const renderOtherOperations = () => {
    if (selectedTab === "process") return null;
    return (
      <>
        <Image
          src={`/copy.svg`}
          alt={`复制`}
          width={20}
          height={20}
          className="w-7 h-7 rounded-xl p-1 hover:bg-[#e7e7e7] hover:cursor-pointer"
        ></Image>
        <Image
          src={`/download.svg`}
          alt={`下载`}
          width={20}
          height={20}
          className="w-7 h-7 rounded-xl p-1 hover:bg-[#e7e7e7] hover:cursor-pointer"
        ></Image>
      </>
    );
  };

  const handleSelect = () => {
    if (selectedTab === "process") setSelectedTab("report");
    else setSelectedTab("process");
  };
  return (
    <div className="w-full sticky top-0 flex justify-between items-center py-2 bg-white z-10">
      <div className="w-[70%] text-xl font-bold">课题：{researchTarget}</div>
      <div className="flex gap-2">
        <Button onClick={() => handleSelect()}>
          {selectedTab === "process" ? "查看结果" : "查看过程"}
        </Button>
        {renderOtherOperations()}
        <Image
          className="cursor-pointer"
          src="/close.svg"
          width={30}
          height={30}
          alt="关闭"
          onClick={() => setIsOpen(false)}
        />
      </div>
    </div>
  );
};
