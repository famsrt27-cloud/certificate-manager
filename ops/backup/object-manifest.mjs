const durableObjectClasses = {
  certificate_pdf: { prefix: "certificates/", mimeTypes: new Set(["application/pdf"]) },
  template_asset: { prefix: "template-assets/", mimeTypes: new Set(["image/png", "image/jpeg", "font/ttf", "font/otf"]) }
};

export const validateDurableObjectManifest = (value) => {
  if (value === null || typeof value !== "object" || !Array.isArray(value.objects) || value.objects.length === 0) {
    throw new Error("Manifest must contain durable objects.");
  }
  const keys = new Set();
  for (const object of value.objects) {
    if (object === null || typeof object !== "object") throw new Error("Invalid object manifest.");
    const objectClass = durableObjectClasses[object.kind];
    if (objectClass === undefined || typeof object.key !== "string" || !object.key.startsWith(objectClass.prefix)
      || !objectClass.mimeTypes.has(object.mime_type) || !/^[a-f0-9]{64}$/.test(object.sha256)
      || !Number.isSafeInteger(object.size_bytes) || object.size_bytes <= 0 || keys.has(object.key)) {
      throw new Error("Manifest contains an invalid or non-durable object.");
    }
    keys.add(object.key);
  }
  return value;
};
