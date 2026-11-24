'use client'

import { createTheme } from '@mui/material/styles'
import { C, MONO, SANS } from './tokens'

/** One central theme with the specification's tokens and component overrides,
 *  so individual components never hand-roll colours or radii. */
export const theme = createTheme({
  cssVariables: true,
  palette: {
    mode: 'dark',
    background: { default: C.bg, paper: C.panel },
    primary: { main: C.accent, contrastText: '#07140C' },
    secondary: { main: C.info },
    success: { main: C.success },
    warning: { main: C.warning },
    error: { main: C.error },
    info: { main: C.info },
    text: { primary: C.text, secondary: C.text2, disabled: C.muted },
    divider: C.border,
  },
  shape: { borderRadius: 4 },
  spacing: 4,
  typography: {
    fontFamily: SANS,
    fontSize: 13,
    htmlFontSize: 16,
    h1: { fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' },
    h2: { fontSize: 15, fontWeight: 600 },
    h3: { fontSize: 13, fontWeight: 600 },
    body1: { fontSize: 13 },
    body2: { fontSize: 12 },
    caption: { fontSize: 11, color: C.text2 },
    button: { fontSize: 12, textTransform: 'none', fontWeight: 500 },
  },
  shadows: [
    'none',
    'none',
    '0 4px 14px rgba(0,0,0,0.5)',
    ...Array(22).fill('0 8px 28px rgba(0,0,0,0.55)'),
  ] as never,
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        '*': { scrollbarColor: C.border + ' transparent', scrollbarWidth: 'thin' },
        '*::-webkit-scrollbar': { width: 10, height: 10 },
        '*::-webkit-scrollbar-thumb': {
          background: C.border,
          borderRadius: 5,
          border: '2px solid transparent',
          backgroundClip: 'padding-box',
        },
        '*::-webkit-scrollbar-thumb:hover': { background: '#33414f' },
        html: { height: '100%' },
        body: {
          height: '100%',
          overflow: 'hidden',
          background: C.bg,
          fontFeatureSettings: '"tnum" 0',
        },
        '#__next, main': { height: '100%' },
        '.mono': { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' },
        '::selection': { background: C.selected, color: C.text },
      },
    },
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiButton: {
      defaultProps: { size: 'small', variant: 'outlined' },
      styleOverrides: {
        root: { minHeight: 26, padding: '2px 10px', borderRadius: 4 },
        outlined: { borderColor: C.border, color: C.text, '&:hover': { borderColor: '#33414f', background: C.raised } },
        contained: { boxShadow: 'none', '&:hover': { boxShadow: 'none' } },
      },
    },
    MuiIconButton: {
      defaultProps: { size: 'small' },
      styleOverrides: {
        root: { borderRadius: 4, color: C.text2, padding: 5, '&:hover': { background: C.raised, color: C.text } },
      },
    },
    MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          background: C.raised,
          borderRadius: 4,
          fontSize: 12,
          '& fieldset': { borderColor: C.border },
          '&:hover fieldset': { borderColor: '#33414f' },
          '&.Mui-focused fieldset': { borderColor: C.accent, borderWidth: 1 },
        },
        input: { padding: '5px 9px' },
      },
    },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiMenu: {
      styleOverrides: {
        paper: { background: C.raised, border: '1px solid ' + C.border, borderRadius: 4, marginTop: 2 },
        list: { padding: 2 },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: 12,
          minHeight: 26,
          borderRadius: 3,
          '&.Mui-selected': { background: C.selected, color: C.text },
          '&.Mui-selected:hover': { background: C.selected },
        },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: false, enterDelay: 400 },
      styleOverrides: {
        tooltip: {
          background: C.raised,
          border: '1px solid ' + C.border,
          color: C.text,
          fontSize: 11,
          borderRadius: 4,
          padding: '4px 8px',
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 32, borderBottom: '1px solid ' + C.border },
        indicator: { height: 2, background: C.accent },
        flexContainer: { gap: 2 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 32,
          padding: '0 10px',
          fontSize: 12,
          color: C.text2,
          '&.Mui-selected': { color: C.text },
        },
      },
    },
    MuiChip: {
      defaultProps: { size: 'small' },
      styleOverrides: {
        root: { height: 18, fontSize: 10.5, borderRadius: 3, fontWeight: 500 },
        label: { padding: '0 6px' },
      },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: C.border } } },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none', border: '1px solid ' + C.border, borderRadius: 4 },
      },
    },
    MuiDialog: { styleOverrides: { paper: { background: C.panel } } },
    MuiCheckbox: { defaultProps: { size: 'small' }, styleOverrides: { root: { padding: 3 } } },
    MuiSwitch: { defaultProps: { size: 'small' } },
    MuiLinearProgress: { styleOverrides: { root: { height: 2, background: C.border } } },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: C.border, padding: '4px 10px', fontSize: 12 },
        head: { background: C.raised, color: C.text2, fontWeight: 500, fontSize: 11 },
      },
    },
  },
})
