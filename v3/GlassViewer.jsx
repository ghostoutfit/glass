import { useState, useCallback, useEffect, useRef } from 'react'
import CompositionView from './CompositionView'
import NetworksView from './NetworksView'
import { initParticles, stepPhysics, stepFloorPhysics, PARTICLE_R, FIXED_DT, T_RIGID, freezeParticles, syncParticlesToRigidBody, stepRigidBody } from './glassPhysics.js'
import { initSandParticles, stepSandPhysics, mergeSodaGrains, mergeSilicateGrains, convertLargeNaGrains, stepNaBlobSprings, checkNaBlobMerges, absorbNearbyGrains, GRAIN_R as SAND_GRAIN_R, NA_BLOB_R_CTR } from './sandPhysics.js'
import './GlassViewer.css'

// ── ScrubSlider — machined-thumb horizontal scrubber (matches concrete v4) ──
const THUMB_W = 20
function ScrubSlider({ value, onChange, disabled }) {
  const trackRef  = useRef(null)
  const dragging  = useRef(false)
  const onChangeCb = useRef(onChange)
  useEffect(() => { onChangeCb.current = onChange }, [onChange])

  useEffect(() => {
    function onMove(e) {
      if (!dragging.current || !trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      onChangeCb.current(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    }
    function onUp() {
      if (dragging.current) { dragging.current = false; document.body.style.cursor = '' }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  function onMouseDown(e) {
    if (disabled || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    onChangeCb.current(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    dragging.current = true
    document.body.style.cursor = 'grabbing'
    e.preventDefault()
  }

  const pct = `${value * 100}%`
  return (
    <div ref={trackRef} onMouseDown={onMouseDown} style={{
      position: 'relative', flex: 1, height: 30, display: 'flex', alignItems: 'center',
      opacity: disabled ? 0.32 : 1, userSelect: 'none',
    }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 5, borderRadius: 3,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(18,12,6,0.70) 100%)',
        boxShadow: 'inset 0 2px 3px rgba(0,0,0,0.65), inset 0 -1px 0 rgba(255,255,255,0.04)',
      }} />
      <div style={{
        position: 'absolute', left: 0, width: pct, height: 5, borderRadius: 3,
        background: 'linear-gradient(180deg, rgba(180,138,72,0.50) 0%, rgba(130,96,44,0.32) 100%)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', left: pct, transform: 'translateX(-50%)',
        width: THUMB_W, height: 30, borderRadius: 4,
        background: 'linear-gradient(180deg, #5c5040 0%, #3e3428 52%, #2c2418 100%)',
        border: '1px solid rgba(160,130,80,0.32)',
        boxShadow: [
          'inset 0 1px 0 rgba(220,190,130,0.16)',
          'inset 0 -1px 0 rgba(0,0,0,0.55)',
          '0 0 0 1px rgba(0,0,0,0.65)',
          '0 3px 5px rgba(0,0,0,0.65)',
          '0 6px 12px rgba(0,0,0,0.38)',
        ].join(', '),
        cursor: disabled ? 'default' : 'grab',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3.5,
        zIndex: 1, pointerEvents: 'none',
      }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{ width: 10, height: 1.5, borderRadius: 1, background: 'rgba(200,170,100,0.30)' }} />
        ))}
      </div>
    </div>
  )
}

// Glass tab: visual-only atom type assignment (does not affect physics)
const GLASS_TYPE_COLORS = ['#d4a020', '#cc3a3a', '#4aaa60', '#4a96be']  // Si, O, Na, Ca
const GLASS_TYPE_R      = [5.0,       3.0,       3.5,       4.5]
function assignGlassTypes(n, sio2, na2o, cao) {
  const nSi = sio2, nO = sio2 * 2 + na2o + cao, nNa = na2o * 2, nCa = cao
  const tot = nSi + nO + nNa + nCa
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = Math.random() * tot
    if (r < nSi)             out[i] = 0
    else if (r < nSi + nO)   out[i] = 1
    else if (r < nSi + nO + nNa) out[i] = 2
    else                      out[i] = 3
  }
  return out
}

// Atom icon for the sidebar key — matches concrete v4 BondIcon sizing (r × 1.5 scale)
// Charge overlay is rendered directly on the atom via box-shadow glow (no separate key section)
function GlassAtomIcon({ type, iconR, showCharge = false, darkMode = true }) {
  const FILL   = { Si: '#d4a020', O: '#cc3a3a', Na: '#4aaa60', Ca: '#4a96be' }
  const CHGRGB = { Si: '62,127,214', Ca: '62,127,214', O: '231,131,42', Na: '231,131,42' }
  const fill = FILL[type] ?? '#aaa'
  const rgb  = CHGRGB[type]
  const diam = iconR * 2
  const total = diam + iconR * 2   // glow pad = 1 radius each side
  return (
    <div style={{ width: total, height: total, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        width: diam, height: diam, borderRadius: '50%',
        background: fill,
        boxShadow: [
          `0 0 0 0.5px ${darkMode ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.25)'}`,
          `0 0 ${iconR * 1.5}px ${fill}99`,
          showCharge && rgb ? `0 0 ${iconR * 2.5}px rgba(${rgb},0.55)` : null,
        ].filter(Boolean).join(', '),
      }} />
    </div>
  )
}

const PRESETS = [
  { id: 'pure', label: 'Pure SiO₂', sio2: 100, na2o: 0,  cao: 0, nGrains: 1800 },
  { id: 'soda', label: 'High Na₂O', sio2: 70,  na2o: 30, cao: 0, nGrains: 2250 },
]

const BOX_SIZE    = 320

// Shadow color for the outer glow — separate from the fill color
function glassGlowColor(tempC) {
  const t = Math.max(0, Math.min(1, (tempC - 25) / (1200 - 25)))
  const stops = [
    [0.00, [40,  10,  3, 0.0]],
    [0.15, [100, 18,  5, 0.5]],
    [0.45, [220, 55, 10, 0.8]],
    [0.70, [255, 110, 18, 0.95]],
    [1.00, [255, 170, 45, 1.0]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i-1][0]) / (stops[i][0] - stops[i-1][0])
      const c0 = stops[i-1][1], c1 = stops[i][1]
      return `rgba(${~~(c0[0]+(c1[0]-c0[0])*f)},${~~(c0[1]+(c1[1]-c0[1])*f)},${~~(c0[2]+(c1[2]-c0[2])*f)},${(c0[3]+(c1[3]-c0[3])*f).toFixed(2)})`
    }
  }
  return 'rgba(255,170,45,1.0)'
}

// Fill + glow ramp for sil blobs — #c87333 copper at formation, warms to gold
// Stops are [t, [r,g,b]] where t = (tempC - 700) / 800 (range 700–1500°C).
// Colors are midpoints between avg-sand and Na measured at each temperature.
// t = (tempC - 700) / 800, range 700–1500°C — clamped above 1500°C
const _BLOB_STOPS = [
  [0.000, [199, 178, 161]],  //  700°C — extrapolated  #c7b2a1
  [0.375, [213, 159, 125]],  // 1000°C — measured      #d59f7d
  [0.542, [219, 151, 115]],  // 1133°C — measured      #db9773
  [0.769, [225, 136,  89]],  // 1315°C — measured      #e18859
  [1.000, [237, 128,  65]],  // 1500°C — measured      #ed8041
]
function blobFillColor(tempC) {
  if (tempC < 700) {
    // Darken from warm pinkish (700°C) toward near-black (25°C) — same feel as glassColor
    const tc = Math.max(0, (tempC - 25) / (700 - 25))
    return `rgb(${~~(30 + (199-30)*tc)},${~~(12 + (178-12)*tc)},${~~(5 + (161-5)*tc)})`
  }
  const t = Math.max(0, Math.min(1, (tempC - 700) / 800))
  for (let i = 1; i < _BLOB_STOPS.length; i++) {
    if (t <= _BLOB_STOPS[i][0]) {
      const f = (t - _BLOB_STOPS[i-1][0]) / (_BLOB_STOPS[i][0] - _BLOB_STOPS[i-1][0])
      const [r1,g1,b1] = _BLOB_STOPS[i-1][1], [r2,g2,b2] = _BLOB_STOPS[i][1]
      return `rgb(${~~(r1+(r2-r1)*f)},${~~(g1+(g2-g1)*f)},${~~(b1+(b2-b1)*f)})`
    }
  }
  return 'rgb(237,128,65)'
}
function blobGlowColor(tempC) {
  if (tempC < 700) return 'rgba(0,0,0,0)'
  const t = Math.max(0, Math.min(1, (tempC - 700) / 800))
  for (let i = 1; i < _BLOB_STOPS.length; i++) {
    if (t <= _BLOB_STOPS[i][0]) {
      const f = (t - _BLOB_STOPS[i-1][0]) / (_BLOB_STOPS[i][0] - _BLOB_STOPS[i-1][0])
      const [r1,g1,b1] = _BLOB_STOPS[i-1][1], [r2,g2,b2] = _BLOB_STOPS[i][1]
      const alpha = 0.20 + 0.25 * t
      return `rgba(${~~(r1+(r2-r1)*f)},${~~(g1+(g2-g1)*f)},${~~(b1+(b2-b1)*f)},${alpha.toFixed(2)})`
    }
  }
  return 'rgba(237,128,65,0.45)'
}

// Temperature → glass fill color (blackbody-ish ramp for molten glass)
const _GLASS_STOPS = [
  [0.00, [50,  22,  8]],
  [0.25, [148, 22,  5]],
  [0.45, [230, 72, 12]],
  [0.65, [255, 148, 28]],
  [0.85, [255, 218, 88]],
  [1.00, [255, 252, 190]],
]
function glassColorRGB(tempC) {
  const t = Math.max(0, Math.min(1, (tempC - 25) / (1200 - 25)))
  for (let i = 1; i < _GLASS_STOPS.length; i++) {
    if (t <= _GLASS_STOPS[i][0]) {
      const f = (t - _GLASS_STOPS[i-1][0]) / (_GLASS_STOPS[i][0] - _GLASS_STOPS[i-1][0])
      const [r1,g1,b1] = _GLASS_STOPS[i-1][1], [r2,g2,b2] = _GLASS_STOPS[i][1]
      return [~~(r1+(r2-r1)*f), ~~(g1+(g2-g1)*f), ~~(b1+(b2-b1)*f)]
    }
  }
  return [255, 252, 190]
}
function glassColor(tempC) {
  const [r,g,b] = glassColorRGB(tempC)
  return `rgb(${r},${g},${b})`
}

// ── Na₂O blob outline helpers ─────────────────────────────────────────────
function convexHull(pts) {
  if (pts.length < 3) return pts
  const s = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y)
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x)
  const lo = [], hi = []
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop()
    lo.push(p)
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop()
    hi.push(p)
  }
  hi.pop(); lo.pop()
  return [...lo, ...hi]
}

function buildNaBlobPath(ctx, blob) {
  const orbs = blob.particles.filter(p => p.type === 'na-sub')
  if (orbs.length < 3) return false
  let cx = 0, cy = 0
  for (const p of orbs) { cx += p.x; cy += p.y }
  cx /= orbs.length; cy /= orbs.length
  const surf = orbs.map(c => {
    const dx = c.x - cx, dy = c.y - cy, d = Math.hypot(dx, dy) || 1
    return { x: c.x + c.r * dx / d, y: c.y + c.r * dy / d }
  })
  const hull = convexHull(surf)
  const h = hull.length
  if (h < 3) return false
  ctx.beginPath()
  ctx.moveTo(hull[0].x, hull[0].y)
  for (let i = 0; i < h; i++) {
    const p0 = hull[(i - 1 + h) % h], p1 = hull[i]
    const p2 = hull[(i + 1) % h],     p3 = hull[(i + 2) % h]
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    )
  }
  ctx.closePath()
  return true
}

const CORNER_R    = 26
const STICK_LEN   = 300
const STICK_ANGLE = 10 * Math.PI / 180

export default function GlassViewer() {
  const [darkMode,   setDarkMode]   = useState(true)
  const [showCount,  setShowCount]  = useState(true)
  const [showCharge, setShowCharge] = useState(false)
  const [showField,  setShowField]  = useState(false)
  const [showDev,    setShowDev]    = useState(false)

  const [tab, setTab]             = useState('glass')
  const [presetId, setPresetId]   = useState('soda')
  const [meltEnergyIn,   setMeltEnergyIn]   = useState(0)    // -100..100, snaps to 0
  const [meltLocalTemp,  setMeltLocalTemp]  = useState(25)   // melt tab's own temperature
  const [derivedTemp,    setDerivedTemp]    = useState(25)   // KE-measured temperature
  const [simSpeed, setSimSpeed]   = useState(0.5)
  const [sioR0, setSioR0]         = useState(9)
  const [attractK, setAttractK]   = useState(0.02)
  const [showGraphs, setShowGraphs]   = useState(false)
  const [coolingMode, setCoolingMode] = useState(null)
  const [meltHeatMode, setMeltHeatMode] = useState(null)  // 'slow' | 'fast' | null
  const [precompute, setPrecompute]   = useState(true)
  const [bondNums, setBondNums]       = useState(false)
  const [bondCounts,        setBondCounts]        = useState(null)
  const [initialBondCounts, setInitialBondCounts] = useState(null)
  const initialBondCapturedRef = useRef(false)
  const [replayFrameCount, setReplayFrameCount] = useState(0)
  const [replayFrame, setReplayFrame]     = useState(null)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const replayRafRef = useRef(null)

  // Glass tab controls
  const [showBox,      setShowBox]      = useState(true)
  const [showStick,    setShowStick]    = useState(false)
  const [autoRotate,   setAutoRotate]   = useState(true)
  const [showMetaball, setShowMetaball] = useState(true)
  const [glassTemp,       setGlassTemp]       = useState(600)
  const [glassEnergyIn,   setGlassEnergyIn]   = useState(0)     // -100..100, snaps to 0
  const [directTempMode,  setDirectTempMode]  = useState(false)
  const [glassDevMode,    setGlassDevMode]    = useState(false)
  const [showEnergyGraph, setShowEnergyGraph] = useState(false)
  const graphCanvasRef  = useRef(null)
  const graphDataRef    = useRef([])   // {e, t}[] — raw samples
  const graphDragRef    = useRef({ dragging: false, ox: 0, oy: 0 })
  const [graphPos, setGraphPos] = useState({ x: 0, y: 0, w: 300, h: 240, init: false })
  const [zone1End,        setZone1End]        = useState(400)
  const [zone2End,        setZone2End]        = useState(750)
  const [zone1Rate,       setZone1Rate]       = useState(2.0)
  const [zone2Rate,       setZone2Rate]       = useState(0.3)
  const [zone3Rate,       setZone3Rate]       = useState(1.5)
  const [baseEnergyRate,  setBaseEnergyRate]  = useState(200)
  const [boxState,        setBoxState]        = useState('sand')
  const [multiRadius,     setMultiRadius]     = useState(true)
  const [showBlobGlow,    setShowBlobGlow]    = useState(true)
  const [blobHue,         setBlobHue]         = useState(0)
  const [blobBright,      setBlobBright]      = useState(1.0)
  const [sandPaused,      setSandPaused]      = useState(false)

  const boxCanvasRef  = useRef(null)
  const miniCanvasRef = useRef(null)
  const boxSimRef = useRef({
    showBox: true, showStick: false, autoRotate: true, showMetaball: true, boxState: 'sand', multiRadius: true,
    showBlobGlow: true, blobHue: 0, blobBright: 1.0, sandPaused: false,
    temp: 25, floorMode: false, floorY: 0,
    energyInput: 0, directTempMode: false, showEnergyGraph: false,
    zone1End: 400, zone2End: 750,
    zone1Rate: 2.0, zone2Rate: 0.3, zone3Rate: 1.5,
    baseRate: 200, lastFrameTs: 0, lastTempUpdate: 0,
    box: null,
    mouse: { x: -400, y: -400 },
    stick: null, stickDrag: null,
  })
  const physRef = useRef({ particles: null, springs: null, accumulator: 0, prevTime: null, rigidBody: null })

  useEffect(() => {
    window.sandStats = () => {
      const grains = physRef.current?.sandParticles
      if (!grains?.length) { console.log('no sand'); return }
      const speeds = grains.map(g => Math.hypot(g.vx, g.vy))
      speeds.sort((a, b) => a - b)
      const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length
      const buckets = [0,1,2,5,10,20,50,Infinity]
      const hist = {}
      for (let i = 0; i < buckets.length - 1; i++) {
        const lo = buckets[i], hi = buckets[i+1]
        hist[`${lo}–${hi === Infinity ? '∞' : hi}`] = speeds.filter(s => s >= lo && s < hi).length
      }
      console.table({ mean: mean.toFixed(2), median: speeds[speeds.length>>1].toFixed(2), p95: speeds[Math.floor(speeds.length*0.95)].toFixed(2), max: speeds[speeds.length-1].toFixed(2) })
      console.table(hist)
    }
    return () => { delete window.sandStats }
  }, [])
  const glassVisualTypesRef = useRef(null)   // per-particle display color, assigned at init
  const presetIdRef  = useRef(presetId)
  const glassDkRef   = useRef(darkMode)

  // ── Shared temperature — single source of truth for both Glass and Melt tabs ──
  // Energy integration lives here (top-level RAF), not inside the Glass canvas loop.
  // Both tabs read sharedTempRef.current.temp; each drives its own physics from it.
  const sharedTempRef = useRef({ temp: 25, lastTs: 0, cumulativeEnergy: 0 })

  // Melt tab has its own independent temperature driven by its own energy input
  const meltTempRef = useRef({ temp: 25, lastTs: 0 })
  const meltSimRef  = useRef({
    energyInput: 0,
    baseRate: 200,
  })

  useEffect(() => { boxSimRef.current.boxState = boxState }, [boxState])
  useEffect(() => { boxSimRef.current.multiRadius = multiRadius }, [multiRadius])

  useEffect(() => {
    document.body.style.background = darkMode ? '#080808' : '#e8e3da'
    document.body.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    glassDkRef.current = darkMode
    return () => document.body.removeAttribute('data-theme')
  }, [darkMode])

  // dev mode: type "dev" to toggle
  useEffect(() => {
    let buf = ''
    const handler = e => {
      if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return
      buf = (buf + e.key.toLowerCase()).slice(-3)
      if (buf === 'dev') { setShowDev(d => !d); buf = '' }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    let raf
    function integrateTick(ts) {
      const s = boxSimRef.current
      const st = sharedTempRef.current
      st.lastTs = ts
      // Glass blob always tracks melt temperature
      st.temp = meltTempRef.current.temp
      s.temp  = st.temp
      raf = requestAnimationFrame(integrateTick)
    }
    raf = requestAnimationFrame(integrateTick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Melt tab temperature integration ─────────────────────────────────────
  useEffect(() => {
    let raf
    let tick = 0
    function integrateMelt(ts) {
      const s  = meltSimRef.current
      const st = meltTempRef.current
      const elapsed = st.lastTs ? Math.min((ts - st.lastTs) / 1000, 0.05) : 0
      st.lastTs = ts
      if (!boxSimRef.current.sandPaused && s.energyInput !== 0 && elapsed > 0) {
        const input      = s.energyInput
        const atFloor    = st.temp <= 0    && input < 0
        const atCeiling  = st.temp >= 2000 && input > 0
        if (!atFloor && !atCeiling) {
          st.temp = Math.max(0, Math.min(2000,
            st.temp + (input / 100) * s.baseRate * elapsed))
          if (++tick % 6 === 0) setMeltLocalTemp(Math.round(st.temp))
        }
      }
      raf = requestAnimationFrame(integrateMelt)
    }
    raf = requestAnimationFrame(integrateMelt)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Replay tick ───────────────────────────────────────────────────────────
  const handleReplayReady = useCallback(count => {
    setReplayFrameCount(count); setReplayFrame(null); setReplayPlaying(false)
  }, [])
  const handleTempUpdate   = useCallback(v => { setMeltLocalTemp(v); meltTempRef.current.temp = v }, [])
  const handleEnergyUpdate = useCallback((_ke, _pe, t) => setDerivedTemp(t), [])

  useEffect(() => {
    if (!replayPlaying) { cancelAnimationFrame(replayRafRef.current); return }
    let last = null
    const tick = ts => {
      if (last !== null && ts - last < 16) { replayRafRef.current = requestAnimationFrame(tick); return }
      last = ts
      setReplayFrame(f => {
        const next = (f ?? 0) + 1
        if (next >= replayFrameCount) { setReplayPlaying(false); return replayFrameCount - 1 }
        return next
      })
      replayRafRef.current = requestAnimationFrame(tick)
    }
    replayRafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(replayRafRef.current)
  }, [replayPlaying, replayFrameCount])

  const startCooling = useCallback(mode => {
    setReplayFrameCount(0); setReplayFrame(null); setReplayPlaying(false)
    setMeltHeatMode(null)
    setCoolingMode(m => {
      const next = m === mode ? null : mode
      meltSimRef.current.energyInput = next === 'fast' ? -100 : next === 'slow' ? -50 : 0
      return next
    })
  }, [])

  const toggleMeltHeat = useCallback(mode => {
    setCoolingMode(prev => { if (prev) meltSimRef.current.energyInput = 0; return null })
    setMeltHeatMode(prev => {
      const next = prev === mode ? null : mode
      meltSimRef.current.energyInput = next === 'fast' ? 100 : next === 'slow' ? 50 : 0
      return next
    })
  }, [])

  const handleBondCounts = useCallback(counts => {
    setBondCounts(counts)
    if (!initialBondCapturedRef.current && counts) {
      setInitialBondCounts(counts)
      initialBondCapturedRef.current = true
    }
  }, [])

  // ── Glass / box canvas loop — canvas always mounted so RAF never drops ────
  useEffect(() => {
    const canvas = boxCanvasRef.current
    if (!canvas) return

    // Fixed-size offscreens for sand (box-local coords, no resize needed)
    const sandGlowOff  = document.createElement('canvas')
    sandGlowOff.width  = BOX_SIZE; sandGlowOff.height = BOX_SIZE
    const sandMeltOff   = document.createElement('canvas')
    sandMeltOff.width   = BOX_SIZE; sandMeltOff.height = BOX_SIZE
    const smctx         = sandMeltOff.getContext('2d')
    const sandMeltCrisp = document.createElement('canvas')
    sandMeltCrisp.width = BOX_SIZE; sandMeltCrisp.height = BOX_SIZE
    const smctx2        = sandMeltCrisp.getContext('2d', { willReadFrequently: true })


    // Full-canvas offscreens for floor-mode metaball (canvas-sized, resize with viewport)
    const mFloorOff   = document.createElement('canvas')
    const mFloorCrisp = document.createElement('canvas')
    const sizeFloorCanvases = () => {
      const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600
      if (mFloorOff.width !== w || mFloorOff.height !== h) {
        mFloorOff.width = w;   mFloorOff.height = h
        mFloorCrisp.width = w; mFloorCrisp.height = h
      }
    }
    sizeFloorCanvases()

    canvas.width  = canvas.clientWidth
    canvas.height = canvas.clientHeight
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.clientWidth
      canvas.height = canvas.clientHeight
      sizeFloorCanvases()
    })
    ro.observe(canvas)

    const worldPos = e => {
      const r = canvas.getBoundingClientRect(), src = e.touches ? e.touches[0] : e
      return { wx: src.clientX - r.left, wy: src.clientY - r.top }
    }
    const getDrawScale = () => Math.min(canvas.width, canvas.height) * 0.82 / BOX_SIZE
    const cornersWorld = () => {
      const s = boxSimRef.current
      if (!s.box) return []
      const bcx = canvas.width / 2, bcy = canvas.height / 2
      const ds = getDrawScale()
      const c = Math.cos(s.box.boxAngle), si = Math.sin(s.box.boxAngle), H = BOX_SIZE / 2 * ds
      return [[-H,-H],[H,-H],[H,H],[-H,H]].map(([lx,ly]) => ({
        wx: bcx + lx*c - ly*si, wy: bcy + lx*si + ly*c
      }))
    }

    const onMouseMove = e => {
      const { wx, wy } = worldPos(e)
      const s = boxSimRef.current
      s.mouse.x = wx; s.mouse.y = wy
      if (s.box?.cornerDrag) {
        const bcx = canvas.width / 2, bcy = canvas.height / 2
        const mAngle = Math.atan2(wy - bcy, wx - bcx)
        const newAngle = s.box.cornerDrag.startBoxAngle + (mAngle - s.box.cornerDrag.startMouseAngle)
        s.box.boxAngularVel = newAngle - s.box.boxAngle
        s.box.boxAngle = newAngle
      }
      if (s.stickDrag && s.stick) {
        s.stick.x = wx - s.stickDrag.offsetX
        s.stick.y = wy - s.stickDrag.offsetY
      }
    }
    const onDown = e => {
      const { wx, wy } = worldPos(e)
      const s = boxSimRef.current
      s.mouse.x = wx; s.mouse.y = wy
      if (s.showBox) {
        const onCorner = cornersWorld().some(c => Math.hypot(c.wx - wx, c.wy - wy) < CORNER_R * getDrawScale())
        if (s.showStick && !onCorner) {
          if (!s.stick) s.stick = { x: wx, y: wy }
          s.stickDrag = { offsetX: wx - s.stick.x, offsetY: wy - s.stick.y }
          return
        }
        if (onCorner && s.box) {
          const bcx = canvas.width / 2, bcy = canvas.height / 2
          s.box.cornerDrag = {
            startMouseAngle: Math.atan2(wy - bcy, wx - bcx),
            startBoxAngle:   s.box.boxAngle,
          }
        }
      } else if (s.showStick) {
        // Floor mode — drag stick as landing surface
        if (!s.stick) s.stick = { x: wx, y: wy }
        s.stickDrag = { offsetX: wx - s.stick.x, offsetY: wy - s.stick.y }
      }
    }
    const onUp = () => {
      const s = boxSimRef.current
      if (s.box) s.box.cornerDrag = null
      s.stickDrag = null
    }

    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mousedown',  onDown)
    canvas.addEventListener('mouseup',    onUp)
    canvas.addEventListener('mouseleave', onUp)
    canvas.addEventListener('touchstart', onDown,      { passive: true })
    canvas.addEventListener('touchmove',  onMouseMove, { passive: true })
    canvas.addEventListener('touchend',   onUp)

    const ctx = canvas.getContext('2d')

    // Two offscreen canvases: raw blobs → crisp binary mask via blur+contrast
    const metaballOff = document.createElement('canvas')
    metaballOff.width  = BOX_SIZE
    metaballOff.height = BOX_SIZE
    const mctx = metaballOff.getContext('2d')

    const metaballCrisp = document.createElement('canvas')
    metaballCrisp.width  = BOX_SIZE
    metaballCrisp.height = BOX_SIZE
    const mctx2 = metaballCrisp.getContext('2d')

    // Separate mini offscreens for the blob-box preview (computed independently)
    const miniOff   = document.createElement('canvas')
    miniOff.width   = BOX_SIZE; miniOff.height = BOX_SIZE
    const miniCrisp = document.createElement('canvas')
    miniCrisp.width = BOX_SIZE; miniCrisp.height = BOX_SIZE
    const mictx     = miniOff.getContext('2d')
    const mictx2    = miniCrisp.getContext('2d', { willReadFrequently: true })

    let raf

    function frame(ts) {
      const s    = boxSimRef.current
      const phys = physRef.current

      // Frame-to-frame elapsed, independent of the physics accumulator
      const frameElapsed = s.lastFrameTs ? Math.min((ts - s.lastFrameTs) / 1000, 0.05) : 0
      s.lastFrameTs = ts

      // Keep s.temp in sync with shared temperature (energy integration runs in its own RAF)
      s.temp = sharedTempRef.current.temp

      // Sync display temp to React state (~20 fps throttle to avoid excessive re-renders)
      if (ts - s.lastTempUpdate > 50) {
        setGlassTemp(Math.round(s.temp))
        s.lastTempUpdate = ts
      }

      // Energy graph: collect sample + redraw graph canvas
      if (s.showEnergyGraph && frameElapsed > 0) {
        const data = graphDataRef.current
        data.push({ e: sharedTempRef.current.cumulativeEnergy, t: s.temp })
        const gc = graphCanvasRef.current
        if (gc) {
          if (gc.offsetWidth && gc.offsetHeight) {
            gc.width  = gc.offsetWidth
            gc.height = gc.offsetHeight
          }
          const gw = gc.width, gh = gc.height
          const gx = gc.getContext('2d')
          gx.clearRect(0, 0, gw, gh)
          gx.fillStyle = '#0e0e0e'
          gx.fillRect(0, 0, gw, gh)

          const PAD_L = 28, PAD_R = 8, PAD_T = 6, PAD_B = 14
          const plotW = gw - PAD_L - PAD_R, plotH = gh - PAD_T - PAD_B

          const E_MIN = -1200, E_MAX = 500, T_MIN = 0, T_MAX = 1500
          const N = data.length
          const toX = e  => PAD_L + (e  - E_MIN) / (E_MAX - E_MIN) * plotW
          const toY = t  => PAD_T + plotH - (t  - T_MIN) / (T_MAX - T_MIN) * plotH

          // Axes
          gx.strokeStyle = '#333'; gx.lineWidth = 1
          gx.strokeRect(PAD_L, PAD_T, plotW, plotH)

          // Grid lines
          gx.setLineDash([2, 4]); gx.strokeStyle = '#222'
          for (const tv of [200, 400, 600, 800, 1000, 1200]) {
            const py = toY(tv)
            gx.beginPath(); gx.moveTo(PAD_L, py); gx.lineTo(PAD_L + plotW, py); gx.stroke()
          }
          // Zero-energy vertical
          gx.strokeStyle = '#2c2c2c'
          gx.beginPath(); gx.moveTo(toX(0), PAD_T); gx.lineTo(toX(0), PAD_T + plotH); gx.stroke()
          gx.setLineDash([])

          // Temperature axis labels only
          gx.fillStyle = '#444'; gx.font = '9px monospace'; gx.textAlign = 'right'
          for (const tv of [200, 600, 1000, 1400]) {
            gx.fillText(tv, PAD_L - 3, toY(tv) + 3)
          }
          // Y axis title
          gx.fillStyle = '#555'; gx.font = '9px monospace'
          gx.save(); gx.translate(8, PAD_T + plotH / 2); gx.rotate(-Math.PI / 2)
          gx.textAlign = 'center'; gx.fillText('Temp °C', 0, 0); gx.restore()

          // Points: persistent, no fade
          gx.fillStyle = 'rgba(200,140,60,0.7)'
          for (let i = 0; i < N; i++) {
            gx.fillRect(toX(data[i].e) - 1, toY(data[i].t) - 1, 2, 2)
          }
          // Current point highlight
          if (N > 0) {
            const last = data[N - 1]
            gx.fillStyle = '#ffcc66'
            gx.beginPath(); gx.arc(toX(last.e), toY(last.t), 3, 0, Math.PI * 2); gx.fill()
          }
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (s.showBox) {
        if (!s.box) s.box = { boxAngle: 0, boxAngularVel: 0, cornerDrag: null }
        if (s.floorMode) {
          // Returning from floor mode — reset to fresh particle state
          phys.particles = null; phys.springs = null; phys.rigidBody = null
          phys.prevTime = null;  phys.accumulator = 0; s.floorMode = false
        }
        const box = s.box
        const HS  = BOX_SIZE / 2
        const bcx = canvas.width / 2, bcy = canvas.height / 2

        if (s.boxState === 'sand') {
          if (!phys.sandParticles) {
            const pr = PRESETS.find(x => x.id === presetIdRef.current) ?? PRESETS[0]
            phys.sandParticles = initSandParticles(HS, s.multiRadius, pr.na2o, pr.nGrains ?? 1800)
            phys.nNaOriginal = phys.sandParticles.filter(g => g.type === 'na').length
            phys.meldCount = 0
            phys.naBlobs = []
            phys.blobMct = {}
            phys.accumulator = 0
            phys.prevTime = ts
          }
        } else {
          if (!phys.particles) {
            phys.particles = initParticles()
            phys.springs   = new Map()
            phys.rigidBody = null
            phys.accumulator = 0
            phys.prevTime = ts
            const pr = PRESETS.find(x => x.id === presetIdRef.current) ?? PRESETS[0]
            glassVisualTypesRef.current = assignGlassTypes(phys.particles.length, pr.sio2, pr.na2o, pr.cao)
          }
        }

        const elapsed = Math.min((ts - phys.prevTime) / 1000, 0.05)
        phys.prevTime    = ts

        if (!box.cornerDrag) {
          if (s.autoRotate) {
            box.boxAngle += 0.1 * 2 * Math.PI * elapsed
          } else {
            box.boxAngle      += box.boxAngularVel
            box.boxAngularVel *= 0.94
          }
        }

        if (s.boxState === 'sand') {
          if (!phys.naBlobs) phys.naBlobs = []
          if (!phys.blobMct) phys.blobMct = {}
          if (!s.sandPaused) {
            phys.accumulator += elapsed
            while (phys.accumulator >= FIXED_DT) {
              stepNaBlobSprings(phys.naBlobs, FIXED_DT, box.boxAngle, s.temp)
              stepSandPhysics(phys.sandParticles, FIXED_DT, HS, box.boxAngle)
              checkNaBlobMerges(phys.naBlobs, phys.blobMct, phys.sandParticles, s.temp)
              phys.accumulator -= FIXED_DT
            }
            // Na₂O grain merging — once per visual frame, only for soda preset
            const isSoda = presetIdRef.current === 'soda'
            if (isSoda && phys.sandParticles && phys.nNaOriginal > 0) {
              const tempFactor = Math.max(0, Math.min(1, (s.temp - 700) / 500))
              const meldFrac   = Math.min(1, phys.meldCount / phys.nNaOriginal)
              const meldProb   = tempFactor >= 1 ? 1 : tempFactor * 0.015 * (1 + meldFrac * 5)
              if (meldProb > 0) {
                phys.meldCount += mergeSodaGrains(phys.sandParticles, meldProb)
              }
              convertLargeNaGrains(phys.sandParticles, phys.naBlobs)
              absorbNearbyGrains(phys.sandParticles, phys.naBlobs, s.temp)
              // Na + Sand → silicate (> 1000°C); silicate + silicate (> 1200°C)
              const siFactor  = Math.max(0, Math.min(1, (s.temp - 1000) / 200))
              const silFactor = Math.max(0, Math.min(1, (s.temp - 1200) / 200))
              const naSandProb = siFactor * 0.004
              const silSilProb = silFactor * 0.004
              mergeSilicateGrains(phys.sandParticles, naSandProb, silSilProb, 3)
            }
          }
        } else {
          // Freeze/unfreeze transition
          const frozen = s.temp <= T_RIGID
          if (frozen && !phys.rigidBody) {
            phys.rigidBody = freezeParticles(phys.particles)
            phys.springs   = new Map()
          } else if (!frozen && phys.rigidBody) {
            syncParticlesToRigidBody(phys.particles, phys.rigidBody)
            phys.rigidBody = null
          }

          phys.accumulator += elapsed
          while (phys.accumulator >= FIXED_DT) {
            if (phys.rigidBody) {
              stepRigidBody(phys.rigidBody, FIXED_DT, HS, box.boxAngle)
              syncParticlesToRigidBody(phys.particles, phys.rigidBody)
            } else {
              stepPhysics(phys.particles, phys.springs, FIXED_DT, HS, box.boxAngle, s.temp)
            }
            phys.accumulator -= FIXED_DT
          }
        }

        // Visual scale: fill the available canvas with the box
        const drawScale = getDrawScale()

        // Box clip (no pre-fill — background drawn behind blob after colorize)
        ctx.save()
        ctx.translate(bcx, bcy); ctx.rotate(box.boxAngle); ctx.scale(drawScale, drawScale)
        ctx.beginPath(); ctx.rect(-HS, -HS, BOX_SIZE, BOX_SIZE); ctx.clip()

        if (s.boxState === 'sand') {
          // 0 at 300°C → gradual, ~0.17 at 500°C, ~0.58 at 1000°C, 1.0 at 1500°C
          const heatT = Math.max(0, Math.min(1, (s.temp - 300) / 1200))
          const hotR = 255, hotG = Math.round(80 * Math.pow(heatT, 2)), hotB = 0
          const glowG = Math.round(140 * Math.pow(heatT, 2.5))

          ctx.fillStyle = '#161210'
          ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)

          const _isSoda   = presetIdRef.current === 'soda'
          // Na grains switch to metaball rendering at 700°C so they merge visually
          const _naAsMeta = _isSoda && s.temp >= 700

          // Heat glow pass — pure sand only
          if (heatT > 0 && !_isSoda) {
            const gc = sandGlowOff.getContext('2d')
            gc.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            gc.globalCompositeOperation = 'lighter'
            gc.fillStyle = `rgba(255,${glowG},0,${heatT * heatT * 0.35})`
            for (const g of phys.sandParticles) {
              gc.beginPath()
              gc.arc(g.x + HS, g.y + HS, g.r * 1.8, 0, Math.PI * 2)
              gc.fill()
            }
          }

          // Individual grain render — sand hexagons, plus Na circles when below melt temp
          ctx.lineWidth = 0.5
          for (const g of phys.sandParticles) {
            if (g.type === 'na-sub' || g.type === 'na-ctr') continue
            if (_naAsMeta && g.type === 'na') continue
            if (g.type === 'silicate') continue
            if (heatT > 0) {
              const blend = heatT * heatT * 0.6
              ctx.fillStyle = `rgb(${Math.round(g._cr + (hotR - g._cr) * blend)},${Math.round(g._cg + (hotG - g._cg) * blend)},${Math.round(g._cb + (hotB - g._cb) * blend)})`
            } else {
              ctx.fillStyle = g.color
            }
            ctx.beginPath()
            if (g.type === 'na') {
              ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
              ctx.closePath(); ctx.fill()
              ctx.strokeStyle = 'rgba(160,210,240,0.35)'; ctx.stroke()
            } else {
              for (let k = 0; k < 6; k++) {
                const a = g.angle + k * Math.PI / 3
                const hx = g.x + g.r * Math.cos(a), hy = g.y + g.r * Math.sin(a)
                k === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy)
              }
              ctx.closePath(); ctx.fill()
              ctx.strokeStyle = `rgba(0,0,0,0.35)`; ctx.stroke()
            }
          }

          if (heatT > 0 && !_isSoda) {
            ctx.filter = `blur(${Math.round(heatT * 12)}px)`
            ctx.globalCompositeOperation = 'lighter'
            ctx.drawImage(sandGlowOff, -HS, -HS, BOX_SIZE, BOX_SIZE)
            ctx.filter = 'none'
            ctx.globalCompositeOperation = 'source-over'
          }

          // Na and silicate grains: hard-edged solid circles, same gradual heat tint as sand
          if (_naAsMeta) {
            if (heatT > 0) {
              const blend = heatT * heatT * 0.6
              ctx.fillStyle = `rgb(${Math.round(220 + (hotR - 220) * blend)},${Math.round(238 + (hotG - 238) * blend)},${Math.round(248 * (1 - blend))})`
            } else {
              ctx.fillStyle = '#dceef8'
            }
            for (const g of phys.sandParticles) {
              if (g.type !== 'na' && g.type !== 'silicate') continue
              ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2); ctx.fill()
            }
          }

          // Na₂O blobs — solid fill + separate transparent glow overlay (same as sand)
          if (phys.naBlobs?.length) {
            const t = Math.max(0, Math.min(1, (s.temp - 700) / 500))

            // Pass 1A: sub-circle halos (additive) → crisp binary mask in smctx2
            smctx.globalCompositeOperation = 'source-over'
            smctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            smctx.globalCompositeOperation = 'lighter'
            for (const blob of phys.naBlobs) {
              for (const p of blob.particles) {
                if (p.type !== 'na-sub') continue
                const px = p.x + HS, py = p.y + HS
                const br = p.r * 8
                const grad = smctx.createRadialGradient(px, py, 0, px, py, br)
                grad.addColorStop(0,   'rgba(255,255,255,1.0)')
                grad.addColorStop(0.3, 'rgba(220,220,220,0.65)')
                grad.addColorStop(1,   'rgba(0,0,0,0)')
                smctx.fillStyle = grad
                smctx.beginPath(); smctx.arc(px, py, br, 0, Math.PI * 2); smctx.fill()
              }
            }
            smctx.globalCompositeOperation = 'source-over'

            // Pass 1B: contrast → near-binary mask, then hard-threshold alpha to true binary
            smctx2.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            smctx2.filter = 'contrast(9999)'
            smctx2.drawImage(sandMeltOff, 0, 0)
            smctx2.filter = 'none'
            const imgD = smctx2.getImageData(0, 0, BOX_SIZE, BOX_SIZE)
            const px = imgD.data
            for (let i = 3; i < px.length; i += 4) px[i] = px[i] > 64 ? 255 : 0
            smctx2.putImageData(imgD, 0, 0)

            // Pass 1C: colorize mask with solid fill color → draw onto scene
            smctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            smctx.drawImage(sandMeltCrisp, 0, 0)
            smctx.save()
            smctx.globalCompositeOperation = 'source-in'
            smctx.fillStyle = blobFillColor(s.temp)
            smctx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
            smctx.restore()
            ctx.filter = `hue-rotate(${s.blobHue}deg) brightness(${s.blobBright})`
            ctx.drawImage(sandMeltOff, -HS, -HS, BOX_SIZE, BOX_SIZE)
            ctx.filter = 'none'

            // Pass 2: soft glow overlay — blur the crisp mask, tint at low alpha, draw lighter
            if (s.showBlobGlow) {
              const glowBlur = Math.round(4 + 6 * t)
              smctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
              smctx.filter = `blur(${glowBlur}px)`
              smctx.drawImage(sandMeltCrisp, 0, 0)
              smctx.filter = 'none'
              smctx.save()
              smctx.globalCompositeOperation = 'source-in'
              smctx.fillStyle = blobGlowColor(s.temp)
              smctx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
              smctx.restore()
              ctx.filter = `hue-rotate(${s.blobHue}deg) brightness(${s.blobBright})`
              ctx.globalCompositeOperation = 'lighter'
              ctx.drawImage(sandMeltOff, -HS, -HS, BOX_SIZE, BOX_SIZE)
              ctx.filter = 'none'
              ctx.globalCompositeOperation = 'source-over'
            }

            // Pass 3: same heat glow as pure sand, using blob sub-circles as sources
            if (heatT > 0) {
              const gc = sandGlowOff.getContext('2d')
              gc.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
              gc.globalCompositeOperation = 'lighter'
              gc.fillStyle = `rgba(255,${glowG},0,${heatT * heatT * 0.35})`
              for (const blob of phys.naBlobs) {
                for (const p of blob.particles) {
                  if (p.type !== 'na-sub') continue
                  gc.beginPath()
                  gc.arc(p.x + HS, p.y + HS, p.r * 1.8, 0, Math.PI * 2)
                  gc.fill()
                }
              }
              ctx.filter = `blur(${Math.round(heatT * 12)}px)`
              ctx.globalCompositeOperation = 'lighter'
              ctx.drawImage(sandGlowOff, -HS, -HS, BOX_SIZE, BOX_SIZE)
              ctx.filter = 'none'
              ctx.globalCompositeOperation = 'source-over'
            }

            window._naBlobs = phys.naBlobs
            window._blobMct = phys.blobMct
          }
        } else if (s.showMetaball) {
          const t     = Math.max(0, Math.min(1, (s.temp - 25) / (1200 - 25)))
          const blobR = PARTICLE_R * 5

          // Step 1: raw gradient blobs on transparent offscreen (lighter = additive)
          mctx.globalCompositeOperation = 'source-over'
          mctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
          mctx.globalCompositeOperation = 'lighter'
          for (const p of phys.particles) {
            const px = p.x + HS, py = p.y + HS
            const g  = mctx.createRadialGradient(px, py, 0, px, py, blobR)
            g.addColorStop(0,    'rgba(255,255,255,1.0)')
            g.addColorStop(0.35, 'rgba(200,200,200,0.50)')
            g.addColorStop(1,    'rgba(0,0,0,0)')
            mctx.fillStyle = g
            mctx.beginPath(); mctx.arc(px, py, blobR, 0, Math.PI * 2); mctx.fill()
          }
          mctx.globalCompositeOperation = 'source-over'

          // Step 2: blur+contrast → crisp binary blob on transparent bg
          mctx2.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
          mctx2.filter = 'blur(4px) contrast(22)'
          mctx2.drawImage(metaballOff, 0, 0)
          mctx2.filter = 'none'

          // Step 3: colorize blob in metaballOff (already consumed above).
          // source-in paints glass color only where blob has alpha; outside stays transparent.
          mctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
          mctx.drawImage(metaballCrisp, 0, 0)
          mctx.save()
          mctx.globalCompositeOperation = 'source-in'
          mctx.fillStyle = glassColor(s.temp)
          mctx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
          mctx.restore()
          mctx.globalCompositeOperation = 'source-over'

          // Step 4: gray background — filled before the blob, never touches colorize
          ctx.fillStyle = '#888888'
          ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)

          // Step 5: draw colored blob over gray with glow halo
          ctx.save()
          ctx.shadowColor = glassGlowColor(s.temp)
          ctx.shadowBlur  = Math.round(4 + 26 * t)
          ctx.drawImage(metaballOff, -HS, -HS, BOX_SIZE, BOX_SIZE)
          ctx.restore()
        } else {
          ctx.fillStyle = '#888888'
          ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
          const vtypes = glassVisualTypesRef.current
          for (let i = 0; i < phys.particles.length; i++) {
            const p = phys.particles[i]
            const vt = vtypes ? vtypes[i] : 1
            ctx.fillStyle = GLASS_TYPE_COLORS[vt]
            ctx.globalAlpha = 0.87
            ctx.beginPath(); ctx.arc(p.x, p.y, GLASS_TYPE_R[vt], 0, Math.PI * 2); ctx.fill()
          }
          ctx.globalAlpha = 1
        }

        ctx.restore()

        // Subtle glass container border
        ctx.save()
        ctx.translate(bcx, bcy); ctx.rotate(box.boxAngle); ctx.scale(drawScale, drawScale)
        ctx.strokeStyle = 'rgba(180,200,220,0.22)'; ctx.lineWidth = 1.5 / drawScale
        ctx.strokeRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
        ctx.restore()

        // Non-sand entity count — diagnostic HUD
        if (s.boxState === 'sand' && phys.sandParticles) {
          let nNa = 0, nSil = 0, nSub = 0, nSand = 0
          for (const g of phys.sandParticles) {
            if (g.type === 'na') nNa++
            else if (g.type === 'silicate') nSil++
            else if (g.type === 'na-sub') nSub++
            else if (g.type === 'sand') nSand++
          }
          const nBlobs = phys.naBlobs?.length ?? 0
          const lines = [
            `sand:       ${nSand}`,
            `free na:    ${nNa}`,
            `silicate:   ${nSil}`,
            `in blobs:   ${nSub}`,
            `sil blobs:  ${nBlobs}`,
          ]
          ctx.save()
          ctx.font = '11px monospace'
          ctx.textAlign = 'left'
          const x0 = bcx - BOX_SIZE * drawScale / 2
          const y0 = bcy + BOX_SIZE * drawScale / 2 + 14
          lines.forEach((ln, i) => {
            ctx.fillStyle = 'rgba(0,0,0,0.55)'
            ctx.fillText(ln, x0 + 1, y0 + i * 14 + 1)
            ctx.fillStyle = i === 4 ? '#aaddff' : '#7a9080'
            ctx.fillText(ln, x0, y0 + i * 14)
          })
          ctx.restore()
        }

        // Stick
        if (s.showStick && s.stick) {
          const { x: sx, y: sy } = s.stick
          const dragging = !!s.stickDrag
          ctx.save()
          ctx.translate(sx, sy); ctx.rotate(-STICK_ANGLE)
          ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 6
          const sg = ctx.createLinearGradient(0, -4, 0, 4)
          sg.addColorStop(0,   '#d4a860'); sg.addColorStop(0.4, '#c09040'); sg.addColorStop(1, '#7a5020')
          ctx.fillStyle = sg
          ctx.beginPath(); ctx.roundRect(2, -3.5, STICK_LEN - 4, 7, 3); ctx.fill()
          ctx.shadowBlur = 0; ctx.fillStyle = '#4a2810'
          ctx.beginPath(); ctx.moveTo(2,-3.5); ctx.lineTo(-10,0); ctx.lineTo(2,3.5); ctx.closePath(); ctx.fill()
          ctx.fillStyle = dragging ? 'rgba(255,220,140,0.5)' : 'rgba(255,220,140,0.25)'
          ctx.beginPath(); ctx.roundRect(4, -3.5, STICK_LEN - 20, 2.5, 1); ctx.fill()
          ctx.restore()
          ctx.save()
          ctx.beginPath(); ctx.arc(sx, sy, dragging ? 5 : 3, 0, Math.PI * 2)
          ctx.fillStyle = dragging ? 'rgba(220,170,80,0.9)' : 'rgba(100,65,25,0.7)'; ctx.fill()
          ctx.restore()
        }
      } else {
        // Box is off — transition existing particles to floor mode, then run it

        if (phys.particles && !s.floorMode) {
          // Coming from box mode: unfreeze rigid body if needed, then transform
          // particles from box-local coordinates to canvas world coordinates.
          if (phys.rigidBody) {
            syncParticlesToRigidBody(phys.particles, phys.rigidBody)
            phys.rigidBody = null
          }
          const boxA = s.box ? s.box.boxAngle : 0
          const cosA = Math.cos(boxA), sinA = Math.sin(boxA)
          const bcx = canvas.width / 2, bcy = canvas.height / 2
          for (const p of phys.particles) {
            const wx  = bcx + p.x*cosA - p.y*sinA
            const wy  = bcy + p.x*sinA + p.y*cosA
            const wvx = p.vx*cosA - p.vy*sinA
            const wvy = p.vx*sinA + p.vy*cosA
            p.x = wx; p.y = wy; p.vx = wvx; p.vy = wvy; p.px = wx; p.py = wy
          }
          phys.springs = new Map()
          phys.accumulator = 0
          phys.prevTime = ts
          s.floorMode = true
          s.floorY = Math.round(canvas.height * 0.88)
          sizeFloorCanvases()
        }

        if (s.floorMode && phys.particles) {
          const elapsed = Math.min((ts - phys.prevTime) / 1000, 0.05)
          phys.prevTime = ts

          const stickA = s.showStick && s.stick ? s.stick : null
          const stickB = stickA ? {
            x: s.stick.x + STICK_LEN * Math.cos(STICK_ANGLE),
            y: s.stick.y - STICK_LEN * Math.sin(STICK_ANGLE),
          } : null
          phys.accumulator += elapsed
          while (phys.accumulator >= FIXED_DT) {
            stepFloorPhysics(phys.particles, phys.springs, FIXED_DT, s.floorY, canvas.width, s.temp, stickA, stickB)
            phys.accumulator -= FIXED_DT
          }

          // Black background — multiply colorize needs an opaque base or it tints transparent pixels
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, canvas.width, canvas.height)

          // Floor surface — same material as box walls
          ctx.save()
          ctx.fillStyle = '#0c0905'
          ctx.fillRect(0, s.floorY, canvas.width, canvas.height - s.floorY)
          ctx.beginPath(); ctx.moveTo(0, s.floorY); ctx.lineTo(canvas.width, s.floorY)
          ctx.strokeStyle = 'rgba(200,170,120,0.85)'; ctx.lineWidth = 3; ctx.stroke()
          ctx.restore()

          // Glass blob — metaball or particle dots
          if (s.showMetaball) {
            const t     = Math.max(0, Math.min(1, (s.temp - 25) / (1200 - 25)))
            const blobR = PARTICLE_R * 5
            const fctx  = mFloorOff.getContext('2d')
            const fctx2 = mFloorCrisp.getContext('2d')
            fctx.globalCompositeOperation = 'source-over'
            fctx.clearRect(0, 0, mFloorOff.width, mFloorOff.height)
            fctx.globalCompositeOperation = 'lighter'
            for (const p of phys.particles) {
              const g = fctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, blobR)
              g.addColorStop(0,    'rgba(255,255,255,1.0)')
              g.addColorStop(0.35, 'rgba(200,200,200,0.50)')
              g.addColorStop(1,    'rgba(0,0,0,0)')
              fctx.fillStyle = g
              fctx.beginPath(); fctx.arc(p.x, p.y, blobR, 0, Math.PI * 2); fctx.fill()
            }
            fctx.globalCompositeOperation = 'source-over'
            fctx2.clearRect(0, 0, mFloorCrisp.width, mFloorCrisp.height)
            fctx2.filter = 'blur(4px) contrast(22)'
            fctx2.drawImage(mFloorOff, 0, 0)
            fctx2.filter = 'none'
            ctx.save()
            ctx.shadowColor = glassGlowColor(s.temp)
            ctx.shadowBlur  = Math.round(4 + 26 * t)
            ctx.drawImage(mFloorCrisp, 0, 0)
            ctx.restore()
            ctx.save()
            ctx.globalCompositeOperation = 'multiply'
            ctx.fillStyle = glassColor(s.temp)
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.restore()
          } else {
            const vtypes = glassVisualTypesRef.current
            for (let i = 0; i < phys.particles.length; i++) {
              const p = phys.particles[i]
              const vt = vtypes ? vtypes[i] : 1
              ctx.fillStyle = GLASS_TYPE_COLORS[vt]
              ctx.globalAlpha = 0.87
              ctx.beginPath(); ctx.arc(p.x, p.y, GLASS_TYPE_R[vt], 0, Math.PI * 2); ctx.fill()
            }
            ctx.globalAlpha = 1
          }

          // Stick — same amber material as floor/walls
          if (s.showStick && s.stick) {
            const { x: sx, y: sy } = s.stick
            const dragging = !!s.stickDrag
            ctx.save()
            ctx.translate(sx, sy); ctx.rotate(-STICK_ANGLE)
            ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 6
            const sg2 = ctx.createLinearGradient(0, -4, 0, 4)
            sg2.addColorStop(0,   '#d4a860')
            sg2.addColorStop(0.4, '#c09040')
            sg2.addColorStop(1,   '#7a5020')
            ctx.fillStyle = sg2
            ctx.beginPath(); ctx.roundRect(2, -3.5, STICK_LEN - 4, 7, 3); ctx.fill()
            ctx.shadowBlur = 0; ctx.fillStyle = '#4a2810'
            ctx.beginPath(); ctx.moveTo(2,-3.5); ctx.lineTo(-10,0); ctx.lineTo(2,3.5); ctx.closePath(); ctx.fill()
            ctx.fillStyle = dragging ? 'rgba(255,220,140,0.5)' : 'rgba(255,220,140,0.25)'
            ctx.beginPath(); ctx.roundRect(4, -3.5, STICK_LEN - 20, 2.5, 1); ctx.fill()
            ctx.restore()
            ctx.save()
            ctx.beginPath(); ctx.arc(sx, sy, dragging ? 5 : 3, 0, Math.PI * 2)
            ctx.fillStyle = dragging ? 'rgba(220,170,80,0.9)' : 'rgba(100,65,25,0.7)'; ctx.fill()
            ctx.restore()
          }
        } else if (!phys.particles) {
          s.floorMode = false
        }
      }

      // ── Mini blob preview (blob-box) ──────────────────────────────
      const mc = miniCanvasRef.current
      if (mc && s.showBox && (phys.particles?.length || phys.sandParticles?.length)) {
        const dpr = window.devicePixelRatio || 1
        const mW  = mc.clientWidth, mH = mc.clientHeight
        if (mW && mH) {
          const cW = Math.round(mW * dpr), cH = Math.round(mH * dpr)
          if (mc.width !== cW || mc.height !== cH) { mc.width = cW; mc.height = cH }
          const mx       = mc.getContext('2d')
          const HS       = BOX_SIZE / 2
          const fitSize  = Math.min(cW, cH) * 0.574
          const cx       = cW / 2, cy = cH / 2
          const boxAngle = s.box?.boxAngle ?? 0

          mx.clearRect(0, 0, cW, cH)
          mx.fillStyle = '#111'
          mx.fillRect(0, 0, cW, cH)

          if (s.boxState === 'sand') {
            const heatT  = Math.max(0, Math.min(1, (s.temp - 300) / 1200))
            const hotR   = 255, hotG = Math.round(80 * Math.pow(heatT, 2))
            const glowG  = Math.round(140 * Math.pow(heatT, 2.5))
            const _isSoda   = presetIdRef.current === 'soda'
            const _naAsMeta = _isSoda && s.temp >= 700
            const scale  = fitSize / BOX_SIZE

            // Background + sand grains
            mx.save()
            mx.translate(cx, cy); mx.rotate(boxAngle)
            mx.fillStyle = '#161210'
            mx.fillRect(-fitSize / 2, -fitSize / 2, fitSize, fitSize)
            mx.lineWidth = 0.4
            for (const g of phys.sandParticles) {
              if (g.type === 'na-sub' || g.type === 'na-ctr') continue
              if (heatT > 0) {
                const blend = heatT * heatT * 0.6
                mx.fillStyle = `rgb(${Math.round(g._cr + (hotR - g._cr) * blend)},${Math.round(g._cg + (hotG - g._cg) * blend)},${Math.round(g._cb * (1 - blend))})`
              } else {
                mx.fillStyle = g.color
              }
              const gr = Math.max(1.2, g.r * scale)
              mx.beginPath()
              if (g.type === 'na') {
                mx.arc(g.x * scale, g.y * scale, gr, 0, Math.PI * 2)
                mx.closePath(); mx.fill()
                mx.strokeStyle = 'rgba(160,210,240,0.3)'; mx.stroke()
              } else {
                for (let k = 0; k < 6; k++) {
                  const a = g.angle + k * Math.PI / 3
                  const hx = g.x * scale + gr * Math.cos(a), hy = g.y * scale + gr * Math.sin(a)
                  k === 0 ? mx.moveTo(hx, hy) : mx.lineTo(hx, hy)
                }
                mx.closePath(); mx.fill()
                mx.strokeStyle = 'rgba(0,0,0,0.3)'; mx.stroke()
              }
            }
            mx.restore()

            // Na₂O blobs — same metaball pipeline as the main view
            if (phys.naBlobs?.length && s.temp >= 700) {
              // Pass 1A: additive halos → miniOff
              mictx.globalCompositeOperation = 'source-over'
              mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
              mictx.globalCompositeOperation = 'lighter'
              for (const blob of phys.naBlobs) {
                for (const p of blob.particles) {
                  if (p.type !== 'na-sub') continue
                  const px = p.x + HS, py = p.y + HS
                  const br = p.r * 8
                  const grad = mictx.createRadialGradient(px, py, 0, px, py, br)
                  grad.addColorStop(0,   'rgba(255,255,255,1.0)')
                  grad.addColorStop(0.3, 'rgba(220,220,220,0.65)')
                  grad.addColorStop(1,   'rgba(0,0,0,0)')
                  mictx.fillStyle = grad
                  mictx.beginPath(); mictx.arc(px, py, br, 0, Math.PI * 2); mictx.fill()
                }
              }
              mictx.globalCompositeOperation = 'source-over'

              // Pass 1B: hard-threshold alpha to true binary mask
              mictx2.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
              mictx2.filter = 'contrast(9999)'
              mictx2.drawImage(miniOff, 0, 0)
              mictx2.filter = 'none'
              const imgD = mictx2.getImageData(0, 0, BOX_SIZE, BOX_SIZE)
              const pxd  = imgD.data
              for (let i = 3; i < pxd.length; i += 4) pxd[i] = pxd[i] > 64 ? 255 : 0
              mictx2.putImageData(imgD, 0, 0)

              // Pass 1C: colorize solid fill
              mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
              mictx.drawImage(miniCrisp, 0, 0)
              mictx.save()
              mictx.globalCompositeOperation = 'source-in'
              mictx.fillStyle = blobFillColor(s.temp)
              mictx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
              mictx.restore()
              mx.save()
              mx.translate(cx, cy); mx.rotate(boxAngle)
              mx.filter = `hue-rotate(${s.blobHue}deg) brightness(${s.blobBright})`
              mx.drawImage(miniOff, -fitSize / 2, -fitSize / 2, fitSize, fitSize)
              mx.filter = 'none'
              mx.restore()

              // Pass 2: glow overlay
              if (s.showBlobGlow) {
                const tBlob   = Math.max(0, Math.min(1, (s.temp - 700) / 500))
                const glowBlur = Math.round(4 + 6 * tBlob)
                mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
                mictx.filter = `blur(${glowBlur}px)`
                mictx.drawImage(miniCrisp, 0, 0)
                mictx.filter = 'none'
                mictx.save()
                mictx.globalCompositeOperation = 'source-in'
                mictx.fillStyle = blobGlowColor(s.temp)
                mictx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
                mictx.restore()
                mx.save()
                mx.translate(cx, cy); mx.rotate(boxAngle)
                mx.filter = `hue-rotate(${s.blobHue}deg) brightness(${s.blobBright})`
                mx.globalCompositeOperation = 'lighter'
                mx.drawImage(miniOff, -fitSize / 2, -fitSize / 2, fitSize, fitSize)
                mx.filter = 'none'
                mx.globalCompositeOperation = 'source-over'
                mx.restore()
              }

              // Pass 3: heat glow (same orange-red additive halo as sand)
              if (heatT > 0) {
                mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
                mictx.globalCompositeOperation = 'lighter'
                mictx.fillStyle = `rgba(255,${glowG},0,${heatT * heatT * 0.35})`
                for (const blob of phys.naBlobs) {
                  for (const p of blob.particles) {
                    if (p.type !== 'na-sub') continue
                    mictx.beginPath()
                    mictx.arc(p.x + HS, p.y + HS, p.r * 1.8, 0, Math.PI * 2)
                    mictx.fill()
                  }
                }
                mictx.globalCompositeOperation = 'source-over'
                mx.save()
                mx.translate(cx, cy); mx.rotate(boxAngle)
                mx.filter = `blur(${Math.round(heatT * 12)}px)`
                mx.globalCompositeOperation = 'lighter'
                mx.drawImage(miniOff, -fitSize / 2, -fitSize / 2, fitSize, fitSize)
                mx.filter = 'none'
                mx.globalCompositeOperation = 'source-over'
                mx.restore()
              }
            }
          } else {
            const t     = Math.max(0, Math.min(1, (s.temp - 25) / (1200 - 25)))
            const blobR = PARTICLE_R * 5

            // Step 1: raw gradient blobs
            mictx.globalCompositeOperation = 'source-over'
            mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            mictx.globalCompositeOperation = 'lighter'
            for (const p of phys.particles) {
              const px = p.x + HS, py = p.y + HS
              const g  = mictx.createRadialGradient(px, py, 0, px, py, blobR)
              g.addColorStop(0,    'rgba(255,255,255,1.0)')
              g.addColorStop(0.35, 'rgba(200,200,200,0.50)')
              g.addColorStop(1,    'rgba(0,0,0,0)')
              mictx.fillStyle = g
              mictx.beginPath(); mictx.arc(px, py, blobR, 0, Math.PI * 2); mictx.fill()
            }
            mictx.globalCompositeOperation = 'source-over'

            // Step 2: blur+contrast → crisp binary blob
            mictx2.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            mictx2.filter = 'blur(4px) contrast(22)'
            mictx2.drawImage(miniOff, 0, 0)
            mictx2.filter = 'none'

            // Step 3: colorize blob in miniOff.
            mictx.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
            mictx.drawImage(miniCrisp, 0, 0)
            mictx.save()
            mictx.globalCompositeOperation = 'source-in'
            mictx.fillStyle = glassColor(s.temp)
            mictx.fillRect(0, 0, BOX_SIZE, BOX_SIZE)
            mictx.restore()
            mictx.globalCompositeOperation = 'source-over'

            // Step 4: gray inside box
            mx.save()
            mx.translate(cx, cy); mx.rotate(boxAngle)
            mx.fillStyle = '#888888'
            mx.fillRect(-fitSize / 2, -fitSize / 2, fitSize, fitSize)
            mx.restore()

            // Step 5: blob with glow
            mx.save()
            mx.translate(cx, cy); mx.rotate(boxAngle)
            mx.shadowColor = glassGlowColor(s.temp)
            mx.shadowBlur  = Math.round((4 + 26 * t) * fitSize / BOX_SIZE)
            mx.drawImage(miniOff, -fitSize / 2, -fitSize / 2, fitSize, fitSize)
            mx.restore()
          }

          // Box outline (both states)
          mx.save()
          mx.translate(cx, cy); mx.rotate(boxAngle)
          mx.strokeStyle = 'rgba(180,200,220,0.30)'
          mx.lineWidth   = 1.5
          mx.strokeRect(-fitSize / 2, -fitSize / 2, fitSize, fitSize)
          mx.restore()
        }
      }

      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('mousemove',  onMouseMove)
      canvas.removeEventListener('mousedown',  onDown)
      canvas.removeEventListener('mouseup',    onUp)
      canvas.removeEventListener('mouseleave', onUp)
      canvas.removeEventListener('touchstart', onDown)
      canvas.removeEventListener('touchmove',  onMouseMove)
      canvas.removeEventListener('touchend',   onUp)
      ro.disconnect()
    }
  }, [])

  const onBoxChange = useCallback(e => {
    const v = e.target.checked
    setShowBox(v); boxSimRef.current.showBox = v
  }, [])
  const onStickChange = useCallback(e => {
    const v = e.target.checked
    setShowStick(v); boxSimRef.current.showStick = v
    if (!v) { boxSimRef.current.stick = null; boxSimRef.current.stickDrag = null }
  }, [])
  const onAutoRotateChange = useCallback(e => {
    const v = e.target.checked
    setAutoRotate(v); boxSimRef.current.autoRotate = v
  }, [])
  const onMetaballChange = useCallback(e => {
    const v = e.target.checked
    setShowMetaball(v); boxSimRef.current.showMetaball = v
  }, [])
  const onDirectTempChange = useCallback(e => {
    const v = e.target.checked
    setDirectTempMode(v); boxSimRef.current.directTempMode = v
  }, [])
  const onDirectTempSlide = useCallback(e => {
    const v = +e.target.value
    setGlassTemp(v); boxSimRef.current.temp = v; sharedTempRef.current.temp = v
  }, [])
  const onEnergyInChange = useCallback(e => {
    const v = +e.target.value
    setGlassEnergyIn(v); boxSimRef.current.energyInput = v
  }, [])
  const onEnergyRelease = useCallback(() => {
    setGlassEnergyIn(0); boxSimRef.current.energyInput = 0
  }, [])
  const onMeltEnergyChange  = useCallback(e => {
    const v = +e.target.value
    setMeltEnergyIn(v); meltSimRef.current.energyInput = v
  }, [])
  const onMeltEnergyRelease = useCallback(() => {
    setMeltEnergyIn(0); meltSimRef.current.energyInput = 0
  }, [])
  const onZone1EndChange   = useCallback(e => { const v = +e.target.value; setZone1End(v);       boxSimRef.current.zone1End = v    }, [])
  const onZone2EndChange   = useCallback(e => { const v = +e.target.value; setZone2End(v);       boxSimRef.current.zone2End = v    }, [])
  const onZone1RateChange  = useCallback(e => { const v = +e.target.value; setZone1Rate(v);      boxSimRef.current.zone1Rate = v   }, [])
  const onZone2RateChange  = useCallback(e => { const v = +e.target.value; setZone2Rate(v);      boxSimRef.current.zone2Rate = v   }, [])
  const onZone3RateChange  = useCallback(e => { const v = +e.target.value; setZone3Rate(v);      boxSimRef.current.zone3Rate = v   }, [])
  const onBaseRateChange   = useCallback(e => { const v = +e.target.value; setBaseEnergyRate(v); boxSimRef.current.baseRate = v    }, [])

  const onToggleEnergyGraph = useCallback(() => {
    setShowEnergyGraph(v => {
      const next = !v
      boxSimRef.current.showEnergyGraph = next
      if (next && !graphPos.init) {
        setGraphPos({
          x: window.innerWidth - 316,
          y: Math.round(window.innerHeight / 2) - 120,
          w: 300, h: 240, init: true,
        })
      }
      if (next) sharedTempRef.current.cumulativeEnergy = 0
      if (!next) graphDataRef.current = []
      return next
    })
  }, [graphPos.init])

  const onGraphMouseDown = useCallback(e => {
    const pos = graphPos
    graphDragRef.current = { dragging: true, ox: e.clientX - pos.x, oy: e.clientY - pos.y }
    const onMove = me => {
      if (!graphDragRef.current.dragging) return
      setGraphPos(p => ({ ...p, x: me.clientX - graphDragRef.current.ox, y: me.clientY - graphDragRef.current.oy }))
    }
    const onUp = () => { graphDragRef.current.dragging = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [graphPos])


  const p            = PRESETS.find(x => x.id === presetId)
  const switchPreset = id => {
    setCoolingMode(null); setPresetId(id)
    presetIdRef.current = id
    glassVisualTypesRef.current = null
    setBondCounts(null); setInitialBondCounts(null)
    initialBondCapturedRef.current = false
    physRef.current.sandParticles = null
    physRef.current.naBlobs = []
    physRef.current.blobMct = {}
    const box = boxSimRef.current.box
    if (box) { box.boxAngle = 0; box.boxAngularVel = 0 }
    meltSimRef.current.energyInput = 0
    meltTempRef.current.temp = 25
    setMeltLocalTemp(25)
  }

  const lcdStyle = { position:'relative', background:'#909e77', border:'1px solid rgba(100,90,70,0.5)', borderRadius:3, fontFamily:'"DSEG7","Courier New",monospace', fontSize:15, letterSpacing:'0.05em', lineHeight:1, userSelect:'none', flexShrink:0 }
  const dimTxt = { color: darkMode ? 'rgba(255,255,255,0.55)' : '#666', fontSize:11 }

  return (
    <div className="app">

      {/* ── Top bar: steel control panel (v4 style) ── */}
      <header className="top-bar">
        <div className="toolbar">
          {/* Corner bolts */}
          <div className="panel-bolt" style={{ top:9,    left:9  }} />
          <div className="panel-bolt" style={{ top:9,    right:9 }} />
          <div className="panel-bolt" style={{ bottom:9, left:9  }} />
          <div className="panel-bolt" style={{ bottom:9, right:9 }} />

          {/* Scrub slider — pinned at bottom of toolbar, melt tab only */}
          {tab === 'melt' && (
            <div style={{ position:'absolute', bottom:7, left:50, right:50, display:'flex', alignItems:'center' }}>
              <ScrubSlider
                value={replayFrameCount > 0 && replayFrame != null ? replayFrame / Math.max(1, replayFrameCount - 1) : 1}
                onChange={v => {
                  if (replayFrameCount > 0) { setReplayPlaying(false); setReplayFrame(Math.round(v * (replayFrameCount - 1))) }
                }}
                disabled={replayFrameCount === 0}
              />
            </div>
          )}

          {/* Tab strip */}
          <div style={{ display:'flex', justifyContent:'center', gap:2, marginBottom:5 }}>
            <button className={`tab-btn ${tab==='melt'?'active':''}`}     onClick={() => setTab('melt')}>Melt</button>
            <button className={`tab-btn ${tab==='networks'?'active':''}`} onClick={() => setTab('networks')}>Networks</button>
            <button className={`tab-btn ${tab==='glass'?'active':''}`}    onClick={() => setTab('glass')}>Glass</button>
          </div>

          {/* Action row */}
          <div style={{ display:'flex', alignItems:'flex-start', gap:4, paddingLeft:6, paddingRight:6 }}>
            {/* Left/center: two-row layout */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', gap:3, minWidth:0 }}>

              {/* Row 1: presets + composition label */}
              <div style={{ display:'flex', alignItems:'center', gap:4, minWidth:0 }}>
                <div style={{ display:'flex', gap:3 }}>
                  {PRESETS.map(preset => (
                    <button key={preset.id}
                      className={`preset-btn ${presetId===preset.id?'active':''}`}
                      onClick={() => switchPreset(preset.id)}
                    >{preset.label}</button>
                  ))}
                </div>
                <div style={{flex:1}} />
                <span style={{fontSize:11, color:'rgba(30,45,60,0.50)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap'}}>
                  SiO₂ {p.sio2}% · Na₂O {p.na2o}% · CaO {p.cao}%
                </span>
              </div>

              {/* Row 2: all tab-specific controls */}
              <div style={{ display:'flex', alignItems:'center', gap:4, minWidth:0, flexWrap:'wrap' }}>

                {/* Melt tab */}
                {tab === 'melt' && <>
                  <button className="action-btn replay-btn" style={{padding:'3px 10px', fontSize:12}}
                    disabled={replayFrameCount === 0}
                    onClick={() => { setReplayPlaying(false); setReplayFrame(0) }}>🐢 ↺</button>
                  <button className="action-btn replay-btn" style={{padding:'3px 10px', fontSize:12}}
                    disabled={replayFrameCount === 0}
                    onClick={() => { setReplayFrame(0); setReplayPlaying(true) }}>🐇 ↺</button>
                  <div className="toolbar-divider" />
                  <button className={`action-btn test-btn${meltHeatMode==='slow'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => toggleMeltHeat('slow')}>Slow Heat</button>
                  <button className={`action-btn test-btn${meltHeatMode==='fast'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => toggleMeltHeat('fast')}>Fast Heat</button>
                  <button className={`action-btn reset-btn${coolingMode==='slow'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => startCooling('slow')}>Slow Cool</button>
                  <button className={`action-btn reset-btn${coolingMode==='fast'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => startCooling('fast')}>Fast Cool</button>
                  <div className="toolbar-divider" />
                  <div style={lcdStyle}>
                    <span style={{visibility:'hidden', display:'block', padding:'3px 6px'}}>2000</span>
                    <span style={{position:'absolute', inset:0, padding:'3px 6px', color:'rgba(60,60,60,0.15)', textAlign:'right'}}>2000</span>
                    <span style={{position:'absolute', inset:0, padding:'3px 6px', color:'rgba(60,60,60,0.75)', textAlign:'right'}}>{meltLocalTemp}</span>
                  </div>
                  <span style={{fontSize:12, fontWeight:700, color:'rgba(30,45,60,0.70)'}}>°C</span>
                  <div style={{display:'flex', alignItems:'center', gap:3}}>
                    <span style={{color:'rgba(30,45,60,0.55)', fontSize:13}}>−</span>
                    <input type="range" style={{width:70, accentColor:'#c06040', cursor:'pointer'}}
                      min={-100} max={100} step={1} value={meltEnergyIn}
                      onChange={onMeltEnergyChange} onMouseUp={onMeltEnergyRelease} onTouchEnd={onMeltEnergyRelease} />
                    <span style={{color:'rgba(30,45,60,0.55)', fontSize:13}}>+</span>
                  </div>
                  <span style={{fontSize:13, lineHeight:1}}>🐢</span>
                  <input type="range" style={{width:55, cursor:'pointer', accentColor:'#6a9060'}}
                    min={0.05} max={0.5} step={0.025} value={simSpeed}
                    onChange={e => setSimSpeed(+e.target.value)} />
                  <span style={{fontSize:13, lineHeight:1}}>🐇</span>
                  <button className={`action-btn replay-btn${showGraphs?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => setShowGraphs(v => !v)}>Graphs</button>
                </>}

                {/* Glass tab */}
                {tab === 'glass' && <>
                  <button className={`action-btn test-btn${meltHeatMode==='slow'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => toggleMeltHeat('slow')}>Slow Heat</button>
                  <button className={`action-btn test-btn${meltHeatMode==='fast'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => toggleMeltHeat('fast')}>Fast Heat</button>
                  <button className={`action-btn reset-btn${coolingMode==='slow'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => startCooling('slow')}>Slow Cool</button>
                  <button className={`action-btn reset-btn${coolingMode==='fast'?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={() => startCooling('fast')}>Fast Cool</button>
                  <div style={lcdStyle}>
                    <span style={{visibility:'hidden', display:'block', padding:'3px 6px'}}>2000</span>
                    <span style={{position:'absolute', inset:0, padding:'3px 6px', color:'rgba(60,60,60,0.15)', textAlign:'right'}}>2000</span>
                    <span style={{position:'absolute', inset:0, padding:'3px 6px', color:'rgba(60,60,60,0.75)', textAlign:'right'}}>{meltLocalTemp}</span>
                  </div>
                  <span style={{fontSize:12, fontWeight:700, color:'rgba(30,45,60,0.70)'}}>°C</span>
                  <div className="toolbar-divider" />
                  <button className={`action-btn replay-btn${showBox?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}}
                    onClick={() => { const v=!showBox; setShowBox(v); boxSimRef.current.showBox=v }}>Box</button>
                  {showBox && <>
                    <button className={`action-btn replay-btn${showMetaball?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => { const v=!showMetaball; setShowMetaball(v); boxSimRef.current.showMetaball=v }}>Metaball</button>
                    <button className={`action-btn replay-btn${autoRotate?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => {
                        const v = !autoRotate; setAutoRotate(v); boxSimRef.current.autoRotate = v
                        if (!v && boxSimRef.current.box) boxSimRef.current.box.boxAngularVel = 0
                      }}>Rotate</button>
                    <button className={`action-btn replay-btn${showStick?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => { const v=!showStick; setShowStick(v); boxSimRef.current.showStick=v; if (!v) { boxSimRef.current.stick=null; boxSimRef.current.stickDrag=null } }}>Stick</button>
                    <button className={`action-btn replay-btn${multiRadius?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => {
                        const v = !multiRadius; setMultiRadius(v); boxSimRef.current.multiRadius = v
                        physRef.current.sandParticles = null
                      }}>Multi R</button>
                  </>}
                  <button className={`action-btn replay-btn${showEnergyGraph?' active':''}`}
                    style={{padding:'3px 9px', fontSize:11}} onClick={onToggleEnergyGraph}>E–T</button>
                  {presetId === 'soda' && <>
                    <div className="toolbar-divider" />
                    <button className={`action-btn replay-btn${sandPaused?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => { const v=!sandPaused; setSandPaused(v); boxSimRef.current.sandPaused=v }}>
                      {sandPaused ? 'Resume' : 'Pause'}
                    </button>
                    <button className="action-btn reset-btn"
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => {
                        physRef.current.sandParticles = null
                        physRef.current.naBlobs = []
                        physRef.current.blobMct = {}
                        physRef.current.meldCount = 0
                        setSandPaused(false); boxSimRef.current.sandPaused = false
                      }}>Reset</button>
                    <div className="toolbar-divider" />
                    <button className={`action-btn replay-btn${showBlobGlow?' active':''}`}
                      style={{padding:'3px 9px', fontSize:11}}
                      onClick={() => { const v=!showBlobGlow; setShowBlobGlow(v); boxSimRef.current.showBlobGlow=v }}>Glow</button>
                    <span style={{fontSize:11, color:'rgba(30,45,60,0.50)'}}>Hue</span>
                    <input type="range" style={{width:55, cursor:'pointer', accentColor:'#c87333'}}
                      min={-60} max={60} step={1} value={blobHue}
                      onChange={e => { const v=+e.target.value; setBlobHue(v); boxSimRef.current.blobHue=v }} />
                    <span style={{fontSize:11, color:'rgba(30,45,60,0.50)'}}>Bright</span>
                    <input type="range" style={{width:55, cursor:'pointer', accentColor:'#c87333'}}
                      min={0.3} max={2.0} step={0.05} value={blobBright}
                      onChange={e => { const v=+e.target.value; setBlobBright(v); boxSimRef.current.blobBright=v }} />
                  </>}
                </>}
              </div>

            </div>

            {/* Right: day/night + COUNT / CHARGE / FIELD */}
            <div style={{flexShrink:0, display:'flex', flexDirection:'column', alignItems:'center', gap:3}}>
              <div style={{display:'flex', alignItems:'center', gap:6}}>
                <span style={{fontSize:15, lineHeight:1, userSelect:'none', color:'#ffc020', display:'inline-block', width:18, textAlign:'center'}}>
                  {darkMode ? '☽' : '☀'}
                </span>
                <div onClick={() => setDarkMode(f => !f)} style={{
                  width:36, height:20, borderRadius:10, cursor:'pointer',
                  background: darkMode ? 'rgba(140,180,255,0.25)' : 'rgba(255,200,40,0.35)',
                  border:     darkMode ? '1px solid rgba(140,180,255,0.4)' : '1px solid rgba(200,150,20,0.45)',
                  position:'relative', transition:'background 0.2s, border-color 0.2s', flexShrink:0,
                }}>
                  <div style={{
                    width:14, height:14, borderRadius:7,
                    background: darkMode ? '#a0c0ff' : '#ffc020',
                    position:'absolute', top:2, left: darkMode ? 2 : 18,
                    transition:'left 0.2s, background 0.2s',
                    boxShadow: darkMode ? '0 0 6px rgba(160,200,255,0.9)' : '0 0 6px rgba(255,180,0,0.9)',
                  }} />
                </div>
              </div>
              <span style={{fontSize:11, fontWeight:700, letterSpacing:'0.09em', textTransform:'uppercase', color:'rgba(30,45,60,0.65)'}}>Visuals</span>
              <div style={{display:'flex', alignItems:'center', gap:3}}>
                <button className={`action-btn replay-btn${showCount?' active':''}`}
                  style={{padding:'3px 10px'}} onClick={() => setShowCount(f => !f)}>Count</button>
                <button className={`action-btn replay-btn${showCharge?' active':''}`}
                  style={{padding:'3px 10px'}} onClick={() => setShowCharge(f => !f)}>Charge</button>
                <button className={`action-btn replay-btn${showField?' active':''}`}
                  style={{padding:'3px 10px'}} onClick={() => setShowField(f => !f)}>Field</button>
              </div>
            </div>
          </div>
        </div>

        {/* Mini blob preview — click to switch to Glass tab */}
        <div className="blob-box" onClick={() => setTab('glass')} style={{cursor:'pointer', padding:0}}>
          <canvas ref={miniCanvasRef} style={{ display:'block', width:'100%', height:'100%' }} />
        </div>
      </header>

      {/* ── Main area ── */}
      <div className="main">

        {/* Left visuals panel — shown when any toggle is active */}
        {(showCount || showCharge || showField || showDev) && (
          <div className="viz-panel">

            {/* Particle key — goldenrod SiO₂ box + green Na₂O box, matching concrete v4 layout */}
            {/* Charge overlays on atom icons when showCharge; no separate charge section */}
            {(showCount || showCharge) && (() => {
              const labelStyle = { fontSize: 22, color: darkMode ? '#999' : '#666', fontFamily: 'system-ui, sans-serif' }
              const sio2Atoms = [
                { iconR: 6,   type: 'Si', label: <><b>Si</b> <sup>δ+</sup></> },
                { iconR: 4.5, type: 'O',  label: <><b>O</b>  <sup>δ−</sup></> },
              ]
              const na2oAtoms = [
                { iconR: 6,   type: 'Na', label: <><b>Na</b><sup>+</sup></> },
                { iconR: 4.5, type: 'O',  label: <><b>O</b> <sup>2−</sup></> },
              ]
              const groupGrid = atoms => (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 3 }}>
                  {atoms.map(({ iconR, type }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <GlassAtomIcon type={type} iconR={iconR} showCharge={showCharge} darkMode={darkMode} />
                    </div>
                  ))}
                  {atoms.map(({ label }, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                      <span style={labelStyle}>{label}</span>
                    </div>
                  ))}
                </div>
              )
              return (
                <div style={{ display: 'flex', flexShrink: 0, padding: '0 6px', gap: 6 }}>
                  <div style={{ flex: 1, border: '1.5px solid goldenrod', borderRadius: 4, padding: '4px 4px 2px', boxShadow: '0 0 0 1px rgba(0,0,0,0.6), 0 0 8px rgba(212,160,32,0.5)' }}>
                    {groupGrid(sio2Atoms)}
                    <div style={{ textAlign: 'center', fontSize: 10, color: 'goldenrod', fontFamily: 'system-ui, sans-serif', letterSpacing: '0.08em', marginTop: 2 }}>SiO₂</div>
                  </div>
                  <div style={{ flex: 1, border: '1.5px solid rgba(74,170,96,0.7)', borderRadius: 4, padding: '4px 4px 2px', boxShadow: '0 0 0 1px rgba(0,0,0,0.6), 0 0 8px rgba(74,170,96,0.35)' }}>
                    {groupGrid(na2oAtoms)}
                    <div style={{ textAlign: 'center', fontSize: 10, color: '#4aaa60', fontFamily: 'system-ui, sans-serif', letterSpacing: '0.08em', marginTop: 2 }}>Na₂O</div>
                  </div>
                </div>
              )
            })()}

            {/* Bond count table — mirrors concrete v4 layout */}
            {showCount && bondCounts && (() => {
              const initial = initialBondCounts ?? bondCounts
              const tested  = initialBondCounts !== null
              const cols = [
                { key: 'sio', label: 'Si-O', color: '#d4a020', typeA: 'Si', rA: 5,   typeB: 'O', rB: 3.5 },
                initial.nao.total > 0
                  ? { key: 'nao', label: 'Na-O', color: '#4aaa60', typeA: 'Na', rA: 4.5, typeB: 'O', rB: 3.5 }
                  : null,
                initial.cao.total > 0
                  ? { key: 'cao', label: 'Ca-O', color: '#4a96be', typeA: 'Ca', rA: 4.5, typeB: 'O', rB: 3.5 }
                  : null,
              ].filter(Boolean)

              const colData = cols.map(({ key, label, color, typeA, rA, typeB, rB }) => ({
                key, label, color, typeA, rA, typeB, rB,
                before: initial[key].intact,
                now:    bondCounts[key].intact,
                broken: Math.max(0, initial[key].intact - bondCounts[key].intact),
              }))
              const totalBroken = colData.reduce((s, d) => s + d.broken, 0)
              const gridCols = `42px ${cols.map(() => '0.9fr').join(' ')}`
              const rowLabelStyle = { fontSize: 13, letterSpacing: '0.07em', color: darkMode ? '#888' : '#666', fontFamily: 'system-ui, sans-serif' }

              return (
                <div style={{ padding: '2px 6px', display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {/* Column headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 0, alignItems: 'end', marginBottom: 4 }}>
                    <span />
                    {colData.map(({ key, label, color, typeA, rA, typeB, rB }) => (
                      <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                          <GlassAtomIcon type={typeA} iconR={rA} showCharge={showCharge} darkMode={darkMode} />
                          <span style={{ fontSize: 9, color: darkMode ? '#444' : '#bbb', lineHeight: 1 }}>—</span>
                          <GlassAtomIcon type={typeB} iconR={rB} showCharge={showCharge} darkMode={darkMode} />
                        </div>
                        <span style={{ fontSize: 12, color, letterSpacing: '0.04em', lineHeight: 1, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>{label}</span>
                      </div>
                    ))}
                  </div>
                  {/* Value rows */}
                  {[
                    { key: 'before', label: 'Before', getCell: d => ({ val: d.before }) },
                    { key: 'now',    label: 'Now',    getCell: d => ({ val: tested ? d.now : null }) },
                    { key: 'broken', label: 'Broken', getCell: d => ({
                      val: tested ? d.broken : null,
                      pct: tested && d.before > 0 ? d.broken / d.before * 100 : null,
                      bold: true,
                    }) },
                    { key: 'total', label: 'Total', getCell: d => ({
                      pct: tested && totalBroken > 0 ? d.broken / totalBroken * 100 : null,
                    }) },
                  ].map(({ key, label, getCell }) => (
                    <div key={key} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 0, alignItems: 'baseline', marginBottom: 3 }}>
                      <span style={rowLabelStyle}>{label}</span>
                      {colData.map(d => {
                        const { val, pct, bold } = getCell(d)
                        return (
                          <div key={d.key} style={{ textAlign: 'center' }}>
                            {val != null && <div style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums', color: d.color, fontWeight: bold ? 700 : 500, lineHeight: 1.1, fontFamily: 'system-ui, sans-serif' }}>{val}</div>}
                            {pct != null && <div style={{ fontSize: 17, color: d.color, opacity: 0.75, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1, fontFamily: 'system-ui, sans-serif' }}>{Math.round(pct)}%</div>}
                            {val == null && pct == null && <span style={{ fontSize: 21, color: darkMode ? '#333' : '#bbb', fontFamily: 'system-ui, sans-serif' }}>—</span>}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Bond strain gradient — same SVG as concrete v4 */}
            {showField && (
              <svg viewBox="0 0 200 50" width="100%" style={{ display: 'block', flexShrink: 0 }}>
                <defs>
                  <linearGradient id="gl-strain-grad" x1="0" x2="1" y1="0" y2="0">
                    {darkMode ? (<>
                      <stop offset="0%"   stopColor="rgb(200,196,188)" />
                      <stop offset="20%"  stopColor="rgb(195,90,255)" />
                      <stop offset="55%"  stopColor="rgb(240,30,225)" />
                      <stop offset="100%" stopColor="rgb(255,70,185)" />
                    </>) : (<>
                      <stop offset="0%"   stopColor="rgb(172,167,160)" />
                      <stop offset="20%"  stopColor="rgb(190,100,220)" />
                      <stop offset="55%"  stopColor="rgb(150,20,200)" />
                      <stop offset="100%" stopColor="rgb(255,40,160)" />
                    </>)}
                  </linearGradient>
                </defs>
                <text x="0" y="14" style={{ fontSize: '14px', fill: darkMode ? '#999' : '#666', fontFamily: 'system-ui, sans-serif' }}>Energy in fields:</text>
                <rect x="0" y="18" width="200" height="10" fill="url(#gl-strain-grad)" rx="1" />
                <text x="0"   y="44" style={{ fontSize: '16px', fill: darkMode ? '#666' : '#888', fontFamily: 'system-ui, sans-serif' }}>Low</text>
                <text x="200" y="44" style={{ fontSize: '16px', fill: darkMode ? '#666' : '#888', fontFamily: 'system-ui, sans-serif', textAnchor: 'end' }}>High</text>
              </svg>
            )}

            {showDev && <>
              <div className="viz-section-title">Dev (type "dev" to hide)</div>
              {tab === 'melt' && <>
                <div style={{fontSize:11, color:'#888', marginBottom:2}}>Si-O r₀: <span style={{color:'#a090d0'}}>{sioR0} px</span></div>
                <input type="range" style={{width:'100%', accentColor:'#8070c0', cursor:'pointer'}}
                  min={5} max={15} step={0.5} value={sioR0} onChange={e => setSioR0(+e.target.value)} />
                <div style={{fontSize:11, color:'#888', marginTop:6, marginBottom:2}}>Attract K: <span style={{color:'#a090d0'}}>{attractK===0?'off':attractK.toFixed(4)}</span></div>
                <input type="range" style={{width:'100%', accentColor:'#8070c0', cursor:'pointer'}}
                  min={0} max={0.02} step={0.0005} value={attractK} onChange={e => setAttractK(+e.target.value)} />
                <label style={{display:'flex', alignItems:'center', gap:4, fontSize:11, color:'rgba(255,255,255,0.42)', cursor:'pointer', marginTop:6, userSelect:'none'}}>
                  <input type="checkbox" checked={precompute} onChange={e => setPrecompute(e.target.checked)} style={{accentColor:'#8070c0', cursor:'pointer'}} />
                  Pre-Compute
                </label>
                <label style={{display:'flex', alignItems:'center', gap:4, fontSize:11, color:'rgba(255,255,255,0.42)', cursor:'pointer', marginTop:4, userSelect:'none'}}>
                  <input type="checkbox" checked={bondNums} onChange={e => setBondNums(e.target.checked)} style={{accentColor:'#8070c0', cursor:'pointer'}} />
                  Bond #s
                </label>
              </>}
              {tab === 'glass' && <>
                <label style={{display:'flex', alignItems:'center', gap:4, fontSize:11, color:'rgba(255,255,255,0.42)', cursor:'pointer', marginBottom:6, userSelect:'none'}}>
                  <input type="checkbox" checked={directTempMode} onChange={onDirectTempChange} style={{accentColor:'#4080c0', cursor:'pointer'}} />
                  Direct temp
                </label>
                {[
                  ['Z1 end', zone1End, '°', 100,700, 25, onZone1EndChange],
                  ['Z2 end', zone2End, '°', 400,1100,25, onZone2EndChange],
                  ['Rate Z1', zone1Rate, '×', 0.5,5.0,0.1, onZone1RateChange],
                  ['Rate Z2', zone2Rate, '×', 0.05,1.0,0.05, onZone2RateChange],
                  ['Rate Z3', zone3Rate, '×', 0.5,3.0,0.1, onZone3RateChange],
                  ['Base', baseEnergyRate, '°/s', 50,600,25, onBaseRateChange],
                ].map(([label, val, unit, mn, mx, st, cb]) => (
                  <div key={label}>
                    <div style={{fontSize:11, color:'#888', marginBottom:2}}>{label}: <span style={{color:'#a090d0'}}>{typeof val === 'number' && val % 1 !== 0 ? val.toFixed(val < 1 ? 2 : 1) : val}{unit}</span></div>
                    <input type="range" style={{width:'100%', accentColor:'#c8a060', cursor:'pointer', marginBottom:4}}
                      min={mn} max={mx} step={st} value={val} onChange={cb} />
                  </div>
                ))}
              </>}
            </>}
          </div>
        )}

        {/* Particle canvas area */}
        <div className="particle-area">
          {tab === 'melt' && (
            <CompositionView key="melt"
              sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao}
              sioR0={sioR0} attractK={attractK} debug={false}
              bondNums={bondNums} precompute={precompute}
              meltTemp={meltLocalTemp} simSpeed={simSpeed} coolingMode={coolingMode}
              onTempUpdate={handleTempUpdate} onEnergyUpdate={handleEnergyUpdate}
              onBondCounts={handleBondCounts}
              showGraphs={showGraphs}
              replayFrame={replayFrame} onReplayReady={handleReplayReady}
              darkMode={darkMode} showCharge={showCharge} showField={showField}
            />
          )}
          {tab === 'networks' && (
            <NetworksView sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao} />
          )}
          {/* Glass canvas — always mounted so RAF never restarts */}
          <div style={{ display: tab==='glass' ? 'flex' : 'none', flexDirection:'column', width:'100%', height:'100%' }}>
            <canvas ref={boxCanvasRef} style={{ flex:1, width:'100%', display:'block' }} />
          </div>
        </div>
        {/* Right spacer: matches blob-box visual column below the toolbar */}
        <div style={{ width:100, flexShrink:0, background:'#050505', borderLeft:'2px solid #4a5e6e' }} />
      </div>

      {/* ── Bottom scrub bar ── */}
      <div className="scrub-bar">
        {tab === 'melt' && replayFrameCount > 0 ? <>
          <button className={`action-btn replay-btn${replayPlaying?' active':''}`}
            style={{padding:'2px 9px', fontSize:11, marginRight:8}}
            onClick={() => { if (replayFrame===null) setReplayFrame(0); setReplayPlaying(p => !p) }}>
            {replayPlaying ? '■ Stop' : '▶ Play'}
          </button>
          <input type="range" className="replay-range"
            min={0} max={replayFrameCount-1} value={replayFrame ?? 0}
            onChange={e => { setReplayPlaying(false); setReplayFrame(+e.target.value) }} />
          <span style={{fontSize:11, color:'rgba(160,140,100,0.65)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap', marginLeft:8, flexShrink:0}}>
            {replayFrame ?? 0} / {replayFrameCount-1}
          </span>
          <button className="action-btn replay-btn" style={{padding:'2px 9px', fontSize:11, marginLeft:8}}
            onClick={() => setReplayFrame(null)}>Live</button>
        </> : (
          <span style={{fontSize:10, fontWeight:700, letterSpacing:'0.06em', color:'rgba(120,110,90,0.55)', marginLeft:'auto'}}>LIVE</span>
        )}
      </div>

      {/* Floating E–T graph */}
      {showEnergyGraph && (
        <div style={{
          position:'fixed', left:graphPos.x, top:graphPos.y,
          width:graphPos.w, height:graphPos.h,
          background:'#0e0d1e', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:6, boxShadow:'0 4px 24px rgba(0,0,0,0.7)',
          display:'flex', flexDirection:'column', zIndex:200,
          resize:'both', overflow:'hidden', minWidth:200, minHeight:160,
        }}
          onMouseMove={e => { if (e.target===e.currentTarget) return; const r=e.currentTarget; setGraphPos(p => ({...p, w:r.offsetWidth, h:r.offsetHeight})) }}
        >
          <div onMouseDown={onGraphMouseDown} style={{
            display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'4px 8px', background:'#12112a', borderBottom:'1px solid rgba(255,255,255,0.08)',
            cursor:'grab', userSelect:'none', flexShrink:0,
          }}>
            <span style={{fontSize:10, color:'rgba(255,255,255,0.35)', letterSpacing:'0.06em', textTransform:'uppercase'}}>Energy → Temp</span>
            <button onClick={() => { graphDataRef.current = [] }} style={{background:'none', border:'none', color:'rgba(255,255,255,0.35)', cursor:'pointer', fontSize:10, letterSpacing:'0.06em', textTransform:'uppercase', padding:'0 4px'}}>Reset</button>
            <button onClick={onToggleEnergyGraph} style={{background:'none', border:'none', color:'rgba(255,255,255,0.35)', cursor:'pointer', fontSize:13, lineHeight:1, padding:'0 2px'}}>×</button>
          </div>
          <canvas ref={graphCanvasRef} style={{flex:1, width:'100%', display:'block'}} />
        </div>
      )}

    </div>
  )
}
