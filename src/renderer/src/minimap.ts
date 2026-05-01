export function setupMinimap(
  scrollEl: HTMLElement,
  contentEl: HTMLElement,
  canvas: HTMLCanvasElement,
): void {
  let raf: ReturnType<typeof requestAnimationFrame> | null = null

  function schedule(): void {
    if (raf !== null) return
    raf = requestAnimationFrame(() => { raf = null; draw() })
  }

  function draw(): void {
    const dpr = window.devicePixelRatio || 1
    const W = canvas.offsetWidth
    const H = canvas.offsetHeight
    if (W === 0 || H === 0) return

    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const text = contentEl.innerText || ''
    const lines = text === '' ? [] : text.split('\n')
    const count = lines.length

    const PAD = 7
    const textW = W - PAD * 2
    const MAX_CHARS = 72
    const LINE_H = Math.min(2.5, (H - 4) / Math.max(count, 1))
    const BAR_H = Math.max(0.8, LINE_H - 0.5)

    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    ctx.fillStyle = dark ? 'rgba(200,200,196,0.50)' : 'rgba(40,40,36,0.38)'
    for (let i = 0; i < count; i++) {
      const len = lines[i].length
      if (len === 0) continue
      const barW = Math.min(len / MAX_CHARS, 1) * textW
      ctx.fillRect(PAD, 2 + i * LINE_H, barW, BAR_H)
    }

    // Viewport indicator
    const { scrollTop, scrollHeight, clientHeight } = scrollEl
    if (scrollHeight > clientHeight + 2) {
      const vTop = (scrollTop / scrollHeight) * H
      const vH = Math.max(20, (clientHeight / scrollHeight) * H)
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
      ctx.fillRect(0, vTop, W, vH)
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, vTop + 0.5, W - 1, vH - 1)
    }
  }

  function jumpTo(clientY: number): void {
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight
    scrollEl.scrollTop = Math.max(0, Math.min(maxScroll,
      ratio * scrollEl.scrollHeight - scrollEl.clientHeight / 2
    ))
  }

  let dragging = false
  canvas.addEventListener('mousedown', (e) => { dragging = true; jumpTo(e.clientY) })
  window.addEventListener('mousemove', (e) => { if (dragging) jumpTo(e.clientY) })
  window.addEventListener('mouseup', () => { dragging = false })

  contentEl.addEventListener('input', schedule)
  scrollEl.addEventListener('scroll', schedule)
  new ResizeObserver(schedule).observe(canvas)
  schedule()
}
