import { defineConfig, globalIgnores } from 'eslint/config';
import { FlatCompat } from '@eslint/eslintrc';
import prettier from 'eslint-config-prettier';

// eslint-config-next v14 是老式 eslintrc 配置，须经 FlatCompat 转成 flat config
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = defineConfig([
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // 存量代码大量使用 any / 存在少量未用变量与 require 导入（历史约定），
      // 降为 warn 不阻塞 CI；新增代码仍建议显式类型、及时清理
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'import/no-anonymous-default-export': 'warn',
      'react/display-name': 'warn',
      '@next/next/no-img-element': 'warn',
    },
  },
  {
    // 分层依赖方向（见 CLAUDE.md「后端分层规范」）：
    // harness / utils / types 是共享层，禁止反向依赖 app 侧（@/server、@/app）
    files: [
      'src/deerflow-harness/**/*.{ts,tsx}',
      'src/utils/**/*.{ts,tsx}',
      'src/types/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/server/*', '@/app/*'],
              message: '共享层（harness/utils/types）不允许依赖 @/server 或 @/app',
            },
          ],
        },
      ],
    },
  },
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
