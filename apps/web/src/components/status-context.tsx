'use client'

import { createContext, useContext } from 'react'
import type { StatusFacts } from './StatusBar'

/** Pages publish the facts the status bar shows, so the bar stays a single
 *  component rather than every page rendering its own. */
export const StatusFactsContext = createContext<(facts: StatusFacts) => void>(() => {})

export function useStatusFacts() {
  return useContext(StatusFactsContext)
}
