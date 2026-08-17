"use client";

import { AuthenticationResponseSchema, LoginRequestSchema } from "@certificate-platform/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const input = LoginRequestSchema.safeParse({ email: form.get("email"), password: form.get("password") });
    if (!input.success) {
      setError("ไม่สามารถเข้าสู่ระบบได้");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${apiBasePath}/admin/auth/login`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.data)
      });
      const body: unknown = await response.json();
      if (!response.ok || !AuthenticationResponseSchema.safeParse(body).success) {
        setError("ไม่สามารถเข้าสู่ระบบได้");
        return;
      }
      router.push("/admin");
    } catch {
      setError("ไม่สามารถเข้าสู่ระบบได้");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="mt-8 space-y-5" method="post" onSubmit={submit}>
      <div>
        <label className="block text-sm font-medium text-slate-800" htmlFor="email">อีเมลผู้ดูแลระบบ</label>
        <input autoComplete="username" className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300" id="email" name="email" required type="email" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-800" htmlFor="password">รหัสผ่าน</label>
        <input autoComplete="current-password" className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300" id="password" name="password" required type="password" />
      </div>
      {error === null ? null : <p aria-live="polite" className="text-sm text-red-700" role="alert">{error}</p>}
      <button className="w-full rounded-lg bg-slate-950 px-4 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={submitting} type="submit">
        {submitting ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
      </button>
    </form>
  );
}
