import { renderHistory, OVERWRITE_COLORS, escapeHtml, type CharEntry } from './player'

// Builds the self-contained HTML document that the main process renders to PDF in an
// offscreen window. Everything is inlined (no external CSS/fonts) and uses a fixed
// light theme. The on-screen light yellow (#fef08a) is hard to read on white, so the
// export substitutes a darker amber for pasted text/boxes.

export interface ExportSection {
  tabName?: string
  history: CharEntry[]  // end-of-replay char history (from Player.getHistory())
}

export interface ExportMeta {
  title: string
  createdAt?: string
}

const EXPORT_PASTE = '#a16207'                                 // darker, print-readable yellow
const OVERWRITE_RED = OVERWRITE_COLORS[OVERWRITE_COLORS.length - 1]

// Colored elements need print-color-adjust so backgrounds/borders survive printing,
// alongside printToPDF({ printBackground: true }).
const COLOR_EXACT = 'print-color-adjust:exact;-webkit-print-color-adjust:exact'

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function countTypes(sections: ExportSection[]): { typed: number; pasted: number; overwrite: number } {
  let typed = 0, pasted = 0, overwrite = 0
  for (const s of sections) {
    for (const e of s.history) {
      if (e.type === 'typed') typed++
      else if (e.type === 'pasted') pasted++
      else overwrite++
    }
  }
  return { typed, pasted, overwrite }
}

function statsBlock(sections: ExportSection[]): string {
  const { typed, pasted, overwrite } = countTypes(sections)
  const total = typed + pasted + overwrite
  if (total === 0) return ''
  const pct = (n: number) => Math.round((n / total) * 100)
  const seg = (w: number, color: string) =>
    w > 0 ? `<span style="display:inline-block;height:100%;width:${w}%;background:${color};${COLOR_EXACT}"></span>` : ''
  const label = (name: string, n: number, color: string) =>
    n > 0 ? `<span style="margin-right:1.2em;color:${color};${COLOR_EXACT}">${name} ${pct(n)}% <span style="opacity:.6">(${n})</span></span>` : ''
  return `
    <div class="stats">
      <div class="stat-bar">${seg(pct(typed), '#6b7280')}${seg(pct(pasted), EXPORT_PASTE)}${seg(pct(overwrite), OVERWRITE_RED)}</div>
      <div class="stat-labels">${label('typed', typed, '#374151')}${label('pasted', pasted, EXPORT_PASTE)}${label('overwrite', overwrite, OVERWRITE_RED)}</div>
    </div>`
}

function legendBlock(): string {
  const box = `border:1px solid ${EXPORT_PASTE};border-radius:2px;padding:0 2px`
  const item = (label: string, swatch: string) =>
    `<span class="legend-item"><span class="legend-swatch" style="${swatch};${COLOR_EXACT}">Aa</span>${label}</span>`
  return `
    <div class="legend">
      ${item('typed', `color:#1a1a1a`)}
      ${item('pasted', `color:${EXPORT_PASTE};${box}`)}
      ${item('overwrite', `color:${OVERWRITE_RED}`)}
      ${item('pasted overwrite', `color:${OVERWRITE_RED};${box}`)}
    </div>`
}

function sectionBlock(section: ExportSection): string {
  const heading = section.tabName ? `<h3>${escapeHtml(section.tabName)}</h3>` : ''
  const plainText = section.history.map(e => e.char).join('')
  const coloredHtml = renderHistory(section.history, EXPORT_PASTE)
  return `
    ${heading}
    <h2>Final document</h2>
    <div class="doc">${escapeHtml(plainText)}</div>
    <h2 class="page-break">Color-coded <span class="subtle">(end of replay)</span></h2>
    <div class="doc colored">${coloredHtml}</div>`
}

export function buildExportHtml(sections: ExportSection[], meta: ExportMeta): string {
  const date = formatDate(meta.createdAt)
  const body = sections.map(sectionBlock).join('\n<hr class="section-sep">\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(meta.title || 'graphine')}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    color: #1a1a1a;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 12pt;
    line-height: 1.7;
  }
  header { border-bottom: 1px solid #e5e5e5; padding-bottom: 0.6em; margin-bottom: 1.4em; }
  h1 { font-size: 20pt; margin: 0 0 0.2em; }
  .date { color: #6b7280; font-size: 10pt; }
  h2 { font-size: 12pt; font-weight: bold; color: #374151; margin: 1.6em 0 0.5em;
       text-transform: uppercase; letter-spacing: 0.06em; }
  h2 .subtle, .subtle { font-weight: normal; text-transform: none; letter-spacing: 0; color: #9ca3af; }
  h3 { font-size: 13pt; margin: 1.2em 0 0.4em; }
  /* The color-coded section always begins on its own page. */
  .page-break { break-before: page; page-break-before: always; }
  .doc { white-space: pre-wrap; word-wrap: break-word; tab-size: 4; }
  .stats { margin-top: 0.8em; font-size: 10pt; }
  .stat-bar { height: 6px; border-radius: 3px; overflow: hidden; background: #f1f1ee; margin-bottom: 0.4em; }
  .stat-labels { color: #374151; }
  .legend { margin-top: 0.6em; font-size: 10pt; color: #374151; }
  .legend-item { margin-right: 1.4em; white-space: nowrap; }
  .legend-swatch { display: inline-block; margin-right: 0.35em; padding: 0 2px; font-size: 9pt; }
  .section-sep { border: none; border-top: 1px solid #e5e5e5; margin: 2em 0; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(meta.title || 'Untitled document')}</h1>
    ${date ? `<div class="date">${escapeHtml(date)}</div>` : ''}
    ${statsBlock(sections)}
    ${legendBlock()}
  </header>
  ${body}
</body>
</html>`
}
