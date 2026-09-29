/**
 * Zero-dependency charts: terminal bar charts and standalone SVG files
 * (openable in any browser, embeddable in mail/docs). No canvas, no
 * native deps — a CRM on a text channel should still be able to draw.
 */
import { writeFileSync } from 'node:fs'

export interface Bar {
  label: string
  /** Text rendered after the bar (e.g. "3 deals", "40% → 1"). */
  sub?: string
  value: number
}

const BLOCK = '█'
const EMPTY = '░'

export function fmtCompact(v: number): string {
  const sign = v < 0 ? '-' : ''
  const a = Math.abs(v)
  if (a >= 1_000_000) {
    return `${sign}${(a / 1_000_000).toFixed(1)}M`
  }
  if (a >= 10_000) {
    return `${sign}${(a / 1000).toFixed(1)}k`
  }
  return `${sign}${Math.round(a)}`
}

export function terminalChart(title: string, bars: Bar[], width = 24): string {
  const nonzero = bars.some((b) => b.value > 0)
  if (bars.length === 0 || !nonzero) {
    return `${title}\n(no data)`
  }
  const max = Math.max(...bars.map((b) => b.value))
  const labelW = Math.min(22, Math.max(4, ...bars.map((b) => b.label.length)))
  const lines = bars.map((b) => {
    const filled = Math.max(0, Math.round((b.value / max) * width))
    const bar = (BLOCK.repeat(filled) + EMPTY.repeat(width - filled)).trimEnd()
    const right = b.sub
      ? `${fmtCompact(b.value)}  ${b.sub}`
      : fmtCompact(b.value)
    return `${b.label.padEnd(labelW)}  ${bar}  ${right}`
  })
  return [title, '', ...lines].join('\n')
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function svgChart(
  title: string,
  bars: Bar[],
  opts: { formatValue?: (v: number) => string } = {},
): string {
  const fmt = opts.formatValue ?? fmtCompact
  const rowH = 30
  const labelW = 150
  const barW = 320
  const w = labelW + barW + 150
  const h = Math.max(bars.length, 1) * rowH + 56
  const max = Math.max(...bars.map((b) => b.value), 1)
  const rows = bars
    .map((b, i) => {
      const y = 48 + i * rowH
      const bw = Math.max(2, Math.round((b.value / max) * barW))
      const value = esc(b.sub ? `${fmt(b.value)}  ${b.sub}` : fmt(b.value))
      return [
        `  <text x="${labelW - 8}" y="${y + 19}" text-anchor="end" font-size="13" fill="#374151" font-family="sans-serif">${esc(b.label)}</text>`,
        `  <rect x="${labelW}" y="${y + 5}" width="${bw}" height="19" rx="4" fill="#2563eb"/>`,
        `  <text x="${labelW + barW + 10}" y="${y + 19}" font-size="13" fill="#111827" font-family="sans-serif">${value}</text>`,
      ].join('\n')
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <title>${esc(title)}</title>
  <rect width="${w}" height="${h}" fill="#ffffff"/>
  <text x="16" y="28" font-size="16" font-weight="bold" fill="#111827" font-family="sans-serif">${esc(title)}</text>
${rows}
</svg>
`
}

/** Render `bars` to the terminal, or to `file` as SVG when a path is given. */
export function renderChart(
  title: string,
  bars: Bar[],
  file: string | undefined,
  opts: { formatValue?: (v: number) => string } = {},
): void {
  // `--chart` without a value gives `true`; only an actual path writes SVG.
  if (typeof file === 'string' && file.length > 0) {
    writeFileSync(file, svgChart(title, bars, opts))
    console.log(`Wrote ${file}`)
  } else {
    console.log(terminalChart(title, bars))
  }
}
