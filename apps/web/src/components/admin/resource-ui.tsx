"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "../ui/button";

export type RecordStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";

const statusPresentation: Record<RecordStatus, { label: string; className: string }> = {
  ACTIVE: { label: "ใช้งาน", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  INACTIVE: { label: "ไม่ใช้งาน", className: "border-amber-200 bg-amber-50 text-amber-800" },
  ARCHIVED: { label: "เก็บถาวร", className: "border-slate-200 bg-slate-100 text-slate-600" }
};

export function StatusBadge({ status }: { readonly status: RecordStatus }) {
  const presentation = statusPresentation[status];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.className}`}>{presentation.label}</span>;
}

export function Feedback({ message, kind }: { readonly message: string | null; readonly kind: "success" | "error" }) {
  if (message === null) return null;
  return (
    <div aria-live={kind === "error" ? "assertive" : "polite"} className={`mb-5 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm leading-6 ${
      kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800"
    }`} role={kind === "error" ? "alert" : "status"}>
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export function Field({ children, error, hint, label, htmlFor }: {
  readonly children: ReactNode;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly label: string;
  readonly htmlFor: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-800" htmlFor={htmlFor}>{label}</label>
      <div className="mt-1.5">{children}</div>
      {error === undefined ? (hint === undefined ? null : <p className="mt-1.5 text-xs leading-5 text-slate-500">{hint}</p>)
        : <p className="mt-1.5 text-xs leading-5 text-red-700" id={`${htmlFor}-error`}>{error}</p>}
    </div>
  );
}

export function Dialog({ children, description, open, onClose, title, pending = false, size = "default" }: {
  readonly children: ReactNode;
  readonly description?: string | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly pending?: boolean;
  readonly size?: "default" | "wide";
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogPanel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeButton.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = priorOverflow;
      const target = returnFocus.current;
      window.setTimeout(() => target?.focus(), 0);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogPanel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open, pending]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid items-end sm:items-center sm:justify-items-center sm:p-5">
      <button aria-label="ปิดหน้าต่าง" className="absolute inset-0 bg-slate-950/45" disabled={pending} onClick={onClose} type="button" />
      <section aria-describedby={description === undefined ? undefined : "resource-dialog-description"} aria-labelledby="resource-dialog-title"
        aria-modal="true" className={`relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl ${size === "wide" ? "sm:max-w-4xl" : "sm:max-w-xl"}`} ref={dialogPanel} role="dialog">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-950" id="resource-dialog-title">{title}</h2>
            {description === undefined ? null : <p className="mt-1 text-sm leading-6 text-slate-600" id="resource-dialog-description">{description}</p>}
          </div>
          <button aria-label="ปิด" className="grid size-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            disabled={pending} onClick={onClose} ref={closeButton} type="button">
            <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></svg>
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function LoadingRows() {
  return <div aria-busy="true" aria-label="กำลังโหลดข้อมูล" className="space-y-3 p-5"><span className="sr-only">กำลังโหลดข้อมูล…</span>{[1, 2, 3].map((item) => (
    <div className="h-16 animate-pulse rounded-lg bg-slate-100" key={item} />
  ))}</div>;
}

export function LoadError({ onRetry }: { readonly onRetry: () => void }) {
  return <div className="px-5 py-14 text-center" role="alert"><h2 className="text-base font-semibold text-slate-950">ไม่สามารถโหลดข้อมูลได้</h2>
    <p className="mt-2 text-sm text-slate-600">โปรดลองอีกครั้ง หากปัญหายังคงอยู่ให้ติดต่อผู้ดูแลระบบ</p>
    <Button className="mt-5" onClick={onRetry} variant="secondary">ลองอีกครั้ง</Button></div>;
}

export function Pagination({ canGoBack, canGoNext, onBack, onNext }: {
  readonly canGoBack: boolean;
  readonly canGoNext: boolean;
  readonly onBack: () => void;
  readonly onNext: () => void;
}) {
  if (!canGoBack && !canGoNext) return null;
  return <nav aria-label="การแบ่งหน้า" className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 sm:justify-end">
    <Button className="flex-1 sm:flex-none" disabled={!canGoBack} onClick={onBack} variant="secondary">ก่อนหน้า</Button>
    <Button className="flex-1 sm:flex-none" disabled={!canGoNext} onClick={onNext} variant="secondary">ถัดไป</Button>
  </nav>;
}

export const selectClassName = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:border-slate-400 focus:border-[#2557a7] focus:outline-none focus:ring-3 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100";
