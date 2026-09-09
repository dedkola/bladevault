'use client'

import { useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Bookmark, BookmarkPlus, Ellipsis, Pencil, Trash2 } from 'lucide-react'
import { useSmartCollections } from '@/components/providers/smart-collections-provider'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  collectionQuery,
  rangeDefinitions,
  rangeError,
} from '@/lib/smart-collections'

export function CollectionRanges({
  params,
  update,
}: {
  params: URLSearchParams
  update: (key: string, value: string) => void
}) {
  return (
    <div className="col-span-full space-y-3 border-t border-border/70 pt-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Measurement ranges
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rangeDefinitions.map((field) => (
          <fieldset key={field.key} className="min-w-0 space-y-1">
            <legend className="text-xs font-medium text-foreground">
              {field.label} ({field.unit})
            </legend>
            <div className="flex gap-2">
              {(['Min', 'Max'] as const).map((bound) => (
                <label
                  key={bound}
                  className="min-w-0 flex-1 text-xs text-muted-foreground"
                >
                  {bound === 'Min' ? 'At least' : 'Under'}
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    aria-label={`${field.label} ${bound === 'Min' ? 'at least' : 'under'} (${field.unit})`}
                    value={params.get(`${field.key}${bound}`) ?? ''}
                    onChange={(event) =>
                      update(`${field.key}${bound}`, event.target.value)
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={params.get('missingSpecs') === '1'}
          onCheckedChange={(checked) =>
            update('missingSpecs', checked ? '1' : '')
          }
        />
        Any missing specification
      </label>
    </div>
  )
}

export function SmartCollectionControls({
  params,
  navigate,
}: {
  params: URLSearchParams
  navigate: (query: string) => void
}) {
  const { collections, save, remove } = useSmartCollections()
  const selected = collections.find((item) => item.id === params.get('smart'))
  const query = collectionQuery(params)
  const invalid = rangeError(params)
  const isModified = Boolean(selected && selected.query !== query)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const showDialog = (edit: boolean) => {
    setEditing(edit)
    setName(edit ? (selected?.name ?? '') : '')
    setError('')
    setOpen(true)
  }

  if (!selected && !query) return null

  return (
    <>
      {selected ? (
        <div className="flex max-w-full items-center gap-1 rounded-lg border border-[var(--bladevault-line)]/80 bg-[color:var(--bladevault-surface-soft)]/35 p-1">
          <Bookmark
            className="ml-1.5 size-3.5 shrink-0 text-[var(--bladevault-title)]"
            aria-hidden="true"
          />
          <span
            className="max-w-44 truncate px-1 text-xs font-medium sm:max-w-56"
            title={selected.name}
          >
            {selected.name}
          </span>
          {isModified && (
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--bladevault-title)]">
              Modified
            </span>
          )}
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Manage ${selected.name}`}
                />
              }
            >
              <Ellipsis className="size-4" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                align="end"
                sideOffset={4}
                className="isolate z-50"
              >
                <Menu.Popup className="w-48 origin-(--transform-origin) rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                  <Menu.Item
                    onClick={() => showDialog(false)}
                    disabled={!query || !!invalid}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <BookmarkPlus className="size-4 text-muted-foreground" />
                    Save as new
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => showDialog(true)}
                    disabled={!query || !!invalid}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <Pencil className="size-4 text-muted-foreground" />
                    Update collection
                  </Menu.Item>
                  <div role="separator" className="-mx-1 my-1 h-px bg-border" />
                  <Menu.Item
                    onClick={() => {
                      setError('')
                      setDeleting(true)
                    }}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-destructive outline-none data-highlighted:bg-destructive/10"
                  >
                    <Trash2 className="size-4" />
                    Delete collection
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!query || !!invalid}
          onClick={() => showDialog(false)}
        >
          <BookmarkPlus className="size-3.5" />
          Save smart collection
        </Button>
      )}
      {invalid && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {invalid}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Update smart collection' : 'Save smart collection'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editing
                ? 'Update the name and filters for this smart collection.'
                : 'Save the current search and filters as a smart collection.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4 pt-1"
            onSubmit={async (event) => {
              event.preventDefault()
              setBusy(true)
              setError('')
              try {
                const saved = await save({
                  ...(editing && selected ? { id: selected.id } : {}),
                  name,
                  query,
                })
                setOpen(false)
                navigate(`${saved.query}&smart=${saved.id}`)
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : 'Could not save.',
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            <div className="space-y-2">
              <label
                htmlFor="smart-collection-name"
                className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="smart-collection-name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Titanium folders"
                aria-invalid={Boolean(error)}
              />
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{selected?.name}”?</DialogTitle>
            <DialogDescription>
              This removes the saved view, not any knives.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!selected) return
                setBusy(true)
                try {
                  await remove(selected.id)
                  setDeleting(false)
                  navigate(query)
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : 'Could not delete.',
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
