import { Client } from 'minio';
import { UUIDTypes } from 'uuid';

// 惰性创建：模块顶层直接 new Client(...) 会在构建期（无环境变量）就实例化，
// 导致 next build 收集页面数据时抛 "Invalid endPoint: undefined"。
// 推迟到首次请求时创建，env 缺失时报清晰错误。
let _client: Client | null = null;

export function getMinioClient(): Client {
  if (!_client) {
    const endPoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    if (!endPoint || !accessKey || !secretKey) {
      throw new Error('MinIO env is not set: MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY');
    }
    _client = new Client({
      endPoint,
      port: parseInt(process.env.MINIO_PORT || '9000'),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey,
      secretKey,
    });
  }
  return _client;
}

function getBucketName(): string {
  const bucket = process.env.MINIO_BUCKET;
  if (!bucket) {
    throw new Error('MinIO env is not set: MINIO_BUCKET');
  }
  return bucket;
}

export async function ensureBucket() {
  const client = getMinioClient();
  const bucketName = getBucketName();
  try {
    const bucketExists = await client.bucketExists(bucketName);
    if (!bucketExists) {
      await client.makeBucket(bucketName);
      console.log(`Bucket ${bucketName} created`);
    } else {
      console.log(`Bucket ${bucketName} already exists`);
    }
  } catch (error) {
    console.error('MinIO connection error:', error);
    throw new Error(`Failed to connect to MinIO: ${error}`);
  }
}

let bucketInitialized = false;
export async function initializeBucket() {
  if (!bucketInitialized) {
    await ensureBucket();
    bucketInitialized = true;
  }
}

export async function uploadFile(fileName: string, fileId: UUIDTypes, buffer: Buffer) {
  await initializeBucket();
  const client = getMinioClient();
  const extensionName = fileName.split('.').pop() || '';
  const objectName = `${Date.now()}-${fileName}`;
  const objectKey = `files/${fileId}/${objectName}`;

  await client.putObject(getBucketName(), objectKey, buffer, buffer.length, {
    contentType: getMimeType(extensionName),
  });

  return { objectKey };
}

export async function getFileUrl(objectKey: string, expiryHours = 24) {
  const url = await getMinioClient().presignedGetObject(
    getBucketName(),
    objectKey,
    expiryHours * 7 * 3600,
  );
  return url;
}

/**
 * MinIO 单次删除的超时上限。
 *
 * minio-js 自身不接受 timeout（`setRequestOptions` 只认 agent / cert / ciphers 那几个字段，
 * timeout 会被 `lodash.pick` 丢掉），一个卡住的 socket 能把调用方无限期拖住 —— 删除对话
 * 是同步等这个结果的，卡住就等于那个请求挂死。
 *
 * 只加在删除上：上传（putObject）耗时随文件大小增长，设上限会误伤大文件。
 */
const MINIO_DELETE_TIMEOUT_MS = 15_000;

/**
 * 给 MinIO 调用套超时。
 *
 * 注意超时后底层请求仍在跑，必须由这里吞掉它迟到的 reject —— Node 默认把未处理的
 * promise rejection 当致命错误（--unhandled-rejections=throw），绝不能让它冒到进程级。
 */
async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${MINIO_DELETE_TIMEOUT_MS}ms`)),
      MINIO_DELETE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => undefined);
  }
}

export async function deleteFile(objectKey: string) {
  await withTimeout(
    getMinioClient().removeObject(getBucketName(), objectKey),
    `minio removeObject(${objectKey})`,
  );
}

export async function getFile(objectKey: string) {
  return await getMinioClient().getObject(getBucketName(), objectKey);
}

export function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    md: 'text/markdown',
    txt: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return mimeMap[ext.toLowerCase()] || 'application/octet-stream';
}
