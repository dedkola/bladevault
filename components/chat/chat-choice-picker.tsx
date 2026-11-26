import { useId, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Brain, Cpu } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ChatChoice } from '@/lib/chat/shared'
import {
  normalizeAiModel,
  PRICE_AI_CHAT_REASONING,
  type PriceAiChatReasoning,
} from '@/lib/settings-shared'

export const REASONING_LABELS: Record<PriceAiChatReasoning, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/**
 * The chat's model (the endpoint's list, or any typed ID) and reasoning
 * level. A typed model is used on Enter or when the field loses focus;
 * Escape puts the current model back.
 */
export function ChatChoicePicker({
  choice,
  models,
  disabled,
  onOpenModels,
  onChange,
}: {
  choice: ChatChoice
  models: string[]
  disabled?: boolean
  /** The model field got focus: a chance to load the endpoint's list. */
  onOpenModels: () => void
  onChange: (next: ChatChoice) => void
}) {
  const listId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)

  const commit = (value: string) => {
    const model = normalizeAiModel(value)
    if (!model) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setDraft(null)
    if (model !== choice.model) onChange({ ...choice, model })
  }

  const onModelChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setInvalid(false)
    // Picking from the list replaces the whole text: use it at once.
    const native = event.nativeEvent
    const picked =
      !(native instanceof InputEvent) ||
      native.inputType === 'insertReplacementText'
    if (picked && models.includes(value)) commit(value)
    else setDraft(value)
  }

  const onModelKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (draft !== null) commit(draft)
    } else if (event.key === 'Escape' && draft !== null) {
      event.preventDefault()
      setDraft(null)
      setInvalid(false)
    }
  }

  return (
    <div className="chat-choice">
      <label className="chat-choice-model">
        <Cpu aria-hidden="true" className="chat-choice-icon" />
        <span className="sr-only">Model for this chat</span>
        <Input
          value={draft ?? choice.model}
          list={listId}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder="Model ID"
          aria-invalid={invalid ? true : undefined}
          title={
            invalid
              ? 'This is not a valid model ID.'
              : 'Pick a model from the list or type its ID'
          }
          className="h-8 pl-7 text-xs"
          onFocus={onOpenModels}
          onChange={onModelChange}
          onKeyDown={onModelKeyDown}
          onBlur={() => {
            if (draft === null) return
            if (draft.trim()) commit(draft)
            else setDraft(null)
          }}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>
      <Select
        value={choice.reasoning}
        disabled={disabled}
        onValueChange={(value) => {
          if (value && value !== choice.reasoning)
            onChange({ ...choice, reasoning: value as PriceAiChatReasoning })
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Reasoning for this chat"
          title="How much the model may reason before it answers: more is slower and uses more tokens. Off asks OpenCode models to answer right away; other endpoints may still reason by default."
          className="chat-choice-reasoning"
        >
          <Brain aria-hidden="true" />
          <SelectValue>
            {`Reasoning: ${REASONING_LABELS[choice.reasoning]}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {PRICE_AI_CHAT_REASONING.map((level) => (
            <SelectItem key={level} value={level}>
              {REASONING_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
