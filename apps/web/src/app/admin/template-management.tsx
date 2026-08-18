"use client";

import {
  TemplateAssetListResponseSchema, TemplateAssetResponseSchema, TemplateDefinitionSchema, TemplateListResponseSchema,
  TemplatePreviewResponseSchema, TemplateResponseSchema, TemplateVersionListResponseSchema, TemplateVersionResponseSchema,
  type AuthenticationData, type Template, type TemplateAsset, type TemplateVersion
} from "@certificate-platform/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
type Membership = AuthenticationData["memberships"][number];
type Preview = ReturnType<typeof TemplatePreviewResponseSchema.parse>["data"];

const initialDefinition = JSON.stringify({
  format_version: 1,
  page: { width: 1123, height: 794, unit: "px" },
  elements: [{ type: "text", x: 161, y: 320, width: 800, height: 80, align: "center", color: "#000000",
    font: { family: "Noto Sans Thai", size: 42, weight: 700 }, binding: "recipient.display_name" }]
}, null, 2);

export function TemplateManagement({ membership, csrfToken }: { membership: Membership; csrfToken: string }) {
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [assets, setAssets] = useState<TemplateAsset[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [definitionText, setDefinitionText] = useState(initialDefinition);
  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedTemplate = templates.find((template) => template.id === templateId);
  const selectedVersion = versions.find((version) => version.id === versionId);

  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, {
    ...init, cache: "no-store", credentials: "same-origin", headers: {
      "X-Organization-ID": membership.organization.id,
      ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers
    }
  }), [csrfToken, membership.organization.id]);

  const refreshTemplates = useCallback(async () => {
    if (!permissions.has("template:read")) return;
    const response = await adminFetch("/admin/templates");
    const parsed = TemplateListResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error("templates");
    setTemplates(parsed.data.data);
    setTemplateId((current) => current || parsed.data.data[0]?.id || "");
  }, [adminFetch, permissions]);

  const refreshTemplateDetails = useCallback(async (activeTemplateId: string) => {
    if (activeTemplateId === "" || !permissions.has("template:read")) { setVersions([]); setAssets([]); return; }
    const [versionResponse, assetResponse] = await Promise.all([
      adminFetch(`/admin/templates/${activeTemplateId}/versions`), adminFetch(`/admin/templates/${activeTemplateId}/assets`)
    ]);
    const versionParsed = TemplateVersionListResponseSchema.safeParse(await versionResponse.json());
    const assetParsed = TemplateAssetListResponseSchema.safeParse(await assetResponse.json());
    if (!versionResponse.ok || !assetResponse.ok || !versionParsed.success || !assetParsed.success) throw new Error("template details");
    setVersions(versionParsed.data.data); setAssets(assetParsed.data.data);
    setVersionId((current) => versionParsed.data.data.some((version) => version.id === current)
      ? current : versionParsed.data.data[0]?.id || "");
  }, [adminFetch, permissions]);

  useEffect(() => { const timeout = window.setTimeout(() => void refreshTemplates().catch(() => setMessage("Unable to load templates.")), 0);
    return () => window.clearTimeout(timeout); }, [refreshTemplates]);
  useEffect(() => { const timeout = window.setTimeout(() => void refreshTemplateDetails(templateId)
    .catch(() => setMessage("Unable to load template versions and assets.")), 0); return () => window.clearTimeout(timeout); }, [refreshTemplateDetails, templateId]);

  const selectVersion = (nextVersionId: string) => {
    setVersionId(nextVersionId);
    const nextVersion = versions.find((version) => version.id === nextVersionId);
    if (nextVersion !== undefined) setDefinitionText(JSON.stringify(nextVersion.definition, null, 2));
    setPreview(null);
  };

  const parseDefinition = () => {
    try { return TemplateDefinitionSchema.safeParse(JSON.parse(definitionText)); } catch { return TemplateDefinitionSchema.safeParse(null); }
  };

  const run = async (operation: () => Promise<void>, failure: string) => {
    setPending(true); setMessage(null);
    try { await operation(); } catch { setMessage(failure); } finally { setPending(false); }
  };

  const createTemplate = (event: FormEvent) => {
    event.preventDefault(); void run(async () => {
      const response = await adminFetch("/admin/templates", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: templateName }) });
      const parsed = TemplateResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("create template");
      setTemplateName(""); setTemplateId(parsed.data.data.id); setMessage("Template created."); await refreshTemplates();
    }, "The template could not be created.");
  };

  const renameTemplate = () => void run(async () => {
    if (selectedTemplate === undefined) return;
    const name = window.prompt("Template name", selectedTemplate.name)?.trim();
    if (!name) return;
    const response = await adminFetch(`/admin/templates/${selectedTemplate.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!response.ok || !TemplateResponseSchema.safeParse(await response.json()).success) throw new Error("rename");
    setMessage("Template renamed."); await refreshTemplates();
  }, "The template could not be renamed.");

  const archiveCurrentTemplate = () => void run(async () => {
    if (selectedTemplate === undefined) return;
    const response = await adminFetch(`/admin/templates/${selectedTemplate.id}/archive`, { method: "POST" });
    if (!response.ok || !TemplateResponseSchema.safeParse(await response.json()).success) throw new Error("archive");
    setMessage("Template archived."); await refreshTemplates();
  }, "The template could not be archived.");

  const createDraft = () => void run(async () => {
    const definition = parseDefinition();
    if (!definition.success || templateId === "") { setMessage("The JSON template definition is invalid."); return; }
    const response = await adminFetch(`/admin/templates/${templateId}/versions`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: definition.data }) });
    const parsed = TemplateVersionResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error("draft");
    setVersionId(parsed.data.data.id); setDefinitionText(JSON.stringify(parsed.data.data.definition, null, 2));
    setMessage("Draft version created."); await refreshTemplateDetails(templateId);
  }, "The draft could not be created. Check asset references and definition values.");

  const saveDraft = () => void run(async () => {
    const definition = parseDefinition();
    if (!definition.success || selectedVersion?.status !== "DRAFT") { setMessage("Select a draft and provide a valid definition."); return; }
    const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: definition.data }) });
    const parsed = TemplateVersionResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error("save");
    setMessage("Draft saved."); setPreview(null); await refreshTemplateDetails(templateId);
  }, "Only a valid draft can be changed.");

  const previewDraft = () => void run(async () => {
    if (selectedVersion === undefined) return;
    const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}/preview`, { method: "POST" });
    const parsed = TemplatePreviewResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error("preview");
    setPreview(parsed.data.data); setMessage("Preview validation passed.");
  }, "Preview validation failed.");

  const changeVersionState = (action: "publish" | "archive") => void run(async () => {
    if (selectedVersion === undefined) return;
    const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}/${action}`, { method: "POST" });
    if (!response.ok || !TemplateVersionResponseSchema.safeParse(await response.json()).success) throw new Error(action);
    setMessage(action === "publish" ? "Template version published and locked." : "Published version archived.");
    await refreshTemplateDetails(templateId);
  }, `The version could not be ${action}d.`);

  const deleteDraft = () => void run(async () => {
    if (selectedVersion?.status !== "DRAFT") return;
    const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("delete");
    setMessage("Draft deleted."); setVersionId(""); await refreshTemplateDetails(templateId);
  }, "Only draft versions can be deleted.");

  const uploadAsset = (event: FormEvent) => {
    event.preventDefault(); void run(async () => {
      if (assetFile === null || templateId === "") return;
      const body = new FormData(); body.set("file", assetFile);
      const response = await adminFetch(`/admin/templates/${templateId}/assets`, { method: "POST", body });
      const parsed = TemplateAssetResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("asset");
      setAssetFile(null); setMessage("Asset validated and stored privately."); await refreshTemplateDetails(templateId);
    }, "The asset was rejected. Use a valid PNG, JPEG, TTF, or OTF within the configured limits.");
  };

  const archiveAsset = (assetId: string) => void run(async () => {
    const response = await adminFetch(`/admin/templates/${templateId}/assets/${assetId}/archive`, { method: "POST" });
    if (!response.ok || !TemplateAssetResponseSchema.safeParse(await response.json()).success) throw new Error("archive asset");
    setMessage("Asset archived."); await refreshTemplateDetails(templateId);
  }, "The asset cannot be archived while a published version depends on it.");

  const parsedDefinition = parseDefinition();
  if (!permissions.has("template:read")) return null;
  return <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="template-builder-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-semibold" id="template-builder-title">Template Builder</h2>
      <p className="text-sm text-slate-600">Versioned JSON templates; preview validates data only and never generates a PDF.</p></div>
      {permissions.has("template:create") && <form className="flex gap-2" onSubmit={createTemplate}><label className="sr-only" htmlFor="template-name">Template name</label>
        <input className="rounded border px-3 py-2" id="template-name" onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name" required value={templateName} />
        <button className="rounded bg-slate-950 px-4 py-2 text-white" disabled={pending} type="submit">Create</button></form>}</div>
    {message && <p aria-live="polite" className="rounded bg-slate-100 px-4 py-3">{message}</p>}
    <div className="flex flex-wrap gap-3"><label>Template<select className="ml-2 rounded border px-3 py-2" onChange={(event) => setTemplateId(event.target.value)} value={templateId}>
      <option value="">Select template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} ({template.status})</option>)}</select></label>
      {permissions.has("template:update") && selectedTemplate?.status !== "ARCHIVED" && <><button className="rounded border px-3 py-2" onClick={renameTemplate} type="button">Rename</button>
        <button className="rounded border border-red-300 px-3 py-2 text-red-800" onClick={archiveCurrentTemplate} type="button">Archive template</button></>}</div>
    {templateId && <div className="grid gap-4 xl:grid-cols-[180px_1fr_260px]">
      <aside className="space-y-4"><div><h3 className="font-semibold">Elements</h3><p className="mt-1 text-sm text-slate-600">Text · Dynamic text · Image · QR · Signature · Shape</p></div>
        <div><h3 className="font-semibold">Layers</h3><ol className="mt-1 list-inside list-decimal text-sm">{(parsedDefinition.success ? parsedDefinition.data.elements : []).map((element, index) => <li key={index}>{element.type}</li>)}</ol></div></aside>
      <div className="space-y-3"><h3 className="font-semibold">Properties / JSON definition</h3><textarea aria-label="Template JSON definition" className="min-h-96 w-full rounded border p-3 font-mono text-xs disabled:bg-slate-100"
        disabled={selectedVersion !== undefined && selectedVersion.status !== "DRAFT"}
        onChange={(event) => { setDefinitionText(event.target.value); setPreview(null); }} spellCheck={false} value={definitionText} />
        <div className="flex flex-wrap gap-2">{permissions.has("template:create") && <button className="rounded bg-slate-900 px-3 py-2 text-white" disabled={pending} onClick={createDraft} type="button">New draft</button>}
          {permissions.has("template:update") && selectedVersion?.status === "DRAFT" && <><button className="rounded border px-3 py-2" disabled={pending} onClick={saveDraft} type="button">Save draft</button>
            <button className="rounded border border-red-300 px-3 py-2 text-red-800" disabled={pending} onClick={deleteDraft} type="button">Delete draft</button></>}</div></div>
      <aside className="space-y-5"><div><h3 className="font-semibold">Version</h3><select className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => selectVersion(event.target.value)} value={versionId}>
        <option value="">Select version</option>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {version.status}</option>)}</select>
        {selectedVersion && <div className="mt-2 flex flex-wrap gap-2"><button className="rounded border px-3 py-2" disabled={pending} onClick={previewDraft} type="button">Preview</button>
          {permissions.has("template:publish") && selectedVersion.status === "DRAFT" && <button className="rounded bg-emerald-700 px-3 py-2 text-white" disabled={pending || preview === null} onClick={() => changeVersionState("publish")} type="button">Publish</button>}
          {permissions.has("template:publish") && selectedVersion.status === "PUBLISHED" && <button className="rounded border px-3 py-2" disabled={pending} onClick={() => changeVersionState("archive")} type="button">Archive version</button>}</div>}</div>
        <div><h3 className="font-semibold">Assets</h3>{permissions.has("template:asset:create") && <form className="mt-2 space-y-2" onSubmit={uploadAsset}><input accept=".png,.jpg,.jpeg,.ttf,.otf,image/png,image/jpeg,font/ttf,font/otf" aria-label="Template asset" onChange={(event) => setAssetFile(event.target.files?.[0] ?? null)} required type="file" />
          <button className="rounded border px-3 py-2" disabled={pending} type="submit">Upload and validate</button></form>}
          <ul className="mt-2 space-y-2 break-all text-xs">{assets.map((asset) => <li key={asset.id}>{asset.original_filename} · {asset.status}<br />{asset.id}
            {permissions.has("template:asset:create") && asset.status === "ACTIVE" && <button className="ml-2 underline" onClick={() => archiveAsset(asset.id)} type="button">Archive</button>}</li>)}</ul></div></aside>
    </div>}
    {preview && <div><h3 className="font-semibold">Preview</h3><div className="relative mt-2 max-w-full overflow-hidden rounded border bg-white" style={{ aspectRatio: `${preview.definition.page.width}/${preview.definition.page.height}` }}>
      {preview.definition.elements.map((element, index) => <div className="absolute overflow-hidden" key={index} style={{ left: `${element.x / preview.definition.page.width * 100}%`, top: `${element.y / preview.definition.page.height * 100}%`,
        width: `${element.width / preview.definition.page.width * 100}%`, height: `${element.height / preview.definition.page.height * 100}%`, opacity: element.opacity,
        color: "color" in element ? element.color : undefined, textAlign: element.type === "text" ? element.align : undefined }}>
        {element.type === "text" || element.type === "qr" ? preview.bound_elements.find((bound) => bound.index === index)?.value : `[${element.type}]`}</div>)}</div></div>}
  </section>;
}
