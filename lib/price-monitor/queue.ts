import {
  laneAvailability,
  manualReadyAt,
  type LaneState,
} from '@/lib/price-monitor/lanes'

/** A source the queue may check. */
export type QueueCandidate = {
  sourceId: number
  laneKey: string
  /** 2 = Check now, 1 = never checked, 0 = normal. */
  priority: number
  /** Epoch ms; null when never scheduled (due now). */
  nextCheckAt: number | null
  /** Covered by scheduled monitoring (enabled source, eligible knife). */
  scheduled: boolean
}

export type QueuePick = {
  sourceId: number
  laneKey: string
  trigger: 'manual' | 'scheduled' | 'probe'
}

export type QueueInput = {
  candidates: readonly QueueCandidate[]
  lanes: ReadonlyMap<string, LaneState>
  /** Lanes with a check in flight: never a second one at the same store. */
  busyLanes: ReadonlySet<string>
  maxParallel: number
  now: number
  /** Monitoring enabled and inside the active hours. */
  scheduledActive: boolean
  defaultLane: (laneKey: string) => LaneState
}

function isDue(candidate: QueueCandidate, input: QueueInput): boolean {
  if (candidate.priority >= 2) return true
  if (!input.scheduledActive || !candidate.scheduled) return false
  return candidate.nextCheckAt === null || candidate.nextCheckAt <= input.now
}

function byUrgency(a: QueueCandidate, b: QueueCandidate): number {
  return (
    b.priority - a.priority ||
    (a.nextCheckAt ?? -Infinity) - (b.nextCheckAt ?? -Infinity) ||
    a.sourceId - b.sourceId
  )
}

/**
 * Chooses which checks start now: at most one per store, at most
 * `maxParallel` stores at once, stores taking turns (the one that waited
 * longest goes first), and inside a store Check now first, then the most
 * overdue source. A store paused by its circuit breaker gets one probe once
 * its cooldown ends. Check now skips the even spread but keeps the store's
 * minimum gap.
 */
export function pickNextChecks(input: QueueInput): QueuePick[] {
  const slots = input.maxParallel - input.busyLanes.size
  if (slots <= 0) return []

  const byLane = new Map<string, QueueCandidate[]>()
  for (const candidate of input.candidates) {
    if (input.busyLanes.has(candidate.laneKey) || !isDue(candidate, input))
      continue
    const list = byLane.get(candidate.laneKey) ?? []
    list.push(candidate)
    byLane.set(candidate.laneKey, list)
  }

  const ready: Array<{ pick: QueuePick; lastRequestAt: number }> = []
  for (const [laneKey, due] of byLane) {
    const lane = input.lanes.get(laneKey) ?? input.defaultLane(laneKey)
    const availability = laneAvailability(lane, input.now)
    const [first] = due.sort(byUrgency)
    let trigger: QueuePick['trigger'] | null = null
    if (availability.state === 'ready') {
      trigger = first.priority >= 2 ? 'manual' : 'scheduled'
    } else if (availability.state === 'probe') {
      trigger = 'probe'
    } else if (
      availability.state === 'waiting' &&
      first.priority >= 2 &&
      manualReadyAt(lane) <= input.now
    ) {
      trigger = 'manual'
    }
    if (trigger)
      ready.push({
        pick: { sourceId: first.sourceId, laneKey, trigger },
        lastRequestAt: lane.lastRequestAt ?? -Infinity,
      })
  }

  return ready
    .sort((a, b) => a.lastRequestAt - b.lastRequestAt)
    .slice(0, slots)
    .map((entry) => entry.pick)
}

/**
 * When something may become runnable: the earliest moment a store with due
 * or upcoming work leaves its gap or cooldown. Null when nothing is pending.
 */
export function nextWakeAt(input: QueueInput): number | null {
  let earliest: number | null = null
  const consider = (time: number) => {
    earliest = earliest === null ? time : Math.min(earliest, time)
  }
  const byLane = new Map<string, QueueCandidate[]>()
  for (const candidate of input.candidates) {
    if (input.busyLanes.has(candidate.laneKey)) continue
    if (
      candidate.priority < 2 &&
      (!candidate.scheduled || !input.scheduledActive)
    )
      continue
    const list = byLane.get(candidate.laneKey) ?? []
    list.push(candidate)
    byLane.set(candidate.laneKey, list)
  }
  for (const [laneKey, list] of byLane) {
    const lane = input.lanes.get(laneKey) ?? input.defaultLane(laneKey)
    const availability = laneAvailability(lane, input.now)
    const manual = list.some((candidate) => candidate.priority >= 2)
    const gate =
      availability.state === 'cooling'
        ? availability.until
        : availability.state === 'waiting'
          ? manual
            ? Math.min(availability.until, manualReadyAt(lane))
            : availability.until
          : input.now
    const sourceDue = manual
      ? input.now
      : Math.min(...list.map((candidate) => candidate.nextCheckAt ?? input.now))
    consider(Math.max(gate, sourceDue))
  }
  return earliest
}
