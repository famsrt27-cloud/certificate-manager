"use client";

import {
  PublicDownloadAuthorizationResponseSchema,
  PublicVerificationResponseSchema,
  type PublicVerificationData
} from "@certificate-platform/contracts";
import { useEffect, useRef, useState } from "react";

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "failure" }
  | { readonly kind: "success"; readonly certificate: PublicVerificationData };

const verifyEndpoint = "/api/public/verify";
const authorizeEndpoint = "/api/public/certificates/download-authorize";
const downloadEndpoint = "/api/public/certificates/download";

const postJson = (url: string, body: object): Promise<Response> => fetch(url, {
  method: "POST",
  credentials: "omit",
  cache: "no-store",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export function PublicVerificationClient() {
  const verificationToken = useRef<string | null>(null);
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [downloadState, setDownloadState] = useState<"idle" | "working" | "failure">("idle");

  useEffect(() => {
    let active = true;
    const processFragment = (): void => {
      const fragment = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
      const entries = [...fragment.entries()];
      const token = entries.length === 1 && entries[0]?.[0] === "token" ? entries[0][1] : undefined;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      if (token === undefined || token.length < 1 || token.length > 2_048) {
        verificationToken.current = null;
        setView({ kind: "failure" });
        return;
      }
      verificationToken.current = token;
      setView({ kind: "loading" });
      void postJson(verifyEndpoint, { token }).then(async (response) => {
        if (!response.ok) throw new Error("verification failed");
        const parsed = PublicVerificationResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("verification failed");
        if (active) setView({ kind: "success", certificate: parsed.data.data });
      }).catch(() => {
        if (active) setView({ kind: "failure" });
      });
    };
    queueMicrotask(() => {
      if (active) processFragment();
    });
    window.addEventListener("hashchange", processFragment);
    return () => {
      active = false;
      window.removeEventListener("hashchange", processFragment);
    };
  }, []);

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
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") {
        throw new Error("download failed");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = "certificate.pdf";
        anchor.click();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      setDownloadState("idle");
    } catch {
      setDownloadState("failure");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12">
      <section className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm" aria-live="polite">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Certificate Platform</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-950">Certificate verification</h1>
        {view.kind === "loading" && <p className="mt-6 text-slate-600">Verifying certificate…</p>}
        {view.kind === "failure" && (
          <p className="mt-6 rounded-lg bg-slate-100 p-4 text-slate-800">The certificate could not be verified.</p>
        )}
        {view.kind === "success" && view.certificate.status === "revoked" && (
          <div className="mt-6 space-y-2">
            <p className="font-semibold text-red-700">Certificate revoked</p>
            <p className="text-slate-700">Certificate number: {view.certificate.certificate_number}</p>
          </div>
        )}
        {view.kind === "success" && view.certificate.status === "valid" && (
          <div className="mt-6 space-y-3">
            <p className="font-semibold text-emerald-700">Valid certificate</p>
            <dl className="grid gap-3 text-slate-700 sm:grid-cols-2">
              <div><dt className="text-sm text-slate-500">Certificate number</dt><dd>{view.certificate.certificate_number}</dd></div>
              <div><dt className="text-sm text-slate-500">Issued</dt><dd>{view.certificate.issued_at}</dd></div>
              <div><dt className="text-sm text-slate-500">Recipient</dt><dd>{view.certificate.recipient_name}</dd></div>
              <div><dt className="text-sm text-slate-500">Program</dt><dd>{view.certificate.program_name}</dd></div>
            </dl>
            <button type="button" disabled={downloadState === "working"} onClick={() => void download()}
              className="mt-4 rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50">
              {downloadState === "working" ? "Preparing download…" : "Download certificate PDF"}
            </button>
            {downloadState === "failure" && <p className="text-sm text-red-700">The download could not be completed.</p>}
          </div>
        )}
      </section>
    </main>
  );
}
