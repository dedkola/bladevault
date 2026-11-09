'use client'

import { useEffect, useState } from 'react'
import { formatDimension, formatWeight } from '@/lib/measurements'
import type { DimensionUnit } from '@/lib/settings-shared'
import {
  maintenanceTypeName,
  type Knife,
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
          <ul data-inspector-history>
            <li>
              <b>Catalogued</b>
              <span>{new Date(knife.addedAt).toLocaleDateString()}</span>
            </li>
            {knife.updatedAt !== knife.addedAt && (
              <li>
                <b>Record updated</b>
                <span>{new Date(knife.updatedAt).toLocaleDateString()}</span>
              </li>
            )}
            {!maintenanceTab && (
              <MaintenanceList
                events={maintenance.events}
                status={maintenance.status}
              />
            )}
          </ul>
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
