'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Copy, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { useComparisons } from '@/components/providers/comparisons-provider'
import { useKnives } from '@/components/providers/knives-provider'
import { getImageUrl } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ComparisonDialog } from '@/components/providers/comparisons-provider'

export function ComparisonDialogs() {
  const { dialog, setDialog, returnFocus, busy } = useComparisons()
  return (
    <Dialog
      open={Boolean(dialog)}
      onOpenChange={(open) => {
        if (!open && !busy) setDialog(null)
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-lg"
        finalFocus={() =>
          returnFocus.current?.isConnected
            ? returnFocus.current
            : document.querySelector<HTMLElement>('main')
        }
      >
        {dialog && (
          <DialogBody
            key={`${dialog.kind}:${dialog.id ?? ''}`}
            config={dialog}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DialogBody({ config }: { config: ComparisonDialog }) {
  const { lists, mutate, setDialog, navigate, busy, refresh } = useComparisons()
  const { knives } = useKnives()
  const list = lists.find((l) => l.id === config.id)
  const selectedIds = config.knifeIds ?? []
  const [name, setName] = useState(
      config.kind === 'rename' ? (list?.name ?? '') : '',
    ),
    [query, setQuery] = useState(''),
    [error, setError] = useState('')
  const [limit, setLimit] = useState(50)
  const [changes, setChanges] = useState<
    Map<string, { selected: boolean; expectedRevision: number }>
  >(new Map())
  const [creating, setCreating] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [creating])
  const form = config.kind === 'create' || config.kind === 'rename' || creating
  const title = form
    ? config.kind === 'rename'
      ? 'Rename comparison'
      : 'New comparison'
    : config.kind === 'choose'
      ? 'Choose comparisons'
      : config.kind === 'add'
        ? 'Add knives'
        : config.kind === 'options'
          ? 'Comparison options'
          : config.kind === 'delete'
            ? 'Delete this comparison?'
            : 'Remove all knives?'
  const description = form
    ? 'Give this comparison a name that is easy to find.'
    : config.kind === 'choose'
      ? config.bulk
        ? `Add ${selectedIds.length} selected knives to one or more lists. Existing memberships are kept.`
        : 'Keep this knife in one list or several.'
      : list
        ? `${list.name} · ${list.ids.length} ${list.ids.length === 1 ? 'knife' : 'knives'}`
        : 'This comparison no longer exists.'
  async function run(work: () => Promise<void>) {
    setError('')
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.')
      void refresh()
    }
  }
  async function saveName() {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 60) {
      setError('Enter a name between 1 and 60 characters.')
      input.current?.focus()
      return
    }
    await run(async () => {
      if (config.kind === 'rename' && list) {
        await mutate(
          {
            action: 'rename',
            id: list.id,
            expectedRevision: list.revision,
            name: trimmed,
          },
          'Comparison renamed',
        )
        setDialog(null)
        return
      }
      const data = await mutate(
        { action: 'create', name: trimmed, ids: selectedIds },
        selectedIds.length
          ? `Created ${trimmed} and added ${selectedIds.length} ${selectedIds.length === 1 ? 'knife' : 'knives'}`
          : `Created ${trimmed}`,
      )
      if (creating) {
        setCreating(false)
        setName('')
        return
      }
      setDialog(null)
      if (!selectedIds.length && data.listId) navigate(data.listId)
    })
  }
  const chooserLists = lists.filter((l) =>
    l.name.toLowerCase().includes(query.toLowerCase()),
  )
  const results = knives.filter((knife) =>
    [
      knife.name,
      knife.brand,
      knife.specs.modelNumber,
      knife.specs.bladeMaterial,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const knife =
    selectedIds.length === 1
      ? knives.find((k) => k.id === selectedIds[0])
      : undefined
  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-6 text-lg">{title}</DialogTitle>
        <DialogDescription className="break-words">
          {description}
        </DialogDescription>
      </DialogHeader>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          {config.kind === 'choose' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setChanges(new Map())
                setError('')
                void refresh()
              }}
            >
              Reset selection to latest lists
            </Button>
          )}
        </div>
      )}
      {form ? (
        <form
          id="comparison-name-form"
          onSubmit={(e) => {
            e.preventDefault()
            void saveName()
          }}
          className="space-y-2"
        >
          <label htmlFor="comparison-name" className="text-sm font-medium">
            Comparison name
          </label>
          <Input
            ref={input}
            id="comparison-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Summer carry"
            autoComplete="off"
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            {selectedIds.length
              ? `${selectedIds.length} selected ${selectedIds.length === 1 ? 'knife will' : 'knives will'} be added to this new comparison.`
              : 'You can add the same knife to more than one comparison.'}
          </p>
        </form>
      ) : config.kind === 'choose' ? (
        <>
          {knife && (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-3">
              {knife.images[0] && (
                <Image
                  src={getImageUrl(knife.images[0])}
                  width={76}
                  height={50}
                  alt=""
                  className="h-12 w-20 rounded object-contain"
                />
              )}
              <div className="min-w-0">
                <p className="font-medium">{knife.name}</p>
                <p className="text-xs text-muted-foreground">
                  {knife.brand} · {knife.specs.modelNumber}
                </p>
              </div>
            </div>
          )}
          <label className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              ref={input}
              aria-label="Find comparison"
              placeholder="Find a comparison…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(50)
              }}
              className="pl-9"
            />
          </label>
          <div className="max-h-64 overflow-y-auto">
            {chooserLists.slice(0, limit).map((l) => {
              const count = selectedIds.filter((id) =>
                  l.ids.includes(id),
                ).length,
                all = count === selectedIds.length,
                mixed = count > 0 && !all
              const change = changes.get(l.id),
                checked = change?.selected ?? all
              return (
                <label
                  key={l.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md p-3 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--bladevault-gold)]"
                    checked={checked}
                    ref={(el) => {
                      if (el) el.indeterminate = !change && mixed
                    }}
                    disabled={busy || (config.bulk && all)}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setChanges((current) =>
                        new Map(current).set(l.id, {
                          selected: checked,
                          expectedRevision: l.revision,
                        }),
                      )
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium">
                      {l.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {l.ids.length} {l.ids.length === 1 ? 'knife' : 'knives'}
                      {mixed
                        ? ` · ${count} of ${selectedIds.length} selected knives already here`
                        : all
                          ? ' · Already added'
                          : ''}
                    </span>
                  </span>
                </label>
              )
            })}
            {!chooserLists.length && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching comparisons.
              </p>
            )}
            {chooserLists.length > limit && (
              <Button variant="ghost" onClick={() => setLimit((n) => n + 50)}>
                Show more comparisons
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setCreating(true)
              setName('')
              setError('')
            }}
            disabled={busy}
          >
            <Plus className="size-4" />
            New comparison
          </Button>
        </>
      ) : config.kind === 'add' && list ? (
        <>
          <Input
            ref={input}
            aria-label="Search knives to add"
            placeholder="Search name, brand, steel, model…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(50)
            }}
          />
          <div className="max-h-80 overflow-y-auto">
            {results.slice(0, limit).map((k) => (
              <div key={k.id} className="flex items-center gap-3 border-b py-3">
                {k.images[0] && (
                  <Image
                    src={getImageUrl(k.images[0])}
                    width={72}
                    height={48}
                    alt=""
                    className="h-12 w-18 rounded object-contain"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {k.brand} · {k.specs.modelNumber}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || list.ids.includes(k.id)}
                  aria-label={`Add ${k.brand} ${k.name} ${k.specs.modelNumber ?? ''} to this comparison`}
                  onClick={() =>
                    void run(async () => {
                      await mutate(
                        {
                          action: 'add',
                          id: list.id,
                          ids: [k.id],
                          expectedRevision: list.revision,
                        },
                        `Added to ${list.name}`,
                      )
                    })
                  }
                >
                  {list.ids.includes(k.id) ? 'Added' : 'Add'}
                </Button>
              </div>
            ))}
            {!results.length && (
              <p className="py-6 text-muted-foreground">No matching knives.</p>
            )}
            {results.length > limit && (
              <Button variant="ghost" onClick={() => setLimit((n) => n + 50)}>
                Show more knives
              </Button>
            )}
          </div>
        </>
      ) : config.kind === 'options' && list ? (
        <div className="grid gap-2">
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => setDialog({ kind: 'rename', id: list.id })}
          >
            <Pencil />
            Rename comparison
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const data = await mutate(
                  {
                    action: 'duplicate',
                    id: list.id,
                    expectedRevision: list.revision,
                  },
                  'Comparison duplicated',
                )
                setDialog(null)
                if (data.listId) navigate(data.listId)
              })
            }
          >
            <Copy />
            Duplicate comparison
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            disabled={!list.ids.length}
            onClick={() => setDialog({ kind: 'clear', id: list.id })}
          >
            <X />
            Remove all knives from this list
          </Button>
          <Button
            variant="ghost"
            className="justify-start text-destructive"
            onClick={() => setDialog({ kind: 'delete', id: list.id })}
          >
            <Trash2 />
            Delete comparison
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          {config.kind === 'delete'
            ? 'This deletes the comparison and its list of knives.'
            : 'This empties the comparison and keeps its name.'}{' '}
          Your knives remain in your collection and other comparisons.
        </p>
      )}
      {config.kind !== 'options' && (
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (creating) {
                setCreating(false)
                setError('')
              } else setDialog(null)
            }}
          >
            {config.kind === 'add' ? 'Done' : 'Cancel'}
          </Button>
          {form ? (
            <Button form="comparison-name-form" type="submit" disabled={busy}>
              {busy
                ? 'Saving…'
                : config.kind === 'rename'
                  ? 'Save name'
                  : selectedIds.length
                    ? 'Create & add'
                    : 'Create comparison'}
            </Button>
          ) : config.kind === 'choose' ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await mutate(
                    {
                      action: 'memberships',
                      ids: selectedIds,
                      changes: [...changes]
                        .filter(([, change]) => !config.bulk || change.selected)
                        .map(([id, change]) => ({ id, ...change })),
                    },
                    'Comparison selection saved',
                  )
                  setDialog(null)
                })
              }
            >
              {busy
                ? 'Saving…'
                : config.bulk
                  ? 'Add to selected lists'
                  : 'Save selection'}
            </Button>
          ) : (
            (config.kind === 'delete' || config.kind === 'clear') && (
              <Button
                variant="destructive"
                disabled={busy || !list}
                onClick={() =>
                  void run(async () => {
                    if (!list) return
                    await mutate(
                      {
                        action: config.kind === 'delete' ? 'delete' : 'clear',
                        id: list.id,
                        expectedRevision: list.revision,
                      },
                      `${config.kind === 'delete' ? 'Deleted' : 'Cleared'} ${list.name}`,
                    )
                    setDialog(null)
                  })
                }
              >
                {busy
                  ? 'Saving…'
                  : config.kind === 'delete'
                    ? 'Delete comparison'
                    : 'Remove all knives'}
              </Button>
            )
          )}
        </DialogFooter>
      )}
    </>
  )
}
