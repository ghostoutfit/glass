import { useMemo, useRef, useEffect } from 'react'
import { initPhysics, stepPhysics, setSiOr0,
         rebuildBonds, computeKE, computeBondedKE, computePE, ENERGY_UNIT, THERMAL_SPEED,
         buildRigidBondMap, setSioExclMult, setBreakStrain, setReformStrain, setCrystAnchorK, setLiberateFrac, setSioK, setNaOK,
         setNaAnchorK, setNaLiberateFrac, setNaBreakStrain, setLatticeSpeedMult, setFreedSpeedMult,
         resetLibStats, getLibStats, measureStrain95, meltStructure, setUseEmaStrain,
         verifyHashPairs, setMeltHash, setCoolBondScale } from './meltPhysics.js'
import { drawScene, setVisualScale, findAtomNear, getVisualScale, getLastHudLines, effectiveDpr } from './renderer.js'
import { buildGrid, buildAllAtoms } from './meltGrid.js'


// Cooling durations in SIM STEPS (not frames). With wall-clock pacing the ramp advances by
// the number of steps taken, so a cool always runs this many relaxation steps regardless of
// frame rate — the slow-vs-fast-cool structure difference no longer depends on the hardware.
// At BASE_STEPS_PER_SEC these equal the historical ~4.5 s / ~24 s wall-clock at simSpeed 1.
const FAST_COOL_FRAMES = 270   // ~4.5 s at simSpeed 1
const SLOW_COOL_FRAMES = 1440  // ~24 s at simSpeed 1

// Wall-clock pacing: the sim advances by elapsed real time, not per rendered frame, so faster
// hardware just draws more (smoother) frames of the SAME sim rate instead of running faster.
const BASE_STEPS_PER_SEC = 60   // sim steps per second at simSpeed 1 (simSpeed scales this)
const MAX_FRAME_DT       = 0.1  // clamp elapsed (s): a struggling machine lags, never spirals
const MAX_STEPS_PER_FRAME = 8   // safety cap on catch-up work in any single frame


const C = {
  Si: '#d4a020', O: '#cc3a3a', Ca: '#4a96be', Na: '#4aaa60',
  bg_sio2:  '#d8cb98', bg_cao:  '#ede8df', bg_na2o:  '#ddeedd',
  bdr_sio2: '#a09050', bdr_cao: '#b0a898', bdr_na2o: '#88aa88',
  lbl_sio2: '#7a6830', lbl_cao: '#5a7080', lbl_na2o: '#4a7850',
}


// ── Graph drawing helpers ─────────────────────────────────────────────────────
function setupCanvas(canvas) {
  if (!canvas || !canvas.clientWidth) return null
  const dpr = effectiveDpr()
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

// ── Cooling heat capacity (distinct from heating — different physics) ──────────
// On cooling the substance RELEASES latent heat where bonds form, which on the T-vs-energy
// graph is a shallower slope (less temperature drop per unit energy removed). Shape, matching
// what's on screen:
//   • T > 1100: no bonds forming yet → low heat capacity → STEEP (fast temp drop per energy)
//   • 500–1100: bonds forming, lenses fading pink→white → high heat capacity → SHALLOW shelf
//   • T < 500:  solid, energy just leaves the kinetic bucket → low heat capacity → STEEP again
// Slow cool finds more/better bonds, so it releases MORE latent heat → an even taller hump
// (even shallower shelf) than fast. Live-tunable via window._coolLatentSlow / _coolLatentFast.
const COOL_BAND_LO = 500, COOL_BAND_HI = 1100, COOL_BAND_W = 60
function coolHeatCap(T, slow) {
  const amp = slow ? (window._coolLatentSlow ?? 7) : (window._coolLatentFast ?? 3)
  const ss = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u) }
  const band = ss(COOL_BAND_LO - COOL_BAND_W, COOL_BAND_LO + COOL_BAND_W, T) *
               (1 - ss(COOL_BAND_HI - COOL_BAND_W, COOL_BAND_HI + COOL_BAND_W, T))
  return 1 + (amp - 1) * band
}
function coolEnergyContent(T, slow) {
  let c = 0
  for (let x = 5; x <= T; x += 5) c += coolHeatCap(x, slow) * 5
  return c * ENERGY_UNIT
}
function coolTempForContent(target, slow) {
  if (target <= 0) return 0
  let c = 0
  for (let x = 5; x <= 2000; x += 5) { c += coolHeatCap(x, slow) * 5 * ENERGY_UNIT; if (c >= target) return x }
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
function drawTEGraph(canvas, hist, darkMode = true, eMax = 4e-3, targetTempLine = null) {
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

  // Target-temperature line (set via the GO box): dotted horizontal line + its value.
  if (targetTempLine != null && targetTempLine >= 0 && targetTempLine <= tMax) {
    const ly = pT + ph - (targetTempLine / tMax) * ph
    ctx.strokeStyle = darkMode ? '#ffb060' : '#c05000'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(pL, ly); ctx.lineTo(pL + pw, ly); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = darkMode ? '#ffb060' : '#c05000'
    ctx.font = 'bold 14px Lexend, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
    ctx.fillText(`${Math.round(targetTempLine)}°`, pL + pw, ly - 2)
  }

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

export default function CompositionView({ sio2Pct, na2oPct, caoPct, sioR0 = 9, attractK = 0, attractFalloff = 1, debug = false, bondNums = false, meltTemp = 50, simSpeed = 1, speedMult = 1, coolingMode = null, onTempUpdate = null, onEnergyUpdate = null, onBondCounts = null, replayFrame = null, onReplayReady = null, graphCanvasRef = null, cumulativeEnergyRef = null, graphXMaxRef = null, darkMode = true, showCharge = false, chargeLite = false, showField = true, fieldBlur = true, interpolate = false, longerCooledBonds = true, atomColorMode = 'normal', showBrokenBonds = false, showLiveStats = false, useEmaStrain = true, hcPlateau = 4, active = true, resetToken = 0, targetTempLine = null }) {
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
  const targetTempLineRef        = useRef(null)
  const hcPlateauRef             = useRef(4)
  // When false this tab is not showing: keep the RAF alive (so the shared energy
  // ramp still advances and the other tab can cool) but skip stepPhysics, drawing,
  // replay recording, the graph and the bond-count callback. See the activeRef
  // guard in the RAF loop below.
  const activeRef                = useRef(active)
  const graphXMaxRefRef          = useRef(graphXMaxRef)
  const frameAccRef         = useRef(0)   // fractional sim-step accumulator (wall-clock pacing)
  const lastTsRef           = useRef(0)   // previous frame timestamp, for elapsed-time pacing
  const lastRampSyncRef     = useRef(0)   // throttle for the ramp → parent temperature sync
  const coolGraphERef       = useRef(null) // during cooling: energy to plot on the graph x-axis
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
  const fieldBlurRef        = useRef(fieldBlur)
  const chargeLiteRef       = useRef(chargeLite)
  const interpolateRef      = useRef(interpolate)
  const longerBondsRef      = useRef(longerCooledBonds)
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
  useEffect(() => { fieldBlurRef.current = fieldBlur }, [fieldBlur])
  useEffect(() => { chargeLiteRef.current = chargeLite }, [chargeLite])
  useEffect(() => { interpolateRef.current = interpolate }, [interpolate])
  useEffect(() => { longerBondsRef.current = longerCooledBonds }, [longerCooledBonds])
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
  useEffect(() => { targetTempLineRef.current = targetTempLine }, [targetTempLine])
  useEffect(() => { hcPlateauRef.current = hcPlateau }, [hcPlateau])
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { graphXMaxRefRef.current = graphXMaxRef }, [graphXMaxRef])

  // Hover highlight: mousemove tracks nearest atom for the white ring in renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const toPhys = e => {
      const rect  = canvas.getBoundingClientRect()
      const dpr   = effectiveDpr()   // must match what drawScene used, or hit-testing desyncs
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
    window.verifyHashPairs = () => verifyHashPairs(window._meltPhys)   // stage-1 hash check
    window.setMeltHash     = setMeltHash                               // toggle hash on/off
    // Live sim-speed tuning: lower = slower. 0.5 steps every 2nd frame, 0.25 every 4th, etc.
    // Dial it here, then tell me the value to hard-code into simSpeed's useState default.
    window.setSimSpeed     = (v) => { window._simSpeed = v }
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
    lastTsRef.current = 0   // restart elapsed-time pacing cleanly after a rebuild
    setCoolBondScale(1)     // reset "longer cooled bonds" on a fresh build
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
    // resetToken: bumped by GlassViewer when this tab's frozen state is no longer
    // valid for the current conditions (temperature moved, preset or ramp mode
    // changed while the Bulk Material tab was showing). Re-running this effect
    // rebuilds the melt from a fresh start state: initPhysics → 5 settling steps →
    // buildRigidBondMap → 20 warm-up steps at the current target temperature.
  }, [cellData, resetToken])  // eslint-disable-line react-hooks/exhaustive-deps

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

      // ── Wall-clock pacing ─────────────────────────────────────────
      // Advance the sim by elapsed real time, not per rendered frame, so it runs the same
      // speed on every machine — fast hardware just draws more (smoother) frames of the same
      // sim rate, a struggling one lags. The ramp advances by the same step count and must
      // keep running even while THIS tab is frozen (it drives the Bulk Material tab's
      // temperature), so it is computed here, above the activeRef gate. window._wallClock =
      // false restores the old per-frame behaviour for A/B.
      const nowMs = ts || performance.now()
      let elapsed = lastTsRef.current ? (nowMs - lastTsRef.current) / 1000 : 0
      lastTsRef.current = nowMs
      if (elapsed > MAX_FRAME_DT) elapsed = MAX_FRAME_DT   // clamp → slow hw lags, never spirals
      const speed   = window._simSpeed ?? speedRef.current
      const useWall = window._wallClock !== false
      let stepsThisFrame, rampAdvance
      if (useWall) {
        frameAccRef.current += elapsed * BASE_STEPS_PER_SEC * speed
        stepsThisFrame = Math.floor(frameAccRef.current)
        frameAccRef.current -= stepsThisFrame
        if (stepsThisFrame > MAX_STEPS_PER_FRAME) { stepsThisFrame = MAX_STEPS_PER_FRAME; frameAccRef.current = 0 }
        rampAdvance = stepsThisFrame
      } else if (speed >= 1) {
        stepsThisFrame = Math.floor(speed); frameAccRef.current = 0; rampAdvance = 1
      } else {
        frameAccRef.current += speed
        stepsThisFrame = frameAccRef.current >= 1 ? (frameAccRef.current -= 1, 1) : 0
        rampAdvance = 1
      }

      // ── Compute energy target for this frame ──────────────────────
      // All ramps are energy-based: ePerParticle = (sliderVal+273)*ENERGY_UNIT. The ramp is
      // advanced in SIM STEPS (rampAdvance), so a cool runs a fixed number of relaxation
      // steps regardless of frame rate — the crystallinity lesson is hardware-independent.
      let ePerParticle
      const isRamping = cm === 'fast' || cm === 'slow' || cm === 'fastHeat' || cm === 'slowHeat'
      if (cm === 'fast' || cm === 'slow') {
        coolingFrameRef.current += rampAdvance
        const dur = cm === 'fast' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)   // progress; advances at a constant rate
        const slow  = cm === 'slow'
        const Tstart = coolingStartERef.current / ENERGY_UNIT - 273
        // Energy leaves at a CONSTANT rate: the graph x-axis moves linearly from where heating
        // ended (energyContent(Tstart)) down to 0. Temperature is derived through the cooling
        // heat-capacity curve, so the graph SLOPE carries the latent-heat physics (a shallow
        // shelf 1100→500), and slow's taller hump makes that shelf even shallower than fast.
        const eTop  = energyContent(Tstart, na2oPctRef.current, hcPlateauRef.current)
        const cTop  = coolEnergyContent(Tstart, slow)
        const scale = cTop > 0 ? eTop / cTop : 1   // normalise so the loop meets heating at the top
        const graphE = eTop * (1 - t)              // linear in energy → constant rate on the x-axis
        const Tnow   = coolTempForContent(graphE / scale, slow)
        ePerParticle = (Tnow + 273) * ENERGY_UNIT
        effectiveERef.current = ePerParticle
        coolGraphERef.current = graphE             // plot this on the graph (hysteresis path)
      } else if (cm === 'fastHeat' || cm === 'slowHeat') {
        coolingFrameRef.current += rampAdvance
        const dur = cm === 'fastHeat' ? FAST_COOL_FRAMES : SLOW_COOL_FRAMES
        const t   = Math.min(1, coolingFrameRef.current / dur)
        ePerParticle = rampEnergyLinearInContent(coolingStartERef.current, 1500, t, na2oPctRef.current, hcPlateauRef.current)
        effectiveERef.current = ePerParticle
        coolGraphERef.current = null   // heating uses the normal energy axis
      } else {
        ePerParticle = (energyValRef.current + 273) * ENERGY_UNIT   // energyValRef tracks meltTemp
        effectiveERef.current = ePerParticle
        coolGraphERef.current = null   // hold uses the normal energy axis
      }

      // Propagate slider-equivalent energy value to parent (throttled to ~10×/s by wall-clock)
      if (onTempUpdateRef.current && isRamping && nowMs - lastRampSyncRef.current > 100) {
        lastRampSyncRef.current = nowMs
        onTempUpdateRef.current(Math.round(ePerParticle / ENERGY_UNIT - 273))
      }

      // "Longer cooled bonds": while cooling, ramp the rigid-bond rest length +10% over the first
      // 300°C of the drop (9→9.9, 12→13.2), then hold it (latched). Reset to normal on reheat.
      // The longer bonds expand the network into the voids so the solid reads as continuous.
      if (longerBondsRef.current && (cm === 'fast' || cm === 'slow')) {
        const startT = coolingStartERef.current / ENERGY_UNIT - 273
        const curT   = ePerParticle / ENERGY_UNIT - 273
        setCoolBondScale(1 + 0.1 * Math.max(0, Math.min(1, (startT - curT) / 300)))
      } else if (cm === 'fastHeat' || cm === 'slowHeat' || !longerBondsRef.current) {
        setCoolBondScale(1)   // reheating, or feature off → normal bond lengths
      }
      // (cm === null hold: leave the latched value in place)

      const phys = physRef.current
      // activeRef gate: everything above this point is cheap bookkeeping that must
      // keep running while the other tab is showing — the energy-content ramp above
      // is the sole temperature driver for Slow/Fast Cool, and the Bulk Material tab
      // reads that temperature. Everything below is the expensive part (stepPhysics,
      // drawScene, replay capture, the graph, bond counts) and is frozen with the tab.
      if (phys && activeRef.current) {
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
          drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, chargeLite: chargeLiteRef.current, showField: showFieldRef.current, fieldBlur: fieldBlurRef.current, atomColorMode: atomColorModeRef.current, showBrokenBonds: showBrokenBondsRef.current, showLiveStats: showLiveStatsRef.current, targetTempC: Math.round(ePerParticle / ENERGY_UNIT - 273), hoverIdx: hoverIdxRef.current, selectedIdx: selectedIdxRef.current })
          rafRef.current = requestAnimationFrame(frame)
          return
        }

        // Run the sim steps scheduled for this frame by the wall-clock pacer above.
        for (let s = 0; s < stepsThisFrame; s++) {
          for (const p of phys.particles) { p.px = p.x; p.py = p.y }
          stepPhysics(phys, ePerParticle, 1.0, attractKRef.current, cm, speedMultRef.current, attractFalloffRef.current)
          stepCallCountRef.current++
          if (!diagDoneRef.current && stepCallCountRef.current <= 10) {
            const meanSpd = phys.particles.reduce((s, p) => s + Math.hypot(p.vx, p.vy), 0) / phys.n
            console.log(`[diag] stepPhysics call #${stepCallCountRef.current}: coolingFactor=1.0 speedMult=${speedMultRef.current.toFixed(3)} ePerParticle=${ePerParticle.toExponential(3)} meanSpeed=${meanSpd.toExponential(3)} cm=${cm}`)
            if (stepCallCountRef.current === 10) diagDoneRef.current = true
          }
        }

        // Hi-Res interpolation: draw freed atoms `frameAccRef` of the way into the next step
        // (the unconsumed time fraction), so motion is smooth between physics steps. 1 = off.
        const interpAlpha = interpolateRef.current ? Math.min(1, frameAccRef.current) : 1
        drawScene(canvasRef.current, phys, { ts, bondNums: bondNumsRef.current, darkMode: darkModeRef.current, showCharge: showChargeRef.current, chargeLite: chargeLiteRef.current, showField: showFieldRef.current, fieldBlur: fieldBlurRef.current, interp: interpAlpha, atomColorMode: atomColorModeRef.current, showBrokenBonds: showBrokenBondsRef.current, showLiveStats: showLiveStatsRef.current, targetTempC: Math.round(ePerParticle / ENERGY_UNIT - 273), hoverIdx: hoverIdxRef.current, selectedIdx: selectedIdxRef.current })

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
          // During cooling, plot the cooling-energy path (constant-rate x, latent-heat slope);
          // otherwise the normal energy axis. This draws the heat-up/cool-down hysteresis loop.
          const xVal = coolGraphERef.current ?? energyContent(targetTempC, na2oPctRef.current, hcPlateauRef.current)
          histRef.current.push({ e: xVal, t: targetTempC })
        }

        // ── Draw energy graph into sidebar canvas when provided ───────
        const extCanvas = graphCanvasRefRef.current?.current
        if (extCanvas) {
          const eMax = energyContent(1800, na2oPctRef.current, hcPlateauRef.current) * 1.05
          drawTEGraph(extCanvas, histRef.current, darkModeRef.current, eMax, targetTempLineRef.current)
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
