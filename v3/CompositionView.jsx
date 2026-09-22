import { useMemo, useRef, useEffect } from 'react'
import { initPhysics, stepPhysics, crystallize, setSiOr0,
         computeAmorphousTargets, computeSlowCoolTargets, initPrecompute, stepPrecompute,
         rebuildBonds, computeKE, computeBondedKE, computePE, ENERGY_UNIT, THERMAL_SPEED,
         buildRigidBondMap } from './meltPhysics.js'
import { drawScene } from './renderer.js'

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

const GRAIN_MARGIN = 2

// Cooling durations in RAF frames (≈60 fps)
const FAST_COOL_FRAMES = 270   // ~4.5 s wall-clock
const SLOW_COOL_FRAMES = 1080  // ~18 s wall-clock
const CRYST_INTERVAL   = 10    // frames between crystallization checks during slow cool

// Composition-dependent crystallization parameters.
// threshold: °C below which the check starts
// minCluster: minimum connected hex-environment Si atoms to trigger nudge
// strength: fraction of displacement corrected per check (0 → 1)
// angleTol: degrees tolerance on each 120° gap in the Si-O ring
function countBonds(phys) {
  if (!phys?.rigidBonds || !phys?.particles) return null
  const r = { sio: { intact: 0, total: 0 }, nao: { intact: 0, total: 0 }, cao: { intact: 0, total: 0 } }
  for (const b of phys.rigidBonds) {
    const ti = phys.particles[b.i].typeId, tj = phys.particles[b.j].typeId
    let cat
    if (!b.breakable)              cat = 'sio'
    else if (ti === 2 || tj === 2) cat = 'nao'
    else if (ti === 3 || tj === 3) cat = 'cao'
    else continue
    r[cat].total++
    if (!b.broken) r[cat].intact++
  }
  return r
}

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
  const si  = buildHexLayer(siA,  'SiO2', types, 'Si', 3.5)
  const na  = buildSquareLayer(NA_A, 'Na2O', types, 'Na', 4)
  const ca  = buildSquareLayer(CA_A, 'CaO',  types, 'Ca', 5)
  return [...si.cats, ...na.cats, ...ca.cats, ...si.oAtoms, ...na.oAtoms, ...ca.oAtoms]
}

// ── Graph drawing helpers ─────────────────────────────────────────────────────
function setupCanvas(canvas) {
  if (!canvas || !canvas.clientWidth) return null
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth, h = canvas.clientHeight
  const cw = Math.round(w * dpr), ch = Math.round(h * dpr)
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

function drawTEGraph(canvas, hist) {
  const s = setupCanvas(canvas)
  if (!s) return
  const { ctx, w, h } = s
  const pL = 34, pR = 8, pT = 6, pB = 18
  const pw = w - pL - pR, ph = h - pT - pB

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(8,6,4,0.82)'
  ctx.fillRect(0, 0, w, h)

  // Axes
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pL, pT); ctx.lineTo(pL, pT + ph)
  ctx.lineTo(pL + pw, pT + ph)
  ctx.stroke()

  // Axis labels
  ctx.fillStyle = '#555'; ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.fillText('2000', pL - 2, pT)
  ctx.fillText('0', pL - 2, pT + ph)
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText('0', pL, pT + ph + 2)
  ctx.fillText('2000', pL + pw, pT + ph + 2)
  ctx.fillText('Energy →', pL + pw / 2, pT + ph + 2)
  ctx.save(); ctx.translate(9, pT + ph / 2); ctx.rotate(-Math.PI / 2)
  ctx.fillText('Temp °C', 0, 0)
  ctx.restore()

  // Zone markers — horizontal lines at bond-break temperatures on the T (y) axis
  const zones = [
    { t: 650,  label: 'Na-O start', color: '#5588aa' },
    { t: 1130, label: 'Na-O gone',  color: '#4477aa' },
    { t: 1700, label: 'Si-O start', color: '#aa7755' },
  ]
  ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
  for (const z of zones) {
    const zy = pT + ph - (z.t / 2000) * ph
    if (zy < pT || zy > pT + ph) continue
    ctx.strokeStyle = z.color; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(pL, zy); ctx.lineTo(pL + pw, zy); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = z.color
    ctx.fillText(z.label, pL + 2, zy - 1)
  }

  const n = hist.length
  if (n < 2) return

  ctx.strokeStyle = '#c07040'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = pL + (hist[i].e / 2000) * pw
    const y = pT + ph - (Math.max(0, hist[i].t) / 2000) * ph
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Current point dot
  const last = hist[n - 1]
  const lx = pL + (last.e / 2000) * pw
  const ly = pT + ph - (Math.max(0, last.t) / 2000) * ph
  ctx.fillStyle = '#ffaa60'; ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill()
}

function drawBarGraph(canvas, ke, pe, n) {
  const s = setupCanvas(canvas)
  if (!s || !n) return
  const { ctx, w, h } = s
  const pL = 8, pR = 8, pT = 6, pB = 18
  const pw = w - pL - pR, ph = h - pT - pB

  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, w, h)

  // Scale bars to per-particle energy, max = (2000+273)*ENERGY_UNIT
  const E_MAX = (2000 + 273) * ENERGY_UNIT
  const keP = ke / n, peP = pe / n
  const barW = pw / 2 - 4

  const keH = Math.min(ph, (keP / E_MAX) * ph)
  const peH = Math.min(ph, (peP / E_MAX) * ph)

  // KE bar (left)
  ctx.fillStyle = '#c06030'
  ctx.fillRect(pL, pT + ph - keH, barW, keH)
  // PE bar (right)
  ctx.fillStyle = '#4060c0'
  ctx.fillRect(pL + barW + 8, pT + ph - peH, barW, peH)

  // Baseline
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(pL, pT + ph); ctx.lineTo(pL + pw, pT + ph); ctx.stroke()

  // Labels
  ctx.fillStyle = '#888'; ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText('KE', pL + barW / 2, pT + ph + 2)
  ctx.fillText('PE', pL + barW + 8 + barW / 2, pT + ph + 2)

  // Values
  ctx.fillStyle = '#aaa'; ctx.textBaseline = 'bottom'
  if (keH > 12) ctx.fillText((keP * 1e4).toFixed(1), pL + barW / 2, pT + ph - keH - 1)
  if (peH > 12) ctx.fillText((peP * 1e4).toFixed(1), pL + barW + 8 + barW / 2, pT + ph - peH - 1)
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

export default function CompositionView({ sio2Pct, na2oPct, caoPct, sioR0 = 9, attractK = 0, debug = false, bondNums = false, precompute = false, meltTemp = 700, simSpeed = 1, coolingMode = null, onTempUpdate = null, onEnergyUpdate = null, onBondCounts = null, replayFrame = null, onReplayReady = null, showGraphs = false, darkMode = true, showCharge = false, showField = true }) {
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
  const canvasRef           = useRef(null)
  const graphTERef          = useRef(null)   // T-vs-E history graph canvas
  const graphBarRef         = useRef(null)   // KE/PE bar chart canvas
  const physRef             = useRef(null)
  const rafRef              = useRef(null)
  const energyValRef        = useRef(meltTemp)
  const speedRef            = useRef(simSpeed)
  const coolingRef          = useRef(coolingMode)
  const showGraphsRef       = useRef(showGraphs)
  const frameAccRef         = useRef(0)
  const smoothTempRef       = useRef(25)  // EMA of derivedTempC for stable readout
  // Cooling/heating state (energy-based)
  const effectiveERef       = useRef((meltTemp + 273) * ENERGY_UNIT)  // ePerParticle during ramp
  const prevCoolingRef      = useRef(null)
  const coolingStartERef    = useRef((meltTemp + 273) * ENERGY_UNIT)
  const coolingFrameRef     = useRef(0)
  const crystParamsRef      = useRef(getCrystParams(sio2Pct, na2oPct, caoPct))
  const onTempUpdateRef     = useRef(onTempUpdate)
  const onEnergyUpdateRef   = useRef(onEnergyUpdate)
  const attractKRef         = useRef(attractK)
  const debugRef            = useRef(debug)
  const bondNumsRef         = useRef(bondNums)
  const precomputeRef       = useRef(precompute)
  const darkModeRef         = useRef(darkMode)
  const showChargeRef       = useRef(showCharge)
  const showFieldRef        = useRef(showField)
  const replayFrameRef      = useRef(replayFrame)
  const onReplayReadyRef    = useRef(onReplayReady)
  const replayBufferRef     = useRef([])
  const replayNotifiedRef   = useRef(false)
  const onBondCountsRef     = useRef(onBondCounts)
  const lastBondCountTsRef  = useRef(0)
  // Graph history — grows forever, never wraps
  const histRef             = useRef([])   // {e, t}[]
  const histFrameRef        = useRef(0)    // throttle: record every 3 frames

  useEffect(() => { onTempUpdateRef.current = onTempUpdate }, [onTempUpdate])
  useEffect(() => { onEnergyUpdateRef.current = onEnergyUpdate }, [onEnergyUpdate])
  useEffect(() => { attractKRef.current = attractK }, [attractK])
  useEffect(() => { debugRef.current = debug }, [debug])
  useEffect(() => { bondNumsRef.current = bondNums }, [bondNums])
  useEffect(() => { precomputeRef.current = precompute }, [precompute])
  useEffect(() => { darkModeRef.current = darkMode }, [darkMode])
  useEffect(() => { showChargeRef.current = showCharge }, [showCharge])
  useEffect(() => { showFieldRef.current = showField }, [showField])
  useEffect(() => { replayFrameRef.current = replayFrame }, [replayFrame])
  useEffect(() => { onReplayReadyRef.current = onReplayReady }, [onReplayReady])
  useEffect(() => { onBondCountsRef.current = onBondCounts }, [onBondCounts])
  useEffect(() => { showGraphsRef.current = showGraphs }, [showGraphs])

  // Keep the physics module's Si-O r0 in sync with the slider
  useEffect(() => { setSiOr0(sioR0) }, [sioR0])

  // Sync energy target ref when not cooling
  useEffect(() => {
    energyValRef.current = meltTemp
    const ePerParticle = (meltTemp + 273) * ENERGY_UNIT
    if (!coolingRef.current) effectiveERef.current = ePerParticle
  }, [meltTemp])

  useEffect(() => { speedRef.current = simSpeed }, [simSpeed])
  useEffect(() => { coolingRef.current = coolingMode }, [coolingMode])

  // Recompute crystallization params when composition changes
  useEffect(() => {
    crystParamsRef.current = getCrystParams(sio2Pct, na2oPct, caoPct)
  }, [sio2Pct, na2oPct, caoPct])

  // Rebuild physics when composition changes
  useEffect(() => {
    physRef.current = initPhysics(cellData)
    // A handful of near-zero-temperature steps let spring forces seat atoms at r0
    // after the dead-zone snap in initPhysics. 5 steps is enough; initPhysics
    // already handles overlap resolution so we don't need many here.
    const eSettle = 1 * ENERGY_UNIT
    for (let s = 0; s < 5; s++) stepPhysics(physRef.current, eSettle)
    buildRigidBondMap(physRef.current)
    // Warm particles to the current target so the visual doesn't start cold
    const eWarm = (energyValRef.current + 273) * ENERGY_UNIT
    for (let s = 0; s < 20; s++) stepPhysics(physRef.current, eWarm)
    smoothTempRef.current = energyValRef.current  // seed EMA at known target (25°C)
    frameAccRef.current = 0

    window.meltDebug = () => {
      const phys = physRef.current
      if (!phys) return console.log('no physics state')
      const d = phys.dbg || {}
      console.log('── melt debug ──────────────────────────────')
      console.table({
        totalEnergy:   d.totalEnergy   ?? '?',
        derivedTempC:  d.derivedTempC  ?? '?',
        hasBeenMelted: d.hasBeenMelted ?? '?',
        anchorStr:     d.anchorStr     ?? '?',
        wanderLimit:   d.wanderLimit   ?? '?',
      })
      if (d.bonds) {
        const rows = {}
        for (const [key, s] of Object.entries(d.bonds)) {
          rows[key] = {
            total: s.total,
            broken: s.broken,
            'broken%': Math.round(s.broken / s.total * 100),
            breakStart: s.breakStart,
            breakFull: s.breakFull,
          }
        }
        console.table(rows)
      }
    }
  }, [cellData])  // eslint-disable-line react-hooks/exhaustive-deps

  // RAF loop
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    function frame(ts) {
      const cm = coolingRef.current

      // ── Detect ramp mode change ───────────────────────────────────
      if (cm !== prevCoolingRef.current) {
        if (cm === 'fast' || cm === 'slow' || cm === 'fastHeat' || cm === 'slowHeat') {
          coolingStartERef.current  = effectiveERef.current
          coolingFrameRef.current   = 0
          replayBufferRef.current   = []
          replayNotifiedRef.current = false
          histRef.current = []  // clear T-vs-E history on new ramp
          if (precomputeRef.current && physRef.current && (cm === 'fast' || cm === 'slow')) {
            const targets = cm === 'slow'
              ? computeSlowCoolTargets(physRef.current, sio2Pct)
              : computeAmorphousTargets(physRef.current)
            initPrecompute(physRef.current, targets)
          }
        } else {
          if (physRef.current) delete physRef.current.precompute
          if (!replayNotifiedRef.current && replayBufferRef.current.length > 0) {
            replayNotifiedRef.current = true
            onReplayReadyRef.current?.(replayBufferRef.current.length)
          }
        }
        prevCoolingRef.current = cm
      }

      // ── Compute energy target for this frame ──────────────────────
      // All ramps are energy-based: ePerParticle = (sliderVal+273)*ENERGY_UNIT
      const E_COOL_END = (200  + 273) * ENERGY_UNIT
      const E_HEAT_END = (1500 + 273) * ENERGY_UNIT
      let ePerParticle
      const isRamping = cm === 'fast' || cm === 'slow' || cm === 'fastHeat' || cm === 'slowHeat'
      if (cm === 'fast' || cm === 'slow') {
        coolingFrameRef.current++
        const dur = cm === 'fast' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)
        ePerParticle = coolingStartERef.current * (1 - t) + E_COOL_END * t
        effectiveERef.current = ePerParticle
      } else if (cm === 'fastHeat' || cm === 'slowHeat') {
        coolingFrameRef.current++
        const dur = cm === 'fastHeat' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)
        ePerParticle = coolingStartERef.current * (1 - t) + E_HEAT_END * t
        effectiveERef.current = ePerParticle
      } else {
        ePerParticle = (energyValRef.current + 273) * ENERGY_UNIT   // energyValRef tracks meltTemp
        effectiveERef.current = ePerParticle
      }

      // Propagate slider-equivalent energy value to parent (throttled, every 6 frames)
      if (onTempUpdateRef.current && isRamping && coolingFrameRef.current % 6 === 0) {
        // Convert back to slider-equivalent so GlassViewer can sync the slider
        onTempUpdateRef.current(Math.round(ePerParticle / ENERGY_UNIT - 273))
      }

      const phys = physRef.current
      if (phys) {
        const rf = replayFrameRef.current

        // ── Replay mode ───────────────────────────────────────────────
        if (rf !== null && replayBufferRef.current[rf]) {
          const snap = replayBufferRef.current[rf]
          const ps   = phys.particles
          for (let i = 0; i < ps.length; i++) {
            ps[i].px = snap[i * 2]; ps[i].x = snap[i * 2]
            ps[i].py = snap[i * 2 + 1]; ps[i].y = snap[i * 2 + 1]
          }
          rebuildBonds(phys)
          drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, showField: showFieldRef.current })
          rafRef.current = requestAnimationFrame(frame)
          return
        }

        const usePrecompute = precomputeRef.current && !!phys.precompute && (cm === 'fast' || cm === 'slow')

        if (usePrecompute) {
          const lerpRate = cm === 'fast' ? 0.04 : 0.02
          stepPrecompute(phys, coolingFrameRef.current, lerpRate)
          drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, showField: showFieldRef.current })
        } else {
          const speed = speedRef.current

          if (speed >= 1) {
            const steps = Math.floor(speed)
            for (let s = 0; s < steps; s++) {
              for (const p of phys.particles) { p.px = p.x; p.py = p.y }
              stepPhysics(phys, ePerParticle, 1.0, attractKRef.current, cm)
            }
            frameAccRef.current = 0
          } else {
            frameAccRef.current += speed
            if (frameAccRef.current >= 1) {
              frameAccRef.current -= 1
              for (const p of phys.particles) { p.px = p.x; p.py = p.y }
              stepPhysics(phys, ePerParticle, 1.0, attractKRef.current, cm)
            }
          }

          // Crystallization nudge (slow cool only, temperature-gated via derived T inside stepPhysics)
          if (cm === 'slow') {
            const cp = crystParamsRef.current
            // Derive temp from current KE for the crystallize gate
            const ke = computeKE(phys)
            const derivedT = ke / (phys.n * ENERGY_UNIT) - 273
            if (derivedT < cp.threshold && coolingFrameRef.current % CRYST_INTERVAL === 0) {
              crystallize(phys, cp.strength, cp.minCluster, cp.angleTol)
            }
          }

          drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, showField: showFieldRef.current })
        }

        // ── KE / PE diagnostics + graph history ──────────────────────
        const ke = computeKE(phys)
        const pe = computePE(phys) + (phys.bondBreakPE ?? 0)
        // latticeTemp = keTarget/ENERGY_UNIT-273: thermostat's intended temperature,
        // free of wander-clamp KE corruption. Drops below totalEnergy when PE rises.
        const rawTempC = Math.max(0, phys.latticeTemp ?? (ePerParticle / ENERGY_UNIT - 273))
        smoothTempRef.current = smoothTempRef.current * 0.92 + rawTempC * 0.08
        const derivedTempC = Math.round(smoothTempRef.current)
        onEnergyUpdateRef.current?.(ke, pe, derivedTempC)

        // Record into ring buffer (every 3 frames to avoid redundancy)
        histFrameRef.current++
        if (histFrameRef.current >= 3) {
          histFrameRef.current = 0
          // X = energy above initial state (25°C baseline), so page-load dot is at far left (0)
          const sliderEquiv = Math.max(0, Math.min(2000, ePerParticle / ENERGY_UNIT - 298))
          histRef.current.push({ e: sliderEquiv, t: Math.max(-273, derivedTempC) })
        }

        // ── Draw energy graphs ────────────────────────────────────────
        if (showGraphsRef.current) {
          drawTEGraph(graphTERef.current, histRef.current)
          drawBarGraph(graphBarRef.current, ke, pe, phys.n)
        }

        // ── Record replay snapshot ────────────────────────────────────
        if (isRamping) {
          const ps   = phys.particles
          const snap = new Float32Array(ps.length * 2)
          for (let i = 0; i < ps.length; i++) { snap[i * 2] = ps[i].x; snap[i * 2 + 1] = ps[i].y }
          replayBufferRef.current.push(snap)

          if (!replayNotifiedRef.current) {
            const dur = (cm === 'fast' || cm === 'fastHeat') ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
            if (coolingFrameRef.current >= dur) {
              replayNotifiedRef.current = true
              onReplayReadyRef.current?.(replayBufferRef.current.length)
            }
          }
        }

        // Bond counts (throttled to ~3×/s)
        if (onBondCountsRef.current && phys.rigidBonds && ts - lastBondCountTsRef.current > 300) {
          lastBondCountTsRef.current = ts
          onBondCountsRef.current(countBonds(phys))
        }
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Main sim area — canvas fills 100%, graph overlaid at bottom edge when active */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
        {showGraphs && (
          <canvas ref={graphTERef}
            style={{
              position: 'absolute', bottom: 0, left: 0,
              width: '100%', height: '34%',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  )
}
