"use client";

import {
  CreateTrainingRequestSchema,
  ProjectListResponseSchema,
  TrainingListResponseSchema,
  TrainingResponseSchema,
  UpdateTrainingRequestSchema,
  type AuthenticationData,
  type Project,
  type Training
} from "@certificate-platform/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AdminPageHeader } from "../admin-page-header";
import { Dialog, Feedback, Field, LoadError, LoadingRows, Pagination, StatusBadge, selectClassName, type RecordStatus } from "../resource-ui";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const pageSize = 12;
type Membership = AuthenticationData["memberships"][number];
type FeedbackState = { readonly kind: "success" | "error"; readonly message: string } | null;
type TrainingFields = { project_id: string; name: string; code: string; start_date: string; end_date: string };
type FormErrors = Partial<Record<keyof TrainingFields, string | undefined>>;

const emptyFields: TrainingFields = { project_id: "", name: "", code: "", start_date: "", end_date: "" };
const displayDate = (value: string | null) => value === null ? "ไม่ระบุ" : new Intl.DateTimeFormat("th-TH", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
}).format(new Date(`${value}T00:00:00.000Z`));

const errorsFromTraining = (fields: TrainingFields): FormErrors => {
  const parsed = CreateTrainingRequestSchema.safeParse({
    project_id: fields.project_id, name: fields.name, code: fields.code,
    start_date: fields.start_date === "" ? null : fields.start_date,
    end_date: fields.end_date === "" ? null : fields.end_date
  });
  if (parsed.success) return {};
  const errors: FormErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (key === "project_id") errors.project_id = "กรุณาเลือกโครงการที่ใช้งานอยู่";
    if (key === "name") errors.name = "กรุณาระบุชื่อการอบรมไม่เกิน 200 ตัวอักษร";
    if (key === "code") errors.code = "ใช้ตัวอักษร ตัวเลข จุด ขีดกลาง ขีดล่าง หรือ / เท่านั้น";
    if (key === "start_date") errors.start_date = "กรุณาระบุวันที่เริ่มให้ถูกต้อง";
    if (key === "end_date") errors.end_date = fields.start_date !== "" && fields.end_date < fields.start_date ? "วันที่สิ้นสุดต้องไม่มาก่อนวันที่เริ่ม" : "กรุณาระบุวันที่สิ้นสุดให้ถูกต้อง";
  }
  return errors;
};

function TrainingForm({ adminFetch, initial, initialProjectId, projectName, projects, onCancel, onSaved }: {
  readonly adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly initial?: Training | undefined;
  readonly initialProjectId?: string | undefined;
  readonly projectName?: string | undefined;
  readonly projects: readonly Project[];
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const [fields, setFields] = useState<TrainingFields>(initial === undefined ? { ...emptyFields, project_id: initialProjectId ?? projects[0]?.id ?? "" } : {
    project_id: initial.project_id, name: initial.name, code: initial.code, start_date: initial.start_date ?? "", end_date: initial.end_date ?? ""
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const updateField = (key: keyof TrainingFields, value: string) => { setFields((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: undefined })); };
  const unchanged = initial !== undefined && fields.name.trim() === initial.name && fields.code.trim() === initial.code
    && fields.start_date === (initial.start_date ?? "") && fields.end_date === (initial.end_date ?? "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const fieldErrors = errorsFromTraining(fields);
    if (Object.keys(fieldErrors).length > 0) { setErrors(fieldErrors); return; }
    const createPayload = CreateTrainingRequestSchema.parse({ project_id: fields.project_id, name: fields.name, code: fields.code,
      start_date: fields.start_date === "" ? null : fields.start_date, end_date: fields.end_date === "" ? null : fields.end_date });
    const payload = initial === undefined ? createPayload : {
      ...(createPayload.name === initial.name ? {} : { name: createPayload.name }),
      ...(createPayload.code === initial.code ? {} : { code: createPayload.code }),
      ...(createPayload.start_date === initial.start_date ? {} : { start_date: createPayload.start_date ?? null }),
      ...(createPayload.end_date === initial.end_date ? {} : { end_date: createPayload.end_date ?? null })
    };
    if (initial !== undefined && !UpdateTrainingRequestSchema.safeParse(payload).success) return;
    setPending(true); setFormError(null);
    try {
      const response = await adminFetch(initial === undefined ? "/admin/trainings" : `/admin/trainings/${initial.id}`, {
        method: initial === undefined ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const body: unknown = await response.json();
      const parsed = TrainingResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        setFormError(response.status === 409 ? "รหัสการอบรมนี้ถูกใช้งานแล้ว กรุณาใช้รหัสอื่น" : "ไม่สามารถบันทึกการอบรมได้ โปรดตรวจสอบข้อมูลแล้วลองอีกครั้ง"); return;
      }
      onSaved();
    } catch { setFormError("ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองอีกครั้ง"); }
    finally { setPending(false); }
  };

  return <form noValidate onSubmit={(event) => void submit(event)}>
    <div className="space-y-5 px-5 py-5 sm:px-6">
      {formError === null ? null : <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800" role="alert">{formError}</p>}
      {initial === undefined ? <Field error={errors.project_id} htmlFor="training-project" label="โครงการ"><select aria-invalid={errors.project_id !== undefined || undefined}
        className={selectClassName} id="training-project" onChange={(event) => updateField("project_id", event.target.value)} value={fields.project_id}>
        <option value="">เลือกโครงการ</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
        : <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3"><p className="text-xs font-medium text-slate-500">โครงการ</p><p className="mt-1 text-sm font-medium text-slate-800">{projectName ?? "ไม่พบชื่อโครงการ"}</p><p className="mt-1 text-xs text-slate-500">ไม่สามารถย้ายการอบรมไปยังโครงการอื่นได้</p></div>}
      <Field error={errors.name} htmlFor="training-name" label="ชื่อการอบรม"><Input autoFocus invalid={errors.name !== undefined} id="training-name" maxLength={200} onChange={(event) => updateField("name", event.target.value)} value={fields.name} /></Field>
      <Field error={errors.code} hint="เช่น DGT-2026-01" htmlFor="training-code" label="รหัสการอบรม"><Input autoCapitalize="characters" invalid={errors.code !== undefined} id="training-code" maxLength={100} onChange={(event) => updateField("code", event.target.value)} value={fields.code} /></Field>
      <div className="grid gap-5 sm:grid-cols-2"><Field error={errors.start_date} htmlFor="training-start-date" label="วันที่เริ่ม"><Input invalid={errors.start_date !== undefined} id="training-start-date" onChange={(event) => updateField("start_date", event.target.value)} type="date" value={fields.start_date} /></Field>
        <Field error={errors.end_date} htmlFor="training-end-date" label="วันที่สิ้นสุด"><Input invalid={errors.end_date !== undefined} id="training-end-date" min={fields.start_date || undefined} onChange={(event) => updateField("end_date", event.target.value)} type="date" value={fields.end_date} /></Field></div>
    </div>
    <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={onCancel} variant="secondary">ยกเลิก</Button>
      <Button disabled={pending || unchanged} type="submit">{pending ? "กำลังบันทึก…" : initial === undefined ? "เพิ่มการอบรม" : "บันทึกการแก้ไข"}</Button></footer>
  </form>;
}

export function TrainingManagement({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [status, setStatus] = useState<RecordStatus | "">("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialog, setDialog] = useState<{ type: "create" } | { type: "edit" | "archive"; training: Training } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [archivePending, setArchivePending] = useState(false);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const activeProjects = useMemo(() => projects.filter((project) => project.status === "ACTIVE"), [projects]);

  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, {
    ...init, cache: "no-store", credentials: "same-origin", headers: { "X-Organization-ID": membership.organization.id,
      ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers }
  }), [csrfToken, membership.organization.id]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const allProjects: Project[] = []; const seenCursors = new Set<string>(); let next: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "100" }); if (next !== null) query.set("cursor", next);
        const response = await adminFetch(`/admin/projects?${query}`, { signal: controller.signal });
        const body: unknown = await response.json(); const parsed = ProjectListResponseSchema.safeParse(body);
        if (!response.ok || !parsed.success) throw new Error("invalid projects");
        allProjects.push(...parsed.data.data); next = parsed.data.meta.next_cursor;
        if (next !== null && seenCursors.has(next)) throw new Error("repeated cursor");
        if (next !== null) seenCursors.add(next);
      } while (next !== null && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      setProjects(allProjects);
      const requestedProject = new URLSearchParams(window.location.search).get("project");
      if (requestedProject !== null && allProjects.some((project) => project.id === requestedProject)) setProjectFilter(requestedProject);
    })().catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); })
      .finally(() => { if (!controller.signal.aborted) setProjectsLoading(false); });
    return () => controller.abort();
  }, [adminFetch, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor); if (status !== "") query.set("status", status); if (projectFilter !== "") query.set("project_id", projectFilter);
    void adminFetch(`/admin/trainings?${query}`, { signal: controller.signal }).then(async (response) => {
      const body: unknown = await response.json(); const parsed = TrainingListResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("invalid trainings");
      setTrainings(parsed.data.data); setNextCursor(parsed.data.meta.next_cursor);
    }).catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [adminFetch, cursor, projectFilter, refreshKey, status]);

  const resetPage = () => { setCursor(undefined); setCursorHistory([]); };
  const saved = (message: string) => { setDialog(null); setTrainings([]); setLoading(true); setLoadError(false); resetPage(); setFeedback({ kind: "success", message }); setRefreshKey((value) => value + 1); };
  const archiveTraining = async (training: Training) => {
    setArchivePending(true);
    try {
      const response = await adminFetch(`/admin/trainings/${training.id}/archive`, { method: "POST" }); const body: unknown = await response.json();
      if (!response.ok || !TrainingResponseSchema.safeParse(body).success) throw new Error("archive failed"); saved("เก็บการอบรมถาวรแล้ว");
    } catch { setDialog(null); setFeedback({ kind: "error", message: "ไม่สามารถเก็บการอบรมถาวรได้ กรุณาลองอีกครั้ง" }); }
    finally { setArchivePending(false); }
  };

  return <>
    <AdminPageHeader action={permissions.has("training:create") ? <Button className="w-full sm:w-auto" disabled={projectsLoading || activeProjects.length === 0} onClick={() => { setFeedback(null); setDialog({ type: "create" }); }}><span aria-hidden="true" className="text-lg leading-none">+</span> เพิ่มการอบรม</Button> : undefined}
      description="จัดการการอบรมภายใต้โครงการ พร้อมกำหนดรหัสและช่วงวันที่ดำเนินการ" eyebrow="โครงสร้างการดำเนินงาน" title="การอบรม" />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    {!projectsLoading && activeProjects.length === 0 ? <section className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-5 py-5"><h2 className="text-sm font-semibold text-slate-950">ต้องสร้างโครงการก่อนจึงจะเพิ่มการอบรมได้</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">การอบรมทุกหลักสูตรต้องอยู่ภายใต้โครงการที่มีสถานะใช้งาน</p>{permissions.has("project:create") ? <Link className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-[#2557a7] px-4 text-sm font-semibold text-white hover:bg-[#1e478c]" href="/admin/projects">สร้างโครงการ</Link> : null}</section> : null}
    <section aria-label="รายการการอบรม" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><div className="flex flex-col gap-1"><h2 className="text-base font-semibold text-slate-950">รายการการอบรม</h2><p className="text-xs leading-5 text-slate-500">แสดงครั้งละ {pageSize} รายการ เรียงจากรายการล่าสุด</p></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 sm:justify-end lg:ml-auto lg:max-w-xl"><label className="text-xs font-medium text-slate-600">โครงการ<select className={`${selectClassName} mt-1.5`} disabled={projectsLoading}
          onChange={(event) => { setTrainings([]); setLoading(true); setLoadError(false); setProjectFilter(event.target.value); resetPage(); }} value={projectFilter}><option value="">ทุกโครงการ</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="text-xs font-medium text-slate-600">สถานะ<select className={`${selectClassName} mt-1.5`} onChange={(event) => { setTrainings([]); setLoading(true); setLoadError(false); setStatus(event.target.value as RecordStatus | ""); resetPage(); }} value={status}>
            <option value="">ทั้งหมด</option><option value="ACTIVE">ใช้งาน</option><option value="INACTIVE">ไม่ใช้งาน</option><option value="ARCHIVED">เก็บถาวร</option></select></label></div></div>
      {loading || projectsLoading ? <LoadingRows /> : loadError ? <LoadError onRetry={() => { setTrainings([]); setProjects([]); setLoading(true); setProjectsLoading(true); setLoadError(false); setRefreshKey((value) => value + 1); }} /> : trainings.length === 0 ? <div className="px-5 py-16 text-center"><span className="mx-auto grid size-11 place-items-center rounded-full bg-blue-50 text-[#2557a7]" aria-hidden="true">◇</span>
        <h2 className="mt-4 text-base font-semibold text-slate-950">{projectFilter === "" && status === "" ? "ยังไม่มีการอบรม" : "ไม่พบการอบรมตามตัวกรอง"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">{projectFilter === "" && status === "" ? "เพิ่มการอบรมภายใต้โครงการที่พร้อมใช้งานเพื่อเริ่มต้น" : "ลองเปลี่ยนโครงการหรือสถานะที่เลือก"}</p>
        {projectFilter === "" && status === "" && permissions.has("training:create") && activeProjects.length > 0 ? <Button className="mt-5" onClick={() => setDialog({ type: "create" })}>เพิ่มการอบรม</Button> : null}</div> : <>
        <div className="hidden lg:block"><table className="w-full table-fixed text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="w-[28%] px-5 py-3 font-medium">การอบรม</th><th className="w-[21%] px-5 py-3 font-medium">โครงการ</th><th className="w-[18%] px-5 py-3 font-medium">ช่วงวันที่</th><th className="w-[13%] px-5 py-3 font-medium">สถานะ</th><th className="px-5 py-3 text-right font-medium">การทำงาน</th></tr></thead>
          <tbody className="divide-y divide-slate-200">{trainings.map((training) => <tr key={training.id}><td className="px-5 py-4"><p className="break-words font-medium text-slate-950">{training.name}</p><p className="mt-1 break-all text-xs text-slate-500">{training.code}</p></td>
            <td className="px-5 py-4"><p className="break-words text-slate-700">{projectMap.get(training.project_id)?.name ?? "ไม่พบชื่อโครงการ"}</p></td><td className="px-5 py-4 text-xs leading-5 text-slate-600"><p>{displayDate(training.start_date)}</p><p>ถึง {displayDate(training.end_date)}</p></td>
            <td className="px-5 py-4"><StatusBadge status={training.status} /></td><td className="px-5 py-4"><div className="flex justify-end gap-1">{permissions.has("training:update") && training.status !== "ARCHIVED" ? <button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100" onClick={() => setDialog({ type: "edit", training })} type="button">แก้ไข</button> : null}
              {permissions.has("training:archive") && training.status !== "ARCHIVED" ? <button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => setDialog({ type: "archive", training })} type="button">เก็บถาวร</button> : null}</div></td></tr>)}</tbody></table></div>
        <ul className="divide-y divide-slate-200 lg:hidden">{trainings.map((training) => <li className="p-4" key={training.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm font-medium text-slate-950">{training.name}</h3><p className="mt-1 break-all text-xs text-slate-500">{training.code}</p></div><StatusBadge status={training.status} /></div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-medium text-slate-500">โครงการ</dt><dd className="mt-1 break-words text-sm text-slate-800">{projectMap.get(training.project_id)?.name ?? "ไม่พบชื่อโครงการ"}</dd></div><div><dt className="font-medium text-slate-500">ช่วงวันที่</dt><dd className="mt-1 text-sm text-slate-800">{displayDate(training.start_date)} – {displayDate(training.end_date)}</dd></div></dl>
          {(permissions.has("training:update") || permissions.has("training:archive")) && training.status !== "ARCHIVED" ? <div className="mt-4 flex gap-2">{permissions.has("training:update") ? <Button className="px-3 text-xs" onClick={() => setDialog({ type: "edit", training })} variant="secondary">แก้ไข</Button> : null}{permissions.has("training:archive") ? <Button className="border-red-200 px-3 text-xs text-red-700" onClick={() => setDialog({ type: "archive", training })} variant="secondary">เก็บถาวร</Button> : null}</div> : null}</li>)}</ul>
        <Pagination canGoBack={cursorHistory.length > 0} canGoNext={nextCursor !== null} onBack={() => { const history = [...cursorHistory]; setTrainings([]); setLoading(true); setLoadError(false); setCursor(history.pop()); setCursorHistory(history); }} onNext={() => { if (nextCursor !== null) { setTrainings([]); setLoading(true); setLoadError(false); setCursorHistory((history) => [...history, cursor]); setCursor(nextCursor); } }} />
      </>}
    </section>
    <Dialog description="เลือกโครงการและระบุรายละเอียดการอบรม" onClose={() => setDialog(null)} open={dialog?.type === "create"} title="เพิ่มการอบรม">
      <TrainingForm adminFetch={adminFetch} initialProjectId={projectFilter !== "" && projectMap.get(projectFilter)?.status === "ACTIVE" ? projectFilter : undefined} onCancel={() => setDialog(null)} onSaved={() => saved("เพิ่มการอบรมเรียบร้อยแล้ว")} projects={activeProjects} />
    </Dialog>
    <Dialog description="แก้ไขรายละเอียดที่รองรับ โดยโครงการต้นสังกัดจะไม่เปลี่ยนแปลง" onClose={() => setDialog(null)} open={dialog?.type === "edit"} title={`แก้ไขการอบรม ${dialog?.type === "edit" ? dialog.training.name : ""}`}>
      {dialog?.type === "edit" ? <TrainingForm adminFetch={adminFetch} initial={dialog.training} onCancel={() => setDialog(null)} onSaved={() => saved("บันทึกการแก้ไขแล้ว")} projectName={projectMap.get(dialog.training.project_id)?.name} projects={activeProjects} /> : null}
    </Dialog>
    <Dialog description="รายการที่เก็บถาวรจะไม่อยู่ในสถานะใช้งาน" onClose={() => { if (!archivePending) setDialog(null); }} open={dialog?.type === "archive"} pending={archivePending} title="เก็บการอบรมถาวร">
      {dialog?.type === "archive" ? <div><div className="px-5 py-5 sm:px-6"><p className="text-sm leading-6 text-slate-700">ยืนยันการเก็บการอบรม <strong className="font-semibold text-slate-950">{dialog.training.name}</strong> ถาวรหรือไม่</p></div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={archivePending} onClick={() => setDialog(null)} variant="secondary">ยกเลิก</Button><Button className="bg-red-700 hover:bg-red-800" disabled={archivePending} onClick={() => void archiveTraining(dialog.training)}>{archivePending ? "กำลังดำเนินการ…" : "ยืนยันเก็บถาวร"}</Button></footer></div> : null}
    </Dialog>
  </>;
}
