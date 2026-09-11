'use client'

import { createContext, useContext, useState } from 'react'

type KnifeFamilyPanelContextValue = {
  openFamilyKey: string | null
  setOpenFamilyKey: (familyKey: string | null) => void
}

const KnifeFamilyPanelContext =
  createContext<KnifeFamilyPanelContextValue | null>(null)

export function KnifeFamilyPanelProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [openFamilyKey, setOpenFamilyKey] = useState<string | null>(null)

  return (
    <KnifeFamilyPanelContext.Provider
      value={{ openFamilyKey, setOpenFamilyKey }}
    >
      {children}
    </KnifeFamilyPanelContext.Provider>
  )
}

export function useKnifeFamilyPanel() {
  const context = useContext(KnifeFamilyPanelContext)
  if (!context) throw new Error('KnifeFamilyPanelProvider is required')
  return context
}
