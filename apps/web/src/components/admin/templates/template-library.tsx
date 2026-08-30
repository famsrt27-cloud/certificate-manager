"use client";

import {
  CreateTemplateRequestSchema, TemplateListResponseSchema, TemplateResponseSchema, UpdateTemplateRequestSchema,
  type AuthenticationData, type Template, type TemplateListItem
} from "@certificate-platform/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AdminPageHeader } from "../admin-page-header";
import { Dialog, Feedback, Field, LoadError, LoadingRows, Pagination, StatusBadge, selectClassName, type RecordStatus } from "../resource-ui";
import { TemplateImportDialog } from "./template-import-dialog";
import { versionPresentation } from "./template-model";
import { TemplateVisualSurface } from "./template-visual-surface";
import { usePrivateTemplateImages } from "./use-private-template-images";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const pageSize = 12;
type Membership = AuthenticationData["memberships"][number];
type FeedbackState = { readonly kind: "success" | "error"; readonly message: string } | null;
type DialogState = { type: "create" | "import" } | { type: "rename" | "archive"; template: Template } | null;

function TemplateThumbnail({ adminFetch, template }: {
  readonly adminFetch: (path: string, init?: RequestInit) => Promise<Response>; readonly template: TemplateListItem;
}) {
  const host = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(false); const preview = template.preview;
  const imageReferences = useMemo(() => preview === null ? [] : [...new Set(preview.definition.elements.flatMap((element) =>
    element.type === "image" || element.type === "signature" ? [element.asset_id] : []))].map((id) => ({ id })), [preview]);
  const images = usePrivateTemplateImages(adminFetch, template.id, imageReferences, visible);
  useEffect(() => {
    const node = host.current; if (node === null || visible) return;
    if (!("IntersectionObserver" in window)) { const timer = setTimeout(() => setVisible(true), 0); return () => clearTimeout(timer); }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" });
    observer.observe(node); return () => observer.disconnect();
  }, [visible]);
  if (preview === null) return <div className="grid h-52 place-items-center bg-[radial-gradient(circle_at_top,#f8fafc,#eef2f7)] px-6 text-center" ref={host}>
    <div><span aria-hidden="true" className="mx-auto grid size-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-400">▱</span><p className="mt-3 text-sm font-semibold text-slate-600">ยังไม่ได้ออกแบบ</p></div></div>;
  const ratio = preview.definition.page.width / preview.definition.page.height;
  const failed = imageReferences.some((reference) => images.failed.has(reference.id));
  return <div className="relative grid h-52 place-items-center overflow-hidden bg-[linear-gradient(135deg,#e8edf4,#f8fafc)] p-4" ref={host}>
    {!visible || images.loading ? <div aria-hidden="true" className="absolute inset-4 animate-pulse rounded-md bg-white/75" /> : failed
      ? <div className="relative z-10 rounded-lg border border-red-100 bg-white/95 px-4 py-3 text-center text-xs font-semibold text-red-700">ไม่สามารถโหลดตัวอย่าง</div>
      : <div aria-hidden="true" className="relative overflow-hidden rounded-sm bg-[#fffdf8] shadow-[0_8px_24px_rgba(15,23,42,0.18)]"
          style={{ aspectRatio: String(ratio), containerType: "inline-size", ...(ratio >= 1 ? { width: "100%" } : { height: "100%" }) }}>
          <TemplateVisualSurface definition={preview.definition} imageUrls={images.urls} />
        </div>}
  </div>;
}

function TemplateNameForm({ adminFetch, initial, onCancel, onSaved }: {
  readonly adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly initial?: Template;
  readonly onCancel: () => void;
  readonly onSaved: (template: Template) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = (initial === undefined ? CreateTemplateRequestSchema : UpdateTemplateRequestSchema).safeParse({ name });
    if (!parsed.success) { setError("กรุณาระบุชื่อเทมเพลตไม่เกิน 200 ตัวอักษร"); return; }
    setPending(true); setError(null);
    try {
      const response = await adminFetch(initial === undefined ? "/admin/templates" : `/admin/templates/${initial.id}`, {
        method: initial === undefined ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data)
      });
      const body: unknown = await response.json(); const result = TemplateResponseSchema.safeParse(body);
      if (!response.ok || !result.success) throw new Error("template response");
      onSaved(result.data.data);
    } catch { setError("ไม่สามารถบันทึกเทมเพลตได้ กรุณาลองอีกครั้ง"); }
    finally { setPending(false); }
  };
  return <form noValidate onSubmit={(event) => void submit(event)}><div className="px-5 py-5 sm:px-6">
    <Field error={error ?? undefined} hint="ตั้งชื่อให้ทีมค้นหาและเลือกใช้งานได้ง่าย" htmlFor="template-name" label="ชื่อเทมเพลต">
      <Input autoFocus id="template-name" invalid={error !== null} maxLength={200} onChange={(event) => { setName(event.target.value); setError(null); }} value={name} />
    </Field>
  </div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
    <Button disabled={pending} onClick={onCancel} variant="secondary">ยกเลิก</Button><Button disabled={pending || name.trim() === initial?.name} type="submit">{pending ? "กำลังบันทึก…" : initial === undefined ? "สร้างเทมเพลต" : "บันทึกชื่อ"}</Button>
  </footer></form>;
}

export function TemplateLibrary({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const router = useRouter(); const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const canImportDesign = permissions.has("template:create") && permissions.has("template:update")
    && permissions.has("template:asset:create");
  const [templates, setTemplates] = useState<TemplateListItem[]>([]); const [status, setStatus] = useState<RecordStatus | "">("");
  const [cursor, setCursor] = useState<string | undefined>(); const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(false); const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null); const [feedback, setFeedback] = useState<FeedbackState>(null); const [archivePending, setArchivePending] = useState(false);
  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, { ...init, cache: "no-store", credentials: "same-origin", headers: {
    "X-Organization-ID": membership.organization.id, ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers
  } }), [csrfToken, membership.organization.id]);

  useEffect(() => {
    const controller = new AbortController(); const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor); if (status !== "") query.set("status", status);
    void adminFetch(`/admin/templates?${query}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json(); const parsed = TemplateListResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("template list"); setTemplates(parsed.data.data); setNextCursor(parsed.data.meta.next_cursor);
    }).catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [adminFetch, cursor, refreshKey, status]);

  const refresh = (message: string) => { setDialog(null); setTemplates([]); setCursor(undefined); setCursorHistory([]); setLoading(true); setLoadError(false); setFeedback({ kind: "success", message }); setRefreshKey((value) => value + 1); };
  const archiveTemplate = async (template: Template) => {
    setArchivePending(true);
    try { const response = await adminFetch(`/admin/templates/${template.id}/archive`, { method: "POST" }); const body: unknown = await response.json(); if (!response.ok || !TemplateResponseSchema.safeParse(body).success) throw new Error("archive"); refresh("เก็บเทมเพลตถาวรแล้ว"); }
    catch { setDialog(null); setFeedback({ kind: "error", message: "ไม่สามารถเก็บเทมเพลตถาวรได้ กรุณาลองอีกครั้ง" }); }
    finally { setArchivePending(false); }
  };

  return <>
    <AdminPageHeader action={permissions.has("template:create") ? <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">{canImportDesign ? <Button onClick={() => { setFeedback(null); setDialog({ type: "import" }); }} variant="secondary">นำเข้าแบบที่ออกแบบไว้แล้ว</Button> : null}<Button onClick={() => { setFeedback(null); setDialog({ type: "create" }); }}><span aria-hidden="true" className="text-lg">+</span> สร้างเทมเพลตใหม่</Button></div> : undefined}
      description="ออกแบบ จัดการเวอร์ชัน และเตรียมเทมเพลตที่พร้อมใช้สำหรับการออกใบประกาศ" eyebrow="รูปแบบใบประกาศ" title="เทมเพลตใบประกาศนียบัตร" />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    <section aria-label="คลังเทมเพลต" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5"><div><h2 className="text-base font-semibold text-slate-950">คลังเทมเพลต</h2><p className="mt-1 text-xs leading-5 text-slate-500">แสดงครั้งละ {pageSize} รายการ เรียงจากรายการล่าสุด</p></div>
        <label className="w-full text-xs font-medium text-slate-600 sm:w-48">สถานะ<select className={`${selectClassName} mt-1.5`} onChange={(event) => { setTemplates([]); setLoading(true); setLoadError(false); setStatus(event.target.value as RecordStatus | ""); setCursor(undefined); setCursorHistory([]); }} value={status}>
          <option value="">ทั้งหมด</option><option value="ACTIVE">ใช้งาน</option><option value="INACTIVE">ไม่ใช้งาน</option><option value="ARCHIVED">เก็บถาวร</option>
        </select></label></div>
      {loading ? <LoadingRows /> : loadError ? <LoadError onRetry={() => { setLoading(true); setLoadError(false); setRefreshKey((value) => value + 1); }} /> : templates.length === 0 ? <div className="px-5 py-16 text-center"><span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-full border border-blue-100 bg-blue-50 text-xl text-[#2557a7]">▱</span><h2 className="mt-4 text-base font-semibold text-slate-950">{status === "" ? "ยังไม่มีเทมเพลตใบประกาศนียบัตร" : "ไม่พบเทมเพลตในสถานะนี้"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">{status === "" ? "สร้างเทมเพลตแรก แล้วเริ่มออกแบบเวอร์ชันสำหรับการใช้งานขององค์กร" : "ลองเลือกสถานะอื่นเพื่อดูรายการเทมเพลต"}</p>{status === "" && permissions.has("template:create") ? <Button className="mt-5" onClick={() => setDialog({ type: "create" })}>สร้างเทมเพลต</Button> : null}</div> : <>
        <ul className="grid grid-cols-1 gap-4 bg-slate-50/70 p-4 min-[560px]:grid-cols-2 xl:grid-cols-3 xl:p-5">{templates.map((template) => {
          const previewStatus = template.preview === null ? null : versionPresentation[template.preview.status];
          return <li className="group overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-[0_12px_28px_rgba(15,23,42,0.10)]" key={template.id}>
            <Link aria-label={`เปิดเทมเพลต ${template.name}`} className="block border-b border-slate-200 focus:outline-none focus:ring-3 focus:ring-inset focus:ring-blue-200" href={`/admin/templates/${template.id}`}>
              <TemplateThumbnail adminFetch={adminFetch} template={template} />
            </Link>
            <div className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><Link className="line-clamp-2 text-sm font-semibold text-slate-950 hover:text-[#2557a7]" href={`/admin/templates/${template.id}`}>{template.name}</Link>
              <p className="mt-1 text-xs text-slate-500">{template.preview === null ? "ยังไม่มีเวอร์ชัน" : `เวอร์ชัน ${template.preview.version}`}</p></div><StatusBadge status={template.status} /></div>
              {previewStatus === null ? null : <span className={`mt-3 inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${previewStatus.className}`}>{previewStatus.label}</span>}
              <div className="mt-4 flex flex-wrap items-center gap-1"><Link className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-[#2557a7] hover:bg-blue-50" href={`/admin/templates/${template.id}`}>เปิดเทมเพลต</Link>
                {permissions.has("template:update") && template.status !== "ARCHIVED" ? <><button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100" onClick={() => setDialog({ type: "rename", template })} type="button">เปลี่ยนชื่อ</button><button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => setDialog({ type: "archive", template })} type="button">เก็บถาวร</button></> : null}
              </div>
            </div>
          </li>;
        })}</ul>
        <Pagination canGoBack={cursorHistory.length > 0} canGoNext={nextCursor !== null} onBack={() => { const history = [...cursorHistory]; setTemplates([]); setLoading(true); setCursor(history.pop()); setCursorHistory(history); }} onNext={() => { if (nextCursor !== null) { setTemplates([]); setLoading(true); setCursorHistory((history) => [...history, cursor]); setCursor(nextCursor); } }} />
      </>}
    </section>
    <Dialog description="ตั้งชื่อเทมเพลตเพื่อเริ่มสร้างเวอร์ชันแบบร่าง" onClose={() => setDialog(null)} open={dialog?.type === "create"} title="สร้างเทมเพลตใหม่"><TemplateNameForm adminFetch={adminFetch} onCancel={() => setDialog(null)} onSaved={(template) => router.push(`/admin/templates/${template.id}`)} /></Dialog>
    <Dialog description="เลือกขนาดใบประกาศ แล้วนำเข้า PNG หรือ JPEG เป็นพื้นหลังชั้นล่างสุด" onClose={() => setDialog(null)} open={dialog?.type === "import"} title="นำเข้าแบบที่ออกแบบไว้แล้ว"><TemplateImportDialog adminFetch={adminFetch} onCancel={() => setDialog(null)} onCreated={(id) => router.push(`/admin/templates/${id}`)} /></Dialog>
    <Dialog description="ชื่อใหม่จะใช้ในคลังเทมเพลต โดยไม่กระทบเวอร์ชันที่เผยแพร่แล้ว" onClose={() => setDialog(null)} open={dialog?.type === "rename"} title="เปลี่ยนชื่อเทมเพลต">{dialog?.type === "rename" ? <TemplateNameForm adminFetch={adminFetch} initial={dialog.template} onCancel={() => setDialog(null)} onSaved={() => refresh("เปลี่ยนชื่อเทมเพลตแล้ว")} /> : null}</Dialog>
    <Dialog description="การเก็บถาวรไม่ใช่การลบ และระบบไม่มีการกู้คืนเทมเพลตผ่านหน้านี้" onClose={() => { if (!archivePending) setDialog(null); }} open={dialog?.type === "archive"} pending={archivePending} title="เก็บเทมเพลตถาวร">{dialog?.type === "archive" ? <div><div className="px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">ยืนยันการเก็บ <strong className="text-slate-950">{dialog.template.name}</strong> ถาวรหรือไม่</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={archivePending} onClick={() => setDialog(null)} variant="secondary">ยกเลิก</Button><Button className="bg-red-700 hover:bg-red-800" disabled={archivePending} onClick={() => void archiveTemplate(dialog.template)}>{archivePending ? "กำลังดำเนินการ…" : "ยืนยันเก็บถาวร"}</Button></footer></div> : null}</Dialog>
  </>;
}
