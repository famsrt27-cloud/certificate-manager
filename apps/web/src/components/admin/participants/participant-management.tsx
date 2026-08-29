"use client";

import {
  JobResponseSchema,
  ParticipantImportInspectResponseSchema,
  ParticipantImportQueuedResponseSchema,
  ParticipantListResponseSchema,
  ParticipantResponseSchema,
  TrainingListResponseSchema,
  UpdateParticipantRequestSchema,
  type AuthenticationData,
  type ImportRowValidationError,
  type Participant,
  type Training
} from "@certificate-platform/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AdminPageHeader } from "../admin-page-header";
import { Dialog, Feedback, Field, LoadError, LoadingRows, Pagination, selectClassName } from "../resource-ui";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const participantPageSize = 20;
const previewPageSize = 25;
const importMaximumBytes = 5 * 1024 * 1024;
const acceptedExtensions = new Set(["csv", "xlsx"]);
const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]);

type Membership = AuthenticationData["memberships"][number];
type FeedbackState = { readonly kind: "success" | "error"; readonly message: string } | null;
type ImportInspection = ReturnType<typeof ParticipantImportInspectResponseSchema.parse>["data"];
type ImportPreviewRow = ImportInspection["preview"][number];
type ImportStatus = ImportInspection["status"];

const statusPresentation: Record<ImportStatus, { label: string; detail: string; className: string }> = {
  QUEUED: { label: "รอประมวลผล", detail: "ไฟล์อยู่ในคิวและจะได้รับการตรวจสอบตามลำดับ", className: "border-blue-200 bg-blue-50 text-blue-800" },
  RUNNING: { label: "กำลังดำเนินการ", detail: "ระบบกำลังตรวจสอบหรือนำเข้าข้อมูล", className: "border-blue-200 bg-blue-50 text-blue-800" },
  AWAITING_CONFIRMATION: { label: "รอยืนยัน", detail: "ตรวจสอบผลลัพธ์ก่อนยืนยันนำเข้ารายการที่ถูกต้อง", className: "border-amber-200 bg-amber-50 text-amber-900" },
  SUCCEEDED: { label: "สำเร็จ", detail: "นำเข้ารายการที่ผ่านการตรวจสอบเรียบร้อยแล้ว", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  FAILED: { label: "ไม่สำเร็จ", detail: "ระบบไม่สามารถดำเนินการนำเข้าได้", className: "border-red-200 bg-red-50 text-red-800" },
  DEAD_LETTER: { label: "ต้องตรวจสอบ", detail: "งานไม่สำเร็จหลังจากระบบลองดำเนินการแล้ว", className: "border-red-200 bg-red-50 text-red-800" },
  CANCELLED: { label: "ยกเลิกแล้ว", detail: "งานนี้ถูกยกเลิกและจะไม่มีการนำเข้าข้อมูล", className: "border-slate-200 bg-slate-100 text-slate-700" }
};

const validationErrorLabels: Record<ImportRowValidationError["code"], string> = {
  DISPLAY_NAME_REQUIRED: "ไม่พบชื่อผู้เข้าร่วม",
  DISPLAY_NAME_TOO_LONG: "ชื่อยาวเกินค่าที่ระบบรองรับ",
  EXTERNAL_REFERENCE_TOO_LONG: "รหัสอ้างอิงยาวเกินค่าที่ระบบรองรับ",
  DUPLICATE_EXTERNAL_REFERENCE: "พบรหัสอ้างอิงซ้ำ",
  UNSUPPORTED_CELL_VALUE: "รูปแบบข้อมูลในเซลล์ไม่รองรับ"
};

const jobErrorLabels: Readonly<Record<string, string>> = {
  IMPORT_FILE_INVALID: "ไฟล์ไม่ผ่านการตรวจสอบความถูกต้อง กรุณาเลือกไฟล์ต้นฉบับใหม่",
  IMPORT_REFERENCE_CONFLICT: "พบข้อมูลอ้างอิงที่เปลี่ยนแปลงระหว่างนำเข้า กรุณาเริ่มนำเข้าใหม่",
  IMPORT_CONFIRMATION_EXPIRED: "ระยะเวลายืนยันหมดอายุแล้ว กรุณาเริ่มนำเข้าใหม่",
  IMPORT_PROCESSING_FAILED: "ระบบประมวลผลไฟล์ไม่สำเร็จ กรุณาลองเริ่มนำเข้าใหม่"
};

function ImportStatusBadge({ status }: { readonly status: ImportStatus }) {
  const presentation = statusPresentation[status];
  return <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${presentation.className}`}>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{presentation.label}
  </span>;
}

function ProgressBar({ completed, total }: { readonly completed: number; readonly total: number }) {
  const percent = total === 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
  return <div><div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-600"><span>ความคืบหน้า</span><span>{completed.toLocaleString("th-TH")} / {total.toLocaleString("th-TH")}</span></div>
    <div aria-label={`ดำเนินการแล้ว ${percent} เปอร์เซ็นต์`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar">
      <div className="h-full rounded-full bg-[#2557a7] transition-[width]" style={{ width: `${percent}%` }} />
    </div></div>;
}

function ParticipantEditForm({ adminFetch, participant, onCancel, onSaved }: {
  readonly adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly participant: Participant;
  readonly onCancel: () => void;
  readonly onSaved: (participant: Participant) => void;
}) {
  const [displayName, setDisplayName] = useState(participant.display_name);
  const [externalReference, setExternalReference] = useState(participant.external_reference ?? "");
  const [errors, setErrors] = useState<{ displayName?: string; externalReference?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const unchanged = displayName.trim() === participant.display_name && externalReference.trim() === (participant.external_reference ?? "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      ...(displayName.trim() === participant.display_name ? {} : { display_name: displayName }),
      ...(externalReference.trim() === (participant.external_reference ?? "") ? {} : { external_reference: externalReference.trim() === "" ? null : externalReference })
    };
    const parsedPayload = UpdateParticipantRequestSchema.safeParse(payload);
    if (!parsedPayload.success) {
      const nextErrors: { displayName?: string; externalReference?: string } = {};
      for (const issue of parsedPayload.error.issues) {
        if (issue.path[0] === "display_name") nextErrors.displayName = "กรุณาระบุชื่อที่แสดงไม่เกิน 200 ตัวอักษร";
        if (issue.path[0] === "external_reference") nextErrors.externalReference = "รหัสอ้างอิงต้องไม่เกิน 200 ตัวอักษร";
      }
      setErrors(nextErrors); return;
    }
    setPending(true); setFormError(null);
    try {
      const response = await adminFetch(`/admin/participants/${participant.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsedPayload.data) });
      const body: unknown = await response.json(); const parsed = ParticipantResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("invalid participant response");
      onSaved(parsed.data.data);
    } catch { setFormError("ไม่สามารถบันทึกข้อมูลผู้เข้าร่วมได้ กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง"); }
    finally { setPending(false); }
  };

  return <form noValidate onSubmit={(event) => void submit(event)}><div className="space-y-5 px-5 py-5 sm:px-6">
    {formError === null ? null : <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800" role="alert">{formError}</p>}
    <Field error={errors.displayName} htmlFor="participant-display-name" label="ชื่อที่แสดง"><Input autoFocus id="participant-display-name" invalid={errors.displayName !== undefined} maxLength={200} onChange={(event) => { setDisplayName(event.target.value); setErrors((current) => current.externalReference === undefined ? {} : { externalReference: current.externalReference }); }} value={displayName} /></Field>
    <Field error={errors.externalReference} hint="เว้นว่างได้ หากองค์กรไม่ได้ใช้รหัสอ้างอิง" htmlFor="participant-external-reference" label="รหัสอ้างอิง"><Input id="participant-external-reference" invalid={errors.externalReference !== undefined} maxLength={200} onChange={(event) => { setExternalReference(event.target.value); setErrors((current) => current.displayName === undefined ? {} : { displayName: current.displayName }); }} value={externalReference} /></Field>
  </div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={onCancel} variant="secondary">ยกเลิก</Button><Button disabled={pending || unchanged} type="submit">{pending ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}</Button></footer></form>;
}

function PreviewRows({ rows }: { readonly rows: readonly ImportPreviewRow[] }) {
  if (rows.length === 0) return <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-5 text-center text-sm text-slate-600">ยังไม่มีรายการตัวอย่างที่พร้อมแสดง</p>;
  return <><div className="hidden md:block"><table className="w-full table-fixed text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="w-16 px-4 py-3 font-medium">แถว</th><th className="w-[30%] px-4 py-3 font-medium">ชื่อที่แสดง</th><th className="w-[24%] px-4 py-3 font-medium">รหัสอ้างอิง</th><th className="px-4 py-3 font-medium">ผลการตรวจสอบ</th></tr></thead>
    <tbody className="divide-y divide-slate-200">{rows.map((row) => <tr key={row.row_number}><td className="px-4 py-3 text-slate-500">{row.row_number}</td><td className="break-words px-4 py-3 font-medium text-slate-900">{row.display_name ?? "—"}</td><td className="break-all px-4 py-3 text-slate-600">{row.external_reference ?? "—"}</td><td className="px-4 py-3"><span className={`font-medium ${row.status === "VALID" || row.status === "IMPORTED" ? "text-emerald-700" : "text-red-700"}`}>{row.status === "VALID" ? "ถูกต้อง" : row.status === "IMPORTED" ? "นำเข้าแล้ว" : "ต้องแก้ไข"}</span>{row.validation_errors.length === 0 ? null : <ul className="mt-1 space-y-1 text-xs leading-5 text-red-700">{row.validation_errors.map((error, index) => <li key={`${error.code}-${index}`}>{validationErrorLabels[error.code]}</li>)}</ul>}</td></tr>)}</tbody></table></div>
    <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 md:hidden">{rows.map((row) => <li className="p-4" key={row.row_number}><div className="flex items-start justify-between gap-3"><span className="text-xs font-medium text-slate-500">แถว {row.row_number}</span><span className={`text-xs font-semibold ${row.status === "VALID" || row.status === "IMPORTED" ? "text-emerald-700" : "text-red-700"}`}>{row.status === "VALID" ? "ถูกต้อง" : row.status === "IMPORTED" ? "นำเข้าแล้ว" : "ต้องแก้ไข"}</span></div><p className="mt-3 break-words text-sm font-medium text-slate-950">{row.display_name ?? "ไม่พบชื่อผู้เข้าร่วม"}</p><p className="mt-1 break-all text-xs text-slate-500">รหัสอ้างอิง: {row.external_reference ?? "ไม่ระบุ"}</p>{row.validation_errors.length === 0 ? null : <ul className="mt-3 space-y-1 text-xs leading-5 text-red-700">{row.validation_errors.map((error, index) => <li key={`${error.code}-${index}`}>• {validationErrorLabels[error.code]}</li>)}</ul>}</li>)}</ul></>;
}

export function ParticipantManagement({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const canRead = permissions.has("participant:read"); const canImport = permissions.has("participant:import");
  const [trainings, setTrainings] = useState<Training[]>([]); const [trainingsLoading, setTrainingsLoading] = useState(permissions.has("training:read"));
  const [selectedTrainingId, setSelectedTrainingId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]); const [participantsLoading, setParticipantsLoading] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(); const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false); const [refreshKey, setRefreshKey] = useState(0); const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [editing, setEditing] = useState<Participant | null>(null); const [importOpen, setImportOpen] = useState(false);
  const [importTrainingId, setImportTrainingId] = useState(""); const [importFile, setImportFile] = useState<File | null>(null); const [fileError, setFileError] = useState<string | null>(null); const [fileInputKey, setFileInputKey] = useState(0);
  const [uploadPending, setUploadPending] = useState(false); const [confirmPending, setConfirmPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null); const [jobTraining, setJobTraining] = useState<Training | null>(null); const [jobStatus, setJobStatus] = useState<ImportStatus | null>(null);
  const [inspection, setInspection] = useState<ImportInspection | null>(null); const [previewRows, setPreviewRows] = useState<ImportPreviewRow[]>([]); const [previewNextCursor, setPreviewNextCursor] = useState<string | null>(null); const [previewPending, setPreviewPending] = useState(false);
  const [inspectionError, setInspectionError] = useState(false); const [jobError, setJobError] = useState<string | null>(null); const [pollTick, setPollTick] = useState(0);
  const uploadKey = useRef<string | null>(null); const confirmKey = useRef<string | null>(null); const successHandled = useRef<string | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const activeTrainings = useMemo(() => trainings.filter((training) => training.status === "ACTIVE"), [trainings]);
  const selectedTraining = useMemo(() => trainings.find((training) => training.id === selectedTrainingId), [selectedTrainingId, trainings]);

  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, { ...init, cache: "no-store", credentials: "same-origin", headers: { "X-Organization-ID": membership.organization.id, ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers } }), [csrfToken, membership.organization.id]);
  const resetParticipantPage = useCallback(() => { setCursor(undefined); setCursorHistory([]); setNextCursor(null); }, []);

  useEffect(() => {
    if (!permissions.has("training:read")) return;
    const controller = new AbortController();
    void (async () => { const all: Training[] = []; const seen = new Set<string>(); let next: string | null = null;
      do { const query = new URLSearchParams({ limit: "100" }); if (next !== null) query.set("cursor", next); const response = await adminFetch(`/admin/trainings?${query}`, { signal: controller.signal }); const body: unknown = await response.json(); const parsed = TrainingListResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("invalid trainings"); all.push(...parsed.data.data); next = parsed.data.meta.next_cursor; if (next !== null && seen.has(next)) throw new Error("repeated cursor"); if (next !== null) seen.add(next); } while (next !== null && !controller.signal.aborted);
      if (!controller.signal.aborted) setTrainings(all);
    })().catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); }).finally(() => { if (!controller.signal.aborted) setTrainingsLoading(false); });
    return () => controller.abort();
  }, [adminFetch, permissions]);

  useEffect(() => {
    if (!canRead || selectedTrainingId === "") return;
    const controller = new AbortController(); const query = new URLSearchParams({ limit: String(participantPageSize), training_id: selectedTrainingId }); if (cursor !== undefined) query.set("cursor", cursor);
    void adminFetch(`/admin/participants?${query}`, { signal: controller.signal }).then(async (response) => { const body: unknown = await response.json(); const parsed = ParticipantListResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("invalid participants"); setParticipants(parsed.data.data); setNextCursor(parsed.data.meta.next_cursor); }).catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); }).finally(() => { if (!controller.signal.aborted) setParticipantsLoading(false); });
    return () => controller.abort();
  }, [adminFetch, canRead, cursor, refreshKey, selectedTrainingId]);

  const inspect = useCallback(async (currentJobId: string, signal?: AbortSignal) => { const response = await adminFetch(`/admin/participant-imports/${currentJobId}?limit=${previewPageSize}`, signal === undefined ? {} : { signal }); const body: unknown = await response.json(); const parsed = ParticipantImportInspectResponseSchema.safeParse(body); if (!response.ok || !parsed.success || parsed.data.data.job_id !== currentJobId) throw new Error("invalid inspection"); setInspection(parsed.data.data); setJobStatus(parsed.data.data.status); setPreviewRows(parsed.data.data.preview); setPreviewNextCursor(parsed.data.meta.next_cursor); setInspectionError(false); return parsed.data.data.status; }, [adminFetch]);

  useEffect(() => {
    if (!importOpen || jobId === null || jobStatus === "AWAITING_CONFIRMATION" || (jobStatus !== null && terminalStatuses.has(jobStatus))) return;
    const controller = new AbortController(); let timer: number | undefined;
    timer = window.setTimeout(() => { void inspect(jobId, controller.signal).then((status) => { if (!terminalStatuses.has(status) && status !== "AWAITING_CONFIRMATION") timer = window.setTimeout(() => setPollTick((value) => value + 1), 1800); }).catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setInspectionError(true); }); }, 0);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [importOpen, inspect, jobId, jobStatus, pollTick]);

  useEffect(() => {
    if (jobId === null || jobStatus === null || !terminalStatuses.has(jobStatus) || !permissions.has("job:read")) return;
    const controller = new AbortController(); void adminFetch(`/admin/jobs/${jobId}`, { signal: controller.signal }).then(async (response) => { const body: unknown = await response.json(); const parsed = JobResponseSchema.safeParse(body); if (response.ok && parsed.success && parsed.data.data.job_id === jobId) setJobError(parsed.data.data.error_code); }).catch(() => undefined); return () => controller.abort();
  }, [adminFetch, jobId, jobStatus, permissions]);

  useEffect(() => { if (jobStatus !== "SUCCEEDED" || jobId === null || successHandled.current === jobId) return; successHandled.current = jobId; const timer = window.setTimeout(() => { setParticipantsLoading(selectedTrainingId !== ""); setRefreshKey((value) => value + 1); }, 0); return () => window.clearTimeout(timer); }, [jobId, jobStatus, selectedTrainingId]);
  useEffect(() => () => operationController.current?.abort(), []);

  const clearFile = () => { setImportFile(null); setFileError(null); setFileInputKey((value) => value + 1); uploadKey.current = null; };
  const resetImport = () => { clearFile(); setJobId(null); setJobTraining(null); setJobStatus(null); setInspection(null); setPreviewRows([]); setPreviewNextCursor(null); setInspectionError(false); setJobError(null); confirmKey.current = null; successHandled.current = null; setImportTrainingId(selectedTraining?.status === "ACTIVE" ? selectedTraining.id : activeTrainings[0]?.id ?? ""); };
  const openImport = () => { if (jobId === null) setImportTrainingId(selectedTraining?.status === "ACTIVE" ? selectedTraining.id : activeTrainings[0]?.id ?? ""); setFeedback(null); setImportOpen(true); };
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0] ?? null; uploadKey.current = null; setFileError(null); if (file === null) { setImportFile(null); return; } const extension = file.name.split(".").pop()?.toLowerCase() ?? ""; if (!acceptedExtensions.has(extension)) { setImportFile(null); setFileError("รองรับเฉพาะไฟล์ CSV หรือ XLSX"); return; } if (file.size > importMaximumBytes) { setImportFile(null); setFileError("ไฟล์มีขนาดเกิน 5 MB"); return; } setImportFile(file); };

  const upload = async (event: FormEvent) => { event.preventDefault(); if (importTrainingId === "" || importFile === null || uploadPending) return; const training = activeTrainings.find((item) => item.id === importTrainingId); if (training === undefined) { setFileError("กรุณาเลือกการอบรมที่ใช้งานอยู่"); return; } const key = uploadKey.current ?? crypto.randomUUID(); uploadKey.current = key; setUploadPending(true); setInspectionError(false);
    const controller = new AbortController(); operationController.current = controller;
    try { const body = new FormData(); body.set("file", importFile); const response = await adminFetch(`/admin/trainings/${importTrainingId}/participants/import`, { method: "POST", headers: { "Idempotency-Key": key }, body, signal: controller.signal }); const responseBody: unknown = await response.json(); const parsed = ParticipantImportQueuedResponseSchema.safeParse(responseBody); if (!response.ok || !parsed.success) throw new Error("upload failed"); setJobId(parsed.data.data.job_id); setJobStatus(parsed.data.data.status); setJobTraining(training); setInspection(null); setPreviewRows([]); setPreviewNextCursor(null); setJobError(null); confirmKey.current = null; setPollTick((value) => value + 1); }
    catch (reason: unknown) { if (!(reason instanceof DOMException && reason.name === "AbortError")) setFileError("ไม่สามารถส่งไฟล์เพื่อตรวจสอบได้ กรุณาลองอีกครั้งโดยใช้ไฟล์เดิม"); } finally { if (operationController.current === controller) operationController.current = null; setUploadPending(false); }
  };

  const loadMorePreview = async () => { if (jobId === null || previewNextCursor === null || previewPending) return; setPreviewPending(true); try { const query = new URLSearchParams({ limit: String(previewPageSize), cursor: previewNextCursor }); const response = await adminFetch(`/admin/participant-imports/${jobId}?${query}`); const body: unknown = await response.json(); const parsed = ParticipantImportInspectResponseSchema.safeParse(body); if (!response.ok || !parsed.success || parsed.data.data.job_id !== jobId) throw new Error("preview failed"); setPreviewRows((current) => [...current, ...parsed.data.data.preview]); setPreviewNextCursor(parsed.data.meta.next_cursor); } catch { setInspectionError(true); } finally { setPreviewPending(false); } };
  const confirmImport = async () => { if (jobId === null || jobStatus !== "AWAITING_CONFIRMATION" || (inspection?.counts.valid ?? 0) === 0 || confirmPending) return; const key = confirmKey.current ?? crypto.randomUUID(); confirmKey.current = key; setConfirmPending(true); const controller = new AbortController(); operationController.current = controller;
    try { const response = await adminFetch(`/admin/participant-imports/${jobId}/confirm`, { method: "POST", headers: { "Idempotency-Key": key }, signal: controller.signal }); const body: unknown = await response.json(); const parsed = ParticipantImportQueuedResponseSchema.safeParse(body); if (!response.ok || !parsed.success || parsed.data.data.job_id !== jobId) throw new Error("confirm failed"); setJobStatus(parsed.data.data.status); setPollTick((value) => value + 1); }
    catch (reason: unknown) { if (!(reason instanceof DOMException && reason.name === "AbortError")) setInspectionError(true); } finally { if (operationController.current === controller) operationController.current = null; setConfirmPending(false); }
  };

  const selectTraining = (value: string) => { const sameTraining = value === selectedTrainingId; setSelectedTrainingId(value); setParticipants([]); setNextCursor(null); setParticipantsLoading(value !== "" && canRead); setLoadError(false); resetParticipantPage(); setFeedback(null); if (sameTraining && value !== "") setRefreshKey((current) => current + 1); };
  const participantSaved = (updated: Participant) => { setParticipants((current) => current.map((item) => item.id === updated.id ? updated : item)); setEditing(null); setFeedback({ kind: "success", message: "บันทึกข้อมูลผู้เข้าร่วมแล้ว" }); };

  return <>
    <AdminPageHeader action={canImport ? <Button className="w-full sm:w-auto" disabled={trainingsLoading || activeTrainings.length === 0} onClick={openImport}><svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24"><path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>นำเข้าผู้เข้าร่วม</Button> : undefined} description="เลือกการอบรมเพื่อตรวจสอบรายชื่อ แก้ไขข้อมูล และนำเข้าผู้เข้าร่วมจากไฟล์อย่างเป็นขั้นตอน" eyebrow="ข้อมูลผู้รับใบประกาศ" title="ผู้เข้าร่วม" />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    {canImport && !trainingsLoading && trainings.length === 0 ? <section className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-5 py-5"><h2 className="text-sm font-semibold text-slate-950">ต้องมีการอบรมก่อนจึงจะนำเข้าผู้เข้าร่วมได้</h2><p className="mt-1 text-sm leading-6 text-slate-600">สร้างการอบรมที่พร้อมใช้งาน แล้วกลับมาเลือกการอบรมเพื่อจัดการรายชื่อผู้เข้าร่วม</p>{permissions.has("training:create") ? <Link className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-[#2557a7] px-4 text-sm font-semibold text-white hover:bg-[#1e478c]" href="/admin/trainings">ไปที่การอบรม</Link> : null}</section> : null}
    <section aria-label="รายชื่อผู้เข้าร่วม" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.03)]">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-5"><div className="flex flex-col gap-1"><h2 className="text-base font-semibold text-slate-950">รายชื่อผู้เข้าร่วม</h2><p className="text-xs leading-5 text-slate-500">แสดงครั้งละ {participantPageSize} รายการตามการอบรมที่เลือก</p></div>
        {permissions.has("training:read") && trainings.length > 0 ? <label className="mt-4 block max-w-xl text-xs font-medium text-slate-600">การอบรม<select className={`${selectClassName} mt-1.5`} disabled={trainingsLoading} onChange={(event) => selectTraining(event.target.value)} value={selectedTrainingId}><option value="">เลือกการอบรม</option>{trainings.map((training) => <option key={training.id} value={training.id}>{training.name} · {training.code}{training.status === "ARCHIVED" ? " (เก็บถาวร)" : training.status === "INACTIVE" ? " (ไม่ใช้งาน)" : ""}</option>)}</select></label> : null}</div>
      {!canRead ? <div className="px-5 py-16 text-center"><h2 className="text-base font-semibold text-slate-950">คุณไม่มีสิทธิ์ดูรายชื่อผู้เข้าร่วม</h2><p className="mt-2 text-sm text-slate-600">ติดต่อผู้ดูแลองค์กรหากจำเป็นต้องใช้งานข้อมูลส่วนนี้</p></div>
        : trainingsLoading ? <LoadingRows /> : loadError ? <LoadError onRetry={() => { setLoadError(false); setRefreshKey((value) => value + 1); }} /> : trainings.length === 0 ? <div className="px-5 py-16 text-center"><h2 className="text-base font-semibold text-slate-950">องค์กรนี้ยังไม่มีการอบรม</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">เมื่อสร้างการอบรมแล้ว คุณจะสามารถนำเข้ารายชื่อจากไฟล์ CSV หรือ XLSX ได้</p></div>
        : selectedTrainingId === "" ? <div className="px-5 py-16 text-center"><span aria-hidden="true" className="mx-auto grid size-11 place-items-center rounded-full bg-blue-50 text-[#2557a7]">✓</span><h2 className="mt-4 text-base font-semibold text-slate-950">เลือกการอบรมเพื่อดูผู้เข้าร่วม</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">รายชื่อจะแสดงเฉพาะการอบรมที่เลือก เพื่อให้คุณทำงานในบริบทที่ถูกต้อง</p></div>
        : participantsLoading ? <LoadingRows /> : participants.length === 0 ? <div className="px-5 py-16 text-center"><h2 className="text-base font-semibold text-slate-950">ยังไม่มีผู้เข้าร่วมในการอบรมนี้</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">นำเข้ารายชื่อจากไฟล์ CSV หรือ XLSX เพื่อเริ่มต้น</p>{canImport && selectedTraining?.status === "ACTIVE" ? <Button className="mt-5" onClick={openImport}>นำเข้าผู้เข้าร่วม</Button> : null}</div> : <>
          <div className="hidden md:block"><table className="w-full table-fixed text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="w-[44%] px-5 py-3 font-medium">ชื่อที่แสดง</th><th className="w-[34%] px-5 py-3 font-medium">รหัสอ้างอิง</th><th className="px-5 py-3 text-right font-medium">การทำงาน</th></tr></thead><tbody className="divide-y divide-slate-200">{participants.map((participant) => <tr key={participant.id}><td className="break-words px-5 py-4 font-medium text-slate-950">{participant.display_name}</td><td className="break-all px-5 py-4 text-slate-600">{participant.external_reference ?? "ไม่ระบุ"}</td><td className="px-5 py-4 text-right">{permissions.has("participant:update") ? <button className="min-h-9 rounded-lg px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100" onClick={() => setEditing(participant)} type="button">แก้ไข</button> : <span className="text-xs text-slate-400">ดูอย่างเดียว</span>}</td></tr>)}</tbody></table></div>
          <ul className="divide-y divide-slate-200 md:hidden">{participants.map((participant) => <li className="p-4" key={participant.id}><h3 className="break-words text-sm font-medium text-slate-950">{participant.display_name}</h3><p className="mt-1 break-all text-xs text-slate-500">รหัสอ้างอิง: {participant.external_reference ?? "ไม่ระบุ"}</p>{permissions.has("participant:update") ? <Button className="mt-4 px-3 text-xs" onClick={() => setEditing(participant)} variant="secondary">แก้ไขข้อมูล</Button> : null}</li>)}</ul>
          <Pagination canGoBack={cursorHistory.length > 0} canGoNext={nextCursor !== null} onBack={() => { const history = [...cursorHistory]; setParticipants([]); setParticipantsLoading(true); setCursor(history.pop()); setCursorHistory(history); }} onNext={() => { if (nextCursor !== null) { setParticipants([]); setParticipantsLoading(true); setCursorHistory((history) => [...history, cursor]); setCursor(nextCursor); } }} />
        </>}
    </section>
    <Dialog description="แก้ไขเฉพาะชื่อที่แสดงและรหัสอ้างอิง โดยไม่เปลี่ยนการอบรม" onClose={() => setEditing(null)} open={editing !== null} title={`แก้ไขผู้เข้าร่วม${editing === null ? "" : ` ${editing.display_name}`}`}>{editing === null ? null : <ParticipantEditForm adminFetch={adminFetch} onCancel={() => setEditing(null)} onSaved={participantSaved} participant={editing} />}</Dialog>
    <Dialog description="อัปโหลด ตรวจสอบ และยืนยันรายชื่อสำหรับการอบรมเดียวอย่างเป็นขั้นตอน" onClose={() => { if (!uploadPending && !confirmPending) setImportOpen(false); }} open={importOpen} pending={uploadPending || confirmPending} size="wide" title="นำเข้าผู้เข้าร่วม">
      <div className="px-5 py-5 sm:px-6"><ol aria-label="ขั้นตอนการนำเข้า" className="grid grid-cols-3 gap-2 text-center text-xs font-medium"><li className={`rounded-lg px-2 py-2 ${jobId === null ? "bg-blue-50 text-[#2557a7]" : "bg-slate-100 text-slate-500"}`}>1 เลือกไฟล์</li><li className={`rounded-lg px-2 py-2 ${jobId !== null && jobStatus !== "SUCCEEDED" ? "bg-blue-50 text-[#2557a7]" : "bg-slate-100 text-slate-500"}`}>2 ตรวจสอบ</li><li className={`rounded-lg px-2 py-2 ${jobStatus === "SUCCEEDED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>3 เสร็จสิ้น</li></ol>
        {jobId === null ? <form className="mt-6 space-y-5" noValidate onSubmit={(event) => void upload(event)}><Field htmlFor="import-training" label="การอบรม"><select className={selectClassName} id="import-training" onChange={(event) => { setImportTrainingId(event.target.value); clearFile(); }} value={importTrainingId}><option value="">เลือกการอบรม</option>{activeTrainings.map((training) => <option key={training.id} value={training.id}>{training.name} · {training.code}</option>)}</select></Field>
          <Field error={fileError ?? undefined} hint="ไฟล์ต้องมีคอลัมน์ display_name และอาจมี external_reference ขนาดไม่เกิน 5 MB" htmlFor="participant-import-file" label="ไฟล์รายชื่อ CSV หรือ XLSX"><label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center hover:border-[#2557a7] hover:bg-blue-50/40" htmlFor="participant-import-file"><svg aria-hidden="true" className="size-6 text-[#2557a7]" fill="none" viewBox="0 0 24 24"><path d="M12 16V4m0 0L8 8m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg><span className="mt-2 text-sm font-semibold text-slate-800">เลือกไฟล์จากอุปกรณ์</span><span className="mt-1 text-xs text-slate-500">ระบบจะตรวจสอบเนื้อหาไฟล์หลังอัปโหลด</span></label><input accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" id="participant-import-file" key={fileInputKey} onChange={chooseFile} type="file" />
          {importFile === null ? null : <div className="mt-3 flex flex-col gap-3 rounded-lg border border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{importFile.name}</p><p className="mt-1 text-xs text-slate-500">{(importFile.size / 1024).toLocaleString("th-TH", { maximumFractionDigits: 1 })} KB</p></div><Button className="shrink-0" onClick={clearFile} variant="quiet">นำไฟล์ออก</Button></div>}</Field>
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-slate-700"><strong className="font-semibold text-slate-900">การตรวจสอบที่เชื่อถือได้ทำโดยระบบ:</strong> ไม่ต้องแก้ไขไฟล์ในเบราว์เซอร์ ระบบจะตรวจสอบรูปแบบ แถวซ้ำ และค่าที่รองรับก่อนให้ยืนยัน</div>
          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end"><Button disabled={uploadPending} onClick={() => setImportOpen(false)} variant="secondary">ยกเลิก</Button><Button disabled={uploadPending || importTrainingId === "" || importFile === null} type="submit">{uploadPending ? "กำลังส่งไฟล์…" : "อัปโหลดและตรวจสอบ"}</Button></div></form>
          : <div className="mt-6"><div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="text-xs font-medium text-slate-500">การอบรมสำหรับการนำเข้านี้</p><p className="mt-1 break-words text-sm font-semibold text-slate-950">{jobTraining?.name ?? "การอบรมที่เลือก"}</p>{importFile === null ? null : <p className="mt-1 truncate text-xs text-slate-500">ไฟล์: {importFile.name}</p>}</div>{jobStatus === null ? null : <ImportStatusBadge status={jobStatus} />}</div>
            {jobStatus === null ? null : <div aria-live="polite" className="mt-5"><p className="text-sm font-medium text-slate-900">{statusPresentation[jobStatus].detail}</p>{inspection !== null && (jobStatus === "QUEUED" || jobStatus === "RUNNING") ? <div className="mt-4"><ProgressBar completed={inspection.progress.completed} total={inspection.progress.total} /></div> : null}</div>}
            {inspectionError ? <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert"><p>ไม่สามารถตรวจสอบสถานะล่าสุดได้</p><Button className="mt-3 border-red-200 text-red-700" disabled={previewPending} onClick={() => { setInspectionError(false); setPollTick((value) => value + 1); }} variant="secondary">ตรวจสอบอีกครั้ง</Button></div> : null}
            {inspection !== null && (jobStatus === "AWAITING_CONFIRMATION" || previewRows.length > 0) ? <section className="mt-6" aria-labelledby="import-preview-title"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h3 className="text-base font-semibold text-slate-950" id="import-preview-title">ผลการตรวจสอบ</h3><p className="mt-1 text-sm text-slate-600">ตรวจสอบแล้ว {inspection.progress.total.toLocaleString("th-TH")} รายการ</p></div><dl className="grid grid-cols-2 gap-2"><div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2"><dt className="text-xs text-emerald-700">ถูกต้อง</dt><dd className="text-lg font-semibold text-emerald-900">{inspection.counts.valid.toLocaleString("th-TH")}</dd></div><div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2"><dt className="text-xs text-red-700">ต้องแก้ไข</dt><dd className="text-lg font-semibold text-red-900">{inspection.counts.invalid.toLocaleString("th-TH")}</dd></div></dl></div><div className="mt-4 overflow-hidden rounded-lg border border-slate-200"><PreviewRows rows={previewRows} /></div>{previewNextCursor === null ? null : <div className="mt-4 text-center"><Button disabled={previewPending} onClick={() => void loadMorePreview()} variant="secondary">{previewPending ? "กำลังโหลด…" : "โหลดรายการตัวอย่างเพิ่มเติม"}</Button></div>}</section> : null}
            {jobStatus === "AWAITING_CONFIRMATION" ? <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4"><h3 className="text-sm font-semibold text-slate-950">ก่อนยืนยันการนำเข้า</h3><p className="mt-1 text-sm leading-6 text-slate-700">ระบบจะนำเข้าเฉพาะ {inspection?.counts.valid.toLocaleString("th-TH") ?? 0} รายการที่ถูกต้อง รายการที่มีปัญหาจะไม่ถูกนำเข้าและควรแก้ไขในไฟล์ก่อนเริ่มงานใหม่</p><div className="mt-4 flex justify-end"><Button disabled={confirmPending || (inspection?.counts.valid ?? 0) === 0} onClick={() => void confirmImport()}>{confirmPending ? "กำลังยืนยัน…" : "ยืนยันการนำเข้า"}</Button></div></div> : null}
            {jobStatus === "SUCCEEDED" ? <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-5"><h3 className="text-base font-semibold text-emerald-950">นำเข้าผู้เข้าร่วมเรียบร้อยแล้ว</h3><p className="mt-1 text-sm leading-6 text-emerald-900">รายชื่อในการอบรมได้รับการอัปเดตแล้วโดยไม่ต้องโหลดหน้าใหม่</p><div className="mt-4 flex flex-col gap-2 sm:flex-row"><Button onClick={() => { if (jobTraining !== null) selectTraining(jobTraining.id); setImportOpen(false); }}>ดูผู้เข้าร่วมในการอบรมนี้</Button><Button onClick={resetImport} variant="secondary">นำเข้าไฟล์เพิ่มเติม</Button></div></div> : null}
            {jobStatus !== null && (jobStatus === "FAILED" || jobStatus === "DEAD_LETTER" || jobStatus === "CANCELLED") ? <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-5 py-5"><h3 className="text-base font-semibold text-red-950">ไม่สามารถดำเนินการนำเข้าได้</h3><p className="mt-1 text-sm leading-6 text-red-900">{jobError === null ? "กรุณาตรวจสอบอีกครั้ง หรือเริ่มนำเข้าด้วยไฟล์ใหม่" : jobErrorLabels[jobError] ?? "กรุณาตรวจสอบอีกครั้ง หรือเริ่มนำเข้าด้วยไฟล์ใหม่"}</p><div className="mt-4 flex flex-col gap-2 sm:flex-row"><Button onClick={() => { setInspectionError(false); setPollTick((value) => value + 1); }} variant="secondary">ตรวจสอบอีกครั้ง</Button><Button onClick={resetImport}>เริ่มนำเข้าใหม่</Button></div></div> : null}
          </div>}
      </div>
    </Dialog>
  </>;
}
