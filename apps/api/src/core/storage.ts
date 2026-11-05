import { mkdir, open, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { MAX_UPLOAD_BYTES } from '@yap/shared';
import { config } from '../config';
import { AppError, badRequest } from './errors';
import { verifyAccessToken } from './tokens';

export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** For sending to a client: a whole file per open download would add up to the API's memory. */
  stream(key: string): Promise<Readable>;
  /** Deleting what is not there is not an error. */
  delete(key: string): Promise<void>;
  /** Room left on the disk, or null when the driver has no disk of ours to fill. */
  freeBytes(): Promise<number | null>;
}

class LocalStorage implements StorageDriver {
  private readonly root = resolve(config.STORAGE_DIR);

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(`${this.root}/`)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async stream(key: string): Promise<Readable> {
    // Opened here, so a missing file fails now and not after the response has started.
    return (await open(this.path(key))).createReadStream();
  }

  delete(key: string): Promise<void> {
    return rm(this.path(key), { force: true });
  }

  async freeBytes(): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root);
    return Number(disk.bavail) * Number(disk.bsize);
  }
}

class S3Storage implements StorageDriver {
  private client?: import('@aws-sdk/client-s3').S3Client;

  private async s3() {
    const sdk = await import('@aws-sdk/client-s3');
    this.client ??= new sdk.S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY ?? '', secretAccessKey: config.S3_SECRET_KEY ?? '' },
    });
    return { sdk, client: this.client };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    const { sdk, client } = await this.s3();
    const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }

  async stream(key: string): Promise<Readable> {
    const { sdk, client } = await this.s3();
    const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return result.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
  }

  async freeBytes(): Promise<null> {
    return null;
  }
}

export const storage: StorageDriver = config.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();

/** Uploads per person. A phone sending what it saved offline stays under this, one photo at a time. */
export const UPLOADS_PER_MINUTE = 60;

/** Per person: everyone in the farm's office shares one address. A token that fails counts by address. */
async function uploaderKey(req: FastifyRequest): Promise<string> {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) return req.ip;
  return verifyAccessToken(token).then(
    (claims) => claims.userId,
    () => req.ip,
  );
}

export const uploadRateLimit = { rateLimit: { max: UPLOADS_PER_MINUTE, timeWindow: '1 minute', keyGenerator: uploaderKey } };

/**
 * All uploads being held in memory at one moment, as sent. Each takes about twice its size while it is
 * put together, and the smallest server gives the API 1 GB, so this leaves that memory to everything else.
 */
const MAX_UPLOADS_IN_MEMORY_BYTES = 96 * 1024 * 1024;

let uploadsInMemory = 0;

/** Run a route that holds an upload in memory. Past the limit it answers "busy", which a client retries. */
export async function withUploadMemory<T>(req: Pick<FastifyRequest, 'headers'>, fn: () => Promise<T>): Promise<T> {
  const size = Math.min(Number(req.headers['content-length']) || MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  if (uploadsInMemory + size > MAX_UPLOADS_IN_MEMORY_BYTES) {
    throw new AppError(429, 'UPLOADS_BUSY', 'The server is receiving many files, please try again in a moment');
  }
  uploadsInMemory += size;
  try {
    return await fn();
  } finally {
    uploadsInMemory -= size;
  }
}

export interface Upload {
  name: string;
  mimeType: string;
  read(): Promise<Buffer>;
}

export const fileTooLarge = () =>
  new AppError(413, 'FILE_TOO_LARGE', 'This file is too large', { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 });

/** The name comes from the client, and may be empty or hold tabs and line breaks no name should show. */
const cleanFileName = (name: string) => name.replace(/\p{Cc}/gu, '').trim().slice(0, 255) || 'file';

/** The file of a multipart request. Its type is known before its bytes are read. */
export async function openUpload(req: Pick<FastifyRequest, 'file'>): Promise<Upload> {
  const part = await req.file();
  if (!part) throw badRequest('FILE_REQUIRED', 'No file was sent');
  // No real file name holds a NUL, so this is the same refusal as a NUL anywhere else.
  if (part.filename.includes('\0')) throw badRequest('INVALID_INPUT', 'Some values are not valid');
  return {
    name: cleanFileName(part.filename),
    mimeType: part.mimetype,
    read: () =>
      part.toBuffer().catch((err) => {
        throw (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' ? fileTooLarge() : err;
      }),
  };
}
