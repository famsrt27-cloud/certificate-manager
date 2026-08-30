"use client";

import {
  PublicDownloadAuthorizationResponseSchema,
  PublicCertificateSearchResponseSchema,
  PublicSearchDownloadAuthorizationResponseSchema,
  PublicVerificationResponseSchema,
  type PublicCertificateSearchResult,
  type PublicVerificationData
} from "@certificate-platform/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { PublicHeader } from "../../components/public/public-header";
import { SearchablePublicSearchPanel } from "./public-search-panel";

type ViewState =
  | { readonly kind: "neutral" }
  | { readonly kind: "loading" }
  | { readonly kind: "failure" }
  | { readonly kind: "success"; readonly certificate: PublicVerificationData };

type DownloadState = "idle" | "working" | "complete" | "failure";

const verifyEndpoint = "/api/public/verify";
const authorizeEndpoint = "/api/public/certificates/download-authorize";
const downloadEndpoint = "/api/public/certificates/download";
const searchEndpoint = "/api/public/certificates/search";
const searchAuthorizeEndpoint = "/api/public/certificates/search-download-authorize";

const postJson = (url: string, body: object): Promise<Response> => fetch(url, {
  method: "POST",
  credentials: "omit",
  cache: "no-store",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const thaiDate = (value: string): string => new Intl.DateTimeFormat("th-TH", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
}).format(new Date(`${value}T00:00:00Z`));

function StatusMark({ kind }: Readonly<{ kind: "neutral" | "loading" | "valid" | "revoked" | "failure" }>) {
  const styles = {
    neutral: "border-[#c9c2b4] bg-[#f6f2e9] text-[#555d63]",
    loading: "border-[#9cb9bf] bg-[#eaf3f3] text-[#165965]",
    valid: "border-[#8cbeb0] bg-[#e6f4ef] text-[#075e4c]",
    revoked: "border-[#d7aaa5] bg-[#f8eae7] text-[#8c2f27]",
    failure: "border-[#c7bfb3] bg-[#f1ede6] text-[#5d554b]"
  }[kind];

  return (
    <div className={`mx-auto flex size-20 items-center justify-center rounded-full border ${styles}`} aria-hidden="true">
      {kind === "loading" ? (
        <svg className="size-9 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none">
          <path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg className="size-10" viewBox="0 0 48 48" fill="none">
          <path d="M24 5.5 38 11v10.4c0 9.1-5.5 16.9-14 21.1-8.5-4.2-14-12-14-21.1V11L24 5.5Z" stroke="currentColor" strokeWidth="2" />
          {kind === "valid" && <path d="m17.5 24 4.3 4.3 9.2-9.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />}
          {kind === "revoked" && <path d="m19 19 10 10m0-10L19 29" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
          {kind === "failure" && <path d="M24 17v8m0 5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />}
          {kind === "neutral" && <path d="M18 19v-3h3m6 0h3v3m0 8v3h-3m-6 0h-3v-3m3-6h6v6h-6z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      )}
    </div>
  );
}

function CertificateDetails({ certificate }: Readonly<{ certificate: Extract<PublicVerificationData, { status: "valid" }> }>) {
  return (
    <dl className="mt-8 divide-y divide-[#e6e0d5] border-y border-[#d8d1c5] text-left">
      <div className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
        <dt className="text-sm font-medium text-[#687076]">เลขที่ใบประกาศ</dt>
        <dd className="break-words font-semibold text-[#17252a] sm:text-right">{certificate.certificate_number}</dd>
      </div>
      <div className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
        <dt className="text-sm font-medium text-[#687076]">ผู้ได้รับใบประกาศ</dt>
        <dd className="break-words font-semibold text-[#17252a] sm:text-right">{certificate.recipient_name}</dd>
      </div>
      <div className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
        <dt className="text-sm font-medium text-[#687076]">โครงการ / หลักสูตร</dt>
        <dd className="break-words font-semibold text-[#17252a] sm:text-right">{certificate.program_name}</dd>
      </div>
      <div className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
        <dt className="text-sm font-medium text-[#687076]">วันที่ออก</dt>
        <dd className="font-semibold text-[#17252a] sm:text-right">{thaiDate(certificate.issued_at)}</dd>
      </div>
    </dl>
  );
}

type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failure" }
  | { readonly kind: "too-broad" }
  | { readonly kind: "results"; readonly items: readonly PublicCertificateSearchResult[] };

type SearchDownloadState = "idle" | "working" | "complete" | "expired" | "unavailable";

const savePdf = async (downloadToken: string): Promise<void> => {
  const response = await postJson(downloadEndpoint, { download_token: downloadToken });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") {
    throw new Error("download failed");
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "certificate.pdf";
    anchor.click();
  } finally { URL.revokeObjectURL(objectUrl); }
};

function PublicSearchPanel() {
  const [mode, setMode] = useState<"search" | "qr">("search");
  const [recipientName, setRecipientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [trainingName, setTrainingName] = useState("");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [downloads, setDownloads] = useState<Readonly<Record<string, SearchDownloadState>>>({});
  const [formError, setFormError] = useState(false);
  const searchExpired = useRef(false);

  useEffect(() => {
    if (state.kind !== "results" || state.items.length === 0) return;
    searchExpired.current = false;
    const timeout = window.setTimeout(() => { searchExpired.current = true; }, 180_000);
    return () => window.clearTimeout(timeout);
  }, [state]);

  const search = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const exactNumber = certificateNumber.trim();
    const recipient = recipientName.trim().replace(/\s+/gu, " ");
    const project = projectName.trim().replace(/\s+/gu, " ");
    const training = trainingName.trim().replace(/\s+/gu, " ");
    const valid = exactNumber.length >= 3
      ? recipient.length === 0 && project.length === 0 && training.length === 0
      : recipient.length >= 4 && (project.length >= 3 || training.length >= 3);
    if (!valid) { setFormError(true); return; }
    setFormError(false);
    setDownloads({});
    setState({ kind: "loading" });
    try {
      const body = exactNumber.length >= 3 ? { certificate_number: exactNumber } : {
        recipient_name: recipient,
        ...(project.length === 0 ? {} : { project_name: project }),
        ...(training.length === 0 ? {} : { training_name: training })
      };
      const response = await postJson(searchEndpoint, body);
      if (!response.ok) throw new Error("search failed");
      const parsed = PublicCertificateSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("search failed");
      setState(parsed.data.data.too_broad ? { kind: "too-broad" }
        : { kind: "results", items: parsed.data.data.results });
    } catch { setState({ kind: "failure" }); }
  };

  const downloadSearchResult = async (item: PublicCertificateSearchResult): Promise<void> => {
    const key = item.search_result_token;
    setDownloads((current) => ({ ...current, [key]: "working" }));
    try {
      const response = await postJson(searchAuthorizeEndpoint, { search_result_token: key });
      if (!response.ok) throw new Error("authorization failed");
      const parsed = PublicSearchDownloadAuthorizationResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("authorization failed");
      await savePdf(parsed.data.data.download_token);
      setDownloads((current) => ({ ...current, [key]: "complete" }));
    } catch {
      setDownloads((current) => ({ ...current, [key]: searchExpired.current ? "expired" : "unavailable" }));
    }
  };

  return <div className="mt-1 text-left">
    <div className="grid grid-cols-2 rounded-xl bg-[#edf1ed] p-1" role="tablist" aria-label="วิธีค้นหาใบประกาศ">
      <button type="button" role="tab" aria-selected={mode === "search"} onClick={() => setMode("search")}
        className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition ${mode === "search" ? "bg-[#fffdf8] text-[#174f50] shadow-sm" : "text-[#657174] hover:text-[#243f42]"}`}>ค้นหาใบประกาศ</button>
      <button type="button" role="tab" aria-selected={mode === "qr"} onClick={() => setMode("qr")}
        className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition ${mode === "qr" ? "bg-[#fffdf8] text-[#174f50] shadow-sm" : "text-[#657174] hover:text-[#243f42]"}`}>ตรวจสอบด้วย QR</button>
    </div>

    {mode === "qr" ? <div className="py-10 text-center">
      <StatusMark kind="neutral" />
      <h1 id="verification-title" className="mt-5 text-2xl font-semibold text-[#172b2d] sm:text-3xl">สแกน QR บนใบประกาศ</h1>
      <p className="mx-auto mt-4 max-w-sm leading-7 text-[#667176]">หากมี QR บนใบประกาศ สามารถสแกนเพื่อตรวจสอบสถานะล่าสุดและดาวน์โหลดได้โดยตรง</p>
    </div> : <div className="pt-7">
      <p className="text-sm font-semibold text-[#276b70]">ค้นหาอย่างเป็นส่วนตัว</p>
      <h1 id="verification-title" className="mt-1 text-2xl font-semibold text-[#172b2d] sm:text-3xl">ค้นหาใบประกาศนียบัตร</h1>
      <p className="mt-3 text-sm leading-6 text-[#667176]">เพื่อคุ้มครองข้อมูลผู้รับใบประกาศ กรุณาระบุชื่อพร้อมโครงการหรือการอบรม</p>
      <form className="mt-6 space-y-4" onSubmit={(event) => void search(event)} noValidate>
        <div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="recipient-name">ชื่อผู้รับใบประกาศ</label><input id="recipient-name" value={recipientName} onChange={(event) => setRecipientName(event.target.value)} autoComplete="off" maxLength={200} disabled={certificateNumber.trim().length > 0} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 outline-none transition focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /></div>
        <div className="grid gap-4 sm:grid-cols-2"><div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="project-name">ชื่อโครงการ</label><input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} autoComplete="off" maxLength={200} disabled={certificateNumber.trim().length > 0} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 outline-none focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /></div><div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="training-name">ชื่อการอบรม</label><input id="training-name" value={trainingName} onChange={(event) => setTrainingName(event.target.value)} autoComplete="off" maxLength={200} disabled={certificateNumber.trim().length > 0} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 outline-none focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /></div></div>
        <div className="flex items-center gap-3 py-1 text-xs font-medium text-[#89908e]" aria-hidden="true"><span className="h-px flex-1 bg-[#e1e3df]" /><span>หรือค้นหาด้วยเลขที่</span><span className="h-px flex-1 bg-[#e1e3df]" /></div>
        <div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="certificate-number">เลขที่ใบประกาศ</label><input id="certificate-number" value={certificateNumber} onChange={(event) => setCertificateNumber(event.target.value)} autoComplete="off" maxLength={200} disabled={recipientName.trim().length > 0 || projectName.trim().length > 0 || trainingName.trim().length > 0} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 font-medium outline-none focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /></div>
        {formError && <p className="rounded-lg border border-[#e5c6bf] bg-[#fbf1ee] px-3 py-2 text-sm text-[#7c342d]" role="alert">กรุณาระบุเลขที่ใบประกาศ หรือชื่อผู้รับพร้อมชื่อโครงการหรือการอบรม</p>}
        <button type="submit" disabled={state.kind === "loading"} className="min-h-12 w-full rounded-xl bg-[#174f50] px-5 py-3 font-semibold text-white shadow-[0_8px_24px_rgba(23,79,80,.18)] transition hover:bg-[#103f40] disabled:cursor-wait disabled:opacity-65">{state.kind === "loading" ? "กำลังค้นหา…" : "ค้นหาใบประกาศ"}</button>
      </form>
      {state.kind === "failure" && <p className="mt-5 rounded-xl border border-[#e1c5bf] bg-[#fbf1ee] p-4 text-sm text-[#713a34]" role="alert">ไม่สามารถค้นหาได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง</p>}
      {state.kind === "too-broad" && <p className="mt-5 rounded-xl border border-[#ddcfaa] bg-[#fbf6e8] p-4 font-medium text-[#665326]" role="status">พบหลายรายการ กรุณาระบุข้อมูลเพิ่มเติม</p>}
      {state.kind === "results" && state.items.length === 0 && <p className="mt-5 rounded-xl border border-[#d9d9d2] bg-[#f4f3ef] p-5 text-center font-medium text-[#596164]" role="status">ไม่พบใบประกาศที่ตรงกับข้อมูล</p>}
      {state.kind === "results" && state.items.length > 0 && <div className="mt-7 space-y-4" aria-live="polite"><p className="text-sm font-semibold text-[#174f50]">ผลการค้นหา</p>{state.items.map((item) => { const downloadState = downloads[item.search_result_token] ?? "idle"; return <article key={item.search_result_token} className="rounded-2xl border border-[#d8ded9] bg-white p-5 shadow-[0_8px_26px_rgba(34,56,54,.06)]"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[#08705b]">พร้อมใช้งาน</p><h2 className="mt-1 text-lg font-semibold text-[#18383a]">{item.recipient_name}</h2></div><span className="rounded-full bg-[#e8f4ef] px-3 py-1 text-xs font-semibold text-[#08705b]">พร้อมใช้งาน</span></div><dl className="mt-4 grid gap-2 text-sm"><div><dt className="inline text-[#748083]">โครงการ: </dt><dd className="inline font-medium">{item.project_name}</dd></div><div><dt className="inline text-[#748083]">การอบรม: </dt><dd className="inline font-medium">{item.training_name}</dd></div><div><dt className="inline text-[#748083]">เลขที่ใบประกาศ: </dt><dd className="inline font-semibold">{item.certificate_number}</dd></div><div><dt className="inline text-[#748083]">วันที่ออก: </dt><dd className="inline font-medium">{thaiDate(item.issued_at)}</dd></div></dl><button type="button" disabled={downloadState === "working" || downloadState === "unavailable" || downloadState === "expired"} onClick={() => void downloadSearchResult(item)} className="mt-5 min-h-11 w-full rounded-xl border border-[#8fb0aa] bg-[#edf6f2] px-4 font-semibold text-[#174f50] transition hover:bg-[#dfeee8] disabled:cursor-not-allowed disabled:opacity-60">{downloadState === "working" ? "กำลังเตรียมไฟล์…" : "ดาวน์โหลดใบประกาศ"}</button>{downloadState === "complete" && <p className="mt-3 text-sm font-medium text-[#08705b]" role="status">เริ่มดาวน์โหลดใบประกาศแล้ว</p>}{downloadState === "expired" && <p className="mt-3 text-sm text-[#7c342d]" role="alert">ผลการค้นหาหมดอายุ กรุณาค้นหาใบประกาศอีกครั้ง</p>}{downloadState === "unavailable" && <p className="mt-3 text-sm text-[#7c342d]" role="alert">ไม่สามารถดาวน์โหลดใบประกาศนี้ได้ กรุณาค้นหาใหม่เพื่อตรวจสอบสถานะล่าสุด</p>}</article>; })}</div>}
      <p className="mt-6 text-center text-sm leading-6 text-[#667176]">หากมี QR บนใบประกาศ สามารถสแกนเพื่อตรวจสอบโดยตรง</p>
    </div>}
  </div>;
}

export function PublicVerificationClient() {
  const verificationToken = useRef<string | null>(null);
  const requestSequence = useRef(0);
  const [view, setView] = useState<ViewState>({ kind: "neutral" });
  const [downloadState, setDownloadState] = useState<DownloadState>("idle");

  const verify = useCallback(async (token: string): Promise<void> => {
    const sequence = ++requestSequence.current;
    setDownloadState("idle");
    setView({ kind: "loading" });
    try {
      const response = await postJson(verifyEndpoint, { token });
      if (!response.ok) throw new Error("verification failed");
      const parsed = PublicVerificationResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("verification failed");
      if (sequence === requestSequence.current) setView({ kind: "success", certificate: parsed.data.data });
    } catch {
      if (sequence === requestSequence.current) setView({ kind: "failure" });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const processFragment = (): void => {
      if (!active) return;
      const fragment = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
      const entries = [...fragment.entries()];
      const token = entries.length === 1 && entries[0]?.[0] === "token" ? entries[0][1] : undefined;
      window.history.replaceState(null, "", window.location.pathname);

      if (token === undefined) {
        verificationToken.current = null;
        ++requestSequence.current;
        setDownloadState("idle");
        setView(entries.length === 0 ? { kind: "neutral" } : { kind: "failure" });
        return;
      }
      if (token.length < 1 || token.length > 2_048) {
        verificationToken.current = null;
        ++requestSequence.current;
        setDownloadState("idle");
        setView({ kind: "failure" });
        return;
      }

      verificationToken.current = token;
      void verify(token);
    };

    queueMicrotask(processFragment);
    window.addEventListener("hashchange", processFragment);
    return () => {
      active = false;
      window.removeEventListener("hashchange", processFragment);
    };
  }, [verify]);

  const reverify = (): void => {
    const token = verificationToken.current;
    if (token !== null) void verify(token);
  };

  const download = async (): Promise<void> => {
    const token = verificationToken.current;
    if (token === null || view.kind !== "success" || view.certificate.status !== "valid") return;
    setDownloadState("working");
    try {
      const authorizationResponse = await postJson(authorizeEndpoint, { token });
      if (!authorizationResponse.ok) throw new Error("download authorization failed");
      const authorization = PublicDownloadAuthorizationResponseSchema.safeParse(await authorizationResponse.json());
      if (!authorization.success) throw new Error("download authorization failed");
      const response = await postJson(downloadEndpoint, { download_token: authorization.data.data.download_token });
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") throw new Error("download failed");
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = "certificate.pdf";
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      setDownloadState("complete");
    } catch {
      setDownloadState("failure");
    }
  };

  const statusKind = view.kind === "success" ? (view.certificate.status === "valid" ? "valid" : "revoked") : view.kind;

  return (
    <div className="min-h-dvh overflow-x-hidden bg-[#eef1ee]">
      <PublicHeader current="/verify" />
    <main className="relative isolate flex min-h-[calc(100dvh-4rem)] items-center justify-center overflow-hidden px-4 py-8 text-[#17252a] sm:px-8 sm:py-12">
      <div className="absolute inset-0 -z-10 opacity-70" aria-hidden="true" style={{ backgroundImage: "linear-gradient(rgba(25,73,74,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(25,73,74,.055) 1px, transparent 1px)", backgroundSize: "34px 34px" }} />
      <div className="absolute left-[-7rem] top-[-8rem] -z-10 size-72 rounded-full bg-[#d7e7e2] blur-3xl" aria-hidden="true" />
      <div className="absolute bottom-[-9rem] right-[-8rem] -z-10 size-80 rounded-full bg-[#e9dfca] blur-3xl" aria-hidden="true" />

      <section className="relative w-full max-w-[42rem] overflow-hidden rounded-[1.75rem] border border-white/80 bg-[#fffdf8] shadow-[0_24px_80px_rgba(25,42,43,0.12)]" aria-labelledby="verification-title">
        <div className="h-1.5 bg-[#174f50]" aria-hidden="true" />
        <div className="px-5 pb-7 pt-6 text-center sm:px-10 sm:pb-10 sm:pt-8">
          <header className="mb-8 flex items-center justify-center gap-3 border-b border-[#e9e3d8] pb-5 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full border border-[#91b4ae] bg-[#e6f1ed] text-sm font-semibold tracking-tight text-[#174f50]" aria-hidden="true">CP</span>
            <div><p className="font-semibold leading-tight text-[#1e3537]">ระบบตรวจสอบใบประกาศ</p><p className="mt-0.5 text-xs tracking-[0.08em] text-[#697478]">CERTIFICATE VERIFICATION</p></div>
          </header>

          {view.kind !== "neutral" && <StatusMark kind={statusKind} />}

          {view.kind === "neutral" && <SearchablePublicSearchPanel />}

          {view.kind === "loading" && <div className="mx-auto mt-5 max-w-md" role="status" aria-live="polite"><p className="text-sm font-semibold text-[#276b70]">กำลังตรวจสอบ</p><h1 id="verification-title" className="mt-2 text-2xl font-semibold leading-snug sm:text-3xl">กำลังยืนยันข้อมูลใบประกาศ</h1><p className="mt-4 text-[0.95rem] leading-7 text-[#667176]">โปรดรอสักครู่ ระบบกำลังตรวจสอบลายเซ็นและสถานะล่าสุด</p></div>}

          {view.kind === "failure" && <div className="mx-auto mt-5 max-w-md" role="alert"><p className="text-sm font-semibold text-[#625b52]">ไม่สามารถตรวจสอบได้</p><h1 id="verification-title" className="mt-2 text-2xl font-semibold leading-snug sm:text-3xl">ไม่สามารถยืนยันความถูกต้องของใบประกาศนี้ได้</h1><p className="mt-4 text-[0.95rem] leading-7 text-[#667176]">กรุณาสแกน QR จากใบประกาศอีกครั้ง หรือติดต่อผู้ออกใบประกาศหากปัญหายังคงอยู่</p></div>}

          {view.kind === "success" && view.certificate.status === "revoked" && <div className="mx-auto mt-5 max-w-md" role="status" aria-live="polite"><p className="text-sm font-semibold text-[#9a3c32]">ใบประกาศถูกเพิกถอน</p><h1 id="verification-title" className="mt-2 text-2xl font-semibold leading-snug text-[#542a26] sm:text-3xl">ใบประกาศนี้ถูกเพิกถอนแล้ว</h1><p className="mt-4 text-[0.95rem] leading-7 text-[#6d625f]">ใบประกาศนี้ไม่สามารถใช้ยืนยันคุณสมบัติได้ในปัจจุบัน</p><div className="mt-7 rounded-xl border border-[#e4c9c4] bg-[#fbf2ef] px-4 py-4 text-left"><p className="text-xs font-medium text-[#8b6862]">เลขที่ใบประกาศ</p><p className="mt-1 break-words font-semibold text-[#542a26]">{view.certificate.certificate_number}</p></div></div>}

          {view.kind === "success" && view.certificate.status === "valid" && (
            <div className="mt-5" role="status" aria-live="polite">
              <p className="text-sm font-semibold text-[#08705b]">ตรวจสอบสำเร็จ</p>
              <h1 id="verification-title" className="mt-2 text-2xl font-semibold leading-snug text-[#123f38] sm:text-3xl">ใบประกาศนี้ถูกต้องและใช้ยืนยันได้</h1>
              <p className="mx-auto mt-3 max-w-md text-[0.95rem] leading-7 text-[#667176]">ข้อมูลด้านล่างตรงกับบันทึกการออกใบประกาศและสถานะล่าสุด</p>
              <CertificateDetails certificate={view.certificate} />
              <div className="mt-7 grid gap-3 sm:grid-cols-[1fr_auto]">
                <button type="button" disabled={downloadState === "working"} onClick={() => void download()} className="min-h-12 rounded-xl bg-[#174f50] px-5 py-3 font-semibold text-white shadow-[0_8px_24px_rgba(23,79,80,.18)] transition hover:bg-[#103f40] disabled:cursor-wait disabled:opacity-65">{downloadState === "working" ? "กำลังเตรียมไฟล์…" : "ดาวน์โหลดใบประกาศ"}</button>
                <button type="button" disabled={downloadState === "working"} onClick={reverify} className="min-h-12 rounded-xl border border-[#b9c5c2] bg-transparent px-5 py-3 font-semibold text-[#28484a] transition hover:bg-[#edf4f1] disabled:opacity-60">ตรวจสอบอีกครั้ง</button>
              </div>
              {downloadState === "complete" && <p className="mt-4 text-sm font-medium text-[#08705b]" role="status">เริ่มดาวน์โหลดใบประกาศแล้ว</p>}
              {downloadState === "failure" && <div className="mt-4 rounded-xl border border-[#e1c5bf] bg-[#fbf1ee] p-4 text-left" role="alert"><p className="font-semibold text-[#7c342d]">ไม่สามารถดาวน์โหลดได้</p><p className="mt-1 text-sm leading-6 text-[#6d5d59]">สิทธิ์ดาวน์โหลดอาจหมดอายุหรือสถานะใบประกาศอาจเปลี่ยนแปลง โปรดตรวจสอบอีกครั้งก่อนดาวน์โหลด</p><button type="button" onClick={reverify} className="mt-3 min-h-11 font-semibold text-[#174f50] underline decoration-[#8cafaa] underline-offset-4">ตรวจสอบสถานะอีกครั้ง</button></div>}
            </div>
          )}

          <footer className="mt-8 border-t border-[#e9e3d8] pt-5 text-xs leading-5 text-[#788084]">หน้านี้ใช้สำหรับตรวจสอบใบประกาศสาธารณะ โดยไม่ต้องเข้าสู่ระบบ</footer>
        </div>
      </section>
    </main>
    </div>
  );
}
