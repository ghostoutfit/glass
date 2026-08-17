import { useMemo, useRef, useEffect } from 'react'
import { initPhysics, stepPhysics, drawPhysics, crystallize, setSiOr0 } from './meltPhysics.js'

const VW      = 600
const VH_GRID = 350
const VH      = VH_GRID + 22   // + legend strip
const COLS    = 5
const ROWS    = 4
const CELL_W  = VW / COLS       // 120
const CELL_H  = VH_GRID / ROWS  // 87.5

// SI_A is derived from sioR0 at call time (SI_A = 2 * sioR0)
const NA_A = 32   // Na-O bond: O at midpoints = 16px = r0_NaO
const CA_A = 24   // Ca-O bond: O at midpoints = 12px = r0_CaO

// Gap (px) inset from every chunk boundary before placing any atom.
// Must exceed the largest attractive cutoff per side: Na-O = 16.32px → need > 8.16px.
const GRAIN_MARGIN = 9

// Cooling durations in RAF frames (≈60 fps)
const FAST_COOL_FRAMES = 90    // ~1.5 s wall-clock
const SLOW_COOL_FRAMES = 360   // ~6 s wall-clock
const CRYST_INTERVAL   = 10    // frames between crystallization checks during slow cool

// Composition-dependent crystallization parameters.
// threshold: °C below which the check starts
// minCluster: minimum connected hex-environment Si atoms to trigger nudge
// strength: fraction of displacement corrected per check (0 → 1)
// angleTol: degrees tolerance on each 120° gap in the Si-O ring
function getCrystParams(sio2Pct, na2oPct, caoPct) {
  const add = na2oPct + caoPct
  if (add <= 5) {
    // Pure SiO₂ — hex rings form readily across large domains
    return { threshold: 500, minCluster: 4, strength: 0.14, angleTol: 25 }
  } else if (na2oPct >= 25 && caoPct <= 5) {
    // High Na₂O — Na disrupts network; fewer, smaller crystal domains
    return { threshold: 400, minCluster: 5, strength: 0.07, angleTol: 20 }
  } else if (add >= 40) {
    // Too many additives — ionic clusters nucleate easily; relaxed threshold
    return { threshold: 450, minCluster: 3, strength: 0.16, angleTol: 30 }
  } else {
    // Soda-lime / moderate mixed — mixed ion sizes prevent sustained alignment
    return { threshold: 300, minCluster: 7, strength: 0.04, angleTol: 15 }
  }
}

const C = {
  Si: '#d4a020', O: '#cc3a3a', Ca: '#4a96be', Na: '#4aaa60',
  bg_sio2:  '#d8cb98', bg_cao:  '#ede8df', bg_na2o:  '#ddeedd',
  bdr_sio2: '#a09050', bdr_cao: '#b0a898', bdr_na2o: '#88aa88',
  lbl_sio2: '#7a6830', lbl_cao: '#5a7080', lbl_na2o: '#4a7850',
}

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

function buildGrid(sio2Pct, na2oPct, caoPct) {
  const total = COLS * ROWS
  const nSio2 = Math.round(sio2Pct / 100 * total)
  const nNa2o = Math.round(na2oPct / 100 * total)
  const nCao  = Math.max(0, total - nSio2 - nNa2o)

  const types = [
    ...Array(nSio2).fill('SiO2'),
    ...Array(nNa2o).fill('Na2O'),
    ...Array(nCao).fill('CaO'),
  ]
  while (types.length < total) types.push('SiO2')
  while (types.length > total) types.pop()

  const rand = makeRand(sio2Pct * 10000 + na2oPct * 100 + caoPct)
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[types[i], types[j]] = [types[j], types[i]]
  }
  return types
}

// ── Per-species hex lattice placement ────────────────────────────────────────
// Each cation type gets its own honeycomb lattice scaled so O midpoints land at r0:
//   Si: a = 2*sioR0  →  O at sioR0 from Si  =  r0_SiO  (zero initial spring force)
//   Na: a = NA_A=32  →  O at 16px from Na   =  r0_NaO
//   Ca: a = CA_A=24  →  O at 12px from Ca   =  r0_CaO
//
// GRAIN_MARGIN: atoms are inset from every chunk boundary by this many pixels so
// no atom from chunk A is within the attractive cutoff of any atom from chunk B.
// This gives each chunk an isolated "grain of sand" at startup.
// O atoms are only placed between same-chunk cation pairs (no cross-chunk bridges).
function buildHexLayer(a, chunkFilter, types, cationType, catRadius) {
  const a1x = a * Math.sqrt(3), a2x = a * Math.sqrt(3) / 2, a2y = a * 1.5
  const bDx = a * Math.sqrt(3) / 2, bDy = a * 0.5
  const ni = Math.ceil(VW      / a1x) + 2
  const nj = Math.ceil(VH_GRID / a2y) + 2
  const cats = [], seen = new Set()
  for (let i = -1; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      for (const [dx, dy] of [[0, 0], [bDx, bDy]]) {
        const x = i * a1x + j * a2x + dx, y = j * a2y + dy
        if (x < 0 || x >= VW || y < 0 || y >= VH_GRID) continue
        const col      = Math.min(COLS - 1, Math.floor(x / CELL_W))
        const row      = Math.min(ROWS - 1, Math.floor(y / CELL_H))
        const chunkIdx = row * COLS + col
        if (types[chunkIdx] !== chunkFilter) continue
        // Reject atoms within GRAIN_MARGIN of any chunk boundary (grain isolation)
        const cellL = col * CELL_W, cellR = (col + 1) * CELL_W
        const cellT = row * CELL_H, cellB = (row + 1) * CELL_H
        if (x - cellL < GRAIN_MARGIN || cellR - x < GRAIN_MARGIN) continue
        if (y - cellT < GRAIN_MARGIN || cellB - y < GRAIN_MARGIN) continue
        const key = `${Math.round(x * 4)},${Math.round(y * 4)}`
        if (seen.has(key)) continue
        seen.add(key)
        cats.push({ x, y, type: cationType, r: catRadius, chunkIdx })
      }
    }
  }
  const nnSq = (a * 1.05) ** 2
  const oAtoms = []
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      if (cats[i].chunkIdx !== cats[j].chunkIdx) continue  // no cross-chunk O bridges
      const dx = cats[j].x - cats[i].x, dy = cats[j].y - cats[i].y
      if (dx * dx + dy * dy >= nnSq) continue
      const ox = (cats[i].x + cats[j].x) / 2, oy = (cats[i].y + cats[j].y) / 2
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(ox / CELL_W)))
      const row = Math.min(ROWS - 1, Math.max(0, Math.floor(oy / CELL_H)))
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.5, chunkIdx: row * COLS + col })
    }
  }
  return { cats, oAtoms }
}

// Orthogonal (square) lattice for modifier oxides (Na₂O, CaO).
// Cations sit on an a×a square grid; O atoms bridge every horizontal and vertical
// nearest-neighbor pair at the midpoint.  nnSq with 1.05× factor rejects diagonals
// (√2·a ≈ 1.414a >> 1.05a) so only the 4 axis-aligned bonds are bridged.
function buildSquareLayer(a, chunkFilter, types, cationType, catRadius) {
  const ni = Math.ceil(VW      / a) + 2
  const nj = Math.ceil(VH_GRID / a) + 2
  const cats = [], seen = new Set()
  for (let i = -1; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      const x = i * a, y = j * a
      if (x < 0 || x >= VW || y < 0 || y >= VH_GRID) continue
      const col      = Math.min(COLS - 1, Math.floor(x / CELL_W))
      const row      = Math.min(ROWS - 1, Math.floor(y / CELL_H))
      const chunkIdx = row * COLS + col
      if (types[chunkIdx] !== chunkFilter) continue
      const cellL = col * CELL_W, cellR = (col + 1) * CELL_W
      const cellT = row * CELL_H, cellB = (row + 1) * CELL_H
      if (x - cellL < GRAIN_MARGIN || cellR - x < GRAIN_MARGIN) continue
      if (y - cellT < GRAIN_MARGIN || cellB - y < GRAIN_MARGIN) continue
      const key = `${Math.round(x * 4)},${Math.round(y * 4)}`
      if (seen.has(key)) continue
      seen.add(key)
      cats.push({ x, y, type: cationType, r: catRadius, chunkIdx })
    }
  }
  const nnSq = (a * 1.05) ** 2
  const oAtoms = []
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      if (cats[i].chunkIdx !== cats[j].chunkIdx) continue
      const dx = cats[j].x - cats[i].x, dy = cats[j].y - cats[i].y
      if (dx * dx + dy * dy >= nnSq) continue
      const ox = (cats[i].x + cats[j].x) / 2, oy = (cats[i].y + cats[j].y) / 2
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(ox / CELL_W)))
      const row = Math.min(ROWS - 1, Math.max(0, Math.floor(oy / CELL_H)))
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.5, chunkIdx: row * COLS + col })
    }
  }
  return { cats, oAtoms }
}

function buildAllAtoms(types, sioR0) {
  const siA = 2 * sioR0   // Si-Si spacing so O midpoints land at exactly sioR0 from Si
  const si  = buildHexLayer(siA,  'SiO2', types, 'Si', 4)
  const na  = buildSquareLayer(NA_A, 'Na2O', types, 'Na', 4)
  const ca  = buildSquareLayer(CA_A, 'CaO',  types, 'Ca', 5)
  return [...si.cats, ...na.cats, ...ca.cats, ...si.oAtoms, ...na.oAtoms, ...ca.oAtoms]
}

function LegendDot({ cx, cy, r, fill, label }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <text x={cx + r + 5} y={cy + 4}
        style={{ fontSize: 10, fill: '#888', fontFamily: 'system-ui,sans-serif' }}>
        {label}
      </text>
    </>
  )
}

export default function CompositionView({ sio2Pct, na2oPct, caoPct, sioR0 = 9, attractK = 0, tempC = 20, simSpeed = 1, coolingMode = null, onTempUpdate = null }) {
  const types = useMemo(
    () => buildGrid(sio2Pct, na2oPct, caoPct),
    [sio2Pct, na2oPct, caoPct]
  )

  const allAtoms = useMemo(() => buildAllAtoms(types, sioR0), [types, sioR0])

  const cellData = useMemo(() => types.map((type, idx) => ({
    idx,
    type,
    atoms: allAtoms.filter(a => a.chunkIdx === idx),
    bonds: [],
    pts:   null,
    bg:        C[`bg_${type.toLowerCase()}`]  ?? C.bg_sio2,
    bdr:       C[`bdr_${type.toLowerCase()}`] ?? C.bdr_sio2,
  })), [types, allAtoms])

  // ── Physics refs ──────────────────────────────────────────────
  const canvasRef          = useRef(null)
  const physRef            = useRef(null)
  const rafRef             = useRef(null)
  const tempRef            = useRef(tempC)
  const speedRef           = useRef(simSpeed)
  const coolingRef         = useRef(coolingMode)
  const frameAccRef        = useRef(0)
  // Cooling state
  const effectiveTempRef    = useRef(tempC)   // tracks temp during active cooling ramp
  const prevCoolingRef      = useRef(null)
  const coolingStartTempRef = useRef(tempC)
  const coolingFrameRef     = useRef(0)
  const crystParamsRef      = useRef(getCrystParams(sio2Pct, na2oPct, caoPct))
  const onTempUpdateRef     = useRef(onTempUpdate)
  const attractKRef         = useRef(attractK)

  useEffect(() => { onTempUpdateRef.current = onTempUpdate }, [onTempUpdate])
  useEffect(() => { attractKRef.current = attractK }, [attractK])

  // Keep the physics module's Si-O r0 in sync with the slider
  useEffect(() => { setSiOr0(sioR0) }, [sioR0])

  // Sync slider temperature to effective temp when not cooling
  useEffect(() => {
    tempRef.current = tempC
    if (!coolingRef.current) effectiveTempRef.current = tempC
  }, [tempC])

  useEffect(() => { speedRef.current = simSpeed }, [simSpeed])
  useEffect(() => { coolingRef.current = coolingMode }, [coolingMode])

  // Recompute crystallization params when composition changes
  useEffect(() => {
    crystParamsRef.current = getCrystParams(sio2Pct, na2oPct, caoPct)
  }, [sio2Pct, na2oPct, caoPct])

  // Rebuild physics when composition changes
  useEffect(() => {
    physRef.current = initPhysics(cellData)
    frameAccRef.current = 0
  }, [cellData])  // eslint-disable-line react-hooks/exhaustive-deps

  // RAF loop
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    function frame() {
      const cm = coolingRef.current

      // ── Detect cooling mode change and reset ramp state ──────────
      if (cm !== prevCoolingRef.current) {
        if (cm === 'fast' || cm === 'slow') {
          coolingStartTempRef.current = effectiveTempRef.current
          coolingFrameRef.current     = 0
        }
        prevCoolingRef.current = cm
      }

      // ── Compute effective temperature for this frame ──────────────
      let T
      if (cm === 'fast' || cm === 'slow') {
        coolingFrameRef.current++
        const dur = cm === 'fast' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)
        T = coolingStartTempRef.current * (1 - t) + 20 * t
        effectiveTempRef.current = T
      } else {
        T = tempRef.current
        effectiveTempRef.current = T
      }

      // Propagate effective temperature to parent display (throttled to every 6 frames)
      if (onTempUpdateRef.current && (cm === 'fast' || cm === 'slow') &&
          coolingFrameRef.current % 6 === 0) {
        onTempUpdateRef.current(Math.round(T))
      }

      const phys = physRef.current
      if (phys) {
        const speed = speedRef.current
        let lerpT   = 1

        // Physics step(s) — always use Berendsen thermostat (coolingFactor = 1.0)
        if (speed >= 1) {
          const steps = Math.floor(speed)
          for (let s = 0; s < steps; s++) {
            for (const p of phys.particles) { p.px = p.x; p.py = p.y }
            stepPhysics(phys, T, 1.0, attractKRef.current)
          }
          frameAccRef.current = 0
        } else {
          frameAccRef.current += speed
          if (frameAccRef.current >= 1) {
            frameAccRef.current -= 1
            for (const p of phys.particles) { p.px = p.x; p.py = p.y }
            stepPhysics(phys, T, 1.0, attractKRef.current)
          }
          lerpT = frameAccRef.current
        }

        // ── Crystallization nudge (slow cool only) ────────────────
        if (cm === 'slow') {
          const cp = crystParamsRef.current
          if (T < cp.threshold && coolingFrameRef.current % CRYST_INTERVAL === 0) {
            crystallize(phys, cp.strength, cp.minCluster, cp.angleTol)
          }
        }

        drawPhysics(canvasRef.current, phys, VW, VH, lerpT)
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      {/* SVG — legend strip only */}
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
      >
        <rect width={VW} height={VH} fill="#1a1a1a" />
        <g transform={`translate(10, ${VH_GRID + 7})`}>
          <LegendDot cx={6}   cy={0} r={4}   fill={C.Si} label="Si" />
          <LegendDot cx={44}  cy={0} r={5}   fill={C.Ca} label="Ca²⁺" />
          <LegendDot cx={96}  cy={0} r={4}   fill={C.Na} label="Na⁺" />
          <LegendDot cx={140} cy={0} r={2.5} fill={C.O}  label="O²⁻" />
        </g>
      </svg>

      {/* Physics canvas — always on top */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
