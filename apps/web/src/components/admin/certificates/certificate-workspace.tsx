"use client";

import {
  AdminCertificateResponseSchema, CertificateGenerationQueuedResponseSchema, CertificateListResponseSchema,
  GenerateCertificatesRequestSchema, JobResponseSchema, ParticipantListResponseSchema, ProjectListResponseSchema,
  RevokeCertificateRequestSchema, TemplateListResponseSchema, TrainingListResponseSchema,
  type AdminCertificate, type AuthenticationData, type Participant, type Project, type TemplateListItem, type Training
} from "@certificate-platform/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { AdminPageHeader } from "../admin-page-header";
import { Dialog, Feedback, Field, LoadError, LoadingRows, Pagination, selectClassName } from "../resource-ui";
import { TemplateVisualSurface } from "../templates/template-visual-surface";
import { usePrivateTemplateImages } from "../templates/use-private-template-images";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const participantPageSize = 25; const certificatePageSize = 20; const selectionMaximum = 1_000;
type Membership = AuthenticationData["memberships"][number];
type CertificateStatus = AdminCertificate["status"];
type Job = typeof JobResponseSchema._output.data;
type SelectionMode = "ALL_ELIGIBLE" | "EXPLICIT";
type PdfAction = { readonly certificateId: string; readonly kind: "view" | "download" };

const certificateStatus: Record<CertificateStatus, { label: string; className: string }> = {
  DRAFT: { label: "ฉบับร่าง", className: "border-slate-200 bg-slate-100 text-slate-700" },
  GENERATING: { label: "กำลังสร้าง", className: "border-blue-200 bg-blue-50 text-blue-800" },
  ISSUED: { label: "ออกแล้ว", className: "border-cyan-200 bg-cyan-50 text-cyan-800" },
  AVAILABLE: { label: "พร้อมใช้งาน", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  REVOKED: { label: "เพิกถอนแล้ว", className: "border-red-200 bg-red-50 text-red-800" },
  ARCHIVED: { label: "เก็บถาวร", className: "border-slate-200 bg-slate-100 text-slate-600" }
};
const jobStatus: Record<Job["status"], { label: string; detail: string; className: string }> = {
  QUEUED: { label: "รอสร้าง", detail: "ระบบรับคำขอแล้วและกำลังรอคิว", className: "border-amber-200 bg-amber-50 text-amber-900" },
  RUNNING: { label: "กำลังสร้าง", detail: "ระบบกำลังสร้างใบประกาศจากข้อมูลที่ตรวจสอบแล้ว", className: "border-blue-200 bg-blue-50 text-blue-900" },
  AWAITING_CONFIRMATION: { label: "รอยืนยัน", detail: "งานกำลังรอการยืนยัน", className: "border-amber-200 bg-amber-50 text-amber-900" },
  SUCCEEDED: { label: "สำเร็จ", detail: "สร้างใบประกาศครบแล้ว กำลังแสดงสถานะล่าสุดจากระบบ", className: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  FAILED: { label: "ไม่สำเร็จ", detail: "งานไม่สำเร็จ กรุณาตรวจสอบข้อมูลแล้วลองเริ่มงานใหม่", className: "border-red-200 bg-red-50 text-red-900" },
  DEAD_LETTER: { label: "ต้องตรวจสอบ", detail: "งานต้องให้ผู้ดูแลระบบตรวจสอบก่อนดำเนินการต่อ", className: "border-red-200 bg-red-50 text-red-900" },
  CANCELLED: { label: "ยกเลิกแล้ว", detail: "งานนี้ถูกยกเลิกและจะไม่ดำเนินการต่อ", className: "border-slate-200 bg-slate-100 text-slate-700" }
};
const terminalJobs = new Set<Job["status"]>(["SUCCEEDED", "FAILED", "DEAD_LETTER", "CANCELLED"]);

const formatDate = (value: string | null) => value === null ? "—" : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium" }).format(new Date(value));

function CertificateBadge({ status }: { readonly status: CertificateStatus }) {
  const item = certificateStatus[status];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${item.className}`}>{item.label}</span>;
}

function CertificateActions({ canDownload, canRevoke, certificate, pdfAction, onDownload, onRevoke, onView }: {
  readonly canDownload: boolean; readonly canRevoke: boolean; readonly certificate: AdminCertificate;
  readonly pdfAction: PdfAction | null; readonly onDownload: () => void; readonly onRevoke: () => void; readonly onView: () => void;
}) {
  const available = certificate.status === "AVAILABLE";
  const busy = pdfAction?.certificateId === certificate.id;
  if (!available || (!canDownload && !canRevoke)) return null;
  return <div className="mt-3 flex flex-wrap items-center gap-1.5">
    {canDownload ? <>
      <button className="min-h-10 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-[#2557a7] hover:bg-blue-50 disabled:cursor-wait disabled:opacity-60" disabled={busy} onClick={onView} type="button">
        {busy && pdfAction?.kind === "view" ? "กำลังเปิด…" : "ดูใบประกาศ"}
      </button>
      <button className="min-h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60" disabled={busy} onClick={onDownload} type="button">
        {busy && pdfAction?.kind === "download" ? "กำลังดาวน์โหลด…" : "ดาวน์โหลด PDF"}
      </button>
    </> : null}
    {canRevoke ? <button className="min-h-10 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50" disabled={busy} onClick={onRevoke} type="button">เพิกถอน</button> : null}
  </div>;
}

function PublishedTemplateCard({ adminFetch, selected, template, onSelect }: { readonly adminFetch: AdminFetch;
  readonly selected: boolean; readonly template: TemplateListItem; readonly onSelect: () => void }) {
  const preview = template.preview!;
  const imageReferences = useMemo(() => [...new Set(preview.definition.elements.flatMap((element) =>
    element.type === "image" || element.type === "signature" ? [element.asset_id] : []))].map((id) => ({ id })), [preview.definition]);
  const images = usePrivateTemplateImages(adminFetch, template.id, imageReferences);
  const ratio = preview.definition.page.width / preview.definition.page.height;
  return <button aria-pressed={selected} className={`grid min-w-0 grid-cols-[6.25rem_1fr] gap-4 rounded-xl border p-3 text-left transition sm:grid-cols-[7.5rem_1fr] ${selected ? "border-[#2557a7] bg-blue-50 ring-2 ring-blue-100" : "border-slate-200 bg-white hover:border-slate-300"}`} onClick={onSelect} type="button">
    <span aria-hidden="true" className="grid h-24 place-items-center overflow-hidden rounded-lg bg-slate-100 p-2">
      <span className="relative block overflow-hidden bg-[#fffdf8] shadow-sm" style={{ aspectRatio: String(ratio), containerType: "inline-size", ...(ratio >= 1 ? { width: "100%" } : { height: "100%" }) }}><TemplateVisualSurface definition={preview.definition} failedImages={images.failed} imageUrls={images.urls} /></span>
    </span>
    <span className="min-w-0 self-center"><span className="block truncate text-sm font-semibold text-slate-950">{template.name}</span><span className="mt-1 block text-xs text-slate-600">เวอร์ชันเผยแพร่ {preview.version}</span><span className="mt-2 block text-xs font-medium text-[#2557a7]">{ratio >= 1 ? "แนวนอน" : "แนวตั้ง"} · พร้อมใช้ออกใบประกาศ</span></span>
  </button>;
}

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function CertificateWorkspace({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const canRead = permissions.has("certificate:read"); const canGenerate = permissions.has("certificate:generate");
  const canRevoke = permissions.has("certificate:revoke"); const canDownload = permissions.has("certificate:download");
  const canReadJobs = permissions.has("job:read");
  const [trainings, setTrainings] = useState<Training[]>([]); const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<TemplateListItem[]>([]); const [dependenciesLoading, setDependenciesLoading] = useState(canGenerate);
  const [dependencyError, setDependencyError] = useState(false); const [selectedTrainingId, setSelectedTrainingId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(""); const [mode, setMode] = useState<SelectionMode>("ALL_ELIGIBLE");
  const [participants, setParticipants] = useState<Participant[]>([]); const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantCursor, setParticipantCursor] = useState<string | undefined>(); const [participantHistory, setParticipantHistory] = useState<(string | undefined)[]>([]);
  const [participantNext, setParticipantNext] = useState<string | null>(null); const [selectedParticipants, setSelectedParticipants] = useState<Map<string, Participant>>(new Map());
  const [generationPending, setGenerationPending] = useState(false); const [generationError, setGenerationError] = useState<string | null>(null);
  const generationOperation = useRef<{ signature: string; key: string } | null>(null); const [currentJob, setCurrentJob] = useState<Job | null>(null);
  const [jobPollingError, setJobPollingError] = useState(false); const [jobPollTick, setJobPollTick] = useState(0);
  const [certificates, setCertificates] = useState<AdminCertificate[]>([]); const [certificatesLoading, setCertificatesLoading] = useState(canRead);
  const [certificatesError, setCertificatesError] = useState(false); const [certificateCursor, setCertificateCursor] = useState<string | undefined>();
  const [certificateHistory, setCertificateHistory] = useState<(string | undefined)[]>([]); const [certificateNext, setCertificateNext] = useState<string | null>(null);
  const [certificateTrainingFilter, setCertificateTrainingFilter] = useState(""); const [certificateStatusFilter, setCertificateStatusFilter] = useState<CertificateStatus | "">("");
  const [certificateRefresh, setCertificateRefresh] = useState(0); const [revokeTarget, setRevokeTarget] = useState<AdminCertificate | null>(null);
  const [revokeReason, setRevokeReason] = useState(""); const [revokePending, setRevokePending] = useState(false);
  const [pdfAction, setPdfAction] = useState<PdfAction | null>(null); const objectUrls = useRef(new Set<string>());
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const adminFetch = useCallback<AdminFetch>((path, init = {}) => fetch(`${apiBasePath}${path}`, { ...init, cache: "no-store", credentials: "same-origin", headers: {
    "X-Organization-ID": membership.organization.id, ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers
  } }), [csrfToken, membership.organization.id]);

  useEffect(() => () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, [membership.organization.id]);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const activeTrainings = useMemo(() => trainings.filter((training) => training.status === "ACTIVE"), [trainings]);
  const publishedTemplates = useMemo(() => templates.filter((template) => template.status === "ACTIVE" && template.preview?.status === "PUBLISHED" && template.preview.version_id !== undefined), [templates]);
  const selectedTraining = activeTrainings.find((training) => training.id === selectedTrainingId);
  const selectedTemplate = publishedTemplates.find((template) => template.id === selectedTemplateId);

  useEffect(() => {
    if (!canGenerate) return;
    const controller = new AbortController();
    const loadAll = async <T,>(path: string, parse: (body: unknown) => { data: T[]; next: string | null }) => { const data: T[] = []; let cursor: string | null = null; const seen = new Set<string>(); do {
      const query = new URLSearchParams({ limit: "100" }); if (cursor !== null) query.set("cursor", cursor);
      const response = await adminFetch(`${path}?${query}`, { signal: controller.signal }); const parsed = parse(await response.json()); if (!response.ok) throw new Error("dependency"); data.push(...parsed.data); cursor = parsed.next;
      if (cursor !== null && seen.has(cursor)) throw new Error("cursor"); if (cursor !== null) seen.add(cursor);
    } while (cursor !== null && !controller.signal.aborted); return data; };
    void Promise.all([
      permissions.has("training:read") ? loadAll("/admin/trainings", (body) => { const parsed = TrainingListResponseSchema.parse(body); return { data: parsed.data, next: parsed.meta.next_cursor }; }) : Promise.resolve([]),
      permissions.has("project:read") ? loadAll("/admin/projects", (body) => { const parsed = ProjectListResponseSchema.parse(body); return { data: parsed.data, next: parsed.meta.next_cursor }; }) : Promise.resolve([]),
      permissions.has("template:read") ? loadAll("/admin/templates", (body) => { const parsed = TemplateListResponseSchema.parse(body); return { data: parsed.data, next: parsed.meta.next_cursor }; }) : Promise.resolve([])
    ]).then(([trainingRows, projectRows, templateRows]) => { if (!controller.signal.aborted) { setTrainings(trainingRows); setProjects(projectRows); setTemplates(templateRows); } })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setDependencyError(true); })
      .finally(() => { if (!controller.signal.aborted) setDependenciesLoading(false); });
    return () => controller.abort();
  }, [adminFetch, canGenerate, permissions]);

  useEffect(() => {
    if (mode !== "EXPLICIT" || selectedTrainingId === "" || !permissions.has("participant:read")) return;
    const controller = new AbortController(); const query = new URLSearchParams({ limit: String(participantPageSize), training_id: selectedTrainingId }); if (participantCursor !== undefined) query.set("cursor", participantCursor);
    void adminFetch(`/admin/participants?${query}`, { signal: controller.signal }).then(async (response) => { const parsed = ParticipantListResponseSchema.safeParse(await response.json()); if (!response.ok || !parsed.success) throw new Error("participants"); if (!controller.signal.aborted) { setParticipants(parsed.data.data); setParticipantNext(parsed.data.meta.next_cursor); } })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setGenerationError("ไม่สามารถโหลดรายชื่อผู้เข้าร่วมได้ กรุณาลองอีกครั้ง"); })
      .finally(() => { if (!controller.signal.aborted) setParticipantsLoading(false); }); return () => controller.abort();
  }, [adminFetch, mode, participantCursor, permissions, selectedTrainingId]);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController(); const query = new URLSearchParams({ limit: String(certificatePageSize) });
    if (certificateCursor !== undefined) query.set("cursor", certificateCursor); if (certificateTrainingFilter !== "") query.set("training_id", certificateTrainingFilter); if (certificateStatusFilter !== "") query.set("status", certificateStatusFilter);
    void adminFetch(`/admin/certificates?${query}`, { signal: controller.signal }).then(async (response) => { const parsed = CertificateListResponseSchema.safeParse(await response.json()); if (!response.ok || !parsed.success) throw new Error("certificates"); if (!controller.signal.aborted) { setCertificates(parsed.data.data); setCertificateNext(parsed.data.meta.next_cursor); setCertificatesError(false); } })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setCertificatesError(true); })
      .finally(() => { if (!controller.signal.aborted) setCertificatesLoading(false); }); return () => controller.abort();
  }, [adminFetch, canRead, certificateCursor, certificateRefresh, certificateStatusFilter, certificateTrainingFilter]);

  useEffect(() => {
    if (currentJob === null || terminalJobs.has(currentJob.status) || !canReadJobs) return;
    const jobId = currentJob.job_id; const controller = new AbortController(); const timer = window.setTimeout(() => { void adminFetch(`/admin/jobs/${jobId}`, { signal: controller.signal }).then(async (response) => { const parsed = JobResponseSchema.safeParse(await response.json()); if (!response.ok || !parsed.success || parsed.data.data.job_id !== jobId || parsed.data.data.type !== "CERTIFICATE_GENERATION") throw new Error("job"); if (!controller.signal.aborted) { setCurrentJob(parsed.data.data); setJobPollingError(false); if (parsed.data.data.status === "SUCCEEDED") { setCertificatesLoading(canRead); setCertificateRefresh((value) => value + 1); } else if (!terminalJobs.has(parsed.data.data.status)) setJobPollTick((value) => value + 1); } })
      .catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setJobPollingError(true); }); }, 1500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [adminFetch, canRead, canReadJobs, currentJob, jobPollTick]);

  const resetParticipantPaging = () => { setParticipantCursor(undefined); setParticipantHistory([]); setParticipantNext(null); };
  const changeTraining = (trainingId: string) => { setSelectedTrainingId(trainingId); setSelectedParticipants(new Map()); setParticipants([]); setParticipantsLoading(mode === "EXPLICIT" && trainingId !== ""); resetParticipantPaging(); setGenerationError(null); generationOperation.current = null; };
  const toggleParticipant = (participant: Participant) => setSelectedParticipants((current) => { const next = new Map(current); if (next.has(participant.id)) next.delete(participant.id); else if (next.size < selectionMaximum) next.set(participant.id, participant); return next; });
  const submissionSignature = `${selectedTrainingId}|${selectedTemplate?.preview?.version_id ?? ""}|${mode}|${mode === "EXPLICIT" ? [...selectedParticipants.keys()].sort().join(",") : "all"}`;
  const generate = async () => {
    if (selectedTraining === undefined || selectedTemplate?.preview?.version_id === undefined || generationPending || (mode === "EXPLICIT" && selectedParticipants.size === 0)) return;
    const request = GenerateCertificatesRequestSchema.safeParse({ template_version_id: selectedTemplate.preview.version_id,
      ...(mode === "EXPLICIT" ? { participant_ids: [...selectedParticipants.keys()] } : {}) }); if (!request.success) return;
    const operation = generationOperation.current?.signature === submissionSignature ? generationOperation.current : { signature: submissionSignature, key: crypto.randomUUID() }; generationOperation.current = operation;
    setGenerationPending(true); setGenerationError(null); setFeedback(null);
    try { const response = await adminFetch(`/admin/trainings/${selectedTraining.id}/certificates/generate`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": operation.key }, body: JSON.stringify(request.data) }); const body: unknown = await response.json(); const parsed = CertificateGenerationQueuedResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) { if (response.status === 409) throw new Error("conflict"); if (response.status === 429) throw new Error("rate"); if (response.status === 503) throw new Error("service"); throw new Error("request"); }
      setCurrentJob({ job_id: parsed.data.data.job_id, type: "CERTIFICATE_GENERATION", status: parsed.data.data.status, progress: { completed: 0, total: 0 }, attempt_count: 0, error_code: null }); if (parsed.data.data.status === "SUCCEEDED") { setCertificatesLoading(canRead); setCertificateRefresh((value) => value + 1); } else setJobPollTick((value) => value + 1); setFeedback({ kind: "success", message: "เริ่มสร้างใบประกาศแล้ว คุณติดตามความคืบหน้าได้ด้านล่าง" }); generationOperation.current = null;
    } catch (reason: unknown) { const code = reason instanceof Error ? reason.message : "request"; setGenerationError(code === "conflict" ? "ข้อมูลที่เลือกเปลี่ยนไป หรือไม่มีผู้รับที่มีสิทธิ์แล้ว กรุณาตรวจสอบการอบรมและเทมเพลตอีกครั้ง" : code === "rate" ? "มีคำขอมากเกินไป กรุณารอสักครู่แล้วลองส่งคำขอเดิมอีกครั้ง" : code === "service" ? "บริการสร้างใบประกาศไม่พร้อมใช้งานชั่วคราว กรุณาลองอีกครั้ง" : "ส่งคำขอไม่สำเร็จ กรุณาลองอีกครั้ง ระบบจะใช้คำขอเดิมอย่างปลอดภัย"); }
    finally { setGenerationPending(false); }
  };

  const revoke = async (event: FormEvent) => { event.preventDefault(); if (revokeTarget === null || revokePending) return; const parsed = RevokeCertificateRequestSchema.safeParse({ reason: revokeReason }); if (!parsed.success) return;
    setRevokePending(true); try { const response = await adminFetch(`/admin/certificates/${revokeTarget.id}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) }); const result = AdminCertificateResponseSchema.safeParse(await response.json()); if (!response.ok || !result.success) throw new Error("revoke"); setCertificates((rows) => rows.map((row) => row.id === result.data.data.id ? result.data.data : row)); setRevokeTarget(null); setRevokeReason(""); setFeedback({ kind: "success", message: `เพิกถอนใบประกาศ ${result.data.data.certificate_number} แล้ว` }); }
    catch { setFeedback({ kind: "error", message: "ไม่สามารถเพิกถอนใบประกาศได้ สถานะอาจเปลี่ยนไปแล้ว กรุณาโหลดข้อมูลล่าสุด" }); setCertificateRefresh((value) => value + 1); } finally { setRevokePending(false); } };

  const fetchPdf = async (certificate: AdminCertificate, disposition: "inline" | "attachment"): Promise<{ blob: Blob; filename: string }> => {
    const response = await adminFetch(`/admin/certificates/${certificate.id}/pdf?disposition=${disposition}`);
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") throw new Error("pdf");
    const safeNumber = certificate.certificate_number.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
    return { blob: await response.blob(), filename: `certificate-${safeNumber || "document"}.pdf` };
  };

  const viewPdf = async (certificate: AdminCertificate) => {
    if (!canDownload || certificate.status !== "AVAILABLE" || pdfAction !== null) return;
    const popup = window.open("about:blank", "_blank");
    if (popup === null) { setFeedback({ kind: "error", message: "เบราว์เซอร์บล็อกหน้าต่างใหม่ กรุณาอนุญาตป๊อปอัปแล้วลองอีกครั้ง" }); return; }
    popup.opener = null; setPdfAction({ certificateId: certificate.id, kind: "view" }); setFeedback(null);
    try {
      const { blob } = await fetchPdf(certificate, "inline"); const url = URL.createObjectURL(blob); objectUrls.current.add(url);
      popup.location.href = url;
      window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url); }, 60_000);
    } catch { popup.close(); setFeedback({ kind: "error", message: "ไม่สามารถเปิดใบประกาศได้ กรุณาลองอีกครั้ง" }); }
    finally { setPdfAction(null); }
  };

  const downloadPdf = async (certificate: AdminCertificate) => {
    if (!canDownload || certificate.status !== "AVAILABLE" || pdfAction !== null) return;
    setPdfAction({ certificateId: certificate.id, kind: "download" }); setFeedback(null);
    try {
      const { blob, filename } = await fetchPdf(certificate, "attachment"); const url = URL.createObjectURL(blob); objectUrls.current.add(url);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url); }, 0);
    } catch { setFeedback({ kind: "error", message: "ไม่สามารถดาวน์โหลดใบประกาศได้ กรุณาลองอีกครั้ง" }); }
    finally { setPdfAction(null); }
  };

  return <>
    <AdminPageHeader eyebrow="ศูนย์ควบคุมการออกใบประกาศ" title="ใบประกาศนียบัตร" description="เลือกข้อมูล ตรวจสอบผู้รับ เริ่มสร้าง และจัดการใบประกาศจากสถานะจริงของระบบในพื้นที่เดียว" />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    {canGenerate ? <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.05)]" aria-labelledby="generation-title">
      <div className="border-b border-slate-200 bg-[linear-gradient(135deg,#f8fbff_0%,#eef5ff_55%,#fff_100%)] px-5 py-6 sm:px-7"><div className="flex items-start gap-4"><span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#2557a7] text-lg font-bold text-white">+</span><div><h2 className="text-xl font-semibold text-slate-950" id="generation-title">สร้างใบประกาศชุดใหม่</h2><p className="mt-1 text-sm leading-6 text-slate-600">ทำตาม 4 ขั้นตอน ระบบจะตรวจสิทธิ์และความพร้อมอีกครั้งก่อนเริ่มงานจริง</p></div></div></div>
      {dependenciesLoading ? <LoadingRows /> : dependencyError ? <LoadError onRetry={() => window.location.reload()} /> : !permissions.has("training:read") || !permissions.has("template:read") ? <div className="px-5 py-12 text-center"><h3 className="font-semibold text-slate-950">สิทธิ์สำหรับข้อมูลประกอบยังไม่ครบ</h3><p className="mt-2 text-sm text-slate-600">คุณสร้างใบประกาศได้ แต่ต้องมีสิทธิ์อ่านการอบรมและเทมเพลตก่อนจึงจะเลือกข้อมูลอย่างปลอดภัยได้</p></div> : <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-8 px-5 py-6 sm:px-7">
          <section aria-labelledby="step-training"><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-full bg-[#2557a7] text-xs font-bold text-white">1</span><h3 className="font-semibold text-slate-950" id="step-training">เลือกการอบรม</h3></div>
            {activeTrainings.length === 0 ? <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5"><p className="font-medium text-slate-900">ยังไม่มีการอบรมที่ใช้งานได้</p><Link className="mt-3 inline-flex text-sm font-semibold text-[#2557a7]" href="/admin/trainings">สร้างการอบรมก่อน →</Link></div> : <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="generation-training">การอบรม<select className={`${selectClassName} mt-1.5`} id="generation-training" onChange={(event) => changeTraining(event.target.value)} value={selectedTrainingId}><option value="">เลือกการอบรม</option>{activeTrainings.map((training) => <option key={training.id} value={training.id}>{training.name} · {training.code} · {projectMap.get(training.project_id) ?? "โครงการ"}</option>)}</select></label>}
          </section>
          <section aria-labelledby="step-template"><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-full bg-[#2557a7] text-xs font-bold text-white">2</span><h3 className="font-semibold text-slate-950" id="step-template">เลือกเทมเพลตที่เผยแพร่แล้ว</h3></div>
            {publishedTemplates.length === 0 ? <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5"><p className="font-medium text-slate-900">ยังไม่มีเทมเพลตที่เผยแพร่แล้ว</p><Link className="mt-3 inline-flex text-sm font-semibold text-[#2557a7]" href="/admin/templates">ไปที่เทมเพลต →</Link></div> : <div className="mt-4 grid gap-3 xl:grid-cols-2">{publishedTemplates.map((template) => <PublishedTemplateCard adminFetch={adminFetch} key={template.id} onSelect={() => { setSelectedTemplateId(template.id); setGenerationError(null); generationOperation.current = null; }} selected={selectedTemplateId === template.id} template={template} />)}</div>}
          </section>
          <section aria-labelledby="step-recipient"><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-full bg-[#2557a7] text-xs font-bold text-white">3</span><h3 className="font-semibold text-slate-950" id="step-recipient">เลือกผู้รับ</h3></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className={`rounded-xl border p-4 ${mode === "ALL_ELIGIBLE" ? "border-[#2557a7] bg-blue-50" : "border-slate-200"}`}><span className="flex items-start gap-3"><input checked={mode === "ALL_ELIGIBLE"} className="mt-1 size-4" name="recipient-mode" onChange={() => { setMode("ALL_ELIGIBLE"); setSelectedParticipants(new Map()); resetParticipantPaging(); generationOperation.current = null; }} type="radio" /><span><strong className="block text-sm text-slate-950">ผู้เข้าร่วมที่มีสิทธิ์ทั้งหมด</strong><small className="mt-1 block leading-5 text-slate-600">ระบบจะเลือกผู้มีสิทธิ์ตามกฎล่าสุดเมื่อเริ่มงาน</small></span></span></label>
              <label className={`rounded-xl border p-4 ${mode === "EXPLICIT" ? "border-[#2557a7] bg-blue-50" : "border-slate-200"}`}><span className="flex items-start gap-3"><input checked={mode === "EXPLICIT"} className="mt-1 size-4" disabled={!permissions.has("participant:read")} name="recipient-mode" onChange={() => { setMode("EXPLICIT"); setParticipants([]); setParticipantsLoading(selectedTrainingId !== ""); resetParticipantPaging(); generationOperation.current = null; }} type="radio" /><span><strong className="block text-sm text-slate-950">เลือกผู้เข้าร่วมเอง</strong><small className="mt-1 block leading-5 text-slate-600">เลือกได้สูงสุด {selectionMaximum.toLocaleString("th-TH")} คน และคงรายการข้ามหน้า</small></span></span></label></div>
            {mode === "EXPLICIT" ? selectedTrainingId === "" ? <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">เลือกการอบรมก่อนเพื่อดูรายชื่อผู้เข้าร่วม</p> : participantsLoading ? <LoadingRows /> : participants.length === 0 ? <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-5 text-center"><p className="font-medium text-slate-900">ยังไม่มีผู้เข้าร่วมในการอบรมนี้</p><Link className="mt-3 inline-flex text-sm font-semibold text-[#2557a7]" href="/admin/participants">เพิ่มหรือนำเข้าผู้เข้าร่วม →</Link></div> : <div className="mt-4 overflow-hidden rounded-xl border border-slate-200"><div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium text-slate-600">เลือกแล้ว {selectedParticipants.size.toLocaleString("th-TH")} คน</div><ul className="divide-y divide-slate-200">{participants.map((participant) => <li key={participant.id}><label className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-slate-50"><input aria-label={`เลือก ${participant.display_name}`} checked={selectedParticipants.has(participant.id)} className="mt-1 size-4" disabled={!selectedParticipants.has(participant.id) && selectedParticipants.size >= selectionMaximum} onChange={() => toggleParticipant(participant)} type="checkbox" /><span className="min-w-0"><strong className="block break-words text-sm text-slate-900">{participant.display_name}</strong><small className="mt-0.5 block break-all text-slate-500">{participant.external_reference ?? "ไม่ระบุรหัสอ้างอิง"}</small></span></label></li>)}</ul><Pagination canGoBack={participantHistory.length > 0} canGoNext={participantNext !== null} onBack={() => { const history = [...participantHistory]; setParticipants([]); setParticipantsLoading(true); setParticipantCursor(history.pop()); setParticipantHistory(history); }} onNext={() => { if (participantNext !== null) { setParticipants([]); setParticipantsLoading(true); setParticipantHistory((history) => [...history, participantCursor]); setParticipantCursor(participantNext); } }} /></div> : null}
          </section>
        </div>
        <aside className="border-t border-slate-200 bg-slate-50/70 px-5 py-6 lg:border-l lg:border-t-0" aria-labelledby="review-title"><div className="sticky top-5"><div className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-full bg-slate-900 text-xs font-bold text-white">4</span><h3 className="font-semibold text-slate-950" id="review-title">ตรวจสอบก่อนสร้าง</h3></div><dl className="mt-5 space-y-4 text-sm"><div><dt className="text-xs font-medium text-slate-500">การอบรม</dt><dd className="mt-1 font-semibold text-slate-900">{selectedTraining?.name ?? "ยังไม่ได้เลือก"}</dd></div><div><dt className="text-xs font-medium text-slate-500">เทมเพลต</dt><dd className="mt-1 font-semibold text-slate-900">{selectedTemplate?.name ?? "ยังไม่ได้เลือก"}</dd></div><div><dt className="text-xs font-medium text-slate-500">ผู้รับ</dt><dd className="mt-1 font-semibold text-slate-900">{mode === "ALL_ELIGIBLE" ? "ผู้เข้าร่วมที่มีสิทธิ์ทั้งหมด" : `${selectedParticipants.size.toLocaleString("th-TH")} คนที่เลือก`}</dd></div></dl><p className="mt-5 rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-3 text-xs leading-5 text-slate-700">การสร้างทำงานแบบ asynchronous คุณออกจากหน้านี้ได้หลังระบบรับคำขอ และติดตามความคืบหน้าจากสถานะงานจริง</p>{generationError === null ? null : <p className="mt-4 text-sm leading-6 text-red-700" role="alert">{generationError}</p>}<Button className="mt-5 w-full" disabled={generationPending || selectedTraining === undefined || selectedTemplate === undefined || (mode === "EXPLICIT" && selectedParticipants.size === 0)} onClick={() => void generate()}>{generationPending ? "กำลังส่งคำขอ…" : "สร้างใบประกาศ"}</Button></div></aside>
      </div>}
    </section> : null}

    {currentJob === null ? null : <section className={`mt-5 rounded-2xl border p-5 sm:p-6 ${jobStatus[currentJob.status].className}`} aria-labelledby="job-progress-title"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] opacity-70">งานสร้างล่าสุด</p><h2 className="mt-1 text-lg font-semibold" id="job-progress-title">{jobStatus[currentJob.status].label}</h2><p className="mt-1 text-sm leading-6 opacity-90">{jobStatus[currentJob.status].detail}</p></div><span className="self-start rounded-full border border-current/20 bg-white/60 px-3 py-1 text-xs font-semibold">{currentJob.progress.completed.toLocaleString("th-TH")} / {currentJob.progress.total.toLocaleString("th-TH")}</span></div>{currentJob.progress.total > 0 ? <div className="mt-5"><div aria-label="ความคืบหน้าการสร้างใบประกาศ" aria-valuemax={currentJob.progress.total} aria-valuemin={0} aria-valuenow={currentJob.progress.completed} className="h-2.5 overflow-hidden rounded-full bg-white/70" role="progressbar"><span className="block h-full rounded-full bg-current transition-[width]" style={{ width: `${Math.min(100, currentJob.progress.completed / currentJob.progress.total * 100)}%` }} /></div></div> : null}{jobPollingError ? <div className="mt-4"><p className="text-sm" role="alert">ตรวจสอบสถานะล่าสุดไม่ได้ชั่วคราว</p><Button className="mt-2" onClick={() => { setJobPollingError(false); setJobPollTick((value) => value + 1); }} variant="secondary">ลองอีกครั้ง</Button></div> : null}</section>}

    <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="certificate-list-title"><div className="border-b border-slate-200 px-5 py-5 sm:px-6"><div><h2 className="text-lg font-semibold text-slate-950" id="certificate-list-title">ใบประกาศที่สร้างแล้ว</h2><p className="mt-1 text-sm text-slate-600">สถานะล่าสุดจากข้อมูลที่บันทึกจริง แสดงครั้งละ {certificatePageSize} รายการ</p></div>{canRead ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-slate-600">การอบรม<select className={`${selectClassName} mt-1`} onChange={(event) => { setCertificates([]); setCertificatesLoading(true); setCertificateTrainingFilter(event.target.value); setCertificateCursor(undefined); setCertificateHistory([]); }} value={certificateTrainingFilter}><option value="">ทุกการอบรม</option>{trainings.map((training) => <option key={training.id} value={training.id}>{training.name} · {training.code}</option>)}</select></label><label className="text-xs font-medium text-slate-600">สถานะ<select className={`${selectClassName} mt-1`} onChange={(event) => { setCertificates([]); setCertificatesLoading(true); setCertificateStatusFilter(event.target.value as CertificateStatus | ""); setCertificateCursor(undefined); setCertificateHistory([]); }} value={certificateStatusFilter}><option value="">ทุกสถานะ</option>{Object.entries(certificateStatus).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label></div> : null}</div>
      {!canRead ? <div className="px-5 py-14 text-center"><h3 className="font-semibold text-slate-950">คุณไม่มีสิทธิ์ดูรายการใบประกาศ</h3><p className="mt-2 text-sm text-slate-600">ส่วนการจัดการรายการจะพร้อมเมื่อได้รับสิทธิ์ certificate:read</p></div> : certificatesLoading ? <LoadingRows /> : certificatesError ? <LoadError onRetry={() => { setCertificatesLoading(true); setCertificateRefresh((value) => value + 1); }} /> : certificates.length === 0 ? <div className="px-5 py-14 text-center"><h3 className="font-semibold text-slate-950">ยังไม่มีใบประกาศในเงื่อนไขนี้</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">เลือกการอบรม เทมเพลต และผู้รับด้านบนเพื่อเริ่มสร้าง หรือปรับตัวกรองเพื่อดูรายการเดิม</p></div> : <>
        <div className="hidden md:block"><table className="w-full table-fixed text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="w-[18%] px-5 py-3 font-medium">เลขที่ใบประกาศ</th><th className="w-[20%] px-5 py-3 font-medium">ผู้รับ</th><th className="w-[22%] px-5 py-3 font-medium">การอบรม</th><th className="w-[12%] px-5 py-3 font-medium">วันที่ออก</th><th className="px-5 py-3 font-medium">สถานะ / การทำงาน</th></tr></thead><tbody className="divide-y divide-slate-200">{certificates.map((certificate) => <tr key={certificate.id}><td className="break-all px-5 py-4 font-semibold text-slate-950">{certificate.certificate_number}</td><td className="break-words px-5 py-4 text-slate-800">{certificate.recipient_display_name}</td><td className="px-5 py-4"><span className="block break-words text-slate-800">{certificate.training_name}</span><span className="mt-1 block text-xs text-slate-500">{certificate.training_code}</span></td><td className="px-5 py-4 text-slate-600">{formatDate(certificate.issued_at)}</td><td className="px-5 py-4"><CertificateBadge status={certificate.status} /><CertificateActions canDownload={canDownload} canRevoke={canRevoke} certificate={certificate} pdfAction={pdfAction} onDownload={() => void downloadPdf(certificate)} onRevoke={() => { setRevokeTarget(certificate); setRevokeReason(""); }} onView={() => void viewPdf(certificate)} /></td></tr>)}</tbody></table></div>
        <ul className="divide-y divide-slate-200 md:hidden">{certificates.map((certificate) => <li className="p-4" key={certificate.id}><div className="flex items-start justify-between gap-3"><p className="break-all text-sm font-semibold text-slate-950">{certificate.certificate_number}</p><CertificateBadge status={certificate.status} /></div><h3 className="mt-3 break-words text-sm font-medium text-slate-900">{certificate.recipient_display_name}</h3><p className="mt-1 text-xs text-slate-600">{certificate.training_name} · {certificate.training_code}</p><p className="mt-2 text-xs text-slate-500">วันที่ออก {formatDate(certificate.issued_at)}</p><CertificateActions canDownload={canDownload} canRevoke={canRevoke} certificate={certificate} pdfAction={pdfAction} onDownload={() => void downloadPdf(certificate)} onRevoke={() => { setRevokeTarget(certificate); setRevokeReason(""); }} onView={() => void viewPdf(certificate)} /></li>)}</ul>
        <Pagination canGoBack={certificateHistory.length > 0} canGoNext={certificateNext !== null} onBack={() => { const history = [...certificateHistory]; setCertificates([]); setCertificatesLoading(true); setCertificateCursor(history.pop()); setCertificateHistory(history); }} onNext={() => { if (certificateNext !== null) { setCertificates([]); setCertificatesLoading(true); setCertificateHistory((history) => [...history, certificateCursor]); setCertificateCursor(certificateNext); } }} />
      </>}
    </section>

    <Dialog description="การเพิกถอนมีผลต่อการตรวจสอบสาธารณะทันที แต่ไม่ได้ลบไฟล์ PDF ออกจากพื้นที่จัดเก็บ" onClose={() => { if (!revokePending) { setRevokeTarget(null); setRevokeReason(""); } }} open={revokeTarget !== null} pending={revokePending} title="ยืนยันการเพิกถอนใบประกาศ">
      <form noValidate onSubmit={(event) => void revoke(event)}><div className="space-y-5 px-5 py-5 sm:px-6"><div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-900"><strong className="block">ใบประกาศจะไม่แสดงว่าใช้งานได้อีกต่อไป</strong><span>หน้าตรวจสอบสาธารณะจะแสดงสถานะเพิกถอนตามสัญญาของระบบ</span></div><p className="text-sm text-slate-700">{revokeTarget?.certificate_number} · {revokeTarget?.recipient_display_name}</p><Field error={revokeReason.trim().length > 0 && !RevokeCertificateRequestSchema.safeParse({ reason: revokeReason }).success ? "ระบุเหตุผลอย่างน้อย 3 ตัวอักษร และไม่เกิน 500 ตัวอักษร" : undefined} hint="เหตุผลเป็นข้อมูลสำหรับผู้ดูแลและจะไม่แสดงบนหน้าตรวจสอบสาธารณะ" htmlFor="revocation-reason" label="เหตุผลการเพิกถอน"><textarea autoFocus className={`${selectClassName} min-h-28 resize-y`} id="revocation-reason" maxLength={500} onChange={(event) => setRevokeReason(event.target.value)} value={revokeReason} /></Field></div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={revokePending} onClick={() => { setRevokeTarget(null); setRevokeReason(""); }} variant="secondary">ยกเลิก</Button><Button className="bg-red-700 hover:bg-red-800 disabled:hover:bg-red-700" disabled={revokePending || !RevokeCertificateRequestSchema.safeParse({ reason: revokeReason }).success} type="submit">{revokePending ? "กำลังเพิกถอน…" : "ยืนยันเพิกถอน"}</Button></footer></form>
    </Dialog>
  </>;
}
