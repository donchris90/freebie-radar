import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AppConfig } from '../config/config';

export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Public URL for a stored key. `requestBase` is the origin the request came in on (used by the local driver). */
  publicUrl(key: string, requestBase: string): string;
  /** Deletes every object whose key starts with the prefix; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

export const STORAGE = Symbol('STORAGE');
const CACHE = 'public, max-age=31536000, immutable';

/** Development and single-server storage on local disk. Files are served by the API itself. */
export class LocalDiskStorage implements StorageDriver {
  readonly name = 'local' as const;
  constructor(private readonly root: string, private readonly publicBase: string | null) {}

  /** Absolute path for a key, or null if the key would escape the storage root. */
  localPath(key: string): string | null {
    const abs = path.resolve(this.root, key);
    return abs.startsWith(path.resolve(this.root) + path.sep) ? abs : null;
  }
  async put(key: string, body: Buffer) {
    const abs = this.localPath(key);
    if (!abs) throw new Error('Invalid storage key');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, { flag: 'wx' });
  }
  publicUrl(key: string, requestBase: string) {
    return `${(this.publicBase ?? requestBase).replace(/\/$/, '')}/uploads/${key}`;
  }
  async deletePrefix(prefix: string) {
    const abs = this.localPath(prefix.replace(/\/$/, ''));
    if (!abs) return 0;
    let count = 0;
    try {
      for (const f of await fs.readdir(abs)) { await fs.rm(path.join(abs, f), { force: true }); count++; }
      await fs.rmdir(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return count;
  }
}

/** S3-compatible object storage (AWS S3, Cloudflare R2, MinIO). Photos are served from `publicBase` (bucket or CDN URL). */
export class S3Storage implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  constructor(private readonly cfg: NonNullable<AppConfig['s3']>) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint ?? undefined,
      forcePathStyle: !!cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: CACHE }));
  }
  publicUrl(key: string) {
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  async deletePrefix(prefix: string) {
    let removed = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }));
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}

export function createStorage(cfg: AppConfig): StorageDriver {
  if (cfg.storageDriver === 's3' && cfg.s3) return new S3Storage(cfg.s3);
  return new LocalDiskStorage(cfg.uploadDir, cfg.publicBaseUrl);
}
