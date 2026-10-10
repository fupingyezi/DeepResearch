export * from './types';
export { getOAuthAdapter, getOAuthAdapters } from './registry';
// 注意：不进 src/lib/index.ts 大桶——那桶 re-export ./db 会把 pg 拉进所有 importer
