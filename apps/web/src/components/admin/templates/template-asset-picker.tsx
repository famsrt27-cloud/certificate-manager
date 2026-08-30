"use client";

import type { TemplateAsset } from "@certificate-platform/contracts";
import Image from "next/image";
import { useRef, useState, type ChangeEvent } from "react";

import { Button } from "../../ui/button";
import { Dialog } from "../resource-ui";
import { assetTypeLabel } from "./template-model";

export type AssetPickerKind = "image" | "signature";

export function TemplateAssetPicker({ assets, backgroundAssetIds, failedImages, imageUrls, kind, onClose, onSelect,
  onUpload, open, pending, uploadAllowed }: {
  readonly assets: readonly TemplateAsset[]; readonly backgroundAssetIds: ReadonlySet<string>;
  readonly failedImages: ReadonlySet<string>; readonly imageUrls: ReadonlyMap<string, string>; readonly kind: AssetPickerKind;
  readonly onClose: () => void; readonly onSelect: (asset: TemplateAsset) => void;
  readonly onUpload: (file: File) => Promise<void>; readonly open: boolean; readonly pending: boolean; readonly uploadAllowed: boolean;
}) {
  const usable = assets.filter((asset) => asset.status === "ACTIVE"
    && (asset.detected_mime_type === "image/png" || asset.detected_mime_type === "image/jpeg"));
  const [selectedId, setSelectedId] = useState<string | null>(null); const inputRef = useRef<HTMLInputElement>(null);
  const selected = usable.find((asset) => asset.id === selectedId);
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ""; if (file !== undefined) void onUpload(file);
  };
  const title = kind === "signature" ? "เลือกรูปลายเซ็น" : "เลือกรูปภาพ";
  return <Dialog description={kind === "signature" ? "เลือกรูปที่ผ่านการตรวจสอบแล้ว ระบบจะจัดวางแบบ contain เพื่อรักษาสัดส่วนลายเซ็น" : "เลือกรูปที่ผ่านการตรวจสอบแล้วอย่างชัดเจนก่อนเพิ่มลงบนใบประกาศ"}
    onClose={onClose} open={open} pending={pending} title={title}>
    <div>
      <div className="max-h-[min(62vh,38rem)] overflow-y-auto px-4 py-4 sm:px-6">
        {usable.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
          <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-full bg-white text-xl shadow-sm">▧</span>
          <h3 className="mt-4 text-sm font-semibold text-slate-950">ยังไม่มีรูปภาพที่พร้อมใช้งาน</h3>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-slate-500">ไฟล์ต้องผ่านการตรวจสอบและมีสถานะพร้อมใช้งานก่อนสร้างองค์ประกอบ</p>
          {uploadAllowed ? <Button className="mt-5" disabled={pending} onClick={() => inputRef.current?.click()}>อัปโหลดรูปภาพ</Button> : null}
        </div> : <div aria-label="รูปภาพที่พร้อมใช้งาน" className="grid grid-cols-1 gap-3 min-[520px]:grid-cols-2 lg:grid-cols-3" role="listbox">
          {usable.map((asset) => { const chosen = selectedId === asset.id; const source = imageUrls.get(asset.id);
            return <button aria-label={`เลือก ${asset.original_filename}`} aria-selected={chosen} className={`group overflow-hidden rounded-xl border-2 bg-white text-left shadow-sm transition ${chosen ? "border-[#2557a7] ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-300"}`}
              key={asset.id} onClick={() => setSelectedId(asset.id)} role="option" type="button">
              <span className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[linear-gradient(135deg,#f8fafc_25%,#eef2f7_25%,#eef2f7_50%,#f8fafc_50%,#f8fafc_75%,#eef2f7_75%)] bg-[length:16px_16px]">
                {source === undefined ? <span className="px-3 text-center text-xs text-slate-500">{failedImages.has(asset.id) ? "ไม่สามารถโหลดตัวอย่าง" : "กำลังโหลดตัวอย่าง…"}</span>
                  : <Image alt="" className="object-contain p-2" fill sizes="(max-width: 519px) 100vw, 33vw" src={source} unoptimized />}
                <span className={`absolute right-2 top-2 grid size-7 place-items-center rounded-full border-2 border-white text-sm font-bold shadow ${chosen ? "bg-[#2557a7] text-white" : "bg-white text-transparent"}`} aria-hidden="true">✓</span>
              </span>
              <span className="block p-3"><span className="block truncate text-sm font-semibold text-slate-950">{asset.original_filename}</span>
                <span className="mt-1 block text-xs text-slate-500">{assetTypeLabel(asset)}{asset.width_px === null || asset.height_px === null ? "" : ` · ${asset.width_px} × ${asset.height_px} px`}</span>
                {backgroundAssetIds.has(asset.id) ? <span className="mt-2 inline-flex rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">ใช้อยู่เป็นพื้นหลัง</span> : null}
              </span>
            </button>;
          })}
        </div>}
        <input accept=".png,.jpg,.jpeg,image/png,image/jpeg" aria-label="อัปโหลดรูปใหม่จากตัวเลือก" className="sr-only" disabled={pending || !uploadAllowed}
          onChange={upload} ref={inputRef} type="file" />
      </div>
      <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>{usable.length > 0 && uploadAllowed ? <Button disabled={pending} onClick={() => inputRef.current?.click()} variant="secondary">อัปโหลดรูปใหม่</Button> : null}</div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row"><Button disabled={pending} onClick={onClose} variant="secondary">ยกเลิก</Button>
          <Button disabled={pending || selected === undefined} onClick={() => { if (selected !== undefined) onSelect(selected); }}>ใช้รูปที่เลือก</Button></div>
      </footer>
    </div>
  </Dialog>;
}
