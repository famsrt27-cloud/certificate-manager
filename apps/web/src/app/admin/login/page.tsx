import type { Metadata } from "next";

import { BrandMark } from "../../../components/brand-mark";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "เข้าสู่ระบบผู้ดูแล"
};

export default function AdminLoginPage() {
  return (
    <main className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,0.82fr)_minmax(540px,1fr)]">
      <section className="relative hidden overflow-hidden bg-[#172033] px-12 py-10 text-white lg:flex lg:min-h-dvh lg:flex-col xl:px-16 xl:py-12" aria-label="ข้อมูลผลิตภัณฑ์">
        <BrandMark inverse />
        <div className="my-auto max-w-lg pb-10">
          <p className="mb-5 text-sm font-semibold tracking-[0.12em] text-blue-200 uppercase">Certificate Management Platform</p>
          <h2 className="text-4xl font-semibold leading-[1.35] tracking-[-0.025em] xl:text-[42px]">
            จัดการใบประกาศนียบัตร<br />อย่างเป็นระบบและปลอดภัย
          </h2>
          <p className="mt-6 max-w-md text-base leading-8 text-slate-300">
            บริหารโครงการ การอบรม ผู้เข้าร่วม เทมเพลต และใบประกาศนียบัตรในพื้นที่ทำงานเดียว
          </p>
        </div>
        <p className="text-xs leading-5 text-slate-400">สำหรับผู้ดูแลระบบที่ได้รับอนุญาตเท่านั้น</p>
        <div className="pointer-events-none absolute -right-28 bottom-24 size-72 rounded-full border border-white/6" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-12 bottom-40 size-40 rounded-full border border-white/8" aria-hidden="true" />
      </section>

      <section className="flex min-h-dvh items-center justify-center px-5 py-8 sm:px-8 lg:px-12" aria-labelledby="login-title">
        <div className="w-full max-w-[440px]">
          <div className="mb-10 lg:hidden">
            <BrandMark />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#2557a7]">ยินดีต้อนรับกลับ</p>
            <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.025em] text-slate-950 sm:text-[32px]" id="login-title">เข้าสู่ระบบผู้ดูแล</h1>
            <p className="mt-3 text-[15px] leading-7 text-slate-600">กรอกข้อมูลบัญชีที่ได้รับสิทธิ์จากองค์กรของคุณ</p>
          </div>
          <LoginForm />
          <p className="mt-8 border-t border-slate-200 pt-6 text-center text-xs leading-5 text-slate-500">
            ระบบนี้ใช้สำหรับงานบริหารจัดการภายในองค์กร
          </p>
        </div>
      </section>
    </main>
  );
}
