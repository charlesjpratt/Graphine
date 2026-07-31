// The minimap mirrors the *rendered* geometry of the write area: one bar per visual line,
// placed and sized from the real client rects of the text. Deriving it from layout rather than
// from the character stream is what makes it correspond to what's on screen — a paragraph that
// wraps over eight rows draws eight bars, blank lines leave gaps, indentation and centring show
// up, and a font-size change re-flows the map for free.
//
// Bars and the viewport box share one vertical scale (document px → canvas px), so the box
// always frames exactly the lines that are on screen, and a click maps back to the line under
// the cursor.

const PAD = 7                // canvas side padding, px
const MAX_LINE_PITCH = 3     // canvas px per rendered line before the map compresses to fit
const MIN_BAR_W = 0.5
const MIN_BAR_H = 0.6
const MIN_VIEWPORT_H = 8
// Reading line geometry costs ~1ms per 1000 rendered rows. Past this budget the map stops
// riding requestAnimationFrame and redraws on a trailing timer instead, so a very long
// document can't turn every keystroke into a long frame.
const FRAME_BUDGET_MS = 8
const SLOW_REDRAW_MS = 200

interface LineBox {
  top: number     // px from the top of the scrollable content
  left: number    // px from the left edge of the write area
  width: number
  height: number
}

export function setupMinimap(
  scrollEl: HTMLElement,
  contentEl: HTMLElement,
  canvas: HTMLCanvasElement,
): void {
  let raf: ReturnType<typeof requestAnimationFrame> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Document px → canvas px, from the last draw. jumpTo() inverts it.
  let scale = 1
  // Line geometry is expressed in scroll-content coordinates, so scrolling doesn't change it.
  // Only an edit or a re-layout does — exactly what invalidate() is wired to.
  let cachedBoxes: LineBox[] | null = null
  let lastGeometryCost = 0

  function schedule(): void {
    if (raf !== null || timer !== null) return
    if (cachedBoxes === null && lastGeometryCost > FRAME_BUDGET_MS) {
      timer = setTimeout(() => { timer = null; draw() }, SLOW_REDRAW_MS)
    } else {
      raf = requestAnimationFrame(() => { raf = null; draw() })
    }
  }

  function invalidate(): void {
    cachedBoxes = null
    schedule()
  }

  // Every visual line box in the document. A Range over a text node yields one rect per line
  // fragment, so wrapped text comes back already split at its wrap points.
  function lineBoxes(scrollTop: number, scrollRect: DOMRect, areaRect: DOMRect): LineBox[] {
    const boxes: LineBox[] = []
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      // Whitespace-only nodes (the newlines between block elements in saved HTML) render
      // nothing meaningful; drawing them would put bars on lines that look empty.
      if (node.nodeValue === null || node.nodeValue.trim() === '') continue
      range.selectNodeContents(node)
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue
        boxes.push({
          top: r.top - scrollRect.top + scrollTop,
          left: r.left - areaRect.left,
          width: r.width,
          height: r.height,
        })
      }
    }
    return boxes
  }

  function lineHeight(): number {
    const lh = parseFloat(getComputedStyle(contentEl).lineHeight)
    return Number.isFinite(lh) && lh > 0 ? lh : 24
  }

  function draw(): void {
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    if (W === 0 || H === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const contentH = scrollEl.scrollHeight
    const viewH = scrollEl.clientHeight
    if (contentH <= 0) return

    // The whole document always fits the canvas, so the map never needs its own scrollbar.
    // Short documents stop expanding at MAX_LINE_PITCH rather than stretching a handful of
    // lines down the full height.
    scale = Math.min(MAX_LINE_PITCH / lineHeight(), H / contentH)

    const scrollTop = scrollEl.scrollTop
    const scrollRect = scrollEl.getBoundingClientRect()
    const areaRect = contentEl.getBoundingClientRect()
    const areaW = areaRect.width || 1
    const textW = Math.max(1, W - PAD * 2)

    if (cachedBoxes === null) {
      const t0 = performance.now()
      cachedBoxes = lineBoxes(scrollTop, scrollRect, areaRect)
      lastGeometryCost = performance.now() - t0
    }

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    ctx.fillStyle = dark ? 'rgba(200,200,196,0.50)' : 'rgba(40,40,36,0.38)'
    for (const box of cachedBoxes) {
      const x = PAD + (box.left / areaW) * textW
      const w = Math.max(MIN_BAR_W, (box.width / areaW) * textW)
      const h = Math.max(MIN_BAR_H, box.height * scale - 0.5)
      ctx.fillRect(x, box.top * scale, Math.min(w, W - x - PAD / 2), h)
    }

    // Viewport indicator, on the same scale as the bars.
    if (contentH > viewH + 2) {
      const vTop = scrollTop * scale
      const vH = Math.max(MIN_VIEWPORT_H, viewH * scale)
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
      ctx.fillRect(0, vTop, W, vH)
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, vTop + 0.5, W - 1, vH - 1)
    }
  }

  // Centre the clicked line in the viewport — the inverse of the mapping draw() used.
  function jumpTo(clientY: number): void {
    const rect = canvas.getBoundingClientRect()
    const docY = (clientY - rect.top) / scale
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, docY - scrollEl.clientHeight / 2))
  }

  let dragging = false
  canvas.addEventListener('mousedown', (e) => { dragging = true; jumpTo(e.clientY) })
  window.addEventListener('mousemove', (e) => { if (dragging) jumpTo(e.clientY) })
  window.addEventListener('mouseup', () => { dragging = false })

  // A MutationObserver rather than an 'input' listener: most of what changes this document
  // never fires input — switching tabs, opening a file, undo/redo and replay all rewrite the
  // write area's HTML directly, and the old listener left the previous document on screen.
  new MutationObserver(invalidate).observe(contentEl, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,  // font/style spans re-flow the text without changing it
  })
  // The write area is a stretched flex item, so its own box height tracks the viewport rather
  // than the document — growing the document does NOT resize it, and the MutationObserver
  // above is what keeps the map current. This observer is for width changes (window resize,
  // sidebar toggle) that re-wrap the text, and for the canvas's own collapse/expand.
  const ro = new ResizeObserver(invalidate)
  ro.observe(canvas)
  ro.observe(contentEl)
  // Scrolling moves the viewport box over unchanged geometry, so it redraws from the cache.
  scrollEl.addEventListener('scroll', schedule)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule)
  invalidate()
}
