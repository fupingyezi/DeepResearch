'use client';

import React, { useState } from 'react';
import { useModelStore } from '@/store';
import { MODEL_PRESETS, ModelPresetName, getAvailablePresets } from '@/config/models';

interface ModelSelectorProps {
  className?: string;
  showLabel?: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ className = '', showLabel = true }) => {
  const { model, setModel } = useModelStore();
  const [isOpen, setIsOpen] = useState(false);
  const presets = getAvailablePresets();
  const currentPreset = MODEL_PRESETS[model];

  const handleSelectModel = (next: ModelPresetName) => {
    setModel(next);
    setIsOpen(false);
  };

  const isActive = isOpen;

  return (
    <div className={`relative ${className}`}>
      {/* 触发按钮：与"联网搜索/深度研究"胶囊样式保持一致 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-8 w-30 items-center justify-center rounded-2xl border-2 border-[#f3f3f3] px-3 hover:cursor-pointer hover:bg-[#e7e7e7]"
        style={{
          backgroundColor: isActive ? '#eceaff' : '',
          color: isActive ? '#4433ff' : '',
        }}
      >
        <span className="flex items-center gap-1 truncate">
          {showLabel ? (
            <>
              <span className="truncate text-sm font-medium">
                {currentPreset?.label || 'Select Model'}
              </span>
              {currentPreset?.isBeta && (
                <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
                  Beta
                </span>
              )}
            </>
          ) : (
            <span className="truncate text-xs">{model}</span>
          )}
        </span>
      </button>

      {/* 下拉菜单：向上展开 */}
      {isOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-64 min-w-[220px] overflow-y-auto rounded-lg border-2 border-[#e5e5e5] bg-white shadow-lg">
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => handleSelectModel(preset.key)}
              className={`w-full border-b border-[#f0f0f0] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#f9f9f9] ${model === preset.key ? 'bg-[#eceaff]' : ''} `}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{preset.label}</span>
                    {preset.isBeta && (
                      <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">
                        Beta
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{preset.description}</p>
                </div>
                {model === preset.key && (
                  <svg
                    className="ml-2 h-5 w-5 text-blue-600"
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
