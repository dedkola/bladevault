'use client'

import { useEffect, useState } from 'react'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'
import {
  maintenanceTypeName,
  type Knife,
  type KnifeNote,
  type MaintenanceEvent,
} from '@/lib/data'

type InspectorTab = 'overview' | 'specifications' | 'maintenance' | 'history'

type MaintenanceState = {
  knifeId: string
  status: 'ready' | 'error'
  events: MaintenanceEvent[]
}

/**
 * Loads a knife's maintenance log once a tab that shows it is opened. Results
 * are keyed by knife id so a previously selected knife's events never appear
 * while the next one loads.
 */
function useMaintenanceEvents(knifeId: string, enabled: boolean) {
  const [state, setState] = useState<MaintenanceState | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetch(`/api/knives/${encodeURIComponent(knifeId)}/maintenance`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('History unavailable')
        const data = (await response.json()) as { events?: MaintenanceEvent[] }
        setState({ knifeId, status: 'ready', events: data.events ?? [] })
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ knifeId, status: 'error', events: [] })
      })
    return () => controller.abort()
  }, [enabled, knifeId])
  const current = state?.knifeId === knifeId ? state : null
  return {
    events: current?.events ?? [],
    status: current?.status ?? ('loading' as const),
  }
}

type NotesState = {
  knifeId: string
  status: 'ready' | 'error'
  notes: KnifeNote[]
}

/** Loads a knife's own dated notes for the History tab, keyed by knife id. */
function useKnifeNotes(knifeId: string, enabled: boolean) {
  const [state, setState] = useState<NotesState | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    fetch(`/api/knives/${encodeURIComponent(knifeId)}/notes`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Notes unavailable')
        const data = (await response.json()) as { notes?: KnifeNote[] }
        setState({ knifeId, status: 'ready', notes: data.notes ?? [] })
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ knifeId, status: 'error', notes: [] })
      })
    return () => controller.abort()
  }, [enabled, knifeId])
  const current = state?.knifeId === knifeId ? state : null
  return {
    notes: current?.notes ?? [],
    status: current?.status ?? ('loading' as const),
  }
}

const NOTE_PREVIEW_LENGTH = 140

function previewNote(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > NOTE_PREVIEW_LENGTH
    ? `${flat.slice(0, NOTE_PREVIEW_LENGTH - 1).trimEnd()}…`
    : flat
}

function MaintenanceList({
  events,
  status,
}: {
  events: MaintenanceEvent[]
  status: 'loading' | 'ready' | 'error'
}) {
  if (status === 'loading')
    return <li role="status">Loading maintenance history…</li>
  if (status === 'error')
    return (
      <li role="status">
        Maintenance history is unavailable. Open the knife to retry.
      </li>
    )
  return events.map((event) => (
    <li key={event.id}>
      <b>{maintenanceTypeName(event.type)}</b>
      <span>
        {new Date(event.occurredAt).toLocaleDateString()}
        {event.notes ? ` · ${event.notes}` : ''}
      </span>
    </li>
  ))
}

type HistoryRow = {
  key: string
  label: string
  detail: string
  day: number
}

function startOfDay(isoString: string): number {
  const date = new Date(isoString)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Merges record milestones, maintenance entries and the collector's notes into one list ordered
 * newest first, so the History tab reads like a reverse-chronological log.
 */
function buildHistoryRows(
  knife: Knife,
  events: MaintenanceEvent[],
  notes: KnifeNote[] = [],
): HistoryRow[] {
  const rows: HistoryRow[] = [
    {
      key: 'catalogued',
      label: 'Catalogued',
      detail: new Date(knife.addedAt).toLocaleDateString(),
      day: startOfDay(knife.addedAt),
    },
  ]
  if (knife.updatedAt !== knife.addedAt) {
    rows.push({
      key: 'updated',
      label: 'Record updated',
      detail: new Date(knife.updatedAt).toLocaleDateString(),
      day: startOfDay(knife.updatedAt),
    })
  }
  for (const event of events) {
    rows.push({
      key: `maintenance-${event.id}`,
      label: maintenanceTypeName(event.type),
      detail: `${new Date(event.occurredAt).toLocaleDateString()}${
        event.notes ? ` · ${event.notes}` : ''
      }`,
      day: startOfDay(event.occurredAt),
    })
  }
  for (const note of notes) {
    rows.push({
      key: `note-${note.id}`,
      label: 'Note',
      detail: `${new Date(note.notedAt).toLocaleDateString()} · ${previewNote(
        note.body,
      )}`,
      day: startOfDay(note.notedAt),
    })
  }
  return rows.sort((a, b) => b.day - a.day)
}

function HistoryList({
  knife,
  events,
  status,
  notes,
  notesStatus,
}: {
  knife: Knife
  events: MaintenanceEvent[]
  status: 'loading' | 'ready' | 'error'
  notes: KnifeNote[]
  notesStatus: 'loading' | 'ready' | 'error'
}) {
  const rows = buildHistoryRows(
    knife,
    status === 'ready' ? events : [],
    notesStatus === 'ready' ? notes : [],
  )
  return (
    <ul data-inspector-history>
      {rows.map((row) => (
        <li key={row.key}>
          <b>{row.label}</b>
          <span>{row.detail}</span>
        </li>
      ))}
      {status === 'loading' && (
        <li role="status">Loading maintenance history…</li>
      )}
      {status === 'error' && (
        <li role="status">
          Maintenance history is unavailable. Open the knife to retry.
        </li>
      )}
      {notesStatus === 'loading' && <li role="status">Loading notes…</li>}
      {notesStatus === 'error' && (
        <li role="status">Notes are unavailable. Open the knife to retry.</li>
      )}
    </ul>
  )
}

/**
 * The inspector's tab strip and panel: Overview, Specifications and History,
 * plus an optional Maintenance tab. Without that tab, History also lists the
 * maintenance log.
 */
export function InspectorTabs({
  knife,
  variant = 'modern',
  dimensionUnit = 'in',
  maintenanceTab = false,
}: {
  knife: Knife
  variant?: 'modern' | 'alloy'
  dimensionUnit?: DimensionUnit
  maintenanceTab?: boolean
}) {
  const tabs: readonly InspectorTab[] = maintenanceTab
    ? ['overview', 'specifications', 'maintenance', 'history']
    : ['overview', 'specifications', 'history']
  const [tab, setTab] = useState<InspectorTab>('overview')
  const maintenance = useMaintenanceEvents(
    knife.id,
    tab === 'maintenance' || (tab === 'history' && !maintenanceTab),
  )
  const knifeNotes = useKnifeNotes(knife.id, tab === 'history')
  const specs =
    tab === 'overview'
      ? variant === 'alloy'
        ? [
            [
              'Blade length',
              formatDimension(knife.specs.bladeLength, dimensionUnit) ||
                'Not recorded',
            ],
            [
              'Weight',
              formatWeight(knife.specs.weight, dimensionUnit) || 'Not recorded',
            ],
            ['Blade steel', knife.specs.bladeMaterial],
            ['Handle', knife.handleMaterial],
          ]
        : [
            ['Maker', knife.brand],
            ['Designer', knife.specs.designer],
            ['Lock', knife.specs.lockingMechanism],
            [
              'Weight',
              formatWeight(knife.specs.weight, dimensionUnit) || 'Not recorded',
            ],
            ['Handle', knife.handleMaterial],
            ['Family', knife.name],
          ]
      : [
          ['Blade material', knife.specs.bladeMaterial],
          ['Hardness', knife.specs.hardness],
          [
            'Blade length',
            formatDimension(knife.specs.bladeLength, dimensionUnit) ||
              'Not recorded',
          ],
          [
            'Overall length',
            formatDimension(knife.specs.overallLength, dimensionUnit) ||
              'Not recorded',
          ],
          [
            'Thickness',
            formatDimension(knife.specs.bladeThickness, dimensionUnit) ||
              'Not recorded',
          ],
          ['Finish', knife.specs.bladeCoating],
          ['Lock', knife.specs.lockingMechanism],
          ['Model', knife.specs.modelNumber],
          [
            'Handle length',
            formatDimension(knife.specs.handleLength, dimensionUnit) ||
              'Not recorded',
          ],
          ['Country', knife.specs.country],
          ['Price', knife.specs.price],
        ]

  return (
    <>
      <div data-inspector-tabs role="tablist" aria-label="Knife information">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            id={`inspector-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`inspector-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const index = tabs.indexOf(value)
              const next =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % tabs.length]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + tabs.length - 1) % tabs.length]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[tabs.length - 1]
                        : null
              if (next) {
                event.preventDefault()
                setTab(next)
                document.getElementById(`inspector-tab-${next}`)?.focus()
              }
            }}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <div
        data-inspector-panel
        id={`inspector-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
      >
        {tab === 'overview' && (
          <>
            <p data-inspector-note>
              {variant === 'alloy' && (
                <span data-alloy-note-label>Collector’s note</span>
              )}
              {knife.description || 'No notes recorded.'}
            </p>
            <div data-inspector-chips>
              {[
                knife.specs.bladeMaterial,
                knife.specs.bladeLength
                  ? formatDimension(knife.specs.bladeLength, dimensionUnit) ||
                    'Not recorded'
                  : '',
                knife.bladeStyle,
              ]
                .filter(Boolean)
                .map((value, index) => (
                  <span key={`${value}-${index}`}>{value}</span>
                ))}
            </div>
          </>
        )}
        {tab === 'maintenance' && (
          <ul data-inspector-history>
            <MaintenanceList
              events={maintenance.events}
              status={maintenance.status}
            />
            {maintenance.status === 'ready' &&
              maintenance.events.length === 0 && (
                <li role="status">No maintenance logged yet.</li>
              )}
          </ul>
        )}
        {tab === 'history' && (
          <HistoryList
            knife={knife}
            events={maintenanceTab ? [] : maintenance.events}
            status={maintenanceTab ? 'ready' : maintenance.status}
            notes={knifeNotes.notes}
            notesStatus={knifeNotes.status}
          />
        )}
        {(tab === 'overview' || tab === 'specifications') && (
          <dl data-inspector-specs>
            {specs.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || 'Not recorded'}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  )
}
