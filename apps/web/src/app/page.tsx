import Link from "next/link";

import { PublicHeader } from "../components/public/public-header";

const capabilities = [
  ["ค้นหาใบประกาศ", "ค้นหาด้วยเลขที่ใบประกาศ หรือชื่อผู้รับพร้อมโครงการ"],
  ["ตรวจสอบความถูกต้อง", "ดูสถานะล่าสุดจากข้อมูลของผู้ออกใบประกาศ"],
  ["ดาวน์โหลด PDF", "ดาวน์โหลดใบประกาศที่พร้อมใช้งานได้โดยตรง"],
  ["ตรวจสอบด้วย QR", "สแกน QR บนใบประกาศเพื่อเปิดหน้าตรวจสอบทันที"]
] as const;

export default function PublicLandingPage() {
  return <div className="min-h-dvh overflow-x-hidden bg-[#f7f5ef] text-[#172a27]">
    <PublicHeader current="/" />
    <main>
      <section className="relative isolate overflow-hidden border-b border-[#dfe1d9]">
        <div className="absolute inset-0 -z-10 opacity-60" aria-hidden="true"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, rgba(25,71,64,.14) 1px, transparent 0)", backgroundSize: "26px 26px" }} />
        <div className="absolute -right-32 top-4 -z-10 size-96 rounded-full bg-[#dce8df] blur-3xl" aria-hidden="true" />
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-16 sm:px-6 sm:py-24 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)] lg:items-center lg:py-28">
          <div>
            <p className="text-sm font-semibold tracking-[0.12em] text-[#467269]">CERTIFICATE PLATFORM</p>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.22] tracking-[-0.025em] text-[#143c36] sm:text-5xl lg:text-[3.65rem]">ตรวจสอบและดาวน์โหลด<br className="hidden sm:block" />ใบประกาศของคุณ</h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-[#5f6e69] sm:text-lg">ค้นหาใบประกาศที่พร้อมใช้งาน ตรวจสอบข้อมูล และดาวน์โหลดไฟล์ PDF ได้ในที่เดียว</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[#174f46] px-6 py-3 font-semibold text-white shadow-[0_12px_30px_rgba(23,79,70,.2)] transition hover:-translate-y-0.5 hover:bg-[#103f38]" href="/verify">ค้นหาใบประกาศ<span className="ml-2" aria-hidden="true">→</span></Link>
              <Link className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[#b9c5bd] bg-[#fbfaf6] px-6 py-3 font-semibold text-[#284a44] transition hover:border-[#8ca69b] hover:bg-white" href="/admin/login">สำหรับผู้ดูแลระบบ</Link>
            </div>
          </div>
          <div className="relative mx-auto w-full max-w-md lg:mr-0" aria-hidden="true">
            <div className="absolute -inset-5 rotate-3 rounded-[2rem] border border-[#bdc9bf] bg-[#edf0e7]" />
            <div className="relative overflow-hidden rounded-[1.75rem] border border-[#d6d8ce] bg-[#fffdf8] p-7 shadow-[0_24px_70px_rgba(33,55,48,.14)] sm:p-9">
              <div className="flex items-center justify-between border-b border-[#e6e2d7] pb-5"><span className="grid size-12 place-items-center rounded-full border border-[#92b1a4] bg-[#e8f1eb] font-semibold text-[#174f46]">CP</span><span className="rounded-full bg-[#e7f2ec] px-3 py-1 text-xs font-semibold text-[#17624f]">พร้อมใช้งาน</span></div>
              <div className="py-8 text-center"><svg className="mx-auto size-20 text-[#a0783c]" viewBox="0 0 80 80" fill="none"><circle cx="40" cy="34" r="24" stroke="currentColor" strokeWidth="1.5" /><path d="m25 54-2 20 17-9 17 9-2-20M30 34l7 7 14-15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="mx-auto mt-6 h-3 w-40 rounded bg-[#d8ddd7]" /><div className="mx-auto mt-3 h-2.5 w-56 max-w-full rounded bg-[#eceae2]" /></div>
              <div className="grid grid-cols-3 gap-3 border-t border-[#e6e2d7] pt-5">{Array.from({ length: 3 }, (_, index) => <div className="h-2 rounded bg-[#e4e6df]" key={index} />)}</div>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-20" aria-labelledby="capability-title">
        <div className="max-w-xl"><p className="text-sm font-semibold text-[#a0783c]">ใช้งานได้ง่าย</p><h2 className="mt-2 text-2xl font-semibold text-[#183f39] sm:text-3xl" id="capability-title">ทุกขั้นตอนสำคัญสำหรับใบประกาศ</h2></div>
        <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-[#d9ddd5] bg-[#d9ddd5] sm:grid-cols-2 lg:grid-cols-4">{capabilities.map(([title, description], index) => <article className="min-h-44 bg-[#fffdf8] p-6" key={title}><span className="text-sm font-semibold tabular-nums text-[#9a7842]">0{index + 1}</span><h3 className="mt-5 font-semibold text-[#1c403a]">{title}</h3><p className="mt-2 text-sm leading-6 text-[#68736f]">{description}</p></article>)}</div>
      </section>
    </main>
    <footer className="border-t border-[#d9ddd5] px-5 py-7 text-center text-sm text-[#6e7874]">Certificate Platform</footer>
  </div>;
}
