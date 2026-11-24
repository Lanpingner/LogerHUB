'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface LogFilters {
  query: string
  methods: string[]
  statusClasses: string[]
  levels: string[]
  environment: string
  application: string
  service: string
}

export const EMPTY_FILTERS: LogFilters = {
  query: '',
  methods: [],
  statusClasses: [],
  levels: [],
  environment: '',
  application: '',
  service: '',
}

export const DEFAULT_COLUMNS = [
  'ts',
  'level',
  'application',
  'service',
  'method',
  'path',
  'status',
  'duration',
  'company',
  'user',
  'request_id',
  'instance',
] as const

export type ColumnKey = (typeof DEFAULT_COLUMNS)[number]

interface ConsoleState {
  /** Panel geometry and collapsed state, persisted so a reload keeps the layout. */
  sidebarCollapsed: boolean
  sidebarWidth: number
  inspectorWidth: number
  histogramOpen: boolean
  bottomPanelOpen: boolean
  treeExpanded: string[]

  range: string
  filters: LogFilters
  columns: ColumnKey[]
  rawMode: boolean
  autoScroll: boolean
  streaming: boolean

  queryHistory: string[]
  savedQueries: { name: string; query: string }[]

  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  toggleHistogram: () => void
  toggleBottomPanel: () => void
  toggleTreeNode: (id: string) => void

  setRange: (r: string) => void
  patchFilters: (p: Partial<LogFilters>) => void
  resetFilters: () => void
  setColumns: (c: ColumnKey[]) => void
  setRawMode: (v: boolean) => void
  setAutoScroll: (v: boolean) => void
  setStreaming: (v: boolean) => void

  rememberQuery: (q: string) => void
  saveQuery: (name: string, query: string) => void
  removeSavedQuery: (name: string) => void
}

export const useConsole = create<ConsoleState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      sidebarWidth: 220,
      inspectorWidth: 460,
      histogramOpen: true,
      bottomPanelOpen: false,
      treeExpanded: ['production'],

      range: '1h',
      filters: EMPTY_FILTERS,
      columns: [...DEFAULT_COLUMNS],
      rawMode: false,
      autoScroll: true,
      streaming: true,

      queryHistory: [],
      savedQueries: [],

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.min(420, Math.max(180, w)) }),
      setInspectorWidth: (w) => set({ inspectorWidth: Math.min(900, Math.max(320, w)) }),
      toggleHistogram: () => set((s) => ({ histogramOpen: !s.histogramOpen })),
      toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
      toggleTreeNode: (id) =>
        set((s) => ({
          treeExpanded: s.treeExpanded.includes(id)
            ? s.treeExpanded.filter((x) => x !== id)
            : [...s.treeExpanded, id],
        })),

      setRange: (range) => set({ range }),
      patchFilters: (p) => set((s) => ({ filters: { ...s.filters, ...p } })),
      resetFilters: () => set({ filters: EMPTY_FILTERS }),
      setColumns: (columns) => set({ columns }),
      setRawMode: (rawMode) => set({ rawMode }),
      setAutoScroll: (autoScroll) => set({ autoScroll }),
      setStreaming: (streaming) => set({ streaming }),

      rememberQuery: (q) => {
        const trimmed = q.trim()
        if (!trimmed) return
        const history = [trimmed, ...get().queryHistory.filter((x) => x !== trimmed)].slice(0, 25)
        set({ queryHistory: history })
      },
      saveQuery: (name, query) =>
        set((s) => ({ savedQueries: [...s.savedQueries.filter((q) => q.name !== name), { name, query }] })),
      removeSavedQuery: (name) => set((s) => ({ savedQueries: s.savedQueries.filter((q) => q.name !== name) })),
    }),
    {
      name: 'logerhub.console',
      version: 1,
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        inspectorWidth: s.inspectorWidth,
        histogramOpen: s.histogramOpen,
        bottomPanelOpen: s.bottomPanelOpen,
        treeExpanded: s.treeExpanded,
        range: s.range,
        filters: s.filters,
        columns: s.columns,
        rawMode: s.rawMode,
        autoScroll: s.autoScroll,
        queryHistory: s.queryHistory,
        savedQueries: s.savedQueries,
      }),
    },
  ),
)
