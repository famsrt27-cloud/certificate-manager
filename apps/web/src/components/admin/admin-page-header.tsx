export function AdminPageHeader({ eyebrow, title, description }: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header className="mb-6 border-b border-slate-200 pb-5 sm:mb-7 sm:pb-6">
      <p className="text-xs font-semibold tracking-[0.1em] text-[#2557a7] uppercase">{eyebrow}</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] text-slate-950 sm:text-[28px]">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
    </header>
  );
}
