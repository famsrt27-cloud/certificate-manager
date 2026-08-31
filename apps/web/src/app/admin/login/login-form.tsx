"use client";

import { LoginRequestSchema, LoginResponseSchema, MfaCodeRequestSchema, MfaCompletionResponseSchema } from "@certificate-platform/contracts";
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
  const [mfaStatus, setMfaStatus] = useState<"MFA_REQUIRED" | "MFA_ENROLLMENT_REQUIRED" | null>(null);
  const [provisioningUri, setProvisioningUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);

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
      const parsed = LoginResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        setError(genericLoginError);
        return;
      }
      if ("status" in parsed.data.data) {
        setMfaStatus(parsed.data.data.status);
        setProvisioningUri(parsed.data.data.status === "MFA_ENROLLMENT_REQUIRED"
          ? parsed.data.data.provisioning_uri
          : null);
      } else {
        router.push("/admin");
      }
    } catch {
      setError(genericLoginError);
    } finally {
      setSubmitting(false);
    }
  };

  const submitMfa = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const input = MfaCodeRequestSchema.safeParse({ code: form.get("code") });
    if (!input.success) {
      setError(genericLoginError);
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`${apiBasePath}/admin/auth/mfa`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.data)
      });
      const parsed = MfaCompletionResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) {
        setError(genericLoginError);
        return;
      }
      if (parsed.data.data.recovery_codes !== undefined) {
        setRecoveryCodes(parsed.data.data.recovery_codes);
      } else {
        router.push("/admin");
      }
    } catch {
      setError(genericLoginError);
    } finally {
      setSubmitting(false);
    }
  };

  if (recoveryCodes !== null) return (
    <section className="mt-8 space-y-5" aria-labelledby="recovery-heading">
      <div>
        <h2 className="text-lg font-semibold text-slate-950" id="recovery-heading">บันทึกรหัสกู้คืน</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">รหัสแต่ละรายการใช้ได้เพียงครั้งเดียว เก็บไว้ในที่ปลอดภัย และอย่าแชร์กับผู้อื่น</p>
      </div>
      <ul className="grid grid-cols-1 gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 font-mono text-sm text-slate-900 sm:grid-cols-2">
        {recoveryCodes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <Button className="min-h-11 w-full" onClick={() => router.push("/admin")} type="button">ฉันบันทึกรหัสแล้ว</Button>
    </section>
  );

  if (mfaStatus !== null) {
    const secret = provisioningUri === null ? null : new URL(provisioningUri).searchParams.get("secret");
    return (
      <form className="mt-8 space-y-5" method="post" onSubmit={submitMfa} aria-describedby={error === null ? undefined : "login-error"}>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            {mfaStatus === "MFA_ENROLLMENT_REQUIRED" ? "ตั้งค่าการยืนยันตัวตนสองขั้นตอน" : "ยืนยันรหัสความปลอดภัย"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {mfaStatus === "MFA_ENROLLMENT_REQUIRED"
              ? "เพิ่มคีย์นี้ในแอป Authenticator แล้วกรอกรหัส 6 หลักเพื่อเปิดใช้งาน"
              : "กรอกรหัส 6 หลักจากแอป Authenticator หรือรหัสกู้คืนที่ยังไม่เคยใช้"}
          </p>
        </div>
        {secret === null ? null : (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-blue-800">คีย์สำหรับตั้งค่า</p>
            <code className="mt-2 block break-all text-sm font-semibold tracking-wider text-slate-950">{secret}</code>
          </div>
        )}
        <div>
          <label className="block text-sm font-semibold text-slate-700" htmlFor="code">รหัสยืนยัน</label>
          <Input autoComplete="one-time-code" className="mt-2" disabled={submitting} id="code"
            inputMode={mfaStatus === "MFA_ENROLLMENT_REQUIRED" ? "numeric" : "text"} invalid={error !== null}
            name="code" placeholder="000000" required />
        </div>
        {error === null ? null : <div id="login-error"><Alert>{error}</Alert></div>}
        <Button className="min-h-11 w-full" disabled={submitting} type="submit">
          {submitting ? "กำลังตรวจสอบ…" : "ยืนยันและเข้าสู่ระบบ"}
        </Button>
      </form>
    );
  }

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
