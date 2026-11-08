import { createLucideIcon } from 'lucide-react'

// "Head to head": two arrows meeting at a center line. Built with Lucide's
// factory so it accepts the same props and default classes as Lucide icons.
export const CompareIcon = createLucideIcon('compare-head-to-head', [
  ['path', { d: 'M3 12h6', key: 'left-shaft' }],
  ['path', { d: 'm6 9 3 3-3 3', key: 'left-head' }],
  ['path', { d: 'M21 12h-6', key: 'right-shaft' }],
  ['path', { d: 'm18 9-3 3 3 3', key: 'right-head' }],
  ['path', { d: 'M12 4v16', key: 'center' }],
])
