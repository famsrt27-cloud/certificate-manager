"use client";

import {
  PublicCertificateSearchResponseSchema,
  PublicCertificateSuggestionResponseSchema,
  PublicSearchDownloadAuthorizationResponseSchema,
  type PublicCertificateSearchResult
} from "@certificate-platform/contracts";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

const searchEndpoint = "/api/public/certificates/search";
const projectSuggestionsEndpoint = "/api/public/certificates/project-suggestions";
const trainingSuggestionsEndpoint = "/api/public/certificates/training-suggestions";
const searchAuthorizeEndpoint = "/api/public/certificates/search-download-authorize";
const downloadEndpoint = "/api/public/certificates/download";

const postJson = (url: string, body: object, signal?: AbortSignal): Promise<Response> => fetch(url, {
  method: "POST", credentials: "omit", cache: "no-store", ...(signal === undefined ? {} : { signal }),
  headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

const thaiDate = (value: string): string => new Intl.DateTimeFormat("th-TH", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
}).format(new Date(`${value}T00:00:00Z`));

const SUGGESTION_DEBOUNCE_MS = 400;
const SUGGESTION_CACHE_LIMIT = 20;

type SuggestionState = "idle" | "loading" | "ready" | "rate-limited" | "error";
type SuggestionKind = "project" | "training";

const retryAfterMilliseconds = (value: string | null): number => {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(1_000, date - Date.now());
};

function SearchableCombobox({ disabled = false, kind, label, onChange, onSelect, placeholder, projectName,
  selectedValue, value }: Readonly<{
  disabled?: boolean;
  kind: SuggestionKind;
  label: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  placeholder: string;
  projectName?: string | null;
  selectedValue: string | null;
  value: string;
}>) {
  const inputId = useId();
  const listboxId = useId();
  const [state, setState] = useState<SuggestionState>("idle");
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const cache = useRef(new Map<string, readonly string[]>());
  const requestGeneration = useRef(0);
  const blockedUntil = useRef(0);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const normalizedProject = projectName?.normalize("NFKC").trim().replace(/\s+/gu, " ") ?? "";

  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (disabled || selectedValue?.normalize("NFKC").trim().replace(/\s+/gu, " ") === normalized
      || normalized.length < 2) {
      return;
    }
    const cacheKey = `${kind}:${normalizedProject}:${normalized}`;
    const cached = cache.current.get(cacheKey);
    if (cached !== undefined) {
      cache.current.delete(cacheKey); cache.current.set(cacheKey, cached);
      const timeout = window.setTimeout(() => {
        if (generation !== requestGeneration.current) return;
        setSuggestions(cached); setState("ready"); setOpen(true); setActiveIndex(-1);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    if (Date.now() < blockedUntil.current) {
      const timeout = window.setTimeout(() => {
        if (generation !== requestGeneration.current) return;
        setSuggestions([]); setState("rate-limited"); setOpen(true); setActiveIndex(-1);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setState("loading"); setOpen(true);
      const endpoint = kind === "project" ? projectSuggestionsEndpoint : trainingSuggestionsEndpoint;
      const body = kind === "project" ? { query: normalized } : {
        query: normalized, ...(normalizedProject.length === 0 ? {} : { project_name: normalizedProject })
      };
      void postJson(endpoint, body, controller.signal)
        .then(async (response) => {
          if (response.status === 429) {
            blockedUntil.current = Date.now() + retryAfterMilliseconds(response.headers.get("retry-after"));
            if (generation === requestGeneration.current) {
              setSuggestions([]); setState("rate-limited"); setOpen(true); setActiveIndex(-1);
            }
            return;
          }
          const parsed = PublicCertificateSuggestionResponseSchema.safeParse(await response.json());
          if (!response.ok || !parsed.success) throw new Error("suggestions unavailable");
          if (generation !== requestGeneration.current) return;
          const nextSuggestions = parsed.data.data.suggestions.map((item) => item.label);
          cache.current.set(cacheKey, nextSuggestions);
          if (cache.current.size > SUGGESTION_CACHE_LIMIT) {
            const oldest = cache.current.keys().next().value;
            if (oldest !== undefined) cache.current.delete(oldest);
          }
          setSuggestions(nextSuggestions);
          setState("ready"); setActiveIndex(-1);
        })
        .catch((reason: unknown) => {
          if (generation === requestGeneration.current
            && !(reason instanceof DOMException && reason.name === "AbortError")) {
            setSuggestions([]); setState("error"); setOpen(true);
          }
        });
    }, SUGGESTION_DEBOUNCE_MS);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [disabled, kind, normalized, normalizedProject, selectedValue]);

  const choose = (suggestion: string) => {
    onSelect(suggestion); setSuggestions([]); setState("idle"); setOpen(false); setActiveIndex(-1);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % suggestions.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1); }
    if (event.key === "Enter" && activeIndex >= 0) { event.preventDefault(); choose(suggestions[activeIndex]!); }
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
  };

  return <div className="relative">
    <label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor={inputId}>{label}</label>
    <input id={inputId} role="combobox" aria-autocomplete="list" aria-controls={listboxId}
      aria-expanded={open} aria-activedescendant={activeIndex < 0 ? undefined : `${listboxId}-${activeIndex}`}
      autoComplete="off" disabled={disabled} maxLength={200} placeholder={placeholder} value={value}
      onBlur={() => setOpen(false)} onChange={(event) => {
        setSuggestions([]); setState("idle"); setActiveIndex(-1); onChange(event.target.value); setOpen(true);
      }}
      onFocus={() => { if (normalized.length >= 2 && selectedValue !== value) setOpen(true); }} onKeyDown={handleKeyDown}
      className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 pr-10 outline-none transition placeholder:text-[#929b97] focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:cursor-not-allowed disabled:bg-[#f0f1ee]" />
    <span className="pointer-events-none absolute bottom-4 right-4 text-[#60726e]" aria-hidden="true">⌄</span>
    <div className="sr-only" role="status" aria-live="polite">{state === "loading" ? `กำลังค้นหา${label}` : state === "ready" ? `พบ ${suggestions.length} รายการ` : state === "rate-limited" ? "ค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" : state === "error" ? `ไม่สามารถค้นหา${label}ได้` : ""}</div>
    {open && !disabled && normalized.length >= 2 ? <div id={listboxId} role="listbox" className="absolute z-30 mt-2 max-h-60 w-full overflow-auto rounded-xl border border-[#cbd4cf] bg-white p-1.5 shadow-[0_16px_36px_rgba(31,54,48,.14)]">
      {state === "loading" ? <p className="px-3 py-3 text-sm text-[#65716d]">กำลังค้นหา…</p> : null}
      {state === "ready" && suggestions.length === 0 ? <p className="px-3 py-3 text-sm text-[#65716d]">ไม่พบ{label}ที่ตรงกับคำค้น</p> : null}
      {state === "rate-limited" ? <p className="px-3 py-3 text-sm text-[#7c342d]">ค้นหาบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่</p> : null}
      {state === "error" ? <p className="px-3 py-3 text-sm text-[#7c342d]">ไม่สามารถค้นหา{label}ได้ กรุณาลองอีกครั้ง</p> : null}
      {suggestions.map((suggestion, index) => <button id={`${listboxId}-${index}`} key={suggestion} role="option"
        aria-selected={activeIndex === index} type="button" onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(suggestion)}
        className={`block min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm ${activeIndex === index ? "bg-[#e6f0eb] text-[#174f46]" : "text-[#2b4540] hover:bg-[#f2f5f2]"}`}>{suggestion}</button>)}
    </div> : null}
    {selectedValue !== null ? <p className="mt-1.5 text-xs font-medium text-[#1b6b59]">เลือกแล้ว: {selectedValue}</p>
      : <p className="mt-1.5 text-xs text-[#75807c]">พิมพ์อย่างน้อย 2 ตัวอักษร แล้วเลือกรายการ</p>}
  </div>;
}

type SearchState = "idle" | "loading" | "failure" | "too-broad" | "results";
type SearchDownloadState = "idle" | "working" | "complete" | "expired" | "unavailable";

export function SearchablePublicSearchPanel() {
  const [mode, setMode] = useState<"search" | "qr">("search");
  const [recipientName, setRecipientName] = useState("");
  const [projectInput, setProjectInput] = useState("");
  const [projectName, setProjectName] = useState<string | null>(null);
  const [trainingInput, setTrainingInput] = useState("");
  const [trainingName, setTrainingName] = useState<string | null>(null);
  const [certificateNumber, setCertificateNumber] = useState("");
  const [state, setState] = useState<SearchState>("idle");
  const [items, setItems] = useState<readonly PublicCertificateSearchResult[]>([]);
  const [downloads, setDownloads] = useState<Readonly<Record<string, SearchDownloadState>>>({});
  const [formError, setFormError] = useState(false);
  const searchExpired = useRef(false);
  const exactMode = certificateNumber.trim().length > 0;
  const contextMode = recipientName.trim().length > 0 || projectInput.length > 0 || trainingInput.length > 0;

  useEffect(() => {
    if (state !== "results" || items.length === 0) return;
    searchExpired.current = false;
    const timeout = window.setTimeout(() => { searchExpired.current = true; }, 180_000);
    return () => window.clearTimeout(timeout);
  }, [items.length, state]);

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const recipient = recipientName.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const exactNumber = certificateNumber.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!(exactNumber.length >= 3 || (recipient.length >= 4 && (projectName !== null || trainingName !== null)))) {
      setFormError(true); return;
    }
    setFormError(false); setState("loading"); setItems([]); setDownloads({});
    try {
      const body = exactNumber.length >= 3 ? { certificate_number: exactNumber } : {
        recipient_name: recipient, ...(projectName === null ? {} : { project_name: projectName }),
        ...(trainingName === null ? {} : { training_name: trainingName })
      };
      const response = await postJson(searchEndpoint, body);
      const parsed = PublicCertificateSearchResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("search failed");
      setItems(parsed.data.data.results);
      setState(parsed.data.data.too_broad ? "too-broad" : "results");
    } catch { setState("failure"); }
  };

  const download = async (item: PublicCertificateSearchResult) => {
    const key = item.search_result_token;
    setDownloads((current) => ({ ...current, [key]: "working" }));
    try {
      const authorization = await postJson(searchAuthorizeEndpoint, { search_result_token: key });
      const parsed = PublicSearchDownloadAuthorizationResponseSchema.safeParse(await authorization.json());
      if (!authorization.ok || !parsed.success) throw new Error("authorization failed");
      const response = await postJson(downloadEndpoint, { download_token: parsed.data.data.download_token });
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") throw new Error("download failed");
      const objectUrl = URL.createObjectURL(await response.blob());
      try { const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = "certificate.pdf"; anchor.click(); }
      finally { URL.revokeObjectURL(objectUrl); }
      setDownloads((current) => ({ ...current, [key]: "complete" }));
    } catch { setDownloads((current) => ({ ...current, [key]: searchExpired.current ? "expired" : "unavailable" })); }
  };

  return <div className="mt-1 text-left">
    <div className="grid grid-cols-2 rounded-xl bg-[#edf1ed] p-1" role="tablist" aria-label="วิธีตรวจสอบใบประกาศ">
      <button type="button" role="tab" aria-selected={mode === "search"} onClick={() => setMode("search")} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${mode === "search" ? "bg-[#fffdf8] text-[#174f50] shadow-sm" : "text-[#657174]"}`}>ค้นหาใบประกาศ</button>
      <button type="button" role="tab" aria-selected={mode === "qr"} onClick={() => setMode("qr")} className={`min-h-11 rounded-lg px-3 text-sm font-semibold ${mode === "qr" ? "bg-[#fffdf8] text-[#174f50] shadow-sm" : "text-[#657174]"}`}>ตรวจสอบด้วย QR</button>
    </div>
    {mode === "qr" ? <div className="py-10 text-center"><svg className="mx-auto size-20 text-[#174f50]" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 8h12v12H8V8Zm20 0h12v12H28V8ZM8 28h12v12H8V28Zm22 0h4v4h-4v-4Zm6 0h4v8h-4v-8Zm-6 8h4v4h-4v-4Zm6 2h4v2h-4v-2Z" stroke="currentColor" strokeWidth="2" /></svg><h1 id="verification-title" className="mt-5 text-2xl font-semibold text-[#172b2d] sm:text-3xl">ตรวจสอบด้วย QR</h1><p className="mx-auto mt-4 max-w-sm leading-7 text-[#667176]">สแกน QR บนใบประกาศด้วยกล้องของอุปกรณ์ แล้วระบบจะเปิดผลการตรวจสอบทันที</p></div> : <div className="pt-7">
      <p className="text-sm font-semibold text-[#a0783c]">ค้นหาใบประกาศ</p>
      <h1 id="verification-title" className="mt-1 text-2xl font-semibold text-[#172b2d] sm:text-3xl">ค้นหาและดาวน์โหลดใบประกาศ</h1>
      <p className="mt-3 text-sm leading-6 text-[#667176]">กรอกชื่อผู้รับพร้อมเลือกโครงการหรือการอบรม</p>
      <form className="mt-6 space-y-4" onSubmit={(event) => void search(event)} noValidate>
        <div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="recipient-name">ชื่อผู้รับใบประกาศ</label><input id="recipient-name" value={recipientName} onChange={(event) => setRecipientName(event.target.value)} autoComplete="name" maxLength={200} disabled={exactMode} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 outline-none transition focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /><p className="mt-1.5 text-xs text-[#75807c]">กรอกชื่อด้วยตนเอง ระบบจะไม่แนะนำชื่อผู้รับ</p></div>
        <SearchableCombobox kind="project" label="โครงการ" placeholder="พิมพ์ชื่อโครงการ" disabled={exactMode}
          value={projectInput} selectedValue={projectName}
          onChange={(value) => { setProjectInput(value); setProjectName(null); setTrainingInput(""); setTrainingName(null); }}
          onSelect={(value) => { setProjectInput(value); setProjectName(value); setTrainingInput(""); setTrainingName(null); }} />
        <SearchableCombobox kind="training" label="การอบรม" placeholder="พิมพ์ชื่อการอบรม" projectName={projectName}
          disabled={exactMode} value={trainingInput} selectedValue={trainingName}
          onChange={(value) => { setTrainingInput(value); setTrainingName(null); }}
          onSelect={(value) => { setTrainingInput(value); setTrainingName(value); }} />
        <div className="flex items-center gap-3 py-1 text-xs font-medium text-[#89908e]" aria-hidden="true"><span className="h-px flex-1 bg-[#e1e3df]" /><span>หรือค้นหาด้วยเลขที่</span><span className="h-px flex-1 bg-[#e1e3df]" /></div>
        <div><label className="mb-1.5 block text-sm font-semibold text-[#34494b]" htmlFor="certificate-number">เลขที่ใบประกาศ</label><input id="certificate-number" value={certificateNumber} onChange={(event) => setCertificateNumber(event.target.value)} autoComplete="off" maxLength={200} disabled={contextMode} className="min-h-12 w-full rounded-xl border border-[#c9d0cc] bg-white px-4 font-medium outline-none focus:border-[#427d7d] focus:ring-3 focus:ring-[#b8d5ce]/50 disabled:bg-[#f0f1ee]" /></div>
        {formError ? <p className="rounded-lg border border-[#e5c6bf] bg-[#fbf1ee] px-3 py-2 text-sm text-[#7c342d]" role="alert">กรุณากรอกเลขที่ใบประกาศ หรือกรอกชื่อผู้รับและเลือกโครงการหรือการอบรม</p> : null}
        <button type="submit" disabled={state === "loading"} className="min-h-12 w-full rounded-xl bg-[#174f50] px-5 py-3 font-semibold text-white shadow-[0_8px_24px_rgba(23,79,80,.18)] transition hover:bg-[#103f40] disabled:cursor-wait disabled:opacity-65">{state === "loading" ? "กำลังค้นหา…" : "ค้นหาใบประกาศ"}</button>
      </form>
      {state === "failure" ? <p className="mt-5 rounded-xl border border-[#e1c5bf] bg-[#fbf1ee] p-4 text-sm text-[#713a34]" role="alert">ไม่สามารถค้นหาได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง</p> : null}
      {state === "too-broad" ? <p className="mt-5 rounded-xl border border-[#ddcfaa] bg-[#fbf6e8] p-4 font-medium text-[#665326]" role="status">พบหลายรายการ กรุณาระบุข้อมูลเพิ่มเติม</p> : null}
      {state === "results" && items.length === 0 ? <p className="mt-5 rounded-xl border border-[#d9d9d2] bg-[#f4f3ef] p-5 text-center font-medium text-[#596164]" role="status">ไม่พบใบประกาศที่ตรงกับข้อมูล</p> : null}
      {state === "results" && items.length > 0 ? <div className="mt-7 space-y-4" aria-live="polite"><p className="text-sm font-semibold text-[#174f50]">ผลการค้นหา</p>{items.map((item) => { const downloadState = downloads[item.search_result_token] ?? "idle"; return <article key={item.search_result_token} className="rounded-2xl border border-[#d8ded9] bg-white p-5 shadow-[0_8px_26px_rgba(34,56,54,.06)]"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[#08705b]">พร้อมใช้งาน</p><h2 className="mt-1 text-lg font-semibold text-[#18383a]">{item.recipient_name}</h2></div><span className="rounded-full bg-[#e8f4ef] px-3 py-1 text-xs font-semibold text-[#08705b]">พร้อมใช้งาน</span></div><dl className="mt-4 grid gap-2 text-sm"><div><dt className="inline text-[#748083]">โครงการ: </dt><dd className="inline font-medium">{item.project_name}</dd></div><div><dt className="inline text-[#748083]">การอบรม: </dt><dd className="inline font-medium">{item.training_name}</dd></div><div><dt className="inline text-[#748083]">เลขที่ใบประกาศ: </dt><dd className="inline font-semibold">{item.certificate_number}</dd></div><div><dt className="inline text-[#748083]">วันที่ออก: </dt><dd className="inline font-medium">{thaiDate(item.issued_at)}</dd></div></dl><button type="button" disabled={downloadState === "working" || downloadState === "unavailable" || downloadState === "expired"} onClick={() => void download(item)} className="mt-5 min-h-11 w-full rounded-xl border border-[#8fb0aa] bg-[#edf6f2] px-4 font-semibold text-[#174f50] transition hover:bg-[#dfeee8] disabled:cursor-not-allowed disabled:opacity-60">{downloadState === "working" ? "กำลังเตรียมไฟล์…" : "ดาวน์โหลดใบประกาศ"}</button>{downloadState === "complete" ? <p className="mt-3 text-sm font-medium text-[#08705b]" role="status">เริ่มดาวน์โหลดใบประกาศแล้ว</p> : null}{downloadState === "expired" ? <p className="mt-3 text-sm text-[#7c342d]" role="alert">ผลการค้นหาหมดอายุ กรุณาค้นหาใบประกาศอีกครั้ง</p> : null}{downloadState === "unavailable" ? <p className="mt-3 text-sm text-[#7c342d]" role="alert">ไม่สามารถดาวน์โหลดใบประกาศนี้ได้ กรุณาค้นหาใหม่เพื่อตรวจสอบสถานะล่าสุด</p> : null}</article>; })}</div> : null}
    </div>}
  </div>;
}
