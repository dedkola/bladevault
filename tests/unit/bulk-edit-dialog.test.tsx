// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BulkEditDialog } from '@/components/bulk-edit-dialog'
import { builtInBulkEditFields } from '@/lib/bulk-edit'
import { createKnife } from '@/tests/fixtures/knife'
import type { DimensionUnit } from '@/lib/settings-shared'

const settings = vi.hoisted(() => ({ dimensionUnit: 'mm' as DimensionUnit }))
vi.mock('@/components/providers/knives-provider', () => ({
  useKnives: () => settings,
}))

afterEach(() => {
  cleanup()
  settings.dimensionUnit = 'mm'
})

function renderDialog(onApply = vi.fn().mockResolvedValue(undefined)) {
  const base = createKnife()
  const knife = createKnife({
    specs: { ...base.specs, bladeLength: '3.5 in', weight: '1 oz' },
  })
  render(
    <BulkEditDialog
      open
      allKnives={[knife]}
      selectedKnives={[knife]}
      fields={[...builtInBulkEditFields]}
      onOpenChange={vi.fn()}
      onApply={onApply}
    />,
  )
  return onApply
}

async function chooseField(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole('combobox'))
  await user.click(await screen.findByRole('option', { name }))
}

describe('bulk measurement editing', () => {
  it.each([
    ['Blade Length', 'mm', '90', 'specs.bladeLength', '90 mm'],
    ['Weight', 'g', '120', 'specs.weight', '120 g'],
  ])(
    'adds the selected metric unit when bulk editing %s',
    async (label, unit, entered, field, stored) => {
      const user = userEvent.setup()
      const onApply = renderDialog()
      await chooseField(user, label)
      await user.type(
        screen.getByLabelText(`New ${label.toLowerCase()} (${unit})`),
        entered,
      )
      await user.click(screen.getByRole('button', { name: 'Update 1 knife' }))
      expect(onApply).toHaveBeenCalledExactlyOnceWith(field, stored)
    },
  )

  it('shows converted current values and retains raw suggestion values', async () => {
    settings.dimensionUnit = 'both'
    const user = userEvent.setup()
    renderDialog()
    await chooseField(user, 'Blade Length')
    expect(screen.getByText('1 88.9 mm / 3.5 in')).toBeInTheDocument()
    const inches = screen.getByLabelText('New blade length (in)')
    expect(inches).toHaveAttribute('list', 'bulk-edit-values-specs.bladeLength')
    expect(document.querySelector('datalist option')).toHaveAttribute(
      'value',
      '3.5 in',
    )
    await user.type(inches, '4')
    expect(screen.getByLabelText('New blade length (mm)')).toHaveValue('101.6')
  })

  it('keeps linked measurement fields disabled until a bulk save finishes', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const onApply = vi.fn(() => pending)
    const user = userEvent.setup()
    renderDialog(onApply)
    await chooseField(user, 'Blade Length')
    const input = screen.getByLabelText('New blade length (mm)')
    await user.type(input, '90')
    await user.click(screen.getByRole('button', { name: 'Update 1 knife' }))
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => {
      finish()
      await pending
    })
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      'specs.bladeLength',
      '90 mm',
    )
  })

  it('preserves ordinary text entry for non-measurement fields', async () => {
    const user = userEvent.setup()
    const onApply = renderDialog()
    await chooseField(user, 'Brand / Maker')
    await user.type(screen.getByLabelText('New value'), 'Updated maker')
    await user.click(screen.getByRole('button', { name: 'Update 1 knife' }))
    expect(onApply).toHaveBeenCalledExactlyOnceWith('brand', 'Updated maker')
  })
})
