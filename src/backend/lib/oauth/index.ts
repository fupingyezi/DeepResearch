export * from './types';
export { getOAuthAdapter, getOAuthAdapters } from './registry';
// 注意：lib 不设 barrel（曾有 index.ts re-export ./db 把 pg 拉进所有 importer，已解散）
