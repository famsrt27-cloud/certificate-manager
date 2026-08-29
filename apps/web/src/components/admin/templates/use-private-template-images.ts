"use client";

import { useEffect, useMemo, useState } from "react";

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;
export type PrivateImageReference = { readonly id: string; readonly mimeType?: "image/png" | "image/jpeg" };

export function usePrivateTemplateImages(adminFetch: AdminFetch, templateId: string,
  references: readonly PrivateImageReference[], enabled = true) {
  const requestKey = useMemo(() => `${templateId}|${references.map((item) => `${item.id}:${item.mimeType ?? "image"}`).join("|")}`,
    [references, templateId]);
  const [state, setState] = useState<{ readonly key: string; readonly urls: ReadonlyMap<string, string>;
    readonly failed: ReadonlySet<string>; readonly loading: boolean }>({ key: "", urls: new Map(), failed: new Set(), loading: false });

  useEffect(() => {
    if (!enabled || references.length === 0) return;
    const controller = new AbortController(); const urls = new Map<string, string>(); const failed = new Set<string>();
    void Promise.all(references.map(async (reference) => {
      try {
        const response = await adminFetch(`/admin/templates/${templateId}/assets/${reference.id}/content`, { signal: controller.signal });
        if (!response.ok) throw new Error("image");
        const blob = await response.blob();
        if (reference.mimeType !== undefined && blob.type !== reference.mimeType) throw new Error("mime");
        if (blob.type !== "image/png" && blob.type !== "image/jpeg") throw new Error("mime");
        urls.set(reference.id, URL.createObjectURL(blob));
      } catch { if (!controller.signal.aborted) failed.add(reference.id); }
    })).then(() => { if (!controller.signal.aborted) setState({ key: requestKey, urls: new Map(urls), failed: new Set(failed), loading: false }); });
    return () => { controller.abort(); for (const url of urls.values()) URL.revokeObjectURL(url); };
  }, [adminFetch, enabled, references, requestKey, templateId]);

  if (!enabled || references.length === 0) return { key: requestKey, urls: new Map<string, string>(), failed: new Set<string>(), loading: false };
  return state.key === requestKey ? state : { key: requestKey, urls: new Map<string, string>(), failed: new Set<string>(), loading: true };
}
