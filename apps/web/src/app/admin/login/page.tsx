import { LoginForm } from "./login-form";

export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6 py-16">
      <section aria-labelledby="login-title" className="w-full rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Certificate Platform</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight" id="login-title">เข้าสู่ระบบผู้ดูแล</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">ใช้บัญชีผู้ดูแลที่ได้รับสิทธิ์จากองค์กรของคุณ</p>
        <LoginForm />
      </section>
    </main>
  );
}
