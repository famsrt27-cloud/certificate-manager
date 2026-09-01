import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { validateDurableObjectManifest } from "./object-manifest.mjs";

const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const streamBytes = async (body) => { const chunks = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
const endpoint = (prefix) => required(`${prefix}_ENDPOINT`);
const bucket = (prefix) => required(`${prefix}_BUCKET`);
const client = (prefix) => new S3Client({ endpoint: endpoint(prefix), region: process.env[`${prefix}_REGION`] ?? "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: required(`${prefix}_ACCESS_KEY`), secretAccessKey: required(`${prefix}_SECRET_KEY`) } });
const manifestPath = argument("--manifest");
const targetPrefix = argument("--target-prefix");
if (!manifestPath || !targetPrefix) throw new Error("Usage: object-copy.mjs --manifest <path> --target-prefix <S3_ENV_PREFIX>");
const createTargetBucket = process.argv.includes("--create-target-bucket");
const sourcePrefix = "SOURCE_S3";
const source = client(sourcePrefix); const destination = client(targetPrefix);
const manifest = validateDurableObjectManifest(JSON.parse(await readFile(manifestPath, "utf8")));
if (createTargetBucket) await destination.send(new CreateBucketCommand({ Bucket: bucket(targetPrefix) })).catch(() => undefined);
for (const expected of manifest.objects) {
  const response = await source.send(new GetObjectCommand({ Bucket: bucket(sourcePrefix), Key: expected.key }));
  if (!response.Body) throw new Error("Source object body is missing.");
  const bytes = await streamBytes(response.Body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256 || bytes.byteLength !== expected.size_bytes) throw new Error("Source object integrity mismatch.");
  await destination.send(new PutObjectCommand({ Bucket: bucket(targetPrefix), Key: expected.key, Body: bytes, ContentType: expected.mime_type,
    Metadata: { "content-sha256": sha256 } }));
}
const statusPath = argument("--status");
if (statusPath) { await mkdir(dirname(statusPath), { recursive: true }); await writeFile(statusPath, JSON.stringify({ object_backup: "success", completed_at: new Date().toISOString(), object_count: manifest.objects.length })); }
console.log(`Durable object copy completed (${manifest.objects.length} objects).`);
