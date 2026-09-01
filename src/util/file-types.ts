import { extname } from 'node:path';

/** 图片扩展名集合：小写、含点；与 im.image.create（image_type:'message'）接口对应 */
export const IMAGE_EXT: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * 判断文件是否为图片（按扩展名、不区分大小写）。
 * 单一来源：src/gateway/feishu-gateway.ts 与 src/index.ts 共同引用此函数，
 * 避免两边各维护一份图片扩展名集合造成漂移。
 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXT.has(extname(filePath).toLowerCase());
}