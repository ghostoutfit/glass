import { useEffect, useRef, useCallback, useState } from 'react'

const W = 500, H = 500
const BOX_HS    = 180
const BOX_SIZE  = BOX_HS * 2
const BALL_R    = 20
const N_REGULAR = 10
const N_SUPER   = 1
const CONVERT_INTERVAL = 5   // seconds between ball→super conversions

const S_BLOB_R   = BALL_R  // outer radius of blob — matches ball it replaces
const S_R_CTR    = 3      // tiny phantom anchor, shielded from all collisions
const S_R_ORB    = 4      // radius of each sub-circle
const S_SPACING  = S_R_ORB * 2 + 0.5   // hex grid pitch — 0.5px gap keeps PBD non-degenerate
const S_K_RAD    = 300
const S_K_NBR    = 150
const MERGE_FRAMES = 35
const MERGE_TOUCH  = 4
const MERGE_K      = 0.20
const SPAWN_FRAMES = 90    // frames during which new sub-circles use soft collision

const GRAVITY        = 600
const DAMPING        = 0.975
const WALL_REST      = 0.35
const BALL_REST      = 0.25
const RESOLVE_PASSES = 20
const FIXED_DT       = 1 / 120

// ── Helpers ───────────────────────────────────────────────────────────────
function mkP(x, y, r) { return { x, y, vx: 0, vy: 0, _px: x, _py: y, r } }
function dist2(a, b) { const dx=b.x-a.x, dy=b.y-a.y; return dx*dx+dy*dy }
function randPos(margin) {
  const hi = BOX_HS - margin - 2
  return [(Math.random()*2-1)*hi, (Math.random()*2-1)*hi]
}

// ── Blob factories ────────────────────────────────────────────────────────
// Returns [x,y] offsets for a hex-packed fill of a circle of radius blobR
// using sub-circles of radius r (0.5px gap between adjacent circles).
function hexPack(blobR, r) {
  const spacing = r * 2 + 0.5
  const rowH    = spacing * Math.sqrt(3) * 0.5
  const innerR  = blobR - r
  const rows    = Math.ceil(innerR / rowH)
  const cols    = Math.ceil(innerR / spacing)
  const out = []
  for (let row = -rows; row <= rows; row++) {
    const y    = row * rowH
    const xOff = Math.abs(row) % 2 === 1 ? spacing * 0.5 : 0
    for (let col = -cols; col <= cols; col++) {
      const x = col * spacing + xOff
      if (x*x + y*y <= innerR * innerR) out.push([x, y])
    }
  }
  return out
}

function makeSuper(cx, cy, vx=0, vy=0) {
  const positions = hexPack(S_BLOB_R, S_R_ORB)
  const ctr = mkP(cx, cy, S_R_CTR); ctr.vx=vx; ctr.vy=vy
  const pts = [ctr, ...positions.map(([x, y]) => {
    const p = mkP(cx+x, cy+y, S_R_ORB); p.vx=vx; p.vy=vy; p._spawnAge=SPAWN_FRAMES; return p
  })]

  const spr = []
  // Radial: phantom center → each sub-circle at its rest distance
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k], dx = p.x-cx, dy = p.y-cy
    spr.push({ a: 0, b: k, rest: Math.sqrt(dx*dx+dy*dy) || 0.001, k: S_K_RAD })
  }
  // Neighbor: springs between sub-circles within 1.5× the grid pitch
  const thresh2 = (S_SPACING * 1.5) ** 2
  for (let i = 1; i < pts.length; i++) {
    for (let j = i+1; j < pts.length; j++) {
      const dx = pts[j].x-pts[i].x, dy = pts[j].y-pts[i].y
      const d2 = dx*dx+dy*dy
      if (d2 < thresh2) spr.push({ a: i, b: j, rest: Math.sqrt(d2), k: S_K_NBR })
    }
  }
  return { particles: pts, springs: spr, merged: false }
}

// Merge: drop all springs — sub-circles become free sand particles.
// PBD collision response alone keeps them packed; no spring artifacts.
function mergeBlobs(b1, b2) {
  const allOrb = [...b1.particles.slice(1), ...b2.particles.slice(1)]
  let cx=0, cy=0, avgVx=0, avgVy=0
  for (const p of allOrb) { cx+=p.x; cy+=p.y; avgVx+=p.vx; avgVy+=p.vy }
  cx /= allOrb.length; cy /= allOrb.length
  avgVx /= allOrb.length; avgVy /= allOrb.length
  const ctr = mkP(cx, cy, S_R_CTR); ctr.vx=avgVx; ctr.vy=avgVy
  return { particles: [ctr, ...allOrb], springs: [], merged: true }
}

// ── State ─────────────────────────────────────────────────────────────────
function initState() {
  const balls = []
  for (let i = 0; i < N_REGULAR; i++) {
    const [x, y] = randPos(BALL_R)
    balls.push(mkP(x, y, BALL_R))
  }
  const supers = []
  for (let i = 0; i < N_SUPER; i++) {
    const [x, y] = randPos(S_BLOB_R + 4)
    supers.push(makeSuper(x, y))
  }
  return { balls, supers, boxAngle: 0, rotating: true, accumulator: 0, prevTime: null, mct: {}, totalTime: 0, lastConvert: 0 }
}

// ── Spring forces ─────────────────────────────────────────────────────────
function applySpringForces(sc, dt) {
  const p = sc.particles
  for (const s of sc.springs) {
    const a = p[s.a], b = p[s.b]
    const dx = b.x-a.x, dy = b.y-a.y
    const d  = Math.sqrt(dx*dx+dy*dy) || 0.01
    const f  = s.k * (d - s.rest)
    const fx = f*dx/d, fy = f*dy/d
    a.vx += fx*dt; a.vy += fy*dt
    b.vx -= fx*dt; b.vy -= fy*dt
  }
}

// ── Merge check ───────────────────────────────────────────────────────────
function checkAndDoMerges(state) {
  const { supers, mct } = state
  let merged = false
  for (let i = 0; i < supers.length && !merged; i++) {
    for (let j = i+1; j < supers.length && !merged; j++) {
      const key = `${i},${j}`
      let close = false
      outer: for (const a of supers[i].particles) for (const b of supers[j].particles) {
        const t = a.r + b.r + MERGE_TOUCH
        if (dist2(a, b) < t*t) { close = true; break outer }
      }
      if (close) {
        mct[key] = (mct[key] || 0) + 1
        if (mct[key] >= MERGE_FRAMES) {
          supers[i] = mergeBlobs(supers[i], supers[j])
          supers.splice(j, 1)
          for (const k of Object.keys(mct)) delete mct[k]
          merged = true
        }
      } else if (mct[key] > 0) {
        mct[key]--
      }
    }
  }
}

// ── Physics step ──────────────────────────────────────────────────────────
function stepPhysics(state, dt) {
  const { balls, supers, boxAngle } = state
  const gx = GRAVITY * Math.sin(boxAngle)
  const gy = GRAVITY * Math.cos(boxAngle)

  const all = [...balls]
  const superOf = new Map()
  for (let si = 0; si < supers.length; si++)
    for (const p of supers[si].particles) { all.push(p); superOf.set(p, si) }
  const n = all.length

  for (const p of all) { p._px = p.x; p._py = p.y }
  for (const sc of supers) applySpringForces(sc, dt)
  for (const p of all) { p.vx += gx*dt; p.vy += gy*dt; p.x += p.vx*dt; p.y += p.vy*dt }

  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    for (let ai = 0; ai < n; ai++) {
      for (let bi = ai+1; bi < n; bi++) {
        // Center anchor is a phantom — never collides with anything.
        // Orbit circles of the SAME super DO collide; that's what prevents compression.
        if (all[ai].r === S_R_CTR || all[bi].r === S_R_CTR) continue

        const a = all[ai], b = all[bi]
        const dx = b.x-a.x, dy = b.y-a.y
        const d2 = dx*dx+dy*dy, minD = a.r+b.r
        if (d2 >= minD*minD || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        const isNew = (a._spawnAge > 0) || (b._spawnAge > 0)
        const push = (minD-d) * (isNew ? 0.01 : 0.5)
        const nx = dx/d, ny = dy/d
        a.x -= nx*push; a.y -= ny*push
        b.x += nx*push; b.y += ny*push
      }
    }
    for (const p of all) {
      const hi = BOX_HS - p.r
      if (p.x < -hi) p.x=-hi; if (p.x > hi) p.x=hi
      if (p.y < -hi) p.y=-hi; if (p.y > hi) p.y=hi
    }
  }

  for (const p of all) { p.vx = (p.x-p._px)/dt; p.vy = (p.y-p._py)/dt }

  for (const p of all) {
    const hi = BOX_HS - p.r
    if (p.x <= -hi+0.1 && p.vx < 0) p.vx *= -WALL_REST
    if (p.x >=  hi-0.1 && p.vx > 0) p.vx *= -WALL_REST
    if (p.y <= -hi+0.1 && p.vy < 0) p.vy *= -WALL_REST
    if (p.y >=  hi-0.1 && p.vy > 0) p.vy *= -WALL_REST
  }

  for (let ai = 0; ai < n; ai++) {
    for (let bi = ai+1; bi < n; bi++) {
      if (all[ai].r === S_R_CTR || all[bi].r === S_R_CTR) continue
      const a = all[ai], b = all[bi]
      const dx = b.x-a.x, dy = b.y-a.y
      const d = Math.sqrt(dx*dx+dy*dy)
      if (d > a.r+b.r+0.5) continue
      const nx = dx/d, ny = dy/d
      const vrel = (b.vx-a.vx)*nx+(b.vy-a.vy)*ny
      if (vrel >= 0) continue
      const imp = -(1+BALL_REST)*vrel*0.5
      a.vx -= imp*nx; a.vy -= imp*ny
      b.vx += imp*nx; b.vy += imp*ny
    }
  }

  for (const p of all) { p.vx *= DAMPING; p.vy *= DAMPING }
  for (const p of all) if (p._spawnAge > 0) p._spawnAge--
  checkAndDoMerges(state)
}

// ── Rendering ─────────────────────────────────────────────────────────────
// Andrew's monotone chain — returns surface points in CCW hull order.
function convexHull(pts) {
  if (pts.length < 3) return pts
  const s = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y)
  const cross = (O, A, B) => (A.x-O.x)*(B.y-O.y) - (A.y-O.y)*(B.x-O.x)
  const lo = [], hi = []
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], p) <= 0) lo.pop()
    lo.push(p)
  }
  for (let i = s.length-1; i >= 0; i--) {
    const p = s[i]
    while (hi.length >= 2 && cross(hi[hi.length-2], hi[hi.length-1], p) <= 0) hi.pop()
    hi.push(p)
  }
  hi.pop(); lo.pop()
  return [...lo, ...hi]
}

// Convex hull of all sub-circle surface points, then Catmull-Rom through the hull.
// Hull order is always correct CCW perimeter order; convexity prevents inward spikes.
function buildBlobPath(ctx, sc) {
  const orbits = sc.particles.filter(p => p.r >= S_R_ORB)
  if (orbits.length < 3) return false

  let cx=0, cy=0
  for (const p of orbits) { cx+=p.x; cy+=p.y }
  cx /= orbits.length; cy /= orbits.length

  // Surface point: outermost point of each sub-circle in the COM→center direction
  const surf = orbits.map(c => {
    const dx = c.x-cx, dy = c.y-cy, d = Math.hypot(dx, dy) || 1
    return { x: c.x + c.r*dx/d, y: c.y + c.r*dy/d }
  })

  const hull = convexHull(surf)
  const h = hull.length
  if (h < 3) return false

  ctx.beginPath()
  ctx.moveTo(hull[0].x, hull[0].y)
  for (let i = 0; i < h; i++) {
    const p0 = hull[(i-1+h)%h], p1 = hull[i]
    const p2 = hull[(i+1)%h],   p3 = hull[(i+2)%h]
    ctx.bezierCurveTo(
      p1.x + (p2.x-p0.x)/6, p1.y + (p2.y-p0.y)/6,
      p2.x - (p3.x-p1.x)/6, p2.y - (p3.y-p1.y)/6,
      p2.x, p2.y
    )
  }
  ctx.closePath()
  return true
}

// ── Component ─────────────────────────────────────────────────────────────
export default function BlobTestbed() {
  const canvasRef  = useRef(null)
  const stateRef   = useRef(null)
  const solidRef   = useRef(false)
  const [solid, setSolid] = useState(false)
  const getState   = () => { if (!stateRef.current) stateRef.current = initState(); return stateRef.current }
  const handleClick = useCallback(() => { const s=getState(); s.rotating=!s.rotating }, [])
  const handleSolid = useCallback(e => { solidRef.current = e.target.checked; setSolid(e.target.checked) }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx    = canvas.getContext('2d')
    let rafId

    function loop(ts) {
      const s = getState()
      if (s.prevTime === null) s.prevTime = ts
      const elapsed = Math.min((ts - s.prevTime) / 1000, 0.05)
      s.prevTime = ts
      if (s.rotating) s.boxAngle += elapsed * 0.4
      s.totalTime += elapsed
      if (s.balls.length > 0 && s.totalTime - s.lastConvert >= CONVERT_INTERVAL) {
        s.lastConvert = s.totalTime
        const idx = Math.floor(Math.random() * s.balls.length)
        const b = s.balls.splice(idx, 1)[0]
        s.supers.push(makeSuper(b.x, b.y, b.vx, b.vy))
      }
      s.accumulator += elapsed
      while (s.accumulator >= FIXED_DT) { stepPhysics(s, FIXED_DT); s.accumulator -= FIXED_DT }

      ctx.clearRect(0, 0, W, H)
      ctx.save()
      ctx.translate(W/2, H/2)
      ctx.rotate(s.boxAngle)

      // Clip all content to the box interior — outline can never bleed outside
      ctx.beginPath()
      ctx.rect(-BOX_HS, -BOX_HS, BOX_SIZE, BOX_SIZE)
      ctx.clip()

      // Regular balls
      ctx.fillStyle = '#e8a030'
      for (const b of s.balls) {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.fill()
      }

      // Super-circles
      const isSolid = solidRef.current
      for (const sc of s.supers) {
        if (!sc.merged) {
          // Unmerged: filled convex-hull shape — looks like a smooth circle
          if (buildBlobPath(ctx, sc)) {
            ctx.fillStyle = '#5090e0'
            ctx.fill()
          }
        } else {
          // Merged: individual sand sub-circles + purple hull outline
          ctx.fillStyle = '#9060cc'
          for (const p of sc.particles) {
            if (p.r < S_R_ORB) continue
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill()
          }
          if (buildBlobPath(ctx, sc)) {
            ctx.strokeStyle = '#dd44ff'
            ctx.lineWidth = 2
            ctx.stroke()
            if (isSolid) {
              buildBlobPath(ctx, sc)
              ctx.fillStyle = '#b43cff'
              ctx.fill()
            }
          }
        }
      }

      ctx.restore()

      // Box walls drawn after restore, on top of everything, in their own transform
      ctx.save()
      ctx.translate(W/2, H/2)
      ctx.rotate(s.boxAngle)
      ctx.strokeStyle = '#555'
      ctx.lineWidth = 2
      ctx.strokeRect(-BOX_HS, -BOX_HS, BOX_SIZE, BOX_SIZE)
      ctx.restore()
      rafId = requestAnimationFrame(loop)
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
                  justifyContent:'center', height:'100%', gap:16 }}>
      <canvas ref={canvasRef} width={W} height={H} onClick={handleClick}
        style={{ cursor:'pointer', border:'1px solid #333', background:'#111' }} />
      <div style={{ display:'flex', alignItems:'center', gap:20 }}>
        <span style={{ color:'#888', fontSize:13 }}>
          click to pause · blue rings merge purple on sustained contact
        </span>
        <label style={{ display:'flex', alignItems:'center', gap:6, color:'#cc88ff', fontSize:13, cursor:'pointer' }}>
          <input type="checkbox" checked={solid} onChange={handleSolid} />
          solid overlay
        </label>
      </div>
    </div>
  )
}
