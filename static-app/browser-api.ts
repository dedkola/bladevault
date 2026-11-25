import { markStaticBrowserApp } from '@/lib/runtime-capabilities'
import {
  DEFAULT_ACHIEVEMENTS,
  DEFAULT_MAINTENANCE_REMINDERS,
  normalizeAchievementSettings,
  DEFAULT_SETTINGS,
  normalizeCareDeferrals,
  normalizeCareIntervalOverrides,
  normalizeMaintenanceReminders,
  normalizeCardFields,
  normalizeStartPage,
  normalizeDimensionUnit,
  type AppSettings,
} from '@/lib/settings-shared'
import {
  toKnifeListItem,
  type Knife,
  type KnifeUpdates,
  type AuditLogEvent,
  type MaintenanceEvent,
  type KnifeActivityEvent,
  KNIFE_NOTE_MAX_IMAGES,
  type KnifeNote,
  isMaintenanceType,
} from '@/lib/data'
import {
  comparisonCommandSchema,
  LEGACY_COMPARISON_ID,
  type Comparison,
} from '@/lib/comparisons'
import type { SmartCollection } from '@/lib/smart-collections'
import {
  buildLatestByKnife,
  getCareStatuses,
  type MaintenanceLatestEntry,
} from '@/lib/maintenance-due'
import {
  applyCareNotificationAction,
  getCareNotificationBox,
  mergeCareNotificationChanges,
  parseCareNotificationAction,
  reconcileCareNotifications,
  type CareNotification,
} from '@/lib/care-notifications'
import {
  evaluateAchievements,
  summarizeAchievements,
} from '@/lib/achievements/catalog'
import {
  latestTouchedKnifeId,
  parseAchievementAction,
  recordAchievementUnlocks,
  type AchievementState,
  type AchievementUnlock,
} from '@/lib/achievements/unlocks'
import type { AchievementInput } from '@/lib/achievements/snapshot'
import { IDLE_CLOUD_BACKUP_JOB } from '@/lib/cloud-backup-shared'
import { DRIVE_BACKUP_UNAVAILABLE } from '@/lib/drive-backup-shared'
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
  notes: Record<string, KnifeNote[]>
  careNotifications: CareNotification[]
  /** Unlocks for this session; initializedAt is set by the first evaluation. */
  achievements: { unlocks: AchievementUnlock[]; initializedAt: string | null }
}

function emptyState(): State {
  return {
    knives: [],
    settings: {
      ...DEFAULT_SETTINGS,
      mcpEnabled: false,
      mcpWriteEnabled: false,
      // The browser has no system messages, so unlocks skip the Inbox.
      achievements: { ...DEFAULT_ACHIEVEMENTS, inbox: false },
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
    notes: {},
    careNotifications: [],
    achievements: { unlocks: [], initializedAt: null },
  }
}

let state: State | null = null

/** Knives saved before sold status existed have no `sold` flag — default them to false. */
function normalizeKnife(knife: Knife): Knife {
  return { ...knife, sold: knife.sold === true }
}

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
      state = {
        ...parsed,
        // Sessions saved before notes existed have no notes map.
        notes: parsed.notes ?? {},
        careNotifications: Array.isArray(parsed.careNotifications)
          ? parsed.careNotifications
          : [],
        knives: parsed.knives.map(normalizeKnife),
        // Sessions saved before achievements had them forced off; start fresh.
        achievements: parsed.achievements ?? {
          unlocks: [],
          initializedAt: null,
        },
        settings: {
          ...parsed.settings,
          achievements: {
            ...(parsed.achievements
              ? normalizeAchievementSettings(parsed.settings.achievements)
              : DEFAULT_ACHIEVEMENTS),
            inbox: false,
          },
          dimensionUnit: normalizeDimensionUnit(parsed.settings.dimensionUnit),
          pinnedCardFields: normalizeCardFields(
            parsed.settings.pinnedCardFields,
            DEFAULT_SETTINGS.pinnedCardFields,
          ),
        },
      }
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
export function readSessionStartPage() {
  const startPage = normalizeStartPage(getState().settings.startPage)
  // The static app has no Wishlist or Price Drops pages.
  return startPage === 'wishlist' || startPage === 'price-drops'
    ? 'insights'
    : startPage
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

function latestMaintenance(db: State): MaintenanceLatestEntry[] {
  const latest: MaintenanceLatestEntry[] = []
  for (const [knifeId, events] of Object.entries(db.maintenance)) {
    const byType = new Map<MaintenanceEvent['type'], string>()
    for (const event of events) {
      const previous = byType.get(event.type)
      if (!previous || event.occurredAt > previous)
        byType.set(event.type, event.occurredAt)
    }
    for (const [type, lastAt] of byType) latest.push({ knifeId, type, lastAt })
  }
  return latest
}

function achievementInput(db: State, now: Date): AchievementInput {
  const remindersOn = normalizeMaintenanceReminders(
    db.settings.maintenanceReminders,
    DEFAULT_MAINTENANCE_REMINDERS,
  ).enabled
  const boxes = db.careNotifications.map((notification) =>
    getCareNotificationBox(notification, now),
  )
  return {
    knives: db.knives,
    activity: db.activity,
    maintenance: Object.values(db.maintenance).flat(),
    noteCount: Object.values(db.notes).reduce(
      (sum, notes) => sum + notes.length,
      0,
    ),
    comparisons: db.lists.map((list) => ({ knifeIds: list.ids })),
    openCareReminders: remindersOn
      ? boxes.filter((box) => box === 'open').length
      : null,
    clearedCareReminders: remindersOn
      ? boxes.filter((box) => box === 'done').length
      : 0,
    // The browser runs no price checks.
    priceMonitoring: null,
    now,
  }
}

function achievementState(
  db: State,
  progress: AchievementState['progress'],
): AchievementState {
  const enabled = db.settings.achievements?.enabled === true
  return {
    enabled,
    unlocks: db.achievements.unlocks,
    progress: enabled ? progress : [],
    summary: summarizeAchievements(db.achievements.unlocks.map((u) => u.id)),
  }
}

function handleAchievements(
  db: State,
  method: string,
  body: Record<string, unknown>,
) {
  const now = new Date()
  const enabled = db.settings.achievements?.enabled === true
  if (method === 'PATCH') {
    let action
    try {
      action = parseAchievementAction(body)
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Invalid body' },
        400,
      )
    }
    if (action.action === 'reset') {
      db.achievements = { unlocks: [], initializedAt: null }
    } else {
      const seen = new Set(action.ids)
      db.achievements.unlocks = db.achievements.unlocks.map((unlock) =>
        seen.has(unlock.id) && !unlock.seenAt
          ? { ...unlock, seenAt: now.toISOString() }
          : unlock,
      )
    }
    save()
  }
  const input = achievementInput(db, now)
  const progress = enabled ? evaluateAchievements(input) : []
  if (method !== 'POST' || !enabled) {
    return json(
      method === 'POST'
        ? {
            ...achievementState(db, progress),
            newlyUnlocked: [],
            backfilledCount: 0,
          }
        : achievementState(db, progress),
    )
  }
  const initialized = db.achievements.initializedAt !== null
  const knifeId = latestTouchedKnifeId(input)
  const { unlocks, inserted } = recordAchievementUnlocks(
    db.achievements.unlocks,
    progress
      .filter((entry) => entry.done)
      .map((entry) => ({ id: entry.id, knifeId })),
    initialized,
    now,
  )
  db.achievements = {
    unlocks,
    initializedAt: db.achievements.initializedAt ?? now.toISOString(),
  }
  save()
  return json({
    ...achievementState(db, progress),
    newlyUnlocked: initialized ? inserted : [],
    backfilledCount: initialized ? 0 : inserted.length,
  })
}

function handle(request: Request, body: Record<string, unknown>) {
  const db = getState(),
    path = new URL(request.url).pathname,
    method = request.method
  if (path === '/api/vault/status') return json(STATIC_VAULT_STATUS)
  // Only this tab writes the static vault, so it never changes underneath it.
  if (path === '/api/vault/changes') return json({ token: 'static' })
  if (path === '/api/cloud-backup/job' && method === 'GET')
    return json({ job: IDLE_CLOUD_BACKUP_JOB })
  if (path === '/api/cloud-backup/restore-job' && method === 'GET')
    return json({ job: IDLE_CLOUD_RESTORE_JOB })
  if (path === '/api/drive-backup/status' && method === 'GET')
    return json(DRIVE_BACKUP_UNAVAILABLE)
  if (path === '/api/app-lock' && method === 'GET')
    return json({ enabled: false, unlocked: true })
  if (path === '/api/activity' && method === 'GET')
    return json({ activity: db.activity })
  if (path === '/api/maintenance' && method === 'GET')
    return json({ latest: latestMaintenance(db) })
  if (path === '/api/maintenance/events' && method === 'GET')
    return json({
      events: Object.values(db.maintenance)
        .flat()
        .sort(
          (left, right) =>
            right.occurredAt.localeCompare(left.occurredAt) ||
            right.id - left.id,
        ),
    })
  if (path === '/api/achievements') return handleAchievements(db, method, body)
  // The static build runs no backups, so it has no system messages.
  if (path === '/api/system-messages') return json({ messages: [] })
  if (path === '/api/care-inbox') {
    const now = new Date()
    if (method === 'POST') {
      const reminders = normalizeMaintenanceReminders(
        db.settings.maintenanceReminders,
        DEFAULT_MAINTENANCE_REMINDERS,
      )
      if (reminders.enabled) {
        const statuses = getCareStatuses(
          db.knives,
          buildLatestByKnife(latestMaintenance(db)),
          reminders,
          normalizeCareIntervalOverrides(db.settings.careIntervalOverrides),
          now,
          normalizeCareDeferrals(db.settings.careDeferrals),
        )
        db.careNotifications = mergeCareNotificationChanges(
          db.careNotifications,
          reconcileCareNotifications(db.careNotifications, statuses, now),
          new Set(db.knives.map((knife) => knife.id)),
        )
        save()
      }
    } else if (method === 'PATCH') {
      let action
      try {
        action = parseCareNotificationAction(body)
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : 'Invalid body' },
          400,
        )
      }
      db.careNotifications = mergeCareNotificationChanges(
        db.careNotifications,
        {
          create: [],
          update: applyCareNotificationAction(
            db.careNotifications,
            action,
            now,
          ),
          deleteIds: [],
        },
        new Set(db.knives.map((knife) => knife.id)),
      )
      save()
    }
    return json({ notifications: db.careNotifications })
  }
  if (path === '/api/logs' && method === 'GET')
    return json({ events: db.events })
  if (path === '/api/timeline' && method === 'GET')
    return json({
      maintenanceEvents: Object.values(db.maintenance)
        .flat()
        .sort(
          (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id - a.id,
        ),
      notes: Object.values(db.notes)
        .flat()
        .sort((a, b) => b.notedAt.localeCompare(a.notedAt) || b.id - a.id),
    })
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
        imageHosts: { enabled: false, hosts: [], managedByEnvironment: true },
        activity: {
          lastActivityAt: null,
          httpRequestsSinceStart: 0,
          toolCallsSinceStart: 0,
          writesSinceStart: 0,
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
      const wasTracking = db.settings.achievements?.enabled === true
      db.settings = {
        ...db.settings,
        ...body,
        achievements: {
          ...normalizeAchievementSettings(
            body.achievements,
            db.settings.achievements,
          ),
          inbox: false,
        },
        dimensionUnit: normalizeDimensionUnit(
          body.dimensionUnit,
          db.settings.dimensionUnit,
        ),
        driveAutoBackupEnabled: false,
        mcpEnabled: false,
        mcpWriteEnabled: false,
      }
      // Turning achievements back on starts a quiet baseline, as in the app.
      if (!wasTracking && db.settings.achievements.enabled) {
        db.achievements.initializedAt = null
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
        sold: body.sold === true,
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
      const raw = body as Record<string, unknown>
      if ('sold' in raw && typeof raw.sold !== 'boolean')
        return json({ error: 'Sold must be true or false' }, 400)
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
      delete db.notes[knife.id]
      db.careNotifications = db.careNotifications.filter(
        (row) => row.knifeId !== knife.id,
      )
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
  const notes = path.match(/^\/api\/knives\/([^/]+)\/notes(?:\/([^/]+))?$/)
  if (notes) {
    const knifeId = decodeURIComponent(notes[1]),
      id = notes[2] ? Number(notes[2]) : undefined
    if (!readSessionKnife(knifeId))
      return json({ error: 'Knife not found' }, 404)
    const list = (db.notes[knifeId] ??= [])
    const knife = readSessionKnife(knifeId)!
    const inGallery = (note: KnifeNote) => ({
      ...note,
      images: (note.images ?? []).filter((src) => knife.images.includes(src)),
    })
    if (method === 'GET') return json({ notes: list.map(inGallery) })
    const existing =
      id === undefined ? undefined : list.find((n) => n.id === id)
    if (id !== undefined && !existing)
      return json({ error: 'Note not found' }, 404)
    if (method === 'DELETE') {
      db.notes[knifeId] = list.filter((n) => n.id !== id)
      save()
      return json({ success: true })
    }
    const text =
      typeof body.body === 'string' ? body.body.trim() : (existing?.body ?? '')
    const images = Array.isArray(body.images)
      ? Array.from(
          new Set(
            body.images.filter(
              (src): src is string =>
                typeof src === 'string' &&
                (src.startsWith('data:image') || knife.images.includes(src)),
            ),
          ),
        ).slice(0, KNIFE_NOTE_MAX_IMAGES)
      : existing
        ? inGallery(existing).images
        : []
    if (!text && images.length === 0)
      return json({ error: 'Note text or a photo is required' }, 400)
    // Uploaded photos join the knife's gallery; the session keeps them inline.
    const uploads = images.filter((src) => !knife.images.includes(src))
    const updatedKnife = uploads.length
      ? updateKnife(knife, { images: [...knife.images, ...uploads] })
      : undefined
    const now = new Date().toISOString()
    const note: KnifeNote = {
      id: id ?? Date.now(),
      knifeId,
      body: text,
      images,
      notedAt:
        typeof body.notedAt === 'string' && body.notedAt
          ? body.notedAt
          : (existing?.notedAt ?? now),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    db.notes[knifeId] = [note, ...list.filter((n) => n.id !== note.id)].sort(
      (a, b) => b.notedAt.localeCompare(a.notedAt) || b.id - a.id,
    )
    save()
    return json(
      { note, ...(updatedKnife ? { knife: updatedKnife } : {}) },
      existing ? 200 : 201,
    )
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
  markStaticBrowserApp()
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
