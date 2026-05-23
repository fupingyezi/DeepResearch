"use client";

import { useState } from "react";
import Image from "next/image";
import SiderContent from "./sider-content";

const Sider = () => {
  const [isExpand, setIsExpand] = useState<boolean>(true);
  const [isHovering, setIsHovering] = useState<boolean>(false);

  const changeIsHovering = () => {
    if (isExpand) return;
    setIsHovering(!isHovering);
  };

  const handleClickExpand = () => {
    if (!isExpand) {
      setIsExpand(true);
      setIsHovering(false);
    } else {
      setIsExpand(false);
    }
  };

  return (
    <div
      className={`h-screen flex flex-col  border-r-2 border-[#f3f3f3] transition-all ${
        isExpand ? "w-[18%] bg-[#f9f9f9]" : "w-14 bg-white"
      }`}
    >
      <div className="flex items-center justify-between p-2">
        {!isHovering && (
          <Image
            src={`/四叶草.svg`}
            alt="Sidebar Icon"
            width={40}
            height={40}
            className="hover:bg-[#e7e7e7] hover:cursor-pointer p-1 rounded-xl"
            onMouseEnter={() => changeIsHovering()}
          />
        )}
        {(isExpand || isHovering) && (
          <Image
            src="/sidebar.svg"
            alt="Sidebar Icon"
            width={35}
            height={35}
            className="hover:bg-[#e7e7e7] hover:cursor-pointer p-1.5 rounded-xl"
            onClick={() => handleClickExpand()}
            onMouseLeave={() => changeIsHovering()}
          />
        )}
      </div>
      {isExpand && <SiderContent />}
    </div>
  );
};

export default Sider;
