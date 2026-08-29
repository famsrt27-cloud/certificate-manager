"use client";

import Image from "next/image";
import type { TemplateAsset } from "@certificate-platform/contracts";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

import { SampleQr } from "./sample-qr";
import { bindingLabel, elementLabel, type TemplateDefinition, type TemplateElement } from "./template-model";

const sampleBindings: Readonly<Record<string, string>> = {
  "recipient.display_name": "นายสมชาย ใจดี", "project.name": "โครงการตัวอย่าง",
  "training.name": "หลักสูตรอบรมตัวอย่าง", "training.code": "TRN-001",
  "certificate.number": "CERT-0001", "certificate.issued_at": "29 สิงหาคม 2569",
  verification_url: "ตัวอย่างสำหรับออกแบบ"
};

export const elementPlacement = (element: TemplateElement, definition: TemplateDefinition): CSSProperties => ({
  left: `${element.x / definition.page.width * 100}%`, top: `${element.y / definition.page.height * 100}%`,
  width: `${element.width / definition.page.width * 100}%`, height: `${element.height / definition.page.height * 100}%`,
  opacity: element.opacity
});

export function TemplateVisualSurface({ assets = [], boundElements = [], definition, failedImages = new Set(), imageUrls = new Map(),
  interactive = false, onSelect, renderKeys, selectedIndex }: {
  readonly assets?: readonly TemplateAsset[];
  readonly boundElements?: readonly { readonly index: number; readonly value: string | null }[];
  readonly definition: TemplateDefinition; readonly failedImages?: ReadonlySet<string>; readonly imageUrls?: ReadonlyMap<string, string>;
  readonly interactive?: boolean; readonly onSelect?: (index: number) => void; readonly renderKeys?: readonly string[];
  readonly selectedIndex?: number | null;
}) {
  const bound = new Map(boundElements.map((element) => [element.index, element.value]));
  return <>
    {definition.elements.map((element, index) => {
      const style = elementPlacement(element, definition); const key = renderKeys?.[index] ?? `readonly-${index}-${element.type}`;
      const common = interactive ? "absolute overflow-hidden focus:outline-none hover:outline hover:outline-1 hover:outline-blue-300 focus:outline-2 focus:outline-[#2557a7]" : "absolute overflow-hidden";
      const selectProps = interactive ? { role: "button", tabIndex: 0, "aria-label": `เลือกเลเยอร์ ${elementLabel(element, assets, definition)}`,
        "aria-pressed": selectedIndex === index, onClick: () => onSelect?.(index), onKeyDown: (event: ReactKeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(index); }
        } } as const : { "aria-hidden": true } as const;
      if (element.type === "text") {
        const value = bound.get(index) ?? element.text ?? (element.binding === undefined ? "ข้อความ" : sampleBindings[element.binding] ?? bindingLabel(element.binding));
        return <div {...selectProps} className={`${common} flex items-start`} key={key} style={{ ...style, color: element.color,
          fontFamily: element.font.family, fontSize: `${element.font.size / definition.page.width * 100}cqw`, fontWeight: element.font.weight,
          justifyContent: element.align === "left" ? "flex-start" : element.align === "right" ? "flex-end" : "center",
          lineHeight: 1.35, textAlign: element.align }}><span className="w-full whitespace-pre-wrap break-words">{value}</span></div>;
      }
      if (element.type === "shape") return <div {...selectProps} className={common} key={key} style={style}>{element.shape === "rectangle"
        ? <span className="absolute inset-0" style={{ border: `${Math.max(1, element.stroke_width / definition.page.width * 100)}cqw solid ${element.color}` }} />
        : <svg aria-hidden="true" className="size-full" preserveAspectRatio="none" viewBox="0 0 100 100"><line stroke={element.color} strokeWidth={Math.max(1, element.stroke_width)} x1="0" x2="100" y1="0" y2="100" /></svg>}</div>;
      if (element.type === "qr") return <div {...selectProps} className={`${common} bg-white`} key={key} style={style}><SampleQr background={element.background} foreground={element.foreground} /></div>;
      const asset = assets.find((candidate) => candidate.id === element.asset_id); const source = imageUrls.get(element.asset_id);
      return <div {...selectProps} className={`${common} grid place-items-center bg-slate-100/50 text-center`} key={key} style={style}>{source === undefined
        ? <span className="max-w-full px-1 text-[1.35cqw] font-medium text-slate-600">{failedImages.has(element.asset_id) ? "โหลดภาพตัวอย่างไม่สำเร็จ" : "กำลังโหลดภาพ…"}<br />{asset?.original_filename ?? "ไฟล์รูปภาพส่วนตัว"}</span>
        : <Image alt="" className="select-none" draggable={false} fill sizes="100vw" src={source}
          style={{ objectFit: element.type === "signature" ? "contain" : element.fit }} unoptimized />}</div>;
    })}
  </>;
}
