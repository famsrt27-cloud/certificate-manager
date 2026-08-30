"use client";

import { DashboardSummaryResponseSchema, OrganizationPublicSearchResponseSchema,
  type AuthenticationData, type DashboardSummaryData } from "@certificate-platform/contracts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { DashboardSection } from "./dashboard-section";
import { MetricCard } from "./metric-card";

type Membership = AuthenticationData["memberships"][number];
type LoadState = { readonly kind: "loading" } | { readonly kind: "error" } | { readonly kind: "ready"; readonly data: DashboardSummaryData };
const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";

function MetricIcon({ kind }: { readonly kind: "project" | "training" | "participant" | "certificate" }) {
  const paths = {
    project: "M4.5 7.5h5l1.5 2h8.5v9h-15v-11Z",
    training: "M4 6.5h16v11H4v-11Zm4 14h8M12 17.5v3",
    participant: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7-1a2.5 2.5 0 1 0 0-5M3.5 19c.3-3.4 2-5 5-5s4.7 1.6 5 5m.5-5c3.6-.3 5.7 1.3 6 4.5",
    certificate: "M7 3.5h10v11H7v-11Zm3 11v6l2-1.5 2 1.5v-6M10 8h4"
  } as const;
  return <svg className="size-5" viewBox="0 0 24 24" fill="none"><path d={paths[kind]} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function DashboardLoading() {
  return <div aria-live="polite" aria-busy="true"><p className="sr-only">กำลังโหลดข้อมูลภาพรวมขององค์กร</p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => (
      <div className="h-36 animate-pulse rounded-xl border border-slate-200 bg-white p-5" key={index}>
        <div className="h-4 w-24 rounded bg-slate-200" /><div className="mt-4 h-8 w-16 rounded bg-slate-200" /><div className="mt-4 h-3 w-32 rounded bg-slate-100" />
      </div>
    ))}</div></div>;
}

const actionClass = "inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg bg-[#2557a7] px-3.5 text-sm font-semibold text-white hover:bg-[#1e478c] focus:outline-none focus:ring-3 focus:ring-blue-200";

export function AdminDashboard({ csrfToken, membership }: { readonly csrfToken: string; readonly membership: Membership }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [settingState, setSettingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [reload, setReload] = useState(0);
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiBasePath}/admin/dashboard`, { credentials: "same-origin", cache: "no-store",
      headers: { "X-Organization-ID": membership.organization.id }, signal: controller.signal
    }).then(async (response) => {
      const parsed = DashboardSummaryResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("dashboard unavailable");
      setState({ kind: "ready", data: parsed.data.data });
    }).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setState({ kind: "error" });
    });
    return () => controller.abort();
  }, [membership.organization.id, reload]);

  if (state.kind === "loading") return <DashboardLoading />;
  if (state.kind === "error") return <section className="rounded-xl border border-red-200 bg-white px-5 py-6" role="alert" aria-labelledby="dashboard-error-title">
    <h2 className="font-semibold text-slate-950" id="dashboard-error-title">ไม่สามารถโหลดข้อมูลภาพรวมได้</h2>
    <p className="mt-1 text-sm leading-6 text-slate-600">ไม่สามารถอ่านสถานะขององค์กรได้ในขณะนี้ กรุณาลองอีกครั้งโดยไม่กระทบเซสชันที่กำลังใช้งาน</p>
    <button className="mt-4 min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-3 focus:ring-blue-100"
      onClick={() => { setState({ kind: "loading" }); setReload((current) => current + 1); }} type="button">ลองอีกครั้ง</button>
  </section>;

  const { data } = state;
  const primaryMetrics = [
    ...(data.projects === undefined ? [] : [{ label: "โครงการ", value: data.projects.active, detail: `ใช้งานจากทั้งหมด ${data.projects.total.toLocaleString("th-TH")}`, kind: "project" as const }]),
    ...(data.trainings === undefined ? [] : [{ label: "การอบรม", value: data.trainings.active, detail: `ใช้งานจากทั้งหมด ${data.trainings.total.toLocaleString("th-TH")}`, kind: "training" as const }]),
    ...(data.participants === undefined ? [] : [{ label: "ผู้เข้าร่วม", value: data.participants.total, detail: "จำนวนทั้งหมดภายในองค์กร", kind: "participant" as const }]),
    ...(data.certificates === undefined ? [] : [{ label: "ใบประกาศพร้อมใช้", value: data.certificates.available, detail: `กำลังดำเนินการ ${data.certificates.in_progress.toLocaleString("th-TH")}`, kind: "certificate" as const }])
  ];
  const attention = [
    ...(data.projects?.total === 0 ? [{ title: "เริ่มต้นด้วยโครงการแรก", description: "สร้างโครงการเพื่อเป็นโครงสร้างหลักสำหรับการอบรม", href: "/admin/projects", action: "สร้างโครงการ", allowed: permissions.has("project:create") }] : []),
    ...(data.trainings?.total === 0 ? [{ title: "ยังไม่มีการอบรม", description: "เพิ่มการอบรมภายใต้โครงการที่พร้อมใช้งาน", href: "/admin/trainings", action: "เพิ่มการอบรม", allowed: permissions.has("training:create") }] : []),
    ...(data.templates?.published_versions === 0 ? [{ title: "เทมเพลตยังไม่พร้อมใช้งาน", description: "สร้างและเผยแพร่เวอร์ชันเทมเพลตก่อนออกใบประกาศ", href: "/admin/templates", action: "เตรียมเทมเพลต", allowed: permissions.has("template:create") || permissions.has("template:publish") }] : []),
    ...((data.jobs?.failed ?? 0) + (data.jobs?.dead_letter ?? 0) > 0 ? [{ title: "มีงานที่ต้องตรวจสอบ", description: `พบงานล้มเหลวหรือหยุดถาวร ${(data.jobs!.failed + data.jobs!.dead_letter).toLocaleString("th-TH")} งาน`, href: "/admin/certificates", action: "ดูสถานะงาน", allowed: permissions.has("job:read") }] : [])
  ];
  const workflow = [
    { label: "สร้างโครงการ", complete: (data.projects?.active ?? 0) > 0, available: data.projects !== undefined, href: "/admin/projects" },
    { label: "เพิ่มการอบรม", complete: (data.trainings?.active ?? 0) > 0, available: data.trainings !== undefined, href: "/admin/trainings" },
    { label: "เพิ่มผู้เข้าร่วม", complete: (data.participants?.total ?? 0) > 0, available: data.participants !== undefined, href: "/admin/participants" },
    { label: "เตรียมเทมเพลต", complete: (data.templates?.published_versions ?? 0) > 0, available: data.templates !== undefined, href: "/admin/templates" },
    { label: "ออกใบประกาศนียบัตร", complete: (data.certificates?.available ?? 0) > 0, available: data.certificates !== undefined, href: "/admin/certificates" }
  ];

  const updatePublicSearch = async (enabled: boolean) => {
    if (!permissions.has("organization:update") || settingState === "saving") return;
    setSettingState("saving");
    try {
      const response = await fetch(`${apiBasePath}/admin/organizations/current`, {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken,
          "X-Organization-ID": membership.organization.id },
        body: JSON.stringify({ public_certificate_search_enabled: enabled })
      });
      const parsed = OrganizationPublicSearchResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("setting update failed");
      setState((current) => current.kind !== "ready" ? current : { kind: "ready", data: {
        ...current.data, organization: parsed.data.data
      } });
      setSettingState("saved");
    } catch { setSettingState("error"); }
  };

  return <div className="space-y-7">
    {primaryMetrics.length === 0 ? <section className="rounded-xl border border-slate-200 bg-white px-5 py-6" role="status">
      <h2 className="font-semibold text-slate-950">ไม่มีข้อมูลสรุปที่เปิดให้ดู</h2><p className="mt-1 text-sm leading-6 text-slate-600">ระบบจะแสดงเฉพาะข้อมูลที่สิทธิ์ของคุณอนุญาต</p>
    </section> : <DashboardSection id="dashboard-metrics-title" title="สถานะปัจจุบัน" description="ตัวเลขสรุปจากข้อมูลทั้งหมดขององค์กร">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{primaryMetrics.map((metric) => <MetricCard {...metric} icon={<MetricIcon kind={metric.kind} />} key={metric.label} />)}</div>
    </DashboardSection>}

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
      <DashboardSection id="dashboard-workflow-title" title="ลำดับการเตรียมความพร้อม" description="สถานะจริงตามข้อมูลที่คุณมีสิทธิ์ดู ไม่ใช่ขั้นตอนบังคับ">
        <ol className="overflow-hidden rounded-xl border border-slate-200 bg-white">{workflow.map((step, index) => <li className="flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 last:border-b-0 sm:gap-4 sm:px-5" key={step.label}>
          <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold ${step.complete ? "bg-emerald-100 text-emerald-800" : step.available ? "bg-blue-50 text-[#2557a7]" : "bg-slate-100 text-slate-400"}`} aria-hidden="true">{step.complete ? "✓" : index + 1}</span>
          <span className={`min-w-0 flex-1 text-sm font-medium ${step.available ? "text-slate-800" : "text-slate-400"}`}>{step.label}</span>
          <span className="hidden text-xs font-medium text-slate-500 sm:block">{step.complete ? "พร้อมแล้ว" : step.available ? "ยังไม่พร้อม" : "ไม่มีสิทธิ์ดู"}</span>
          {step.available ? <Link className="text-xs font-semibold text-[#2557a7] hover:underline" href={step.href}>เปิด</Link> : null}
        </li>)}</ol>
      </DashboardSection>

      <DashboardSection id="dashboard-operations-title" title="สถานะการดำเนินงาน" description="ข้อมูลรองที่ควรตรวจสอบเป็นระยะ">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          {data.templates === undefined && data.jobs === undefined ? <p className="text-sm text-slate-500">ไม่มีข้อมูลที่เปิดให้ดู</p> : null}
          {data.templates === undefined ? null : <div className="flex items-center justify-between gap-4 border-b border-slate-100 py-2.5 first:pt-0 last:border-b-0 last:pb-0"><span className="text-sm text-slate-600">เทมเพลตพร้อมใช้</span><strong className="text-sm tabular-nums text-slate-950">{data.templates.published_versions.toLocaleString("th-TH")} เวอร์ชัน</strong></div>}
          {data.jobs === undefined ? null : <><div className="flex items-center justify-between gap-4 border-b border-slate-100 py-2.5"><span className="text-sm text-slate-600">งานระหว่างดำเนินการ</span><strong className="text-sm tabular-nums text-slate-950">{(data.jobs.queued + data.jobs.running).toLocaleString("th-TH")}</strong></div>
            <div className="flex items-center justify-between gap-4 py-2.5 pb-0"><span className="text-sm text-slate-600">งานที่ต้องตรวจสอบ</span><strong className="text-sm tabular-nums text-slate-950">{(data.jobs.failed + data.jobs.dead_letter).toLocaleString("th-TH")}</strong></div></>}
        </div>
      </DashboardSection>
    </div>

    <DashboardSection id="public-search-setting-title" title="การค้นหาใบประกาศสาธารณะ"
      description="กำหนดว่าผู้รับใบประกาศสามารถค้นหาใบประกาศขององค์กรนี้ได้หรือไม่">
      <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm leading-6 text-slate-700">เมื่อเปิดใช้งาน ผู้รับใบประกาศสามารถค้นหาใบประกาศด้วยชื่อพร้อมข้อมูลโครงการหรือการอบรม และดาวน์โหลดใบประกาศที่พร้อมใช้งานได้</p>
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">ผลการค้นหาอาจแสดงชื่อผู้รับ โครงการ การอบรม เลขที่ใบประกาศ และวันที่ออก</div>
          </div>
          <div className="shrink-0">
            <button type="button" role="switch" aria-checked={data.organization.public_certificate_search_enabled}
              disabled={!permissions.has("organization:update") || settingState === "saving"}
              onClick={() => void updatePublicSearch(!data.organization.public_certificate_search_enabled)}
              className={`inline-flex min-h-12 min-w-28 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-semibold transition focus:outline-none focus:ring-3 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60 ${
                data.organization.public_certificate_search_enabled ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-slate-300 bg-slate-50 text-slate-700"
              }`}>
              <span className={`size-2.5 rounded-full ${data.organization.public_certificate_search_enabled ? "bg-emerald-600" : "bg-slate-400"}`} aria-hidden="true" />
              {data.organization.public_certificate_search_enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}
            </button>
            {!permissions.has("organization:update") ? <p className="mt-2 max-w-36 text-xs leading-5 text-slate-500">คุณไม่มีสิทธิ์เปลี่ยนการตั้งค่านี้</p> : null}
          </div>
        </div>
        <div className="mt-3 min-h-5 text-sm" aria-live="polite">
          {settingState === "saving" ? <span className="text-slate-600">กำลังบันทึก…</span> : null}
          {settingState === "saved" ? <span className="font-medium text-emerald-700">บันทึกการตั้งค่าแล้ว</span> : null}
          {settingState === "error" ? <span className="font-medium text-red-700" role="alert">ไม่สามารถบันทึกได้ กรุณาลองอีกครั้ง</span> : null}
        </div>
      </div>
    </DashboardSection>

    {attention.length > 0 ? <DashboardSection id="dashboard-attention-title" title="สิ่งที่ควรดำเนินการ" description="คำแนะนำจากสถานะปัจจุบันขององค์กร">
      <div className="grid gap-3 lg:grid-cols-2">{attention.map((item) => <article className="flex min-w-0 flex-col gap-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4 sm:flex-row sm:items-center" key={item.title}>
        <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-amber-950">{item.title}</h3><p className="mt-1 text-sm leading-5 text-amber-900/80">{item.description}</p></div>
        {item.allowed ? <Link className={actionClass} href={item.href}>{item.action}</Link> : null}
      </article>)}</div>
    </DashboardSection> : <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm leading-6 text-emerald-950" role="status"><span className="font-semibold">พร้อมดำเนินงาน</span> ไม่พบรายการเร่งด่วนจากข้อมูลที่คุณมีสิทธิ์ดู</section>}
  </div>;
}
