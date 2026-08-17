// meltPhysics.js — KMT hard-sphere + charge-based pairwise interaction physics

export const PHYSICS_START_TEMP = 0
export const SIM_W = 600
export const SIM_H = 350   // grid area only

const SUBSTEPS       = 6      // more substeps → fewer tunnelling events at high T
const THERMAL_SPEED  = 0.005  // v_rms = THERMAL_SPEED × √T  (px/substep per √°C)
const THERMOSTAT_TAU = 0.10   // Berendsen coupling: fraction of (v_target/v_rms − 1) per substep
const WALL_K         = 1.0    // soft boundary spring
const WALL_BUF       = 100    // invisible buffer beyond visible area before walls push back

// Opposite-charge pairs: preferred distance, spring constant, cutoff multiplier.
// Each species sits on its own hex lattice scaled so O midpoints match r0 exactly:
//   Si: lattice a=18px → O at 9px  = r0_SiO
//   Na: lattice a=32px → O at 16px = r0_NaO
//   Ca: lattice a=24px → O at 12px = r0_CaO
//
// Cutoff (mult) calibrated so escape energy ½·k·(r0·(mult-1))² = KE at T_escape,
// with THERMAL_SPEED=0.005: KE(T) = ½·(0.005·√T)² = 1.25e-5·T
//   Si-O: escapes ~1200°C  (KE=0.015)  →  ½·0.42·(9·0.03)²  = 0.0153 ✓
//   Ca-O: escapes  ~700°C  (KE=0.00875)→  ½·0.28·(12·0.02)² = 0.0081 ✓
//   Na-O: escapes  ~460°C  (KE=0.00575)→  ½·0.20·(16·0.02)² = 0.0064 ✓
const PREFERRED = {
  // oneSided: no spring repulsion for d < r0 — hard-sphere collision is the only
  // close-range repulsion.  After any collision the atoms coast to d = r0 where the
  // attractive spring captures them; bonds therefore form wherever particles meet at
  // low enough temperature rather than being blown apart by a spring kick.
  'O-Si': { r0: 9,  k: 0.42, mult: 1.03, oneSided: true  },
  'Na-O': { r0: 16, k: 0.20, mult: 1.02, oneSided: false },
  'Ca-O': { r0: 12, k: 0.28, mult: 1.02, oneSided: false },
}

// Same-charge pairs — soft-sphere repulsion only (positive ions repel each other; O repels O)
const REP_K    = 0.28
const REP_MULT = 1.8   // repulsion applies within (r_i + r_j) × REP_MULT

// Fast type-pair lookup: integer IDs → avoid string allocation in the inner loop
const TYPE_ID = { Si: 0, O: 1, Na: 2, Ca: 3 }
// Max interaction cutoff per type pair (px); null = same-charge repulsion only
// Max attraction: Na-O at r0=16, mult=1.02 → 16.3px; max repulsion: Ca-Ca at (5+5)*1.8=18px
const FORCE_CUTOFF    = 20   // early-reject pairs farther than this in x or y
const COLLIDE_CUTOFF  = 10   // early-reject collision pairs (max r_i + r_j = Ca+Ca = 10)
// 4×4 pair-spec table indexed by [typeIdA][typeIdB]
const PAIR_TABLE = Array.from({ length: 4 }, () => new Array(4).fill(null))
PAIR_TABLE[0][1] = PAIR_TABLE[1][0] = PREFERRED['O-Si']
PAIR_TABLE[2][1] = PAIR_TABLE[1][2] = PREFERRED['Na-O']
PAIR_TABLE[3][1] = PAIR_TABLE[1][3] = PREFERRED['Ca-O']

// Lattice anchor: each atom is tethered to its initial position by a gentle spring.
// Prevents center-of-mass drift/rotation of grain clusters while leaving thermal
// vibration visible.  Fades out linearly as T→ANCHOR_FADE_TEMP, and is permanently
// disabled once the simulation has ever reached ANCHOR_MELT_TEMP so it never fights
// a re-solidified (crystallized) network that has moved from the original grain layout.
const ANCHOR_K         = 0.06
const ANCHOR_FADE_TEMP = 800   // anchor → 0 at this °C
const ANCHOR_MELT_TEMP = 600   // once T exceeds this, anchor disabled forever

// ── Hex-directed attraction helper ───────────────────────────────────────────
// Returns the ideal 120°-spaced bond slot for the next O on a Si atom.
// existingAngles: angles of Si's current O bonds.
// candidateAngle: current direction from Si to the O being considered.
// Strategy: anchor three canonical positions to the first existing bond, drop any
// slot within 60° of an existing bond (each bond claims exactly one slot), return
// the remaining free slot closest to candidateAngle.
function idealHexAngle(existingAngles, candidateAngle) {
  if (existingAngles.length === 0) return candidateAngle   // first bond: no preference
  const PI2  = Math.PI * 2
  const STEP = PI2 / 3            // 120° between slots
  const TOL  = Math.PI / 3        // 60° — half the inter-slot gap; each bond claims one slot
  const wrap = a => ((a % PI2) + PI2) % PI2
  const diff = (a, b) => { let d = Math.abs(wrap(a) - wrap(b)); return d > Math.PI ? PI2 - d : d }

  const base  = wrap(existingAngles[0])
  const slots = [base, wrap(base + STEP), wrap(base - STEP)]

  const free = slots.filter(s => existingAngles.every(ea => diff(s, ea) > TOL))
  if (free.length === 0) return candidateAngle   // Si already satisfied
  return free.reduce((best, s) =>
    diff(s, candidateAngle) < diff(best, candidateAngle) ? s : best
  )
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initPhysics(cellData) {
  const particles = []
  const posMap    = new Map()

  for (const { atoms, type, idx } of cellData) {
    for (const atom of atoms) {
      const key = `${Math.round(atom.x * 2)},${Math.round(atom.y * 2)}`
      if (posMap.has(key)) continue
      posMap.set(key, particles.length)
      particles.push({
        x0: atom.x, y0: atom.y,
        x:  atom.x, y:  atom.y,
        px: atom.x, py: atom.y,   // previous-step positions for lerp
        vx: 0,      vy: 0,
        type: atom.type, typeId: TYPE_ID[atom.type] ?? 0, r: atom.r,
        cellType: type,
        chunkIdx: idx,
      })
    }
  }

  const n = particles.length

  // Resolve initial overlaps: push particles apart (position only, no velocities).
  // Needed because chunk polygons overlap, so cross-chunk atom pairs can start coincident.
  for (let pass = 0; pass < 120; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj   = particles[j]
        const dx   = pj.x - pi.x, dy = pj.y - pi.y
        const minD = pi.r + pj.r
        const d2   = dx * dx + dy * dy
        if (d2 >= minD * minD || d2 < 1e-6) continue
        moved = true
        const d    = Math.sqrt(d2)
        const nx   = dx / d, ny = dy / d
        const half = (minD - d) * 0.55  // slight overshoot aids convergence
        pi.x -= nx * half; pi.y -= ny * half
        pj.x += nx * half; pj.y += ny * half
      }
    }
    if (!moved) break
  }
  // Sync all position references so lerp and spread calculations use corrected start
  for (const p of particles) { p.x0 = p.x; p.y0 = p.y; p.px = p.x; p.py = p.y }

  // Per-chunk metadata for outline tracing
  const chunks = cellData.map(({ idx, pts, bg, bdr }) => {
    const pIdxs = []
    for (let i = 0; i < particles.length; i++) {
      if (particles[i].chunkIdx === idx) pIdxs.push(i)
    }
    let origCx = 0, origCy = 0
    for (const i of pIdxs) { origCx += particles[i].x0; origCy += particles[i].y0 }
    if (pIdxs.length) { origCx /= pIdxs.length; origCy /= pIdxs.length }
    let origSpread = 0
    for (const i of pIdxs) {
      origSpread += Math.hypot(particles[i].x0 - origCx, particles[i].y0 - origCy)
    }
    origSpread = pIdxs.length ? origSpread / pIdxs.length : 1
    return { idx, pts, bg, bdr, origCx, origCy, origSpread: Math.max(origSpread, 4), pIdxs }
  })

  return {
    particles,
    bonds: [],   // rebuilt dynamically each step for rendering
    chunks,
    n,
    fx: new Float32Array(n),
    fy: new Float32Array(n),
    hasBeenMelted: false,
  }
}

// Gentle long-range attraction between unsatisfied opposite-charge pairs, active
// only during cooling.  Bond-count-aware: stops pulling once an atom reaches its
// coordination target so the network forms naturally without over-bonding.
//   Si  → 3 O  (triangular network former in 2-D)
//   O   → 2 cations  (bridging O bonds 2 Si; non-bridging bonds 1 Si + 1 modifier)
//   Na  → 1 O  (monovalent modifier — each Na⁺ breaks one bridge, takes 1 NBO)
//   Ca  → 2 O  (divalent modifier — each Ca²⁺ claims 2 NBOs)
// Slow/fast outcome difference comes from crystallize() nudge (slow only), not from
// the attract itself — amorphous = random collision angles, crystalline = nudged 120°.
const ATTRACT_RANGE  = 40
const COORD_TARGET   = [3, 2, 1, 2]   // Si, O, Na, Ca (typeId order)

// ── Step ──────────────────────────────────────────────────────────────────────
// coolingFactor: 1.0 = thermostat mode
// attractK:     subtle pull strength, active only when coolingMode !== null
// coolingMode:  null | 'fast' | 'slow'
export function stepPhysics(phys, tempC, coolingFactor = 1.0, attractK = 0, coolingMode = null) {
  const { particles, n, fx, fy } = phys
  const vTarget = THERMAL_SPEED * Math.sqrt(Math.max(0, tempC))

  if (!phys.hasBeenMelted && tempC > ANCHOR_MELT_TEMP) phys.hasBeenMelted = true
  const anchorStr = phys.hasBeenMelted
    ? 0
    : ANCHOR_K * Math.max(0, 1 - tempC / ANCHOR_FADE_TEMP)

  // Per-atom opposite-charge bond counts and (for slow cool) Si bond-angle maps.
  // Both built from last frame's bond snapshot — one frame stale, acceptable.
  const doAttract = attractK > 0 && coolingMode !== null
  const bondCount = doAttract ? new Int32Array(n) : null
  if (bondCount) {
    for (const { i, j } of phys.bonds) { bondCount[i]++; bondCount[j]++ }
  }

  // For slow cool: map each Si → array of current O-bond angles so idealHexAngle()
  // can direct incoming O toward the correct 120° slot rather than Si's center.
  const siBondAngles = (doAttract && coolingMode === 'slow') ? new Map() : null
  if (siBondAngles) {
    for (const { i, j } of phys.bonds) {
      const ti = particles[i].typeId, tj = particles[j].typeId
      let si, oi
      if      (ti === 0 && tj === 1) { si = i; oi = j }
      else if (ti === 1 && tj === 0) { si = j; oi = i }
      else continue
      if (!siBondAngles.has(si)) siBondAngles.set(si, [])
      siBondAngles.get(si).push(
        Math.atan2(particles[oi].y - particles[si].y, particles[oi].x - particles[si].x)
      )
    }
  }

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    fx.fill(0); fy.fill(0)

    // ── Pairwise interaction forces ──────────────────────────────
    // Fast early-reject on single axis before computing full distance.
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj = particles[j]
        const dx = pj.x - pi.x
        if (dx > FORCE_CUTOFF || dx < -FORCE_CUTOFF) continue
        const dy = pj.y - pi.y
        if (dy > FORCE_CUTOFF || dy < -FORCE_CUTOFF) continue
        const d2 = dx * dx + dy * dy
        if (d2 < 0.01) continue
        const d  = Math.sqrt(d2)
        const nx = dx / d, ny = dy / d
        const spec = PAIR_TABLE[pi.typeId][pj.typeId]

        if (spec) {
          // For one-sided specs (Si-O): spring only when d > r0 (purely attractive).
          // Hard-sphere collision already handles close approach — no spring kick.
          if (d < spec.r0 * spec.mult && (!spec.oneSided || d > spec.r0)) {
            const f = spec.k * (d - spec.r0)
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        } else {
          const cutoff = (pi.r + pj.r) * REP_MULT
          if (d < cutoff) {
            const f = -REP_K * (cutoff - d)
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }

    // ── Cooling attraction — mode-specific structure assembly ───────────
    // Slow cool Si-O: directs O toward the ideal 120° hex slot on Si rather than
    // Si's center, so the hexagonal network assembles by attraction rather than
    // waiting for random collisions.  Modifier (Na, Ca) attraction is suppressed
    // above 250°C so the Si-O network forms first; Na/Ca then claim the non-bridging
    // O atoms (NBOs) that are left with one free bond after the Si network closes.
    //
    // Fast cool Si-O: isotropic — whatever angle O approaches from is where it bonds,
    // producing random bond angles → mixed ring sizes → amorphous glass.
    if (bondCount) {
      for (let i = 0; i < n; i++) {
        if (bondCount[i] >= COORD_TARGET[particles[i].typeId]) continue
        const pi = particles[i]
        for (let j = i + 1; j < n; j++) {
          if (bondCount[j] >= COORD_TARGET[particles[j].typeId]) continue
          const pj   = particles[j]
          const spec = PAIR_TABLE[pi.typeId][pj.typeId]
          if (!spec) continue

          // Slow cool modifier gate: Na-O and Ca-O attraction only below 250°C
          const isSiO = spec === PAIR_TABLE[0][1]
          if (coolingMode === 'slow' && !isSiO && tempC > 250) continue

          const dx = pj.x - pi.x
          if (dx > ATTRACT_RANGE || dx < -ATTRACT_RANGE) continue
          const dy = pj.y - pi.y
          if (dy > ATTRACT_RANGE || dy < -ATTRACT_RANGE) continue
          const d2 = dx * dx + dy * dy
          if (d2 >= ATTRACT_RANGE * ATTRACT_RANGE) continue
          const bondCutSq = (spec.r0 * spec.mult) ** 2
          if (d2 <= bondCutSq) continue   // inside bond range: spring already handles it
          const d = Math.sqrt(d2)
          const f = attractK * spec.r0 / d

          if (coolingMode === 'slow' && isSiO) {
            // Hex-directed: aim O at the ideal 120° slot on Si, not at Si's center
            const isSi_i = pi.typeId === 0
            const siIdx  = isSi_i ? i : j
            const oIdx   = isSi_i ? j : i
            const si = particles[siIdx], o = particles[oIdx]
            const θ  = idealHexAngle(
              siBondAngles.get(siIdx) ?? [],
              Math.atan2(o.y - si.y, o.x - si.x)
            )
            const tx = si.x + spec.r0 * Math.cos(θ) - o.x
            const ty = si.y + spec.r0 * Math.sin(θ) - o.y
            const tlen = Math.hypot(tx, ty)
            if (tlen < 0.5) continue
            const tnx = tx / tlen, tny = ty / tlen
            fx[oIdx]  += f * tnx;  fy[oIdx]  += f * tny   // O toward ideal slot
            fx[siIdx] -= f * tnx;  fy[siIdx] -= f * tny   // Si reacts
          } else {
            // Fast cool (all pairs) or slow cool modifier (below 250°C): isotropic
            const nx = dx / d, ny = dy / d
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }

    // ── Lattice anchor: tethers each atom to its initial grain position ──
    if (anchorStr > 0) {
      for (let i = 0; i < n; i++) {
        const p = particles[i]
        fx[i] -= anchorStr * (p.x - p.x0)
        fy[i] -= anchorStr * (p.y - p.y0)
      }
    }

    // ── Soft boundary walls (100px outside visible area) ─────────
    for (let i = 0; i < n; i++) {
      const p  = particles[i]
      const m  = p.r + 2
      const x0 = -WALL_BUF + m,          x1 = SIM_W + WALL_BUF - m
      const y0 = -WALL_BUF + m,          y1 = SIM_H + WALL_BUF - m
      if (p.x < x0) fx[i] += WALL_K * (x0 - p.x)
      if (p.x > x1) fx[i] += WALL_K * (x1 - p.x)
      if (p.y < y0) fy[i] += WALL_K * (y0 - p.y)
      if (p.y > y1) fy[i] += WALL_K * (y1 - p.y)
    }

    // ── Integrate ───────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const p = particles[i]
      p.vx += fx[i];  p.vy += fy[i]
      p.x  += p.vx;   p.y  += p.vy
    }

    // ── Elastic hard-sphere collision resolution ─────────────────
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj = particles[j]
        const dx = pj.x - pi.x
        if (dx > COLLIDE_CUTOFF || dx < -COLLIDE_CUTOFF) continue
        const dy   = pj.y - pi.y
        const minD = pi.r + pj.r
        const d2   = dx * dx + dy * dy
        if (d2 >= minD * minD || d2 < 1e-6) continue
        const d    = Math.sqrt(d2)
        const nx   = dx / d, ny = dy / d
        const half = (minD - d) * 0.5
        pi.x -= nx * half;  pi.y -= ny * half
        pj.x += nx * half;  pj.y += ny * half
        const dvn = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
        if (dvn > 0) {
          pi.vx -= dvn * nx;  pi.vy -= dvn * ny
          pj.vx += dvn * nx;  pj.vy += dvn * ny
        }
      }
    }

    // ── Thermostat or cooling ────────────────────────────────────
    if (coolingFactor < 1.0 - 1e-6) {
      // Cooling mode: apply per-substep damping (nth root of the per-step factor)
      const sf = Math.pow(coolingFactor, 1 / SUBSTEPS)
      for (let i = 0; i < n; i++) { particles[i].vx *= sf; particles[i].vy *= sf }
    } else if (vTarget < 0.001) {
      // T ≈ 0: damp velocities to rest
      for (let i = 0; i < n; i++) { particles[i].vx *= 0.8; particles[i].vy *= 0.8 }
    } else {
      // Berendsen thermostat: rescale toward target speed
      let sumV2 = 0
      for (let i = 0; i < n; i++) {
        const p = particles[i]; sumV2 += p.vx * p.vx + p.vy * p.vy
      }
      const vRms = Math.sqrt(sumV2 / n)
      if (vRms < 0.001) {
        // Cold start: initialize with random velocities at target
        for (let i = 0; i < n; i++) {
          const theta = Math.random() * Math.PI * 2
          particles[i].vx = vTarget * Math.cos(theta)
          particles[i].vy = vTarget * Math.sin(theta)
        }
      } else {
        const scale = 1 + THERMOSTAT_TAU * (vTarget / vRms - 1)
        for (let i = 0; i < n; i++) { particles[i].vx *= scale; particles[i].vy *= scale }
      }
    }
  }

  // ── Dynamic bond detection for rendering ─────────────────────────────────
  const bonds = []
  for (let i = 0; i < n; i++) {
    const pi   = particles[i]
    for (let j = i + 1; j < n; j++) {
      const pj   = particles[j]
      const spec = PAIR_TABLE[pi.typeId][pj.typeId]
      if (!spec) continue
      const dx = pj.x - pi.x
      if (dx > spec.r0 * spec.mult || dx < -spec.r0 * spec.mult) continue
      const d = Math.hypot(dx, pj.y - pi.y)
      if (d > spec.r0 * spec.mult) continue
      bonds.push({ i, j, strain: (d - spec.r0) / spec.r0, currentBreakStrain: 0.25 })
    }
  }
  phys.bonds = bonds
}

// ── Convex hull (Andrew's monotone chain) ─────────────────────────────────────
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

// ── Runtime parameter updates ────────────────────────────────────────────────
// Mutates the shared PREFERRED entry so PAIR_TABLE, crystallize(), and the force
// loop all pick up the new value immediately without rebuilding the module.
export function setSiOr0(r0) {
  PREFERRED['O-Si'].r0 = r0
}

// ── Crystallization nudge ─────────────────────────────────────────────────────
// For slow cooling: detects Si in near-hexagonal (3-fold, ~120°) bond environments,
// clusters connected groups through shared O bridges, then teleports O atoms partway
// toward ideal hex positions for clusters large enough to be crystal seeds.
// Call every 10-20 RAF frames during slow cool, below the composition threshold.
export function crystallize(phys, strength, minCluster, angleTol = 25) {
  const { particles, bonds } = phys
  if (!bonds || bonds.length === 0) return

  const tolRad = angleTol * (Math.PI / 180)
  const TWO_PI = 2 * Math.PI
  const IDEAL  = TWO_PI / 3   // 120°

  // Build Si→[O idx] and O→[Si idx] adjacency from current bond snapshot
  const siToO = new Map()
  const oToSi = new Map()
  for (const { i, j } of bonds) {
    const ti = particles[i].typeId, tj = particles[j].typeId
    let si, oi
    if      (ti === 0 && tj === 1) { si = i; oi = j }
    else if (ti === 1 && tj === 0) { si = j; oi = i }
    else continue
    if (!siToO.has(si)) siToO.set(si, [])
    siToO.get(si).push(oi)
    if (!oToSi.has(oi)) oToSi.set(oi, [])
    oToSi.get(oi).push(si)
  }

  // Identify Si atoms in hex environment: exactly 3 O bonds, all angle gaps within tolRad of 120°
  const hexSi = new Map()   // si_idx → best-fit lattice orientation θ
  for (const [si, oList] of siToO) {
    if (oList.length !== 3) continue
    const p = particles[si]
    const a = oList.map(k => Math.atan2(particles[k].y - p.y, particles[k].x - p.x))
    a.sort((x, y) => x - y)
    const g0 = a[1] - a[0], g1 = a[2] - a[1], g2 = TWO_PI - (a[2] - a[0])
    if (Math.max(Math.abs(g0 - IDEAL), Math.abs(g1 - IDEAL), Math.abs(g2 - IDEAL)) < tolRad) {
      hexSi.set(si, (a[0] + (a[1] - IDEAL) + (a[2] - 2 * IDEAL)) / 3)
    }
  }
  if (hexSi.size === 0) return

  // BFS: find connected clusters of hex-environment Si (connected through shared O)
  const visited  = new Set()
  const clusters = []
  for (const start of hexSi.keys()) {
    if (visited.has(start)) continue
    const cluster = [], queue = [start]
    visited.add(start)
    let qi = 0
    while (qi < queue.length) {
      const cur = queue[qi++]
      cluster.push(cur)
      for (const oi of siToO.get(cur)) {
        for (const nb of (oToSi.get(oi) ?? [])) {
          if (!visited.has(nb) && hexSi.has(nb)) { visited.add(nb); queue.push(nb) }
        }
      }
    }
    clusters.push(cluster)
  }

  // Teleport O atoms partway toward ideal hex positions for large enough clusters
  const R0 = PREFERRED['O-Si'].r0   // 9 px — Si-O equilibrium distance
  for (const cluster of clusters) {
    if (cluster.length < minCluster) continue
    for (const si of cluster) {
      const p = particles[si], θ = hexSi.get(si)
      const ia = [θ, θ + IDEAL, θ + 2 * IDEAL]
      for (const oi of siToO.get(si)) {
        const o      = particles[oi]
        const actual = Math.atan2(o.y - p.y, o.x - p.x)
        let best = ia[0], bestD = Infinity
        for (const a of ia) {
          let d = actual - a; while (d > Math.PI) d -= TWO_PI; while (d < -Math.PI) d += TWO_PI
          if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = a }
        }
        // Position-only correction; velocity (vx/vy) unchanged so thermostat still governs speed
        o.x += strength * (p.x + R0 * Math.cos(best) - o.x)
        o.y += strength * (p.y + R0 * Math.sin(best) - o.y)
      }
    }
  }
}

// ── Pre-computed cooling targets ─────────────────────────────────────────────
//
// computeAmorphousTargets: damped physics relaxation (T=0, long-range attract ON)
// on cloned positions.  Returns settled amorphous layout as target array.
export function computeAmorphousTargets(phys) {
  const { particles, n } = phys
  const px = new Float32Array(n), py = new Float32Array(n)
  const vx = new Float32Array(n), vy = new Float32Array(n)
  const fx = new Float32Array(n), fy = new Float32Array(n)
  for (let i = 0; i < n; i++) { px[i] = particles[i].x; py[i] = particles[i].y }

  for (let step = 0; step < 80; step++) {
    fx.fill(0); fy.fill(0)
    for (let i = 0; i < n; i++) {
      const ti = particles[i].typeId
      for (let j = i + 1; j < n; j++) {
        const dx = px[j] - px[i]; if (dx > ATTRACT_RANGE || dx < -ATTRACT_RANGE) continue
        const dy = py[j] - py[i]; if (dy > ATTRACT_RANGE || dy < -ATTRACT_RANGE) continue
        const d2 = dx*dx + dy*dy; if (d2 < 0.01 || d2 >= ATTRACT_RANGE*ATTRACT_RANGE) continue
        const d = Math.sqrt(d2), nx = dx/d, ny = dy/d
        const spec = PAIR_TABLE[ti][particles[j].typeId]
        if (spec) {
          const cut = spec.r0 * spec.mult
          if (d < cut) {
            if (!spec.oneSided || d > spec.r0) {
              const f = spec.k * (d - spec.r0)
              fx[i]+=f*nx; fy[i]+=f*ny; fx[j]-=f*nx; fy[j]-=f*ny
            }
          } else {
            const f = 0.06 * spec.r0 / d   // long-range pull to bring pairs within bond range
            fx[i]+=f*nx; fy[i]+=f*ny; fx[j]-=f*nx; fy[j]-=f*ny
          }
        } else {
          const cut = (particles[i].r + particles[j].r) * REP_MULT
          if (d < cut) { const f = -REP_K*(cut-d); fx[i]+=f*nx; fy[i]+=f*ny; fx[j]-=f*nx; fy[j]-=f*ny }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      vx[i] = vx[i]*0.4 + fx[i];  vy[i] = vy[i]*0.4 + fy[i]
      px[i] = Math.max(particles[i].r+2, Math.min(SIM_W-particles[i].r-2, px[i]+vx[i]))
      py[i] = Math.max(particles[i].r+2, Math.min(SIM_H-particles[i].r-2, py[i]+vy[i]))
    }
  }
  return Array.from({length: n}, (_, i) => ({ x: px[i], y: py[i] }))
}

// computeSlowCoolTargets: hex crystal lattice stamped from center, particles
// matched to nearest site by type.  crystalFrac (derived from SiO₂ content)
// controls what fraction of each species goes to crystal vs amorphous positions.
export function computeSlowCoolTargets(phys, sio2Pct, _na2oPct, _caoPct) {
  const { particles, n } = phys
  const targets = computeAmorphousTargets(phys)   // amorphous baseline for every particle

  const crystalFrac = Math.max(0, Math.pow(Math.max(0, sio2Pct - 50) / 50, 1.5))
  if (crystalFrac < 0.02) return targets

  const R0  = PREFERRED['O-Si'].r0          // 9 px
  const a   = R0 * 2                         // lattice constant = 18 px
  const a1x = a * Math.sqrt(3)              // ≈ 31.2
  const a2x = a * Math.sqrt(3) / 2          // ≈ 15.6
  const a2y = a * 1.5                        // 27
  const bDx = a * Math.sqrt(3) / 2, bDy = a * 0.5
  const cx  = SIM_W / 2, cy = SIM_H / 2
  const ni  = Math.ceil(SIM_W / a1x) + 1
  const nj  = Math.ceil(SIM_H / a2y) + 1

  // Generate all lattice sites
  const siSites = [], naSites = []
  for (let ii = -ni; ii <= ni; ii++) {
    for (let jj = -nj; jj <= nj; jj++) {
      for (const [ddx, ddy] of [[0,0],[bDx,bDy]]) {
        const x = cx + ii*a1x + jj*a2x + ddx, y = cy + jj*a2y + ddy
        if (x > 4 && x < SIM_W-4 && y > 4 && y < SIM_H-4) siSites.push({x,y})
      }
      // Ring centers for Na/Ca
      const rx = cx + ii*a1x + jj*a2x + bDx, ry = cy + jj*a2y - bDy
      if (rx > 4 && rx < SIM_W-4 && ry > 4 && ry < SIM_H-4) naSites.push({x:rx,y:ry})
    }
  }

  const nnSq = (a * 1.05) ** 2
  const oSites = []
  for (let i = 0; i < siSites.length; i++) {
    for (let j = i+1; j < siSites.length; j++) {
      const dx = siSites[j].x-siSites[i].x, dy = siSites[j].y-siSites[i].y
      if (dx*dx+dy*dy < nnSq) oSites.push({x:(siSites[i].x+siSites[j].x)/2, y:(siSites[i].y+siSites[j].y)/2})
    }
  }
  // Ca sites: vertical inter-ring bond midpoints (nearly pure-y displacement)
  const caSites = oSites.filter(o => {
    for (const s of siSites) if (Math.abs(s.x-o.x)<2 && Math.abs(s.y-o.y-R0)<2) return true
    return false
  })

  // Greedy nearest-site assignment per type, limited to crystalFrac of each species
  const byType = [[],[],[],[]]
  for (let i = 0; i < n; i++) byType[particles[i].typeId].push(i)

  function assignNearest(pIdxs, sites, count) {
    const sorted = [...pIdxs].sort((a,b) =>
      Math.hypot(particles[a].x-cx, particles[a].y-cy) - Math.hypot(particles[b].x-cx, particles[b].y-cy)
    )
    const used = new Set(), result = new Map()
    for (const pi of sorted.slice(0, count)) {
      let best = -1, bestD = Infinity
      for (let s = 0; s < sites.length; s++) {
        if (used.has(s)) continue
        const d = Math.hypot(sites[s].x-particles[pi].x, sites[s].y-particles[pi].y)
        if (d < bestD) { bestD = d; best = s }
      }
      if (best >= 0) { used.add(best); result.set(pi, sites[best]) }
    }
    return result
  }

  const siMap = assignNearest(byType[0], siSites, Math.round(byType[0].length * crystalFrac))
  const oMap  = assignNearest(byType[1], oSites,  Math.round(byType[1].length * crystalFrac))
  const naMap = assignNearest(byType[2], naSites, Math.round(byType[2].length * crystalFrac))
  const caMap = assignNearest(byType[3], caSites.length ? caSites : naSites, Math.round(byType[3].length * crystalFrac))

  for (const [pi, site] of [...siMap, ...oMap, ...naMap, ...caMap]) {
    targets[pi] = { x: site.x, y: site.y }
  }
  return targets
}

// Attach per-particle wobble state to phys and store targets.
export function initPrecompute(phys, targets) {
  const n = phys.n
  phys.precompute = {
    targets,
    amp:   Float32Array.from({length: n}, () => 1.5 + Math.random() * 3.5),
    phase: Float32Array.from({length: n}, () => Math.random() * Math.PI * 2),
    freq:  Float32Array.from({length: n}, () => 0.12 + Math.random() * 0.22),
  }
}

// Animate each particle toward its target.  lerpRate: fraction closed per frame.
// wobbleScale: amplitude multiplier for lateral oscillation (decays per frame).
export function stepPrecompute(phys, frame, lerpRate, wobbleScale) {
  const { particles, n } = phys
  const { targets, amp, phase, freq } = phys.precompute

  for (let i = 0; i < n; i++) {
    const p = particles[i], t = targets[i]
    if (!t) continue
    const dx = t.x - p.x, dy = t.y - p.y
    const d = Math.hypot(dx, dy)
    if (d < 0.08) { p.x = t.x; p.y = t.y; p.px = p.x; p.py = p.y; continue }
    const nx = dx/d, ny = dy/d
    const osc = amp[i] * wobbleScale * Math.sin(frame * freq[i] + phase[i])
    amp[i] *= 0.987
    p.x += lerpRate * dx + osc * (-ny)
    p.y += lerpRate * dy + osc * nx
    p.px = p.x; p.py = p.y
  }

  // Rebuild bonds for rendering
  const bonds = []
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    for (let j = i+1; j < n; j++) {
      const pj = particles[j]
      const spec = PAIR_TABLE[pi.typeId][pj.typeId]
      if (!spec) continue
      const dx = pj.x - pi.x
      if (Math.abs(dx) > spec.r0 * spec.mult) continue
      const d = Math.hypot(dx, pj.y - pi.y)
      if (d > spec.r0 * spec.mult) continue
      bonds.push({ i, j, strain: (d - spec.r0) / spec.r0, currentBreakStrain: 0.25 })
    }
  }
  phys.bonds = bonds
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

const COLOR_STOPS = [
  [0.00, 172, 167, 160],
  [0.12, 255, 180, 230],
  [0.28, 255,  40, 180],
  [0.80, 160,   0, 255],
  [1.00,   0, 200, 255],
]

function strainColor(strain, breakStrain) {
  const t = Math.min(1, Math.abs(strain) / Math.max(breakStrain, 0.001))
  for (let k = 0; k < COLOR_STOPS.length - 1; k++) {
    const [t0, r0, g0, b0] = COLOR_STOPS[k]
    const [t1, r1, g1, b1] = COLOR_STOPS[k + 1]
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return `rgb(${Math.round(r0 + (r1 - r0) * u)},${Math.round(g0 + (g1 - g0) * u)},${Math.round(b0 + (b1 - b0) * u)})`
    }
  }
  return 'rgb(0,200,255)'
}

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

const ATOM_COLOR = { Si: '#d4a020', O: '#cc3a3a', Ca: '#4a96be', Na: '#4aaa60' }

export function drawPhysics(canvas, phys, svgW, svgH, lerpT = 1, debug = false, bondNums = false) {
  if (!canvas || !phys) return
  const dpr = window.devicePixelRatio || 1
  const W   = canvas.clientWidth
  const H   = canvas.clientHeight
  if (!W || !H) return
  const cw = Math.round(W * dpr), ch = Math.round(H * dpr)
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }

  const ctx   = canvas.getContext('2d')
  const scale = Math.min(W / svgW, H / svgH) * dpr
  const offX  = (W * dpr - svgW * scale) / 2
  const offY  = (H * dpr - svgH * scale) / 2

  ctx.setTransform(scale, 0, 0, scale, offX, offY)
  ctx.fillStyle = '#1a1a1a'
  ctx.fillRect(0, 0, SIM_W, SIM_H)

  const { particles, bonds, chunks } = phys

  // ── Chunk outline traces ──
  if (chunks) {
    for (const chunk of chunks) {
      if (!chunk.pIdxs.length) continue
      const pts = chunk.pIdxs.map(i => {
        const p = particles[i]
        return lerpT < 1
          ? [p.px + (p.x - p.px) * lerpT, p.py + (p.y - p.py) * lerpT]
          : [p.x, p.y]
      })
      let cx = 0, cy = 0
      for (const [x, y] of pts) { cx += x; cy += y }
      cx /= pts.length; cy /= pts.length
      const currSpread = pts.reduce((s, [x, y]) => s + Math.hypot(x - cx, y - cy), 0) / pts.length
      const spreadRatio = currSpread / chunk.origSpread
      const alpha = Math.max(0, 1 - (spreadRatio - 1.0) / 0.30)
      if (alpha < 0.01) continue
      const hull = convexHull(pts)
      if (hull.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(hull[0][0], hull[0][1])
      for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1])
      ctx.closePath()
      ctx.globalAlpha = alpha * 0.18; ctx.fillStyle = chunk.bg; ctx.fill()
      ctx.globalAlpha = alpha * 0.80; ctx.strokeStyle = chunk.bdr; ctx.lineWidth = 1.5; ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // ── Bonds — lens shapes colored by strain ──
  ctx.globalAlpha = 0.60
  for (const bond of bonds) {
    const pi = particles[bond.i], pj = particles[bond.j]
    const x1 = lerpT < 1 ? pi.px + (pi.x - pi.px) * lerpT : pi.x
    const y1 = lerpT < 1 ? pi.py + (pi.y - pi.py) * lerpT : pi.y
    const x2 = lerpT < 1 ? pj.px + (pj.x - pj.px) * lerpT : pj.x
    const y2 = lerpT < 1 ? pj.py + (pj.y - pj.py) * lerpT : pj.y
    ctx.fillStyle = strainColor(bond.strain, bond.currentBreakStrain)
    fillLens(ctx, x1, y1, x2, y2, 1.4)
    ctx.fill()
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.6; ctx.stroke()
  }
  ctx.globalAlpha = 1

  // ── Atoms ──
  ctx.globalAlpha = 0.88
  for (const p of particles) {
    const rx = lerpT < 1 ? p.px + (p.x - p.px) * lerpT : p.x
    const ry = lerpT < 1 ? p.py + (p.y - p.py) * lerpT : p.y
    ctx.fillStyle = ATOM_COLOR[p.type] ?? '#fff'
    ctx.beginPath(); ctx.arc(rx, ry, p.r, 0, Math.PI * 2); ctx.fill()
  }
  ctx.globalAlpha = 1

  // ── Debug overlay ─────────────────────────────────────────────────────────
  if (bondNums) {
    const n = particles.length
    const bondCnt = new Int32Array(n)
    for (const { i, j } of bonds) { bondCnt[i]++; bondCnt[j]++ }

    if (bondNums) {
      // Bond-count label on every atom (outlined for readability on any background)
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.font         = '6px monospace'
      for (let i = 0; i < n; i++) {
        const p  = particles[i]
        const rx = lerpT < 1 ? p.px + (p.x - p.px) * lerpT : p.x
        const ry = lerpT < 1 ? p.py + (p.y - p.py) * lerpT : p.y
        const cnt = bondCnt[i]
        const tgt = COORD_TARGET[p.typeId] ?? 2
        const col = cnt >= tgt ? '#00ff66' : cnt > 0 ? '#ffcc00' : '#ff4444'
        ctx.lineWidth   = 2.5
        ctx.strokeStyle = '#000'
        ctx.globalAlpha = 0.9
        ctx.strokeText(String(cnt), rx, ry)
        ctx.fillStyle   = col
        ctx.globalAlpha = 1
        ctx.fillText(String(cnt), rx, ry)
      }
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
