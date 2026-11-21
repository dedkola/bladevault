import { getLocalDb } from '@/lib/local-db'
import { fromMinorUnits } from '@/lib/price-monitor/money'
import {
  applyPriceWatchUpdate,
  PriceWatchError,
  startKnifeFocus,
} from '@/lib/price-monitor/store'
import { applyRelink } from '@/lib/price-monitor/recovery'
import { getStorage } from '@/lib/storage'
import {
  readSystemMessages,
  resolveSystemMessage,
  updateSystemMessages,
} from '@/lib/system-message-store'
import {
  isOpenPriceQuestion,
  type SystemMessage,
  type SystemMessageAnswer,
} from '@/lib/system-messages'
import { withVaultWrite } from '@/lib/vault-access'

/** A question that cannot be answered (any more). Answers HTTP 409. */
export class PriceQuestionError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'PriceQuestionError'
  }
}

/**
 * Answers an AI supervisor question from the Inbox. Yes (and No for a
 * listing) acts through the same paths as the knife's own controls, then
 * the question closes with the answer. A question about a knife or listing
 * that is gone closes without one.
 */
export async function answerPriceQuestion(
  id: number,
  answer: SystemMessageAnswer,
  now: Date = new Date(),
): Promise<SystemMessage[]> {
  const message = readSystemMessages(getLocalDb()).find((row) => row.id === id)
  if (!message || message.kind !== 'price-question')
    throw new PriceQuestionError('This question is no longer in the Inbox.')
  const payload = message.payload
  if (!isOpenPriceQuestion(message) || payload?.type !== 'question')
    throw new PriceQuestionError('This question was already answered.')
  const knife = await getStorage().getKnifeById(payload.knifeId)
  if (!knife) {
    await resolveSystemMessage(id, now)
    throw new PriceQuestionError(
      'This knife is no longer in the collection, so the question was closed.',
    )
  }
  try {
    if (answer === 'yes' && payload.ask === 'set_target') {
      await applyPriceWatchUpdate(knife, {
        alerts: {
          targetPrice: {
            amount: fromMinorUnits(payload.priceMinor, payload.currency),
            currency: payload.currency,
          },
        },
      })
    } else if (answer === 'yes' && payload.ask === 'watch_closely') {
      await withVaultWrite(async () => {
        const database = getLocalDb()
        database.transaction(() =>
          startKnifeFocus(
            database,
            knife.id,
            {
              hours: payload.hours,
              everyHours: payload.everyHours,
              reason: message.detail || 'You said yes in the Inbox.',
            },
            now.getTime(),
          ),
        )()
      })
    } else if (answer === 'yes' && payload.ask === 'relink') {
      if (
        !(await applyRelink({ sourceId: payload.sourceId, url: payload.url }))
      )
        throw new PriceWatchError('Source not found', 404)
    } else if (answer === 'no' && payload.ask === 'keep_listing') {
      await applyPriceWatchUpdate(knife, {
        update: [{ id: payload.sourceId, enabled: false }],
      })
    }
  } catch (error) {
    if (error instanceof PriceWatchError && error.status === 404) {
      await resolveSystemMessage(id, now)
      throw new PriceQuestionError(
        'This listing is no longer monitored, so the question was closed.',
      )
    }
    throw error
  }
  return updateSystemMessages({ action: 'answer', id, answer }, now)
}
