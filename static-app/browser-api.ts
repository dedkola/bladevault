import { DEFAULT_SETTINGS, type AppSettings } from '@/lib/settings-shared'
import {
  toKnifeListItem,
  type Knife,
  type KnifeUpdates,
  type AuditLogEvent,
  type MaintenanceEvent,
  type KnifeActivityEvent,
  isMaintenanceType,
} from '@/lib/data'
import {
  comparisonCommandSchema,
  LEGACY_COMPARISON_ID,
  type Comparison,
} from '@/lib/comparisons'
import type { SmartCollection } from '@/lib/smart-collections'
import { IDLE_CLOUD_BACKUP_JOB } from '@/lib/cloud-backup-shared'
import { IDLE_CLOUD_RESTORE_JOB } from '@/lib/cloud-restore-shared'

const SESSION_KEY = 'bladevault:static-session:v1'
export const STATIC_VAULT_STATUS = {
  generation: 'browser-session',
  phase: 'idle' as const,
  readOnly: false,
  appLockEnabled: false,
}

type State = {
  knives: Knife[]
  settings: AppSettings
  lists: Comparison[]
  collections: SmartCollection[]
  events: AuditLogEvent[]
  activity: KnifeActivityEvent[]
  maintenance: Record<string, MaintenanceEvent[]>
}

function emptyState(): State {
  return {
    knives: [],
    settings: {
      ...DEFAULT_SETTINGS,
      mcpEnabled: false,
      mcpWriteEnabled: false,
    },
    lists: [
      {
        id: LEGACY_COMPARISON_ID,
        name: 'Comparison',
        ids: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        differencesOnly: false,
        revision: 0,
      },
    ],
    collections: [],
    events: [],
    activity: [],
    maintenance: {},
  }
}

let state: State | null = null
function getState(): State {
  if (state) return state
  try {
    const saved = sessionStorage.getItem(SESSION_KEY)
    const parsed = saved ? (JSON.parse(saved) as State) : null
    if (
      parsed &&
      Array.isArray(parsed.knives) &&
      Array.isArray(parsed.lists) &&
      Array.isArray(parsed.events) &&
      Array.isArray(parsed.collections) &&
      Array.isArray(parsed.activity) &&
      parsed.settings &&
      parsed.maintenance
    )
      state = parsed
  } catch {
    /* Start empty if session storage is unavailable or invalid. */
  }
  return (state ??= emptyState())
}

function save() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(getState()))
}

export function resetSession() {
  state = null
  sessionStorage.removeItem(SESSION_KEY)
}
export function readSessionKnife(id: string) {
  return getState().knives.find((k) => k.id === id)
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'X-BladeVault-Vault-Generation': STATIC_VAULT_STATUS.generation,
    },
  })
}
function unavailable() {
  return json(
    {
      error:
        'This feature needs the desktop or self-hosted app. This website runs in your browser.',
    },
    501,
  )
}

function record(type: 'created' | 'updated' | 'deleted', knife: Knife) {
  const db = getState(),
    now = new Date().toISOString()
  db.events.unshift({
    id: (db.events[0]?.id ?? 0) + 1,
    operationId: crypto.randomUUID(),
    type,
    knifeId: type === 'deleted' ? null : knife.id,
    subject: knife.name,
    actor: 'You',
    source: 'browser',
    summary: `${type[0].toUpperCase()}${type.slice(1)} ${knife.name}`,
    changes: [],
    occurredAt: now,
  })
  if (type !== 'deleted')
    db.activity.push({ knifeId: knife.id, type, occurredAt: now })
}

function updateKnife(knife: Knife, updates: KnifeUpdates) {
  const updated: Knife = {
    ...knife,
    ...updates,
    id: knife.id,
    addedAt: knife.addedAt,
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(knife.updatedAt) + 1),
    ).toISOString(),
    specs: { ...knife.specs, ...updates.specs },
    customFields: Object.fromEntries(
      Object.entries({ ...knife.customFields, ...updates.customFields }).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  }
  getState().knives = getState().knives.map((k) =>
    k.id === knife.id ? updated : k,
  )
  record('updated', updated)
  return updated
}

function handle(request: Request, body: Record<string, unknown>) {
  const db = getState(),
    path = new URL(request.url).pathname,
    method = request.method
  if (path === '/api/vault/status') return json(STATIC_VAULT_STATUS)
  if (path === '/api/runtime-config')
    return json({ authUrl: '', backupUrl: '' })
  if (path === '/api/cloud-backup/job' && method === 'GET')
    return json({ job: IDLE_CLOUD_BACKUP_JOB })
  if (path === '/api/cloud-backup/restore-job' && method === 'GET')
    return json({ job: IDLE_CLOUD_RESTORE_JOB })
  if (path === '/api/app-lock' && method === 'GET')
    return json({ enabled: false, unlocked: true })
  if (path === '/api/activity' && method === 'GET')
    return json({ activity: db.activity })
  if (path === '/api/logs' && method === 'GET')
    return json({ events: db.events })
  if (path === '/api/settings/webpage-screenshots' && method === 'GET')
    return json({ items: [] })
  if (path === '/api/settings/mcp' && method === 'GET')
    return json({
      mcp: {
        enabled: false,
        writeEnabled: false,
        controls: {
          enabledManagedByEnvironment: true,
          writeEnabledManagedByEnvironment: true,
        },
        http: {
          path: '/mcp',
          authConfigured: false,
          authToken: '',
          authManagedByEnvironment: true,
          authRequiredForRemote: true,
        },
        tools: { read: 0, write: 0, total: 0 },
        activity: {
          lastActivityAt: null,
          httpRequestsSinceStart: 0,
          toolCallsSinceStart: 0,
          lastTransport: null,
        },
        stats: {
          knifeCount: db.knives.length,
          writeOperationCount: 0,
          changedKnifeCount: 0,
          lastWriteAt: null,
        },
      },
    })
  if (path === '/api/settings') {
    if (method === 'POST') {
      db.settings = {
        ...db.settings,
        ...body,
        cloudAutoBackupEnabled: false,
        mcpEnabled: false,
        mcpWriteEnabled: false,
      }
      save()
    }
    return json({
      settings: db.settings,
      localDataPath: 'Temporary browser session',
      defaultLocalDataPath: 'Temporary browser session',
      configuredLocalDataPath: null,
      dataDirManagedByEnv: false,
      isContainerized: false,
    })
  }
  if (path === '/api/knives') {
    if (method === 'GET')
      return json({ knives: db.knives.map(toKnifeListItem) })
    if (method === 'POST') {
      if (typeof body.name !== 'string' || !body.name.trim())
        return json({ error: 'Name is required' }, 400)
      const now = new Date().toISOString()
      const text = (key: string) =>
        typeof body[key] === 'string' ? (body[key] as string) : ''
      const knife: Knife = {
        id: crypto.randomUUID(),
        name: text('name').trim(),
        brand: text('brand'),
        bladeStyle: text('bladeStyle'),
        handleMaterial: text('handleMaterial'),
        description: text('description'),
        sourceUrl: text('sourceUrl'),
        pinned: body.pinned === true,
        addedAt: now,
        updatedAt: now,
        specs: {
          weight: '',
          overallLength: '',
          bladeLength: '',
          country: '',
          ...((body.specs as Partial<Knife['specs']>) ?? {}),
        },
        customFields: (body.customFields as Record<string, string>) ?? {},
        images: Array.isArray(body.imageUrls)
          ? body.imageUrls.filter(
              (src): src is string =>
                typeof src === 'string' && /^(https?:|data:image)/.test(src),
            )
          : [],
      }
      db.knives.unshift(knife)
      record('created', knife)
      save()
      return json({ knife })
    }
  }
  if (
    (path === '/api/knives/bulk' || path === '/api/knives/bulk/pin') &&
    method === 'PATCH'
  ) {
    const ids = Array.isArray(body.ids) ? body.ids : [],
      expected = body.expectedUpdatedAt as Record<string, string> | undefined
    const targets = db.knives.filter((k) => ids.includes(k.id))
    if (targets.some((k) => expected?.[k.id] && expected[k.id] !== k.updatedAt))
      return json({ error: 'Collection changed. Refresh and try again.' }, 409)
    const field = typeof body.field === 'string' ? body.field : '',
      value = typeof body.value === 'string' ? body.value : ''
    let updates: KnifeUpdates
    if (path.endsWith('/pin')) updates = { pinned: body.pinned === true }
    else if (
      [
        'name',
        'brand',
        'bladeStyle',
        'handleMaterial',
        'description',
        'sourceUrl',
      ].includes(field)
    )
      updates = { [field]: value }
    else if (
      /^specs\.(weight|overallLength|bladeLength|bladeThickness|bladeCoating|bladeMaterial|lockingMechanism|designer|modelNumber|handleLength|hardness|price|country)$/.test(
        field,
      )
    )
      updates = { specs: { [field.slice(6)]: value } }
    else if (
      /^customFields\.[a-zA-Z0-9_-]+$/.test(field) &&
      !['__proto__', 'constructor', 'prototype'].includes(field.slice(13))
    )
      updates = { customFields: { [field.slice(13)]: value } }
    else return json({ error: 'Unsupported field' }, 400)
    const knives = targets.map((k) => updateKnife(k, updates))
    save()
    return json({ knives })
  }
  const detail = path.match(/^\/api\/knives\/([^/]+)$/)
  if (detail) {
    const knife = readSessionKnife(decodeURIComponent(detail[1]))
    if (!knife) return json({ error: 'Knife not found' }, 404)
    if (method === 'GET') return json({ knife })
    if (method === 'PATCH') {
      const updated = updateKnife(knife, body as KnifeUpdates)
      save()
      return json({ knife: updated })
    }
    if (method === 'DELETE') {
      db.knives = db.knives.filter((k) => k.id !== knife.id)
      db.lists.forEach((l) => {
        l.ids = l.ids.filter((id) => id !== knife.id)
      })
      delete db.maintenance[knife.id]
      record('deleted', knife)
      save()
      return json({ success: true })
    }
  }
  if (path === '/api/compare') {
    let list = db.lists.find((l) => l.id === LEGACY_COMPARISON_ID)
    if (!list) {
      list = { ...emptyState().lists[0] }
      db.lists.unshift(list)
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : typeof body.id === 'string'
        ? [body.id]
        : []
    if (method === 'POST')
      list.ids = [...new Set([...list.ids, ...ids])].filter((id) =>
        db.knives.some((k) => k.id === id),
      )
    if (method === 'DELETE')
      list.ids = ids.length ? list.ids.filter((id) => !ids.includes(id)) : []
    if (method !== 'GET') {
      list.revision++
      save()
    }
    return json({ compareIds: list.ids })
  }
  if (path === '/api/comparisons') {
    if (method === 'GET') return json({ lists: db.lists })
    if (method !== 'POST') return unavailable()
    const parsed = comparisonCommandSchema.safeParse(body)
    if (!parsed.success)
      return json({ error: parsed.error.issues[0].message }, 400)
    const command = parsed.data,
      now = new Date().toISOString()
    let listId: string | undefined
    if (command.action === 'create') {
      const list = {
        id: crypto.randomUUID(),
        name: command.name,
        ids: command.ids.filter((id) => db.knives.some((k) => k.id === id)),
        createdAt: now,
        updatedAt: now,
        revision: 0,
        differencesOnly: false,
      }
      db.lists.push(list)
      listId = list.id
    } else if (command.action === 'restore') {
      const current = db.lists.find((l) => l.id === command.list.id)
      if (current && current.revision !== command.expectedRevision)
        return json(
          { error: 'Comparison changed. Refresh and try again.' },
          409,
        )
      db.lists = db.lists.filter((l) => l.id !== command.list.id)
      db.lists.push({
        ...command.list,
        revision: (current?.revision ?? command.list.revision) + 1,
      })
    } else if (command.action === 'memberships') {
      for (const change of command.changes) {
        const list = db.lists.find((l) => l.id === change.id)
        if (
          !list ||
          (change.expectedRevision !== undefined &&
            change.expectedRevision !== list.revision)
        )
          return json(
            { error: 'Comparison changed. Refresh and try again.' },
            409,
          )
      }
      for (const change of command.changes) {
        const list = db.lists.find((l) => l.id === change.id)!
        list.ids = change.selected
          ? [...new Set([...list.ids, ...command.ids])]
          : list.ids.filter((id) => !command.ids.includes(id))
        list.revision++
        list.updatedAt = now
      }
    } else {
      const list = db.lists.find((l) => l.id === command.id)
      if (!list) return json({ error: 'Comparison not found' }, 404)
      if (
        command.expectedRevision !== undefined &&
        command.expectedRevision !== list.revision
      )
        return json(
          { error: 'Comparison changed. Refresh and try again.' },
          409,
        )
      listId = list.id
      if (command.action === 'rename') list.name = command.name
      if (command.action === 'preference')
        list.differencesOnly = command.differencesOnly
      if (command.action === 'delete')
        db.lists = db.lists.filter((l) => l.id !== list.id)
      if (command.action === 'clear') list.ids = []
      if (command.action === 'add')
        list.ids = [...new Set([...list.ids, ...command.ids])].filter((id) =>
          db.knives.some((k) => k.id === id),
        )
      if (command.action === 'remove')
        list.ids = list.ids.filter((id) => !command.ids.includes(id))
      if (command.action === 'duplicate') {
        const copy = {
          ...list,
          id: crypto.randomUUID(),
          name: `${list.name} copy`.slice(0, 60),
          ids: [...list.ids],
          revision: 0,
        }
        db.lists.push(copy)
        listId = copy.id
      }
      list.revision++
      list.updatedAt = now
    }
    save()
    return json({ lists: db.lists, listId })
  }
  if (path === '/api/smart-collections') {
    if (method === 'GET') return json({ collections: db.collections })
    if (method === 'DELETE') {
      db.collections = db.collections.filter((c) => c.id !== body.id)
      save()
      return json({ success: true })
    }
    if (method === 'POST') {
      const collection = {
        ...body,
        id: typeof body.id === 'string' ? body.id : crypto.randomUUID(),
      } as SmartCollection
      db.collections = [
        ...db.collections.filter((c) => c.id !== collection.id),
        collection,
      ]
      save()
      return json({ collection })
    }
  }
  const maintenance = path.match(
    /^\/api\/knives\/([^/]+)\/maintenance(?:\/([^/]+))?$/,
  )
  if (maintenance) {
    const knifeId = decodeURIComponent(maintenance[1]),
      id = maintenance[2] ? Number(maintenance[2]) : undefined
    if (!readSessionKnife(knifeId))
      return json({ error: 'Knife not found' }, 404)
    const events = (db.maintenance[knifeId] ??= [])
    if (method === 'GET') return json({ events })
    if (method === 'DELETE') {
      db.maintenance[knifeId] = events.filter((e) => e.id !== id)
      save()
      return json({ success: true })
    }
    if (typeof body.type !== 'string' || !isMaintenanceType(body.type))
      return json({ error: 'Choose a maintenance type' }, 400)
    const now = new Date().toISOString()
    const event: MaintenanceEvent = {
      id: id ?? Date.now(),
      knifeId,
      type: body.type,
      occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : now,
      notes: typeof body.notes === 'string' ? body.notes : '',
      createdAt: now,
      sharpeningDetails:
        body.sharpeningDetails as MaintenanceEvent['sharpeningDetails'],
    }
    db.maintenance[knifeId] = [
      event,
      ...events.filter((e) => e.id !== event.id),
    ]
    db.activity.push({
      knifeId,
      type: 'maintained',
      occurredAt: event.occurredAt,
    })
    save()
    return json({ event })
  }
  return unavailable()
}

export function installBrowserApi() {
  const original = window.fetch
  const browserFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    )
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith('/api/')
    )
      return original(input, init)
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(url, init)
    if (request.signal.aborted)
      throw new DOMException('Request aborted', 'AbortError')
    const body: Record<string, unknown> =
      request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : await request.json().catch(() => ({}))
    const before = JSON.stringify(getState())
    try {
      return handle(request, body)
    } catch (error) {
      state = JSON.parse(before) as State
      return json(
        {
          error:
            error instanceof DOMException && error.name === 'QuotaExceededError'
              ? 'This browser tab is full. Remove an image or clear the session.'
              : error instanceof Error
                ? error.message
                : 'Could not update this browser session.',
        },
        400,
      )
    }
  }
  window.fetch = browserFetch
  return () => {
    if (window.fetch === browserFetch) window.fetch = original
  }
}
