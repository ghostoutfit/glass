import { useRef, useEffect, useState, useCallback } from 'react'

const FLOOR_OFF   = 70
const N_BOX       = 24
const BOX_SIZE    = 320
const CORNER_R    = 26
const GRAVITY     = 0.20
const MIN_THICK   = 52
const STICK_LEN   = 300
const STICK_ANGLE = 10 * Math.PI / 180   // 10° downward tilt, tip lower than handle

function lerp(a, b, t)    { return a + (b - a) * t }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
function hex2rgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]
}
function lerpColor(cold, hot, t) {
  const a = hex2rgb(cold), b = hex2rgb(hot)
  return `rgb(${Math.round(lerp(a[0],b[0],t))},${Math.round(lerp(a[1],b[1],t))},${Math.round(lerp(a[2],b[2],t))})`
}

function blobParams(t) {
  return { w: lerp(120, 225, t), h: lerp(105, 22, t), r: lerp(44, 11, t) }
}

// Analytical blob — floor mode
function drawBlob(ctx, cx, floorY, w, h, r) {
  const ctrlY = floorY - h - (h - r) / 3
  ctx.beginPath()
  ctx.moveTo(cx - (w - r), floorY)
  ctx.quadraticCurveTo(cx - w, floorY,  cx - w, floorY - r)
  ctx.bezierCurveTo   (cx - w, ctrlY,   cx + w, ctrlY,   cx + w, floorY - r)
  ctx.quadraticCurveTo(cx + w, floorY,  cx + (w - r), floorY)
  ctx.lineTo(cx - (w - r), floorY)
  ctx.closePath()
}

// Smooth closed bezier — box particle blob
function drawClosed(ctx, pts) {
  const n = pts.length
  ctx.beginPath()
  ctx.moveTo((pts[n-1].x + pts[0].x) / 2, (pts[n-1].y + pts[0].y) / 2)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    ctx.quadraticCurveTo(pts[i].x, pts[i].y,
      (pts[i].x + pts[j].x) / 2, (pts[i].y + pts[j].y) / 2)
  }
  ctx.closePath()
}

// Signed area via shoelace (pressure / volume conservation)
function signedArea(pts) {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

// For rendering: project wall-contact particles to actual wall
function wallRenderPts(pts, HS_I, gnx, gny) {
  const wallD = Math.min(
    Math.abs(gnx) > 0.01 ? (BOX_SIZE / 2) / Math.abs(gnx) : 1e9,
    Math.abs(gny) > 0.01 ? (BOX_SIZE / 2) / Math.abs(gny) : 1e9
  )
  const depths = pts.map(p => p.x*gnx + p.y*gny)
  const maxD   = Math.max(...depths)
  if (maxD < HS_I - 4) return pts
  return pts.map((p, i) => {
    if (depths[i] < HS_I - 2) return p
    const shift = wallD - depths[i]
    return { x: p.x + gnx*shift, y: p.y + gny*shift }
  })
}

// Tapered strand for glob connection
function drawStrand(ctx, ax, ay, gx, gy, wBase) {
  const dx = gx - ax, dy = gy - ay
  const len = Math.sqrt(dx*dx + dy*dy) || 1
  const nx = -dy/len, ny = dx/len   // perpendicular
  const wTip = 1.5

  ctx.beginPath()
  ctx.moveTo(ax + nx*wBase, ay + ny*wBase)
  // Side curves taper from wBase at attachment to wTip at glob
  ctx.bezierCurveTo(
    ax + nx*wBase*0.7 + dx*0.35, ay + ny*wBase*0.7 + dy*0.35,
    gx  + nx*wTip*2   - dx*0.15, gy  + ny*wTip*2   - dy*0.15,
    gx + nx*wTip, gy + ny*wTip
  )
  ctx.lineTo(gx - nx*wTip, gy - ny*wTip)
  ctx.bezierCurveTo(
    gx  - nx*wTip*2   - dx*0.15, gy  - ny*wTip*2   - dy*0.15,
    ax - nx*wBase*0.7 + dx*0.35, ay - ny*wBase*0.7 + dy*0.35,
    ax - nx*wBase, ay - ny*wBase
  )
  ctx.closePath()
}

function initBox(temp) {
  const t  = clamp((temp - 25) / 175, 0, 1)
  const { w, h } = blobParams(t)
  const HS  = BOX_SIZE / 2
  const wm  = lerp(4, 22, t)
  const HSI = HS - wm
  const rx  = Math.min(w * 0.74, HSI - 8)
  const ry  = Math.max(36, Math.min(h * 0.42, HSI - 8))
  const cy0 = HSI - ry - 8
  const pts = Array.from({ length: N_BOX }, (_, i) => {
    const a = (i / N_BOX) * Math.PI * 2 - Math.PI / 2
    return { x: rx * Math.cos(a), y: cy0 + ry * Math.sin(a), vx: 0, vy: 0 }
  })
  const restPts    = pts.map(p => ({ x: p.x, y: p.y }))
  const targetArea = Math.abs(signedArea(pts))
  return { pts, restPts, targetArea, boxAngle: 0, boxAngularVel: 0, cornerDrag: null }
}

export default function BlobView() {
  const canvasRef = useRef(null)
  const simRef    = useRef({
    temp: 80, boxMode: false, showStick: false, box: null,
    mouse: { x: -400, y: -400, down: false },
    displayT: null,   // shape-lag temp — changes slower when cooling
    glob: null,       // pulled material: { x,y,vx,vy,r, attached, ax,ay }
    stick: null,      // { x, y } in canvas coords — independent of cursor; null = unplaced
    stickDrag: null,  // { offsetX, offsetY } when grabbed
  })
  const [temp,      setTemp]      = useState(80)
  const [boxMode,   setBoxMode]   = useState(false)
  const [showStick, setShowStick] = useState(false)

  const onTempChange = useCallback(e => {
    const v = Number(e.target.value)
    setTemp(v)
    simRef.current.temp = v
  }, [])

  const onBoxChange = useCallback(e => {
    const bm = e.target.checked
    setBoxMode(bm)
    simRef.current.boxMode = bm
    if (bm && !simRef.current.box) simRef.current.box = initBox(simRef.current.temp)
  }, [])

  const onStickChange = useCallback(e => {
    const v = e.target.checked
    setShowStick(v)
    simRef.current.showStick = v
    if (!v) { simRef.current.stick = null; simRef.current.stickDrag = null }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width  = canvas.clientWidth
    canvas.height = canvas.clientHeight

    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.clientWidth
      canvas.height = canvas.clientHeight
    })
    ro.observe(canvas)

    // ── Mouse / touch helpers ──────────────────────────────────────
    function worldPos(e) {
      const r   = canvas.getBoundingClientRect()
      const src = e.touches ? e.touches[0] : e
      return { wx: src.clientX - r.left, wy: src.clientY - r.top }
    }

    function cornersWorld() {
      const box = simRef.current.box
      if (!box) return []
      const bcx = canvas.width / 2, bcy = canvas.height / 2
      const c = Math.cos(box.boxAngle), s = Math.sin(box.boxAngle), H = BOX_SIZE / 2
      return [[-H,-H],[H,-H],[H,H],[-H,H]].map(([lx,ly]) => ({
        wx: bcx + lx*c - ly*s, wy: bcy + lx*s + ly*c
      }))
    }

    // ── Event handlers ─────────────────────────────────────────────
    const onMouseMove = e => {
      const { wx, wy } = worldPos(e)
      simRef.current.mouse.x = wx
      simRef.current.mouse.y = wy
      const s = simRef.current
      // Box corner drag
      if (s.boxMode && s.box && s.box.cornerDrag) {
        const bcx = canvas.width / 2, bcy = canvas.height / 2
        const mAngle = Math.atan2(wy - bcy, wx - bcx)
        const newAngle = s.box.cornerDrag.startBoxAngle + (mAngle - s.box.cornerDrag.startMouseAngle)
        s.box.boxAngularVel = newAngle - s.box.boxAngle
        s.box.boxAngle = newAngle
      }
      // Stick drag
      if (s.stickDrag && s.stick) {
        s.stick.x = wx - s.stickDrag.offsetX
        s.stick.y = wy - s.stickDrag.offsetY
      }
    }

    const onDown = e => {
      const s = simRef.current
      const { wx, wy } = worldPos(e)
      s.mouse.x = wx; s.mouse.y = wy; s.mouse.down = true

      if (s.boxMode && s.box) {
        const bcx = canvas.width / 2, bcy = canvas.height / 2

        // Stick: clicking anywhere in box mode while stick is visible grabs it
        // (unless clicking a corner handle for rotation)
        const onCorner = cornersWorld().some(c => Math.hypot(c.wx - wx, c.wy - wy) < CORNER_R)
        if (s.showStick && !onCorner) {
          // Place stick on first click if not yet placed
          if (!s.stick) s.stick = { x: wx, y: wy }
          s.stickDrag = { offsetX: wx - s.stick.x, offsetY: wy - s.stick.y }
          return
        }
        if (onCorner) {
          s.box.cornerDrag = {
            startMouseAngle: Math.atan2(wy - bcy, wx - bcx),
            startBoxAngle:   s.box.boxAngle,
          }
        }
      } else if (!s.boxMode && !s.glob) {
        // Try to start a glob dig
        const t = s.displayT ?? clamp((s.temp - 25) / 175, 0, 1)
        const { w, h } = blobParams(t)
        const cx = canvas.width / 2, floorY = canvas.height - FLOOR_OFF
        // Tip of the stick is at the cursor — check if it's inside the blob region
        if (wy > floorY - h - 18 && wy < floorY + 8 && Math.abs(wx - cx) < w + 8) {
          const r0 = lerp(12, 22, t)
          s.glob = {
            x: wx, y: clamp(wy, floorY - h - r0, floorY),
            vx: 0, vy: -0.5,
            r: r0,
            attached: true,
            ax: wx,
            ay: clamp(wy, floorY - h, floorY - 4),  // attachment on blob surface
          }
        }
      }
    }

    const onUp = () => {
      const s = simRef.current
      if (s.box) s.box.cornerDrag = null
      s.stickDrag = null
      s.mouse.down = false
      if (s.glob) s.glob.attached = false
    }

    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mousedown',  onDown)
    canvas.addEventListener('mouseup',    onUp)
    canvas.addEventListener('mouseleave', onUp)
    canvas.addEventListener('touchstart', onDown,      { passive: true })
    canvas.addEventListener('touchmove',  onMouseMove, { passive: true })
    canvas.addEventListener('touchend',   onUp)

    const ctx = canvas.getContext('2d')
    let raf

    function frame() {
      const s   = simRef.current
      const t   = clamp((s.temp - 25) / 175, 0, 1)
      const cx  = canvas.width / 2

      // Shape-lag: blob deforms quickly when heating, slowly when cooling
      // so "cool it down → keeps its shape"
      if (s.displayT == null) s.displayT = t
      const dT = t - s.displayT
      s.displayT += dT * (dT > 0 ? 0.018 : 0.004)

      const dt = s.displayT   // shape temperature (lagged)

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // ══ FLOOR MODE ════════════════════════════════════════════════
      if (!s.boxMode) {
        const floorY = canvas.height - FLOOR_OFF
        const { w, h, r } = blobParams(dt)      // shape uses lagged temp

        // Contact glow
        if (t > 0.05) {
          const gr = ctx.createRadialGradient(cx, floorY, 0, cx, floorY, w * lerp(1.1, 1.7, t))
          gr.addColorStop(0, `rgba(255,80,0,${t * 0.18})`); gr.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.save()
          ctx.fillStyle = gr; ctx.beginPath()
          ctx.ellipse(cx, floorY, w * lerp(1.1, 1.7, t), 16, 0, 0, Math.PI * 2); ctx.fill()
          ctx.restore()
        }
        ctx.save()
        ctx.strokeStyle = 'rgba(140,110,80,0.30)'; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(0, floorY); ctx.lineTo(canvas.width, floorY); ctx.stroke()
        ctx.restore()

        ctx.save()
        ctx.globalAlpha = lerp(0.28, 0.10, t); ctx.fillStyle = '#000'
        ctx.beginPath(); ctx.ellipse(cx, floorY + 6, w, 6, 0, 0, Math.PI * 2); ctx.fill()
        ctx.restore()

        ctx.save()
        drawBlob(ctx, cx, floorY, w, h, r)
        ctx.shadowColor = lerpColor('#300800', '#ff6500', t)
        ctx.shadowBlur  = lerp(5, 52, t)
        ctx.fillStyle   = lerpColor('#300800', '#cc5500', t); ctx.fill()
        ctx.restore()

        ctx.save()
        drawBlob(ctx, cx, floorY, w, h, r)
        ctx.fillStyle = lerpColor('#5c2000', '#ff9200', t); ctx.fill()
        ctx.restore()

        ctx.save()
        drawBlob(ctx, cx, floorY, w, h, r)
        const tg = ctx.createLinearGradient(cx, floorY - h, cx, floorY)
        tg.addColorStop(0,    `rgba(255,210,100,${0.10 + t * 0.28})`)
        tg.addColorStop(0.38, `rgba(255,150, 30,${0.04 + t * 0.10})`)
        tg.addColorStop(1,    'rgba(0,0,0,0)')
        ctx.fillStyle = tg; ctx.fill()
        ctx.restore()

        ctx.save()
        drawBlob(ctx, cx, floorY, w, h, r)
        const sp = ctx.createRadialGradient(cx - w*0.22, floorY - h*0.80, 0, cx - w*0.22, floorY - h*0.80, w*0.38)
        sp.addColorStop(0, `rgba(255,255,220,${0.07 + t * 0.18})`); sp.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = sp; ctx.fill()
        ctx.restore()

        // ── Glob physics ───────────────────────────────────────────
        if (s.glob) {
          const g = s.glob
          const visc     = lerp(0.82, 0.94, t)          // cold = more viscous
          const maxStrand = lerp(30, 150, t)             // hot = stretches further
          const springK  = lerp(0.04, 0.18, t)          // hot = snappier follow

          if (g.attached && s.mouse.down) {
            // Spring pull toward stick tip
            const tx = s.mouse.x, ty = s.mouse.y
            g.vx += (tx - g.x) * springK
            g.vy += (ty - g.y) * springK
            // Detach if strand overstretches
            const strandLen = Math.hypot(g.x - g.ax, g.y - g.ay)
            if (strandLen > maxStrand) g.attached = false
          } else {
            g.attached = false
          }

          g.vy += 0.30             // gravity on glob
          g.vx *= visc; g.vy *= visc
          g.x += g.vx; g.y += g.vy

          // Merge back into blob when it falls to the floor
          if (g.y > floorY + g.r * 1.5) { s.glob = null }
        }

        // ── Glob rendering ─────────────────────────────────────────
        if (s.glob) {
          const g = s.glob
          const blobColor = lerpColor('#5c2000', '#ff9200', t)
          const strandLen = Math.hypot(g.x - g.ax, g.y - g.ay)
          const maxStrand = lerp(30, 150, t)
          const strandW   = lerp(5, 14, t) * Math.max(0.2, 1 - strandLen / (maxStrand + 40))

          ctx.save()
          drawStrand(ctx, g.ax, g.ay, g.x, g.y, strandW)
          ctx.shadowColor = lerpColor('#300800', '#ff6500', t)
          ctx.shadowBlur  = lerp(3, 18, t)
          ctx.fillStyle   = blobColor
          ctx.fill()
          ctx.restore()

          ctx.save()
          ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
          ctx.shadowColor = lerpColor('#300800', '#ff6500', t)
          ctx.shadowBlur  = lerp(4, 22, t)
          ctx.fillStyle   = lerpColor('#300800', '#cc5500', t)
          ctx.fill()
          ctx.restore()

          ctx.save()
          ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
          ctx.fillStyle = blobColor; ctx.fill()
          ctx.restore()

          // Surface glint on glob
          ctx.save()
          ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
          const sg = ctx.createRadialGradient(g.x - g.r*0.3, g.y - g.r*0.3, 0, g.x, g.y, g.r)
          sg.addColorStop(0, `rgba(255,255,220,${0.08 + t*0.20})`)
          sg.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = sg; ctx.fill()
          ctx.restore()
        }

        // ── Stick rendering ────────────────────────────────────────
        // Tip is at mouse. Handle extends upper-right at 10° above horizontal.
        {
          const mx = s.mouse.x, my = s.mouse.y
          // Handle direction: from tip, go right and slightly up
          const hx = mx + STICK_LEN * Math.cos(STICK_ANGLE)
          const hy = my - STICK_LEN * Math.sin(STICK_ANGLE)

          ctx.save()
          ctx.translate(mx, my)
          ctx.rotate(-STICK_ANGLE)  // align local x-axis with stick direction

          // Shadow for depth
          ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6

          // Body gradient (wood / glass rod look)
          const g2 = ctx.createLinearGradient(0, -4, 0, 4)
          g2.addColorStop(0,   '#e0c890')
          g2.addColorStop(0.4, '#c8a060')
          g2.addColorStop(1,   '#7a5030')
          ctx.fillStyle = g2

          // Shaft
          ctx.beginPath()
          ctx.roundRect(2, -3.5, STICK_LEN - 4, 7, 3)
          ctx.fill()

          // Tip taper
          ctx.shadowBlur = 0
          ctx.fillStyle = '#5a3a1a'
          ctx.beginPath()
          ctx.moveTo(2, -3.5); ctx.lineTo(-10, 0); ctx.lineTo(2, 3.5); ctx.closePath()
          ctx.fill()

          // Specular highlight
          ctx.fillStyle = 'rgba(255,245,220,0.35)'
          ctx.beginPath()
          ctx.roundRect(4, -3.5, STICK_LEN - 20, 2.5, 1)
          ctx.fill()

          ctx.restore()

          // Small circle at the cursor/tip for precision
          ctx.save()
          ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(80,50,20,0.7)'; ctx.fill()
          ctx.restore()
        }

      // ══ BOX MODE ══════════════════════════════════════════════════
      } else {
        if (!s.box) s.box = initBox(s.temp)
        const box = s.box
        const HS  = BOX_SIZE / 2

        const wallMargin  = lerp(4, 22, t)
        const HS_I        = HS - wallMargin
        const bcx = canvas.width / 2, bcy = canvas.height / 2

        // OLD PHYSICS — commented out, replaced below
        // const springK     = lerp(0.18, 0.00, t)   // shape-memory spring (strong cold, zero hot)
        // const dampC       = lerp(0.74, 0.88, t)   // velocity damping (viscous cold, fluid hot)
        // const surfTen     = lerp(0.06, 0.02, t)   // surface tension (neighbor midpoint pull)
        // const restitution = lerp(0.40, 0.04, t)   // wall bounce elasticity
        // const pressureK   = lerp(1.20, 0.60, t)   // area-conservation pressure
        // const memoryRate  = t * t * 0.08           // how fast rest positions follow (plastic deform)

        if (!box.cornerDrag) {
          box.boxAngle      += box.boxAngularVel
          box.boxAngularVel *= 0.94
        }

        const gMag = GRAVITY
        const gx   = gMag * Math.sin(box.boxAngle)
        const gy   = gMag * Math.cos(box.boxAngle)
        const gnx = gx / gMag, gny = gy / gMag
        // const ptx = -gny, pty = gnx   // tangent to gravity (unused now)

        // OLD: plastic memory drift — rest positions slowly chase current positions
        // for (let i = 0; i < N_BOX; i++) {
        //   box.restPts[i].x += (box.pts[i].x - box.restPts[i].x) * memoryRate
        //   box.restPts[i].y += (box.pts[i].y - box.restPts[i].y) * memoryRate
        // }

        // OLD: centroid + area-conservation pressure outward push
        // let centX = 0, centY = 0
        // for (const p of box.pts) { centX += p.x; centY += p.y }
        // centX /= N_BOX; centY /= N_BOX
        // const area      = Math.abs(signedArea(box.pts))
        // const areaRatio = box.targetArea / Math.max(area, 1)
        // const pForce    = (areaRatio - 1) * pressureK
        // for (let i = 0; i < N_BOX; i++) {
        //   const p  = box.pts[i]
        //   const dx = p.x - centX, dy = p.y - centY
        //   const d  = Math.sqrt(dx*dx + dy*dy)
        //   if (d > 0.5) { p.vx += (dx/d)*pForce; p.vy += (dy/d)*pForce }
        // }

        // OLD: minimum thickness — prevents pancake collapse along gravity axis
        // {
        //   const projs  = box.pts.map(p => p.x*gnx + p.y*gny)
        //   const minP   = Math.min(...projs)
        //   const maxP   = Math.max(...projs)
        //   const thick  = maxP - minP
        //   if (thick < MIN_THICK) {
        //     const half = (MIN_THICK - thick) * 0.5
        //     const midP = (minP + maxP) / 2
        //     for (let i = 0; i < N_BOX; i++) {
        //       const side = projs[i] > midP ? 1 : -1
        //       box.pts[i].vx += gnx * side * half * 0.06
        //       box.pts[i].vy += gny * side * half * 0.06
        //     }
        //   }
        // }

        // OLD: surface tension + spring to rest + gravity + damping + wall clamp + integrate + wall bounce
        // for (let i = 0; i < N_BOX; i++) {
        //   const p    = box.pts[i]
        //   const prev = box.pts[(i - 1 + N_BOX) % N_BOX]
        //   const next = box.pts[(i + 1) % N_BOX]
        //   p.vx += ((prev.x + next.x) * 0.5 - p.x) * surfTen   // surface tension
        //   p.vy += ((prev.y + next.y) * 0.5 - p.y) * surfTen
        //   p.vx += (box.restPts[i].x - p.x) * springK            // shape-memory spring
        //   p.vy += (box.restPts[i].y - p.y) * springK
        //   p.vx += gx; p.vy += gy                                 // gravity
        //   p.vx *= dampC; p.vy *= dampC                           // viscous damping
        //   if (p.vx > 0 && p.x + p.vx >  HS_I) p.vx = Math.max(0,  HS_I - p.x)   // wall clamp
        //   if (p.vx < 0 && p.x + p.vx < -HS_I) p.vx = Math.min(0, -HS_I - p.x)
        //   if (p.vy > 0 && p.y + p.vy >  HS_I) p.vy = Math.max(0,  HS_I - p.y)
        //   if (p.vy < 0 && p.y + p.vy < -HS_I) p.vy = Math.min(0, -HS_I - p.y)
        //   p.x += p.vx; p.y += p.vy                              // integrate
        //   if (p.x < -HS_I) { p.x = -HS_I; if (p.vx < 0) p.vx = Math.abs(p.vx) * restitution }  // bounce
        //   if (p.x >  HS_I) { p.x =  HS_I; if (p.vx > 0) p.vx = -Math.abs(p.vx) * restitution }
        //   if (p.y < -HS_I) { p.y = -HS_I; if (p.vy < 0) p.vy = Math.abs(p.vy) * restitution }
        //   if (p.y >  HS_I) { p.y =  HS_I; if (p.vy > 0) p.vy = -Math.abs(p.vy) * restitution }
        // }

        // ── NEW PHYSICS: incompressible soft blob ─────────────────
        // Closed ring of N particles. Can never split (topology).
        // Can self-contact and merge (topology repair step).
        const N = box.pts.length

        // Temperature-scaled parameters
        const K_PRESS = 3.5                       // area-conservation pressure
        const K_SURF  = lerp(0.003, 0.06, t)      // surface tension — near-zero cold so shape freezes
        const K_EDGE  = lerp(0.01, 0.10, t)       // edge equalization — near-zero cold so spacing freezes
        const DAMP    = lerp(0.80, 0.96, t)        // velocity damping
        const REST    = lerp(0.25, 0.04, t)        // wall restitution

        // 1. Area-conservation pressure via signed-area gradient.
        //    Each vertex is pushed along ∂A/∂p_i to restore target area.
        //    Works for any shape, including self-folded/figure-8 configurations.
        const rawArea = signedArea(box.pts)
        const area    = Math.abs(rawArea)
        const aSgn    = rawArea >= 0 ? 1 : -1     // +1 CW canvas, -1 CCW
        const pForce  = K_PRESS * (box.targetArea / Math.max(area, 1) - 1) * aSgn
        for (let i = 0; i < N; i++) {
          const prev = box.pts[(i - 1 + N) % N]
          const next = box.pts[(i + 1) % N]
          box.pts[i].vx += (next.y - prev.y) * 0.5 * pForce
          box.pts[i].vy += (prev.x - next.x) * 0.5 * pForce
        }

        // 2. Surface tension: pull each vertex toward its neighbor midpoint.
        //    Keeps the outline smooth and curved (no kinks).
        for (let i = 0; i < N; i++) {
          const p    = box.pts[i]
          const prev = box.pts[(i - 1 + N) % N]
          const next = box.pts[(i + 1) % N]
          p.vx += ((prev.x + next.x) * 0.5 - p.x) * K_SURF
          p.vy += ((prev.y + next.y) * 0.5 - p.y) * K_SURF
        }

        // 3. Edge-length equalization: keep particles evenly spaced around ring.
        //    Prevents clustering at corners and gaps on straight stretches.
        let totalLen = 0
        for (let i = 0; i < N; i++) {
          const next = box.pts[(i + 1) % N]
          totalLen += Math.hypot(next.x - box.pts[i].x, next.y - box.pts[i].y)
        }
        const avgLen = totalLen / N
        for (let i = 0; i < N; i++) {
          const p    = box.pts[i]
          const next = box.pts[(i + 1) % N]
          const dx   = next.x - p.x, dy = next.y - p.y
          const d    = Math.hypot(dx, dy) || 1
          const f    = K_EDGE * (d - avgLen) / d
          p.vx    += dx * f;  p.vy    += dy * f
          next.vx -= dx * f;  next.vy -= dy * f
        }

        // 4. Gravity, damping, integrate, hard walls, stick collision
        // Stick tip converted from canvas coords to box-local coords
        const ca = Math.cos(-box.boxAngle), sa = Math.sin(-box.boxAngle)
        const toLocal = (wx, wy) => {
          const dx = wx - bcx, dy = wy - bcy
          return [dx*ca - dy*sa, dx*sa + dy*ca]
        }
        const stick = s.showStick && s.stickDrag && s.stick  // only collide while dragging
        const [tipLx, tipLy] = stick ? toLocal(stick.x, stick.y) : [0, 0]
        const [hanLx, hanLy] = stick ? toLocal(
          stick.x + STICK_LEN * Math.cos(STICK_ANGLE),
          stick.y - STICK_LEN * Math.sin(STICK_ANGLE)
        ) : [0, 0]
        const sdx = hanLx - tipLx, sdy = hanLy - tipLy
        const sLen2 = sdx*sdx + sdy*sdy
        const STICK_R = 5

        const MAX_V = HS_I * 0.4   // velocity cap prevents tunneling through walls/stick
        for (let i = 0; i < N; i++) {
          const p = box.pts[i]
          p.vx += gx; p.vy += gy
          p.vx *= DAMP; p.vy *= DAMP
          // Cap speed before integration so no particle ever tunnels a wall in one frame
          if (p.vx >  MAX_V) p.vx =  MAX_V
          if (p.vx < -MAX_V) p.vx = -MAX_V
          if (p.vy >  MAX_V) p.vy =  MAX_V
          if (p.vy < -MAX_V) p.vy = -MAX_V
          p.x  += p.vx; p.y  += p.vy
          // Hard walls — position is always clamped then velocity reflected
          if (p.x < -HS_I) { p.x = -HS_I; p.vx =  Math.abs(p.vx) * REST }
          if (p.x >  HS_I) { p.x =  HS_I; p.vx = -Math.abs(p.vx) * REST }
          if (p.y < -HS_I) { p.y = -HS_I; p.vy =  Math.abs(p.vy) * REST }
          if (p.y >  HS_I) { p.y =  HS_I; p.vy = -Math.abs(p.vy) * REST }
          // Stick — only collides when actively being dragged
          if (stick && sLen2 > 0.01) {
            const tParam = Math.max(0, Math.min(1, ((p.x - tipLx)*sdx + (p.y - tipLy)*sdy) / sLen2))
            const cpx = tipLx + tParam*sdx, cpy = tipLy + tParam*sdy
            const ex = p.x - cpx, ey = p.y - cpy
            const d = Math.hypot(ex, ey)
            if (d < STICK_R && d > 0.001) {
              const nx = ex/d, ny = ey/d
              p.x += nx * (STICK_R - d)
              p.y += ny * (STICK_R - d)
              const vn = p.vx*nx + p.vy*ny
              if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny }
            }
          }
        }

        // 5. Topology repair: when non-adjacent particles touch, merge the ring.
        //    Keeps the larger-area sub-ring, discards the small loop.
        //    Preserves constant-area constraint (no splitting, only merging).
        const MERGE_D2  = 10 * 10
        const MIN_RING  = 5
        let merged = false
        for (let i = 0; i < N - 2 && !merged; i++) {
          const pi = box.pts[i]
          for (let j = i + 3; j < N; j++) {
            if (i === 0 && j === N - 1) continue   // adjacent at wrap
            const pj = box.pts[j]
            const dx = pj.x - pi.x, dy = pj.y - pi.y
            if (dx * dx + dy * dy > MERGE_D2) continue
            const segA = box.pts.slice(i, j + 1)
            const segB = [...box.pts.slice(j), ...box.pts.slice(0, i + 1)]
            if (segA.length < MIN_RING || segB.length < MIN_RING) continue
            const aA = Math.abs(signedArea(segA))
            const aB = Math.abs(signedArea(segB))
            box.pts = aA >= aB ? segA : segB
            merged = true
            break
          }
        }

        // ── Render box mode ────────────────────────────────────────
        const renderPts = wallRenderPts(box.pts, HS_I, gnx, gny)

        ctx.save()
        ctx.translate(bcx, bcy)
        ctx.rotate(box.boxAngle)

        ctx.fillStyle = '#080604'
        ctx.fillRect(-HS, -HS, BOX_SIZE, BOX_SIZE)

        ctx.beginPath(); ctx.rect(-HS, -HS, BOX_SIZE, BOX_SIZE); ctx.clip()

        ctx.save()
        drawClosed(ctx, renderPts)
        ctx.shadowColor = lerpColor('#300800', '#ff6500', t)
        ctx.shadowBlur  = lerp(4, 22, t)
        ctx.fillStyle   = lerpColor('#300800', '#cc5500', t)
        ctx.fill()
        ctx.restore()

        ctx.save()
        drawClosed(ctx, renderPts)
        ctx.fillStyle = lerpColor('#5c2000', '#ff9200', t)
        ctx.fill()
        ctx.restore()

        ctx.save()
        let cxB = 0, cyB = 0
        for (const p of renderPts) { cxB += p.x; cyB += p.y }
        cxB /= N_BOX; cyB /= N_BOX
        const bR = Math.max(4, ...renderPts.map(p => Math.hypot(p.x - cxB, p.y - cyB)))
        const grd = ctx.createRadialGradient(
          cxB - gnx*bR*0.35, cyB - gny*bR*0.35, 0, cxB, cyB, bR
        )
        grd.addColorStop(0,   `rgba(255,220,100,${0.08 + t*0.20})`)
        grd.addColorStop(0.5, `rgba(255,140, 20,${0.03 + t*0.06})`)
        grd.addColorStop(1,   'rgba(0,0,0,0)')
        drawClosed(ctx, renderPts)
        ctx.fillStyle = grd; ctx.fill()
        ctx.restore()

        ctx.restore()

        ctx.save()
        ctx.translate(bcx, bcy)
        ctx.rotate(box.boxAngle)
        ctx.strokeStyle = 'rgba(200,170,120,0.80)'; ctx.lineWidth = 3
        ctx.strokeRect(-HS, -HS, BOX_SIZE, BOX_SIZE)
        ;[[-HS,-HS],[HS,-HS],[HS,HS],[-HS,HS]].forEach(([lx, ly]) => {
          ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(240,210,160,0.96)'; ctx.fill()
          ctx.strokeStyle = 'rgba(160,130,90,0.80)'; ctx.lineWidth = 1.5; ctx.stroke()
        })
        ctx.restore()

        // ── Stick (canvas coords — not rotated with box) ───────────
        if (s.showStick && s.stick) {
          const sx = s.stick.x, sy = s.stick.y
          const isDragging = !!s.stickDrag
          ctx.save()
          ctx.translate(sx, sy)
          ctx.rotate(-STICK_ANGLE)
          ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6
          const sg = ctx.createLinearGradient(0, -4, 0, 4)
          sg.addColorStop(0,   '#e0c890')
          sg.addColorStop(0.4, '#c8a060')
          sg.addColorStop(1,   '#7a5030')
          ctx.fillStyle = sg
          ctx.beginPath(); ctx.roundRect(2, -3.5, STICK_LEN - 4, 7, 3); ctx.fill()
          ctx.shadowBlur = 0
          ctx.fillStyle = '#5a3a1a'
          ctx.beginPath()
          ctx.moveTo(2, -3.5); ctx.lineTo(-10, 0); ctx.lineTo(2, 3.5); ctx.closePath()
          ctx.fill()
          ctx.fillStyle = isDragging ? 'rgba(255,230,100,0.5)' : 'rgba(255,245,220,0.35)'
          ctx.beginPath(); ctx.roundRect(4, -3.5, STICK_LEN - 20, 2.5, 1); ctx.fill()
          ctx.restore()
          ctx.save()
          ctx.beginPath(); ctx.arc(sx, sy, isDragging ? 5 : 3, 0, Math.PI * 2)
          ctx.fillStyle = isDragging ? 'rgba(200,160,80,0.9)' : 'rgba(80,50,20,0.7)'; ctx.fill()
          ctx.restore()
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

  return (
    <div style={{ display:'flex', flexDirection:'column', width:'100%', height:'100%' }}>
      <canvas ref={canvasRef} style={{ flex:1, width:'100%', display:'block', cursor: 'default' }} />
      <div style={{
        display:'flex', alignItems:'center', gap:16,
        padding:'10px 24px', background:'#181818', borderTop:'1px solid #2a2a2a', flexShrink:0,
      }}>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#888', cursor:'pointer', userSelect:'none' }}>
          <input type="checkbox" checked={boxMode} onChange={onBoxChange}
            style={{ cursor:'pointer', accentColor:'#c06040' }} />
          Box
        </label>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color: showStick ? '#c8a060' : '#888', cursor:'pointer', userSelect:'none' }}>
          <input type="checkbox" checked={showStick} onChange={onStickChange}
            style={{ cursor:'pointer', accentColor:'#c8a060' }} />
          Stick
        </label>
        <div style={{ width:1, height:16, background:'#333' }} />
        <span style={{ fontSize:12, color:'#666', whiteSpace:'nowrap' }}>Temperature</span>
        <input type="range" min={25} max={200} step={1} value={temp} onChange={onTempChange}
          style={{ flex:1, accentColor:'#c06040', cursor:'pointer' }} />
        <span style={{ fontSize:12, color:'#c08060', fontVariantNumeric:'tabular-nums', minWidth:52 }}>
          {temp}°C
        </span>
      </div>
    </div>
  )
}
