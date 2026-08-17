import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

export interface PrivateObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export interface PutPrivateObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly contentSha256Hex: string;
}

export interface PrivateObjectStorage {
  put(input: PutPrivateObjectInput): Promise<void>;
  get(key: string, maximumBytes: number): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class PrivateObjectTooLargeError extends Error {
  constructor() {
    super("Private object exceeds the configured read limit");
    this.name = "PrivateObjectTooLargeError";
  }
}

export const createS3Client = (config: PrivateObjectStorageConfig): S3Client => new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  forcePathStyle: config.forcePathStyle,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey
  }
});

export const ensurePrivateBucket = async (
  client: S3Client,
  bucket: string,
  createWhenMissing: boolean
): Promise<void> => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!createWhenMissing) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
};

export const createPrivateObjectStorage = (
  client: S3Client,
  bucket: string
): PrivateObjectStorage => ({
  async put(input) {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.body.byteLength,
      ContentType: input.contentType,
      Metadata: { "content-sha256": input.contentSha256Hex }
    }));
  },

  async get(key, maximumBytes) {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (response.ContentLength !== undefined && response.ContentLength > maximumBytes) {
      throw new PrivateObjectTooLargeError();
    }
    if (response.Body === undefined) throw new Error("Private object response had no body");
    const bytes = await response.Body.transformToByteArray();
    if (bytes.byteLength > maximumBytes) throw new PrivateObjectTooLargeError();
    return bytes;
  },

  async delete(key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
});
