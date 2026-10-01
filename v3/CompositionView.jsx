import { useMemo, useRef, useEffect } from 'react'
import { initPhysics, stepPhysics, setSiOr0,
         rebuildBonds, computeKE, computeBondedKE, computePE, ENERGY_UNIT, THERMAL_SPEED,
         buildRigidBondMap, setSioExclMult, setBreakStrain, setReformStrain, setCrystAnchorK, setLiberateFrac, setSioK, setNaOK,
         setNaAnchorK, setNaLiberateFrac, setNaBreakStrain, setLatticeSpeedMult, setFreedSpeedMult,
         resetLibStats, getLibStats, measureStrain95, meltStructure, setUseEmaStrain } from './meltPhysics.js'
import { drawScene, setVisualScale, findAtomNear, getVisualScale, getLastHudLines } from './renderer.js'

const VW      = 600
const VH_GRID = 350
const VH      = VH_GRID + 22   // + legend strip
const COLS    = 5
const ROWS    = 4
const CELL_W  = VW / COLS       // 120
const CELL_H  = VH_GRID / ROWS  // 87.5

// SI_A is derived from sioR0 at call time (SI_A = 2 * sioR0)
const NA_A = 24   // Na-O bond: O at midpoints = 12px = r0_NaO
const CA_A = 24   // Ca-O bond: O at midpoints = 12px = r0_CaO

const GRAIN_MARGIN = 5

// Cooling durations in RAF frames (≈60 fps)
const FAST_COOL_FRAMES = 270   // ~4.5 s wall-clock
const SLOW_COOL_FRAMES = 1440  // ~24 s wall-clock


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
  declumpGrid(types, rand)
  return types
}

// Count orthogonally-adjacent cell pairs that share a grain type.
function likeAdjacency(types) {
  let c = 0
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const t = types[r * COLS + col]
      if (col + 1 < COLS && types[r * COLS + col + 1] === t) c++
      if (r + 1 < ROWS && types[(r + 1) * COLS + col] === t) c++
    }
  }
  return c
}

// Up to 3 SiO2↔Na2O swaps, each the one that most reduces like-type adjacency.
// Ties broken by the seeded rand so the layout is stable per composition.
function declumpGrid(types, rand, maxSwaps = 3) {
  for (let s = 0; s < maxSwaps; s++) {
    const base = likeAdjacency(types)
    let best = 0, bestPairs = []
    for (let a = 0; a < types.length; a++) {
      if (types[a] !== 'SiO2') continue
      for (let b = 0; b < types.length; b++) {
        if (types[b] !== 'Na2O') continue
        types[a] = 'Na2O'; types[b] = 'SiO2'
        const gain = base - likeAdjacency(types)
        types[a] = 'SiO2'; types[b] = 'Na2O'
        if (gain > best) { best = gain; bestPairs = [[a, b]] }
        else if (gain === best && gain > 0) bestPairs.push([a, b])
      }
    }
    if (best <= 0) break
    const [a, b] = bestPairs[Math.floor(rand() * bestPairs.length)]
    types[a] = 'Na2O'; types[b] = 'SiO2'
  }
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
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.3, chunkIdx: row * COLS + col })
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
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.3, chunkIdx: row * COLS + col })
    }
  }
  return { cats, oAtoms }
}

function buildAllAtoms(types, sioR0) {
  const siA = 2 * sioR0   // Si-Si spacing so O midpoints land at exactly sioR0 from Si
  const si  = buildHexLayer(siA,  'SiO2', types, 'Si', 3.2)
  const na  = buildSquareLayer(NA_A, 'Na2O', types, 'Na', 3.6)
  const ca  = buildSquareLayer(CA_A, 'CaO',  types, 'Ca', 4.5)
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

function fmtE(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v)
}

// x-axis = thermal energy CONTENT at temperature T: ∫₀ᵀ hc(T)·dT, in per-particle units.
// Mirrors meltHeatCapacity in GlassViewer (ramp 500→750 to a Na₂O-scaled plateau).
const HC_LO = 500, HC_HI = 750
function heatCap(T, na2oPct, plateau) {
  const amp = (plateau - 1) * Math.min(1, na2oPct / 30)
  if (amp <= 0 || T <= HC_LO) return 1
  const t = Math.min(1, (T - HC_LO) / (HC_HI - HC_LO))
  return 1 + amp * t * t * (3 - 2 * t)
}
function energyContent(T, na2oPct, plateau) {   // per-particle units
  let c = 0
  for (let x = 5; x <= T; x += 5) c += heatCap(x, na2oPct, plateau) * 5
  return c * ENERGY_UNIT
}
// Inverse: temperature whose content equals `target`. Lets ramps interpolate linearly in
// ENERGY (content) instead of temperature, so the kJ readout changes at a constant rate
// through the latent-heat plateau — independent of temperature or bonds breaking.
function tempForContent(target, na2oPct, plateau) {
  if (target <= 0) return 0
  let c = 0
  for (let x = 5; x <= 2000; x += 5) { c += heatCap(x, na2oPct, plateau) * 5 * ENERGY_UNIT; if (c >= target) return x }
  return 2000
}
// Ramp ePerParticle so that energy CONTENT moves linearly from the start temp to endTemp.
function rampEnergyLinearInContent(startE, endTemp, t, na2oPct, plateau) {
  const Tstart = startE / ENERGY_UNIT - 273
  const cStart = energyContent(Math.max(0, Tstart), na2oPct, plateau)
  const cEnd   = energyContent(endTemp, na2oPct, plateau)
  const T = tempForContent(cStart * (1 - t) + cEnd * t, na2oPct, plateau)
  return (T + 273) * ENERGY_UNIT
}
const GRAPH_E_MIN = 0
function drawTEGraph(canvas, hist, darkMode = true, eMax = 4e-3) {
  const s = setupCanvas(canvas)
  if (!s) return
  const { ctx, w, h } = s
  const pL = 46, pR = 10, pT = 10, pB = 30
  const pw = w - pL - pR, ph = h - pT - pB

  const tMax = 1800
  const ink     = darkMode ? '#999' : '#666'   // matches sidebar 'Energy in fields' label
  const axisCol = darkMode ? '#888' : '#999'

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = darkMode ? 'rgba(8,6,4,0.82)' : 'rgba(224,219,210,0.95)'   // off-white, matches viz-panel
  ctx.fillRect(0, 0, w, h)

  // Axes
  ctx.strokeStyle = axisCol; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pL, pT); ctx.lineTo(pL, pT + ph)
  ctx.lineTo(pL + pw, pT + ph)
  ctx.stroke()

  // Axis labels (2× size, high contrast)
  ctx.fillStyle = ink; ctx.font = "bold 14px Lexend, system-ui, sans-serif"; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  ctx.fillText(String(tMax), pL - 4, pT + 2)
  ctx.fillText('0', pL - 4, pT + ph)
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText('energy added / particle', pL + pw / 2, h - 4)
  ctx.save(); ctx.translate(14, pT + ph / 2); ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('Temp °C', 0, 0)
  ctx.restore()

  const n = hist.length
  if (n < 2) return

  ctx.strokeStyle = darkMode ? '#ff9050' : '#c04000'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = pL + Math.max(0, Math.min(1, (hist[i].e - GRAPH_E_MIN) / (eMax - GRAPH_E_MIN))) * pw
    const y = pT + ph - (Math.max(0, hist[i].t) / tMax) * ph
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Current point dot
  const last = hist[n - 1]
  const lx = pL + Math.max(0, Math.min(1, (last.e - GRAPH_E_MIN) / (eMax - GRAPH_E_MIN))) * pw
  const ly = pT + ph - (Math.max(0, last.t) / tMax) * ph
  ctx.fillStyle = darkMode ? '#ffcc80' : '#e05500'; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill()
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

function countBonds(phys) {
  const counts = { sio: { intact: 0, total: 0 }, nao: { intact: 0, total: 0 }, cao: { intact: 0, total: 0 } }
  if (!phys?.rigidBonds || !phys?.particles) return counts
  const ps = phys.particles
  for (const rb of phys.rigidBonds) {
    const ti = ps[rb.i].typeId, tj = ps[rb.j].typeId
    const key = rb.isSiO ? 'sio' : ((ti === 2 || tj === 2) ? 'nao' : ((ti === 3 || tj === 3) ? 'cao' : null))
    if (!key) continue
    counts[key].total++
    if (!rb.broken) counts[key].intact++
  }
  return counts
}

export default function CompositionView({ sio2Pct, na2oPct, caoPct, sioR0 = 9, attractK = 0, attractFalloff = 1, debug = false, bondNums = false, meltTemp = 50, simSpeed = 1, speedMult = 1, coolingMode = null, onTempUpdate = null, onEnergyUpdate = null, onBondCounts = null, replayFrame = null, onReplayReady = null, graphCanvasRef = null, cumulativeEnergyRef = null, graphXMaxRef = null, darkMode = true, showCharge = false, showField = true, atomColorMode = 'normal', showBrokenBonds = false, showLiveStats = false, useEmaStrain = true, hcPlateau = 4 }) {
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
  const graphBarRef         = useRef(null)   // KE/PE bar chart canvas (unused)
  const physRef             = useRef(null)
  const rafRef              = useRef(null)
  const energyValRef        = useRef(meltTemp)
  const speedRef            = useRef(simSpeed)
  const coolingRef          = useRef(coolingMode)
  const graphCanvasRefRef        = useRef(graphCanvasRef)
  const cumulativeEnergyRefRef   = useRef(cumulativeEnergyRef)
  const na2oPctRef               = useRef(na2oPct)
  const hcPlateauRef             = useRef(4)
  const graphXMaxRefRef          = useRef(graphXMaxRef)
  const frameAccRef         = useRef(0)
  const stepCallCountRef    = useRef(0)   // diagnostic: total stepPhysics calls
  const diagDoneRef         = useRef(false)  // diagnostic: first-10-calls log emitted
  const smoothTempRef       = useRef(25)  // EMA of derivedTempC for stable readout
  // Cooling/heating state (energy-based)
  const effectiveERef       = useRef((meltTemp + 273) * ENERGY_UNIT)  // ePerParticle during ramp
  const prevCoolingRef      = useRef(null)
  const coolingStartERef    = useRef((meltTemp + 273) * ENERGY_UNIT)
  const coolingFrameRef     = useRef(0)
  const onTempUpdateRef     = useRef(onTempUpdate)
  const onEnergyUpdateRef   = useRef(onEnergyUpdate)
  const attractKRef         = useRef(attractK)
  const attractFalloffRef   = useRef(attractFalloff)
  const speedMultRef        = useRef(speedMult)
  const debugRef            = useRef(debug)
  const bondNumsRef         = useRef(bondNums)
  const darkModeRef         = useRef(darkMode)
  const showChargeRef       = useRef(showCharge)
  const showFieldRef        = useRef(showField)
  const atomColorModeRef    = useRef(atomColorMode)
  const showBrokenBondsRef  = useRef(showBrokenBonds)
  const showLiveStatsRef    = useRef(showLiveStats)
  const hoverIdxRef         = useRef(null)
  const lastHoverIdxRef     = useRef(null)
  const selectedIdxRef      = useRef(-1)
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
  useEffect(() => { attractFalloffRef.current = attractFalloff }, [attractFalloff])
  useEffect(() => { speedMultRef.current = speedMult }, [speedMult])
  useEffect(() => { debugRef.current = debug }, [debug])
  useEffect(() => { bondNumsRef.current = bondNums }, [bondNums])
  useEffect(() => { darkModeRef.current = darkMode }, [darkMode])
  useEffect(() => { showChargeRef.current = showCharge }, [showCharge])
  useEffect(() => { showFieldRef.current = showField }, [showField])
  useEffect(() => { atomColorModeRef.current = atomColorMode }, [atomColorMode])
  useEffect(() => { showBrokenBondsRef.current = showBrokenBonds }, [showBrokenBonds])
  useEffect(() => { showLiveStatsRef.current = showLiveStats }, [showLiveStats])
  useEffect(() => { setUseEmaStrain(useEmaStrain) }, [useEmaStrain])
  useEffect(() => { replayFrameRef.current = replayFrame }, [replayFrame])
  useEffect(() => { onReplayReadyRef.current = onReplayReady }, [onReplayReady])
  useEffect(() => { onBondCountsRef.current = onBondCounts }, [onBondCounts])
  useEffect(() => { graphCanvasRefRef.current = graphCanvasRef }, [graphCanvasRef])
  useEffect(() => { cumulativeEnergyRefRef.current = cumulativeEnergyRef }, [cumulativeEnergyRef])
  useEffect(() => { na2oPctRef.current = na2oPct }, [na2oPct])
  useEffect(() => { hcPlateauRef.current = hcPlateau }, [hcPlateau])
  useEffect(() => { graphXMaxRefRef.current = graphXMaxRef }, [graphXMaxRef])

  // Hover highlight: mousemove tracks nearest atom for the white ring in renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const toPhys = e => {
      const rect  = canvas.getBoundingClientRect()
      const dpr   = window.devicePixelRatio || 1
      const W     = canvas.clientWidth, H = canvas.clientHeight
      const scale = Math.min(W / 600, H / 350) * dpr
      const offX  = (W * dpr - 600 * scale) / 2
      const offY  = (H * dpr - 350 * scale) / 2
      return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, scale, offX, offY]
    }
    const onMove = e => {
      const phys = physRef.current
      if (!phys) return
      const [cx, cy, scale, offX, offY] = toPhys(e)
      hoverIdxRef.current = findAtomNear(phys, (cx - offX) / scale, (cy - offY) / scale, getVisualScale())
    }
    const onClick = e => {
      const phys = physRef.current
      if (!phys) return
      const [cx, cy, scale, offX, offY] = toPhys(e)
      const idx = findAtomNear(phys, (cx - offX) / scale, (cy - offY) / scale, getVisualScale())
      if (idx < 0) return
      selectedIdxRef.current = selectedIdxRef.current === idx ? -1 : idx
      const p    = phys.particles[idx]
      const lf   = phys.latticeFreed?.[idx] ?? 0
      const ic   = phys.intactCount?.[idx]  ?? 0
      const orig = phys.originalBondCount?.[idx] ?? '?'
      const spd  = Math.hypot(p.vx, p.vy).toExponential(3)
      const dist = Math.hypot(p.x - p.x0, p.y - p.y0).toFixed(1)
      let bc = 0
      for (const b of (phys.bonds ?? [])) { if (b.i === idx || b.j === idx) bc++ }
      const tgt  = [3, 2, 1, 2][p.typeId] ?? 2
      const elig = bc < tgt ? 'attract-eligible' : 'NOT attract-eligible'
      const bondInfo = (phys.bonds ?? [])
        .filter(b => b.i === idx || b.j === idx)
        .map(b => {
          const other = b.i === idx ? b.j : b.i
          const po    = phys.particles[other]
          const d     = Math.hypot(p.x - po.x, p.y - po.y).toFixed(1)
          const rigid = b.currentBreakStrain !== undefined
          const state = !rigid ? 'soft' : b.broken ? 'BRK' : 'ok'
          const strain = rigid && b.strain != null ? b.strain.toFixed(3) : '—'
          return `  → ${po.type}#${other}  d=${d}px  ${state}  strain=${strain}`
        })
      console.log(
        `[click] atom #${idx} ${p.type} (${p.cellType})\n` +
        `  latticeFreed: ${lf}\n` +
        `  intactCount: ${ic}  (originalBondCount: ${orig})\n` +
        `  bondCount(attract): ${bc}  COORD_TARGET: ${tgt}  → ${elig}\n` +
        `  dist from x0: ${dist}px  speed: ${spd} px/step\n` +
        `  bonds (phys.bonds):\n` + (bondInfo.length ? bondInfo.join('\n') : '  (none)')
      )
    }
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('click', onClick)
    return () => { canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('click', onClick) }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

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

  // Rebuild physics when composition changes
  useEffect(() => {
    physRef.current = initPhysics(cellData)
    physRef.current.sio2Pct = sio2Pct
    window._meltPhys = physRef.current
    window.measureStrain95 = () => measureStrain95(window._meltPhys)
    window.meltStructure   = () => meltStructure(window._meltPhys)
    // A handful of near-zero-temperature steps let spring forces seat atoms at r0
    // after the dead-zone snap in initPhysics. 5 steps is enough; initPhysics
    // already handles overlap resolution so we don't need many here.
    const eSettle = 1 * ENERGY_UNIT
    for (let s = 0; s < 5; s++) stepPhysics(physRef.current, eSettle)
    buildRigidBondMap(physRef.current)
    // Measurement-only bookkeeping arrays — no physics effect
    const _nb = physRef.current.rigidBonds.length
    physRef.current.everBroken      = new Uint8Array(_nb)
    physRef.current.wasIntact       = new Uint8Array(_nb).fill(1)
    physRef.current.currentIntact   = new Int32Array(_nb)
    physRef.current.lifetimeTotal   = new Float64Array(_nb)
    physRef.current.lifetimeBreaks  = new Int32Array(_nb)
    physRef.current.totalEnergyAdded = 0
    physRef.current.cumulativeKE    = 0
    // Per-cation intra-grain bond index list — for whole-unit (per-Si/Na/Ca) tracking.
    // A bond is intra-unit when both atoms share chunkIdx; inter-unit when they don't.
    const _pArr2 = physRef.current.particles
    const _rb2   = physRef.current.rigidBonds
    const _unitBonds = new Array(physRef.current.n).fill(null)
    for (let _bi = 0; _bi < _rb2.length; _bi++) {
      const { i: _i, j: _j } = _rb2[_bi]
      const _pi = _pArr2[_i], _pj = _pArr2[_j]
      if (_pi.typeId !== 1 && _pj.typeId === 1 && _pi.chunkIdx === _pj.chunkIdx) {
        if (!_unitBonds[_i]) _unitBonds[_i] = []
        _unitBonds[_i].push(_bi)
      }
      if (_pj.typeId !== 1 && _pi.typeId === 1 && _pi.chunkIdx === _pj.chunkIdx) {
        if (!_unitBonds[_j]) _unitBonds[_j] = []
        _unitBonds[_j].push(_bi)
      }
    }
    physRef.current.unitBonds = _unitBonds
    // Warm particles to the current target so the visual doesn't start cold
    const eWarm = (energyValRef.current + 273) * ENERGY_UNIT
    for (let s = 0; s < 20; s++) stepPhysics(physRef.current, eWarm)
    smoothTempRef.current = energyValRef.current  // seed EMA at known target (25°C)
    frameAccRef.current = 0
    histRef.current = []

    window.bondAudit = () => {
      const phys = physRef.current
      if (!phys) return console.log('no physics state')
      const p = phys.particles, lf = phys.latticeFreed
      const rows = phys.bonds
        .filter(b => lf?.[b.i] && lf?.[b.j])
        .map(b => {
          const r0s = Math.hypot(p[b.j].x0 - p[b.i].x0, p[b.j].y0 - p[b.i].y0)
          const actualD = Math.hypot(p[b.j].x - p[b.i].x, p[b.j].y - p[b.i].y)
          // Both atoms are freed (filter above guarantees this), so renderer uses bond.strain
          // directly — the r0s path is bypassed by the iFreed && jFreed guard in renderer.js.
          return {
            pair: `${p[b.i].type}-${p[b.j].type}`,
            r0s_orig: Math.round(r0s),
            actualD: Math.round(actualD),
            bondStrain: b.strain?.toFixed(3),
            renderedStrain: b.strain?.toFixed(3),
          }
        })
        .sort((a, b) => b.r0s_orig - a.r0s_orig)
      console.log(`── freed-pair bonds (${rows.length}) ──`)
      console.table(rows.slice(0, 20))
      console.log('renderedStrain = bondStrain for all rows (both-freed guard active in renderer)')
    }
    window.setMeltTemp    = (tempC) => { energyValRef.current = tempC }
    window.setSioExclMult = (v)    => setSioExclMult(v)
    window.setBreakStrain  = (v)   => setBreakStrain(v)
    window.setReformStrain = (v)   => setReformStrain(v)
    window.setCrystAnchorK = (v)   => setCrystAnchorK(v)
    window.setLiberateFrac = (v)   => setLiberateFrac(v)
    window.setSioK         = (v)   => setSioK(v)
    window.setNaOK         = (v)   => setNaOK(v)
    window.getDisplacementStats = () => {
      const phys = physRef.current
      if (!phys?.particles) return null
      const { particles, n } = phys
      let sum = 0, max = 0, over9 = 0
      for (let i = 0; i < n; i++) {
        const p = particles[i]
        const d = Math.hypot(p.x - p.x0, p.y - p.y0)
        sum += d
        if (d > max) max = d
        if (d > 9) over9++
      }
      return { mean: +(sum / n).toFixed(3), max: +max.toFixed(3), over9pct: +(over9 / n * 100).toFixed(1) }
    }
    window.getFreedStats = () => {
      const phys = physRef.current
      if (!phys?.particles || !phys?.latticeFreed) return null
      const { particles, n, latticeFreed } = phys
      let sioTotal = 0, sioFreed = 0, naTotal = 0, naFreed = 0
      for (let i = 0; i < n; i++) {
        const ct = particles[i].cellType
        if (ct === 'SiO2') { sioTotal++; if (latticeFreed[i]) sioFreed++ }
        else if (ct === 'Na2O') { naTotal++; if (latticeFreed[i]) naFreed++ }
      }
      return {
        sioFreedPct: sioTotal ? +(sioFreed / sioTotal * 100).toFixed(1) : 0,
        naFreedPct:  naTotal  ? +(naFreed  / naTotal  * 100).toFixed(1) : 0,
        sioFreed, sioTotal, naFreed, naTotal,
      }
    }
    window.getBreakStats = () => {
      const phys = physRef.current
      if (!phys?.particles) return null
      const totalKE = computeKE(phys)   // total KE of all atoms
      return {
        breakKERemoved:  phys.breakKERemoved  ?? 0,
        breakKEReturned: phys.breakKEReturned ?? 0,
        netDrain:        (phys.breakKERemoved ?? 0) - (phys.breakKEReturned ?? 0),
        totalKE,
        // gross fraction of total KE drained per step by bond breaking (before reforms)
        breakPEoverKE: totalKE > 0 ? (phys.breakKERemoved ?? 0) / totalKE : 0,
        latticeTemp: phys.latticeTemp ?? null,
      }
    }
    window.setNaAnchorK         = v => setNaAnchorK(v)
    window.setNaLiberateFrac    = v => setNaLiberateFrac(v)
    window.setNaBreakStrain     = v => setNaBreakStrain(v)
    window.setLatticeSpeedMult  = v => setLatticeSpeedMult(v)
    window.setFreedSpeedMult    = v => setFreedSpeedMult(v)
    window.resetLibStats   = () => resetLibStats()
    window.getLibStats     = () => getLibStats()
    window.getStrainStats = () => {
      const phys = physRef.current
      if (!phys?.rigidBonds) return null
      const { particles, rigidBonds } = phys
      const strains = []
      for (const rb of rigidBonds) {
        if (rb.broken) continue
        const pi = particles[rb.i], pj = particles[rb.j]
        const d = Math.hypot(pj.x - pi.x, pj.y - pi.y)
        strains.push((d - rb.r0) / rb.r0)
      }
      if (!strains.length) return { n: 0 }
      strains.sort((a, b) => a - b)
      const mean = strains.reduce((s, v) => s + v, 0) / strains.length
      const p95  = strains[Math.floor(strains.length * 0.95)]
      const p99  = strains[Math.floor(strains.length * 0.99)]
      const max  = strains[strains.length - 1]
      return { n: strains.length, mean: +mean.toFixed(4), p95: +p95.toFixed(4), p99: +p99.toFixed(4), max: +max.toFixed(4) }
    }
    window.resetLifetimes = () => {
      const phys = physRef.current
      if (!phys?.lifetimeTotal) return
      phys.lifetimeTotal.fill(0)
      phys.lifetimeBreaks.fill(0)
      phys.currentIntact.fill(0)
      const rb = phys.rigidBonds
      if (rb) for (let i = 0; i < rb.length; i++) phys.wasIntact[i] = rb[i].broken ? 0 : 1
    }
    window.getKERatio = () => {
      const phys = physRef.current
      if (!phys) return null
      const n = phys.n
      const ke = computeKE(phys)
      const d  = phys.dbg || {}
      if (d.totalEnergy == null) return null
      const targetKE = (d.totalEnergy + 273) * ENERGY_UNIT * n
      return { ke, targetKE, ratio: ke / targetKE, tempC: Math.round(ke / (n * ENERGY_UNIT) - 273) }
    }
    window.getSioStats = () => {
      const phys = physRef.current
      if (!phys || !phys.rigidBonds) return null
      const { particles, rigidBonds, latticeFreed, n } = phys
      const isBonded = new Uint8Array(n)
      for (const b of (phys.bonds ?? [])) { if (!b.broken) { isBonded[b.i] = 1; isBonded[b.j] = 1 } }
      const idxs = []
      for (let i = 0; i < n; i++) if (particles[i].cellType === 'SiO2') idxs.push(i)
      if (!idxs.length) return null
      const nBonded = idxs.filter(i => isBonded[i]).length
      let ltTotal = 0, ltBreaks = 0
      for (let bi = 0; bi < rigidBonds.length; bi++) {
        if (particles[rigidBonds[bi].i].cellType === 'SiO2') {
          ltTotal  += phys.lifetimeTotal?.[bi]  ?? 0
          ltBreaks += phys.lifetimeBreaks?.[bi] ?? 0
        }
      }
      return {
        bondedPct:  Math.round(nBonded / idxs.length * 100),
        meanLifeFr: ltBreaks > 0 ? Math.round(ltTotal / ltBreaks) : null,
      }
    }
    window.meltDebug = () => {
      const phys = physRef.current
      if (!phys) return console.log('no physics state')
      const { particles, rigidBonds, latticeFreed, chunks } = phys
      const n = phys.n
      const d = phys.dbg || {}

      // ── System ─────────────────────────────────────────────────────────
      const ke              = computeKE(phys)
      const { ke: bonKE }  = computeBondedKE(phys)
      const bpe   = phys.bondBreakPE  ?? 0
      const cumKE = phys.cumulativeKE ?? 0
      const totE  = phys.totalEnergyAdded ?? 0
      const targetKE = d.totalEnergy != null ? (d.totalEnergy + 273) * ENERGY_UNIT * n : null
      const keRatio  = targetKE ? (ke / targetKE).toFixed(4) : '—'
      console.log('── system ──────────────────────────────────────────────')
      console.table({
        'tempC (target)':   d.totalEnergy ?? Math.round(ke / (n * ENERGY_UNIT) - 273),
        'tempC (total KE)': Math.round(ke / (n * ENERGY_UNIT) - 273),
        'KE/target ratio':  keRatio,
        KE:               ke.toExponential(3),
        bondedKE:         bonKE.toExponential(3),
        'KE/bondedKE':    bonKE > 0 ? (ke / bonKE).toFixed(3) : '—',
        bondBreakPE:      bpe.toExponential(3),
        cumulativeKE:     cumKE.toExponential(3),
        'breakPE/cumKE':  cumKE > 0 ? (bpe / cumKE).toFixed(4) : '—',
        totalEnergyAdded: totE.toExponential(3),
        hasBeenMelted:    d.hasBeenMelted ?? '?',
        anchorStr:        d.anchorStr     ?? '?',
      })

      if (!rigidBonds || !phys.everBroken) {
        console.log('bond bookkeeping not yet initialized')
        return
      }

      // Atoms with at least one live bond (rigid or dynamic, not broken)
      const isBonded = new Uint8Array(n)
      for (const b of (phys.bonds ?? [])) { if (!b.broken) { isBonded[b.i] = 1; isBonded[b.j] = 1 } }

      // Intra-unit bond: both atoms share chunkIdx in original rigid bond map
      const isIntraUnit = new Uint8Array(rigidBonds.length)
      for (let bi = 0; bi < rigidBonds.length; bi++) {
        const { i, j } = rigidBonds[bi]
        if (particles[i].chunkIdx === particles[j].chunkIdx) isIntraUnit[bi] = 1
      }

      // ── Per-species stats ───────────────────────────────────────────────
      // whole% = cation atoms (Si/Na/Ca) with no ever-broken intra-grain bonds / total cations
      const CATION_TYPE = { SiO2: 0, Na2O: 2, CaO: 3 }
      console.log('── per species ─────────────────────────────────────────')
      const specRows = {}
      for (const species of ['SiO2', 'Na2O', 'CaO']) {
        const specAtomIdxs = []
        for (let i = 0; i < n; i++) if (particles[i].cellType === species) specAtomIdxs.push(i)
        if (!specAtomIdxs.length) continue

        const cationTid = CATION_TYPE[species]
        const cationIdxs = specAtomIdxs.filter(i => particles[i].typeId === cationTid)
        const nAtoms      = specAtomIdxs.length
        const nCations    = cationIdxs.length
        const nBonded     = specAtomIdxs.filter(i => isBonded[i]).length
        const nLiberated  = specAtomIdxs.filter(i => latticeFreed?.[i]).length
        const nWhole   = cationIdxs.filter(i => {
          const ub = phys.unitBonds?.[i]
          return !ub?.length || ub.every(bi => !phys.everBroken[bi])
        }).length

        let ltTotal = 0, ltBreaks = 0
        for (let bi = 0; bi < rigidBonds.length; bi++) {
          const pi = particles[rigidBonds[bi].i]
          if (pi.cellType === species) {
            ltTotal  += phys.lifetimeTotal[bi]
            ltBreaks += phys.lifetimeBreaks[bi]
          }
        }

        specRows[species] = {
          atoms:        nAtoms,
          'bonded%':    Math.round(nBonded / nAtoms * 100) + '%',
          'free%':      Math.round((nAtoms - nBonded) / nAtoms * 100) + '%',
          'liberated%': Math.round(nLiberated / nAtoms * 100) + '%',
          cations:      nCations,
          'whole%':   nCations > 0 ? Math.round(nWhole / nCations * 100) + '%' : '—',
          meanLifeFr: ltBreaks > 0 ? Math.round(ltTotal / ltBreaks) : '∞',
        }
      }
      console.table(specRows)

      // ── Bond break stats (intra-unit vs inter-unit) ─────────────────────
      if (d.bonds) {
        const rows = {}
        for (const [key, s] of Object.entries(d.bonds)) {
          rows[key] = {
            total: s.total, broken: s.broken,
            'broken%': Math.round(s.broken / s.total * 100),
          }
        }
        console.log('── bond break stats ────────────────────────────────────')
        console.table(rows)

        // Intra vs inter breakdown from phys.bonds (all live bonds, broken excluded).
        // intra = both atoms share chunkIdx (same original grain).
        // inter = atoms from different grains — only possible for dynamic bonds formed in the melt.
        const intra = { total: 0 }
        const inter = { total: 0 }
        for (const b of (phys.bonds ?? [])) {
          if (b.broken) continue
          const ci = particles[b.i].chunkIdx, cj = particles[b.j].chunkIdx
          if (ci === cj) intra.total++
          else           inter.total++
        }
        const bondTotal = intra.total + inter.total
        console.log('── intra-grain vs inter-grain (live bonds, phys.bonds) ──')
        console.table({
          'intra-grain': { ...intra, '%': bondTotal ? Math.round(intra.total / bondTotal * 100) : '—' },
          'inter-grain': { ...inter, '%': bondTotal ? Math.round(inter.total / bondTotal * 100) : '—' },
        })
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
        } else {
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
        ePerParticle = rampEnergyLinearInContent(coolingStartERef.current, 200, t, na2oPctRef.current, hcPlateauRef.current)
        effectiveERef.current = ePerParticle
      } else if (cm === 'fastHeat' || cm === 'slowHeat') {
        coolingFrameRef.current++
        const dur = cm === 'fastHeat' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)
        ePerParticle = rampEnergyLinearInContent(coolingStartERef.current, 1500, t, na2oPctRef.current, hcPlateauRef.current)
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
          drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, showField: showFieldRef.current, atomColorMode: atomColorModeRef.current, showBrokenBonds: showBrokenBondsRef.current, showLiveStats: showLiveStatsRef.current, targetTempC: Math.round(ePerParticle / ENERGY_UNIT - 273), hoverIdx: hoverIdxRef.current, selectedIdx: selectedIdxRef.current })
          rafRef.current = requestAnimationFrame(frame)
          return
        }

        const speed = speedRef.current

        if (speed >= 1) {
          const steps = Math.floor(speed)
          for (let s = 0; s < steps; s++) {
            for (const p of phys.particles) { p.px = p.x; p.py = p.y }
            stepPhysics(phys, ePerParticle, 1.0, attractKRef.current, cm, speedMultRef.current, attractFalloffRef.current)
            stepCallCountRef.current++
            if (!diagDoneRef.current && stepCallCountRef.current <= 10) {
              const meanSpd = phys.particles.reduce((s, p) => s + Math.hypot(p.vx, p.vy), 0) / phys.n
              console.log(`[diag] stepPhysics call #${stepCallCountRef.current}: coolingFactor=1.0 speedMult=${speedMultRef.current.toFixed(3)} ePerParticle=${ePerParticle.toExponential(3)} meanSpeed=${meanSpd.toExponential(3)} cm=${cm}`)
              if (stepCallCountRef.current === 10) diagDoneRef.current = true
            }
          }
          frameAccRef.current = 0
        } else {
          frameAccRef.current += speed
          if (frameAccRef.current >= 1) {
            frameAccRef.current -= 1
            for (const p of phys.particles) { p.px = p.x; p.py = p.y }
            stepPhysics(phys, ePerParticle, 1.0, attractKRef.current, cm, speedMultRef.current, attractFalloffRef.current)
            stepCallCountRef.current++
            if (!diagDoneRef.current && stepCallCountRef.current <= 10) {
              const meanSpd = phys.particles.reduce((s, p) => s + Math.hypot(p.vx, p.vy), 0) / phys.n
              console.log(`[diag] stepPhysics call #${stepCallCountRef.current}: coolingFactor=1.0 speedMult=${speedMultRef.current.toFixed(3)} ePerParticle=${ePerParticle.toExponential(3)} meanSpeed=${meanSpd.toExponential(3)} cm=${cm}`)
              if (stepCallCountRef.current === 10) diagDoneRef.current = true
            }
          }
        }

        drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, showField: showFieldRef.current, atomColorMode: atomColorModeRef.current, showBrokenBonds: showBrokenBondsRef.current, showLiveStats: showLiveStatsRef.current, targetTempC: Math.round(ePerParticle / ENERGY_UNIT - 273), hoverIdx: hoverIdxRef.current, selectedIdx: selectedIdxRef.current })

        // ── KE / PE diagnostics + graph history ──────────────────────
        const ke = computeKE(phys)
        const pe = computePE(phys) + (phys.bondBreakPE ?? 0)
        // latticeTemp = keTarget/ENERGY_UNIT-273: thermostat's intended temperature,
        // free of wander-clamp KE corruption. Drops below totalEnergy when PE rises.
        const rawTempC = Math.max(0, computeKE(phys) / (phys.n * ENERGY_UNIT) - 273)
        smoothTempRef.current = smoothTempRef.current * 0.92 + rawTempC * 0.08
        const derivedTempC = Math.round(smoothTempRef.current)
        onEnergyUpdateRef.current?.(ke, pe, derivedTempC, effectiveERef.current, phys.fBroken ?? 0, phys.meanAvgStrain ?? 0, phys.sevFireRate ?? 0, phys.meanEffThreshold ?? 0, phys.maxAvgStrain ?? 0)
        // ── Per-frame measurement bookkeeping (no physics effect) ─────────
        if (phys.wasIntact) {
          const rb = phys.rigidBonds
          for (let _i = 0; _i < rb.length; _i++) {
            if (!rb[_i].broken) {
              phys.currentIntact[_i]++
              phys.wasIntact[_i] = 1
            } else {
              phys.everBroken[_i] = 1
              if (phys.wasIntact[_i]) {
                phys.lifetimeTotal[_i]  += phys.currentIntact[_i]
                phys.lifetimeBreaks[_i]++
                phys.currentIntact[_i]   = 0
                phys.wasIntact[_i]       = 0
              }
            }
          }
          phys.totalEnergyAdded += ePerParticle * phys.n
          phys.cumulativeKE     += ke
        }

        // Record into ring buffer (every 3 frames to avoid redundancy)
        histFrameRef.current++
        if (histFrameRef.current >= 3) {
          histFrameRef.current = 0
          const targetTempC = Math.max(0, Math.round(ePerParticle / ENERGY_UNIT - 273))
          const xVal = energyContent(targetTempC, na2oPctRef.current, hcPlateauRef.current)
          histRef.current.push({ e: xVal, t: targetTempC })
        }

        // ── Draw energy graph into sidebar canvas when provided ───────
        const extCanvas = graphCanvasRefRef.current?.current
        if (extCanvas) {
          const eMax = energyContent(1800, na2oPctRef.current, hcPlateauRef.current) * 1.05
          drawTEGraph(extCanvas, histRef.current, darkModeRef.current, eMax)
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
        {showLiveStats && (
          <button
            onClick={() => navigator.clipboard?.writeText(getLastHudLines().join('\n'))}
            style={{
              position: 'absolute', top: 6, right: 6,
              background: 'rgba(0,0,0,0.65)', color: '#aaa',
              border: '1px solid #555', borderRadius: 3,
              fontSize: 10, padding: '2px 6px', cursor: 'pointer',
              fontFamily: 'monospace', userSelect: 'none',
            }}
          >copy</button>
        )}
      </div>
    </div>
  )
}
