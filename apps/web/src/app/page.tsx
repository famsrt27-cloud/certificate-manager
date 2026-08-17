export default function FoundationPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-16">
      <section aria-labelledby="foundation-title" className="space-y-4">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
          Phase 3 Project, Training &amp; Participant
        </p>
        <h1 id="foundation-title" className="text-4xl font-semibold tracking-tight text-slate-950">
          Certificate Platform
        </h1>
        <p className="max-w-2xl text-lg leading-8 text-slate-700">
          Secure tenant-scoped project and training management with private, validated participant imports is ready.
        </p>
        <a className="inline-flex rounded-lg bg-slate-950 px-4 py-2.5 font-medium text-white" href="/admin/login">เข้าสู่ระบบผู้ดูแล</a>
      </section>
    </main>
  );
}
