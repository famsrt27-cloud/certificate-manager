import type { ReactNode } from "react";

export function DashboardSection({ title, description, children, id }: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly id: string;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950" id={id}>{title}</h2>
        {description === undefined ? null : <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}
