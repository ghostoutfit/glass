// renderer.js — glass v2 canvas renderer
//
// Ported from concrete v5 renderer.js. Key differences from the concrete version:
//   - Atom types: Si (gold), O (red), Na (green), Ca (blue)
//     In concrete: Ca is the cement matrix. In glass: Si is the network former,
//     Na and Ca are modifier ions. Same element symbols, completely different roles.
//   - Particle shape: { x0, y0, x, y, type, r, typeId, cellType, vx, vy }
//     No `isGrain` bool; grain membership is inferred from `cellType` ('SiO2'/'Na2O'/'CaO').
//     Freed particles tracked via phys.latticeFreed (Uint8Array).
//   - Bond shape: { i, j, broken, strain, currentBreakStrain }
//     No `fieldAlpha`, `diagonal`, or `restLen` — all bonds are drawn, no skipping.
//   - Grain outlines: derived from phys.chunks (convex hulls) rather than phys.grains (bboxes).
//   - Visual scale: freed particles draw at real position; lattice particles amplify from x0/y0.
//
// Entry point: drawScene(canvas, phys, options)
//   canvas  — HTMLCanvasElement
//   phys    — glass meltPhysics state object
//   options — { ts, visualScale, bondRound, showField, bondNums }

export const VW = 600
export const VH = 350

const VISUAL_SCALE = 1   // 1:1 with physics — glass thermal motion is already visible at scale

export const C = {
  Si:  '#d4a020',   // gold  — network former
  O:   '#cc3a3a',   // red
  Na:  '#4aaa60',   // green — network modifier
  Ca:  '#4a96be',   // blue  — modifier (NOT cement matrix as in concrete)
}

const CHARGE_POS = '62,127,214'   // blue halo  — Si, Ca
const CHARGE_NEG = '231,131,42'   // orange halo — O, Na
const CHARGE_TYPES = { Si: CHARGE_POS, Ca: CHARGE_POS, O: CHARGE_NEG, Na: CHARGE_NEG }

const COORD_TARGET = [3, 2, 1, 2]   // Si, O, Na, Ca (typeId order) — used for bondNums debug

// Bond strain ramp: warm grey → violet → magenta → hot pink (matches concrete v4)
const COLOR_STOPS = [
  [0.00, 200, 196, 188],
  [0.20, 195,  90, 255],
  [0.55, 240,  30, 225],
  [1.00, 255,  70, 185],
]

function strainColor(strain, breakStrain) {
  const t = Math.min(1, Math.abs(strain) / Math.max(breakStrain * 0.45, 0.001))
  for (let k = 0; k < COLOR_STOPS.length - 1; k++) {
    const [t0, r0, g0, b0] = COLOR_STOPS[k]
    const [t1, r1, g1, b1] = COLOR_STOPS[k + 1]
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return `rgb(${Math.round(r0+(r1-r0)*u)},${Math.round(g0+(g1-g0)*u)},${Math.round(b0+(b1-b0)*u)})`
    }
  }
  return 'rgb(0,200,255)'
}

// Tapered lens shape centered on bond midpoint — always tapers to points at each atom
function fillLens(ctx, ax, ay, bx, by, bondRound) {
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 0.5) return
  const ux = (bx - ax) / len, uy = (by - ay) / len
  const px = -uy, py = ux
  const mx = (ax + bx) / 2, my = (ay + by) / 2
  const halfL = Math.min(len * 0.40, 7)
  const r  = Math.min(bondRound, halfL * 0.65)
  const cp = halfL * 0.45
  ctx.beginPath()
  ctx.moveTo(mx - halfL * ux, my - halfL * uy)
  ctx.bezierCurveTo(
    mx - cp * ux + r * px, my - cp * uy + r * py,
    mx + cp * ux + r * px, my + cp * uy + r * py,
    mx + halfL * ux, my + halfL * uy,
  )
  ctx.bezierCurveTo(
    mx + cp * ux - r * px, my + cp * uy - r * py,
    mx - cp * ux - r * px, my - cp * uy - r * py,
    mx - halfL * ux, my - halfL * uy,
  )
  ctx.closePath()
}

// Jitter disabled — actual physics thermal motion (THERMAL_SPEED × √T) provides
// the right animation at each temperature without artificial shimmer.
function canvasJitter(_idx, _t) { return { jx: 0, jy: 0 } }

// Fade bond lenses when atoms are far apart (stretched/breaking) to prevent ghost smears
function bondCurDistAlpha(dx, dy) {
  const d  = Math.hypot(dx, dy)
  const lo = 25   // normal bond range (max r0 in glass is 16px)
  const hi = 40
  if (d <= lo) return 1
  if (d >= hi) return 0
  return 1 - (d - lo) / (hi - lo)
}

// Andrew's monotone chain convex hull
function convexHull(pts) {
  if (pts.length < 3) return pts
  const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
  const s = [...pts].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])
  const lower = []
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = s.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], s[i]) <= 0)
      upper.pop()
    upper.push(s[i])
  }
  lower.pop(); upper.pop()
  return [...lower, ...upper]
}

// Offscreen layer cache — layers are reused across frames, recreated only on resize
const fieldLayerCache = new WeakMap()
const chunkLayerCache = new WeakMap()

function getLayer(cache, canvas) {
  let layer = cache.get(canvas)
  if (!layer || layer.width !== canvas.width || layer.height !== canvas.height) {
    layer = document.createElement('canvas')
    layer.width  = canvas.width
    layer.height = canvas.height
    cache.set(canvas, layer)
  }
  return layer
}

// ── drawScene ───────────────────────────────────────────────────────────────
// Main entry point. Call once per rAF frame.
//
// phys must have:
//   particles[]      — glass particle objects with x0/y0/x/y/type/r/typeId
//   bonds[]          — pair interaction bonds with i/j/broken/strain/currentBreakStrain
//   chunks[]         — grain groups with pIdxs/origSpread/bg/bdr  (optional)
//   latticeFreed     — Uint8Array: freed[i]=1 means particle i left the lattice (optional)
export function drawScene(canvas, phys, {
  ts          = 0,
  visualScale = VISUAL_SCALE,
  bondRound   = 1.6,
  showField   = true,
  showCharge  = false,
  darkMode    = true,
  bondNums    = false,
} = {}) {
  if (!canvas || !phys) return

  const dpr = window.devicePixelRatio || 1
  const W   = canvas.clientWidth
  const H   = canvas.clientHeight
  if (!W || !H) return

  const cw = Math.round(W * dpr)
  const ch = Math.round(H * dpr)
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }

  const ctx   = canvas.getContext('2d')
  const scale = Math.min(W / VW, H / VH) * dpr   // contain: all particles visible
  const offX  = (W * dpr - VW * scale) / 2
  const offY  = (H * dpr - VH * scale) / 2
  const bg    = darkMode ? '#1a1a1a' : '#ede8df'

  // Clear letterbox areas in background color
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, cw, ch)
  ctx.restore()

  ctx.setTransform(scale, 0, 0, scale, offX, offY)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, VW, VH)
  ctx.clip()
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, VW, VH)

  const { particles, bonds, chunks } = phys
  const latticeFreed = phys.latticeFreed
  const t = ts / 1000   // seconds for jitter functions

  // Visual position: lattice atoms are amplified from x0/y0; freed atoms show at real position
  const vx = (p, i) => latticeFreed?.[i] ? p.x : p.x0 + (p.x - p.x0) * visualScale
  const vy = (p, i) => latticeFreed?.[i] ? p.y : p.y0 + (p.y - p.y0) * visualScale

  // ── Chunk outlines (grain group silhouettes) ──
  // Drawn to an offscreen layer, blurred, then composited. The blur gives a
  // soft glow behind the atoms. Outlines fade as chunks disperse.
  if (chunks?.length) {
    const cl   = getLayer(chunkLayerCache, canvas)
    const cctx = cl.getContext('2d')
    cctx.clearRect(0, 0, cl.width, cl.height)
    const tr = ctx.getTransform()
    cctx.setTransform(tr.a, tr.b, tr.c, tr.d, tr.e, tr.f)

    for (const chunk of chunks) {
      if (!chunk.pIdxs.length) continue
      // Measure dissolution using real physics positions (not amplified)
      const realPts = chunk.pIdxs.map(i => [particles[i].x, particles[i].y])
      let cx = 0, cy = 0
      for (const [x, y] of realPts) { cx += x; cy += y }
      cx /= realPts.length; cy /= realPts.length
      const currSpread = realPts.reduce((s, [x, y]) => s + Math.hypot(x - cx, y - cy), 0) / realPts.length
      const alpha = Math.max(0, 1 - (currSpread / chunk.origSpread - 1.0) / 0.30)
      if (alpha < 0.01) continue
      // Draw hull around visual (amplified) positions so it matches atom placement on screen
      const visPts = chunk.pIdxs.map(i => [vx(particles[i], i), vy(particles[i], i)])
      const hull = convexHull(visPts)
      if (hull.length < 2) continue
      cctx.beginPath()
      cctx.moveTo(hull[0][0], hull[0][1])
      for (let k = 1; k < hull.length; k++) cctx.lineTo(hull[k][0], hull[k][1])
      cctx.closePath()
      cctx.globalAlpha = alpha * 0.18; cctx.fillStyle   = chunk.bg;  cctx.fill()
      cctx.globalAlpha = alpha * 0.80; cctx.strokeStyle = chunk.bdr; cctx.lineWidth = 1.5; cctx.stroke()
    }
    cctx.globalAlpha = 1

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(2px)'
    ctx.drawImage(cl, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── Charge halos — matches concrete v4: fixed 8px radius, solid at center ──
  if (showCharge && particles?.length) {
    for (let i = 0; i < particles.length; i++) {
      const p   = particles[i]
      const px  = vx(p, i)
      const py  = vy(p, i)
      const rgb = CHARGE_TYPES[p.type]
      if (!rgb) continue
      const cr  = 8
      const g   = ctx.createRadialGradient(px, py, 0, px, py, cr)
      g.addColorStop(0,     `rgba(${rgb},1.0)`)
      g.addColorStop(1/cr,  `rgba(${rgb},1.0)`)
      g.addColorStop(1,     `rgba(${rgb},0)`)
      ctx.fillStyle   = g
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(px, py, cr, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ── Bond strain field (blurred lens shapes) ──
  // All intact pair bonds drawn as strain-colored lenses on an offscreen layer,
  // blurred once, then composited. One filter pass instead of per-bond blur.
  if (showField && bonds?.length) {
    const fl   = getLayer(fieldLayerCache, canvas)
    const fctx = fl.getContext('2d')
    fctx.clearRect(0, 0, fl.width, fl.height)
    const tr = ctx.getTransform()
    fctx.setTransform(tr.a, tr.b, tr.c, tr.d, tr.e, tr.f)

    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      const pi = particles[bond.i], pj = particles[bond.j]
      const da = bondCurDistAlpha(pj.x - pi.x, pj.y - pi.y)
      if (da <= 0) continue
      fctx.globalAlpha = 0.75 * da
      fctx.fillStyle   = strainColor(bond.strain ?? 0, bond.currentBreakStrain ?? 0.03)
      fillLens(fctx, vx(pi, bond.i), vy(pi, bond.i), vx(pj, bond.j), vy(pj, bond.j), bondRound)
      fctx.fill()
    }

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(3px)'
    ctx.drawImage(fl, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── Atoms ──
  // Draw at visual (amplified) position + per-particle Lissajous jitter.
  ctx.lineWidth = 0.5
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    const { jx, jy } = canvasJitter(i, t)
    const px = vx(p, i) + jx
    const py = vy(p, i) + jy

    ctx.beginPath()
    ctx.arc(px, py, p.r, 0, Math.PI * 2)
    ctx.fillStyle   = C[p.type] ?? '#ffffff'
    ctx.globalAlpha = 0.88
    ctx.fill()
    ctx.strokeStyle = darkMode ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.25)'
    ctx.globalAlpha = 1
    ctx.stroke()
  }

  // ── Debug: bond-count labels on each atom ──
  if (bondNums && bonds?.length) {
    const n = particles.length
    const bondCnt = new Int32Array(n)
    for (const { i, j } of bonds) { bondCnt[i]++; bondCnt[j]++ }
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.font         = '6px monospace'
    for (let i = 0; i < n; i++) {
      const p   = particles[i]
      const { jx, jy } = canvasJitter(i, t)
      const px  = vx(p, i) + jx
      const py  = vy(p, i) + jy
      const cnt = bondCnt[i]
      const tgt = COORD_TARGET[p.typeId] ?? 2
      const col = cnt >= tgt ? '#00ff66' : cnt > 0 ? '#ffcc00' : '#ff4444'
      ctx.lineWidth   = 2.5
      ctx.strokeStyle = '#000'
      ctx.globalAlpha = 0.9
      ctx.strokeText(String(cnt), px, py)
      ctx.fillStyle   = col
      ctx.globalAlpha = 1
      ctx.fillText(String(cnt), px, py)
    }
  }

  ctx.restore()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
