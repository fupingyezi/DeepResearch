import { Client } from 'minio';
import { UUIDTypes } from 'uuid';

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT!,
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

const BUCKET_NAME = process.env.MINIO_BUCKET!;

export async function ensureBucket() {
  try {
    const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
    if (!bucketExists) {
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`Bucket ${BUCKET_NAME} created`);
    } else {
      console.log(`Bucket ${BUCKET_NAME} already exists`);
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
  const extensionName = fileName.split('.').pop() || '';
  const objectName = `${Date.now()}-${fileName}`;
  const objectKey = `files/${fileId}/${objectName}`;

  await minioClient.putObject(BUCKET_NAME, objectKey, buffer, buffer.length, {
    contentType: getMimeType(extensionName),
  });

  return { objectKey };
}

export async function getFileUrl(objectKey: string, expiryHours = 24) {
  const url = await minioClient.presignedGetObject(BUCKET_NAME, objectKey, expiryHours * 7 * 3600);
  return url;
}

export async function deleteFile(objectKey: string) {
  await minioClient.removeObject(BUCKET_NAME, objectKey);
}

export async function getFile(objectKey: string) {
  return await minioClient.getObject(BUCKET_NAME, objectKey);
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

export default minioClient;
