/**
 * Redis 缓存模块（当前未使用，已禁用自动连接）
 *
 * 如需启用，取消下方注释并确保 Redis 服务可用。
 */

import { createClient } from "redis";

let redis: ReturnType<typeof createClient> | null = null;
let connected = false;

/**
 * 获取 Redis 客户端（懒连接模式）
 * 仅在实际调用时才尝试连接
 */
async function getRedisClient() {
  if (!redis) {
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: {
        keepAlive: true,
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            console.error("Redis 重连次数过多，停止重连");
            return new Error("Redis 重连次数过多");
          }
          return Math.min(retries * 200, 3000);
        },
      },
    });

    redis.on("error", (err) => {
      console.warn("Redis Client Error:", err.message);
    });

    redis.on("connect", () => {
      console.log("Redis connected successfully");
      connected = true;
    });
  }

  if (!connected) {
    try {
      await redis.connect();
      connected = true;
    } catch (err: any) {
      console.warn("Redis 连接失败，缓存功能不可用:", err.message);
      return null;
    }
  }

  return redis;
}

export async function setCache(
  key: string,
  value: string,
  expireSeconds?: number
) {
  const client = await getRedisClient();
  if (!client) return;
  const stringValue = JSON.stringify(value);
  if (expireSeconds) {
    await client.setEx(key, expireSeconds, stringValue);
  } else {
    await client.set(key, stringValue);
  }
}

export async function getCache(key: string) {
  const client = await getRedisClient();
  if (!client) return null;
  const value = await client.get(key);
  return value ? JSON.parse(value) : null;
}

export async function deleteCache(key: string) {
  const client = await getRedisClient();
  if (!client) return;
  await client.del(key);
}

export default null;
