export {
  PrivateObjectTooLargeError,
  createPrivateObjectStorage,
  createS3Client,
  ensurePrivateBucket,
  type PrivateObjectStorage,
  type PrivateObjectStorageFailureObserver,
  type PrivateObjectStorageConfig,
  type PutPrivateObjectInput
} from "./s3-private-storage.js";
