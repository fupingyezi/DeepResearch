import { createMiddleware } from 'langchain';

/**
 * ViewImageMiddleware（features.vision 启用）—— 当前为**占位实现**

 */

let warned = false;

export const viewImageMiddleware = createMiddleware({
  name: 'ViewImageMiddleware',
  beforeAgent: async (state: any) => {
    if (warned) return undefined;
    const viewed = state?.viewedImages;
    if (!viewed || typeof viewed !== 'object') return undefined;
    if (Object.keys(viewed).length === 0) return undefined;
    warned = true;
    console.warn(
      '[viewImageMiddleware] vision feature is enabled and state.viewedImages is non-empty, ' +
        'but middleware is not implemented yet — viewedImages will be ignored. ' +
        'See TODO in view-image-middleware.ts for implementation guidance.',
    );
    return undefined;
  },
});
