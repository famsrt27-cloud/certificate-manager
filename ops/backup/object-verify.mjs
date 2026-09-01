import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { validateDurableObjectManifest } from "./object-manifest.mjs";

const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const manifestPath = arg("--manifest"); const prefix = arg("--prefix");
if (!manifestPath || !prefix) throw new Error("Usage: object-verify.mjs --manifest <path> --prefix <S3_ENV_PREFIX>");
const config = new S3Client({ endpoint: required(`${prefix}_ENDPOINT`), region: process.env[`${prefix}_REGION`] ?? "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: required(`${prefix}_ACCESS_KEY`), secretAccessKey: required(`${prefix}_SECRET_KEY`) } });
const bucket = required(`${prefix}_BUCKET`); const manifest = validateDurableObjectManifest(JSON.parse(await readFile(manifestPath, "utf8")));
for (const expected of manifest.objects) {
  const head = await config.send(new HeadObjectCommand({ Bucket: bucket, Key: expected.key }));
  if (head.ContentType !== expected.mime_type || head.ContentLength !== expected.size_bytes || head.Metadata?.["content-sha256"] !== expected.sha256) throw new Error("Restored object metadata mismatch.");
  const response = await config.send(new GetObjectCommand({ Bucket: bucket, Key: expected.key })); if (!response.Body) throw new Error("Restored object body is missing.");
  const hash = createHash("sha256"); for await (const chunk of response.Body) hash.update(Buffer.from(chunk));
  if (hash.digest("hex") !== expected.sha256) throw new Error("Restored object content hash mismatch.");
}
console.log(`Durable object verification completed (${manifest.objects.length} objects).`);
