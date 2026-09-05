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
