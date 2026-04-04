/**
 * CodeMirror 6 language + theme helpers for the project file preview editor.
 * @see https://codemirror.net/
 * @see https://github.com/uiwjs/react-codemirror
 */

import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'

/** Lezer-based highlighting for paths we recognize; empty → plain text (no highlighting). */
export function languageExtensionsForPath(relPath) {
  const base = (String(relPath).split(/[/\\]/).pop() || '').toLowerCase()
  if (base.endsWith('.html') || base.endsWith('.htm')) return [html()]
  if (base.endsWith('.css')) return [css()]
  if (base.endsWith('.tsx')) return [javascript({ jsx: true, typescript: true })]
  if (base.endsWith('.ts')) return [javascript({ typescript: true })]
  if (base.endsWith('.jsx')) return [javascript({ jsx: true })]
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs')) return [javascript()]
  if (base.endsWith('.py') || base.endsWith('.pyw')) return [python()]
  return []
}

/** Tokens roughly aligned with app light theme (theme.css --bg-deep / --text-primary). */
const adaLightChrome = EditorView.theme(
  {
    '&': {
      backgroundColor: '#f6f8fa',
      color: '#1f2328',
    },
    '.cm-scroller': {
      fontFamily: "ui-monospace, 'Consolas', 'Monaco', monospace",
      fontSize: '0.75rem',
      lineHeight: '1.5',
    },
    '.cm-content': {
      caretColor: '#0969da',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#0969da',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(9, 105, 218, 0.06)',
    },
    '&.cm-focused .cm-selectionBackground, & .cm-content ::selection': {
      backgroundColor: 'rgba(9, 105, 218, 0.25) !important',
    },
  },
  { dark: false },
)

const adaLightHighlight = syntaxHighlighting(defaultHighlightStyle, { fallback: true })

const adaLightTheme = [adaLightChrome, adaLightHighlight]

const adaDarkTypography = EditorView.theme(
  {
    '.cm-scroller': {
      fontFamily: "ui-monospace, 'Consolas', 'Monaco', monospace",
      fontSize: '0.75rem',
      lineHeight: '1.5',
    },
  },
  { dark: true },
)

/** Dark: one-dark + app typography; light: GitHub-like chrome + default highlight styles. */
export function themeExtensionsForScheme(colorScheme) {
  if (colorScheme === 'light') return adaLightTheme
  return [oneDark, adaDarkTypography]
}
