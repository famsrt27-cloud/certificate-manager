import { readFile } from "node:fs/promises";
import { createDatabase, closeDatabase, reconcileStaleCertificateGenerationOutbox } from "../../packages/database/src/index.ts";

const databaseUrl = process.env.RESTORE_DRILL_TARGET_DATABASE_URL;
const manifestPath = process.env.RESTORE_DRILL_MANIFEST_PATH;
if (!databaseUrl || !manifestPath) throw new Error("Restore drill target URL and manifest path are required.");
const expected = JSON.parse(await readFile(manifestPath, "utf8")); const database = createDatabase({ connectionString: databaseUrl, maxConnections: 2 });
try {
  const certificate = await database.selectFrom("certificates").selectAll().where("id", "=", expected.certificate_id).executeTakeFirstOrThrow();
  if (certificate.organization_id !== expected.organization_id || certificate.public_identifier !== expected.public_identifier || certificate.status !== "REVOKED" || certificate.verification_key_kid !== expected.verification_key_kid) throw new Error("Certificate identity, tenant, revocation, or historical key relationship changed.");
  if (certificate.training_id !== expected.training_id || certificate.participant_id !== expected.participant_id || certificate.template_version_id !== expected.template_version_id || certificate.pdf_storage_key === null || certificate.pdf_content_sha256 === null || certificate.pdf_size_bytes === null || certificate.pdf_mime_type !== "application/pdf") throw new Error("Certificate issuance relationships or immutable template/PDF metadata are incomplete.");
  const snapshot = await database.selectFrom("certificate_issuance_snapshots").select(["organization_id", "recipient_display_name", "project_name", "training_name", "training_code", "issued_at"]).where("certificate_id", "=", expected.certificate_id).executeTakeFirstOrThrow();
  if (snapshot.organization_id !== expected.organization_id || snapshot.recipient_display_name !== "Synthetic Restore Recipient" || snapshot.project_name !== "Restore Drill Project" || snapshot.training_name !== "Restore Drill Training" || snapshot.training_code !== "RESTORE-DRILL" || snapshot.issued_at.toISOString() !== "2026-08-31T00:00:00.000Z") throw new Error("Immutable issuance snapshot changed.");
  const generation = await database.selectFrom("certificate_generation_items as item").innerJoin("jobs as job", "job.id", "item.job_id").select(["item.certificate_id", "item.generation_revision", "item.status", "job.organization_id", "job.status as job_status"]).where("item.job_id", "=", expected.generation_job_id).executeTakeFirstOrThrow();
  if (generation.certificate_id !== expected.certificate_id || generation.generation_revision !== 1 || generation.status !== "SUCCEEDED" || generation.organization_id !== expected.organization_id || generation.job_status !== "SUCCEEDED") throw new Error("Certificate generation relationship or terminal job state changed.");
  const version = await database.selectFrom("template_versions").select(["id", "organization_id", "status"]).where("id", "=", expected.template_version_id).executeTakeFirstOrThrow();
  if (version.organization_id !== expected.organization_id || version.status !== "PUBLISHED") throw new Error("Immutable template version was not preserved.");
  const links = await database.selectFrom("template_version_assets").innerJoin("template_assets", "template_assets.id", "template_version_assets.asset_id").select(["template_assets.storage_key", "template_assets.content_sha256", "template_assets.size_bytes", "template_assets.detected_mime_type"]).where("template_version_assets.template_version_id", "=", expected.template_version_id).execute();
  const asset = expected.objects.find((item: { kind: string }) => item.kind === "template_asset"); const pdf = expected.objects.find((item: { kind: string }) => item.kind === "certificate_pdf");
  if (links.length !== 1 || links[0].storage_key !== asset.key || Buffer.from(links[0].content_sha256).toString("hex") !== asset.sha256 || links[0].size_bytes !== String(asset.size_bytes) || links[0].detected_mime_type !== asset.mime_type) throw new Error("Template asset integrity metadata changed.");
  if (certificate.pdf_storage_key !== pdf.key || Buffer.from(certificate.pdf_content_sha256).toString("hex") !== pdf.sha256 || certificate.pdf_size_bytes !== String(pdf.size_bytes)) throw new Error("PDF integrity metadata changed.");
  const audit = await database.selectFrom("audit_logs").select(["id", "organization_id", "actor_user_id", "actor_membership_id"]).where("resource_id", "=", expected.certificate_id).where("action", "=", "CERTIFICATE_REVOKED").executeTakeFirst();
  const cleanup = await database.selectFrom("storage_cleanup_outbox").select("id").where("organization_id", "=", expected.organization_id).executeTakeFirst();
  if (!audit || audit.organization_id !== expected.organization_id || audit.actor_user_id === null || audit.actor_membership_id === null || !cleanup) throw new Error("Required tenant-bound revocation audit or durable cleanup outbox state is absent.");
  const completedOutbox = await database.selectFrom("queue_outbox").select("dispatched_at").where("organization_id", "=", expected.organization_id).where("deduplication_key", "=", `${expected.generation_job_id}-generate`).executeTakeFirstOrThrow();
  const recoveryOutboxBefore = await database.selectFrom("queue_outbox").select("dispatched_at").where("organization_id", "=", expected.organization_id).where("deduplication_key", "=", `${expected.recovery_job_id}-generate`).executeTakeFirstOrThrow();
  if (completedOutbox.dispatched_at === null || recoveryOutboxBefore.dispatched_at === null) throw new Error("Restored queue outbox dispatch evidence is absent.");
  await reconcileStaleCertificateGenerationOutbox(database, new Date());
  const completedOutboxAfter = await database.selectFrom("queue_outbox").select("dispatched_at").where("organization_id", "=", expected.organization_id).where("deduplication_key", "=", `${expected.generation_job_id}-generate`).executeTakeFirstOrThrow();
  const recoveryOutboxAfter = await database.selectFrom("queue_outbox").select("dispatched_at").where("organization_id", "=", expected.organization_id).where("deduplication_key", "=", `${expected.recovery_job_id}-generate`).executeTakeFirstOrThrow();
  if (completedOutboxAfter.dispatched_at === null || recoveryOutboxAfter.dispatched_at !== null) throw new Error("Queue recovery requeued terminal work or failed to reconstruct pending delivery.");
  console.log("Relational restore integrity verification completed.");
} finally { await closeDatabase(database); }
