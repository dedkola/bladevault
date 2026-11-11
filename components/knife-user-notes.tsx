'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { KNIFE_NOTE_MAX_LENGTH, type KnifeNote } from '@/lib/data'
import { readJsonResponse } from '@/lib/api-response'
import { useKnives } from '@/components/providers/knives-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

function toDateInputValue(isoString: string): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Keeps the time of day when the date is unchanged, so edits don't reorder same-day notes. */
function fromDateInputValue(value: string, previous?: string): string {
  if (!value) return previous ?? new Date().toISOString()
  if (previous && toDateInputValue(previous) === value) return previous
  const [year, month, day] = value.split('-').map(Number)
  const now = new Date()
  return new Date(
    year,
    month - 1,
    day,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ).toISOString()
}

function formatDay(isoString: string): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return isoString
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function sortNotes(notes: KnifeNote[]): KnifeNote[] {
  return [...notes].sort(
    (left, right) =>
      right.notedAt.localeCompare(left.notedAt) || right.id - left.id,
  )
}

function groupNotesByDay(notes: KnifeNote[]) {
  const groups: Array<{ key: string; label: string; notes: KnifeNote[] }> = []
  for (const note of notes) {
    const key = toDateInputValue(note.notedAt)
    const current = groups.at(-1)
    if (current?.key === key) current.notes.push(note)
    else groups.push({ key, label: formatDay(note.notedAt), notes: [note] })
  }
  return groups
}

function NoteComposer({
  note,
  onSave,
  onCancel,
}: {
  note?: KnifeNote
  onSave: (input: { body: string; notedAt: string }) => Promise<void>
  onCancel: () => void
}) {
  const formId = useId()
  const [body, setBody] = useState(note?.body ?? '')
  const [day, setDay] = useState(
    toDateInputValue(note?.notedAt ?? new Date().toISOString()),
  )
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Focus on open, with the caret after any existing text so edits append.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    const end = textarea.value.length
    textarea.setSelectionRange(end, end)
  }, [])

  const submit = async () => {
    if (!body.trim()) {
      setError('Write something first.')
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await onSave({
        body: body.trim(),
        notedAt: fromDateInputValue(day, note?.notedAt),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note')
      setIsSaving(false)
    }
  }

  return (
    <form
      data-note-composer
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="space-y-2.5 rounded-lg border border-border/65 bg-[color:var(--bladevault-surface-soft)]/50 p-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="flex items-center gap-2">
        <label
          htmlFor={`${formId}-date`}
          className="text-[11px] text-muted-foreground"
        >
          Date
        </label>
        <Input
          id={`${formId}-date`}
          type="date"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className="h-8 w-40"
        />
      </div>
      <label htmlFor={`${formId}-body`} className="sr-only">
        Note
      </label>
      <Textarea
        id={`${formId}-body`}
        ref={textareaRef}
        value={body}
        maxLength={KNIFE_NOTE_MAX_LENGTH}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder="Carry impressions, edge retention, where it came from…"
        rows={3}
        className="min-h-20 text-xs xl:text-sm"
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSaving}>
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          {note ? 'Save note' : 'Add note'}
        </Button>
      </div>
    </form>
  )
}

/**
 * The collector's own dated notes, listed under the scraped description and
 * grouped by day, newest first.
 */
export function KnifeUserNotes({ knifeId }: { knifeId: string }) {
  const { scheduleVaultBackup } = useKnives()
  const [notes, setNotes] = useState<KnifeNote[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [status, setStatus] = useState('')
  const notesUrl = `/api/knives/${encodeURIComponent(knifeId)}/notes`

  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetch(notesUrl, { cache: 'no-store' })
        const data = await readJsonResponse<{
          error?: string
          notes?: KnifeNote[]
        }>(response)
        if (cancelled) return
        if (!response.ok) throw new Error(data.error || 'Failed to load notes')
        setNotes(sortNotes(data.notes ?? []))
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load notes')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [notesUrl])

  const saveNote = async (
    input: { body: string; notedAt: string },
    existing?: KnifeNote,
  ) => {
    const response = await fetch(
      existing ? `${notesUrl}/${existing.id}` : notesUrl,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    )
    const data = await readJsonResponse<{ error?: string; note?: KnifeNote }>(
      response,
    )
    if (!response.ok || !data.note) {
      throw new Error(data.error || 'Failed to save note')
    }
    const saved = data.note
    setNotes((current) =>
      sortNotes([...current.filter((item) => item.id !== saved.id), saved]),
    )
    scheduleVaultBackup()
    setIsAdding(false)
    setEditingId(null)
    setStatus(existing ? 'Note updated' : 'Note added')
  }

  const deleteNote = async (note: KnifeNote) => {
    if (!window.confirm('Delete this note?')) return
    setDeletingId(note.id)
    setError(null)
    try {
      const response = await fetch(`${notesUrl}/${note.id}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const data = await readJsonResponse<{ error?: string }>(response)
        throw new Error(data.error || 'Failed to delete note')
      }
      setNotes((current) => current.filter((item) => item.id !== note.id))
      scheduleVaultBackup()
      setStatus('Note deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note')
    } finally {
      setDeletingId(null)
    }
  }

  const groups = groupNotesByDay(notes)

  return (
    // `relative` keeps the sr-only status inside this block; otherwise it is
    // placed against the page and stretches the body past the app shell.
    <div data-user-notes className="relative space-y-3">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground xl:text-xs">
          My notes
        </h4>
        {!isAdding && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-mr-2 text-[var(--bladevault-title)] dark:text-[var(--bladevault-gold)]"
            onClick={() => {
              setEditingId(null)
              setIsAdding(true)
            }}
            disabled={isLoading}
          >
            <Plus aria-hidden="true" />
            Add note
          </Button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isAdding && (
        <NoteComposer
          onSave={(input) => saveNote(input)}
          onCancel={() => setIsAdding(false)}
        />
      )}

      {isLoading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading notes…
        </p>
      ) : notes.length === 0 && !isAdding && !error ? (
        <p className="text-xs text-muted-foreground xl:text-sm">
          No notes yet. Add your own impressions, care tips or history.
        </p>
      ) : (
        <ol className="space-y-1" aria-label="My notes by date">
          {groups.map((group) => (
            <li key={group.key} data-note-day className="flex gap-3">
              <div className="flex flex-col items-center pt-1.5">
                <div className="size-2 rounded-full bg-[var(--bladevault-gold)]" />
                <div className="my-1 w-px flex-1 bg-[var(--bladevault-line)]/60" />
              </div>
              <div className="min-w-0 flex-1 pb-3">
                <h5 className="text-xs font-medium text-foreground xl:text-sm">
                  <time dateTime={group.key}>{group.label}</time>
                </h5>
                <ul className="mt-1.5 space-y-2">
                  {group.notes.map((note) =>
                    editingId === note.id ? (
                      <li key={note.id}>
                        <NoteComposer
                          note={note}
                          onSave={(input) => saveNote(input, note)}
                          onCancel={() => setEditingId(null)}
                        />
                      </li>
                    ) : (
                      <li
                        key={note.id}
                        data-user-note
                        className="group flex items-start justify-between gap-2"
                      >
                        <p className="min-w-0 whitespace-pre-line text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere] xl:text-sm">
                          {note.body}
                        </p>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => {
                              setIsAdding(false)
                              setEditingId(note.id)
                            }}
                            aria-label="Edit note"
                            className="size-8 sm:size-6"
                          >
                            <Pencil className="size-3.5 sm:size-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => deleteNote(note)}
                            disabled={deletingId === note.id}
                            aria-label="Delete note"
                            className="size-8 text-destructive hover:text-destructive sm:size-6"
                          >
                            {deletingId === note.id ? (
                              <Loader2 className="size-3.5 animate-spin sm:size-3" />
                            ) : (
                              <Trash2 className="size-3.5 sm:size-3" />
                            )}
                          </Button>
                        </div>
                      </li>
                    ),
                  )}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
