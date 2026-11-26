/** Section and page names in the Modern layout's header breadcrumb. */
export function workspaceCrumb(pathname: string): [string, string] {
  if (pathname === '/collection') return ['Collection', 'All knives']
  if (pathname.startsWith('/collection/'))
    return ['Collection', 'Knife details']
  if (pathname.startsWith('/add')) return ['Collection', 'Add knife']
  if (pathname === '/studio') return ['Studio', 'Visual library']
  if (pathname.startsWith('/compare')) return ['Compare', 'Saved comparisons']
  if (pathname.startsWith('/wishlist')) return ['Collection', 'Wishlist']
  if (pathname.startsWith('/price-drops')) return ['Collection', 'Price Drops']
  if (pathname.startsWith('/chat')) return ['Workspace', 'Chat']
  if (pathname.startsWith('/maintenance')) return ['Activity', 'Maintenance']
  if (pathname.startsWith('/logs')) return ['Activity', 'History']
  if (pathname.startsWith('/insights')) return ['Workspace', 'Insights']
  if (pathname.startsWith('/settings')) return ['Workspace', 'Settings']
  if (pathname === '/inbox') return ['Workspace', 'Inbox']
  if (pathname.startsWith('/unlock')) return ['Workspace', 'Unlock']
  // Every page is listed above, so anything else is a missing page.
  return ['Workspace', 'Page not found']
}
