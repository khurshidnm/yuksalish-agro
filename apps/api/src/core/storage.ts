import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config';

export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
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
}

export const storage: StorageDriver = config.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
