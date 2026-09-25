// sandPhysics.js — granular sand physics for the glass box (state 1)
// Uses Position-Based Dynamics (PBD): velocity is derived from actual displacement
// after constraint solving, so settled grains naturally get zero velocity.

export const GRAIN_R     = 2.25   // average; used for packing layout
export const GRAIN_R_MIN = 1.6
export const GRAIN_R_MAX = 3.2
export const N_GRAINS    = 2250  // max / mixture count; pure sand uses 1800

const GRAVITY          = 900
const DAMPING_SLOW     = 0.80    // extra damping for near-stationary grains
const DAMPING_FAST     = 0.97    // light damping for fast-moving grains
const SPEED_SQ_MAX     = 10 * 10 // speed² above which DAMPING_FAST fully applies
const WALL_RESTITUTION = 0.18
const RESOLVE_PASSES   = 20

export const SAND_COLORS = [
  '#c8a84c', '#b89840', '#c4a050', '#a88838',
  '#d0b060', '#b49045', '#c09848', '#aa8c3c',
  '#c2a042', '#bc9c44', '#caa44e', '#b29040',
]

// ── Spatial grid (typed arrays, rebuilt each pass, no GC) ─────────────────
const CELL = GRAIN_R_MAX * 2   // fine grid; loop uses ±4 to cover large silicate grains

let _gridW   = 0
let _gridH   = null
let _nodeG   = null
let _nodeNxt = null

function allocGrid(HS) {
  _gridW   = Math.ceil(2 * HS / CELL) + 2
  _gridH   = new Int32Array(_gridW * _gridW).fill(-1)
  _nodeG   = new Int32Array(N_GRAINS)
  _nodeNxt = new Int32Array(N_GRAINS)
}

function rebuildGrid(grains, HS) {
  _gridH.fill(-1)
  for (let i = 0; i < grains.length; i++) {
    const g  = grains[i]
    const cx = Math.min(_gridW - 1, Math.max(0, (g.x + HS) / CELL | 0))
    const cy = Math.min(_gridW - 1, Math.max(0, (g.y + HS) / CELL | 0))
    const k  = cy * _gridW + cx
    _nodeNxt[i] = _gridH[k]
    _nodeG[i]   = i
    _gridH[k]   = i
  }
}

const NA_R = 1.5

// ── Init ──────────────────────────────────────────────────────────────────
// na2oPct: 0–100, drives count of Na micro-grains (circles) mixed into sand.
// At na2o=30 → ~36% count = ~20% volume (r_na=1.5, r_sand_avg=2.25).
export function initSandParticles(HS, multiRadius = true, na2oPct = 0, nGrains = 1800) {
  allocGrid(HS)

  const naCountFrac = na2oPct > 0 ? Math.min(0.70, (na2oPct / 30) * 0.36) : 0
  const nNa         = Math.round(naCountFrac * nGrains)

  const r      = GRAIN_R
  // Spread grains to fill ~90% of box height with gaps, staying within walls.
  // Formula derived by solving: (rows-1)*stepY ≈ 0.9*(2*HS-2r)
  const boxInner = 2 * HS - r * 2
  const spread   = Math.max(1.0, Math.sqrt(0.90 * boxInner * boxInner / (nGrains * 2 * r * r * Math.sqrt(3))) * 0.70)
  const stepX  = r * 2 * spread
  const stepY  = r * Math.sqrt(3) * spread
  const cols   = Math.floor((2 * HS - r * 2) / stepX)
  const startX = -(cols - 1) * stepX / 2

  const grains = []
  let row = 0
  while (grains.length < nGrains) {
    const oddRow  = row % 2
    const rowCols = oddRow ? cols - 1 : cols
    const rowX0   = startX + oddRow * stepX * 0.5
    for (let c = 0; c < rowCols && grains.length < nGrains; c++) {
      const hex = SAND_COLORS[grains.length % SAND_COLORS.length]
      grains.push({
        x: rowX0 + c * stepX, y: HS - r - row * stepY,
        vx: 0, vy: 0,
        _px: 0, _py: 0,
        r:     multiRadius ? GRAIN_R_MIN + Math.random() * (GRAIN_R_MAX - GRAIN_R_MIN) : GRAIN_R,
        angle: Math.random() * Math.PI,
        color: hex,
        _cr: parseInt(hex.slice(1,3), 16),
        _cg: parseInt(hex.slice(3,5), 16),
        _cb: parseInt(hex.slice(5,7), 16),
        type:  'sand',
      })
    }
    row++
  }

  // Randomly scatter Na grains throughout the full pile so they start mixed
  if (nNa > 0) {
    const idx = Array.from({ length: nGrains }, (_, i) => i)
    for (let i = 0; i < nNa; i++) {
      const j = i + Math.floor(Math.random() * (nGrains - i))
      ;[idx[i], idx[j]] = [idx[j], idx[i]]
      const g = grains[idx[i]]
      g.type  = 'na'
      g.r     = NA_R
      g.color = '#dceef8'
      g._cr   = 220; g._cg = 238; g._cb = 248
      g.angle = 0
    }
  }

  // Sync _px/_py to initial positions
  for (const g of grains) { g._px = g.x; g._py = g.y }
  return grains
}

// ── Na₂O and silicate grain merging ─────────────────────────────────────
const SILICATE_MAX_R = 20

const _toAbsorb = new Uint8Array(N_GRAINS)

// Call once per visual frame (not per physics tick).
// Returns count of merges performed.
export function mergeSodaGrains(grains, meldProb) {
  if (meldProb <= 0) return 0
  const MAX_R = NA_R * 10
  const n = grains.length
  _toAbsorb.fill(0, 0, n)
  let merged = 0

  for (let ai = 0; ai < n; ai++) {
    if (_toAbsorb[ai]) continue
    const a = grains[ai]
    if (a.type !== 'na') continue
    for (let bi = ai + 1; bi < n; bi++) {
      if (_toAbsorb[bi]) continue
      const b = grains[bi]
      if (b.type !== 'na') continue
      const dx = b.x - a.x, dy = b.y - a.y
      if (dx * dx + dy * dy >= (a.r + b.r) ** 2) continue  // not touching
      if (Math.random() >= meldProb) continue
      const r_new = Math.sqrt(a.r ** 2 + b.r ** 2)
      if (r_new > MAX_R) continue
      // Merge b into a — area-weighted position/velocity (2D mass ∝ r²)
      const va = a.r ** 2, vb = b.r ** 2, vt = va + vb
      a.x  = (a.x  * va + b.x  * vb) / vt
      a.y  = (a.y  * va + b.y  * vb) / vt
      a.vx = (a.vx * va + b.vx * vb) / vt
      a.vy = (a.vy * va + b.vy * vb) / vt
      a._px = a.x; a._py = a.y
      a.r = r_new
      _toAbsorb[bi] = 1
      merged++
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    if (_toAbsorb[i]) grains.splice(i, 1)
  }
  return merged
}

// Na + Sand → silicate, and silicate + silicate → silicate.
// Called once per visual frame. Returns merge count.
export function mergeSilicateGrains(grains, naSandProb, silSilProb, maxMerges = 5) {
  if (naSandProb <= 0 && silSilProb <= 0) return 0
  const n = grains.length
  _toAbsorb.fill(0, 0, n)
  let merged = 0

  for (let ai = 0; ai < n; ai++) {
    if (merged >= maxMerges) break
    if (_toAbsorb[ai]) continue
    const a = grains[ai]
    const isNa  = a.type === 'na'
    const isSi  = a.type === 'sand'
    const isSil = a.type === 'silicate'
    if (!isNa && !isSi && !isSil) continue

    for (let bi = ai + 1; bi < n; bi++) {
      if (_toAbsorb[bi]) continue
      const b = grains[bi]

      let prob = 0
      if (naSandProb > 0 && ((isNa && b.type === 'sand') || (isSi && b.type === 'na') || (isSil && b.type === 'sand'))) {
        prob = naSandProb
      } else if (silSilProb > 0 && isSil && b.type === 'silicate') {
        prob = silSilProb
      } else continue

      const dx = b.x - a.x, dy = b.y - a.y
      if (dx * dx + dy * dy >= (a.r + b.r) ** 2) continue
      if (Math.random() >= prob) continue
      const r_new = Math.sqrt(a.r ** 2 + b.r ** 2)
      if (r_new > SILICATE_MAX_R) continue

      const va = a.r ** 2, vb = b.r ** 2, vt = va + vb
      a.x  = (a.x  * va + b.x  * vb) / vt
      a.y  = (a.y  * va + b.y  * vb) / vt
      a.vx = (a.vx * va + b.vx * vb) / vt
      a.vy = (a.vy * va + b.vy * vb) / vt
      a._px = a.x; a._py = a.y
      a.r = r_new
      a.type = 'silicate'
      _toAbsorb[bi] = 1
      merged++
      break
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    if (_toAbsorb[i]) grains.splice(i, 1)
  }
  return merged
}

// ── Step ─────────────────────────────────────────────────────────────────
const LARGE_R = GRAIN_R_MAX * 1.5  // grains above this use linear-scan collision

export function stepSandPhysics(grains, dt, HS, boxAngle) {
  const gx = GRAVITY * Math.sin(boxAngle)
  const gy = GRAVITY * Math.cos(boxAngle)
  const n  = grains.length

  // 1. Store pre-step positions for velocity derivation
  for (let i = 0; i < n; i++) {
    const g = grains[i]; g._px = g.x; g._py = g.y
  }

  // 2. Predict: integrate gravity onto velocity, then position
  for (let i = 0; i < n; i++) {
    const g = grains[i]
    g.vx += gx * dt
    g.vy += gy * dt
    g.x  += g.vx * dt
    g.y  += g.vy * dt
  }

  // 3. Position-only constraint solve (no velocity changes here)
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    rebuildGrid(grains, HS)

    for (let ai = 0; ai < n; ai++) {
      const a   = grains[ai]
      const acx = Math.min(_gridW - 1, Math.max(0, (a.x + HS) / CELL | 0))
      const acy = Math.min(_gridW - 1, Math.max(0, (a.y + HS) / CELL | 0))
      for (let dcy = -1; dcy <= 1; dcy++) {
        const cy = acy + dcy
        if (cy < 0 || cy >= _gridW) continue
        for (let dcx = -1; dcx <= 1; dcx++) {
          const cx = acx + dcx
          if (cx < 0 || cx >= _gridW) continue
          let ni = _gridH[cy * _gridW + cx]
          while (ni !== -1) {
            const bi = _nodeG[ni]; ni = _nodeNxt[ni]
            if (bi <= ai) continue
            const b    = grains[bi]
            const dx   = b.x - a.x, dy = b.y - a.y
            const d2   = dx * dx + dy * dy
            const minD = a.r + b.r
            if (d2 >= minD * minD || d2 < 1e-6) continue
            if (a.type === 'na-ctr' || b.type === 'na-ctr') continue
            const d    = Math.sqrt(d2)
            const nx   = dx / d, ny = dy / d
            const push = (minD - d) * 0.5
            a.x -= nx * push; a.y -= ny * push
            b.x += nx * push; b.y += ny * push
          }
        }
      }
    }

    // Large-grain linear scan: grid ±1 misses collisions when r > CELL/2.
    // Only runs for merged grains; pure sand never triggers it.
    for (let ai = 0; ai < n; ai++) {
      const a = grains[ai]
      if (a.r <= LARGE_R) continue
      for (let bi = ai + 1; bi < n; bi++) {
        const b = grains[bi]
        const dx = b.x - a.x, dy = b.y - a.y
        const d2 = dx * dx + dy * dy
        const minD = a.r + b.r
        if (d2 >= minD * minD || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        const nx = dx / d, ny = dy / d
        const push = (minD - d) * 0.5
        a.x -= nx * push; a.y -= ny * push
        b.x += nx * push; b.y += ny * push
      }
    }

    for (let i = 0; i < n; i++) {
      const g = grains[i], hi = HS - g.r
      if (g.x < -hi) g.x = -hi
      if (g.x >  hi) g.x =  hi
      if (g.y < -hi) g.y = -hi
      if (g.y >  hi)  g.y =  hi
    }
  }

  // 4. Derive velocity from total displacement; apply wall restitution + damping.
  //    A settled grain barely moves → derived velocity ≈ 0, no damping needed.
  for (let i = 0; i < n; i++) {
    const g = grains[i]
    g.vx = (g.x - g._px) / dt
    g.vy = (g.y - g._py) / dt
    // Wall restitution on grains that came to rest at a wall
    const hi = HS - g.r
    if (g.x <= -hi + 0.05 && g.vx < 0) g.vx *= -WALL_RESTITUTION
    if (g.x >=  hi - 0.05 && g.vx > 0) g.vx *= -WALL_RESTITUTION
    if (g.y <= -hi + 0.05 && g.vy < 0) g.vy *= -WALL_RESTITUTION
    if (g.y >=  hi - 0.05 && g.vy > 0) g.vy *= -WALL_RESTITUTION
    // Velocity-dependent damping (carry-over to next step)
    const t = Math.min(1, (g.vx * g.vx + g.vy * g.vy) / SPEED_SQ_MAX)
    const d = DAMPING_SLOW + (DAMPING_FAST - DAMPING_SLOW) * t
    g.vx *= d
    g.vy *= d
  }
}

// ── Na₂O blob system ──────────────────────────────────────────────────────
// When enough Na grains merge they exceed NA_BLOB_CONVERT_R, at which point
// we replace the single merged circle with a hex-packed soft body.

export const NA_BLOB_R_CTR     = 1.0   // phantom center — never collides
export const NA_BLOB_CONVERT_R = 5.0   // Na grain radius that triggers conversion
const NA_BLOB_K_RAD  = 200
const NA_BLOB_K_NBR  = 100
const NA_BLOB_PITCH  = NA_R * 2 + 0.4  // hex grid spacing for sub-circles

let _blobId = 0

function hexPackBlob(blobR) {
  const r       = NA_R
  const spacing = NA_BLOB_PITCH
  const rowH    = spacing * Math.sqrt(3) * 0.5
  const innerR  = blobR - r
  if (innerR <= 0) return [[0, 0]]
  const rows = Math.ceil(innerR / rowH)
  const cols = Math.ceil(innerR / spacing)
  const out  = []
  for (let row = -rows; row <= rows; row++) {
    const y    = row * rowH
    const xOff = Math.abs(row) % 2 === 1 ? spacing * 0.5 : 0
    for (let col = -cols; col <= cols; col++) {
      const x = col * spacing + xOff
      if (x * x + y * y <= innerR * innerR) out.push([x, y])
    }
  }
  return out
}

export function makeNaBlob(cx, cy, vx, vy, blobR) {
  const id  = _blobId++
  const ctr = {
    x: cx, y: cy, vx, vy, _px: cx, _py: cy,
    r: NA_BLOB_R_CTR, type: 'na-ctr', blobId: id,
    angle: 0, color: '#fff', _cr: 255, _cg: 255, _cb: 255,
  }
  const orbs = hexPackBlob(blobR).map(([ox, oy]) => ({
    x: cx + ox, y: cy + oy, vx, vy, _px: cx + ox, _py: cy + oy,
    r: NA_R, type: 'na-sub', blobId: id,
    angle: 0, color: '#fff', _cr: 255, _cg: 255, _cb: 255,
  }))
  const particles = [ctr, ...orbs]

  const springs = []
  for (let k = 1; k < particles.length; k++) {
    const p = particles[k]
    const dx = p.x - cx, dy = p.y - cy
    springs.push({ a: ctr, b: particles[k], rest: Math.sqrt(dx * dx + dy * dy) || 0.001, k: NA_BLOB_K_RAD })
  }
  const thresh2 = (NA_BLOB_PITCH * 1.5) ** 2
  for (let i = 1; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[j].x - particles[i].x, dy = particles[j].y - particles[i].y
      const d2 = dx * dx + dy * dy
      if (d2 < thresh2) springs.push({ a: particles[i], b: particles[j], rest: Math.sqrt(d2), k: NA_BLOB_K_NBR })
    }
  }

  return { id, blobR, particles, springs }
}

export function stepNaBlobSprings(naBlobs, dt, boxAngle = 0) {
  const gx = Math.sin(boxAngle)
  const gy = Math.cos(boxAngle)

  for (const blob of naBlobs) {
    for (const s of blob.springs) {
      const a = s.a, b = s.b
      const dx = b.x - a.x, dy = b.y - a.y
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f  = s.k * (d - s.rest)
      const fx = f * dx / d, fy = f * dy / d
      a.vx += fx * dt; a.vy += fy * dt
      b.vx -= fx * dt; b.vy -= fy * dt
    }

    const orbs = blob.particles.filter(p => p.type === 'na-sub')
    if (orbs.length < 3) continue
    let avgSpd = 0
    for (const p of orbs) avgSpd += Math.hypot(p.vx, p.vy)
    avgSpd /= orbs.length
    const settleFactor = Math.max(0, 1 - avgSpd / 1.5)
    if (settleFactor <= 0) continue

    const ctr = blob.particles[0]
    for (const p of orbs) {
      const dx = p.x - ctr.x, dy = p.y - ctr.y
      const gravComp = dx * gx + dy * gy
      if (gravComp >= 0) continue
      const flatK = 0.8 * settleFactor
      p.vx -= flatK * gravComp * gx * dt
      p.vy -= flatK * gravComp * gy * dt
    }
  }
}

// Convert at most one eligible silicate grain per call to avoid batch-conversion
// of many grains in a single frame, which causes a jarring visual volume jump.
export function convertLargeNaGrains(grains, naBlobs) {
  for (let i = grains.length - 1; i >= 0; i--) {
    const g = grains[i]
    if (g.type !== 'silicate' || g.r < NA_BLOB_CONVERT_R) continue
    grains.splice(i, 1)
    const blob = makeNaBlob(g.x, g.y, g.vx, g.vy, g.r)
    for (const p of blob.particles) grains.push(p)
    naBlobs.push(blob)
    return  // one per frame — spread the conversion over multiple frames
  }
}

// ── Na blob merging (same logic as v5 checkAndDoMerges) ───────────────────

function mergeNaBlobs(b1, b2, grains) {
  // Remove both old phantom centers from the grains array
  for (const blob of [b1, b2]) {
    const ctr = blob.particles.find(p => p.type === 'na-ctr')
    if (ctr) { const idx = grains.indexOf(ctr); if (idx !== -1) grains.splice(idx, 1) }
  }

  const allOrbs = [
    ...b1.particles.filter(p => p.type === 'na-sub'),
    ...b2.particles.filter(p => p.type === 'na-sub'),
  ]
  let cx = 0, cy = 0, avgVx = 0, avgVy = 0
  for (const p of allOrbs) { cx += p.x; cy += p.y; avgVx += p.vx; avgVy += p.vy }
  cx /= allOrbs.length; cy /= allOrbs.length; avgVx /= allOrbs.length; avgVy /= allOrbs.length

  const newCtr = {
    x: cx, y: cy, vx: avgVx, vy: avgVy, _px: cx, _py: cy,
    r: NA_BLOB_R_CTR, type: 'na-ctr', blobId: _blobId,
    angle: 0, color: '#fff', _cr: 255, _cg: 255, _cb: 255,
  }
  grains.push(newCtr)
  for (const p of allOrbs) p.blobId = _blobId

  return {
    id: _blobId++,
    blobR: Math.sqrt(b1.blobR ** 2 + b2.blobR ** 2),
    particles: [newCtr, ...allOrbs],
    springs: [],
    merged: true,
  }
}

// Call once per physics tick (inside the accumulator loop).
// temp controls how many consecutive ticks of contact are required before merge.
export function checkNaBlobMerges(naBlobs, mct, grains, temp = 1000) {
  const tempFactor  = Math.max(0.05, Math.min(1, (temp - 700) / 500))
  const frameTarget = Math.max(5, Math.round(20 / tempFactor))

  let didMerge = false
  for (let i = 0; i < naBlobs.length && !didMerge; i++) {
    for (let j = i + 1; j < naBlobs.length && !didMerge; j++) {
      const key = `${naBlobs[i].id},${naBlobs[j].id}`
      const ctrA = naBlobs[i].particles[0]
      const ctrB = naBlobs[j].particles[0]
      const dx = ctrB.x - ctrA.x, dy = ctrB.y - ctrA.y
      // Only trigger on actual physical contact: surfaces touching = sum of radii
      const t = naBlobs[i].blobR + naBlobs[j].blobR + 1
      const close = dx * dx + dy * dy < t * t
      if (close) {
        mct[key] = (mct[key] || 0) + 1
        if (mct[key] >= frameTarget) {
          naBlobs[i] = mergeNaBlobs(naBlobs[i], naBlobs[j], grains)
          naBlobs.splice(j, 1)
          for (const k of Object.keys(mct)) delete mct[k]
          didMerge = true
        }
      } else if (mct[key] > 0) {
        mct[key]--
      }
    }
  }
}

// Call once per visual frame. Absorbs nearby na/silicate/sand grains into sil blobs.
// All types activate at 700°C; sand is slower (weaker Si-O bond probability).
// Proximity is checked against the nearest sub-circle, not the phantom center, so
// grains trapped inside the hull (where the center may have drifted) are caught.
export function absorbNearbyGrains(grains, naBlobs, temp) {
  if (!naBlobs.length) return
  const tempF    = Math.max(0, Math.min(1, (temp - 700) / 500))
  const naSilProb = tempF * 0.008
  const sandProb  = tempF * 0.002  // sand dissolves ~4× slower than Na/silicate
  if (naSilProb <= 0) return

  for (const blob of naBlobs) {
    let absorbed = false

    for (let i = grains.length - 1; i >= 0 && !absorbed; i--) {
      const g = grains[i]
      const isSand  = g.type === 'sand'
      const isNaSil = g.type === 'na' || g.type === 'silicate'
      if (!isSand && !isNaSil) continue
      if (g.type === 'silicate' && g.r >= NA_BLOB_CONVERT_R) continue

      const prob = isSand ? sandProb : naSilProb
      if (prob <= 0) continue

      // Check proximity to nearest sub-circle (catches grains inside the hull
      // even when the phantom center has drifted away from them)
      let minD2 = Infinity
      const contactR = g.r + NA_R + 3
      for (const p of blob.particles) {
        if (p.type !== 'na-sub') continue
        const dx = g.x - p.x, dy = g.y - p.y
        minD2 = Math.min(minD2, dx * dx + dy * dy)
        if (minD2 < contactR * contactR) break
      }
      if (minD2 >= contactR * contactR) continue
      if (Math.random() >= prob) continue

      blob.blobR = Math.sqrt(blob.blobR ** 2 + g.r ** 2)
      g.type   = 'na-sub'
      g.blobId = blob.id
      g.color  = '#fff'; g._cr = 255; g._cg = 255; g._cb = 255
      blob.particles.push(g)

      if (!blob.merged) {
        const ctr = blob.particles[0]
        const dx = g.x - ctr.x, dy = g.y - ctr.y
        const dr = Math.sqrt(dx * dx + dy * dy) || 1
        blob.springs.push({ a: ctr, b: g, rest: dr, k: NA_BLOB_K_RAD })
        const thresh2 = (NA_BLOB_PITCH * 1.5) ** 2
        for (const p of blob.particles) {
          if (p === g || p.type === 'na-ctr') continue
          const pdx = p.x - g.x, pdy = p.y - g.y
          const pd2 = pdx * pdx + pdy * pdy
          if (pd2 < thresh2) blob.springs.push({ a: g, b: p, rest: Math.sqrt(pd2), k: NA_BLOB_K_NBR })
        }
      }

      absorbed = true
    }
  }
}
