/**
 * 树形列目录：在 root 下最多遍历 maxDepth 层，跳过 ignore 项，目录项以 `/` 结尾。
 *
 * symlink 防护：解析后若指向 root 之外则跳过，避免通过软链越权列出宿主其它目录。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { shouldIgnoreName } from './search';

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function listDir(targetPath: string, maxDepth = 2): string[] {
  const result: string[] = [];
  const root = path.resolve(targetPath);

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return result;
  }
  if (!rootStat.isDirectory()) return result;

  const traverse = (currentPath: string, currentDepth: number): void => {
    if (currentDepth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldIgnoreName(entry.name)) continue;
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isSymbolicLink()) {
        let resolved: string;
        let isDir: boolean;
        try {
          resolved = fs.realpathSync(entryPath);
          if (!isWithinRoot(resolved, root)) continue;
          isDir = fs.statSync(resolved).isDirectory();
        } catch {
          continue;
        }
        result.push(isDir ? `${resolved}/` : resolved);
        continue;
      }

      const isDir = entry.isDirectory();
      result.push(isDir ? `${entryPath}/` : entryPath);
      if (isDir && currentDepth < maxDepth) {
        traverse(entryPath, currentDepth + 1);
      }
    }
  };

  traverse(root, 1);
  return result.sort();
}
