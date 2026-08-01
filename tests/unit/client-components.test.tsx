// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FilterMultiSelect } from '@/components/filter-multi-select'
import { SearchField } from '@/components/search-field'

function ControlledSearch() {
  const [value, setValue] = useState('Bugout')
  return <SearchField value={value} onChange={setValue} />
}

describe('client collection controls', () => {
  it('clears search and restores focus to the input', async () => {
    const user = userEvent.setup()
    render(<ControlledSearch />)

    const input = screen.getByRole('searchbox')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('focuses filter search on open and returns focus to the trigger on Escape', async () => {
    const user = userEvent.setup()
    render(
      <FilterMultiSelect
        label="Brand"
        options={['Benchmade', 'Spyderco']}
        selectedValues={[]}
        onToggleValue={vi.fn()}
        onSelectAll={vi.fn()}
        onClear={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Brand' })
    await user.click(trigger)
    expect(screen.getByPlaceholderText('Search brand...')).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
