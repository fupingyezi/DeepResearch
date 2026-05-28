"use client";

import React, { useState } from "react";
import { useModelStore } from "@/store";
import { MODEL_PRESETS, getAvailablePresets } from "@/config/models";

interface ModelSelectorProps {
  className?: string;
  showLabel?: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  className = "",
  showLabel = true,
}) => {
  const { selectedModelKey, setSelectedModelKey } = useModelStore();
  const [isOpen, setIsOpen] = useState(false);
  const presets = getAvailablePresets();
  const currentPreset = MODEL_PRESETS[selectedModelKey];

  const handleSelectModel = (key: any) => {
    setSelectedModelKey(key);
    setIsOpen(false);
  };

  const isActive = isOpen;

  return (
    <div className={`relative ${className}`}>
      {/* 触发按钮：与"联网搜索/深度研究"胶囊样式保持一致 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-30 h-8 rounded-2xl border-[#f3f3f3] border-2 flex justify-center items-center hover:cursor-pointer hover:bg-[#e7e7e7] px-3"
        style={{
          backgroundColor: isActive ? "#eceaff" : "",
          color: isActive ? "#4433ff" : "",
        }}
      >
        <span className="flex items-center gap-1 truncate">
          {showLabel ? (
            <>
              <span className="text-sm font-medium truncate">
                {currentPreset?.label || "Select Model"}
              </span>
              {currentPreset?.isBeta && (
                <span className="text-xs bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">
                  Beta
                </span>
              )}
            </>
          ) : (
            <span className="text-xs truncate">{selectedModelKey}</span>
          )}
        </span>
      </button>

      {/* 下拉菜单：向上展开 */}
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 bg-white border-2 border-[#e5e5e5] rounded-lg shadow-lg z-50 min-w-[220px] max-h-64 overflow-y-auto">
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => handleSelectModel(preset.key)}
              className={`
                w-full text-left px-4 py-3
                border-b border-[#f0f0f0] last:border-b-0
                hover:bg-[#f9f9f9]
                transition-colors
                ${selectedModelKey === preset.key ? "bg-[#eceaff]" : ""}
              `}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {preset.label}
                    </span>
                    {preset.isBeta && (
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">
                        Beta
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {preset.description}
                  </p>
                </div>
                {selectedModelKey === preset.key && (
                  <svg
                    className="w-5 h-5 text-blue-600 ml-2"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
