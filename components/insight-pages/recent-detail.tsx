'use client'

import { useMemo, useState } from 'react'
import { useKnives } from '@/components/providers/knives-provider'
import {
  InsightKnifeCard,
  InsightKnifeRow,
  InsightMetrics,
  InsightPanel,
} from '@/components/insight-pages/detail-primitives'

export function RecentDetail() {
  const { knives } = useKnives(),
    [query, setQuery] = useState('')
  const recent = useMemo(
    () =>
      [...knives].sort(
        (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
      ),
    [knives],
  )
  const filtered = useMemo(
    () =>
      recent.filter((knife) =>
        [knife.brand, knife.name, knife.specs.bladeMaterial]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [recent, query],
  )
  const formatDate = (value?: string) =>
    value
      ? new Date(value).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : '—'
  const latest = recent[0],
    first = recent.at(-1)
  return (
    <div className="id-recent">
      <InsightMetrics
        items={[
          {
            value: recent.length,
            label: 'Addition records',
            helper: 'Every knife remains available in the list',
          },
          {
            value: formatDate(latest?.addedAt),
            label: 'Latest addition',
            helper: latest ? `${latest.brand} · ${latest.name}` : undefined,
          },
          {
            value: formatDate(first?.addedAt),
            label: 'First addition',
            helper: first ? `${first.brand} · ${first.name}` : undefined,
          },
        ]}
      />
      <div className="id-grid id-recent-grid">
        <InsightPanel
          title="Latest additions"
          description="Six newest records · select a knife to inspect"
        >
          <div className="id-mini-cards">
            {recent.slice(0, 6).map((knife) => (
              <InsightKnifeCard key={knife.id} knife={knife} />
            ))}
          </div>
        </InsightPanel>
        <InsightPanel
          title="All additions"
          description={`${recent.length} knives · newest first`}
          footer={
            <>
              <span aria-live="polite">{filtered.length} records</span>
              <span>Original added dates</span>
            </>
          }
        >
          <input
            className="id-search"
            type="search"
            aria-label="Search additions"
            placeholder="Search maker, model or steel…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="id-scroll">
            {filtered.length ? (
              filtered.map((knife) => (
                <InsightKnifeRow key={knife.id} knife={knife} />
              ))
            ) : (
              <p className="py-5 text-sm text-muted-foreground">
                No matching records.
              </p>
            )}
          </div>
        </InsightPanel>
      </div>
    </div>
  )
}
