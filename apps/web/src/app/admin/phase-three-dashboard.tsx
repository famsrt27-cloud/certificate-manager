"use client";

import {
  ParticipantImportInspectResponseSchema, ParticipantImportQueuedResponseSchema, ParticipantListResponseSchema,
  ProjectListResponseSchema, ProjectResponseSchema, TrainingListResponseSchema, TrainingResponseSchema,
  type AuthenticationData, type Participant, type Project, type Training
} from "@certificate-platform/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
type Membership = AuthenticationData["memberships"][number];
type ImportInspection = ReturnType<typeof ParticipantImportInspectResponseSchema.parse>["data"];

export function PhaseThreeDashboard({ membership, csrfToken }: { membership: Membership; csrfToken: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [trainingProjectId, setTrainingProjectId] = useState("");
  const [trainingName, setTrainingName] = useState("");
  const [trainingCode, setTrainingCode] = useState("");
  const [importTrainingId, setImportTrainingId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const permissions = useMemo(() => new Set(membership.permissions), [membership.permissions]);

  const adminFetch = useCallback((path: string, init: RequestInit = {}) => fetch(`${apiBasePath}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "X-Organization-ID": membership.organization.id,
      ...(init.method !== undefined && init.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
      ...init.headers
    }
  }), [csrfToken, membership.organization.id]);

  const refreshResources = useCallback(async () => {
    const requests: Promise<void>[] = [];
    if (permissions.has("project:read")) requests.push(adminFetch("/admin/projects").then(async (response) => {
      const parsed = ProjectListResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("projects");
      setProjects(parsed.data.data);
      setTrainingProjectId((current) => current || parsed.data.data[0]?.id || "");
    }));
    if (permissions.has("training:read")) requests.push(adminFetch("/admin/trainings").then(async (response) => {
      const parsed = TrainingListResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("trainings");
      setTrainings(parsed.data.data);
      setImportTrainingId((current) => current || parsed.data.data[0]?.id || "");
    }));
    if (permissions.has("participant:read")) requests.push(adminFetch("/admin/participants").then(async (response) => {
      const parsed = ParticipantListResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("participants");
      setParticipants(parsed.data.data);
    }));
    try { await Promise.all(requests); } catch { setMessage("Unable to load Phase 3 resources."); }
  }, [adminFetch, permissions]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshResources(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshResources]);

  const createProject = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await adminFetch("/admin/projects", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName, slug: projectSlug }) });
      const parsed = ProjectResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("create project");
      setProjectName(""); setProjectSlug(""); setMessage("Project created."); await refreshResources();
    } catch { setMessage("The project could not be created."); } finally { setPending(false); }
  };

  const createTraining = async (event: FormEvent) => {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await adminFetch("/admin/trainings", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: trainingProjectId, name: trainingName, code: trainingCode }) });
      const parsed = TrainingResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("create training");
      setTrainingName(""); setTrainingCode(""); setMessage("Training created."); await refreshResources();
    } catch { setMessage("The training could not be created."); } finally { setPending(false); }
  };

  const uploadImport = async (event: FormEvent) => {
    event.preventDefault();
    if (importFile === null || importTrainingId === "") return;
    setPending(true); setMessage(null);
    try {
      const body = new FormData(); body.set("file", importFile);
      const response = await adminFetch(`/admin/trainings/${importTrainingId}/participants/import`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body
      });
      const parsed = ParticipantImportQueuedResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("upload import");
      setImportJobId(parsed.data.data.job_id); setInspection(null); setMessage("Import queued for validation.");
    } catch { setMessage("The participant import could not be queued."); } finally { setPending(false); }
  };

  const inspectImport = async () => {
    if (importJobId === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await adminFetch(`/admin/participant-imports/${importJobId}`);
      const parsed = ParticipantImportInspectResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("inspect import");
      setInspection(parsed.data.data);
    } catch { setMessage("The import preview could not be loaded."); } finally { setPending(false); }
  };

  const confirmImport = async () => {
    if (importJobId === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await adminFetch(`/admin/participant-imports/${importJobId}/confirm`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }
      });
      const parsed = ParticipantImportQueuedResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("confirm import");
      setMessage("Import confirmed and queued."); await refreshResources();
    } catch { setMessage("The import could not be confirmed."); } finally { setPending(false); }
  };

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-semibold">{membership.organization.name}</h2>
        <p className="mt-1 text-sm text-slate-600">{membership.roles.join(", ") || "No role"}</p></div>
      {message && <p aria-live="polite" className="rounded-lg bg-slate-100 px-4 py-3">{message}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="projects-title">
          <h2 className="text-xl font-semibold" id="projects-title">Projects</h2>
          {permissions.has("project:create") && <form className="mt-4 grid gap-3" onSubmit={(event) => void createProject(event)}>
            <label>Name<input className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setProjectName(event.target.value)} required value={projectName} /></label>
            <label>Slug<input className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setProjectSlug(event.target.value)} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required value={projectSlug} /></label>
            <button className="rounded bg-slate-950 px-4 py-2 text-white" disabled={pending} type="submit">Create project</button>
          </form>}
          <ul className="mt-4 space-y-2">{projects.map((project) => <li key={project.id}>{project.name} <span className="text-sm text-slate-500">({project.status})</span></li>)}</ul>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="trainings-title">
          <h2 className="text-xl font-semibold" id="trainings-title">Trainings</h2>
          {permissions.has("training:create") && <form className="mt-4 grid gap-3" onSubmit={(event) => void createTraining(event)}>
            <label>Project<select className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setTrainingProjectId(event.target.value)} required value={trainingProjectId}>
              <option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <label>Name<input className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setTrainingName(event.target.value)} required value={trainingName} /></label>
            <label>Code<input className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setTrainingCode(event.target.value)} required value={trainingCode} /></label>
            <button className="rounded bg-slate-950 px-4 py-2 text-white" disabled={pending || trainingProjectId === ""} type="submit">Create training</button>
          </form>}
          <ul className="mt-4 space-y-2">{trainings.map((training) => <li key={training.id}>{training.name} <span className="text-sm text-slate-500">{training.code}</span></li>)}</ul>
        </section>
      </div>
      {permissions.has("participant:import") && <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="import-title">
        <h2 className="text-xl font-semibold" id="import-title">Participant import</h2>
        <p className="mt-1 text-sm text-slate-600">CSV/XLSX: display_name and optional external_reference only.</p>
        <form className="mt-4 grid gap-3 md:grid-cols-3" onSubmit={(event) => void uploadImport(event)}>
          <label>Training<select className="mt-1 w-full rounded border px-3 py-2" onChange={(event) => setImportTrainingId(event.target.value)} required value={importTrainingId}>
            <option value="">Select training</option>{trainings.map((training) => <option key={training.id} value={training.id}>{training.name}</option>)}</select></label>
          <label>File<input accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="mt-1 block w-full" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} required type="file" /></label>
          <button className="self-end rounded bg-slate-950 px-4 py-2 text-white" disabled={pending} type="submit">Upload and validate</button>
        </form>
        {importJobId && <div className="mt-4 flex gap-3"><button className="rounded border px-4 py-2" disabled={pending} onClick={() => void inspectImport()} type="button">Refresh preview</button>
          {inspection?.status === "AWAITING_CONFIRMATION" && inspection.counts.valid > 0 && <button className="rounded bg-emerald-700 px-4 py-2 text-white" disabled={pending} onClick={() => void confirmImport()} type="button">Confirm import</button>}</div>}
        {inspection && <div className="mt-5"><p>Status: {inspection.status}; valid {inspection.counts.valid}; invalid {inspection.counts.invalid}</p>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Row</th><th>Name</th><th>Reference</th><th>Result</th></tr></thead><tbody>
            {inspection.preview.map((row) => <tr key={row.row_number}><td>{row.row_number}</td><td>{row.display_name ?? "—"}</td><td>{row.external_reference ?? "—"}</td><td>{row.status}{row.validation_errors.length ? `: ${row.validation_errors.map((error) => error.code).join(", ")}` : ""}</td></tr>)}
          </tbody></table></div></div>}
      </section>}
      {permissions.has("participant:read") && <section className="rounded-xl border border-slate-200 bg-white p-5" aria-labelledby="participants-title">
        <h2 className="text-xl font-semibold" id="participants-title">Participants</h2>
        <ul className="mt-4 grid gap-2">{participants.map((participant) => <li key={participant.id}>{participant.display_name}{participant.external_reference ? ` — ${participant.external_reference}` : ""}</li>)}</ul>
      </section>}
    </div>
  );
}
