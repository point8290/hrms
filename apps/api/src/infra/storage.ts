import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';

export type PresignedUpload = {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  bucket: string;
  key: string;
  expiresInSeconds: number;
};

export type Storage = {
  /** Objects are keyed by tenant so a misissued URL cannot reach another tenant's files. */
  buildKey(tenantId: string, documentType: string, filename: string): string;
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  presignDownload(key: string, filename: string): Promise<{ url: string; expiresInSeconds: number }>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /**
   * Cheap reachability probe for `/health/deps`. Metadata only — a health check that
   * writes an object is one that fills the bucket and bills for every probe.
   */
  healthCheck(): Promise<void>;
  readonly bucket: string;
};

function sanitise(filename: string): string {
  return filename.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

function buildKey(tenantId: string, documentType: string, filename: string): string {
  return `tenants/${tenantId}/${documentType}/${randomUUID()}-${sanitise(filename)}`;
}

/**
 * Local filesystem storage for development.
 *
 * "Presigned" URLs are signed with the app secret and served by the API's own
 * /internal/files route, so the access-control shape (short-lived, single-object,
 * unguessable) matches S3 and the calling code does not change between environments.
 */
function createLocalStorage(): Storage {
  const cfg = config();
  const root = path.resolve(cfg.LOCAL_STORAGE_DIR);

  const sign = (key: string, expires: number) =>
    createHmac('sha256', cfg.JWT_SECRET).update(`${key}:${expires}`).digest('base64url');

  const filePath = (key: string) => path.join(root, key.replace(/\.\./g, '_'));

  return {
    bucket: cfg.S3_BUCKET,
    buildKey,
    async healthCheck() {
      // The directory is created lazily on first write, so its absence is not a fault.
      await mkdir(root, { recursive: true });
    },
    async presignUpload(key, contentType) {
      const expires = Math.floor(Date.now() / 1000) + cfg.S3_PRESIGN_TTL_SECONDS;
      return {
        url: `/internal/files/${encodeURIComponent(key)}?expires=${expires}&sig=${sign(key, expires)}`,
        method: 'PUT',
        headers: { 'content-type': contentType },
        bucket: cfg.S3_BUCKET,
        key,
        expiresInSeconds: cfg.S3_PRESIGN_TTL_SECONDS,
      };
    },
    async presignDownload(key, filename) {
      const expires = Math.floor(Date.now() / 1000) + cfg.S3_PRESIGN_TTL_SECONDS;
      const qs = `expires=${expires}&sig=${sign(key, expires)}&filename=${encodeURIComponent(filename)}`;
      return {
        url: `/internal/files/${encodeURIComponent(key)}?${qs}`,
        expiresInSeconds: cfg.S3_PRESIGN_TTL_SECONDS,
      };
    },
    async putObject(key, body) {
      const target = filePath(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    },
    async getObject(key) {
      return readFile(filePath(key));
    },
  };
}

export function verifyLocalSignature(key: string, expires: number, signature: string): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const expected = Buffer.from(
    createHmac('sha256', config().JWT_SECRET).update(`${key}:${expires}`).digest('base64url'),
  );
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function createS3Storage(): Storage {
  const cfg = config();
  let modPromise: Promise<any> | undefined;
  const aws = async () => {
    modPromise ??= (async () => {
      const [s3, presigner] = await Promise.all([
        import('@aws-sdk/client-s3' as string),
        import('@aws-sdk/s3-request-presigner' as string),
      ]);
      return { s3, presigner, client: new s3.S3Client({ region: cfg.AWS_REGION }) };
    })();
    return modPromise;
  };

  return {
    bucket: cfg.S3_BUCKET,
    buildKey,
    async healthCheck() {
      // HeadBucket: confirms the bucket exists and that this task's role may reach it,
      // without reading or writing an object.
      const { s3, client } = await aws();
      await client.send(new s3.HeadBucketCommand({ Bucket: cfg.S3_BUCKET }));
    },
    async presignUpload(key, contentType) {
      const { s3, presigner, client } = await aws();
      const url = await presigner.getSignedUrl(
        client,
        new s3.PutObjectCommand({
          Bucket: cfg.S3_BUCKET,
          Key: key,
          ContentType: contentType,
          ServerSideEncryption: 'aws:kms',
        }),
        { expiresIn: cfg.S3_PRESIGN_TTL_SECONDS },
      );
      return {
        url,
        method: 'PUT',
        headers: { 'content-type': contentType },
        bucket: cfg.S3_BUCKET,
        key,
        expiresInSeconds: cfg.S3_PRESIGN_TTL_SECONDS,
      };
    },
    async presignDownload(key, filename) {
      const { s3, presigner, client } = await aws();
      const url = await presigner.getSignedUrl(
        client,
        new s3.GetObjectCommand({
          Bucket: cfg.S3_BUCKET,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${sanitise(filename)}"`,
        }),
        { expiresIn: cfg.S3_PRESIGN_TTL_SECONDS },
      );
      return { url, expiresInSeconds: cfg.S3_PRESIGN_TTL_SECONDS };
    },
    async putObject(key, body, contentType) {
      const { s3, client } = await aws();
      await client.send(
        new s3.PutObjectCommand({
          Bucket: cfg.S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'aws:kms',
        }),
      );
    },
    async getObject(key) {
      const { s3, client } = await aws();
      const res = await client.send(new s3.GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },
  };
}

let instance_: Storage | undefined;

export function storage(): Storage {
  instance_ ??= config().STORAGE_DRIVER === 's3' ? createS3Storage() : createLocalStorage();
  return instance_;
}

/** Test seam: substitute an in-memory store so a test never reaches a real bucket. */
export function setStorage(instance: Storage | undefined): void {
  instance_ = instance;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
