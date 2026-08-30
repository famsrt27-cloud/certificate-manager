import { TemplateDefinitionSchema, type TemplateAsset, type TemplateVersion } from "@certificate-platform/contracts";

export type TemplateDefinition = TemplateVersion["definition"];
export type TemplateElement = TemplateDefinition["elements"][number];
export type TemplateBinding = Extract<TemplateElement, { type: "text" }>["binding"];
export type VersionStatus = TemplateVersion["status"];

export const defaultDefinition: TemplateDefinition = TemplateDefinitionSchema.parse({
  format_version: 1,
  page: { width: 1123, height: 794, unit: "px" },
  elements: [
    { type: "text", x: 162, y: 122, width: 799, height: 56, opacity: 1, text: "ใบประกาศนียบัตร", align: "center", color: "#17345C", font: { family: "Noto Serif Thai", size: 38, weight: 700 } },
    { type: "text", x: 162, y: 286, width: 799, height: 86, opacity: 1, binding: "recipient.display_name", align: "center", color: "#0F172A", font: { family: "Noto Sans Thai", size: 46, weight: 700 } },
    { type: "text", x: 212, y: 400, width: 699, height: 52, opacity: 1, binding: "training.name", align: "center", color: "#334155", font: { family: "Noto Sans Thai", size: 25, weight: 400 } },
    { type: "shape", x: 76, y: 72, width: 971, height: 650, opacity: 1, shape: "rectangle", color: "#2557A7", stroke_width: 3 },
    { type: "qr", x: 920, y: 616, width: 112, height: 112, opacity: 1, binding: "verification_url", foreground: "#0F172A", background: "#FFFFFF" }
  ]
});

export const bindingOptions = [
  ["recipient.display_name", "ชื่อผู้รับใบประกาศ"],
  ["project.name", "ชื่อโครงการ"],
  ["training.name", "ชื่อการอบรม"],
  ["training.code", "รหัสการอบรม"],
  ["certificate.number", "เลขที่ใบประกาศ"],
  ["certificate.issued_at", "วันที่ออกใบประกาศ"],
  ["verification_url", "ลิงก์ตรวจสอบ"]
] as const;

export const bindingLabel = (binding: string): string => bindingOptions.find(([value]) => value === binding)?.[1] ?? "ข้อมูลอัตโนมัติ";

export const versionPresentation: Record<VersionStatus, { label: string; className: string }> = {
  DRAFT: { label: "แบบร่าง", className: "border-blue-200 bg-blue-50 text-blue-800" },
  PUBLISHED: { label: "เผยแพร่แล้ว", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  ARCHIVED: { label: "เก็บถาวร", className: "border-slate-200 bg-slate-100 text-slate-600" }
};

export const assetStatusPresentation: Record<TemplateAsset["status"], { label: string; className: string }> = {
  QUARANTINED: { label: "กำลังตรวจสอบ", className: "border-amber-200 bg-amber-50 text-amber-800" },
  ACTIVE: { label: "พร้อมใช้งาน", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  REJECTED: { label: "ไม่ผ่านการตรวจสอบ", className: "border-red-200 bg-red-50 text-red-800" },
  ARCHIVED: { label: "เก็บถาวร", className: "border-slate-200 bg-slate-100 text-slate-600" }
};

export const assetTypeLabel = (asset: TemplateAsset): string => asset.detected_mime_type.startsWith("image/") ? "รูปภาพ" : "แบบอักษร";

export const formatBytes = (bytes: number): string => bytes < 1024 ? `${bytes} ไบต์`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const elementLabel = (element: TemplateElement, assets: readonly TemplateAsset[], definition?: TemplateDefinition): string => {
  if (element.type === "text") return `ข้อความ — ${element.binding === undefined ? (element.text === "" ? "ข้อความคงที่" : element.text) : bindingLabel(element.binding)}`;
  if (element.type === "qr") return "QR Code — ลิงก์ตรวจสอบ";
  if (element.type === "shape") return element.shape === "line" ? "เส้น" : "กรอบสี่เหลี่ยม";
  const asset = assets.find((candidate) => candidate.id === element.asset_id);
  if (element.type === "image" && definition !== undefined && element.x === 0 && element.y === 0
    && element.width === definition.page.width && element.height === definition.page.height) {
    return `พื้นหลัง — ${asset?.original_filename ?? "ไม่พบไฟล์"}`;
  }
  return `${element.type === "signature" ? "ลายเซ็น" : "รูปภาพ"} — ${asset?.original_filename ?? "ไม่พบไฟล์"}`;
};

export const cloneDefinition = (definition: TemplateDefinition): TemplateDefinition => structuredClone(definition);
