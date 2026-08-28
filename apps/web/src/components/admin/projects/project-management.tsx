"use client";

import {
  CreateProjectRequestSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  UpdateProjectRequestSchema,
  type AuthenticationData,
  type Project
} from "@certificate-platform/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AdminPageHeader } from "../admin-page-header";
import {
  Dialog, Feedback, Field, LoadError, LoadingRows, Pagination, StatusBadge, selectClassName, type RecordStatus
} from "../resource-ui";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const pageSize = 12;
type Membership = AuthenticationData["memberships"][number];
type FeedbackState = { readonly kind: "success" | "error"; readonly message: string } | null;
type FormErrors = Partial<Record<"name" | "slug", string | undefined>>;

const slugFromName = (name: string): string | null => {
  const candidate = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/g, "");
  return candidate !== "" && CreateProjectRequestSchema.shape.slug.safeParse(candidate).success ? candidate : null;
};

const projectErrors = (result: ReturnType<typeof CreateProjectRequestSchema.safeParse>): FormErrors => {
  if (result.success) return {};
  const errors: FormErrors = {};
  for (const issue of result.error.issues) {
    if (issue.path[0] === "name") errors.name = "กรุณาระบุชื่อโครงการไม่เกิน 200 ตัวอักษร";
    if (issue.path[0] === "slug") errors.slug = "ใช้ตัวพิมพ์เล็ก ตัวเลข และขีดกลางเท่านั้น เช่น digital-skills-2026";
  }
  return errors;
};

function ProjectForm({ initial, onCancel, onSaved, adminFetch }: {
  readonly initial?: Project;
  readonly onCancel: () => void;
  readonly onSaved: (project: Project) => void;
  readonly adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugAutomatic, setSlugAutomatic] = useState(initial === undefined);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unchanged = initial !== undefined && name.trim() === initial.name && slug.trim() === initial.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = { name, slug };
    const validated = CreateProjectRequestSchema.safeParse(candidate);
    if (!validated.success) { setErrors(projectErrors(validated)); return; }
    const update = initial === undefined ? validated.data : {
      ...(validated.data.name === initial.name ? {} : { name: validated.data.name }),
      ...(validated.data.slug === initial.slug ? {} : { slug: validated.data.slug })
    };
    if (initial !== undefined && !UpdateProjectRequestSchema.safeParse(update).success) return;
    setPending(true); setFormError(null); setErrors({});
    try {
      const response = await adminFetch(initial === undefined ? "/admin/projects" : `/admin/projects/${initial.id}`, {
        method: initial === undefined ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(update)
      });
      const body: unknown = await response.json();
      const parsed = ProjectResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        setFormError(response.status === 409 ? "ชื่อหรือ slug นี้ถูกใช้งานแล้ว กรุณาเลือกค่าอื่น" : "ไม่สามารถบันทึกโครงการได้ โปรดตรวจสอบข้อมูลแล้วลองอีกครั้ง");
        return;
      }
      onSaved(parsed.data.data);
    } catch { setFormError("ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองอีกครั้ง"); }
    finally { setPending(false); }
  };

  return <form noValidate onSubmit={(event) => void submit(event)}>
    <div className="space-y-5 px-5 py-5 sm:px-6">
      {formError === null ? null : <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800" role="alert">{formError}</p>}
      <Field error={errors.name} htmlFor="project-name" label="ชื่อโครงการ">
        <Input aria-describedby={errors.name === undefined ? undefined : "project-name-error"} autoFocus invalid={errors.name !== undefined} id="project-name" maxLength={200}
          onChange={(event) => {
            const nextName = event.target.value; setName(nextName); setErrors((current) => ({ ...current, name: undefined }));
            if (slugAutomatic) setSlug(slugFromName(nextName) ?? "");
          }} value={name} />
      </Field>
      <Field error={errors.slug} hint="ใช้เป็นชื่ออ้างอิงที่อ่านง่าย เช่น digital-skills-2026 (ตัวพิมพ์เล็ก ตัวเลข และขีดกลาง)" htmlFor="project-slug" label="slug">
        <Input aria-describedby={errors.slug === undefined ? undefined : "project-slug-error"} autoCapitalize="none" invalid={errors.slug !== undefined} id="project-slug" maxLength={100}
          onChange={(event) => { setSlug(event.target.value); setSlugAutomatic(false); setErrors((current) => ({ ...current, slug: undefined })); }} spellCheck={false} value={slug} />
      </Field>
    </div>
    <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
      <Button disabled={pending} onClick={onCancel} variant="secondary">ยกเลิก</Button>
      <Button disabled={pending || unchanged} type="submit">{pending ? "กำลังบันทึก…" : initial === undefined ? "สร้างโครงการ" : "บันทึกการแก้ไข"}</Button>
    </footer>
  </form>;
}

export function ProjectManagement({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [status, setStatus] = useState<RecordStatus | "">("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<{ type: "create" } | { type: "edit" | "archive"; project: Project } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [archivePending, setArchivePending] = useState(false);

  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, {
    ...init, cache: "no-store", credentials: "same-origin", headers: {
      "X-Organization-ID": membership.organization.id,
      ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers
    }
  }), [csrfToken, membership.organization.id]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor);
    if (status !== "") query.set("status", status);
    void adminFetch(`/admin/projects?${query}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json();
      const parsed = ProjectListResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("invalid project list");
      setProjects(parsed.data.data); setNextCursor(parsed.data.meta.next_cursor);
    }).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [adminFetch, cursor, refreshKey, status]);

  const resetAndRefresh = (message: string) => {
    setDialog(null); setProjects([]); setLoading(true); setLoadError(false); setCursor(undefined); setCursorHistory([]); setFeedback({ kind: "success", message }); setRefreshKey((value) => value + 1);
  };
  const archiveProject = async (project: Project) => {
    setArchivePending(true);
    try {
      const response = await adminFetch(`/admin/projects/${project.id}/archive`, { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok || !ProjectResponseSchema.safeParse(body).success) throw new Error("archive failed");
      resetAndRefresh("เก็บโครงการถาวรแล้ว");
    } catch { setDialog(null); setFeedback({ kind: "error", message: "ไม่สามารถเก็บโครงการถาวรได้ กรุณาลองอีกครั้ง" }); }
    finally { setArchivePending(false); }
  };

  return <>
    <AdminPageHeader action={permissions.has("project:create") ? <Button className="w-full sm:w-auto" onClick={() => { setFeedback(null); setDialog({ type: "create" }); }}>
      <span aria-hidden="true" className="text-lg leading-none">+</span> สร้างโครงการ</Button> : undefined}
      description="สร้างและดูแลโครงการซึ่งเป็นโครงสร้างหลักสำหรับจัดกลุ่มการอบรมขององค์กร" eyebrow="โครงสร้างการดำเนินงาน" title="โครงการ" />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    <section aria-label="รายการโครงการ" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-5">
        <div><h2 className="text-base font-semibold text-slate-950">รายการโครงการ</h2><p className="mt-1 text-xs leading-5 text-slate-500">แสดงครั้งละ {pageSize} รายการ เรียงจากรายการล่าสุด</p></div>
        <label className="w-full text-xs font-medium text-slate-600 sm:w-48">สถานะ
          <select className={`${selectClassName} mt-1.5`} onChange={(event) => { setProjects([]); setLoading(true); setLoadError(false); setStatus(event.target.value as RecordStatus | ""); setCursor(undefined); setCursorHistory([]); }} value={status}>
            <option value="">ทั้งหมด</option><option value="ACTIVE">ใช้งาน</option><option value="INACTIVE">ไม่ใช้งาน</option><option value="ARCHIVED">เก็บถาวร</option>
          </select>
        </label>
      </div>
      {loading ? <LoadingRows /> : loadError ? <LoadError onRetry={() => { setLoading(true); setLoadError(false); setRefreshKey((value) => value + 1); }} /> : projects.length === 0 ? (
        <div className="px-5 py-16 text-center"><span className="mx-auto grid size-11 place-items-center rounded-full bg-blue-50 text-[#2557a7]" aria-hidden="true">◇</span>
          <h2 className="mt-4 text-base font-semibold text-slate-950">{status === "" ? "ยังไม่มีโครงการ" : "ไม่พบโครงการในสถานะนี้"}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">{status === "" ? "เริ่มต้นด้วยการสร้างโครงการแรก แล้วจึงเพิ่มการอบรมภายใต้โครงการ" : "ลองเลือกสถานะอื่นเพื่อดูรายการโครงการ"}</p>
          {status === "" && permissions.has("project:create") ? <Button className="mt-5" onClick={() => setDialog({ type: "create" })}>สร้างโครงการ</Button> : null}
        </div>
      ) : <>
        <div className="hidden md:block"><table className="w-full table-fixed text-left text-sm"><thead className="bg-slate-50 text-xs font-medium text-slate-500"><tr>
          <th className="w-[42%] px-5 py-3 font-medium">โครงการ</th><th className="w-[24%] px-5 py-3 font-medium">slug</th><th className="w-[14%] px-5 py-3 font-medium">สถานะ</th><th className="px-5 py-3 text-right font-medium">การทำงาน</th>
        </tr></thead><tbody className="divide-y divide-slate-200">{projects.map((project) => <tr className="align-middle" key={project.id}>
          <td className="px-5 py-4"><p className="break-words font-medium text-slate-950">{project.name}</p></td><td className="px-5 py-4"><span className="break-all rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{project.slug}</span></td>
          <td className="px-5 py-4"><StatusBadge status={project.status} /></td><td className="px-5 py-4"><div className="flex flex-wrap justify-end gap-1">
            <Link className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-[#2557a7] hover:bg-blue-50" href={`/admin/trainings?project=${encodeURIComponent(project.id)}`}>ดูการอบรม</Link>
            {permissions.has("project:update") && project.status !== "ARCHIVED" ? <button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100" onClick={() => setDialog({ type: "edit", project })} type="button">แก้ไข</button> : null}
            {permissions.has("project:archive") && project.status !== "ARCHIVED" ? <button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => setDialog({ type: "archive", project })} type="button">เก็บถาวร</button> : null}
          </div></td></tr>)}</tbody></table></div>
        <ul className="divide-y divide-slate-200 md:hidden">{projects.map((project) => <li className="p-4" key={project.id}>
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm font-medium text-slate-950">{project.name}</h3><p className="mt-1 break-all text-xs text-slate-500">{project.slug}</p></div><StatusBadge status={project.status} /></div>
          <div className="mt-4 flex flex-wrap gap-2"><Link className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#2557a7]" href={`/admin/trainings?project=${encodeURIComponent(project.id)}`}>ดูการอบรม</Link>
            {permissions.has("project:update") && project.status !== "ARCHIVED" ? <Button className="px-3 text-xs" onClick={() => setDialog({ type: "edit", project })} variant="secondary">แก้ไข</Button> : null}
            {permissions.has("project:archive") && project.status !== "ARCHIVED" ? <Button className="border-red-200 px-3 text-xs text-red-700" onClick={() => setDialog({ type: "archive", project })} variant="secondary">เก็บถาวร</Button> : null}</div>
        </li>)}</ul>
        <Pagination canGoBack={cursorHistory.length > 0} canGoNext={nextCursor !== null} onBack={() => { const history = [...cursorHistory]; setProjects([]); setLoading(true); setLoadError(false); setCursor(history.pop()); setCursorHistory(history); }}
          onNext={() => { if (nextCursor !== null) { setProjects([]); setLoading(true); setLoadError(false); setCursorHistory((history) => [...history, cursor]); setCursor(nextCursor); } }} />
      </>}
    </section>

    <Dialog onClose={() => setDialog(null)} open={dialog?.type === "create"} title="สร้างโครงการใหม่" description="เพิ่มโครงการเพื่อใช้จัดกลุ่มการอบรม">
      <ProjectForm adminFetch={adminFetch} onCancel={() => setDialog(null)} onSaved={() => resetAndRefresh("สร้างโครงการเรียบร้อยแล้ว")} />
    </Dialog>
    <Dialog onClose={() => setDialog(null)} open={dialog?.type === "edit"} title={`แก้ไขโครงการ ${dialog?.type === "edit" ? dialog.project.name : ""}`} description="แก้ไขชื่อและ slug ของโครงการ">
      {dialog?.type === "edit" ? <ProjectForm adminFetch={adminFetch} initial={dialog.project} onCancel={() => setDialog(null)} onSaved={() => resetAndRefresh("บันทึกการแก้ไขแล้ว")} /> : null}
    </Dialog>
    <Dialog onClose={() => { if (!archivePending) setDialog(null); }} open={dialog?.type === "archive"} pending={archivePending} title="เก็บโครงการถาวร" description="รายการที่เก็บถาวรจะไม่อยู่ในสถานะใช้งาน และไม่สามารถนำไปสร้างการอบรมใหม่ได้">
      {dialog?.type === "archive" ? <div><div className="px-5 py-5 sm:px-6"><p className="text-sm leading-6 text-slate-700">ยืนยันการเก็บโครงการ <strong className="font-semibold text-slate-950">{dialog.project.name}</strong> ถาวรหรือไม่</p></div>
        <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={archivePending} onClick={() => setDialog(null)} variant="secondary">ยกเลิก</Button>
          <Button className="bg-red-700 hover:bg-red-800" disabled={archivePending} onClick={() => void archiveProject(dialog.project)}>{archivePending ? "กำลังดำเนินการ…" : "ยืนยันเก็บถาวร"}</Button></footer></div> : null}
    </Dialog>
  </>;
}
