import { useMemo, useRef, useEffect } from 'react'

const VW = 600
const VH = 350
const MATRIX_SPACING = 16
const H_STEP = MATRIX_SPACING * 2
const V_STEP = MATRIX_SPACING
const SI_PAD = MATRIX_SPACING / 2

// ── Physics constants ──────────────────────────────────────────
const GAMMA           = 0.003
const SUBSTEPS        = 30
const DT              = 1/60
const MAX_PUNCH_DISP  = 8
const PUNCH_RAMP      = 0.04
const VISUAL_SCALE    = 5

// Bond spring constants and break strains
const BOND_K = {
  'cc-near': 1.0,
  'cc-diag': 0.4,
  'ss':      3.0,
  'cs':      0.5,
}
const BOND_BREAK = {
  'cc-near': 0.035,
  'cc-diag': 0.020,
  'ss':      0.08,
  'cs':      0.18,
}
const NEAR_BOND  = MATRIX_SPACING * 1.15
const DIAG_BOND  = MATRIX_SPACING * Math.SQRT2 * 1.1
const GRAIN_BOND = H_STEP + 4
const IFACE_BOND = MATRIX_SPACING * 1.7

// Precomputed strain colour buckets
const STRAIN_COLORS = (() => {
  const out = []
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    if (t < 0.30) {
      out.push(`rgba(40,50,90,${(0.55 + t * 0.6).toFixed(2)})`)
    } else if (t < 0.70) {
      const u = (t - 0.30) / 0.40
      const r = Math.round(40  + u * 215)
      const g = Math.round(50  + u * 150)
      const b = Math.round(90  - u * 90)
      out.push(`rgba(${r},${g},${b},0.92)`)
    } else {
      const u = (t - 0.70) / 0.30
      const g = Math.round(200 * (1 - u))
      out.push(`rgba(255,${g},0,0.97)`)
    }
  }
  return out
})()

function strainBucket(strain, breakStrain) {
  return Math.min(10, Math.floor(Math.abs(strain) / breakStrain * 10))
}

// ── Seeded PRNG ────────────────────────────────────────────────
function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

// ── Grain layout ───────────────────────────────────────────────
const GRAIN_CFG = {
  0:  { count: 0,  minCols: 0, maxCols: 0, minRows: 0, maxRows: 0 },
  20: { count: 3,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  40: { count: 6,  minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  60: { count: 11, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
  80: { count: 18, minCols: 3, maxCols: 6, minRows: 2, maxRows: 5 },
}
const GRAIN_GRID = { 20: [3, 1], 40: [3, 2], 60: [4, 3], 80: [6, 3] }

function grainDims(siCols, siRows) {
  return {
    w: (siCols - 1) * H_STEP + SI_PAD * 2,
    h: (siRows - 1) * 2 * V_STEP + SI_PAD * 2,
  }
}

function buildGrains(sandPct, seed) {
  const cfg = GRAIN_CFG[sandPct]
  if (!cfg || cfg.count === 0) return []
  const rand = makeRand(seed)
  const count = cfg.count
  const [cols, rows] = GRAIN_GRID[sandPct] ?? [1, 1]
  const cellW = VW / cols
  const cellH = VH / rows
  const cells = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells.push({ cx: (c + 0.5) * cellW, cy: (r + 0.5) * cellH })
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j], cells[i]]
  }
  const grains = []
  for (let i = 0; i < count; i++) {
    const siCols = cfg.minCols + Math.round(rand() * (cfg.maxCols - cfg.minCols))
    const siRows = cfg.minRows + Math.round(rand() * (cfg.maxRows - cfg.minRows))
    const { w, h } = grainDims(siCols, siRows)
    const { cx, cy } = cells[i]
    const rawX = cx + (rand() - 0.5) * cellW * 0.40 - w / 2
    const rawY = cy + (rand() - 0.5) * cellH * 0.40 - h / 2
    const x = Math.round(rawX / MATRIX_SPACING) * MATRIX_SPACING
    const y = Math.max(Math.round(rawY / MATRIX_SPACING) * MATRIX_SPACING, MATRIX_SPACING * 6)
    grains.push({ x, y, w, h, id: i, siCols, siRows })
  }
  return grains
}

function buildLattice(g) {
  const { siCols, siRows } = g
  const nodes = []
  for (let si = 0; si < siRows; si++) {
    const y = g.y + SI_PAD + si * 2 * V_STEP
    for (let sc = 0; sc < siCols; sc++) {
      const x = g.x + SI_PAD + sc * H_STEP
      nodes.push({ x, y, type: 'Si' })
      if (sc < siCols - 1) nodes.push({ x: x + H_STEP / 2, y, type: 'O' })
    }
    if (si < siRows - 1) {
      const yO = y + V_STEP
      for (let sc = 0; sc < siCols; sc++) {
        nodes.push({ x: g.x + SI_PAD + sc * H_STEP, y: yO, type: 'O' })
        if (sc < siCols - 1)
          nodes.push({ x: g.x + SI_PAD + sc * H_STEP + H_STEP / 2, y: yO, type: 'O' })
      }
    }
  }
  return nodes
}

function buildIons(grains) {
  const ions = []
  function inGrain(x, y) {
    return grains.some(g =>
      x > g.x - SI_PAD && x < g.x + g.w + SI_PAD &&
      y > g.y - SI_PAD && y < g.y + g.h + SI_PAD
    )
  }
  for (let col = 0, x = MATRIX_SPACING / 2; x < VW; x += MATRIX_SPACING, col++) {
    for (let row = 0, y = MATRIX_SPACING / 2; y < VH; y += MATRIX_SPACING, row++) {
      if (inGrain(x, y)) continue
      const type = (col + row) % 2 === 0 ? 'Ca' : 'O'
      ions.push({ type, x, y, r: type === 'Ca' ? 5.5 : 3 })
    }
  }
  return ions
}

// ── Physics engine ─────────────────────────────────────────────
function buildPhysics(ions, grains, lattices) {
  const punchX = VW / 2
  const punchContactHW = 32

  const particles = []

  ions.forEach(ion => {
    particles.push({
      x0: ion.x, y0: ion.y, x: ion.x, y: ion.y,
      vx: 0, vy: 0,
      isGrain: false, grainIdx: -1,
      fixed: false, isPunch: false, inScope: true,
      type: ion.type, r: ion.r,
    })
  })
  const matrixCount = particles.length

  lattices.forEach((lat, gi) => {
    lat.forEach(node => {
      particles.push({
        x0: node.x, y0: node.y, x: node.x, y: node.y,
        vx: 0, vy: 0,
        isGrain: true, grainIdx: gi,
        fixed: true, isPunch: false, inScope: true,
      })
    })
  })

  const n = particles.length

  particles.forEach(p => {
    p.fixed = p.isGrain || p.y > VH - MATRIX_SPACING * 1.5
    p.isPunch = !p.fixed && p.y0 < MATRIX_SPACING * 3
  })

  const bonds = []
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    for (let j = i + 1; j < n; j++) {
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)

      let bondType = null
      if (!pi.isGrain && !pj.isGrain) {
        if (d <= NEAR_BOND) bondType = 'cc-near'
        else if (d <= DIAG_BOND) bondType = 'cc-diag'
      } else if (pi.isGrain && pj.isGrain && pi.grainIdx === pj.grainIdx) {
        if (d <= GRAIN_BOND) bondType = 'ss'
      } else if (pi.isGrain !== pj.isGrain) {
        if (d <= IFACE_BOND) bondType = 'cs'
      }

      if (!bondType) continue

      const nearPunch = bondType !== 'cs' &&
        ((pi.y < MATRIX_SPACING * 3 && Math.abs(pi.x - punchX) < punchContactHW * 1.5) ||
         (pj.y < MATRIX_SPACING * 3 && Math.abs(pj.x - punchX) < punchContactHW * 1.5))
      const effectiveBreak = nearPunch ? BOND_BREAK[bondType] * 0.55 : BOND_BREAK[bondType]

      bonds.push({
        i, j,
        restLen: d,
        k: BOND_K[bondType],
        breakStrain: effectiveBreak,
        strain: 0,
        broken: false,
        type: bondType,
      })
    }
  }

  const fx = new Float32Array(n)
  const fy = new Float32Array(n)

  return { particles, bonds, n, matrixCount, fx, fy, currentDisp: 0 }
}

function stepPhysics(phys, forceVal) {
  const { particles, bonds, n, fx, fy } = phys
  const dt = DT / SUBSTEPS

  const targetDisp = forceVal * MAX_PUNCH_DISP
  const gap = targetDisp - phys.currentDisp
  const totalRamp = Math.sign(gap) * Math.min(PUNCH_RAMP, Math.abs(gap))
  const rampPerSub = totalRamp / SUBSTEPS

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    phys.currentDisp += rampPerSub
    for (let i = 0; i < n; i++) {
      if (particles[i].isPunch) particles[i].y = particles[i].y0 + phys.currentDisp
    }
    fx.fill(0)
    fy.fill(0)

    for (let b = 0; b < bonds.length; b++) {
      const bond = bonds[b]
      if (bond.broken) continue
      const pi = particles[bond.i]
      const pj = particles[bond.j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d = Math.hypot(dx, dy)
      if (d < 0.001) continue
      const strain = (d - bond.restLen) / bond.restLen
      bond.strain = strain
      if (Math.abs(strain) > bond.breakStrain) {
        bond.broken = true
        continue
      }
      const f = bond.k * (d - bond.restLen)
      const nx = dx / d, ny = dy / d
      if (!pi.fixed && !pi.isPunch) { fx[bond.i] += f * nx; fy[bond.i] += f * ny }
      if (!pj.fixed && !pj.isPunch) { fx[bond.j] -= f * nx; fy[bond.j] -= f * ny }
    }

    for (let i = 0; i < n; i++) {
      const p = particles[i]
      if (p.fixed || p.isPunch) continue
      const vx = fx[i] / GAMMA
      const vy = fy[i] / GAMMA
      p.x += vx * dt
      p.y += vy * dt
    }
  }
}

// ── Canvas scene rendering ─────────────────────────────────────
function drawScene(canvas, phys) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const W   = canvas.clientWidth
  const H   = canvas.clientHeight
  if (!W || !H) return

  const cw = Math.round(W * dpr)
  const ch = Math.round(H * dpr)
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width  = cw
    canvas.height = ch
  }

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, cw, ch)

  const scale   = Math.min(W / VW, H / VH) * dpr
  const offsetX = (W * dpr - VW * scale) / 2
  const offsetY = (H * dpr - VH * scale) / 2
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY)

  const { particles, bonds, matrixCount } = phys

  const vx = p => p.x0 + (p.x - p.x0) * VISUAL_SCALE
  const vy = p => p.y0 + (p.y - p.y0) * VISUAL_SCALE

  // Bonds coloured by strain energy
  const batches = Array.from({ length: 11 }, () => [])
  for (let b = 0; b < bonds.length; b++) {
    const bond = bonds[b]
    if (bond.broken || bond.type === 'ss') continue
    const bucket = strainBucket(bond.strain, bond.breakStrain)
    if (bucket === 0) continue
    batches[bucket].push(b)
  }

  for (let bucket = 1; bucket <= 10; bucket++) {
    const list = batches[bucket]
    if (!list.length) continue
    ctx.strokeStyle = STRAIN_COLORS[bucket]
    ctx.lineWidth = 1.8
    ctx.beginPath()
    for (const b of list) {
      const bond = bonds[b]
      const pi = particles[bond.i]
      const pj = particles[bond.j]
      ctx.moveTo(vx(pi), vy(pi))
      ctx.lineTo(vx(pj), vy(pj))
    }
    ctx.stroke()
  }

  // Matrix atoms
  for (let i = 0; i < matrixCount; i++) {
    const p = particles[i]
    ctx.beginPath()
    ctx.arc(vx(p), vy(p), p.r, 0, Math.PI * 2)
    ctx.fillStyle = p.type === 'Ca' ? C.Ca : C.O
    ctx.globalAlpha = 0.85
    ctx.fill()
  }
  ctx.globalAlpha = 1

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// ── Per-particle jitter (thermal animation) ────────────────────
function jitterStyle(idx) {
  function h(n) {
    let v = (n ^ 0xdeadbeef) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    v = (((v >> 16) ^ v) * 0x45d9f3b) | 0
    return ((v >> 16) ^ v) | 0
  }
  const amp = (n) => ((h(idx * 11 + n) & 0xFF) / 127.5 - 1) * 0.7
  const dur = (0.18 + (h(idx * 11 + 8) & 0x1F) * 0.008).toFixed(3)
  const del = -((h(idx * 11 + 9) & 0xFF) * 0.004).toFixed(3)
  return {
    '--j1x': `${amp(0).toFixed(2)}px`, '--j1y': `${amp(1).toFixed(2)}px`,
    '--j2x': `${amp(2).toFixed(2)}px`, '--j2y': `${amp(3).toFixed(2)}px`,
    '--j3x': `${amp(4).toFixed(2)}px`, '--j3y': `${amp(5).toFixed(2)}px`,
    '--j4x': `${amp(6).toFixed(2)}px`, '--j4y': `${amp(7).toFixed(2)}px`,
    animation: `particle-jitter ${dur}s linear ${del}s infinite`,
  }
}

const C = {
  Si: '#d4a020', O: '#cc3a3a', Ca: '#4a96be',
  bg: '#ede8df', grain: '#d8cb98', stroke: '#a09050',
}

function LegendDot({ cx, cy, r, fill, label }) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <text x={cx + r + 5} y={cy + 4} className="micro-legend">{label}</text>
    </>
  )
}

// ── MicroPanel component ───────────────────────────────────────
export default function MicroPanel({ sandPct, phase = 'idle', layoutSeed = 0, force = 0, calcScope = 'everything' }) {
  const grains   = useMemo(() => buildGrains(sandPct, layoutSeed * 7919 + sandPct * 137 + 42), [sandPct, layoutSeed])
  const ions     = useMemo(() => buildIons(grains), [grains])
  const lattices = useMemo(() => grains.map(buildLattice), [grains])

  const canvasRef = useRef(null)
  const physRef   = useRef(null)
  const rafRef    = useRef(null)
  const forceRef  = useRef(force)

  useEffect(() => { forceRef.current = force }, [force])

  useEffect(() => {
    physRef.current = buildPhysics(ions, grains, lattices)
  }, [ions, grains, lattices])

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)

    if (phase === 'idle') {
      physRef.current = buildPhysics(ions, grains, lattices)
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return
    }

    if (phase !== 'testing') return

    function frame() {
      const phys = physRef.current
      if (!phys) return
      stepPhysics(phys, forceRef.current)
      drawScene(canvasRef.current, phys)
      rafRef.current = requestAnimationFrame(frame)
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [phase])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
        className="panel-svg"
      >
        <defs>
          <clipPath id="micro-clip">
            <rect width={VW} height={VH} rx={4} />
          </clipPath>
        </defs>

        <g clipPath="url(#micro-clip)">
          <rect width={VW} height={VH} fill={C.bg} rx={4} />

          {phase === 'idle' && ions.map((ion, i) => (
            <circle key={i}
              cx={ion.x} cy={ion.y} r={ion.r}
              fill={ion.type === 'Ca' ? C.Ca : C.O}
              opacity={0.85}
              style={jitterStyle(i * 73 + 29)}
            />
          ))}

          {grains.map((g, gi) => (
            <g key={g.id}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h}
                fill={C.grain} stroke={C.stroke} strokeWidth={1.5} rx={3} />
              {lattices[gi].map((node, ni) => (
                <circle key={ni}
                  cx={node.x} cy={node.y}
                  r={node.type === 'Si' ? 4 : 3}
                  fill={node.type === 'Si' ? C.Si : C.O}
                  opacity={0.82}
                  style={jitterStyle((gi * 500 + ni) * 137 + 42)}
                />
              ))}
            </g>
          ))}

          <g transform={`translate(10, ${VH - 18})`}>
            <LegendDot cx={6}   cy={0} r={4} fill={C.Si} label="Si" />
            <LegendDot cx={46}  cy={0} r={3} fill={C.O}  label="O (grain)" />
            <LegendDot cx={115} cy={0} r={4} fill={C.Ca} label="Ca²⁺" />
            <LegendDot cx={162} cy={0} r={3} fill={C.O}  label="O²⁻" />
          </g>
        </g>
      </svg>

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
