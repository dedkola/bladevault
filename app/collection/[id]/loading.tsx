function SkeletonBlock({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-md bg-[color:var(--bladevault-surface-soft)] ${className}`}
    />
  )
}

export default function KnifeDetailLoading() {
  return (
    <div className="flex-1 p-6 lg:p-8 w-full" role="status" aria-live="polite">
      <span className="sr-only">Loading knife details</span>

      <div className="motion-safe:animate-pulse" aria-hidden="true">
        <div className="mb-4 flex items-center gap-2">
          <SkeletonBlock className="h-4 w-12" />
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="h-4 w-28" />
        </div>

        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <SkeletonBlock className="h-7 w-64 max-w-full" />
          <div className="flex flex-wrap gap-2">
            <SkeletonBlock className="h-8 w-24" />
            <SkeletonBlock className="h-8 w-20" />
            <SkeletonBlock className="h-8 w-16" />
            <SkeletonBlock className="h-8 w-20" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_380px] 2xl:grid-cols-[1.5fr_420px]">
          <div className="flex flex-col gap-6">
            <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background">
              <SkeletonBlock className="h-[26rem] w-full rounded-none" />
              <div className="flex gap-2 border-t border-[var(--bladevault-line)] p-3">
                <SkeletonBlock className="size-14" />
                <SkeletonBlock className="size-14" />
                <SkeletonBlock className="size-14" />
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background">
              <div className="border-b border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)]/70 px-4 py-3">
                <SkeletonBlock className="h-5 w-20 bg-background/80" />
              </div>
              <div className="space-y-2 p-4">
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-4 w-5/6" />
                <SkeletonBlock className="h-4 w-2/3" />
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--bladevault-line)] bg-background">
            <div className="border-b border-[var(--bladevault-line)] bg-[color:var(--bladevault-surface-soft)]/70 px-4 py-3">
              <SkeletonBlock className="h-5 w-28 bg-background/80" />
            </div>
            <div className="divide-y divide-[var(--bladevault-line)]/60 px-4">
              {Array.from({ length: 11 }, (_, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-6 py-3"
                >
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock
                    className={`h-4 ${index % 3 === 0 ? 'w-28' : 'w-20'}`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
