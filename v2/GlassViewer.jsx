import { useState, useCallback, useEffect, useRef } from 'react'
import CompositionView from './CompositionView'
import NetworksView from './NetworksView'
import { initParticles, stepPhysics, stepFloorPhysics, PARTICLE_R, FIXED_DT, T_RIGID, freezeParticles, syncParticlesToRigidBody, stepRigidBody } from './glassPhysics.js'
import './GlassViewer.css'

const PRESETS = [
  { id: 'pure',     label: 'Pure SiO₂',         sio2: 100, na2o: 0,  cao: 0  },
  { id: 'soda',     label: 'High Na₂O',          sio2: 70,  na2o: 30, cao: 0  },
  { id: 'sodalime', label: 'Soda-lime glass',    sio2: 70,  na2o: 15, cao: 15 },
  { id: 'excess',   label: 'Too many additives', sio2: 50,  na2o: 25, cao: 25 },
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

// Temperature → glass fill color (blackbody-ish ramp for molten glass)
function glassColor(tempC) {
  const t = Math.max(0, Math.min(1, (tempC - 25) / (1200 - 25)))
  const stops = [
    [0.00, [50,  22,  8]],   // 25°C   — dark amber, barely visible
    [0.25, [148, 22,  5]],   // ~325°C — dark cherry red
    [0.45, [230, 72, 12]],   // ~560°C — orange-red
    [0.65, [255, 148, 28]],  // ~790°C — bright orange
    [0.85, [255, 218, 88]],  // ~1035°C — yellow-orange
    [1.00, [255, 252, 190]], // 1200°C — white-hot
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i-1][0]) / (stops[i][0] - stops[i-1][0])
      const [r1,g1,b1] = stops[i-1][1], [r2,g2,b2] = stops[i][1]
      return `rgb(${~~(r1+(r2-r1)*f)},${~~(g1+(g2-g1)*f)},${~~(b1+(b2-b1)*f)})`
    }
  }
  return 'rgb(255,252,190)'
}
const CORNER_R    = 26
const STICK_LEN   = 300
const STICK_ANGLE = 10 * Math.PI / 180

export default function GlassViewer() {
  const [tab, setTab]             = useState('melt')
  const [presetId, setPresetId]   = useState('pure')
  const [meltEnergyIn,   setMeltEnergyIn]   = useState(0)    // -100..100, snaps to 0
  const [meltLocalTemp,  setMeltLocalTemp]  = useState(25)   // melt tab's own temperature
  const [derivedTemp,    setDerivedTemp]    = useState(25)   // KE-measured temperature
  const [simSpeed, setSimSpeed]   = useState(0.5)
  const [sioR0, setSioR0]         = useState(9)
  const [attractK, setAttractK]   = useState(0.02)
  const [showDev, setShowDev]     = useState(false)
  const [showGraphs, setShowGraphs]   = useState(true)
  const [coolingMode, setCoolingMode] = useState(null)
  const [meltHeatMode, setMeltHeatMode] = useState(null)  // 'slow' | 'fast' | null
  const [precompute, setPrecompute]   = useState(true)
  const [bondNums, setBondNums]       = useState(false)
  const [replayFrameCount, setReplayFrameCount] = useState(0)
  const [replayFrame, setReplayFrame]     = useState(null)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const replayRafRef = useRef(null)

  // Glass tab controls
  const [showBox,      setShowBox]      = useState(true)
  const [showStick,    setShowStick]    = useState(false)
  const [autoRotate,   setAutoRotate]   = useState(false)
  const [showMetaball, setShowMetaball] = useState(false)
  const [glassTemp,       setGlassTemp]       = useState(25)
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

  const boxCanvasRef = useRef(null)
  const boxSimRef = useRef({
    showBox: true, showStick: false, autoRotate: false, showMetaball: false,
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

  useEffect(() => {
    let raf
    function integrateTick(ts) {
      const s = boxSimRef.current
      const st = sharedTempRef.current
      const elapsed = st.lastTs ? Math.min((ts - st.lastTs) / 1000, 0.05) : 0
      st.lastTs = ts
      if (!s.directTempMode && s.energyInput !== 0 && elapsed > 0) {
        const input = s.energyInput
        const atFloor = st.temp <= 25   && input < 0
        const atCeil  = st.temp >= 1200 && input > 0
        if (!atFloor && !atCeil) {
          const mult = st.temp < s.zone1End ? s.zone1Rate :
                       st.temp < s.zone2End ? s.zone2Rate : s.zone3Rate
          st.temp = Math.max(25, Math.min(1200,
            st.temp + (input / 100) * s.baseRate * mult * elapsed))
          s.temp = st.temp   // keep Glass RAF in sync
          st.cumulativeEnergy += (input / 100) * s.baseRate * elapsed
        }
      }
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
      if (s.energyInput !== 0 && elapsed > 0) {
        const input   = s.energyInput
        const atFloor = st.temp <= 0 && input < 0
        if (!atFloor) {
          st.temp = Math.max(0,
            st.temp + (input / 100) * s.baseRate * elapsed)
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
    setCoolingMode(m => m === mode ? null : mode)
  }, [])

  const toggleMeltHeat = useCallback(mode => {
    setMeltHeatMode(prev => {
      const next = prev === mode ? null : mode
      meltSimRef.current.energyInput = next === 'fast' ? 100 : next === 'slow' ? 50 : 0
      return next
    })
  }, [])

  // ── Glass / box canvas loop — canvas always mounted so RAF never drops ────
  useEffect(() => {
    const canvas = boxCanvasRef.current
    if (!canvas) return

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
    const cornersWorld = () => {
      const s = boxSimRef.current
      if (!s.box) return []
      const bcx = canvas.width / 2, bcy = canvas.height / 2
      const c = Math.cos(s.box.boxAngle), si = Math.sin(s.box.boxAngle), H = BOX_SIZE / 2
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
        const onCorner = cornersWorld().some(c => Math.hypot(c.wx - wx, c.wy - wy) < CORNER_R)
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

        if (!phys.particles) {
          phys.particles = initParticles()
          phys.springs   = new Map()
          phys.rigidBody = null
          phys.accumulator = 0
          phys.prevTime = ts
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

        // Box fill + clip
        ctx.save()
        ctx.translate(bcx, bcy); ctx.rotate(box.boxAngle)
        ctx.fillStyle = '#080604'
        ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
        ctx.beginPath(); ctx.rect(-HS, -HS, BOX_SIZE, BOX_SIZE); ctx.clip()

        if (s.showMetaball) {
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

          // Step 2: blur+contrast onto transparent canvas → crisp binary blob.
          // Transparent outside means the canvas shadow in step 3 only halos the
          // blob edge, not the whole canvas rectangle.
          mctx2.clearRect(0, 0, BOX_SIZE, BOX_SIZE)
          mctx2.filter = 'blur(4px) contrast(22)'
          mctx2.drawImage(metaballOff, 0, 0)
          mctx2.filter = 'none'

          // Step 3: draw crisp blob with canvas shadow for outer glow — same
          // technique as v1's shadowColor/shadowBlur on filled bezier paths.
          // Hard edge from contrast, gaussian halo from shadowBlur outside it.
          ctx.save()
          ctx.shadowColor = glassGlowColor(s.temp)
          ctx.shadowBlur  = Math.round(4 + 26 * t)
          ctx.drawImage(metaballCrisp, -HS, -HS, BOX_SIZE, BOX_SIZE)
          ctx.restore()

          // Step 4: colorize via multiply — white blob becomes glass color,
          // shadow halo gets tinted by the same ramp (bright at hot, dim at cold)
          ctx.save()
          ctx.globalCompositeOperation = 'multiply'
          ctx.fillStyle = glassColor(s.temp)
          ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
          ctx.restore()
        } else {
          ctx.fillStyle = 'rgba(255,140,40,0.85)'
          for (const p of phys.particles) {
            ctx.beginPath(); ctx.arc(p.x, p.y, PARTICLE_R, 0, Math.PI * 2); ctx.fill()
          }
        }

        ctx.restore()

        // Border + corners
        ctx.save()
        ctx.translate(bcx, bcy); ctx.rotate(box.boxAngle)
        ctx.strokeStyle = 'rgba(200,170,120,0.80)'; ctx.lineWidth = 3
        ctx.strokeRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
        ;[[-HS,-HS],[HS,-HS],[HS,HS],[-HS,HS]].forEach(([lx,ly]) => {
          ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(240,210,160,0.96)'; ctx.fill()
          ctx.strokeStyle = 'rgba(160,130,90,0.80)'; ctx.lineWidth = 1.5; ctx.stroke()
        })
        ctx.restore()

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
            ctx.fillStyle = 'rgba(255,140,40,0.85)'
            for (const p of phys.particles) {
              ctx.beginPath(); ctx.arc(p.x, p.y, PARTICLE_R, 0, Math.PI * 2); ctx.fill()
            }
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
  const switchPreset = id => { setCoolingMode(null); setPresetId(id) }

  return (
    <div className="viewer">
      <header className="top-bar">
        <div className="toolbar">

          <button className={`tab-btn ${tab === 'melt'     ? 'active' : ''}`} onClick={() => setTab('melt')}    >Melt</button>
          <button className={`tab-btn ${tab === 'networks' ? 'active' : ''}`} onClick={() => setTab('networks')}>Networks</button>
          <button className={`tab-btn ${tab === 'glass'    ? 'active' : ''}`} onClick={() => setTab('glass')}   >Glass</button>

          <div className="toolbar-divider" />

          {PRESETS.map(preset => (
            <button key={preset.id}
              className={`preset-btn ${presetId === preset.id ? 'active' : ''}`}
              onClick={() => switchPreset(preset.id)}
            >{preset.label}</button>
          ))}

          {tab === 'melt' && <>
            <div className="toolbar-divider" />
            <span style={{ fontSize: 11, color: '#555', userSelect: 'none' }}>−</span>
            <input type="range" className="temp-range" min={-100} max={100} step={1}
              value={meltEnergyIn}
              onChange={onMeltEnergyChange}
              onMouseUp={onMeltEnergyRelease}
              onTouchEnd={onMeltEnergyRelease}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 11, color: '#555', userSelect: 'none' }}>+</span>
            <div className="toolbar-divider" />
            <span className="toolbar-label">E:</span>
            <span className="temp-val">{meltLocalTemp}</span>
            <span className="toolbar-label">T:</span>
            <span className="temp-val">{derivedTemp}°C</span>
          </>}

          {tab === 'glass' && <>
            <div className="toolbar-divider" />
            <button className={`tab-btn ${showEnergyGraph ? 'active' : ''}`} onClick={onToggleEnergyGraph}>E–T Graph</button>
          </>}

          <span className="composition-tag">SiO₂ {p.sio2}% · Na₂O {p.na2o}% · CaO {p.cao}%</span>
        </div>

        {tab === 'melt' && (
          <div className="toolbar">
            <button className={`heat-btn ${meltHeatMode === 'slow' ? 'active' : ''}`} onClick={() => toggleMeltHeat('slow')}>Slow Heat</button>
            <button className={`heat-btn ${meltHeatMode === 'fast' ? 'active' : ''}`} onClick={() => toggleMeltHeat('fast')}>Fast Heat</button>
            <button className={`cool-btn ${coolingMode === 'slow'     ? 'active' : ''}`} onClick={() => startCooling('slow')}>Slow Cool</button>
            <button className={`cool-btn ${coolingMode === 'fast'     ? 'active' : ''}`} onClick={() => startCooling('fast')}>Fast Cool</button>
            <div className="toolbar-divider" />
            <span className="speed-label">🐢</span>
            <input type="range" className="speed-range" min={0.05} max={0.5} step={0.025} value={simSpeed} onChange={e => setSimSpeed(+e.target.value)} />
            <span className="speed-label">🐇</span>
            <div className="toolbar-divider" />
            <label className="dev-toggle"><input type="checkbox" checked={showGraphs} onChange={e => setShowGraphs(e.target.checked)} /> Graphs</label>
            <div className="toolbar-divider" />
            <label className="dev-toggle"><input type="checkbox" checked={showDev} onChange={e => setShowDev(e.target.checked)} /> dev</label>
          </div>
        )}
      </header>

      {tab === 'melt' && replayFrameCount > 0 && (
        <div className="replay-bar">
          <button className={`replay-btn ${replayPlaying ? 'active' : ''}`}
            onClick={() => { if (replayFrame === null) setReplayFrame(0); setReplayPlaying(p => !p) }}>
            {replayPlaying ? '■ Stop' : '▶ Replay'}
          </button>
          <input type="range" className="replay-range" min={0} max={replayFrameCount - 1}
            value={replayFrame ?? 0} onChange={e => { setReplayPlaying(false); setReplayFrame(+e.target.value) }} />
          <span className="replay-time">{replayFrame ?? 0} / {replayFrameCount - 1}</span>
          <button className="replay-btn" onClick={() => setReplayFrame(null)}>Live</button>
        </div>
      )}

      {tab === 'melt' && showDev && (
        <div className="dev-bar">
          <span className="toolbar-label">Si-O r₀</span>
          <input type="range" className="r0-range" min={5} max={15} step={0.5} value={sioR0} onChange={e => setSioR0(+e.target.value)} />
          <span className="r0-val">{sioR0} px</span>
          <div className="toolbar-divider" />
          <span className="toolbar-label">Cooling Attract</span>
          <input type="range" className="r0-range" min={0} max={0.02} step={0.0005} value={attractK} onChange={e => setAttractK(+e.target.value)} />
          <span className="r0-val">{attractK === 0 ? 'off' : attractK.toFixed(4)}</span>
          <div className="toolbar-divider" />
          <label className="dev-toggle"><input type="checkbox" checked={precompute} onChange={e => setPrecompute(e.target.checked)} /> Pre-Compute</label>
          <div className="toolbar-divider" />
          <label className="dev-toggle"><input type="checkbox" checked={bondNums} onChange={e => setBondNums(e.target.checked)} /> Bond #s</label>
        </div>
      )}

      <main className="micro-section">
        {/* Melt and Networks tabs */}
        {tab === 'melt' && (
          <CompositionView key="melt"
            sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao}
            sioR0={sioR0} attractK={attractK} debug={showDev}
            bondNums={bondNums} precompute={precompute}
            meltTemp={meltLocalTemp} simSpeed={simSpeed} coolingMode={coolingMode}
            onTempUpdate={handleTempUpdate} onEnergyUpdate={handleEnergyUpdate}
            showGraphs={showGraphs}
            replayFrame={replayFrame} onReplayReady={handleReplayReady}
          />
        )}
        {tab === 'networks' && (
          <NetworksView sio2Pct={p.sio2} na2oPct={p.na2o} caoPct={p.cao} />
        )}

        {/* Glass tab — canvas always mounted so RAF never restarts on tab switch */}
        <div style={{ display: tab === 'glass' ? 'flex' : 'none', flexDirection: 'column', width: '100%', height: '100%' }}>
          <canvas ref={boxCanvasRef} style={{ flex: 1, width: '100%', display: 'block' }} />

          {/* Glass dev bar */}
          {glassDevMode && (
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 24px', background:'#141414', borderTop:'1px solid #222', fontSize:11, color:'#777', flexShrink:0, flexWrap:'wrap' }}>
              <span>Z1 end</span>
              <input type="range" min={100} max={700} step={25} value={zone1End} onChange={onZone1EndChange} style={{ width:70 }} />
              <span style={{ color:'#c8a060', minWidth:34 }}>{zone1End}°</span>
              <div style={{ width:1, height:14, background:'#333' }} />
              <span>Z2 end</span>
              <input type="range" min={400} max={1100} step={25} value={zone2End} onChange={onZone2EndChange} style={{ width:70 }} />
              <span style={{ color:'#c8a060', minWidth:34 }}>{zone2End}°</span>
              <div style={{ width:1, height:14, background:'#333' }} />
              <span>Rate Z1</span>
              <input type="range" min={0.5} max={5.0} step={0.1} value={zone1Rate} onChange={onZone1RateChange} style={{ width:60 }} />
              <span style={{ color:'#c8a060', minWidth:26 }}>{zone1Rate.toFixed(1)}×</span>
              <div style={{ width:1, height:14, background:'#333' }} />
              <span>Rate Z2</span>
              <input type="range" min={0.05} max={1.0} step={0.05} value={zone2Rate} onChange={onZone2RateChange} style={{ width:60 }} />
              <span style={{ color:'#c8a060', minWidth:30 }}>{zone2Rate.toFixed(2)}×</span>
              <div style={{ width:1, height:14, background:'#333' }} />
              <span>Rate Z3</span>
              <input type="range" min={0.5} max={3.0} step={0.1} value={zone3Rate} onChange={onZone3RateChange} style={{ width:60 }} />
              <span style={{ color:'#c8a060', minWidth:26 }}>{zone3Rate.toFixed(1)}×</span>
              <div style={{ width:1, height:14, background:'#333' }} />
              <span>Base</span>
              <input type="range" min={50} max={600} step={25} value={baseEnergyRate} onChange={onBaseRateChange} style={{ width:60 }} />
              <span style={{ color:'#c8a060', minWidth:40 }}>{baseEnergyRate}°/s</span>
            </div>
          )}

          {/* Glass controls bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16,
            padding: '10px 24px', background: '#181818', borderTop: '1px solid #2a2a2a', flexShrink: 0,
          }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: showBox ? '#c8a060' : '#888', cursor:'pointer', userSelect:'none' }}>
              <input type="checkbox" checked={showBox} onChange={onBoxChange} style={{ cursor:'pointer', accentColor:'#c06040' }} />
              Box
            </label>
            {showBox && (
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: showStick ? '#c8a060' : '#888', cursor:'pointer', userSelect:'none' }}>
                <input type="checkbox" checked={showStick} onChange={onStickChange} style={{ cursor:'pointer', accentColor:'#c8a060' }} />
                Stick
              </label>
            )}
            {showBox && (
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: autoRotate ? '#c8a060' : '#888', cursor:'pointer', userSelect:'none' }}>
                <input type="checkbox" checked={autoRotate} onChange={onAutoRotateChange} style={{ cursor:'pointer', accentColor:'#c8a060' }} />
                Rotate
              </label>
            )}
            {showBox && (
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: showMetaball ? '#c8a060' : '#888', cursor:'pointer', userSelect:'none' }}>
                <input type="checkbox" checked={showMetaball} onChange={onMetaballChange} style={{ cursor:'pointer', accentColor:'#c8a060' }} />
                Metaball
              </label>
            )}
            <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: directTempMode ? '#80b0e0' : '#888', cursor:'pointer', userSelect:'none' }}>
              <input type="checkbox" checked={directTempMode} onChange={onDirectTempChange} style={{ cursor:'pointer', accentColor:'#4080c0' }} />
              Direct
            </label>
            <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: glassDevMode ? '#aaa' : '#555', cursor:'pointer', userSelect:'none' }}>
              <input type="checkbox" checked={glassDevMode} onChange={e => setGlassDevMode(e.target.checked)} style={{ cursor:'pointer' }} />
              dev
            </label>

            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>
              {/* Energy input — snaps to 0 on release, disabled in direct mode */}
              <span style={{ fontSize:11, color: directTempMode ? '#333' : '#555', userSelect:'none' }}>−</span>
              <input type="range" min={-100} max={100} step={1} value={glassEnergyIn}
                onChange={onEnergyInChange}
                onMouseUp={onEnergyRelease}
                onTouchEnd={onEnergyRelease}
                disabled={directTempMode}
                style={{ width:80, accentColor:'#4080c0', cursor: directTempMode ? 'not-allowed' : 'pointer', opacity: directTempMode ? 0.3 : 1 }}
              />
              <span style={{ fontSize:11, color: directTempMode ? '#333' : '#555', userSelect:'none' }}>+</span>

              <div style={{ width:1, height:18, background:'#333', margin:'0 4px' }} />

              {/* Temperature display — editable only in direct mode */}
              <span style={{ fontSize:11, color:'#555' }}>25°C</span>
              <input type="range" min={25} max={1200} step={5} value={glassTemp}
                onChange={directTempMode ? onDirectTempSlide : () => {}}
                style={{ width:160, accentColor:'#c06040', cursor: directTempMode ? 'pointer' : 'default', opacity: directTempMode ? 1 : 0.55 }}
              />
              <span style={{ fontSize:11, color:'#555' }}>1200°C</span>
              <span style={{ fontSize:12, color:'#c8a060', minWidth:52, textAlign:'right' }}>{glassTemp}°C</span>
            </div>
          </div>
        </div>
      </main>

      {showEnergyGraph && (
        <div style={{
          position: 'fixed', left: graphPos.x, top: graphPos.y,
          width: graphPos.w, height: graphPos.h,
          background: '#0e0e0e', border: '1px solid #333',
          borderRadius: 6, boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column', zIndex: 200,
          resize: 'both', overflow: 'hidden', minWidth: 200, minHeight: 160,
        }}
          onMouseMove={e => {
            if (e.target === e.currentTarget) return
            const r = e.currentTarget
            setGraphPos(p => ({ ...p, w: r.offsetWidth, h: r.offsetHeight }))
          }}
        >
          {/* Drag handle header */}
          <div
            onMouseDown={onGraphMouseDown}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '4px 8px', background: '#161616', borderBottom: '1px solid #2a2a2a',
              cursor: 'grab', userSelect: 'none', flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 10, color: '#666', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Energy → Temp</span>
            <button onClick={() => { graphDataRef.current = [] }} style={{
              background: 'none', border: 'none', color: '#555', cursor: 'pointer',
              fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 4px',
            }}>Reset</button>
            <button onClick={onToggleEnergyGraph} style={{
              background: 'none', border: 'none', color: '#555', cursor: 'pointer',
              fontSize: 13, lineHeight: 1, padding: '0 2px',
            }}>×</button>
          </div>
          <canvas ref={graphCanvasRef} style={{ flex: 1, width: '100%', display: 'block' }} />
        </div>
      )}
    </div>
  )
}
