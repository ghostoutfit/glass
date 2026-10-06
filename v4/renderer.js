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

import { COORD_TARGET, ENERGY_UNIT } from './meltPhysics.js'

export const VW = 600
export const VH = 350

// Minimum image for renderer (matches physics miDx/miDy)
const riDx = dx => dx >  VW * 0.5 ? dx - VW : dx < -VW * 0.5 ? dx + VW : dx
const riDy = dy => dy >  VH * 0.5 ? dy - VH : dy < -VH * 0.5 ? dy + VH : dy
const GHOST_ZONE = 25  // px from edge at which ghost copies are drawn

// ── Device-pixel-ratio cap ──────────────────────────────────────────────────
// A canvas backing store is sized at devicePixelRatio, so fill cost scales with
// its SQUARE: a dpr-2 panel is 4x the pixels of dpr-1. Measured on the melt tab,
// dpr 1 -> 2 costs 2.2x per frame (52 -> 113 ms on a fast machine; 259 -> 612 ms
// at 4x CPU throttle). It is the single largest render lever in this project.
//
// devicePixelRatio ALSO tracks browser zoom, so a student at 125% zoom silently
// pays ~1.56x fill with no other change — a likely source of the machine-to-machine
// variance seen in field testing versus a dev machine at 100%.
//
// Everything that sizes a canvas or maps pointer coordinates MUST use effectiveDpr(),
// never window.devicePixelRatio directly, or the melt tab's click-to-inspect mapping
// desyncs from what was actually drawn.
let _maxDpr = 2
export const setMaxDpr   = v => { _maxDpr = Math.max(0.5, v) }
export const getMaxDpr   = () => _maxDpr
export const effectiveDpr = () => Math.min(window.devicePixelRatio || 1, _maxDpr)

let _visualScale = 3.3   // amplify lattice-atom displacement from x0; freed atoms unaffected
export const setVisualScale = v => { _visualScale = v }
// Only the first JIGGLE_PX of displacement from x0 is amplified — that's the thermal jiggle the
// scale exists to show. Real drift (dissolving grains) is drawn 1:1, otherwise an atom drifted
// 5px drew 16px away and its bonds to freed neighbours looked ~3× too long.
const JIGGLE_PX = 1.5
function visOffset(p, scale) {
  const dx = p.x - p.x0, dy = p.y - p.y0
  const d  = Math.hypot(dx, dy)
  if (d < 1e-9) return [0, 0]
  const k = (d + (scale - 1) * Math.min(d, JIGGLE_PX)) / d
  return [dx * k, dy * k]
}
export const getVisualScale = () => _visualScale

export const C = {
  Si:  '#d4a020',   // gold  — network former
  O:   '#cc3a3a',   // red
  Na:  '#4aaa60',   // green — network modifier
  Ca:  '#4a96be',   // blue  — modifier (NOT cement matrix as in concrete)
}

const CHARGE_POS = '62,127,214'   // blue halo  — Si, Ca
const CHARGE_NEG = '231,131,42'   // orange halo — O
const CHARGE_TYPES = { Si: CHARGE_POS, Ca: CHARGE_POS, Na: CHARGE_POS, O: CHARGE_NEG }


// Bond strain ramp: warm grey → violet → magenta → hot pink
const COLOR_STOPS = [
  [0.00, 200, 196, 188],
  [0.15, 195,  90, 255],
  [0.40, 240,  30, 225],
  [1.00, 255,  70, 185],
]
// Light mode composites the field with 'multiply', so colors must be dark to show on the
// off-white background — the dark warm-grey zero-strain end keeps low-energy bonds visible.
const COLOR_STOPS_LIGHT = [
  [0.00,  96,  92,  84],
  [0.15, 150,  50, 210],
  [0.40, 200,  20, 170],
  [1.00, 220,  40, 140],
]

function strainColorRGB(strain, breakStrain, darkMode = true) {
  const stops = darkMode ? COLOR_STOPS : COLOR_STOPS_LIGHT
  const t = Math.min(1, Math.abs(strain) / Math.max(breakStrain * 0.50, 0.001))
  for (let k = 0; k < stops.length - 1; k++) {
    const [t0, r0, g0, b0] = stops[k]
    const [t1, r1, g1, b1] = stops[k + 1]
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return [Math.round(r0+(r1-r0)*u), Math.round(g0+(g1-g0)*u), Math.round(b0+(b1-b0)*u)]
    }
  }
  return [0, 200, 255]
}

// Tapered lens shape centered on bond midpoint — always tapers to points at each atom
function fillLens(ctx, ax, ay, bx, by, bondRound) {
  const len = Math.hypot(bx - ax, by - ay)
  if (len < 0.5) return
  const ux = (bx - ax) / len, uy = (by - ay) / len
  const px = -uy, py = ux
  const mx = (ax + bx) / 2, my = (ay + by) / 2
  const halfL = len * 0.40
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
  const lo = 14   // fade starts just past max intact bond length (~12px Na-O)
  const hi = 25   // fully gone once atoms are clearly separated
  if (d <= lo) return 1
  if (d >= hi) return 0
  return 1 - (d - lo) / (hi - lo)
}

// Builds a rounded, inflated convex hull path.
// inflate: pixels to expand each vertex outward from centroid
// cornerR: pixel radius of rounded corners
function roundedHullPath(ctx, pts, inflate, cornerR) {
  if (pts.length < 2) return
  let cx = 0, cy = 0
  for (const [x, y] of pts) { cx += x; cy += y }
  cx /= pts.length; cy /= pts.length

  const ip = pts.map(([x, y]) => {
    const dx = x - cx, dy = y - cy
    const d = Math.hypot(dx, dy) || 1
    return [x + (dx / d) * inflate, y + (dy / d) * inflate]
  })

  const n = ip.length
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const a  = ip[(i - 1 + n) % n]
    const b  = ip[i]
    const c  = ip[(i + 1) % n]
    const dba = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1
    const dbc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1
    const r  = Math.min(cornerR, dba * 0.45, dbc * 0.45)
    const ux = (a[0] - b[0]) / dba, uy = (a[1] - b[1]) / dba
    const p1 = [b[0] + ux * r, b[1] + uy * r]
    if (i === 0) ctx.moveTo(p1[0], p1[1])
    else         ctx.lineTo(p1[0], p1[1])
    ctx.arcTo(b[0], b[1], c[0], c[1], r)
  }
  ctx.closePath()
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
// Light-mode grain outlines: saturated to match the atom colors (Si gold, Na green).
const CHUNK_BDR_LIGHT = { SiO2: '#c88a00', Na2O: '#2f9d4f', CaO: '#7f8a90' }
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
  ts              = 0,
  visualScale     = _visualScale,
  bondRound       = 4,
  showField       = true,
  fieldBlur       = true,   // false (Simple tier) draws the strain field crisp, skipping the costly blur
  showCharge      = false,
  chargeLite      = false,  // true (Simple tier) draws flat charge discs, skipping the per-atom gradient
  interp          = 1,      // <1 (Hi-Res tier) renders freed atoms interpolated between physics steps for smoothness
  darkMode        = true,
  bondNums        = false,
  atomColorMode   = 'normal',   // 'normal' | 'freed' | 'coordination' | 'attract'
  showBrokenBonds = false,
  showLiveStats   = false,
  targetTempC     = null,
  hoverIdx        = null,
  selectedIdx     = -1,
} = {}) {
  if (!canvas || !phys) return

  const dpr = effectiveDpr()
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

  // Visual position: lattice atoms are amplified from x0/y0; freed atoms show at real position.
  // Hi-Res tier (interp < 1): freed atoms are drawn interpolated between the last two physics
  // steps (px → x by `interp`), so motion stays smooth even when the sim steps fewer times than
  // the display refreshes. riDx/riDy keep the interpolation on the short (min-image) path so an
  // atom wrapping across the toroidal edge doesn't streak. Lattice atoms barely move per step,
  // so they keep the plain visOffset path (and hit-testing stays on true positions).
  const vx = (p, i) => latticeFreed?.[i]
    ? (interp >= 1 ? p.x : p.px + riDx(p.x - p.px) * interp)
    : p.x0 + visOffset(p, visualScale)[0]
  const vy = (p, i) => latticeFreed?.[i]
    ? (interp >= 1 ? p.y : p.py + riDy(p.y - p.py) * interp)
    : p.y0 + visOffset(p, visualScale)[1]

  // Overlay bond count — mirrors attract loop exactly: count ALL phys.bonds (including broken)
  let overlayBondCount = null
  if (atomColorMode === 'attract' && bonds?.length) {
    overlayBondCount = new Int32Array(particles.length)
    for (const { i, j } of bonds) { overlayBondCount[i]++; overlayBondCount[j]++ }
  }

  // ── Chunk outlines (grain group silhouettes) ──
  // Hull drawn from rest positions (x0/y0) so thermal jitter never wobbles the shape.
  // Hides when _chunkBondFrac of internal bonds have broken (tune: window._chunkBondFrac).
  if (chunks?.length) {
    const BOND_FRAC = window._chunkBondFrac ?? 0.40

    const particleChunkIdx = new Map()
    chunks.forEach((chunk, ci) => { for (const idx of chunk.pIdxs) particleChunkIdx.set(idx, ci) })
    const chunkBondTotal  = new Int32Array(chunks.length)
    const chunkBondBroken = new Int32Array(chunks.length)
    const rigidBonds = phys.rigidBonds
    if (rigidBonds?.length) {
      for (const rb of rigidBonds) {
        const ci = particleChunkIdx.get(rb.i)
        const cj = particleChunkIdx.get(rb.j)
        if (ci !== undefined && ci === cj) {
          chunkBondTotal[ci]++
          if (rb.broken) chunkBondBroken[ci]++
        }
      }
    }

    const cl   = getLayer(chunkLayerCache, canvas)
    const cctx = cl.getContext('2d')
    cctx.clearRect(0, 0, cl.width, cl.height)
    const tr = ctx.getTransform()
    cctx.setTransform(tr.a, tr.b, tr.c, tr.d, tr.e, tr.f)

    // Dissolving is permanent: once a grain melts, its border never returns — otherwise
    // re-integration during cooling (which clears freed flags and reforms bonds) would make
    // grain borders reappear in the cooled solid.
    if (!phys.chunkDissolved) phys.chunkDissolved = new Uint8Array(chunks.length)
    const dissolved = phys.chunkDissolved
    chunks.forEach((chunk, ci) => {
      if (!chunk.pIdxs.length) return
      if (dissolved[ci]) return
      const freedCount = chunk.pIdxs.reduce((s, i) => s + (latticeFreed?.[i] ? 1 : 0), 0)
      if ((chunkBondTotal[ci] > 0 && chunkBondBroken[ci] / chunkBondTotal[ci] >= BOND_FRAC) ||
          (chunk.pIdxs.length > 0 && freedCount / chunk.pIdxs.length >= 0.25)) { dissolved[ci] = 1; return }
      // Freeze the outline shape on first draw: once captured it never changes, so atom
      // rearrangement / x0 rebasing can't reshape the grain border. A dissolved grain is gone
      // forever (above); a surviving one keeps its original outline exactly.
      if (!chunk._hull) chunk._hull = convexHull(chunk.pIdxs.map(i => [particles[i].x0, particles[i].y0]))
      const hull = chunk._hull
      if (hull.length < 2) return
      roundedHullPath(cctx, hull, 7, 6)
      cctx.globalAlpha = 0.85
      cctx.strokeStyle = darkMode ? chunk.bdr : CHUNK_BDR_LIGHT[chunk.type] ?? chunk.bdr
      cctx.lineWidth = 2.5; cctx.stroke()
    })
    cctx.globalAlpha = 1

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.filter = 'blur(2px)'
    ctx.drawImage(cl, 0, 0)
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── Bond strain field (blurred lens shapes, drawn under atoms) ──
  if (showField && bonds?.length) {
    const fl   = getLayer(fieldLayerCache, canvas)
    const fctx = fl.getContext('2d')
    fctx.clearRect(0, 0, fl.width, fl.height)
    const tr = ctx.getTransform()
    fctx.setTransform(tr.a, tr.b, tr.c, tr.d, tr.e, tr.f)

    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      // Broken bonds are never drawn as bonds — they'd show as long pink streaks while the
      // atoms drift apart. The showBrokenBonds overlay (below) draws them when requested.
      if (bond.broken) continue
      const pi = particles[bond.i], pj = particles[bond.j]
      // Use minimum image for all distance/direction calculations (toroidal wrap)
      const rawDx = pj.x - pi.x, rawDy = pj.y - pi.y
      const da = bondCurDistAlpha(riDx(rawDx), riDy(rawDy))
      if (da <= 0) continue
      fctx.globalAlpha = da
      const iFreed = latticeFreed?.[bond.i], jFreed = latticeFreed?.[bond.j]
      const pix = iFreed ? pi.x : (pi.x + pi.x0) * 0.5
      const piy = iFreed ? pi.y : (pi.y + pi.y0) * 0.5
      const pjx_raw = jFreed ? pj.x : (pj.x + pj.x0) * 0.5
      const pjy_raw = jFreed ? pj.y : (pj.y + pj.y0) * 0.5
      const sdx = riDx(pjx_raw - pix), sdy = riDy(pjy_raw - piy)
      // r0s path: midpoint-averaged distance vs. original lattice separation.
      // Correct for lattice-lattice pairs and mixed (one freed) rigid bonds — r0s ≈ spec.r0
      // for original neighbors and the midpoint averaging suppresses thermal jitter.
      // Wrong for both-freed dynamic bonds formed in the melt: those atoms were never
      // original neighbors so r0s can be 50-500 px, giving deeply negative strain → pink.
      // Guard: only bypass r0s when BOTH atoms are freed (the only case where r0s is meaningless).
      const smoothStrain = (iFreed && jFreed)
        ? (bond.strain ?? 0)
        : (() => { const r0s = Math.hypot(pj.x0 - pi.x0, pj.y0 - pi.y0); return r0s > 0.5 ? (Math.hypot(sdx, sdy) - r0s) / r0s : (bond.strain ?? 0) })()
      // Thermal fade: the pink shows bond energy, which falls with temperature. Fade to grey
      // across 750→500°C (gray below 500), independent of strain, so a cooled solid is grey.
      // Bonds fade from pink (energetic) to grey across 650→500°C — the window where the
      // slow-cool structure is already built and just settles into the cold solid.
      const thermPink = Math.max(0, Math.min(1, ((targetTempC ?? 999) - 500) / 150))
      const [cr, cg, cb] = strainColorRGB(smoothStrain * thermPink, bond.currentBreakStrain ?? 0.25, darkMode)
      fctx.fillStyle = `rgb(${cr},${cg},${cb})`
      // Adjust pj to the minimum-image position relative to pi for lens drawing
      const pix_v = vx(pi, bond.i), piy_v = vy(pi, bond.i)
      const pjx_v = pix_v + riDx(vx(pj, bond.j) - pix_v)
      const pjy_v = piy_v + riDy(vy(pj, bond.j) - piy_v)
      fillLens(fctx, pix_v, piy_v, pjx_v, pjy_v, bondRound)
      fctx.fill()
    }

    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // The blur is the one expensive part (~7 ms/frame, full-canvas). On Simple we skip it and
    // composite the crisp lens shapes — still reads as "strained bond → pink", just not fuzzy.
    if (fieldBlur) ctx.filter = 'blur(2px)'
    ctx.globalCompositeOperation = darkMode ? 'screen' : 'multiply'
    ctx.drawImage(fl, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.restore()
  }

  // ── Broken bond overlay (dashed lines, drawn in physics coords) ──
  if (showBrokenBonds && bonds?.length) {
    ctx.save()
    ctx.lineWidth = 0.8
    ctx.setLineDash([2, 3])
    for (const bond of bonds) {
      if (!bond.broken) continue
      const pi = particles[bond.i], pj = particles[bond.j]
      const da = bondCurDistAlpha(riDx(pj.x - pi.x), riDy(pj.y - pi.y))
      if (da <= 0) continue
      const pix_v = vx(pi, bond.i), piy_v = vy(pi, bond.i)
      const pjx_v = pix_v + riDx(vx(pj, bond.j) - pix_v)
      const pjy_v = piy_v + riDy(vy(pj, bond.j) - piy_v)
      ctx.globalAlpha = da * 0.45
      ctx.strokeStyle = '#88aaee'
      ctx.beginPath()
      ctx.moveTo(pix_v, piy_v)
      ctx.lineTo(pjx_v, pjy_v)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.restore()
  }

  // ── Atoms ──
  // Draw at visual position + per-particle Lissajous jitter.
  // Ghost copies near edges create the toroidal (asteroids) wrap effect.
  ctx.lineWidth = 0.5
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    const { jx, jy } = canvasJitter(i, t)
    const px = vx(p, i) + jx
    const py = vy(p, i) + jy
    const gx = px < GHOST_ZONE ? VW : px > VW - GHOST_ZONE ? -VW : 0
    const gy = py < GHOST_ZONE ? VH : py > VH - GHOST_ZONE ? -VH : 0

    ctx.fillStyle   = overlayAtomColor(p, i, atomColorMode, latticeFreed, phys.intactCount, overlayBondCount)
    ctx.strokeStyle = darkMode ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.25)'
    ctx.globalAlpha = 0.88
    const drawAtom = (ax, ay) => {
      ctx.beginPath(); ctx.arc(ax, ay, p.r, 0, Math.PI * 2)
      ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); ctx.globalAlpha = 0.88
    }
    drawAtom(px, py)
    if (gx) drawAtom(px + gx, py)
    if (gy) drawAtom(px, py + gy)
    if (gx && gy) drawAtom(px + gx, py + gy)
    ctx.globalAlpha = 1
  }

  // ── Selected atom highlight (gold ring) ──
  if (selectedIdx >= 0 && selectedIdx < particles.length) {
    const p  = particles[selectedIdx]
    const px = vx(p, selectedIdx), py = vy(p, selectedIdx)
    ctx.save()
    ctx.strokeStyle = '#ffd700'
    ctx.lineWidth   = 2
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(px, py, p.r + 4, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ── Hover highlight (white ring) ──
  if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < particles.length) {
    const p  = particles[hoverIdx]
    const px = vx(p, hoverIdx), py = vy(p, hoverIdx)
    ctx.save()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 1.5
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    ctx.arc(px, py, p.r + 3, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ── Charge halos — drawn over atoms; fixed 8px radius, solid at center ──
  if (showCharge && particles?.length) {
    for (let i = 0; i < particles.length; i++) {
      const p   = particles[i]
      const px  = vx(p, i)
      const py  = vy(p, i)
      const rgb = CHARGE_TYPES[p.type]
      if (!rgb) continue
      const cr  = 8
      ctx.globalAlpha = 1
      let rad = cr
      if (chargeLite) {
        // Simple tier: one flat translucent disc — no per-atom gradient allocation.
        // Still reads as a colored charge halo, just without the soft radial fade.
        // 1px smaller and a touch more opaque than the gradient's core, so the flat
        // disc reads as a tighter, slightly stronger halo.
        rad = cr - 1
        ctx.fillStyle = `rgba(${rgb},0.4)`
      } else {
        const g = ctx.createRadialGradient(px, py, 0, px, py, cr)
        g.addColorStop(0,     `rgba(${rgb},0.6)`)
        g.addColorStop(1/cr,  `rgba(${rgb},0.6)`)
        g.addColorStop(1,     `rgba(${rgb},0)`)
        ctx.fillStyle = g
      }
      ctx.beginPath()
      ctx.arc(px, py, rad, 0, Math.PI * 2)
      ctx.fill()
    }
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
  if (showLiveStats) drawLiveStats(ctx, phys, targetTempC, selectedIdx)
}

// ── Atom color modes ──────────────────────────────────────────────────────────
function overlayAtomColor(p, i, mode, lf, intactCount, overlayBondCount) {
  if (mode === 'freed') {
    return lf?.[i] ? '#00ffcc' : '#667788'
  }
  if (mode === 'coordination') {
    const ic  = intactCount?.[i] ?? 0
    const tgt = COORD_TARGET[p.typeId] ?? 2
    if (ic === 0)    return '#ff4444'   // no intact bonds
    if (ic > tgt)    return '#ff8800'   // over-coordinated
    if (ic >= tgt)   return '#44ff66'   // satisfied
    return '#ffcc00'                    // under-coordinated
  }
  if (mode === 'attract') {
    const bc  = overlayBondCount?.[i] ?? 0
    const tgt = COORD_TARGET[p.typeId] ?? 2
    return bc < tgt ? '#ff44ff' : '#555555'
  }
  return C[p.type] ?? '#ffffff'
}

// ── Live stats HUD ────────────────────────────────────────────────────────────
let _lastHudLines = []
export const getLastHudLines = () => _lastHudLines

function drawLiveStats(ctx, phys, targetTempC, selectedIdx = -1) {
  if (!phys?.particles) return
  const ps = phys.particles
  const n  = phys.n ?? ps.length

  let keSum = 0, speedSum = 0
  for (let i = 0; i < n; i++) {
    const p = ps[i]
    keSum    += (p.vx * p.vx + p.vy * p.vy) * 0.5
    speedSum += Math.hypot(p.vx, p.vy)
  }
  const measuredTempC = Math.round(keSum / n / ENERGY_UNIT - 273)
  const meanSpeed     = (speedSum / n).toExponential(2)

  let liveSiO = 0, liveNaO = 0, liveCaO = 0, brokenRigid = 0
  for (const rb of (phys.rigidBonds ?? [])) {
    if (rb.broken) { brokenRigid++; continue }
    const ti = ps[rb.i].typeId, tj = ps[rb.j].typeId
    if      ((ti === 0) !== (tj === 0) && (ti <= 1) && (tj <= 1)) liveSiO++
    else if ((ti === 2 && tj === 1) || (ti === 1 && tj === 2))    liveNaO++
    else if ((ti === 3 && tj === 1) || (ti === 1 && tj === 3))    liveCaO++
  }

  const lf = phys.latticeFreed
  const ic = phys.intactCount
  let sio2T = 0, sio2F = 0, na2oT = 0, na2oF = 0
  let siSum = 0, siN = 0
  for (let i = 0; i < n; i++) {
    const p = ps[i]
    if (p.cellType === 'SiO2') { sio2T++; if (lf?.[i]) sio2F++ }
    else if (p.cellType === 'Na2O') { na2oT++; if (lf?.[i]) na2oF++ }
    if (p.typeId === 0) { siSum += (ic?.[i] ?? 0); siN++ }
  }
  const meanSiCoord = siN ? (siSum / siN).toFixed(1) : '—'

  const bondStr = [`Si-O ${liveSiO}`, liveNaO && `Na-O ${liveNaO}`, liveCaO && `Ca-O ${liveCaO}`]
    .filter(Boolean).join(' / ')

  // Per-bond live readout for selected atom
  const selBondLines = []
  if (selectedIdx >= 0 && selectedIdx < n) {
    const sp = ps[selectedIdx]
    selBondLines.push(`  ► #${selectedIdx} ${sp.type} (${phys.latticeFreed?.[selectedIdx] ? 'freed' : 'lattice'})`)
    const myBonds = (phys.bonds ?? []).filter(b => b.i === selectedIdx || b.j === selectedIdx)
    for (const b of myBonds) {
      const oi    = b.i === selectedIdx ? b.j : b.i
      const po    = ps[oi]
      const d     = Math.hypot(sp.x - po.x, sp.y - po.y).toFixed(1)
      const rigid = b.currentBreakStrain !== undefined
      const state = !rigid ? 'soft' : b.broken ? 'BRK ' : 'ok  '
      const avgs  = rigid && b.avgStrain    != null ? (b.avgStrain    * 1000).toFixed(1) : '—'
      const thr   = rigid && b.effThreshold != null ? (b.effThreshold * 1000).toFixed(1) : '—'
      selBondLines.push(`    ${po.type}#${oi} ${d.padStart(5)}px ${state} avgs=${avgs} thr=${thr}`)
    }
    if (myBonds.length === 0) selBondLines.push('    (no bonds)')
  }

  const lines = [
    targetTempC !== null ? `T tgt  ${targetTempC}°C`      : null,
    `T meas ${measuredTempC}°C`,
    `bonds  ${bondStr}`,
    ...selBondLines,
    `broken ${brokenRigid} rigid  (${(((phys.fBroken ?? 0) * 100)).toFixed(1)}%)`,
    `coord  Si ${meanSiCoord}/3`,
    sio2T ? `freed  SiO₂ ${Math.round(sio2F / sio2T * 100)}%` : null,
    na2oT ? `freed  Na₂O ${Math.round(na2oF / na2oT * 100)}%` : null,
    `spd    ${meanSpeed} px/step`,
  ].filter(Boolean)

  _lastHudLines = lines

  ctx.save()
  const pad = 6, lineH = 14
  const boxW = 196, boxH = lines.length * lineH + pad * 2
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(4, 4, boxW, boxH)
  ctx.fillStyle = '#cccccc'
  ctx.font = '10.5px monospace'
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'top'
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 4 + pad, 4 + pad + i * lineH)
  }
  ctx.restore()
}

// ── Hover: find nearest atom in visual coordinates ────────────────────────────
// physX/physY are in the same coordinate space as vx()/vy() (visual physics coords).
// Returns atom index, or -1 if none within threshold.
export function findAtomNear(phys, physX, physY, vs) {
  if (!phys?.particles) return -1
  const { particles } = phys
  const lf = phys.latticeFreed
  const vxf = (p, i) => lf?.[i] ? p.x : p.x0 + visOffset(p, vs)[0]
  const vyf = (p, i) => lf?.[i] ? p.y : p.y0 + visOffset(p, vs)[1]
  let best = -1, bestD2 = Infinity
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]
    const dx = physX - vxf(p, i), dy = physY - vyf(p, i)
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = i }
  }
  return bestD2 < 400 ? best : -1   // threshold: 20px in visual coords
}
