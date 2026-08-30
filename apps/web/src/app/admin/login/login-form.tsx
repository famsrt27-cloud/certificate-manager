"use client";

import { AuthenticationResponseSchema, LoginRequestSchema } from "@certificate-platform/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? "/api";
const genericLoginError = "ไม่สามารถเข้าสู่ระบบได้ กรุณาตรวจสอบข้อมูลและลองอีกครั้ง";

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
      setError(genericLoginError);
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
        setError(genericLoginError);
        return;
      }
      router.push("/admin");
    } catch {
      setError(genericLoginError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="mt-8 space-y-5" method="post" onSubmit={submit} aria-describedby={error === null ? undefined : "login-error"}>
      <div>
        <label className="block text-sm font-semibold text-slate-700" htmlFor="email">อีเมลผู้ดูแลระบบ</label>
        <Input autoComplete="username" className="mt-2" disabled={submitting} id="email" invalid={error !== null} name="email" placeholder="name@organization.com" required type="email" />
      </div>
      <div>
        <label className="block text-sm font-semibold text-slate-700" htmlFor="password">รหัสผ่าน</label>
        <Input autoComplete="current-password" className="mt-2" disabled={submitting} id="password" invalid={error !== null} name="password" placeholder="กรอกรหัสผ่าน" required type="password" />
      </div>
      {error === null ? null : <div id="login-error"><Alert>{error}</Alert></div>}
      <Button className="mt-1 min-h-11 w-full" disabled={submitting} type="submit">
        {submitting ? <><span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white" aria-hidden="true" />กำลังเข้าสู่ระบบ…</> : "เข้าสู่ระบบ"}
      </Button>
    </form>
  );
}
