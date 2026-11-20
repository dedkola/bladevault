import { describe, expect, it } from 'vitest'
import { workspaceCrumb } from '@/lib/workspace-crumb'

describe('workspaceCrumb', () => {
  it('names every page instead of falling back to Insights', () => {
    expect(workspaceCrumb('/price-drops')).toEqual([
      'Collection',
      'Price Drops',
    ])
    expect(workspaceCrumb('/insights')).toEqual(['Workspace', 'Insights'])
    expect(workspaceCrumb('/insights/value')).toEqual(['Workspace', 'Insights'])
    expect(workspaceCrumb('/collection')).toEqual(['Collection', 'All knives'])
    expect(workspaceCrumb('/collection/abc')).toEqual([
      'Collection',
      'Knife details',
    ])
    expect(workspaceCrumb('/add')).toEqual(['Collection', 'Add knife'])
    expect(workspaceCrumb('/studio')).toEqual(['Studio', 'Visual library'])
    expect(workspaceCrumb('/compare')).toEqual(['Compare', 'Saved comparisons'])
    expect(workspaceCrumb('/maintenance/log')).toEqual([
      'Activity',
      'Maintenance',
    ])
    expect(workspaceCrumb('/logs')).toEqual(['Activity', 'History'])
    expect(workspaceCrumb('/settings')).toEqual(['Workspace', 'Settings'])
    expect(workspaceCrumb('/inbox')).toEqual(['Workspace', 'Inbox'])
  })

  it('does not call an unknown page Insights', () => {
    expect(workspaceCrumb('/nope')).toEqual(['Workspace', 'Page not found'])
  })
})
