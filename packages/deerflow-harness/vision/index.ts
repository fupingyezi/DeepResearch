/** 视觉子系统公共门面：图片字节注入 + 多模态消息构造 + 历史压缩中间件。 */
export {
  buildHumanMessageContent,
  getThreadImageFetcher,
  maxImageBytesFromEnv,
  setThreadImageFetcher,
  type BuildContentOptions,
  type BuildContentResult,
  type FetchedImage,
  type ThreadImageFetcher,
  type ThreadImageRef,
} from './image-fetcher';
export { extractContentTextBlocks } from './content-blocks';
export { contentHasImageBlocks, visionMiddleware } from './vision-middleware';
