"use client";

import {
  CreateTemplateRequestSchema, DeleteDraftVersionResponseSchema, DuplicateTemplateRequestSchema, DuplicateTemplateResponseSchema,
  TemplateAssetListResponseSchema, TemplateAssetResponseSchema,
  TemplateDefinitionSchema, TemplatePreviewResponseSchema, TemplateResponseSchema, TemplateVersionListResponseSchema,
  TemplateVersionResponseSchema, PAGE_PRESETS, describeLogicalPage, pageForCustomMillimeters, pageForPreset,
  type AuthenticationData, type PageOrientation, type PagePresetId, type Template, type TemplateAsset, type TemplateVersion
} from "@certificate-platform/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { AdminPageHeader } from "../admin-page-header";
import { Dialog, Feedback, Field, LoadError, LoadingRows, StatusBadge, selectClassName } from "../resource-ui";
import { TemplateCanvas } from "./template-canvas";
import { TemplateAssetPicker, type AssetPickerKind } from "./template-asset-picker";
import {
  assetStatusPresentation, assetTypeLabel, cloneDefinition, defaultDefinition, elementLabel, formatBytes,
  versionPresentation, type TemplateBinding, type TemplateDefinition, type TemplateElement
} from "./template-model";
import { TemplateProperties } from "./template-properties";
import { usePrivateTemplateImages } from "./use-private-template-images";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const childPageSize = 100;
const maximumChildPages = 100;
type Membership = AuthenticationData["memberships"][number];
type Preview = ReturnType<typeof TemplatePreviewResponseSchema.parse>["data"];
type FeedbackState = { readonly kind: "success" | "error"; readonly message: string } | null;
type MobilePanel = "layers" | "design" | "properties" | "assets";
type ConfirmState = "archive-template" | "delete-draft" | "publish" | "archive-version" | null;
type DiscardTarget = { type: "version"; id: string } | { type: "library" } | null;
type PendingPage = TemplateDefinition["page"] | null;

const isTextEditingTarget = (target: EventTarget | null): boolean => target instanceof HTMLElement
  && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable
    || target.closest("[contenteditable='true'], [role='textbox']") !== null);
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const VersionBadge = ({ status }: { readonly status: TemplateVersion["status"] }) => { const item = versionPresentation[status]; return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${item.className}`}>{item.label}</span>; };
const AssetBadge = ({ status }: { readonly status: TemplateAsset["status"] }) => { const item = assetStatusPresentation[status]; return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${item.className}`}>{item.label}</span>; };
const formatPublishedAt = (value: string | null): string | null => value === null ? null : new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const isFullPageBackground = (element: TemplateElement, definition: TemplateDefinition): element is Extract<TemplateElement, { type: "image" }> =>
  element.type === "image" && element.x === 0 && element.y === 0
  && element.width === definition.page.width && element.height === definition.page.height;

export function TemplateWorkspace({ csrfToken, membership, templateId }: { readonly csrfToken: string; readonly membership: Membership; readonly templateId: string }) {
  const router = useRouter(); const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);
  const [template, setTemplate] = useState<Template | null>(null); const [versions, setVersions] = useState<TemplateVersion[]>([]); const [assets, setAssets] = useState<TemplateAsset[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState(""); const [definition, setDefinition] = useState<TemplateDefinition | null>(null); const [savedDefinition, setSavedDefinition] = useState<TemplateDefinition | null>(null); const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [elementKeys, setElementKeys] = useState<string[]>([]); const elementKeySequence = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(false); const [pending, setPending] = useState(false); const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [clonePending, setClonePending] = useState(false); const cloneInFlight = useRef(false);
  const [refreshKey, setRefreshKey] = useState(0); const [mobilePanel, setMobilePanel] = useState<MobilePanel>("design"); const [confirm, setConfirm] = useState<ConfirmState>(null); const [discardTarget, setDiscardTarget] = useState<DiscardTarget>(null);
  const [renameOpen, setRenameOpen] = useState(false); const [renameValue, setRenameValue] = useState("");
  const [duplicateOpen, setDuplicateOpen] = useState(false); const [duplicateName, setDuplicateName] = useState("");
  const duplicateInFlight = useRef(false); const duplicateRequestSequence = useRef(0);
  const [uploadOpen, setUploadOpen] = useState(false); const [assetFile, setAssetFile] = useState<File | null>(null); const [fileInputKey, setFileInputKey] = useState(0); const [assetToArchive, setAssetToArchive] = useState<TemplateAsset | null>(null);
  const [jsonText, setJsonText] = useState(""); const [jsonError, setJsonError] = useState<string | null>(null);
  const [unlockedBackgroundAssets, setUnlockedBackgroundAssets] = useState<ReadonlySet<string>>(new Set());
  const [pendingPage, setPendingPage] = useState<PendingPage>(null);
  const [assetPickerKind, setAssetPickerKind] = useState<AssetPickerKind | null>(null);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId);
  const dirty = definition !== null && savedDefinition !== null && JSON.stringify(definition) !== JSON.stringify(savedDefinition);
  const readOnly = template?.status === "ARCHIVED" || selectedVersion?.status !== "DRAFT" || !permissions.has("template:update");
  const activeImageAssets = useMemo(() => assets.filter((asset): asset is TemplateAsset & { detected_mime_type: "image/png" | "image/jpeg" } =>
    asset.status === "ACTIVE" && (asset.detected_mime_type === "image/png" || asset.detected_mime_type === "image/jpeg")), [assets]);
  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, { ...init, cache: "no-store", credentials: "same-origin", headers: {
    "X-Organization-ID": membership.organization.id, ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}), ...init.headers
  } }), [csrfToken, membership.organization.id]);
  const imageReferences = useMemo(() => activeImageAssets.map((asset) => ({ id: asset.id, mimeType: asset.detected_mime_type })), [activeImageAssets]);
  const privateImages = usePrivateTemplateImages(adminFetch, templateId, imageReferences);
  const nextElementKey = useCallback(() => `editor-element-${++elementKeySequence.current}`, []);
  const freshElementKeys = useCallback((count: number) => Array.from({ length: count }, () => nextElementKey()), [nextElementKey]);

  const fetchAllChildren = useCallback(async <T,>(path: string, schema: typeof TemplateVersionListResponseSchema | typeof TemplateAssetListResponseSchema, signal: AbortSignal): Promise<T[]> => {
    const all: T[] = []; const seen = new Set<string>(); let cursor: string | null = null;
    for (let page = 0; page < maximumChildPages; page += 1) {
      const query = new URLSearchParams({ limit: String(childPageSize) }); if (cursor !== null) query.set("cursor", cursor);
      const response = await adminFetch(`${path}?${query}`, { signal }); const body: unknown = await response.json(); const parsed = schema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("invalid child list"); all.push(...parsed.data.data as T[]); cursor = parsed.data.meta.next_cursor;
      if (cursor === null) return all; if (seen.has(cursor)) throw new Error("repeated cursor"); seen.add(cursor);
    }
    throw new Error("child list exceeded safe page bound");
  }, [adminFetch]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      adminFetch(`/admin/templates/${templateId}`, { signal: controller.signal }).then(async (response) => { const body: unknown = await response.json(); const parsed = TemplateResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("template"); return parsed.data.data; }),
      fetchAllChildren<TemplateVersion>(`/admin/templates/${templateId}/versions`, TemplateVersionListResponseSchema, controller.signal),
      fetchAllChildren<TemplateAsset>(`/admin/templates/${templateId}/assets`, TemplateAssetListResponseSchema, controller.signal)
    ]).then(([nextTemplate, nextVersions, nextAssets]) => {
      setLoadError(false); setTemplate(nextTemplate); setVersions(nextVersions); setAssets(nextAssets); const first = nextVersions[0];
      if (first !== undefined) { setSelectedVersionId(first.id); setDefinition(cloneDefinition(first.definition)); setSavedDefinition(cloneDefinition(first.definition)); setElementKeys(freshElementKeys(first.definition.elements.length)); }
    }).catch((reason: unknown) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setLoadError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [adminFetch, fetchAllChildren, freshElementKeys, refreshKey, templateId]);

  useEffect(() => () => { duplicateRequestSequence.current += 1; duplicateInFlight.current = false; }, [templateId]);

  const applyVersion = (version: TemplateVersion | undefined) => { setSelectedVersionId(version?.id ?? ""); setDefinition(version === undefined ? null : cloneDefinition(version.definition)); setSavedDefinition(version === undefined ? null : cloneDefinition(version.definition)); setElementKeys(freshElementKeys(version?.definition.elements.length ?? 0)); setSelectedIndex(null); setPreview(null); setJsonError(null); setUnlockedBackgroundAssets(new Set()); setPendingPage(null); setAssetPickerKind(null); };
  const requestVersion = (id: string) => { if (pending || id === selectedVersionId) return; if (dirty) { setDiscardTarget({ type: "version", id }); return; } applyVersion(versions.find((version) => version.id === id)); };
  const requestLibrary = () => { if (dirty) setDiscardTarget({ type: "library" }); else router.push("/admin/templates"); };
  const updateDefinition = (next: TemplateDefinition) => { setDefinition(next); setPreview(null); setFeedback(null); };
  const updateSelected = (element: TemplateElement) => { if (definition === null || selectedIndex === null) return; const elements = [...definition.elements]; elements[selectedIndex] = element; updateDefinition({ ...definition, elements }); };
  const updateElementAt = (index: number, element: TemplateElement) => { if (definition === null || readOnly) return; const elements = [...definition.elements]; elements[index] = element; updateDefinition({ ...definition, elements }); };

  const addElement = (kind: "text" | "binding" | "image" | "signature" | "qr" | "shape", binding: TemplateBinding = "recipient.display_name") => {
    if (definition === null || readOnly || definition.elements.length >= 200) return;
    if (kind === "image" || kind === "signature") { setAssetPickerKind(kind); setFeedback(null); return; }
    const offset = Math.min(180, 32 + definition.elements.length * 12); const common = { x: Math.min(offset, definition.page.width - 240), y: Math.min(offset, definition.page.height - 100), width: 240, height: 60, opacity: 1 };
    let element: TemplateElement | null = null;
    if (kind === "text") element = { type: "text", ...common, text: "ข้อความใหม่", align: "center", color: "#0F172A", font: { family: "Noto Sans Thai", size: 28, weight: 400 } };
    if (kind === "binding") element = { type: "text", ...common, binding, align: "center", color: "#0F172A", font: { family: "Noto Sans Thai", size: 32, weight: binding === "recipient.display_name" ? 700 : 400 } };
    if (kind === "qr") element = { type: "qr", x: common.x, y: common.y, width: 120, height: 120, opacity: 1, binding: "verification_url", foreground: "#0F172A", background: "#FFFFFF" };
    if (kind === "shape") element = { type: "shape", x: common.x, y: common.y, width: 300, height: 160, opacity: 1, shape: "rectangle", color: "#2557A7", stroke_width: 2 };
    if (element === null) return;
    const candidate = TemplateDefinitionSchema.safeParse({ ...definition, elements: [...definition.elements, element] });
    if (!candidate.success) { setFeedback({ kind: "error", message: "ไม่สามารถเพิ่มองค์ประกอบภายในพื้นที่ใบประกาศได้" }); return; }
    updateDefinition(candidate.data); setElementKeys((current) => [...current, nextElementKey()]); setSelectedIndex(candidate.data.elements.length - 1); setMobilePanel("properties");
  };
  const addAssetElement = (asset: TemplateAsset, kind: AssetPickerKind) => {
    if (definition === null || readOnly || asset.status !== "ACTIVE"
      || (asset.detected_mime_type !== "image/png" && asset.detected_mime_type !== "image/jpeg")) return;
    const ratio = asset.width_px !== null && asset.height_px !== null ? asset.width_px / asset.height_px : (kind === "signature" ? 2.4 : 1.5);
    const maximumWidth = Math.min(definition.page.width * (kind === "signature" ? 0.28 : 0.24), kind === "signature" ? 240 : 220);
    const maximumHeight = Math.min(definition.page.height * (kind === "signature" ? 0.16 : 0.24), kind === "signature" ? 110 : 180);
    let width = maximumWidth; let height = width / ratio;
    if (height > maximumHeight) { height = maximumHeight; width = height * ratio; }
    width = Math.max(24, Math.min(width, definition.page.width)); height = Math.max(16, Math.min(height, definition.page.height));
    const common = { x: Math.max(0, (definition.page.width - width) / 2), y: Math.max(0, (definition.page.height - height) / 2),
      width, height, opacity: 1, asset_id: asset.id };
    const element: TemplateElement = kind === "signature" ? { type: "signature", ...common }
      : { type: "image", ...common, fit: "contain" };
    const candidate = TemplateDefinitionSchema.safeParse({ ...definition, elements: [...definition.elements, element] });
    if (!candidate.success) { setFeedback({ kind: "error", message: "ไม่สามารถเพิ่มรูปภาพภายในพื้นที่ใบประกาศได้" }); return; }
    updateDefinition(candidate.data); setElementKeys((current) => [...current, nextElementKey()]);
    setSelectedIndex(candidate.data.elements.length - 1); setAssetPickerKind(null); setMobilePanel("properties");
  };
  const removeElement = () => { if (definition === null || selectedIndex === null || readOnly) return; const selected = definition.elements[selectedIndex];
    if (selected !== undefined && isFullPageBackground(selected, definition) && !unlockedBackgroundAssets.has(selected.asset_id)) { setFeedback({ kind: "error", message: "ปลดล็อกพื้นหลังก่อนลบ" }); return; }
    const nextLength = definition.elements.length - 1; const nextSelection = nextLength === 0 ? null : Math.min(selectedIndex, nextLength - 1);
    updateDefinition({ ...definition, elements: definition.elements.filter((_, index) => index !== selectedIndex) });
    setElementKeys((current) => current.filter((_, index) => index !== selectedIndex)); setSelectedIndex(nextSelection);
  };
  const moveElement = (direction: -1 | 1) => { if (definition === null || selectedIndex === null || readOnly) return; const target = selectedIndex + direction; if (target < 0 || target >= definition.elements.length) return; const elements = [...definition.elements]; [elements[selectedIndex], elements[target]] = [elements[target]!, elements[selectedIndex]!]; const keys = [...elementKeys]; [keys[selectedIndex], keys[target]] = [keys[target]!, keys[selectedIndex]!]; updateDefinition({ ...definition, elements }); setElementKeys(keys); setSelectedIndex(target); };
  const moveElementTo = (target: "front" | "back") => { if (definition === null || selectedIndex === null || readOnly) return; const elements = [...definition.elements]; const keys = [...elementKeys]; const [element] = elements.splice(selectedIndex, 1); const [key] = keys.splice(selectedIndex, 1); if (element === undefined || key === undefined) return; if (target === "front") { elements.push(element); keys.push(key); setSelectedIndex(elements.length - 1); } else { elements.unshift(element); keys.unshift(key); setSelectedIndex(0); } updateDefinition({ ...definition, elements }); setElementKeys(keys); };
  const duplicateElement = () => { if (definition === null || selectedIndex === null || readOnly || definition.elements.length >= 200) return;
    const selected = definition.elements[selectedIndex]; if (selected === undefined) return;
    if (isFullPageBackground(selected, definition) && !unlockedBackgroundAssets.has(selected.asset_id)) { setFeedback({ kind: "error", message: "ปลดล็อกพื้นหลังก่อนทำสำเนา" }); return; }
    const duplicate = { ...structuredClone(selected), x: clamp(selected.x + 16, 0, definition.page.width - selected.width),
      y: clamp(selected.y + 16, 0, definition.page.height - selected.height) };
    const candidate = TemplateDefinitionSchema.safeParse({ ...definition, elements: [...definition.elements, duplicate] }); if (!candidate.success) return;
    updateDefinition(candidate.data); setElementKeys((current) => [...current, nextElementKey()]); setSelectedIndex(candidate.data.elements.length - 1);
  };
  const alignSelected = (alignment: "left" | "right" | "top" | "bottom" | "horizontal" | "vertical") => {
    if (definition === null || selectedIndex === null || readOnly) return; const element = definition.elements[selectedIndex]; if (element === undefined) return;
    const next = { ...element };
    if (alignment === "left") next.x = 0; if (alignment === "right") next.x = definition.page.width - next.width;
    if (alignment === "top") next.y = 0; if (alignment === "bottom") next.y = definition.page.height - next.height;
    if (alignment === "horizontal") next.x = (definition.page.width - next.width) / 2;
    if (alignment === "vertical") next.y = (definition.page.height - next.height) / 2;
    updateElementAt(selectedIndex, next);
  };

  const createDraft = async () => {
    if (template === null || template.status === "ARCHIVED") return; setPending(true); setFeedback(null);
    const starting = TemplateDefinitionSchema.safeParse(definition ?? defaultDefinition);
    try { if (!starting.success) throw new Error("definition"); const response = await adminFetch(`/admin/templates/${templateId}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: starting.data }) }); const body: unknown = await response.json(); const parsed = TemplateVersionResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("draft"); const next = parsed.data.data; setVersions((current) => [next, ...current]); applyVersion(next); setFeedback({ kind: "success", message: `สร้างแบบร่างเวอร์ชัน ${next.version} แล้ว` }); }
    catch { setFeedback({ kind: "error", message: "ไม่สามารถสร้างแบบร่างได้ กรุณาตรวจสอบองค์ประกอบและไฟล์ที่ใช้งาน" }); }
    finally { setPending(false); }
  };
  const cloneSelectedVersion = async () => {
    if (selectedVersion === undefined || template === null || template.status === "ARCHIVED" || dirty
      || !permissions.has("template:update") || cloneInFlight.current) return;
    cloneInFlight.current = true; setPending(true); setClonePending(true); setFeedback(null);
    try {
      const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}/clone`, { method: "POST" });
      const body: unknown = await response.json(); const parsed = TemplateVersionResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("clone");
      const next = parsed.data.data; setVersions((current) => [next, ...current]); applyVersion(next);
      setFeedback({ kind: "success", message: `สร้างแบบร่างเวอร์ชัน ${next.version} จากเวอร์ชัน ${selectedVersion.version} แล้ว โดยเวอร์ชันเดิมไม่เปลี่ยนแปลง` });
    } catch {
      setFeedback({ kind: "error", message: "ไม่สามารถสร้างแบบร่างจากเวอร์ชันนี้ได้ กรุณาตรวจสอบว่าไฟล์อ้างอิงยังพร้อมใช้งานและลองอีกครั้ง" });
    } finally {
      cloneInFlight.current = false; setClonePending(false); setPending(false);
    }
  };
  const duplicateSelectedVersion = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedVersion === undefined || template === null || duplicateInFlight.current || !permissions.has("template:create")) return;
    const parsedInput = DuplicateTemplateRequestSchema.safeParse({ source_version_id: selectedVersion.id, name: duplicateName });
    if (!parsedInput.success) {
      setFeedback({ kind: "error", message: "กรุณาระบุชื่อเทมเพลตใหม่ไม่เกิน 200 ตัวอักษร" });
      return;
    }
    duplicateInFlight.current = true; const requestSequence = ++duplicateRequestSequence.current;
    const sourceTemplateId = templateId; setPending(true); setFeedback(null);
    try {
      const response = await adminFetch(`/admin/templates/${templateId}/duplicate`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsedInput.data) });
      const body: unknown = await response.json(); const parsed = DuplicateTemplateResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("duplicate template");
      if (requestSequence !== duplicateRequestSequence.current || sourceTemplateId !== templateId) return;
      setDuplicateOpen(false); router.push(`/admin/templates/${parsed.data.data.template.id}`);
    } catch {
      if (requestSequence !== duplicateRequestSequence.current || sourceTemplateId !== templateId) return;
      setDuplicateOpen(false);
      setFeedback({ kind: "error", message: "ไม่สามารถทำสำเนาเป็นเทมเพลตใหม่ได้ กรุณาลองอีกครั้ง" });
    } finally {
      if (requestSequence === duplicateRequestSequence.current) {
        duplicateInFlight.current = false; setPending(false);
      }
    }
  };
  const saveDraft = async () => {
    if (definition === null || selectedVersion?.status !== "DRAFT") return; const validated = TemplateDefinitionSchema.safeParse(definition);
    if (!validated.success) { setFeedback({ kind: "error", message: "แบบร่างยังมีข้อมูลไม่ถูกต้อง กรุณาตรวจสอบคุณสมบัติองค์ประกอบ" }); return; }
    setPending(true); setFeedback(null);
    try { const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: validated.data }) }); const body: unknown = await response.json(); const parsed = TemplateVersionResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("save"); const saved = parsed.data.data; setVersions((current) => current.map((version) => version.id === saved.id ? saved : version)); setDefinition(cloneDefinition(saved.definition)); setSavedDefinition(cloneDefinition(saved.definition)); setPreview(null); setFeedback({ kind: "success", message: "บันทึกแบบร่างแล้ว พร้อมตรวจสอบข้อมูลตัวอย่าง" }); }
    catch { setFeedback({ kind: "error", message: "ไม่สามารถบันทึกแบบร่างได้ กรุณาตรวจสอบไฟล์อ้างอิงและลองอีกครั้ง" }); }
    finally { setPending(false); }
  };
  const validatePreview = async () => {
    if (selectedVersion === undefined || dirty) return; setPending(true); setFeedback(null);
    try { const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}/preview`, { method: "POST" }); const body: unknown = await response.json(); const parsed = TemplatePreviewResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("preview"); setPreview(parsed.data.data); setFeedback({ kind: "success", message: "การตรวจสอบข้อมูลตัวอย่างผ่านแล้ว นี่ไม่ใช่ไฟล์ PDF จริง" }); }
    catch { setPreview(null); setFeedback({ kind: "error", message: "ไม่ผ่านการตรวจสอบข้อมูลตัวอย่าง โปรดตรวจสอบว่าไฟล์อ้างอิงพร้อมใช้งาน" }); }
    finally { setPending(false); }
  };
  const changeVersionState = async (action: "publish" | "archive") => {
    if (selectedVersion === undefined) return; setPending(true); setFeedback(null);
    try { const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}/${action}`, { method: "POST" }); const body: unknown = await response.json(); const parsed = TemplateVersionResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error(action); const changed = parsed.data.data; setVersions((current) => current.map((version) => version.id === changed.id ? changed : version)); applyVersion(changed); setFeedback({ kind: "success", message: action === "publish" ? `เผยแพร่เวอร์ชัน ${changed.version} แล้ว เวอร์ชันนี้ถูกล็อกไม่ให้แก้ไข` : `เก็บเวอร์ชัน ${changed.version} ถาวรแล้ว` }); setConfirm(null); }
    catch { setConfirm(null); setFeedback({ kind: "error", message: action === "publish" ? "ไม่สามารถเผยแพร่ได้ โปรดตรวจสอบความพร้อมของแบบร่างและไฟล์อ้างอิง" : "ไม่สามารถเก็บเวอร์ชันถาวรได้ กรุณาลองอีกครั้ง" }); }
    finally { setPending(false); }
  };
  const deleteDraft = async () => {
    if (selectedVersion?.status !== "DRAFT") return; setPending(true);
    try { const response = await adminFetch(`/admin/templates/${templateId}/versions/${selectedVersion.id}`, { method: "DELETE" }); const body: unknown = await response.json(); if (!response.ok || !DeleteDraftVersionResponseSchema.safeParse(body).success) throw new Error("delete"); const remaining = versions.filter((version) => version.id !== selectedVersion.id); setVersions(remaining); applyVersion(remaining[0]); setFeedback({ kind: "success", message: `ลบแบบร่างเวอร์ชัน ${selectedVersion.version} แล้ว` }); setConfirm(null); }
    catch { setConfirm(null); setFeedback({ kind: "error", message: "ไม่สามารถลบแบบร่างได้ สถานะอาจมีการเปลี่ยนแปลง กรุณาลองใหม่" }); }
    finally { setPending(false); }
  };

  const renameTemplate = async (event: FormEvent) => { event.preventDefault(); const parsedName = CreateTemplateRequestSchema.safeParse({ name: renameValue }); if (!parsedName.success) { setFeedback({ kind: "error", message: "กรุณาระบุชื่อเทมเพลตไม่เกิน 200 ตัวอักษร" }); return; } setPending(true);
    try { const response = await adminFetch(`/admin/templates/${templateId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsedName.data) }); const body: unknown = await response.json(); const parsed = TemplateResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("rename"); setTemplate(parsed.data.data); setRenameOpen(false); setFeedback({ kind: "success", message: "เปลี่ยนชื่อเทมเพลตแล้ว" }); }
    catch { setFeedback({ kind: "error", message: "ไม่สามารถเปลี่ยนชื่อเทมเพลตได้ กรุณาลองอีกครั้ง" }); }
    finally { setPending(false); }
  };
  const archiveTemplate = async () => { if (template === null) return; setPending(true); try { const response = await adminFetch(`/admin/templates/${templateId}/archive`, { method: "POST" }); const body: unknown = await response.json(); const parsed = TemplateResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("archive"); setTemplate(parsed.data.data); setConfirm(null); setPreview(null); setFeedback({ kind: "success", message: "เก็บเทมเพลตถาวรแล้ว พื้นที่นี้อยู่ในโหมดอ่านอย่างเดียว" }); } catch { setConfirm(null); setFeedback({ kind: "error", message: "ไม่สามารถเก็บเทมเพลตถาวรได้ กรุณาลองอีกครั้ง" }); } finally { setPending(false); } };

  const chooseAsset = (event: ChangeEvent<HTMLInputElement>) => { setAssetFile(event.target.files?.[0] ?? null); };
  const performAssetUpload = async (file: File): Promise<TemplateAsset | null> => { setPending(true); const form = new FormData(); form.set("file", file);
    try { const response = await adminFetch(`/admin/templates/${templateId}/assets`, { method: "POST", body: form }); const body: unknown = await response.json(); const parsed = TemplateAssetResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("upload"); const uploaded = parsed.data.data; setAssets((current) => [uploaded, ...current.filter((asset) => asset.id !== uploaded.id)]); setFeedback({ kind: "success", message: uploaded.status === "ACTIVE" ? "อัปโหลดและตรวจสอบไฟล์แล้ว พร้อมนำไปใช้ในแบบร่าง" : "รับไฟล์แล้ว ระบบกำลังตรวจสอบ ไฟล์จะเลือกใช้ได้เมื่อสถานะพร้อมใช้งาน" }); return uploaded; }
    catch { setFeedback({ kind: "error", message: "ไม่สามารถรับไฟล์ได้ รองรับเฉพาะ PNG, JPEG, TTF และ OTF ที่ผ่านการตรวจสอบ" }); return null; }
    finally { setPending(false); }
  };
  const uploadAsset = async (event: FormEvent) => { event.preventDefault(); if (assetFile === null) return; const uploaded = await performAssetUpload(assetFile);
    if (uploaded !== null) { setUploadOpen(false); setAssetFile(null); setFileInputKey((value) => value + 1); }
  };
  const archiveAsset = async () => { if (assetToArchive === null) return; setPending(true); try { const response = await adminFetch(`/admin/templates/${templateId}/assets/${assetToArchive.id}/archive`, { method: "POST" }); const body: unknown = await response.json(); const parsed = TemplateAssetResponseSchema.safeParse(body); if (!response.ok || !parsed.success) throw new Error("archive asset"); const changed = parsed.data.data; setAssets((current) => current.map((asset) => asset.id === changed.id ? changed : asset)); setAssetToArchive(null); setFeedback({ kind: "success", message: "เก็บไฟล์ถาวรแล้ว" }); } catch { setAssetToArchive(null); setFeedback({ kind: "error", message: "ไม่สามารถเก็บไฟล์ถาวรได้ อาจมีเวอร์ชันที่เผยแพร่แล้วกำลังใช้งานไฟล์นี้" }); } finally { setPending(false); } };

  const applyPageChange = (page: TemplateDefinition["page"]) => {
    if (definition === null || readOnly) return;
    const ratioX = page.width / definition.page.width; const ratioY = page.height / definition.page.height;
    const elements = definition.elements.map((element): TemplateElement => {
      const resized = { ...element, x: element.x * ratioX, y: element.y * ratioY,
        width: element.width * ratioX, height: element.height * ratioY };
      if (resized.type === "qr") { const size = Math.min(resized.width, resized.height); return { ...resized, width: size, height: size }; }
      return resized;
    });
    const parsed = TemplateDefinitionSchema.safeParse({ ...definition, page, elements });
    if (!parsed.success) { setFeedback({ kind: "error", message: "ไม่สามารถใช้ขนาดหน้านี้กับองค์ประกอบปัจจุบันได้" }); return; }
    updateDefinition(parsed.data); setPendingPage(null); setSelectedIndex(null);
  };
  const requestPageChange = (page: TemplateDefinition["page"]) => {
    if (definition === null || readOnly || (page.width === definition.page.width && page.height === definition.page.height)) return;
    if (definition.elements.length > 0) setPendingPage(page); else applyPageChange(page);
  };

  const applyAdvancedJson = () => { let input: unknown; try { input = JSON.parse(jsonText) as unknown; } catch { setJsonError("JSON ไม่ถูกต้อง จึงยังไม่ได้นำมาใช้"); return; } const parsed = TemplateDefinitionSchema.safeParse(input); if (!parsed.success) { setJsonError("ข้อมูลไม่ผ่านโครงสร้างเทมเพลตที่ระบบรองรับ"); return; } updateDefinition(parsed.data); setElementKeys(freshElementKeys(parsed.data.elements.length)); setSelectedIndex(null); setJsonError(null); setFeedback({ kind: "success", message: "นำ JSON ขั้นสูงมาใช้กับแบบร่างแล้ว โปรดตรวจสอบและบันทึก" }); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEditingTarget(event.target) || assetPickerKind !== null || uploadOpen || renameOpen || duplicateOpen || confirm !== null
        || discardTarget !== null || pendingPage !== null || assetToArchive !== null) return;
      if (event.key === "Escape") { if (selectedIndex !== null) { event.preventDefault(); setSelectedIndex(null); } return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { if (selectedIndex !== null) { event.preventDefault(); duplicateElement(); } return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedIndex !== null) { event.preventDefault(); removeElement(); }
    };
    document.addEventListener("keydown", onKeyDown); return () => document.removeEventListener("keydown", onKeyDown);
  });

  if (loading) return <><AdminPageHeader description="กำลังเตรียมพื้นที่ออกแบบและประวัติเวอร์ชัน" eyebrow="สตูดิโอเทมเพลต" title="กำลังโหลดเทมเพลต…" /><section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><LoadingRows /></section></>;
  if (loadError || template === null) return <><AdminPageHeader description="ไม่พบเทมเพลตในองค์กรนี้ หรือระบบยังไม่พร้อมให้บริการ" eyebrow="สตูดิโอเทมเพลต" title="ไม่สามารถเปิดเทมเพลตได้" /><section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><LoadError onRetry={() => { setLoading(true); setLoadError(false); setRefreshKey((value) => value + 1); }} /></section></>;

  const selectedElement = definition !== null && selectedIndex !== null ? definition.elements[selectedIndex] : undefined;
  const lockedIndices = new Set<number>();
  const backgroundAssetIds = new Set<string>();
  if (definition !== null) definition.elements.forEach((element, index) => {
    if (isFullPageBackground(element, definition)) { backgroundAssetIds.add(element.asset_id); if (!unlockedBackgroundAssets.has(element.asset_id)) lockedIndices.add(index); }
  });
  const selectedBackground = definition !== null && selectedElement !== undefined && isFullPageBackground(selectedElement, definition)
    ? selectedElement : undefined;
  const pageDescription = definition === null ? null : describeLogicalPage(definition.page);
  return <>
    <AdminPageHeader action={<Button className="w-full sm:w-auto" onClick={() => requestLibrary()} variant="secondary">← กลับคลังเทมเพลต</Button>} description="ออกแบบองค์ประกอบ จัดการไฟล์ และเตรียมเวอร์ชันที่พร้อมเผยแพร่" eyebrow="สตูดิโอเทมเพลต" title={template.name} />
    <Feedback kind={feedback?.kind ?? "success"} message={feedback?.message ?? null} />
    <section aria-label="ข้อมูลเทมเพลตและเวอร์ชัน" className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.03)] sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 items-start gap-3"><StatusBadge status={template.status} /><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-950">{template.name}</p><p className="mt-1 text-xs text-slate-500">{template.status === "ARCHIVED" ? "เก็บถาวรแล้ว — ดูประวัติได้โดยไม่สามารถแก้ไข" : "การแก้ไขเกิดขึ้นในเวอร์ชันแบบร่างเท่านั้น"}</p></div></div><div className="flex flex-wrap gap-2">{permissions.has("template:update") && template.status !== "ARCHIVED" ? <><Button onClick={() => { setRenameValue(template.name); setRenameOpen(true); }} variant="secondary">เปลี่ยนชื่อ</Button><Button className="border-red-200 text-red-700" onClick={() => setConfirm("archive-template")} variant="secondary">เก็บเทมเพลตถาวร</Button></> : null}{permissions.has("template:create") && template.status !== "ARCHIVED" ? <Button disabled={pending} onClick={() => void createDraft()}>+ สร้างแบบร่างใหม่</Button> : null}</div></div>
      <div className="mt-5 grid gap-3 border-t border-slate-200 pt-4 lg:grid-cols-[minmax(220px,340px)_1fr]"><Field htmlFor="version-selector" label="เวอร์ชันที่กำลังดู"><select className={selectClassName} disabled={pending} id="version-selector" onChange={(event) => requestVersion(event.target.value)} value={selectedVersionId}><option value="">ยังไม่มีเวอร์ชัน</option>{versions.map((version) => <option key={version.id} value={version.id}>เวอร์ชัน {version.version} — {versionPresentation[version.status].label}</option>)}</select></Field>
        <div className="flex flex-col justify-end gap-2"><div className="flex flex-wrap items-center gap-2">{selectedVersion === undefined ? <span className="text-sm text-slate-500">สร้างแบบร่างแรกเพื่อเริ่มออกแบบ</span> : <><VersionBadge status={selectedVersion.status} />{dirty ? <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800"><span className="size-1.5 rounded-full bg-amber-500" />มีการแก้ไขที่ยังไม่ได้บันทึก</span> : <span className="text-xs text-slate-500">บันทึกล่าสุดตรงกับข้อมูลบนระบบ</span>}</>}</div>
          {selectedVersion !== undefined ? <div className="flex flex-col gap-2"><div className="flex flex-wrap gap-2">{selectedVersion.status === "DRAFT" && permissions.has("template:update") && template.status !== "ARCHIVED" ? <><Button disabled={pending || !dirty} onClick={() => void saveDraft()}>บันทึกแบบร่าง</Button><Button disabled={pending || dirty} onClick={() => void validatePreview()} variant="secondary">ตรวจสอบข้อมูลตัวอย่าง</Button><Button className="border-red-200 text-red-700" disabled={pending} onClick={() => setConfirm("delete-draft")} variant="secondary">ลบแบบร่าง</Button></> : null}{selectedVersion.status === "DRAFT" && permissions.has("template:publish") && template.status !== "ARCHIVED" ? <Button disabled={pending || dirty || preview === null} onClick={() => setConfirm("publish")} variant="secondary">เผยแพร่เวอร์ชัน</Button> : null}{selectedVersion.status === "PUBLISHED" && permissions.has("template:publish") ? <Button disabled={pending} onClick={() => setConfirm("archive-version")} variant="secondary">เก็บเวอร์ชันถาวร</Button> : null}{permissions.has("template:update") && template.status !== "ARCHIVED" ? <Button disabled={pending || dirty} onClick={() => void cloneSelectedVersion()} variant="secondary">{clonePending ? "กำลังสร้างแบบร่างใหม่…" : "สร้างแบบร่างใหม่จากเวอร์ชันนี้"}</Button> : null}{permissions.has("template:create") ? <Button disabled={pending || dirty} onClick={() => { setDuplicateName(`${template.name} Copy`); setDuplicateOpen(true); setFeedback(null); }} variant="secondary">ทำสำเนาเป็นเทมเพลตใหม่</Button> : null}</div>{selectedVersion.status === "PUBLISHED" || selectedVersion.status === "ARCHIVED" ? <p className="text-xs leading-5 text-slate-500">สร้างแบบร่างใหม่ที่แก้ไขได้ โดยเวอร์ชันเดิมจะไม่เปลี่ยนแปลง</p> : null}</div> : null}</div></div>
    </section>

    {definition === null ? <section className="rounded-xl border border-slate-200 bg-white px-5 py-16 text-center"><span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-full bg-blue-50 text-xl text-[#2557a7]">▱</span><h2 className="mt-4 text-base font-semibold text-slate-950">เทมเพลตนี้ยังไม่มีเวอร์ชัน</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">สร้างแบบร่างแรกจากโครงสร้างเริ่มต้นที่ผ่านการตรวจสอบแล้ว โดยไม่ต้องเขียน JSON</p>{permissions.has("template:create") && template.status !== "ARCHIVED" ? <Button className="mt-5" onClick={() => void createDraft()}>สร้างแบบร่างแรก</Button> : <p className="mt-4 text-sm text-slate-500">บัญชีนี้มีสิทธิ์ดูเท่านั้น</p>}</section> : <>
      <nav aria-label="ส่วนของสตูดิโอเทมเพลต" className="mb-3 grid grid-cols-4 rounded-xl border border-slate-200 bg-white p-1 xl:hidden">{(["layers", "design", "properties", "assets"] as const).map((panel) => <button aria-current={mobilePanel === panel ? "page" : undefined} className={`min-h-10 rounded-lg px-2 text-xs font-semibold ${mobilePanel === panel ? "bg-blue-50 text-[#2557a7]" : "text-slate-600"}`} key={panel} onClick={() => setMobilePanel(panel)} type="button">{{ layers: "เลเยอร์", design: "ออกแบบ", properties: "คุณสมบัติ", assets: "ไฟล์" }[panel]}</button>)}</nav>
      <section aria-label="ตัวแก้ไขเทมเพลต" className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_310px]">
        <aside className={`${mobilePanel === "layers" ? "block" : "hidden"} overflow-hidden rounded-xl border border-slate-200 bg-white xl:block`}><div className="border-b border-slate-200 px-4 py-4"><h2 className="text-sm font-semibold text-slate-950">เพิ่มองค์ประกอบ</h2><div className="mt-3 grid grid-cols-2 gap-2">{[["text", "เพิ่มข้อความ"], ["binding", "เพิ่มข้อมูลอัตโนมัติ"], ["image", "เพิ่มรูปภาพ"], ["signature", "เพิ่มลายเซ็น"], ["qr", "QR ตรวจสอบ"], ["shape", "เพิ่มเส้น/กรอบ"]].map(([kind, label]) => <button className="min-h-10 rounded-lg border border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-[#2557a7] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400" disabled={readOnly} key={kind} onClick={() => addElement(kind as Parameters<typeof addElement>[0])} type="button">{label}</button>)}</div><details className="mt-3"><summary className="cursor-pointer text-xs font-semibold text-[#2557a7]">เพิ่มข้อมูลสำเร็จรูป</summary><div className="mt-2 grid gap-1">{[["recipient.display_name", "ชื่อผู้รับใบประกาศ"], ["project.name", "ชื่อโครงการ"], ["training.name", "ชื่อการอบรม"], ["training.code", "รหัสการอบรม"], ["certificate.number", "เลขที่ใบประกาศ"], ["certificate.issued_at", "วันที่ออกใบประกาศ"]].map(([binding, label]) => <button className="min-h-9 rounded-lg px-2 text-left text-xs text-slate-700 hover:bg-blue-50" disabled={readOnly} key={binding} onClick={() => addElement("binding", binding as TemplateBinding)} type="button">+ {label}</button>)}<button className="min-h-9 rounded-lg px-2 text-left text-xs text-slate-700 hover:bg-blue-50" disabled={readOnly} onClick={() => addElement("qr")} type="button">+ QR ตรวจสอบ</button></div></details>{readOnly ? <p className="mt-3 text-xs leading-5 text-slate-500">เวอร์ชันนี้เป็นประวัติแบบอ่านอย่างเดียว</p> : null}</div>
          <div className="px-4 py-4"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-950">เลเยอร์</h2><span className="text-xs text-slate-500">{definition.elements.length}/200</span></div>{definition.elements.length === 0 ? <p className="mt-4 rounded-lg bg-slate-50 px-3 py-5 text-center text-xs leading-5 text-slate-500">ยังไม่มีองค์ประกอบ</p> : <ol className="mt-3 space-y-1">{definition.elements.map((element, index) => <li key={elementKeys[index]}><button aria-current={selectedIndex === index ? "true" : undefined} aria-pressed={selectedIndex === index} className={`w-full rounded-lg border px-3 py-2.5 text-left text-xs leading-5 ${selectedIndex === index ? "border-blue-200 bg-blue-50 font-semibold text-[#2557a7]" : "border-transparent text-slate-700 hover:bg-slate-50"}`} onClick={() => { setSelectedIndex(index); setMobilePanel("properties"); }} type="button"><span className="line-clamp-2">{elementLabel(element, assets, definition)}</span></button></li>)}</ol>}
          {selectedIndex !== null ? <div className="mt-3 border-t border-slate-200 pt-3"><p className="mb-2 text-[11px] text-slate-500">ลำดับแรกอยู่ด้านหลัง · ลำดับสุดท้ายอยู่ด้านหน้า</p><div className="grid grid-cols-2 gap-1"><button aria-label="ส่งเลเยอร์ไปด้านหลัง" className="min-h-9 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40" disabled={readOnly || selectedIndex === 0 || lockedIndices.has(selectedIndex)} onClick={() => moveElementTo("back")} type="button">ส่งไปด้านหลัง</button><button aria-label="นำเลเยอร์ไปด้านหน้า" className="min-h-9 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40" disabled={readOnly || selectedIndex === definition.elements.length - 1 || lockedIndices.has(selectedIndex)} onClick={() => moveElementTo("front")} type="button">นำไปด้านหน้า</button><button aria-label="เลื่อนเลเยอร์ลง" className="min-h-9 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40" disabled={readOnly || selectedIndex === 0 || lockedIndices.has(selectedIndex)} onClick={() => moveElement(-1)} type="button">เลื่อนลง</button><button aria-label="เลื่อนเลเยอร์ขึ้น" className="min-h-9 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40" disabled={readOnly || selectedIndex === definition.elements.length - 1 || lockedIndices.has(selectedIndex)} onClick={() => moveElement(1)} type="button">เลื่อนขึ้น</button></div>{selectedBackground !== undefined ? <button className="mt-2 min-h-9 w-full rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-800" disabled={readOnly} onClick={() => setUnlockedBackgroundAssets((current) => { const next = new Set(current); if (next.has(selectedBackground.asset_id)) next.delete(selectedBackground.asset_id); else next.add(selectedBackground.asset_id); return next; })} type="button">{lockedIndices.has(selectedIndex) ? "ปลดล็อกพื้นหลัง" : "ล็อกพื้นหลัง"}</button> : null}<button className="mt-2 min-h-9 w-full rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40" disabled={readOnly || lockedIndices.has(selectedIndex)} onClick={duplicateElement} type="button">ทำสำเนาองค์ประกอบ</button><button className="mt-1 min-h-9 w-full rounded-lg text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40" disabled={readOnly || lockedIndices.has(selectedIndex)} onClick={removeElement} type="button">ลบองค์ประกอบ</button></div> : null}</div>
          <div className="border-t border-slate-200 px-4 py-4"><h2 className="text-sm font-semibold text-slate-950">ประวัติเวอร์ชัน</h2><ol className="mt-3 space-y-2">{versions.map((version) => <li key={version.id}><button className={`w-full rounded-lg border p-3 text-left ${version.id === selectedVersionId ? "border-blue-200 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`} disabled={pending} onClick={() => requestVersion(version.id)} type="button"><span className="flex items-center justify-between gap-2"><strong className="text-xs text-slate-900">เวอร์ชัน {version.version}</strong><VersionBadge status={version.status} /></span>{formatPublishedAt(version.published_at) === null ? null : <span className="mt-2 block text-[11px] text-slate-500">เผยแพร่ {formatPublishedAt(version.published_at)}</span>}</button></li>)}</ol></div>
        </aside>
        <main className={`${mobilePanel === "design" ? "block" : "hidden"} min-w-0 rounded-xl border border-slate-200 bg-slate-100/70 p-3 sm:p-5 xl:block`}><div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold text-slate-950">พื้นที่ออกแบบ</h2><p className="mt-1 text-xs text-slate-500">เลือกองค์ประกอบบนผืนงานหรือจากรายการเลเยอร์</p></div>{preview === null ? <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500">ยังไม่ได้ตรวจสอบข้อมูลตัวอย่าง</span> : <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">ผ่านการตรวจสอบจากระบบ</span>}</div>
          <section aria-label="ขนาดใบประกาศ" className="mb-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Field htmlFor="workspace-page-preset" label="ขนาดใบประกาศ"><select className={selectClassName} disabled={readOnly} id="workspace-page-preset" onChange={(event) => { const preset = event.target.value as PagePresetId; if (preset !== "CUSTOM") requestPageChange(pageForPreset(preset, pageDescription?.orientation ?? "LANDSCAPE")); }} value={pageDescription?.presetId ?? "CUSTOM"}>{PAGE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="CUSTOM">กำหนดเอง</option></select></Field><Field htmlFor="workspace-page-orientation" label="การวางแนว"><select className={selectClassName} disabled={readOnly} id="workspace-page-orientation" onChange={(event) => { const orientation = event.target.value as PageOrientation; if (pageDescription?.presetId !== undefined && pageDescription.presetId !== "CUSTOM") requestPageChange(pageForPreset(pageDescription.presetId, orientation)); else requestPageChange({ width: definition.page.height, height: definition.page.width, unit: "px" }); }} value={pageDescription?.orientation ?? "LANDSCAPE"}><option value="LANDSCAPE">แนวนอน</option><option value="PORTRAIT">แนวตั้ง</option></select></Field><p className="pb-2 text-xs font-medium text-slate-600">{pageDescription?.presetId === "CUSTOM" ? "กำหนดเอง" : PAGE_PRESETS.find((item) => item.id === pageDescription?.presetId)?.label} · {pageDescription?.widthMm.toFixed(0)} × {pageDescription?.heightMm.toFixed(0)} มม.</p>{pageDescription?.presetId === "CUSTOM" ? <div className="grid gap-3 sm:col-span-3 sm:grid-cols-2"><Field htmlFor="workspace-custom-width" label="ความกว้าง (มม.)"><Input defaultValue={pageDescription.widthMm.toFixed(1)} disabled={readOnly} id="workspace-custom-width" key={`w-${definition.page.width}`} onBlur={(event) => { try { requestPageChange(pageForCustomMillimeters(Number(event.target.value), pageDescription.heightMm)); } catch { setFeedback({ kind: "error", message: "ขนาดกำหนดเองต้องอยู่ระหว่าง 50–500 มม." }); } }} type="number" /></Field><Field htmlFor="workspace-custom-height" label="ความสูง (มม.)"><Input defaultValue={pageDescription.heightMm.toFixed(1)} disabled={readOnly} id="workspace-custom-height" key={`h-${definition.page.height}`} onBlur={(event) => { try { requestPageChange(pageForCustomMillimeters(pageDescription.widthMm, Number(event.target.value))); } catch { setFeedback({ kind: "error", message: "ขนาดกำหนดเองต้องอยู่ระหว่าง 50–500 มม." }); } }} type="number" /></Field></div> : null}</section>
          <TemplateCanvas assets={assets} boundElements={preview?.bound_elements ?? []} definition={definition} editable={!readOnly}
            elementKeys={elementKeys} failedImages={privateImages.failed} imageUrls={privateImages.urls} lockedIndices={lockedIndices}
            onChange={updateElementAt} onSelect={(index) => { setSelectedIndex(index); }} selectedIndex={selectedIndex} />
          <p className="mt-3 text-center text-xs leading-5 text-slate-500">QR ตรวจสอบในหน้าจอนี้เป็นข้อมูลตัวอย่างเท่านั้น ระบบจะสร้าง QR สำหรับตรวจสอบใบประกาศให้อัตโนมัติเมื่อออกใบประกาศ</p>
          {preview !== null ? <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3"><p className="text-xs font-semibold text-blue-900">ข้อมูลตัวอย่างจากระบบ</p><p className="mt-1 text-xs leading-5 text-blue-800">ใช้ข้อมูลสังเคราะห์เพื่อตรวจสอบการผูกข้อมูลเท่านั้น ไม่ใช่ผู้เข้าร่วมจริงและไม่ใช่ตัวอย่าง PDF</p><div className="mt-2 flex flex-wrap gap-2">{preview.bound_elements.filter((item) => item.value !== null).slice(0, 5).map((item) => <span className="rounded bg-white/80 px-2 py-1 text-[11px] text-blue-900" key={item.index}>{item.value}</span>)}</div></div> : null}
          <details className="mt-4 rounded-lg border border-slate-200 bg-white"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700" onClick={(event) => { const details = event.currentTarget.parentElement; if (!(details instanceof HTMLDetailsElement) || !details.open) { setJsonText(JSON.stringify(definition, null, 2)); setJsonError(null); } }}>JSON ขั้นสูง</summary><div className="border-t border-slate-200 p-4"><p className="mb-3 text-xs leading-5 text-slate-500">สำหรับตรวจสอบหรือแก้ปัญหาขั้นสูงเท่านั้น การออกแบบปกติใช้ผืนงานและแผงคุณสมบัติด้านบน</p><textarea aria-label="JSON ขั้นสูง" className="min-h-72 w-full rounded-lg border border-slate-300 bg-slate-950 p-3 font-mono text-xs leading-5 text-slate-100 focus:outline-none focus:ring-3 focus:ring-blue-100 disabled:opacity-60" disabled={readOnly} onChange={(event) => { setJsonText(event.target.value); setJsonError(null); }} spellCheck={false} value={jsonText} />{jsonError === null ? null : <p className="mt-2 text-xs text-red-700" role="alert">{jsonError}</p>}<Button className="mt-3" disabled={readOnly} onClick={applyAdvancedJson} variant="secondary">ตรวจสอบและนำ JSON มาใช้</Button></div></details>
        </main>
        <aside className={`${mobilePanel === "properties" ? "block" : "hidden"} rounded-xl border border-slate-200 bg-white p-4 xl:block`}><h2 className="text-sm font-semibold text-slate-950">คุณสมบัติ</h2><p className="mt-1 text-xs leading-5 text-slate-500">ปรับเนื้อหา รูปแบบ ตำแหน่ง และขนาดอย่างแม่นยำ</p><div className="mt-5">{selectedElement === undefined ? <div className="rounded-lg bg-slate-50 px-4 py-8 text-center text-xs leading-5 text-slate-500">เลือกองค์ประกอบจากผืนงานหรือรายการเลเยอร์เพื่อแก้ไข</div> : <><div className="mb-4 grid grid-cols-3 gap-1" aria-label="จัดแนวองค์ประกอบ">{[["left", "ชิดซ้าย"], ["horizontal", "กึ่งกลางแนวนอน"], ["right", "ชิดขวา"], ["top", "ชิดบน"], ["vertical", "กึ่งกลางแนวตั้ง"], ["bottom", "ชิดล่าง"]].map(([value, label]) => <button className="min-h-9 rounded-md bg-slate-50 px-1 text-[10px] font-semibold text-slate-600 hover:bg-blue-50 disabled:opacity-40" disabled={readOnly || lockedIndices.has(selectedIndex ?? -1)} key={value} onClick={() => alignSelected(value as Parameters<typeof alignSelected>[0])} type="button">{label}</button>)}</div><TemplateProperties assets={assets} definition={definition} element={selectedElement} onUpdate={updateSelected} readOnly={readOnly || lockedIndices.has(selectedIndex ?? -1)} /></>}</div></aside>
        <section aria-label="ไฟล์ประกอบเทมเพลต" className={`${mobilePanel === "assets" ? "block" : "hidden"} overflow-hidden rounded-xl border border-slate-200 bg-white xl:col-span-3 xl:block`}><div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold text-slate-950">ไฟล์ประกอบ</h2><p className="mt-1 text-xs leading-5 text-slate-500">รูปภาพที่พร้อมใช้งานจะแสดงบนผืนงานผ่านช่องทางส่วนตัวที่ยืนยันสิทธิ์แล้ว ส่วนแบบอักษรแสดงข้อมูลไฟล์เท่านั้น</p></div>{permissions.has("template:asset:create") && template.status !== "ARCHIVED" ? <Button onClick={() => { setAssetFile(null); setUploadOpen(true); }} variant="secondary">อัปโหลดไฟล์</Button> : null}</div>{assets.length === 0 ? <div className="px-5 py-12 text-center"><h3 className="text-sm font-semibold text-slate-950">ยังไม่มีไฟล์ประกอบ</h3><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">อัปโหลด PNG, JPEG, TTF หรือ OTF เพื่อใช้กับรูปภาพ ลายเซ็น และแบบอักษรบนใบประกาศ</p></div> : <ul className="grid gap-px bg-slate-200 md:grid-cols-2 xl:grid-cols-3">{assets.map((asset) => <li className="bg-white p-4" key={asset.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{asset.original_filename}</p><p className="mt-1 text-xs text-slate-500">{assetTypeLabel(asset)} · {formatBytes(asset.size_bytes)}{asset.width_px === null ? "" : ` · ${asset.width_px} × ${asset.height_px} px`}</p></div><AssetBadge status={asset.status} /></div>{asset.status === "REJECTED" ? <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">ไฟล์นี้ไม่ผ่านการตรวจสอบและจะไม่ปรากฏในตัวเลือกองค์ประกอบ</p> : null}{permissions.has("template:asset:create") && asset.status === "ACTIVE" && template.status !== "ARCHIVED" ? <button className="mt-3 min-h-9 rounded-lg px-3 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => setAssetToArchive(asset)} type="button">เก็บไฟล์ถาวร</button> : null}</li>)}</ul>}</section>
      </section>
    </>}

    {assetPickerKind === null ? null : <TemplateAssetPicker assets={assets} backgroundAssetIds={backgroundAssetIds} failedImages={privateImages.failed}
      imageUrls={privateImages.urls} kind={assetPickerKind} onClose={() => { if (!pending) setAssetPickerKind(null); }}
      onSelect={(asset) => { if (assetPickerKind !== null) addAssetElement(asset, assetPickerKind); }}
      onUpload={async (file) => { const kind = assetPickerKind; const uploaded = await performAssetUpload(file);
        if (uploaded !== null && uploaded.status === "ACTIVE" && kind !== null) addAssetElement(uploaded, kind);
      }} open={assetPickerKind !== null} pending={pending}
      uploadAllowed={permissions.has("template:asset:create") && template.status !== "ARCHIVED"} />}
    <Dialog description="ชื่อใหม่จะใช้ในคลังเทมเพลต โดยไม่เปลี่ยนเนื้อหาเวอร์ชัน" onClose={() => { if (!pending) setRenameOpen(false); }} open={renameOpen} pending={pending} title="เปลี่ยนชื่อเทมเพลต"><form onSubmit={(event) => void renameTemplate(event)}><div className="px-5 py-5 sm:px-6"><Field htmlFor="workspace-template-name" label="ชื่อเทมเพลต"><Input autoFocus id="workspace-template-name" maxLength={200} onChange={(event) => setRenameValue(event.target.value)} value={renameValue} /></Field></div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={() => setRenameOpen(false)} variant="secondary">ยกเลิก</Button><Button disabled={pending || renameValue.trim() === template.name} type="submit">บันทึกชื่อ</Button></footer></form></Dialog>
    <Dialog description="สร้างเทมเพลตใหม่ที่เป็นอิสระจากเวอร์ชันนี้ เทมเพลตและเวอร์ชันต้นฉบับจะไม่เปลี่ยนแปลง" onClose={() => { if (!pending) setDuplicateOpen(false); }} open={duplicateOpen} pending={pending} title="ทำสำเนาเป็นเทมเพลตใหม่"><form onSubmit={(event) => void duplicateSelectedVersion(event)}><div className="px-5 py-5 sm:px-6"><Field htmlFor="duplicate-template-name" label="ชื่อเทมเพลตใหม่"><Input autoFocus id="duplicate-template-name" maxLength={200} onChange={(event) => setDuplicateName(event.target.value)} value={duplicateName} /></Field></div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={() => setDuplicateOpen(false)} variant="secondary">ยกเลิก</Button><Button disabled={pending || duplicateName.trim().length === 0} type="submit">{pending ? "กำลังทำสำเนา…" : "สร้างเทมเพลตใหม่"}</Button></footer></form></Dialog>
    <Dialog description="รองรับ PNG, JPEG, TTF และ OTF ระบบจะตรวจสอบชนิดไฟล์ก่อนอนุญาตให้นำไปใช้" onClose={() => { if (!pending) setUploadOpen(false); }} open={uploadOpen} pending={pending} title="อัปโหลดไฟล์ประกอบ"><form onSubmit={(event) => void uploadAsset(event)}><div className="px-5 py-5 sm:px-6"><Field hint="ระบบไม่เปิดเผยที่เก็บไฟล์และจะไม่โหลดไฟล์ส่วนตัวเข้าเบราว์เซอร์โดยตรง" htmlFor="template-asset-file" label="เลือกไฟล์"><Input accept=".png,.jpg,.jpeg,.ttf,.otf,image/png,image/jpeg,font/ttf,font/otf" id="template-asset-file" key={fileInputKey} onChange={chooseAsset} type="file" /></Field>{assetFile === null ? null : <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{assetFile.name}</p>}</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={() => setUploadOpen(false)} variant="secondary">ยกเลิก</Button><Button disabled={pending || assetFile === null} type="submit">{pending ? "กำลังอัปโหลด…" : "อัปโหลดและตรวจสอบ"}</Button></footer></form></Dialog>
    <Dialog description="การเก็บถาวรไม่ใช่การลบ และอาจถูกปฏิเสธเมื่อเวอร์ชันที่เผยแพร่แล้วยังใช้งานไฟล์นี้" onClose={() => { if (!pending) setAssetToArchive(null); }} open={assetToArchive !== null} pending={pending} title="เก็บไฟล์ถาวร">{assetToArchive === null ? null : <div><div className="px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">ยืนยันการเก็บ <strong className="text-slate-950">{assetToArchive.original_filename}</strong> ถาวรหรือไม่</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={() => setAssetToArchive(null)} variant="secondary">ยกเลิก</Button><Button className="bg-red-700 hover:bg-red-800" disabled={pending} onClick={() => void archiveAsset()}>ยืนยันเก็บถาวร</Button></footer></div>}</Dialog>
    <Dialog description={confirm === "publish" ? "เวอร์ชันที่เผยแพร่จะถูกล็อกถาวร หากต้องการแก้ไขภายหลังต้องสร้างแบบร่างใหม่" : confirm === "delete-draft" ? "แบบร่างจะถูกลบจริงและไม่สามารถกู้คืนผ่านหน้านี้" : confirm === "archive-version" ? "เวอร์ชันจะเปลี่ยนเป็นประวัติแบบอ่านอย่างเดียว และไม่มีการกู้คืนผ่านหน้านี้" : "การเก็บเทมเพลตไม่ใช่การลบ แต่จะทำให้พื้นที่นี้เป็นแบบอ่านอย่างเดียว"} onClose={() => { if (!pending) setConfirm(null); }} open={confirm !== null} pending={pending} title={confirm === "publish" ? "เผยแพร่เวอร์ชัน" : confirm === "delete-draft" ? "ลบแบบร่าง" : confirm === "archive-version" ? "เก็บเวอร์ชันถาวร" : "เก็บเทมเพลตถาวร"}><div><div className="px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">{confirm === "publish" ? `ยืนยันการเผยแพร่เวอร์ชัน ${selectedVersion?.version ?? ""} หรือไม่` : confirm === "delete-draft" ? `ยืนยันการลบแบบร่างเวอร์ชัน ${selectedVersion?.version ?? ""} หรือไม่` : confirm === "archive-version" ? `ยืนยันการเก็บเวอร์ชัน ${selectedVersion?.version ?? ""} ถาวรหรือไม่` : `ยืนยันการเก็บ ${template.name} ถาวรหรือไม่`}</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button disabled={pending} onClick={() => setConfirm(null)} variant="secondary">ยกเลิก</Button><Button className={confirm === "delete-draft" || confirm === "archive-template" ? "bg-red-700 hover:bg-red-800" : ""} disabled={pending} onClick={() => { if (confirm === "publish") void changeVersionState("publish"); else if (confirm === "archive-version") void changeVersionState("archive"); else if (confirm === "delete-draft") void deleteDraft(); else void archiveTemplate(); }}>{pending ? "กำลังดำเนินการ…" : "ยืนยัน"}</Button></footer></div></Dialog>
    <Dialog description="การเปลี่ยนขนาดหรือแนวหน้าจะปรับตำแหน่งและขนาดองค์ประกอบตามสัดส่วน โปรดตรวจสอบผืนงานอีกครั้งก่อนบันทึก" onClose={() => setPendingPage(null)} open={pendingPage !== null} title="เปลี่ยนขนาดใบประกาศ"><div><div className="px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">ยืนยันการเปลี่ยนหน้าที่มีองค์ประกอบอยู่แล้วหรือไม่ การเปลี่ยนแปลงจะยังไม่บันทึกจนกด “บันทึกแบบร่าง”</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button onClick={() => setPendingPage(null)} variant="secondary">ยกเลิก</Button><Button onClick={() => { if (pendingPage !== null) applyPageChange(pendingPage); }}>ยืนยันเปลี่ยนขนาด</Button></footer></div></Dialog>
    <Dialog description="เลือกดำเนินการต่อเพื่อทิ้งการแก้ไขที่ยังไม่ได้บันทึก หรือกลับไปบันทึกแบบร่างก่อน" onClose={() => setDiscardTarget(null)} open={discardTarget !== null} title="มีการแก้ไขที่ยังไม่ได้บันทึก"><div><div className="px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">การดำเนินการต่อจะทิ้งการแก้ไขล่าสุดในหน้านี้</div><footer className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6"><Button onClick={() => setDiscardTarget(null)} variant="secondary">กลับไปบันทึก</Button><Button className="bg-red-700 hover:bg-red-800" onClick={() => { const target = discardTarget; setDiscardTarget(null); if (target?.type === "library") router.push("/admin/templates"); else if (target?.type === "version") applyVersion(versions.find((version) => version.id === target.id)); }}>ทิ้งการแก้ไขและดำเนินการต่อ</Button></footer></div></Dialog>
  </>;
}
