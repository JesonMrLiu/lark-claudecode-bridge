// 版本号唯一来源：package.json（运行时读取，避免双份声明漂移——历史上 0.7.0~0.10.0 曾连续漏改）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

export const VERSION = pkg.version;
