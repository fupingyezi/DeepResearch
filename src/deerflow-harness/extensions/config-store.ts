/**
 * extensions 配置文件存储。
 *
 * 关键特性（复用 memory FileStorage 范式）：
 * - mtime 缓存：文件未变更时直接返回内存副本，避免每次读盘 + 解析。
 * - 原子写：写入临时文件后 rename，避免并发写出现半截文件。
 * - 损坏回退：JSON 解析或 schema 校验失败时回退到空配置，不抛错阻断上层。
 *
 * getMtimeMs() 供 skill / mcp 子系统做缓存失效判定（配置变更即重建）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getExtensionsConfigPath } from './paths';
import {
  createEmptyExtensionsConfig,
  extensionsConfigSchema,
  type ExtensionsConfig,
  type McpServerConfig,
} from './types';

export interface ExtensionsConfigStore {
  load(): Promise<ExtensionsConfig>;
  reload(): Promise<ExtensionsConfig>;
  save(config: ExtensionsConfig): Promise<boolean>;
  getMtimeMs(): Promise<number | null>;
  setMcpServer(name: string, config: McpServerConfig): Promise<ExtensionsConfig>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<ExtensionsConfig>;
  removeMcpServer(name: string): Promise<ExtensionsConfig>;
  setSkillEnabled(name: string, enabled: boolean): Promise<ExtensionsConfig>;
}

interface CacheEntry {
  data: ExtensionsConfig;
  mtimeMs: number | null;
}

export class FileExtensionsConfigStore implements ExtensionsConfigStore {
  private cache: CacheEntry | null = null;

  private filePath(): string {
    return getExtensionsConfigPath();
  }

  async getMtimeMs(): Promise<number | null> {
    try {
      const s = await fs.stat(this.filePath());
      return s.mtimeMs;
    } catch {
      return null;
    }
  }

  private async loadFromFile(): Promise<ExtensionsConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(), 'utf-8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        console.warn('[extensions/config-store] Failed to read config file:', e);
      }
      return createEmptyExtensionsConfig();
    }
    try {
      const parsed = JSON.parse(raw);
      const result = extensionsConfigSchema.safeParse(parsed);
      if (!result.success) {
        console.warn(
          '[extensions/config-store] Config schema invalid, fallback to empty:',
          result.error.message,
        );
        return createEmptyExtensionsConfig();
      }
      return result.data;
    } catch (e) {
      console.warn('[extensions/config-store] Failed to parse config file:', e);
      return createEmptyExtensionsConfig();
    }
  }

  async load(): Promise<ExtensionsConfig> {
    const currentMtime = await this.getMtimeMs();
    if (this.cache && this.cache.mtimeMs === currentMtime) {
      return this.cache.data;
    }
    const data = await this.loadFromFile();
    this.cache = { data, mtimeMs: currentMtime };
    return data;
  }

  async reload(): Promise<ExtensionsConfig> {
    const data = await this.loadFromFile();
    const mtimeMs = await this.getMtimeMs();
    this.cache = { data, mtimeMs };
    return data;
  }

  async save(config: ExtensionsConfig): Promise<boolean> {
    const filePath = this.filePath();
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.${randomUUID().replace(/-/g, '')}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
      const mtimeMs = await this.getMtimeMs();
      this.cache = { data: config, mtimeMs };
      return true;
    } catch (e) {
      console.error('[extensions/config-store] Failed to save config file:', e);
      return false;
    }
  }

  async setMcpServer(name: string, config: McpServerConfig): Promise<ExtensionsConfig> {
    const current = await this.load();
    const next: ExtensionsConfig = {
      ...current,
      mcpServers: { ...current.mcpServers, [name]: config },
    };
    await this.save(next);
    return next;
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<ExtensionsConfig> {
    const current = await this.load();
    const existing = current.mcpServers[name];
    if (!existing) throw new Error(`MCP server '${name}' not found`);
    const next: ExtensionsConfig = {
      ...current,
      mcpServers: { ...current.mcpServers, [name]: { ...existing, enabled } },
    };
    await this.save(next);
    return next;
  }

  async removeMcpServer(name: string): Promise<ExtensionsConfig> {
    const current = await this.load();
    const nextServers = { ...current.mcpServers };
    delete nextServers[name];
    const next: ExtensionsConfig = { ...current, mcpServers: nextServers };
    await this.save(next);
    return next;
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<ExtensionsConfig> {
    const current = await this.load();
    const next: ExtensionsConfig = {
      ...current,
      skills: { ...current.skills, [name]: { enabled } },
    };
    await this.save(next);
    return next;
  }
}

let _instance: ExtensionsConfigStore | null = null;

export function getExtensionsConfigStore(): ExtensionsConfigStore {
  if (_instance) return _instance;
  _instance = new FileExtensionsConfigStore();
  return _instance;
}

export function resetExtensionsConfigStore(): void {
  _instance = null;
}
