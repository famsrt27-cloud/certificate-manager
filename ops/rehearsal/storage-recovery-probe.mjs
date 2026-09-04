import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

const requireFromRuntime = createRequire(realpathSync("/app/node_modules/@certificate-platform/storage/package.json"));
const { HeadObjectCommand, PutObjectCommand, S3Client } = requireFromRuntime("@aws-sdk/client-s3");

const bucket = process.env.OBJECT_STORAGE_BUCKET;
if (!bucket) throw new Error("OBJECT_STORAGE_BUCKET is required");

const client = new S3Client({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  region: process.env.OBJECT_STORAGE_REGION,
  credentials: {
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY
  },
  forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
  maxAttempts: 1
});

const key = "rehearsal/recovery-marker-v1";
const body = Buffer.from("certificate-platform-rehearsal-storage-recovery-v1", "utf8");
const operation = process.argv[2];

try {
  if (operation === "put") {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/octet-stream" }));
  } else if (operation === "head") {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (Number(result.ContentLength) !== body.byteLength) throw new Error("Recovered object length changed");
  } else {
    throw new Error("Expected put or head operation");
  }
  console.log("storage-recovery-probe: PASS");
} finally {
  client.destroy();
}
