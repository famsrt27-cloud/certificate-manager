"use client";

import type { TemplateAsset } from "@certificate-platform/contracts";

import { Input } from "../../ui/input";
import { Field, selectClassName } from "../resource-ui";
import { bindingOptions, type TemplateDefinition, type TemplateElement } from "./template-model";

const colorClass = "h-11 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1";

function NumericField({ label, max, min, onChange, step = 1, value }: { readonly label: string; readonly max: number; readonly min: number; readonly onChange: (value: number) => void; readonly step?: number; readonly value: number }) {
  const id = `element-${label.toLowerCase().replaceAll(" ", "-")}`;
  return <Field htmlFor={id} label={label}><Input id={id} inputMode="decimal" max={max} min={min} onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next))); }} step={step} type="number" value={value} /></Field>;
}

export function TemplateProperties({ assets, definition, element, onUpdate, readOnly }: {
  readonly assets: readonly TemplateAsset[];
  readonly definition: TemplateDefinition;
  readonly element: TemplateElement;
  readonly onUpdate: (element: TemplateElement) => void;
  readonly readOnly: boolean;
}) {
  const imageAssets = assets.filter((asset) => asset.status === "ACTIVE" && asset.detected_mime_type.startsWith("image/"));
  const fontAssets = assets.filter((asset) => asset.status === "ACTIVE" && asset.detected_mime_type.startsWith("font/"));
  const updateCommon = (key: "x" | "y" | "width" | "height" | "opacity", value: number) => onUpdate({ ...element, [key]: value } as TemplateElement);
  return <fieldset className="space-y-5" disabled={readOnly}><legend className="sr-only">คุณสมบัติองค์ประกอบ</legend>
    {element.type === "text" ? <>
      <Field htmlFor="text-mode" label="ประเภทข้อความ"><select className={selectClassName} id="text-mode" onChange={(event) => {
        const common = { type: "text" as const, x: element.x, y: element.y, width: element.width, height: element.height, opacity: element.opacity, align: element.align, color: element.color, font: element.font };
        if (event.target.value === "binding") onUpdate({ ...common, binding: "recipient.display_name" });
        else onUpdate({ ...common, text: "ข้อความใหม่" });
      }} value={element.binding === undefined ? "text" : "binding"}><option value="text">ข้อความคงที่</option><option value="binding">ข้อมูลอัตโนมัติ</option></select></Field>
      {element.binding === undefined ? <Field htmlFor="element-text" label="ข้อความ"><textarea className={`${selectClassName} min-h-24 resize-y`} id="element-text" maxLength={2000} onChange={(event) => onUpdate({ ...element, text: event.target.value })} value={element.text ?? ""} /></Field>
        : <Field htmlFor="element-binding" label="ข้อมูลที่แสดง"><select className={selectClassName} id="element-binding" onChange={(event) => onUpdate({ ...element, binding: event.target.value as NonNullable<typeof element.binding> })} value={element.binding}>{bindingOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
      <Field htmlFor="element-font" label="แบบอักษรบนใบประกาศ"><select className={selectClassName} id="element-font" onChange={(event) => {
        if (event.target.value.startsWith("asset:")) { const asset = fontAssets.find((candidate) => candidate.id === event.target.value.slice(6)); if (asset !== undefined) onUpdate({ ...element, font: { ...element.font, family: asset.original_filename, asset_id: asset.id } }); }
        else onUpdate({ ...element, font: { family: event.target.value, size: element.font.size, weight: element.font.weight } });
      }} value={element.font.asset_id === undefined ? element.font.family : `asset:${element.font.asset_id}`}><option value="Noto Sans Thai">Noto Sans Thai</option><option value="Noto Serif Thai">Noto Serif Thai</option>{fontAssets.map((asset) => <option key={asset.id} value={`asset:${asset.id}`}>{asset.original_filename}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3"><NumericField label="ขนาดตัวอักษร" max={200} min={6} onChange={(value) => onUpdate({ ...element, font: { ...element.font, size: value } })} value={element.font.size} /><Field htmlFor="element-weight" label="น้ำหนัก"><select className={selectClassName} id="element-weight" onChange={(event) => onUpdate({ ...element, font: { ...element.font, weight: Number(event.target.value) as 400 | 700 } })} value={element.font.weight}><option value="400">ปกติ</option><option value="700">หนา</option></select></Field></div>
      <div className="grid grid-cols-2 gap-3"><Field htmlFor="element-align" label="จัดแนว"><select className={selectClassName} id="element-align" onChange={(event) => onUpdate({ ...element, align: event.target.value as "left" | "center" | "right" })} value={element.align}><option value="left">ซ้าย</option><option value="center">กึ่งกลาง</option><option value="right">ขวา</option></select></Field><Field htmlFor="element-color" label="สีข้อความ"><input aria-label="สีข้อความ" className={colorClass} id="element-color" onChange={(event) => onUpdate({ ...element, color: event.target.value.toUpperCase() })} type="color" value={element.color} /></Field></div>
    </> : null}
    {element.type === "image" ? <><Field hint="แสดงเฉพาะรูปภาพที่ผ่านการตรวจสอบแล้ว" htmlFor="image-asset" label="ไฟล์รูปภาพ"><select className={selectClassName} id="image-asset" onChange={(event) => onUpdate({ ...element, asset_id: event.target.value })} value={element.asset_id}>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.original_filename}</option>)}</select></Field><Field htmlFor="image-fit" label="การวางรูป"><select className={selectClassName} id="image-fit" onChange={(event) => onUpdate({ ...element, fit: event.target.value as "contain" | "cover" | "fill" })} value={element.fit}><option value="contain">แสดงครบทั้งภาพ</option><option value="cover">เต็มพื้นที่และครอบตัด</option><option value="fill">ยืดเต็มพื้นที่</option></select></Field></> : null}
    {element.type === "signature" ? <Field hint="แสดงเฉพาะรูปภาพที่ผ่านการตรวจสอบแล้ว" htmlFor="signature-asset" label="ไฟล์ลายเซ็น"><select className={selectClassName} id="signature-asset" onChange={(event) => onUpdate({ ...element, asset_id: event.target.value })} value={element.asset_id}>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.original_filename}</option>)}</select></Field> : null}
    {element.type === "qr" ? <div className="grid grid-cols-2 gap-3"><Field htmlFor="qr-foreground" label="สี QR"><input className={colorClass} id="qr-foreground" onChange={(event) => onUpdate({ ...element, foreground: event.target.value.toUpperCase() })} type="color" value={element.foreground} /></Field><Field htmlFor="qr-background" label="สีพื้นหลัง"><input className={colorClass} id="qr-background" onChange={(event) => onUpdate({ ...element, background: event.target.value.toUpperCase() })} type="color" value={element.background} /></Field></div> : null}
    {element.type === "shape" ? <><Field htmlFor="shape-type" label="รูปแบบ"><select className={selectClassName} id="shape-type" onChange={(event) => onUpdate({ ...element, shape: event.target.value as "line" | "rectangle" })} value={element.shape}><option value="rectangle">กรอบสี่เหลี่ยม</option><option value="line">เส้น</option></select></Field><div className="grid grid-cols-2 gap-3"><Field htmlFor="shape-color" label="สี"><input className={colorClass} id="shape-color" onChange={(event) => onUpdate({ ...element, color: event.target.value.toUpperCase() })} type="color" value={element.color} /></Field><NumericField label="ความหนาเส้น" max={20} min={0.5} onChange={(value) => onUpdate({ ...element, stroke_width: value })} step={0.5} value={element.stroke_width} /></div></> : null}
    <details className="rounded-lg border border-slate-200 bg-slate-50"><summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-slate-700">ตำแหน่งและขนาดแบบละเอียด</summary><div className="grid grid-cols-2 gap-3 border-t border-slate-200 p-3"><NumericField label="X" max={definition.page.width - element.width} min={0} onChange={(value) => updateCommon("x", value)} value={element.x} /><NumericField label="Y" max={definition.page.height - element.height} min={0} onChange={(value) => updateCommon("y", value)} value={element.y} /><NumericField label="ความกว้าง" max={definition.page.width - element.x} min={1} onChange={(value) => updateCommon("width", value)} value={element.width} /><NumericField label="ความสูง" max={definition.page.height - element.y} min={1} onChange={(value) => updateCommon("height", value)} value={element.height} /><NumericField label="ความทึบ" max={1} min={0} onChange={(value) => updateCommon("opacity", value)} step={0.05} value={element.opacity} /></div></details>
  </fieldset>;
}
