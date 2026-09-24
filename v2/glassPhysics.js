// Clavet, Beaudoin & Poulin (2005) — Step 4
// Adds temperature wiring: all viscoelastic params mapped to 25°C–1200°C

export const PARTICLE_R  = 4.5
export const H           = 12
export const N_PARTICLES = 500
export const FIXED_DT    = 1 / 120

const GRAVITY    = 900
const MAX_SPEED  = 800   // px/s — caps individual particle velocity to prevent high-temp explosions
// Walls: hard boundary, zero friction, zero restitution — particles settle at contact, never penetrate

// Double density (Alg 2) — pressure/incompressibility, temperature-invariant
// REST_DENSITY > typical surface density → negative pressure at edges = cohesion/stickiness
const K_PRESSURE   = 1000
const K_NEAR       = 3000
const REST_DENSITY = 0.8

// ── Temperature → parameter mapping ──────────────────────────────────────────
// All viscoelastic params use geometric (log-linear) interpolation so the
// curve feels exponential — matches Arrhenius/VTF viscosity behaviour of glass.
//
// t = 0 → 25°C (cold, near-solid)
// t = 1 → 1200°C (hot, freely flowing melt)
//
//   ~600°C (t≈0.49): glass transition — steep viscosity drop here

const SIGMA_COLD  = 60     // linear viscosity cold end — stability limit ≈ 80 (6 neighbors × dt × 0.5 × σ ≤ 1)
const SIGMA_HOT   = 25     // linear viscosity hot end — capped at former 700°C value
const ALPHA_COLD  = 0.005  // plasticity rate cold (springs persist ~200 s → near-solid)
const ALPHA_HOT   = 0.019  // plasticity rate hot — capped at former 700°C value
const K_SPRING_COLD = 15000 // spring stiffness cold — stability limit ≈ 19000 (6 springs × dt² × K × 0.25 ≤ 2)
const K_SPRING_HOT  = 7000  // spring stiffness hot — capped at former 700°C value

// Global velocity damping — the key to solid behavior at cold temperatures.
// SPH alone is always a fluid. This overdamps inertia so springs dominate:
// particles can't accelerate, only the spring restoring force moves them.
// Cubic falloff keeps it near-zero above ~700°C so the hot fluid feels free.
const VELDAMP_COLD = 0.15  // fraction of velocity killed per step at 25°C — enough to overdamp springs, not enough to freeze translation
const RIGID_COLD   = 0.95  // rigid body blend fraction at 25°C (1 = fully rigid)

function glerp(a, b, t) {
  return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t)
}

export function tempParams(tempC) {
  const t = Math.max(0, Math.min(1, (tempC - 25) / (1200 - 25)))
  // Fluid params (sigma/spring/plasticity) only start easing above 590°C — that's
  // the viscoelastic peak. Below 590°C they stay at full cold-end values; the rigid
  // body projection takes over rather than making the blob look "more viscous."
  const tf = Math.max(0, Math.min(1, (tempC - 590) / (1200 - 590)))
  // Cubic falloff: velDamp and rigidFrac still use the full 25–1200°C range
  const velDamp    = VELDAMP_COLD * Math.pow(1 - t, 3)
  const rigidFrac  = RIGID_COLD   * Math.pow(1 - t, 3)
  return {
    sigma:   glerp(SIGMA_COLD,    SIGMA_HOT,    tf),
    alpha:   glerp(ALPHA_COLD,    ALPHA_HOT,    tf),
    kSpring: glerp(K_SPRING_COLD, K_SPRING_HOT, tf),
    velDamp, rigidFrac,
    gamma:   0.2,
    beta:    0.0,
  }
}

// ── Spatial hash ──────────────────────────────────────────────────────────────
function cellKey(ix, iy) { return (ix + 500) * 1001 + (iy + 500) }

function buildHash(particles) {
  const table = new Map()
  for (let i = 0; i < particles.length; i++) {
    const p   = particles[i]
    const ix  = Math.floor(p.x / H)
    const iy  = Math.floor(p.y / H)
    const key = cellKey(ix, iy)
    let cell  = table.get(key)
    if (!cell) { cell = []; table.set(key, cell) }
    cell.push(i)
  }
  return table
}

function getNeighbors(table, x, y) {
  const ix0 = Math.floor(x / H)
  const iy0 = Math.floor(y / H)
  const out  = []
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const cell = table.get(cellKey(ix0 + dx, iy0 + dy))
      if (cell) for (const j of cell) out.push(j)
    }
  return out
}

// ── Viscosity impulses (Alg 1 step 2) ────────────────────────────────────────
function applyViscosity(particles, dt, table, sigma, beta) {
  for (let i = 0; i < particles.length; i++) {
    const pi  = particles[i]
    const nbs = getNeighbors(table, pi.x, pi.y)
    for (const j of nbs) {
      if (j <= i) continue
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d2 = dx * dx + dy * dy
      if (d2 === 0 || d2 >= H * H) continue
      const dist = Math.sqrt(d2)
      const nx = dx / dist, ny = dy / dist
      const u  = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
      if (u <= 0) continue
      const q   = dist / H
      const mag = Math.min(0.5 * dt * (1 - q) * (sigma * u + beta * u * u), u * 0.4)
      pi.vx -= mag * nx;  pi.vy -= mag * ny
      pj.vx += mag * nx;  pj.vy += mag * ny
    }
  }
}

// ── Spring key ────────────────────────────────────────────────────────────────
function springKey(i, j) {
  return i < j ? i * N_PARTICLES + j : j * N_PARTICLES + i
}

// ── Algorithm 3: Spring Adjustment ───────────────────────────────────────────
function adjustSprings(particles, springs, table, dt, alpha, gamma) {
  for (const [key, L] of springs) {
    const i  = Math.floor(key / N_PARTICLES)
    const j  = key % N_PARTICLES
    const pi = particles[i], pj = particles[j]
    const dx = pj.x - pi.x, dy = pj.y - pi.y
    const r  = Math.sqrt(dx * dx + dy * dy)

    if (r >= H) { springs.delete(key); continue }

    const d = gamma * L
    let newL = L
    if      (r > L + d) newL += dt * alpha * (r - L - d)
    else if (r < L - d) newL -= dt * alpha * (L - d - r)

    if (newL >= H) springs.delete(key)
    else           springs.set(key, newL)
  }

  for (let i = 0; i < particles.length; i++) {
    const pi  = particles[i]
    const nbs = getNeighbors(table, pi.x, pi.y)
    for (const j of nbs) {
      if (j <= i) continue
      const key = springKey(i, j)
      if (springs.has(key)) continue
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const r  = Math.sqrt(dx * dx + dy * dy)
      if (r > 0 && r < H) springs.set(key, r)
    }
  }
}

// ── Algorithm 4: Spring Displacements ────────────────────────────────────────
function applySpringDisplacements(particles, springs, dt, kSpring) {
  const dt2 = dt * dt
  for (const [key, L] of springs) {
    const i  = Math.floor(key / N_PARTICLES)
    const j  = key % N_PARTICLES
    const pi = particles[i], pj = particles[j]
    const dx = pj.x - pi.x, dy = pj.y - pi.y
    const r  = Math.sqrt(dx * dx + dy * dy)
    if (r === 0) continue
    const mag = dt2 * kSpring * (1 - L / H) * (L - r)
    const nx = dx / r, ny = dy / r
    pi.x -= nx * mag * 0.5;  pi.y -= ny * mag * 0.5
    pj.x += nx * mag * 0.5;  pj.y += ny * mag * 0.5
  }
}

// ── Algorithm 2: Double Density Relaxation ───────────────────────────────────
function doubleDensityRelaxation(particles, dt, table) {
  const dt2 = dt * dt
  const H2  = H * H
  for (let i = 0; i < particles.length; i++) {
    const pi  = particles[i]
    const nbs = getNeighbors(table, pi.x, pi.y)
    let rho = 0, rhoN = 0
    for (const j of nbs) {
      if (j === i) continue
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d2 = dx * dx + dy * dy
      if (d2 > 0 && d2 < H2) {
        const q1 = 1 - Math.sqrt(d2) / H
        rho  += q1 * q1
        rhoN += q1 * q1 * q1
      }
    }
    const P  = K_PRESSURE * (rho  - REST_DENSITY)
    const PN = K_NEAR     * rhoN
    let dxi = 0, dyi = 0
    for (const j of nbs) {
      if (j === i) continue
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d2 = dx * dx + dy * dy
      if (d2 > 0 && d2 < H2) {
        const dist = Math.sqrt(d2)
        const q1   = 1 - dist / H
        const mag  = dt2 * (P * q1 + PN * q1 * q1)
        const nx = dx / dist, ny = dy / dist
        pj.x += nx * mag * 0.5;  pj.y += ny * mag * 0.5
        dxi  -= nx * mag * 0.5;  dyi  -= ny * mag * 0.5
      }
    }
    pi.x += dxi;  pi.y += dyi
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export function initParticles() {
  const particles = []
  const cols    = Math.ceil(Math.sqrt(N_PARTICLES * 1.3))
  const spacing = PARTICLE_R * 2.2
  for (let i = 0; i < N_PARTICLES; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x   = (col - cols / 2 + 0.5) * spacing + (Math.random() - 0.5)
    const y   = (row - Math.ceil(N_PARTICLES / cols) / 2) * spacing - 30 + (Math.random() - 0.5)
    particles.push({ x, y, vx: 0, vy: 0, px: x, py: y })
  }
  return particles
}

// ── Overlap resolution ────────────────────────────────────────────────────────
// Hard position constraint: particles never overlap regardless of temperature.
// Runs after DDR; rebuilds hash from current positions for accuracy.
function resolveOverlaps(particles) {
  const minD  = PARTICLE_R * 2
  const minD2 = minD * minD
  const table = buildHash(particles)
  for (let i = 0; i < particles.length; i++) {
    const pi  = particles[i]
    const nbs = getNeighbors(table, pi.x, pi.y)
    for (const j of nbs) {
      if (j <= i) continue
      const pj = particles[j]
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d2 = dx * dx + dy * dy
      if (d2 > 0 && d2 < minD2) {
        const d    = Math.sqrt(d2)
        const push = (minD - d) * 0.5
        const nx = dx / d, ny = dy / d
        pi.x -= nx * push;  pi.y -= ny * push
        pj.x += nx * push;  pj.y += ny * push
      }
    }
  }
}

// ── Rigid body wall friction ──────────────────────────────────────────────────
// Per-particle wall friction causes sticking in rigid body mode because the
// rigid body projection spreads each contact particle's "zero tangential"
// signal across the whole blob. Instead, detect wall contact, then apply a
// single tangential friction impulse to the CM so the blob slides correctly.
function applyRigidBodyWallFriction(particles, lim, rigidFrac) {
  if (rigidFrac <= 0.1) return
  const friction = (1 - WALL_FRICTION) * rigidFrac

  let touchLR = false, touchTB = false
  let vcx = 0, vcy = 0
  for (const p of particles) {
    vcx += p.vx; vcy += p.vy
    if (Math.abs(p.x) >= lim - 0.5) touchLR = true
    if (Math.abs(p.y) >= lim - 0.5) touchTB = true
  }
  vcx /= particles.length; vcy /= particles.length

  // Damp CM velocity along the wall's tangent direction
  const dvcx = touchTB ? -vcx * friction : 0
  const dvcy = touchLR ? -vcy * friction : 0
  if (dvcx === 0 && dvcy === 0) return
  for (const p of particles) { p.vx += dvcx; p.vy += dvcy }
}

// ── Rigid body velocity projection ───────────────────────────────────────────
// Blends each particle's velocity toward the rigid body velocity field
// (v_cm + ω × r_i). At rigidFrac=1 the blob moves as one solid object;
// at 0 it's purely fluid. Uses same cubic temperature curve as velDamp.
function applyRigidBodyProjection(particles, rigidFrac) {
  if (rigidFrac <= 0) return
  const N = particles.length

  // Center of mass position and velocity
  let cx = 0, cy = 0, vcx = 0, vcy = 0
  for (const p of particles) { cx += p.x; cy += p.y; vcx += p.vx; vcy += p.vy }
  cx /= N; cy /= N; vcx /= N; vcy /= N

  // Angular velocity: ω = Σ(r × Δv) / Σ|r|²
  let I = 0, omega = 0
  for (const p of particles) {
    const rx = p.x - cx, ry = p.y - cy
    I     += rx * rx + ry * ry
    omega += rx * (p.vy - vcy) - ry * (p.vx - vcx)
  }
  if (I > 0) omega /= I

  // Blend each velocity toward its rigid body target
  for (const p of particles) {
    const rx = p.x - cx, ry = p.y - cy
    p.vx += (vcx - omega * ry - p.vx) * rigidFrac
    p.vy += (vcy + omega * rx - p.vy) * rigidFrac
  }
}

export function stepPhysics(particles, springs, dt, HS, boxAngle, tempC) {
  const { sigma, beta, alpha, gamma, kSpring, velDamp, rigidFrac } = tempParams(tempC)

  const gx = GRAVITY * Math.sin(boxAngle)
  const gy = GRAVITY * Math.cos(boxAngle)

  const retain = 1 - velDamp
  for (const p of particles) {
    p.vx = (p.vx + gx * dt) * retain
    p.vy = (p.vy + gy * dt) * retain
  }

  applyViscosity(particles, dt, buildHash(particles), sigma, beta)

  for (const p of particles) {
    p.px = p.x;  p.py = p.y
    p.x += p.vx * dt;  p.y += p.vy * dt
  }

  const tablePost = buildHash(particles)
  adjustSprings(particles, springs, tablePost, dt, alpha, gamma)
  applySpringDisplacements(particles, springs, dt, kSpring)

  doubleDensityRelaxation(particles, dt, tablePost)

  // Overlap resolution before wall clamp so pushes don't escape the box
  resolveOverlaps(particles)

  // Walls: hard boundary, zero friction, zero restitution.
  // Setting p.px/p.py = p.x/p.y after clamp gives Verlet velocity = 0 in the
  // normal direction while leaving the tangential component (stored in the
  // other prev-coord) completely untouched → particles slide freely along walls.
  const lim = HS - PARTICLE_R
  for (const p of particles) {
    if      (p.x < -lim) { p.x = -lim; p.px = p.x }
    else if (p.x >  lim) { p.x =  lim; p.px = p.x }
    if      (p.y < -lim) { p.y = -lim; p.py = p.y }
    else if (p.y >  lim) { p.y =  lim; p.py = p.y }
  }

  for (const p of particles) {
    p.vx = (p.x - p.px) / dt
    p.vy = (p.y - p.py) / dt
  }

  const maxSpd2 = MAX_SPEED * MAX_SPEED
  for (const p of particles) {
    const spd2 = p.vx * p.vx + p.vy * p.vy
    if (spd2 > maxSpd2) { const s = MAX_SPEED / Math.sqrt(spd2); p.vx *= s; p.vy *= s }
  }

  applyRigidBodyProjection(particles, rigidFrac)
}

// ── Rigid body mode ───────────────────────────────────────────────────────────
// Below T_RIGID the blob is completely frozen into a rigid body: fixed shape,
// correct 2D impulse physics at wall contacts, tumbles/slides/bounces naturally.

export const T_RIGID = 200   // °C — freeze threshold

const RB_RESTITUTION = 0.35
const RB_DAMP_LIN    = 0.9999   // per step — nearly frictionless translation
const RB_DAMP_ROT    = 0.9990   // per step — slight rotational drag
const RB_MAX_SPEED   = 1200     // px/s hard cap
const RB_MAX_OMEGA   = 14       // rad/s hard cap (~2.2 rev/s)
const CONTACT_TOL    = 2.5      // px — distance from wall to count as contact

export function freezeParticles(particles) {
  const N = particles.length
  let cx = 0, cy = 0, vcx = 0, vcy = 0
  for (const p of particles) { cx += p.x; cy += p.y; vcx += p.vx; vcy += p.vy }
  cx /= N; cy /= N; vcx /= N; vcy /= N
  const refX = new Float32Array(N), refY = new Float32Array(N)
  let I = 0, omega = 0
  for (let i = 0; i < N; i++) {
    refX[i] = particles[i].x - cx
    refY[i] = particles[i].y - cy
    I     += refX[i]*refX[i] + refY[i]*refY[i]
    omega += refX[i]*(particles[i].vy - vcy) - refY[i]*(particles[i].vx - vcx)
  }
  if (I > 0) omega /= I
  return { cx, cy, vcx, vcy, theta: 0, omega, refX, refY, I, N }
}

export function syncParticlesToRigidBody(particles, rb) {
  const cosT = Math.cos(rb.theta), sinT = Math.sin(rb.theta)
  for (let i = 0; i < rb.N; i++) {
    const rwx = rb.refX[i]*cosT - rb.refY[i]*sinT
    const rwy = rb.refX[i]*sinT + rb.refY[i]*cosT
    particles[i].x  = rb.cx + rwx
    particles[i].y  = rb.cy + rwy
    particles[i].vx = rb.vcx - rb.omega * rwy
    particles[i].vy = rb.vcy + rb.omega * rwx
  }
}

export function stepRigidBody(rb, dt, HS, boxAngle) {
  const gx  = GRAVITY * Math.sin(boxAngle)
  const gy  = GRAVITY * Math.cos(boxAngle)
  const lim = HS - PARTICLE_R
  const { N, refX, refY, I } = rb
  const INV_M = 1 / N

  // Gravity + damping
  rb.vcx = (rb.vcx + gx * dt) * RB_DAMP_LIN
  rb.vcy = (rb.vcy + gy * dt) * RB_DAMP_LIN
  rb.omega *= RB_DAMP_ROT

  // Speed caps
  const spd = Math.sqrt(rb.vcx*rb.vcx + rb.vcy*rb.vcy)
  if (spd > RB_MAX_SPEED) { const s = RB_MAX_SPEED/spd; rb.vcx *= s; rb.vcy *= s }
  rb.omega = Math.max(-RB_MAX_OMEGA, Math.min(RB_MAX_OMEGA, rb.omega))

  // Integrate
  rb.cx    += rb.vcx * dt
  rb.cy    += rb.vcy * dt
  rb.theta += rb.omega * dt

  // Position correction — translate CM until no particle is outside the box.
  // Pure translation is cheap and stable; angular correction is skipped here
  // because the velocity impulse below handles the rotational response.
  for (let iter = 0; iter < 8; iter++) {
    const cosT = Math.cos(rb.theta), sinT = Math.sin(rb.theta)
    let pushL = 0, pushR = 0, pushT = 0, pushB = 0
    for (let i = 0; i < N; i++) {
      const wx = rb.cx + refX[i]*cosT - refY[i]*sinT
      const wy = rb.cy + refX[i]*sinT + refY[i]*cosT
      if (wx < -lim) pushL = Math.max(pushL, -lim - wx)
      if (wx >  lim) pushR = Math.max(pushR,  wx -  lim)
      if (wy < -lim) pushT = Math.max(pushT, -lim - wy)
      if (wy >  lim) pushB = Math.max(pushB,  wy -  lim)
    }
    rb.cx += pushL - pushR
    rb.cy += pushT - pushB
    if (pushL + pushR + pushT + pushB < 0.01) break
  }

  // Velocity impulse — one per wall, applied at the average contact centroid.
  // Averaging contact points is correct for flat-face collisions (no spurious
  // spin) and degrades gracefully to single-point for corner hits.
  const cosT = Math.cos(rb.theta), sinT = Math.sin(rb.theta)

  // Left wall: n = (+1, 0)
  { let sRwy = 0, sVn = 0, cnt = 0
    for (let i = 0; i < N; i++) {
      if (rb.cx + refX[i]*cosT - refY[i]*sinT > -lim + CONTACT_TOL) continue
      const rwy = refX[i]*sinT + refY[i]*cosT
      const vn  = rb.vcx - rb.omega * rwy
      if (vn >= 0) continue
      sRwy += rwy; sVn += vn; cnt++
    }
    if (cnt) {
      const rCN = -(sRwy/cnt), denom = INV_M + rCN*rCN/I
      const J   = -(1 + RB_RESTITUTION) * (sVn/cnt) / denom
      rb.vcx += J * INV_M;  rb.omega += rCN * J / I
    }
  }
  // Right wall: n = (-1, 0)
  { let sRwy = 0, sVn = 0, cnt = 0
    for (let i = 0; i < N; i++) {
      if (rb.cx + refX[i]*cosT - refY[i]*sinT < lim - CONTACT_TOL) continue
      const rwy = refX[i]*sinT + refY[i]*cosT
      const vn  = -(rb.vcx - rb.omega * rwy)
      if (vn >= 0) continue
      sRwy += rwy; sVn += vn; cnt++
    }
    if (cnt) {
      const rCN = sRwy/cnt, denom = INV_M + rCN*rCN/I
      const J   = -(1 + RB_RESTITUTION) * (sVn/cnt) / denom
      rb.vcx -= J * INV_M;  rb.omega += rCN * J / I
    }
  }
  // Top wall: n = (0, +1)
  { let sRwx = 0, sVn = 0, cnt = 0
    for (let i = 0; i < N; i++) {
      if (rb.cy + refX[i]*sinT + refY[i]*cosT > -lim + CONTACT_TOL) continue
      const rwx = refX[i]*cosT - refY[i]*sinT
      const vn  = rb.vcy + rb.omega * rwx
      if (vn >= 0) continue
      sRwx += rwx; sVn += vn; cnt++
    }
    if (cnt) {
      const rCN = sRwx/cnt, denom = INV_M + rCN*rCN/I
      const J   = -(1 + RB_RESTITUTION) * (sVn/cnt) / denom
      rb.vcy += J * INV_M;  rb.omega += rCN * J / I
    }
  }
  // Bottom wall: n = (0, -1)
  { let sRwx = 0, sVn = 0, cnt = 0
    for (let i = 0; i < N; i++) {
      if (rb.cy + refX[i]*sinT + refY[i]*cosT < lim - CONTACT_TOL) continue
      const rwx = refX[i]*cosT - refY[i]*sinT
      const vn  = -(rb.vcy + rb.omega * rwx)
      if (vn >= 0) continue
      sRwx += rwx; sVn += vn; cnt++
    }
    if (cnt) {
      const rCN = -(sRwx/cnt), denom = INV_M + rCN*rCN/I
      const J   = -(1 + RB_RESTITUTION) * (sVn/cnt) / denom
      rb.vcy -= J * INV_M;  rb.omega += rCN * J / I
    }
  }
}

// ── Floor mode ────────────────────────────────────────────────────────────────
// World-space physics when the box is removed: gravity always points down,
// floor at floorY, canvas-edge side walls. Zero restitution everywhere so the
// blob oozes rather than bounces. Optional stick as a line-segment obstacle.
export function stepFloorPhysics(particles, springs, dt, floorY, canvasW, tempC, stickA, stickB) {
  const { sigma, beta, alpha, gamma, kSpring, velDamp } = tempParams(tempC)
  const retain = 1 - velDamp

  for (const p of particles) {
    p.vx =  p.vx * retain
    p.vy = (p.vy + GRAVITY * dt) * retain
  }

  applyViscosity(particles, dt, buildHash(particles), sigma, beta)

  for (const p of particles) {
    p.px = p.x; p.py = p.y
    p.x += p.vx * dt; p.y += p.vy * dt
  }

  const tablePost = buildHash(particles)
  adjustSprings(particles, springs, tablePost, dt, alpha, gamma)
  applySpringDisplacements(particles, springs, dt, kSpring)
  doubleDensityRelaxation(particles, dt, tablePost)
  resolveOverlaps(particles)

  // Stick — hard line-segment boundary, zero restitution so glass oozes off
  if (stickA) {
    const sdx   = stickB.x - stickA.x
    const sdy   = stickB.y - stickA.y
    const sLen2 = sdx*sdx + sdy*sdy
    const minD  = PARTICLE_R + 4.5
    for (const p of particles) {
      const t   = Math.max(0, Math.min(1, ((p.x-stickA.x)*sdx + (p.y-stickA.y)*sdy) / sLen2))
      const cpx = stickA.x + t*sdx, cpy = stickA.y + t*sdy
      const ex  = p.x - cpx, ey = p.y - cpy
      const d2  = ex*ex + ey*ey
      if (d2 > 0 && d2 < minD*minD) {
        const d = Math.sqrt(d2), nx = ex/d, ny = ey/d
        p.x += nx*(minD-d); p.y += ny*(minD-d)
        const vn = p.vx*nx + p.vy*ny
        if (vn < 0) { p.vx -= vn*nx; p.vy -= vn*ny }
      }
    }
  }

  // Walls: floor (bottom) and canvas edges (left/right). No top wall.
  const limB = floorY - PARTICLE_R
  const limL = PARTICLE_R
  const limR = canvasW - PARTICLE_R
  for (const p of particles) {
    if (p.y > limB) { p.y = limB; p.py = p.y }
    if (p.x < limL) { p.x = limL; p.px = p.x }
    if (p.x > limR) { p.x = limR; p.px = p.x }
  }

  for (const p of particles) {
    p.vx = (p.x - p.px) / dt
    p.vy = (p.y - p.py) / dt
  }

  const maxSpd2 = MAX_SPEED * MAX_SPEED
  for (const p of particles) {
    const spd2 = p.vx*p.vx + p.vy*p.vy
    if (spd2 > maxSpd2) { const s = MAX_SPEED/Math.sqrt(spd2); p.vx *= s; p.vy *= s }
  }
}
