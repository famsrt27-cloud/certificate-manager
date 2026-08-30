import type { ReactNode } from "react";

export function AdminPageHeader({ eyebrow, title, description, action }: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:mb-7 sm:flex-row sm:items-end sm:justify-between sm:gap-6 sm:pb-6">
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-[0.1em] text-[#2557a7] uppercase">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-[28px]">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </header>
  );
}
