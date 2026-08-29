"use client";

import type { TemplateAsset } from "@certificate-platform/contracts";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { elementLabel, type TemplateDefinition, type TemplateElement } from "./template-model";
import { elementPlacement, TemplateVisualSurface } from "./template-visual-surface";

type BoundElement = { readonly index: number; readonly value: string | null };
type ResizeCorner = "nw" | "ne" | "sw" | "se";
type Interaction = { readonly kind: "drag" | "resize"; readonly corner?: ResizeCorner; readonly pointerId: number;
  readonly startClientX: number; readonly startClientY: number; readonly start: TemplateElement };

const roundCoordinate = (value: number): number => Math.round(value * 10) / 10;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const isTypingTarget = (target: EventTarget | null): boolean => target instanceof HTMLElement
  && (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable
    || target.closest("[contenteditable='true'], [role='textbox']") !== null);

export function TemplateCanvas({ assets, boundElements, definition, editable, elementKeys, failedImages, imageUrls, lockedIndices, onChange,
  onSelect, selectedIndex }: {
  readonly assets: readonly TemplateAsset[]; readonly boundElements: readonly BoundElement[];
  readonly definition: TemplateDefinition; readonly editable: boolean; readonly lockedIndices: ReadonlySet<number>;
  readonly elementKeys: readonly string[]; readonly failedImages: ReadonlySet<string>; readonly imageUrls: ReadonlyMap<string, string>;
  readonly onChange: (index: number, element: TemplateElement) => void; readonly onSelect: (index: number) => void;
  readonly selectedIndex: number | null;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction | null>(null);

  const selected = selectedIndex === null ? undefined : definition.elements[selectedIndex];
  const selectedLocked = selectedIndex !== null && lockedIndices.has(selectedIndex);
  const placement = (element: TemplateElement) => elementPlacement(element, definition);
  const applyPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const active = interaction.current; const canvas = canvasRef.current;
    if (active === null || canvas === null || selectedIndex === null || event.pointerId !== active.pointerId) return;
    const scale = canvas.getBoundingClientRect().width / definition.page.width;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const dx = (event.clientX - active.startClientX) / scale; const dy = (event.clientY - active.startClientY) / scale;
    if (active.kind === "drag") {
      onChange(selectedIndex, { ...active.start,
        x: roundCoordinate(clamp(active.start.x + dx, 0, definition.page.width - active.start.width)),
        y: roundCoordinate(clamp(active.start.y + dy, 0, definition.page.height - active.start.height)) }); return;
    }
    const corner = active.corner ?? "se"; const fromLeft = corner.endsWith("w"); const fromTop = corner.startsWith("n");
    const fixedX = fromLeft ? active.start.x + active.start.width : active.start.x;
    const fixedY = fromTop ? active.start.y + active.start.height : active.start.y;
    let movingX = fromLeft ? active.start.x + dx : active.start.x + active.start.width + dx;
    let movingY = fromTop ? active.start.y + dy : active.start.y + active.start.height + dy;
    movingX = fromLeft ? clamp(movingX, 0, fixedX - 8) : clamp(movingX, fixedX + 8, definition.page.width);
    movingY = fromTop ? clamp(movingY, 0, fixedY - 8) : clamp(movingY, fixedY + 8, definition.page.height);
    let width = Math.abs(movingX - fixedX); let height = Math.abs(movingY - fixedY);
    const preserveRatio = active.start.type === "qr"
      || ((active.start.type === "image" || active.start.type === "signature") && event.shiftKey);
    if (preserveRatio) {
      const ratio = active.start.type === "qr" ? 1 : active.start.width / active.start.height;
      const maximumWidth = fromLeft ? fixedX : definition.page.width - fixedX;
      const maximumHeight = fromTop ? fixedY : definition.page.height - fixedY;
      if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio; else width = height * ratio;
      if (width > maximumWidth) { width = maximumWidth; height = width / ratio; }
      if (height > maximumHeight) { height = maximumHeight; width = height * ratio; }
      width = Math.max(8, width); height = Math.max(8, height);
    }
    const x = fromLeft ? fixedX - width : fixedX; const y = fromTop ? fixedY - height : fixedY;
    onChange(selectedIndex, { ...active.start, x: roundCoordinate(x), y: roundCoordinate(y),
      width: roundCoordinate(width), height: roundCoordinate(height) });
  };
  const beginInteraction = (kind: Interaction["kind"], event: ReactPointerEvent<HTMLElement>, corner?: ResizeCorner) => {
    if (!editable || selected === undefined || selectedLocked || selectedIndex === null) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = { kind, ...(corner === undefined ? {} : { corner }), pointerId: event.pointerId, startClientX: event.clientX,
      startClientY: event.clientY, start: structuredClone(selected) };
  };
  const endInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    if (interaction.current?.pointerId === event.pointerId) interaction.current = null;
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!editable || selected === undefined || selectedLocked || selectedIndex === null || isTypingTarget(event.target)) return;
    const directions: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key]; if (direction === undefined) return;
    event.preventDefault(); const step = event.shiftKey ? 10 : 1;
    onChange(selectedIndex, { ...selected,
      x: clamp(selected.x + direction[0] * step, 0, definition.page.width - selected.width),
      y: clamp(selected.y + direction[1] * step, 0, definition.page.height - selected.height) });
  };

  return <div className="mx-auto w-full max-w-5xl">
    <div ref={canvasRef} className="relative w-full overflow-hidden rounded-sm border border-slate-300 bg-[#fffdf8] shadow-[0_18px_45px_rgba(15,23,42,0.13)]" style={{ aspectRatio: `${definition.page.width}/${definition.page.height}`, containerType: "inline-size" }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-35" style={{ backgroundImage: "linear-gradient(rgba(37,87,167,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(37,87,167,.035) 1px, transparent 1px)", backgroundSize: "4% 4%" }} />
      <TemplateVisualSurface assets={assets} boundElements={boundElements} definition={definition} failedImages={failedImages}
        imageUrls={imageUrls} interactive onSelect={onSelect} renderKeys={elementKeys} selectedIndex={selectedIndex} />
      {selected !== undefined && selectedIndex !== null ? <div aria-label={`${selectedLocked ? "เลเยอร์ถูกล็อก" : "เลเยอร์ที่เลือก สามารถลากหรือใช้ปุ่มลูกศรเพื่อย้าย"}: ${elementLabel(selected, assets, definition)}`} className={`absolute outline-2 outline-offset-2 ${selectedLocked ? "cursor-not-allowed outline-amber-500" : "cursor-move outline-[#2557a7]"}`} onKeyDown={moveByKeyboard} onPointerCancel={endInteraction} onPointerDown={(event) => beginInteraction("drag", event)} onPointerMove={applyPointer} onPointerUp={endInteraction} role="group" style={{ ...placement(selected), opacity: 1, touchAction: "none" }} tabIndex={0}>
        <span className="pointer-events-none absolute -top-7 left-0 rounded bg-slate-950 px-2 py-1 text-[10px] font-semibold text-white">{selectedLocked ? "ล็อกพื้นหลัง" : "ลากเพื่อย้าย"}</span>
        {!selectedLocked && editable ? <>
          <button aria-label="ปรับขนาดจากมุมซ้ายบน" className="absolute -left-3 -top-3 size-7 cursor-nwse-resize rounded-full border-2 border-white bg-[#2557a7] shadow-md" onPointerCancel={(event) => { event.stopPropagation(); endInteraction(event); }} onPointerDown={(event) => { event.stopPropagation(); beginInteraction("resize", event, "nw"); }} onPointerMove={(event) => { event.stopPropagation(); applyPointer(event); }} onPointerUp={(event) => { event.stopPropagation(); endInteraction(event); }} style={{ touchAction: "none" }} type="button" />
          <button aria-label="ปรับขนาดจากมุมขวาบน" className="absolute -right-3 -top-3 size-7 cursor-nesw-resize rounded-full border-2 border-white bg-[#2557a7] shadow-md" onPointerCancel={(event) => { event.stopPropagation(); endInteraction(event); }} onPointerDown={(event) => { event.stopPropagation(); beginInteraction("resize", event, "ne"); }} onPointerMove={(event) => { event.stopPropagation(); applyPointer(event); }} onPointerUp={(event) => { event.stopPropagation(); endInteraction(event); }} style={{ touchAction: "none" }} type="button" />
          <button aria-label="ปรับขนาดจากมุมซ้ายล่าง" className="absolute -bottom-3 -left-3 size-7 cursor-nesw-resize rounded-full border-2 border-white bg-[#2557a7] shadow-md" onPointerCancel={(event) => { event.stopPropagation(); endInteraction(event); }} onPointerDown={(event) => { event.stopPropagation(); beginInteraction("resize", event, "sw"); }} onPointerMove={(event) => { event.stopPropagation(); applyPointer(event); }} onPointerUp={(event) => { event.stopPropagation(); endInteraction(event); }} style={{ touchAction: "none" }} type="button" />
          <button aria-label="ลากเพื่อปรับขนาด" className="absolute -bottom-3 -right-3 size-7 cursor-nwse-resize rounded-full border-2 border-white bg-[#2557a7] shadow-md" onPointerCancel={(event) => { event.stopPropagation(); endInteraction(event); }} onPointerDown={(event) => { event.stopPropagation(); beginInteraction("resize", event, "se"); }} onPointerMove={(event) => { event.stopPropagation(); applyPointer(event); }} onPointerUp={(event) => { event.stopPropagation(); endInteraction(event); }} style={{ touchAction: "none" }} type="button" />
        </> : null}
      </div> : null}
      {definition.elements.length === 0 ? <div className="absolute inset-0 grid place-items-center p-8 text-center"><div><span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-[#2557a7]">＋</span><p className="mt-3 text-[2cqw] font-medium text-slate-600">เพิ่มองค์ประกอบเพื่อเริ่มออกแบบใบประกาศ</p></div></div> : null}
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"><span>ลากเพื่อจัดวาง · Shift + ลูกศร ขยับครั้งละ 10 หน่วย</span><span>{Math.round(definition.page.width)} × {Math.round(definition.page.height)} หน่วยออกแบบ</span></div>
  </div>;
}
