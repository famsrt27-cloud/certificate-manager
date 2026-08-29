"use client";

import {
  CreateTemplateRequestSchema, CUSTOM_PAGE_MAX_MM, CUSTOM_PAGE_MIN_MM, PAGE_PRESETS, TemplateAssetResponseSchema,
  TemplateDefinitionSchema, TemplateResponseSchema, TemplateVersionResponseSchema, pageAspectRatio,
  pageForCustomMillimeters, pageForPreset, type PageOrientation, type PagePresetId, type TemplateAsset
} from "@certificate-platform/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Field, selectClassName } from "../resource-ui";

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;
type ImageFit = "contain" | "cover" | "fill";

export function TemplateImportDialog({ adminFetch, onCancel, onCreated }: {
  readonly adminFetch: AdminFetch; readonly onCancel: () => void; readonly onCreated: (templateId: string) => void;
}) {
  const [name, setName] = useState("แบบใบประกาศที่นำเข้า");
  const [preset, setPreset] = useState<PagePresetId>("A4");
  const [orientation, setOrientation] = useState<PageOrientation>("LANDSCAPE");
  const [customWidth, setCustomWidth] = useState(297); const [customHeight, setCustomHeight] = useState(210);
  const [fit, setFit] = useState<ImageFit>("contain"); const [file, setFile] = useState<File | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [addRecipient, setAddRecipient] = useState(true); const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = useMemo(() => {
    try { return preset === "CUSTOM" ? pageForCustomMillimeters(customWidth, customHeight) : pageForPreset(preset, orientation); }
    catch { return null; }
  }, [customHeight, customWidth, orientation, preset]);
  const ratioDifference = page === null || imageSize === null ? null
    : Math.abs(pageAspectRatio(page) - imageSize.width / imageSize.height) / pageAspectRatio(page);

  useEffect(() => {
    if (file === null || !["image/png", "image/jpeg"].includes(file.type)) return;
    let cancelled = false; let objectUrl = "";
    void createImageBitmap(file).then((bitmap) => { if (!cancelled) setImageSize({ width: bitmap.width, height: bitmap.height }); bitmap.close(); })
      .catch(() => { objectUrl = URL.createObjectURL(file); const image = new Image(); image.onload = () => { if (!cancelled) setImageSize({ width: image.naturalWidth, height: image.naturalHeight }); URL.revokeObjectURL(objectUrl); }; image.onerror = () => { if (!cancelled) setError("ไม่สามารถอ่านขนาดรูปภาพได้ กรุณาเลือก PNG หรือ JPEG ที่สมบูรณ์"); URL.revokeObjectURL(objectUrl); }; image.src = objectUrl; });
    return () => { cancelled = true; if (objectUrl !== "") URL.revokeObjectURL(objectUrl); };
  }, [file]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    const parsedName = CreateTemplateRequestSchema.safeParse({ name });
    if (!parsedName.success) { setError("กรุณาระบุชื่อเทมเพลตไม่เกิน 200 ตัวอักษร"); return; }
    if (file === null || !["image/png", "image/jpeg"].includes(file.type)) { setError("กรุณาเลือกไฟล์ PNG หรือ JPEG"); return; }
    if (page === null) { setError(`ขนาดกำหนดเองต้องอยู่ระหว่าง ${CUSTOM_PAGE_MIN_MM}–${CUSTOM_PAGE_MAX_MM} มม.`); return; }
    setPending(true);
    try {
      const templateResponse = await adminFetch("/admin/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsedName.data) });
      const templateBody: unknown = await templateResponse.json(); const parsedTemplate = TemplateResponseSchema.safeParse(templateBody);
      if (!templateResponse.ok || !parsedTemplate.success) throw new Error("template");
      const form = new FormData(); form.append("file", file);
      const assetResponse = await adminFetch(`/admin/templates/${parsedTemplate.data.data.id}/assets`, { method: "POST", body: form });
      const assetBody: unknown = await assetResponse.json(); const parsedAsset = TemplateAssetResponseSchema.safeParse(assetBody);
      if (!assetResponse.ok || !parsedAsset.success || parsedAsset.data.data.status !== "ACTIVE"
        || !["image/png", "image/jpeg"].includes(parsedAsset.data.data.detected_mime_type)) throw new Error("asset");
      const asset: TemplateAsset = parsedAsset.data.data;
      const elements: unknown[] = [{ type: "image", x: 0, y: 0, width: page.width, height: page.height, opacity: 1,
        asset_id: asset.id, fit }];
      if (addRecipient) elements.push({ type: "text", x: page.width * 0.2, y: page.height * 0.44,
        width: page.width * 0.6, height: Math.min(100, page.height * 0.14), opacity: 1,
        binding: "recipient.display_name", align: "center", color: "#0F172A",
        font: { family: "Noto Sans Thai", size: 42, weight: 700 } });
      const definition = TemplateDefinitionSchema.parse({ format_version: 1, page, elements });
      const versionResponse = await adminFetch(`/admin/templates/${parsedTemplate.data.data.id}/versions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition })
      });
      const versionBody: unknown = await versionResponse.json();
      if (!versionResponse.ok || !TemplateVersionResponseSchema.safeParse(versionBody).success) throw new Error("version");
      onCreated(parsedTemplate.data.data.id);
    } catch { setError("นำเข้าแบบใบประกาศไม่สำเร็จ กรุณาตรวจสอบไฟล์และลองอีกครั้ง"); }
    finally { setPending(false); }
  };

  return <form onSubmit={(event) => void submit(event)}><div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
    <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">หากออกแบบจาก Canva สามารถส่งออกเป็น PNG แล้วนำเข้าที่นี่ได้ จากนั้นวางชื่อผู้รับและ QR บนแบบเดิม</div>
    <Field htmlFor="import-template-name" label="ชื่อเทมเพลต"><Input id="import-template-name" maxLength={200} onChange={(event) => setName(event.target.value)} value={name} /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field htmlFor="import-page-preset" label="ขนาดใบประกาศ"><select className={selectClassName} id="import-page-preset" onChange={(event) => setPreset(event.target.value as PagePresetId)} value={preset}>{PAGE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="CUSTOM">กำหนดเอง</option></select></Field>
      <Field htmlFor="import-orientation" label="การวางแนว"><select className={selectClassName} disabled={preset === "CUSTOM"} id="import-orientation" onChange={(event) => setOrientation(event.target.value as PageOrientation)} value={orientation}><option value="LANDSCAPE">แนวนอน</option><option value="PORTRAIT">แนวตั้ง</option></select></Field></div>
    {preset === "CUSTOM" ? <div className="grid gap-4 sm:grid-cols-2"><Field htmlFor="custom-page-width" label="ความกว้าง (มม.)"><Input id="custom-page-width" max={CUSTOM_PAGE_MAX_MM} min={CUSTOM_PAGE_MIN_MM} onChange={(event) => setCustomWidth(Number(event.target.value))} type="number" value={customWidth} /></Field><Field htmlFor="custom-page-height" label="ความสูง (มม.)"><Input id="custom-page-height" max={CUSTOM_PAGE_MAX_MM} min={CUSTOM_PAGE_MIN_MM} onChange={(event) => setCustomHeight(Number(event.target.value))} type="number" value={customHeight} /></Field></div> : null}
    <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{preset === "CUSTOM" ? "กำหนดเอง" : PAGE_PRESETS.find((item) => item.id === preset)?.label} · {customWidth && page ? `${Math.round(page.width)} × ${Math.round(page.height)} หน่วยออกแบบ` : ""} · {orientation === "LANDSCAPE" ? "แนวนอน" : "แนวตั้ง"}</p>
    <Field hint="รองรับ PNG และ JPEG เท่านั้น" htmlFor="import-certificate-file" label="เลือกไฟล์แบบใบประกาศ"><Input accept=".png,.jpg,.jpeg,image/png,image/jpeg" id="import-certificate-file" onChange={(event) => { const next = event.target.files?.[0] ?? null; setImageSize(null); setFile(next); setError(null); }} type="file" /></Field>
    {file === null ? null : <div className="rounded-lg border border-slate-200 p-3"><p className="truncate text-sm font-semibold text-slate-900">{file.name}</p><p className="mt-1 text-xs text-slate-500">{imageSize === null ? "กำลังตรวจสอบขนาดภาพ…" : `ความละเอียดไฟล์ ${imageSize.width} × ${imageSize.height} px`}</p>{ratioDifference !== null ? <p className={`mt-2 text-xs ${ratioDifference <= 0.02 ? "text-emerald-700" : "text-amber-700"}`}>{ratioDifference <= 0.02 ? "สัดส่วนภาพเข้ากับหน้าที่เลือก" : "สัดส่วนภาพต่างจากหน้าที่เลือก โปรดเลือกวิธีจัดภาพด้านล่าง"}</p> : null}</div>}
    <Field htmlFor="import-background-fit" label="การจัดภาพพื้นหลัง"><select className={selectClassName} id="import-background-fit" onChange={(event) => setFit(event.target.value as ImageFit)} value={fit}><option value="contain">พอดีกับหน้า — เห็นภาพทั้งหมด อาจมีขอบว่าง</option><option value="cover">เติมเต็มหน้า — อาจตัดขอบภาพ</option><option value="fill">ยืดเต็มหน้า — อาจทำให้ภาพผิดสัดส่วน</option></select></Field>
    <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700"><input checked={addRecipient} className="mt-1 size-4" onChange={(event) => setAddRecipient(event.target.checked)} type="checkbox" /><span><strong className="block text-slate-950">เพิ่มชื่อผู้รับใบประกาศ</strong>วางไว้กลางหน้าเป็นจุดเริ่มต้น แล้วลากไปยังตำแหน่งที่ต้องการ</span></label>
    {error === null ? null : <p className="text-sm text-red-700" role="alert">{error}</p>}
  </div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={onCancel} variant="secondary">ยกเลิก</Button><Button disabled={pending || file === null} type="submit">{pending ? "กำลังนำเข้า…" : "สร้างแบบร่างจากไฟล์นี้"}</Button></footer></form>;
}
