import type { ReactNode } from "react";

export function MetricCard({ label, value, detail, icon }: {
  readonly label: string;
  readonly value: number;
  readonly detail: string;
  readonly icon: ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)] sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600">{label}</p>
          <p className="mt-1.5 text-[28px] font-semibold tracking-[-0.03em] text-slate-950 tabular-nums">{value.toLocaleString("th-TH")}</p>
        </div>
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-[#2557a7]" aria-hidden="true">{icon}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>
    </article>
  );
}
