"use client";

import Link from "next/link";

import { AdminPageHeader } from "../../../components/admin/admin-page-header";
import { useAdminContext } from "../admin-context";

export default function CertificatesPage() {
  const { membership } = useAdminContext();
  const permissions = new Set(membership.permissions);
  return <><AdminPageHeader eyebrow="ผลลัพธ์การรับรอง" title="ใบประกาศนียบัตร" description="พื้นที่สำหรับติดตามและดำเนินการออกใบประกาศนียบัตรขององค์กร" />
    <section className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8" aria-labelledby="certificate-foundation-title">
      <div className="max-w-2xl">
        <span className="inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-[#2557a7]">พื้นที่การทำงาน</span>
        <h2 className="mt-4 text-xl font-semibold text-slate-950" id="certificate-foundation-title">เตรียมข้อมูลให้พร้อมก่อนออกใบประกาศนียบัตร</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">ตรวจสอบว่าองค์กรมีโครงการ การอบรม ผู้เข้าร่วม และเทมเพลตที่เผยแพร่แล้ว การจัดการรายการใบประกาศแบบเต็มจะได้รับการออกแบบในส่วนถัดไป</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link className="inline-flex min-h-10 items-center rounded-lg bg-[#2557a7] px-4 text-sm font-semibold text-white hover:bg-[#1e478c] focus:outline-none focus:ring-3 focus:ring-blue-200" href="/admin">ตรวจสอบความพร้อม</Link>
          {permissions.has("template:read") ? <Link className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-3 focus:ring-blue-100" href="/admin/templates">ดูเทมเพลต</Link> : null}
        </div>
      </div>
    </section></>;
}
