import { randomUUID } from "node:crypto";

import {
  armStorageCleanup,
  cancelRequiredStorageCleanupInTransaction,
  closeDatabase,
  createDatabase
} from "@certificate-platform/database";
import type { PrivateObjectStorage } from "@certificate-platform/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StorageCleanupReconciler } from "../../src/storage-cleanup-reconciler.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled = databaseUrl !== undefined && new URL(databaseUrl).pathname.toLowerCase().includes("test");

describe.skipIf(!integrationEnabled)("storage cleanup reconciliation", () => {
  const database = createDatabase({ connectionString: databaseUrl!, maxConnections: 2 });
  const organizationId = randomUUID();
  const objects = new Set<string>();
  let failDeletes = false;
  let beforeDelete: (() => Promise<void>) | null = null;

  const storage: PrivateObjectStorage = {
    put: async (input) => { objects.add(input.key); },
    get: async () => new Uint8Array(),
    delete: async (key) => {
      if (failDeletes) throw new Error("synthetic storage outage");
      await beforeDelete?.();
      objects.delete(key);
    }
  };

  beforeAll(async () => {
    await database.insertInto("organizations").values({
      id: organizationId,
      name: "Storage Cleanup Integration"
    }).execute();
  });

  afterAll(async () => {
    await database.deleteFrom("storage_cleanup_outbox").where("organization_id", "=", organizationId).execute();
    await database.deleteFrom("organizations").where("id", "=", organizationId).execute();
    await closeDatabase(database);
  });

  it("retries a failed object deletion and removes the durable intent after recovery", async () => {
    const objectKey = `template-assets/${organizationId}/synthetic/${randomUUID()}.png`;
    objects.add(objectKey);
    await armStorageCleanup(database, {
      organizationId,
      objectKey,
      notBefore: new Date("2000-01-01T00:00:00.000Z")
    });
    const reconciler = new StorageCleanupReconciler({
      database,
      storage,
      batchSize: 10,
      retryDelayMs: 0
    });

    failDeletes = true;
    expect(await reconciler.runOnce()).toEqual({ claimed: 1, deleted: 0, protected: 0, failed: 1 });
    expect(objects.has(objectKey)).toBe(true);
    const failed = await database.selectFrom("storage_cleanup_outbox")
      .select(["attempt_count", "last_error_code"])
      .where("object_key", "=", objectKey)
      .executeTakeFirstOrThrow();
    expect(failed.attempt_count).toBe(1);
    expect(failed.last_error_code).toBe("STORAGE_DELETE_FAILED");

    failDeletes = false;
    expect(await reconciler.runOnce()).toEqual({ claimed: 1, deleted: 1, protected: 0, failed: 0 });
    expect(objects.has(objectKey)).toBe(false);
    const completed = await database.selectFrom("storage_cleanup_outbox")
      .select("id")
      .where("object_key", "=", objectKey)
      .executeTakeFirst();
    expect(completed).toBeUndefined();
  });

  it("never deletes an object that became referenced by committed database state", async () => {
    const templateId = randomUUID();
    const membershipUserId = randomUUID();
    const membershipId = randomUUID();
    const objectKey = `template-assets/${organizationId}/${templateId}/${randomUUID()}.png`;

    await database.insertInto("users").values({
      id: membershipUserId,
      email: `storage-cleanup-${membershipUserId}@example.invalid`,
      password_hash: "synthetic"
    }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId,
      organization_id: organizationId,
      user_id: membershipUserId
    }).execute();
    await database.insertInto("certificate_templates").values({
      id: templateId,
      organization_id: organizationId,
      name: "Referenced Cleanup Guard"
    }).execute();
    await database.insertInto("template_assets").values({
      id: randomUUID(),
      organization_id: organizationId,
      template_id: templateId,
      storage_key: objectKey,
      original_filename: "guard.png",
      content_sha256: new Uint8Array(32).fill(7),
      detected_mime_type: "image/png",
      size_bytes: "128",
      width_px: 1,
      height_px: 1,
      status: "ACTIVE",
      created_by_membership_id: membershipId
    }).execute();
    objects.add(objectKey);
    await armStorageCleanup(database, {
      organizationId,
      objectKey,
      notBefore: new Date("2000-01-01T00:00:00.000Z")
    });

    const reconciler = new StorageCleanupReconciler({
      database,
      storage,
      batchSize: 10,
      retryDelayMs: 0
    });
    expect(await reconciler.runOnce()).toEqual({ claimed: 1, deleted: 0, protected: 1, failed: 0 });
    expect(objects.has(objectKey)).toBe(true);
    expect(await database.selectFrom("storage_cleanup_outbox").select("id")
      .where("object_key", "=", objectKey).executeTakeFirst()).toBeUndefined();

    await database.deleteFrom("template_assets").where("storage_key", "=", objectKey).execute();
    await database.deleteFrom("certificate_templates").where("id", "=", templateId).execute();
    await database.deleteFrom("organization_memberships").where("id", "=", membershipId).execute();
    await database.deleteFrom("users").where("id", "=", membershipUserId).execute();
    objects.delete(objectKey);
  });

  it("serializes a claimed deletion against ownership commit and forces the losing commit to roll back", async () => {
    const templateId = randomUUID();
    const membershipUserId = randomUUID();
    const membershipId = randomUUID();
    const assetId = randomUUID();
    const objectKey = `template-assets/${organizationId}/${templateId}/${assetId}.png`;
    await database.insertInto("users").values({
      id: membershipUserId, email: `cleanup-race-${membershipUserId}@example.invalid`, password_hash: "synthetic"
    }).execute();
    await database.insertInto("organization_memberships").values({
      id: membershipId, organization_id: organizationId, user_id: membershipUserId
    }).execute();
    await database.insertInto("certificate_templates").values({
      id: templateId, organization_id: organizationId, name: "Cleanup ownership race"
    }).execute();
    objects.add(objectKey);
    await armStorageCleanup(database, { organizationId, objectKey, notBefore: new Date("2000-01-01T00:00:00.000Z") });

    let releaseDelete!: () => void;
    let reportDeleteStarted!: () => void;
    const deleteRelease = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteStarted = new Promise<void>((resolve) => { reportDeleteStarted = resolve; });
    beforeDelete = async () => { reportDeleteStarted(); await deleteRelease; };
    const reconciler = new StorageCleanupReconciler({ database, storage, batchSize: 10, retryDelayMs: 0 });
    const reconciliation = reconciler.runOnce();
    await deleteStarted;

    const ownershipCommit = database.transaction().execute(async (transaction) => {
      await transaction.insertInto("template_assets").values({
        id: assetId, organization_id: organizationId, template_id: templateId, storage_key: objectKey,
        original_filename: "race.png", content_sha256: new Uint8Array(32).fill(9), detected_mime_type: "image/png",
        size_bytes: "128", width_px: 1, height_px: 1, status: "ACTIVE", created_by_membership_id: membershipId
      }).execute();
      if (!await cancelRequiredStorageCleanupInTransaction(transaction, organizationId, objectKey)) {
        throw new Error("cleanup intent was already consumed");
      }
    });
    releaseDelete();
    expect(await reconciliation).toEqual({ claimed: 1, deleted: 1, protected: 0, failed: 0 });
    await expect(ownershipCommit).rejects.toThrow("cleanup intent was already consumed");
    beforeDelete = null;
    expect(objects.has(objectKey)).toBe(false);
    expect(await database.selectFrom("template_assets").select("id").where("id", "=", assetId).executeTakeFirst())
      .toBeUndefined();

    await database.deleteFrom("certificate_templates").where("id", "=", templateId).execute();
    await database.deleteFrom("organization_memberships").where("id", "=", membershipId).execute();
    await database.deleteFrom("users").where("id", "=", membershipUserId).execute();
  });
});
