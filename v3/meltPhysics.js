// meltPhysics.js — KMT hard-sphere + charge-based pairwise interaction physics

export const PHYSICS_START_TEMP = 0
export const SIM_W = 600
export const SIM_H = 350   // grid area only

const SUBSTEPS       = 6      // more substeps → fewer tunnelling events at high T
export const THERMAL_SPEED      = 0.0018  // v_rms = THERMAL_SPEED × √T  (px/substep per √°C); 2× previous 0.0009
export const ENERGY_UNIT    = THERMAL_SPEED * THERMAL_SPEED * 0.5  // = 1.125e-6; ePerParticle = (sliderVal+273)*ENERGY_UNIT
const THERMOSTAT_TAU = 0.10   // Berendsen coupling: fraction of (v_target/v_rms − 1) per substep
// Minimum image helpers for toroidal (asteroids) boundary
const miDx = dx => dx >  SIM_W * 0.5 ? dx - SIM_W : dx < -SIM_W * 0.5 ? dx + SIM_W : dx
const miDy = dy => dy >  SIM_H * 0.5 ? dy - SIM_H : dy < -SIM_H * 0.5 ? dy + SIM_H : dy

// Opposite-charge pairs: preferred distance, spring constant, cutoff multiplier.
// Each species sits on its own hex lattice scaled so O midpoints match r0 exactly:
//   Si: lattice a=18px → O at 9px  = r0_SiO
//   Na: lattice a=32px → O at 16px = r0_NaO
//   Ca: lattice a=24px → O at 12px = r0_CaO
//
// Cutoff (mult) calibrated so escape energy ½·k·(r0·(mult-1))² = KE at T_escape,
// with THERMAL_SPEED=0.005: KE(T) = ½·(0.005·√T)² = 1.25e-5·T
//   Si-O: escapes ~1200°C  (KE=0.015)  →  ½·0.42·(9·0.03)²  = 0.0153 ✓
//   Ca-O: escapes  ~700°C  (KE=0.00875)→  ½·0.28·(12·0.02)² = 0.0081 ✓
//   Na-O: escapes  ~460°C  (KE=0.00575)→  ½·0.20·(16·0.02)² = 0.0064 ✓
const PREFERRED = {
  // oneSided: no spring repulsion for d < r0 — hard-sphere collision is the only
  // close-range repulsion.  After any collision the atoms coast to d = r0 where the
  // attractive spring captures them; bonds therefore form wherever particles meet at
  // low enough temperature rather than being blown apart by a spring kick.
  'O-Si': { r0: 9,  k: 0.061, mult: 1.03, oneSided: true  },
  'Na-O': { r0: 12, k: 0.042, mult: 1.05, viewMult: 1.30, oneSided: false, freeRepR0: 7, freeRepK: 0.50 },
  'Ca-O': { r0: 12, k: 0.28, mult: 1.02, oneSided: false, freeRepR0: 8, freeRepK: 0.55 },
}

// Temperature-dependent Si-O capture range.
// The Si-O spring is one-sided (attractive only, d > r0). Its static mult=1.03
// gives only 0.27px of capture range — room-temperature vibrations regularly
// exceed this, causing bonds to visually flicker out.
// Fix: widen the capture range at cold temperatures so escaped atoms are always
// pulled back. The spring constant k is unchanged, so the FORCE at any given
// extension is identical; only the outer cutoff distance changes.
// Hot-end mult=1.03 preserves the ~1200°C escape calibration.
// Cold-end mult=1.15 means bonds are essentially unbreakable below ~800°C in practice;
// escape probability at 700°C (default page-load temp) is exp(-13.4) ≈ 0.
// The fade extends to SIO_FADE_HIGH=1100°C so the wide range persists through the
// working temperature range, with visible bond breaking starting above ~1000°C.
const SIO_COLD_MULT = 1.15   // T ≤ SIO_FADE_LOW  — wide recapture range
let _sioHotMult     = 1.07   // T ≥ SIO_FADE_HIGH — wider capture window helps freed Si re-bond
let _freeAttractSiOMult = 1.0  // scale factor for attract force on freed Si-O pairs
let _sioExclMult    = 1.4    // XPBD exclusion multiplier for freed Si-O pairs (vs FREE_EXCL=2.0 for all others)
let _crystJiggleMult = 1.0   // kick multiplier for crystAnchor/naAnchor atoms (vs base kickSigma)
let _breakStrain     = 0.07  // strain threshold for bond breaking: bond breaks when (d−r₀)/r₀ > _breakStrain
let _reformStrain    = 0.0   // strain threshold for bond reform: bond reforms when (d−r₀)/r₀ ≤ _reformStrain
let _crystAnchorK    = 0.06  // crystAnchor spring constant for SiO2 network atoms
let _liberateFrac    = 0.5   // liberation fraction for SiO2 atoms (1.0 = all broken, 0.5 = majority broken)
let _naAnchorK       = 0.06  // naAnchor spring constant for Na2O atoms (independent of _crystAnchorK)
let _naLiberateFrac  = 0.5   // liberation fraction for Na2O atoms
let _naBreakStrain   = 0.04  // break strain for Na-O bonds (independent of Si-O _breakStrain)
let _breakStrainSpread = 0.15 // per-bond random ± factor drawn at buildRigidBondMap; 0 = uniform
let _useEmaStrain     = false // true = EMA-smoothed strain for break check; false = instantaneous
let _sevTriggerDist   = 13   // px — freed modifier ion must be within this distance of a Si or O to sever the Si-O bond
// Feedback loop calibration: GAIN interpolated on sio2Pct between soda (70%) and silica (100%)
const FEEDBACK_GAIN_SODA   = 0.437  // 70% SiO2 / 30% Na2O: f=0 at 500°C, f=1 at 1322°C
const FEEDBACK_GAIN_SILICA = 0.112  // 100% SiO2:             f=0 at 1500°C, f=1 at 1920°C
let _feedbackGainMult = 100         // scalar multiplier on GAIN — dial up/down feedback ramp speed
let _latticeSpeedMult = 1.0  // kick-sigma multiplier for bonded (non-freed) atoms
let _freedSpeedMult   = 3.5  // kick-sigma multiplier for freed atoms
let _reintBondN       = 2    // min intact bonds to count toward re-integration
let _reintFrameM      = 30   // consecutive frames with ≥N bonds before cleared
const REINT_RAMP_FRAMES = 10  // frames to ramp speed mult from freed→lattice after re-integration
export const setSioHotMult         = v => { _sioHotMult = v }
export const setFreeAttractSiOMult  = v => { _freeAttractSiOMult = v }
export const setSioExclMult        = v => { _sioExclMult = v }
export const setCrystJiggleMult    = v => { _crystJiggleMult = v }
export const setBreakStrain        = v => { _breakStrain = v }
export const setReformStrain       = v => { _reformStrain = v }
export const setCrystAnchorK       = v => { _crystAnchorK = v }
export const setLiberateFrac       = v => { _liberateFrac = v }
export const setNaAnchorK          = v => { _naAnchorK = v }
export const setNaLiberateFrac     = v => { _naLiberateFrac = v }
export const setNaBreakStrain      = v => { _naBreakStrain = v }
export const setBreakStrainSpread  = v => { _breakStrainSpread = v }
export const setUseEmaStrain       = v => { _useEmaStrain = v }
export const setSevTriggerDist     = v => { _sevTriggerDist = v }
export const setFeedbackGainMult   = v => { _feedbackGainMult = v }
export const setLatticeSpeedMult   = v => { _latticeSpeedMult = v }
export const setFreedSpeedMult     = v => { _freedSpeedMult = v }
export const setReintBondN         = v => { _reintBondN = v }
export const setReintFrameM        = v => { _reintFrameM = v }
export const setSioK               = v => { PREFERRED['O-Si'].k = v }
export const setNaOK               = v => { PREFERRED['Na-O'].k = v }

// Liberation instrumentation — counts fires per path and records separations at fire time.
const _libStats = {
  contactFires: 0,      // times contact liberation set latticeFreed[j]=1
  strainFires:  0,      // times strain-based loop set latticeFreed[i]=1
  contactSeps:  [],     // [{liberatorType, dToJ, dLiberatorToOwnBond}] at each contact fire (capped 200)
}
export const resetLibStats = () => {
  _libStats.contactFires = 0
  _libStats.strainFires  = 0
  _libStats.contactSeps  = []
}
export const getLibStats   = () => ({ ..._libStats, contactSeps: [..._libStats.contactSeps] })
const SIO_FADE_LOW  = 200    // °C below which full cold mult applies
const SIO_FADE_HIGH = 1100   // °C above which full hot mult applies

// Latent-heat helpers: adjust a particle's KE when a bond changes state.
// Returns actual energy removed (may be less than `amount` if atom doesn't have enough).
function _removeKE(p, amount) {
  const ke = 0.5 * (p.vx * p.vx + p.vy * p.vy)
  if (ke < 1e-14) return 0
  const newKE = Math.max(0, ke - amount)
  const scale = Math.sqrt(newKE / ke)
  p.vx *= scale; p.vy *= scale
  return ke - newKE
}
// Inject `amount` KE into particle p, directed outward along (nx, ny).
// Scales if atom has existing velocity; injects along (nx,ny) if at rest.
function _addKE(p, amount, nx, ny) {
  const ke = 0.5 * (p.vx * p.vx + p.vy * p.vy)
  if (ke < 1e-14) {
    const v = Math.sqrt(2 * amount)
    p.vx += nx * v; p.vy += ny * v
  } else {
    const scale = Math.sqrt(1 + amount / ke)
    p.vx *= scale; p.vy *= scale
  }
}

// Same-charge pairs — soft-sphere repulsion only (positive ions repel each other; O repels O)
const REP_K    = 0.28
const REP_MULT = 1.8   // repulsion applies within (r_i + r_j) × REP_MULT

// Fast type-pair lookup: integer IDs → avoid string allocation in the inner loop
const TYPE_ID = { Si: 0, O: 1, Na: 2, Ca: 3 }
// Max interaction cutoff per type pair (px); null = same-charge repulsion only
// Max attraction: Na-O at r0=16, mult=1.02 → 16.3px; max repulsion: Ca-Ca at (5+5)*1.8=18px
const FORCE_CUTOFF    = 20   // early-reject pairs farther than this in x or y
const COLLIDE_CUTOFF  = 10   // early-reject collision pairs (max r_i + r_j = Ca+Ca = 10)
// 4×4 pair-spec table indexed by [typeIdA][typeIdB]
const PAIR_TABLE = Array.from({ length: 4 }, () => new Array(4).fill(null))
PAIR_TABLE[0][1] = PAIR_TABLE[1][0] = PREFERRED['O-Si']
PAIR_TABLE[2][1] = PAIR_TABLE[1][2] = PREFERRED['Na-O']
PAIR_TABLE[3][1] = PAIR_TABLE[1][3] = PREFERRED['Ca-O']
// Like-charge repulsion: same-sign ions push each other away.
// repOnly:true means force only fires at d < r0 (pure repulsion, never attractive).
// freeRepR0/freeRepK: extra floor repulsion when both atoms are freed (not in original crystal).
PAIR_TABLE[0][0] = { r0: 12, k: 0.22, mult: 1, repOnly: true }                                               // Si-Si  (Si⁴⁺)
PAIR_TABLE[1][1] = { r0:  8, k: 0.32, mult: 1, repOnly: true, freeRepR0: 6, freeRepK: 0.3 }                 // O-O    (O²⁻; extra push when freed)
PAIR_TABLE[2][2] = { r0:  8, k: 0.45, mult: 1, repOnly: true }                                               // Na-Na  (Na⁺)
PAIR_TABLE[3][3] = { r0: 10, k: 0.50, mult: 1, repOnly: true }                                               // Ca-Ca  (Ca²⁺)
PAIR_TABLE[2][3] = PAIR_TABLE[3][2] = { r0:  9, k: 0.38, mult: 1, repOnly: true }                           // Na-Ca

// Lattice anchor: each atom is tethered to its initial position by a gentle spring.
// Prevents center-of-mass drift/rotation of grain clusters while leaving thermal
// vibration visible.  Fades out linearly as T→ANCHOR_FADE_TEMP, and is permanently
// disabled once the simulation has ever reached ANCHOR_MELT_TEMP so it never fights
// a re-solidified (crystallized) network that has moved from the original grain layout.
const ANCHOR_K         = 1.6   // strong home-pull; keeps atoms near x0/y0
const ANCHOR_FADE_TEMP = 800   // anchor → 0 at this °C
const ANCHOR_MELT_TEMP = 600   // once T exceeds this, anchor disabled forever

// ── Hex-directed attraction helper ───────────────────────────────────────────
// Returns the ideal 120°-spaced bond slot for the next O on a Si atom.
// existingAngles: angles of Si's current O bonds.
// candidateAngle: current direction from Si to the O being considered.
// Strategy: anchor three canonical positions to the first existing bond, drop any
// slot within 60° of an existing bond (each bond claims exactly one slot), return
// the remaining free slot closest to candidateAngle.
function idealHexAngle(existingAngles, candidateAngle) {
  if (existingAngles.length === 0) return candidateAngle   // first bond: no preference
  const PI2  = Math.PI * 2
  const STEP = PI2 / 3            // 120° between slots
  const TOL  = Math.PI / 3        // 60° — half the inter-slot gap; each bond claims one slot
  const wrap = a => ((a % PI2) + PI2) % PI2
  const diff = (a, b) => { let d = Math.abs(wrap(a) - wrap(b)); return d > Math.PI ? PI2 - d : d }

  const base  = wrap(existingAngles[0])
  const slots = [base, wrap(base + STEP), wrap(base - STEP)]

  const free = slots.filter(s => existingAngles.every(ea => diff(s, ea) > TOL))
  if (free.length === 0) return candidateAngle   // Si already satisfied
  return free.reduce((best, s) =>
    diff(s, candidateAngle) < diff(best, candidateAngle) ? s : best
  )
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initPhysics(cellData) {
  const particles = []
  const posMap    = new Map()

  for (const { atoms, type, idx } of cellData) {
    for (const atom of atoms) {
      const key = `${Math.round(atom.x * 2)},${Math.round(atom.y * 2)}`
      if (posMap.has(key)) continue
      posMap.set(key, particles.length)
      particles.push({
        x0: atom.x, y0: atom.y,
        x:  atom.x, y:  atom.y,
        px: atom.x, py: atom.y,   // previous-step positions for lerp
        vx: 0,      vy: 0,
        type: atom.type, typeId: TYPE_ID[atom.type] ?? 0, r: atom.r,
        cellType: type,
        chunkIdx: idx,
      })
    }
  }

  const n = particles.length

  // Resolve initial overlaps: push particles apart (position only, no velocities).
  // Needed because chunk polygons overlap, so cross-chunk atom pairs can start coincident.
  for (let pass = 0; pass < 120; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj   = particles[j]
        const dx   = pj.x - pi.x, dy = pj.y - pi.y
        const minD = pi.r + pj.r
        const d2   = dx * dx + dy * dy
        if (d2 >= minD * minD || d2 < 1e-6) continue
        moved = true
        const d    = Math.sqrt(d2)
        const nx   = dx / d, ny = dy / d
        const half = (minD - d) * 0.55  // slight overshoot aids convergence
        pi.x -= nx * half; pi.y -= ny * half
        pj.x += nx * half; pj.y += ny * half
      }
    }
    if (!moved) break
  }
  // Snap Si-O pairs that landed in the dead zone (r_sum < d < r0) after overlap
  // resolution. In that zone neither hard-sphere nor spring acts, so those atoms
  // float freely forever. Push them just past r0 so the attractive spring grabs them.
  const SIO_R0   = PREFERRED['O-Si'].r0
  const SIO_RSUM = 3.2 + 2.3   // Si radius + O radius
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    if (pi.type !== 'Si' && pi.type !== 'O') continue
    for (let j = i + 1; j < n; j++) {
      const pj = particles[j]
      if (!((pi.type === 'Si' && pj.type === 'O') ||
            (pi.type === 'O'  && pj.type === 'Si'))) continue
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d2 = dx * dx + dy * dy
      if (d2 < SIO_RSUM * SIO_RSUM || d2 >= SIO_R0 * SIO_R0) continue
      // Pair is in dead zone — nudge outward to r0 + 0.2
      const d  = Math.sqrt(d2)
      const nx = dx / d, ny = dy / d
      const half = (SIO_R0 + 0.2 - d) * 0.5
      pi.x -= nx * half; pi.y -= ny * half
      pj.x += nx * half; pj.y += ny * half
    }
  }

  // Sync all position references so lerp and spread calculations use corrected start
  for (const p of particles) { p.x0 = p.x; p.y0 = p.y; p.px = p.x; p.py = p.y }

  // Per-chunk metadata for outline tracing
  const chunks = cellData.map(({ idx, pts, bg, bdr }) => {
    const pIdxs = []
    for (let i = 0; i < particles.length; i++) {
      if (particles[i].chunkIdx === idx) pIdxs.push(i)
    }
    let origCx = 0, origCy = 0
    for (const i of pIdxs) { origCx += particles[i].x0; origCy += particles[i].y0 }
    if (pIdxs.length) { origCx /= pIdxs.length; origCy /= pIdxs.length }
    let origSpread = 0
    for (const i of pIdxs) {
      origSpread += Math.hypot(particles[i].x0 - origCx, particles[i].y0 - origCy)
    }
    origSpread = pIdxs.length ? origSpread / pIdxs.length : 1
    return { idx, pts, bg, bdr, origCx, origCy, origSpread: Math.max(origSpread, 4), pIdxs }
  })

  return {
    particles,
    bonds: [],   // rebuilt dynamically each step for rendering
    chunks,
    n,
    fx: new Float32Array(n),
    fy: new Float32Array(n),
    hasBeenMelted: false,  // anchor active; fades above ANCHOR_FADE_TEMP
    sioMult: SIO_COLD_MULT,  // current effective Si-O capture mult; updated each stepPhysics
  }
}

// ── Rigid bond map ───────────────────────────────────────────────────────────
// Snapshot the bond structure after init-time settling.  Each recorded bond
// is applied every substep with NO distance cutoff — atoms are always pulled
// back toward their initial bonded partners regardless of how far they drift.
// The spring is bilateral (attractive AND repulsive), so atoms can't pass
// through r0 and get stuck in the dead zone.
// Call this once after initPhysics + warm-up steps, before the first render.
// To break a bond later: remove it from phys.rigidBonds.
export function buildRigidBondMap(phys) {
  const ps      = phys.particles
  const n       = phys.n
  const sioMult = phys.sioMult ?? SIO_COLD_MULT
  const bonds   = []

  for (let i = 0; i < n; i++) {
    const pi   = ps[i]
    for (let j = i + 1; j < n; j++) {
      const pj   = ps[j]
      const spec = PAIR_TABLE[pi.typeId][pj.typeId]
      if (!spec) continue
      const effMult = (spec === PAIR_TABLE[0][1]) ? sioMult : spec.mult
      const dx = pj.x - pi.x, dy = pj.y - pi.y
      const d  = Math.hypot(dx, dy)
      if (!spec.repOnly && d < spec.r0 * effMult && (!spec.oneSided || d >= spec.r0 * 0.9)) {
        const isSiO  = spec === PAIR_TABLE[0][1]
        const factor = 1 + (Math.random() * 2 - 1) * _breakStrainSpread
        bonds.push({
          i, j, r0: d,
          broken: false,
          breakable: true,
          isSiO,
          specMult: isSiO ? null : spec.mult,
          bondDepth: 0.5 * spec.k * (d * (spec.mult - 1)) ** 2,
          breakStrain:      (isSiO ? _breakStrain : _naBreakStrain) * factor,
          projectionCutoff: (isSiO ? 1700 : 650) * factor,
          avgStrain:        0,
        })
      }
    }
  }
  phys.rigidBonds = bonds
  // Count original bond count per atom for the majority-bond liberation threshold.
  const origCount = new Uint8Array(phys.n)
  for (const rb of bonds) { origCount[rb.i]++; origCount[rb.j]++ }
  phys.originalBondCount = origCount
  // Reset latticeFreed: settling steps before this call ran with no rigidBonds, causing
  // all atoms to be spuriously freed (intactCount was 0 for everyone). Clear that now.
  phys.latticeFreed      = new Uint8Array(phys.n)
  phys.stableBondFrames  = new Int16Array(phys.n)
  phys.reintRampFrames   = new Int16Array(phys.n)
}

// Gentle long-range attraction between unsatisfied opposite-charge pairs, active
// only during cooling.  Bond-count-aware: stops pulling once an atom reaches its
// coordination target so the network forms naturally without over-bonding.
//   Si  → 3 O  (triangular network former in 2-D)
//   O   → 2 cations  (bridging O bonds 2 Si; non-bridging bonds 1 Si + 1 modifier)
//   Na  → 1 O  (monovalent modifier — each Na⁺ breaks one bridge, takes 1 NBO)
//   Ca  → 2 O  (divalent modifier — each Ca²⁺ claims 2 NBOs)
// Slow/fast outcome: slow uses hex-directed Si-O attract → 120° angles → crystalline;
// fast uses isotropic → random angles → amorphous.
const ATTRACT_RANGE  = 40
export const COORD_TARGET   = [3, 2, 1, 2]   // Si, O, Na, Ca (typeId order)

// ── Energy diagnostics ────────────────────────────────────────────────────────
export function computeKE(phys) {
  const { particles, n } = phys
  let ke = 0
  for (let i = 0; i < n; i++) { ke += particles[i].vx ** 2 + particles[i].vy ** 2 }
  return ke * 0.5
}

// KE of bonded atoms only — excludes freed atoms running at boosted thermal speed,
// giving an accurate lattice temperature for the T: readout.
export function computeBondedKE(phys) {
  const { particles, n, intactCount } = phys
  if (!intactCount) return computeKE(phys)
  let ke = 0, count = 0
  for (let i = 0; i < n; i++) {
    if (intactCount[i] > 0) { ke += particles[i].vx ** 2 + particles[i].vy ** 2; count++ }
  }
  return count > 0 ? { ke: ke * 0.5, n: count } : { ke: 0, n: 1 }
}

// PE from bond springs: ½k(d−r0)² for each bond currently in range.
// Si-O is one-sided (no compression spring), so skip ext < 0 for those.
export function computePE(phys) {
  const { particles, bonds } = phys
  let pe = 0
  for (const b of bonds) {
    const spec = PAIR_TABLE[particles[b.i].typeId][particles[b.j].typeId]
    if (!spec) continue
    const ext = b.strain * spec.r0   // d − r0
    if (spec.oneSided && ext < 0) continue
    pe += 0.5 * spec.k * ext * ext
  }
  return pe
}

// ── Step ──────────────────────────────────────────────────────────────────────
// ePerParticle: total energy target per particle (KE + PE). vTarget is derived
//   by subtracting current PE so the thermostat chases KE = ePerParticle − PE/n.
// coolingFactor: 1.0 = thermostat mode
// attractK:     subtle pull strength, active only when coolingMode !== null
// coolingMode:  null | 'fast' | 'slow' | 'fastHeat' | 'slowHeat'
export function stepPhysics(phys, ePerParticle, coolingFactor = 1.0, attractK = 0, coolingMode = null, speedMult = 1, attractFalloff = 1) {
  const { particles, n, fx, fy } = phys

  // Langevin thermostat targets KE directly — do not subtract PE.
  // Subtracting PE would make the steady-state temperature track ePerParticle/2
  // (because <PE> ≈ <KE> via the virial theorem), leaving T: stuck at 0 for the
  // first ~273 E units. PE is still computed for the bar graph.
  const peNow       = computePE(phys)
  const keTarget    = Math.max(ENERGY_UNIT * 10, ePerParticle)
  const vTarget     = Math.sqrt(2 * keTarget) * speedMult
  phys.latticeTemp  = keTarget / ENERGY_UNIT - 273

  // Derive current kinetic temperature for physics gates (attract modifier threshold)
  const keNow       = computeKE(phys)
  const derivedTempC = Math.max(-273, keNow / (n * ENERGY_UNIT) - 273)

  // Bond-breaking uses the TARGET temperature (from ePerParticle) so it responds to
  // the user's energy input directly, not to the lagging measured KE temperature.
  const totalEnergy = ePerParticle / ENERGY_UNIT - 273

  // Temperature-dependent Si-O capture range (see SIO_COLD_MULT / SIO_HOT_MULT constants).
  // Computed once per step from measured KE temperature, stored for rebuildBonds.
  const sioMultFrac = Math.max(0, Math.min(1, (derivedTempC - SIO_FADE_LOW) / (SIO_FADE_HIGH - SIO_FADE_LOW)))
  const sioMult = SIO_COLD_MULT + (_sioHotMult - SIO_COLD_MULT) * sioMultFrac
  phys.sioMult = sioMult

  if (!phys.hasBeenMelted && totalEnergy >= ANCHOR_MELT_TEMP) phys.hasBeenMelted = true
  const anchorStr = phys.hasBeenMelted ? 0
    : ANCHOR_K * Math.max(0, 1 - totalEnergy / ANCHOR_FADE_TEMP)

  // Si-O network anchor set — used for crystal anchor spring (see below).
  // All Si atoms are always part of the SiO2 network (Si-O breaks only above 1700°C),
  // so anchor every Si regardless of bond state. O atoms bonded to Si are included via
  // the rigid bond loop. This covers edge Si atoms that lost their O neighbor during
  // warm-up and therefore have no rigid bond entry.
  const crystAnchor = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = particles[i]
    // All Si, plus all O atoms that live in a SiO2 grain — covers edge/loose atoms
    // that drifted outside the rigid-bond capture range during warm-up.
    if (p.typeId === 0 || (p.typeId === 1 && p.cellType === 'SiO2')) crystAnchor[i] = 1
  }

  // latticeFreed: persistent flag set when a SiO2 atom is liberated by contact with a
  // freed Na2O atom (or a SiO2 atom that has already drifted from its site).
  // Freed atoms lose the crystAnchor spring and the tight wander clamp.
  if (!phys.latticeFreed) phys.latticeFreed = new Uint8Array(n)
  const latticeFreed = phys.latticeFreed
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.broken && !rb.breakable) { crystAnchor[rb.i] = 1; crystAnchor[rb.j] = 1 }
    }
  }

  // Na2O grain anchor set — same soft-spring treatment as crystAnchor but conditional:
  // only applied when the atom is still bonded (prevIntact > 0) so freed Na/O atoms
  // can roam freely once their bonds break above 650°C.
  const naAnchor = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (particles[i].cellType === 'Na2O') naAnchor[i] = 1
  }
  // Fade the Na2O anchor spring from full at 650°C to zero at 1150°C, matching the
  // Na-O bond-breaking window. Structure dissolves progressively rather than all at once.
  const naAnchorFrac = 1 - Math.max(0, Math.min(1, (totalEnergy - 650) / 500))

  // Per-atom opposite-charge bond counts and (for slow cool) Si bond-angle maps.
  // Both built from last frame's bond snapshot — one frame stale, acceptable.
  const doAttract = attractK > 0 && coolingMode !== null
  const bondCount = doAttract ? new Int32Array(n) : null
  if (bondCount) {
    for (const { i, j } of phys.bonds) { bondCount[i]++; bondCount[j]++ }
  }

  // For slow cool: map each Si → array of current O-bond angles so idealHexAngle()
  // can direct incoming O toward the correct 120° slot rather than Si's center.
  const siBondAngles = (doAttract && coolingMode === 'slow') ? new Map() : null
  if (siBondAngles) {
    for (const { i, j } of phys.bonds) {
      const ti = particles[i].typeId, tj = particles[j].typeId
      let si, oi
      if      (ti === 0 && tj === 1) { si = i; oi = j }
      else if (ti === 1 && tj === 0) { si = j; oi = i }
      else continue
      if (!siBondAngles.has(si)) siBondAngles.set(si, [])
      siBondAngles.get(si).push(
        Math.atan2(particles[oi].y - particles[si].y, particles[oi].x - particles[si].x)
      )
    }
  }

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    fx.fill(0); fy.fill(0)

    // ── Pairwise interaction forces ──────────────────────────────
    // Fast early-reject on single axis before computing full distance.
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj = particles[j]
        const dx = miDx(pj.x - pi.x)
        if (dx > FORCE_CUTOFF || dx < -FORCE_CUTOFF) continue
        const dy = miDy(pj.y - pi.y)
        if (dy > FORCE_CUTOFF || dy < -FORCE_CUTOFF) continue
        const d2 = dx * dx + dy * dy
        if (d2 < 0.01) continue
        const d  = Math.sqrt(d2)
        const nx = dx / d, ny = dy / d
        const spec = PAIR_TABLE[pi.typeId][pj.typeId]

        if (spec) {
          const isSiOSpec  = spec === PAIR_TABLE[0][1]
          const isFreedPair = latticeFreed[i] && latticeFreed[j]
          // Si-O is one-sided (attractive only, d > r0) to avoid spring kicks in the crystal.
          // For freed pairs, lift this in all phases — liquid or solid — so freed Si-O can
          // form a stable well at r0=9px, matching Na-O capture behaviour.
          const effOneSided = spec.oneSided && !(isSiOSpec && isFreedPair)
          const effMult = isSiOSpec ? sioMult : spec.mult
          if (d < spec.r0 * effMult && (!effOneSided || d > spec.r0) && (!spec.repOnly || d < spec.r0)) {
            // Freed-freed: skip the attractive part for non-Si-O pairs while hot so dissolved
            // Na/Ca ions disperse. Gate on coolingMode so ions can re-bond during cooling.
            // Si-O is always exempt — freed Si must be able to re-bond with freed O.
            if (!(isFreedPair && d >= spec.r0 && !isSiOSpec && coolingMode === null)) {
              const f = spec.k * (d - spec.r0)
              fx[i] += f * nx;  fy[i] += f * ny
              fx[j] -= f * nx;  fy[j] -= f * ny
            }
          }
          // Hard short-range floor for freed opposite-charge pairs (Na-O, Ca-O):
          // prevents tight ionic pairs from forming regardless of temperature.
          if (spec.freeRepR0 && latticeFreed[i] && latticeFreed[j] && d < spec.freeRepR0) {
            const f = spec.freeRepK * (d - spec.freeRepR0)  // always repulsive here
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
          // Long-range attract for freed Si-O — runs always, not gated on coolingMode.
          // This is the only mechanism that brings freed Si toward freed O in the hot
          // liquid; the spring only fires once they're already within ~9.6px.
          if (isSiOSpec && isFreedPair && _freeAttractSiOMult > 0 && d > spec.r0 * effMult && d < ATTRACT_RANGE) {
            const f = _freeAttractSiOMult * 0.004 * spec.r0 / d
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        } else {
          const repM = REP_MULT
          const cutoff = (pi.r + pj.r) * repM
          if (d < cutoff) {
            const f = -REP_K * (cutoff - d)
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }

    // ── Cooling attraction — coordination-driven assembly ───────────────────
    // slow: hex-directed Si-O via idealHexAngle → consistent 120° angles → crystalline.
    // fast: isotropic Si-O → random angles → amorphous.
    // Na/Ca attract throughout — COORD_TARGET[Na]=1 means each Na stops after one O.
    if (bondCount) {
      for (let i = 0; i < n; i++) {
        if (bondCount[i] >= COORD_TARGET[particles[i].typeId]) continue
        const pi = particles[i]
        for (let j = i + 1; j < n; j++) {
          if (bondCount[j] >= COORD_TARGET[particles[j].typeId]) continue
          const pj   = particles[j]
          const spec = PAIR_TABLE[pi.typeId][pj.typeId]
          if (!spec) continue
          // Freed-freed pairs must not attract while hot — they're dissolved ions that
          // should disperse. During cooling, allow attraction so Na/Ca can re-bond.
          // Si-O is always allowed — freed Si network requires freed O capture.
          const isSiO = spec === PAIR_TABLE[0][1]
          if (latticeFreed[i] && latticeFreed[j] && !isSiO && coolingMode === null) continue


          const dx = miDx(pj.x - pi.x)
          if (dx > ATTRACT_RANGE || dx < -ATTRACT_RANGE) continue
          const dy = miDy(pj.y - pi.y)
          if (dy > ATTRACT_RANGE || dy < -ATTRACT_RANGE) continue
          const d2 = dx * dx + dy * dy
          if (d2 >= ATTRACT_RANGE * ATTRACT_RANGE) continue
          const bondCutSq = (spec.r0 * spec.mult) ** 2
          if (d2 <= bondCutSq) continue   // inside bond range: spring already handles it
          const d = Math.sqrt(d2)
          const isFreedSiO = isSiO && latticeFreed[i] && latticeFreed[j]
          const f = attractK * spec.r0 / Math.pow(d, attractFalloff) * (isFreedSiO ? _freeAttractSiOMult : 1)

          if (coolingMode === 'slow' && isSiO) {
            // Hex-directed: aim O at the ideal 120° slot on Si, not at Si's center
            const isSi_i = pi.typeId === 0
            const siIdx  = isSi_i ? i : j
            const oIdx   = isSi_i ? j : i
            const si = particles[siIdx], o = particles[oIdx]
            const θ  = idealHexAngle(
              siBondAngles.get(siIdx) ?? [],
              Math.atan2(o.y - si.y, o.x - si.x)
            )
            const tx = si.x + spec.r0 * Math.cos(θ) - o.x
            const ty = si.y + spec.r0 * Math.sin(θ) - o.y
            const tlen = Math.hypot(tx, ty)
            if (tlen < 0.5) continue
            const tnx = tx / tlen, tny = ty / tlen
            fx[oIdx]  += f * tnx;  fy[oIdx]  += f * tny   // O toward ideal slot
            fx[siIdx] -= f * tnx;  fy[siIdx] -= f * tny   // Si reacts
          } else {
            // Fast cool (all pairs) or slow cool modifier (below 250°C): isotropic
            const nx = dx / d, ny = dy / d
            fx[i] += f * nx;  fy[i] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }

    // ── Lattice anchor: tethers each atom to its initial grain position ──
    // Skip SiO2 and Na2O atoms — they have their own soft anchor springs (below).
    // Applying this strong anchor to them below 600°C blocks the thermal jiggle.
    if (anchorStr > 0) {
      for (let i = 0; i < n; i++) {
        if (crystAnchor[i] || naAnchor[i]) continue
        const p = particles[i]
        fx[i] -= anchorStr * (p.x - p.x0)
        fy[i] -= anchorStr * (p.y - p.y0)
      }
    }

    // ── Crystal network anchor ───────────────────────────────────
    // Si-O bonded atoms are pulled toward their initial lattice site by a spring.
    // This simulates bonds to the crystal structure beyond the grain edge, preventing
    // edge atoms (which have bonds on only one side) from drifting freely outward.
    // Interior atoms are already constrained symmetrically by their three bonds;
    // the extra force is negligible for them.
    // Freed atoms (latticeFreed=1) are excluded so they can drift once all bonds break.
    for (let i = 0; i < n; i++) {
      if (!crystAnchor[i] || latticeFreed[i]) continue
      fx[i] -= _crystAnchorK * (particles[i].x - particles[i].x0)
      fy[i] -= _crystAnchorK * (particles[i].y - particles[i].y0)
    }

    // Na2O anchor: fades from full at 650°C to zero at 1150°C so structure dissolves
    // progressively. Freed atoms (latticeFreed=1) skip the spring so they can roam.
    if (naAnchorFrac > 0) {
      const naK = _naAnchorK * naAnchorFrac
      for (let i = 0; i < n; i++) {
        if (!naAnchor[i] || latticeFreed[i]) continue
        fx[i] -= naK * (particles[i].x - particles[i].x0)
        fy[i] -= naK * (particles[i].y - particles[i].y0)
      }
    }

    // (walls removed — toroidal wrap applied after integration)

    // ── Integrate ───────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const p = particles[i]
      p.vx += fx[i];  p.vy += fy[i]
      p.x  += p.vx;   p.y  += p.vy
      // Toroidal wrap
      if (p.x <  0)     p.x += SIM_W
      if (p.x >= SIM_W) p.x -= SIM_W
      if (p.y <  0)     p.y += SIM_H
      if (p.y >= SIM_H) p.y -= SIM_H
    }

    // ── Rigid bond projection (XPBD-style, unconditionally stable) ──
    // Directly corrects bond lengths rather than applying spring forces.
    // Zeroing the relative velocity along the bond axis prevents energy pump.
    // Si-O: XPBD enforced up to 1700 °C (network former, stays rigid longer).
    // Na-O / Ca-O: XPBD enforced up to 650 °C (modifiers release earlier).
    // Distance guard (> 3×r0) prevents rubber-banding original partners that
    // have drifted far apart during melt back together on cooling.
    if (phys.rigidBonds) {
      for (const rb of phys.rigidBonds) {
        if (rb.broken) continue
        if (totalEnergy > rb.projectionCutoff) continue
        const pi = particles[rb.i], pj = particles[rb.j]
        const dx = miDx(pj.x - pi.x), dy = miDy(pj.y - pi.y)
        const d  = Math.hypot(dx, dy)
        if (d < 0.01 || d > rb.r0 * 3) continue
        const nx   = dx / d,       ny   = dy / d
        const half = (d - rb.r0) * 0.5
        pi.x += nx * half;  pi.y += ny * half
        pj.x -= nx * half;  pj.y -= ny * half
        const dvn = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
        const imp = dvn * 0.5
        pi.vx -= imp * nx;  pi.vy -= imp * ny
        pj.vx += imp * nx;  pj.vy += imp * ny
      }
    }

    // ── Elastic hard-sphere collision resolution ─────────────────
    for (let i = 0; i < n; i++) {
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        const pj = particles[j]
        const dx = miDx(pj.x - pi.x)
        if (dx > COLLIDE_CUTOFF || dx < -COLLIDE_CUTOFF) continue
        const dy   = miDy(pj.y - pi.y)
        const minD = pi.r + pj.r
        const d2   = dx * dx + dy * dy
        if (d2 >= minD * minD || d2 < 1e-6) continue
        const d    = Math.sqrt(d2)
        const nx   = dx / d, ny = dy / d
        const half = (minD - d) * 0.5
        pi.x -= nx * half;  pi.y -= ny * half
        pj.x += nx * half;  pj.y += ny * half
        const dvn = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
        if (dvn > 0) {
          pi.vx -= dvn * nx;  pi.vy -= dvn * ny
          pj.vx += dvn * nx;  pj.vy += dvn * ny
        }
      }
    }

    // ── Freed-ion exclusion zone (XPBD position correction) ──────
    // Force-based springs can be overpowered at high velocities. Position
    // correction is unconditionally stable: freed ions are pushed apart
    // to minD = (r_i + r_j) * FREE_EXCL regardless of velocity or force.
    // Si-O uses _sioExclMult (default 1.4, tunable via dev slider) so that
    // freed Si-O can reach r0=9px and settle there (1.4×5.5=7.7px < r0=9px < capture=9.63px).
    // Values 1.5–1.7 place the floor inside the capture window but above r0, creating a
    // resonance band that inflates KE to ~3.8× target; values ≥1.8 exceed the capture radius.
    const FREE_EXCL = 2.0   // exclusion = 2× contact radius (~10-11 px for Na+O)
    for (let i = 0; i < n; i++) {
      if (!latticeFreed[i]) continue
      const pi = particles[i]
      for (let j = i + 1; j < n; j++) {
        if (!latticeFreed[j]) continue
        const pj = particles[j]
        const dx = miDx(pj.x - pi.x)
        if (dx > FORCE_CUTOFF || dx < -FORCE_CUTOFF) continue
        const dy   = miDy(pj.y - pi.y)
        const isSiOPair = pi.typeId + pj.typeId === 1  // Si(0)+O(1) uniquely sums to 1
        const minD = (pi.r + pj.r) * (isSiOPair ? _sioExclMult : FREE_EXCL)
        const d2   = dx * dx + dy * dy
        if (d2 >= minD * minD || d2 < 1e-6) continue
        const d    = Math.sqrt(d2)
        const nx   = dx / d, ny = dy / d
        const half = (minD - d) * 0.5
        // Push apart and wrap
        let ax = pi.x - nx * half, ay = pi.y - ny * half
        let bx = pj.x + nx * half, by = pj.y + ny * half
        if (ax <  0) ax += SIM_W; if (ax >= SIM_W) ax -= SIM_W
        if (ay <  0) ay += SIM_H; if (ay >= SIM_H) ay -= SIM_H
        if (bx <  0) bx += SIM_W; if (bx >= SIM_W) bx -= SIM_W
        if (by <  0) by += SIM_H; if (by >= SIM_H) by -= SIM_H
        pi.x = ax; pi.y = ay; pj.x = bx; pj.y = by
        // Elastic velocity correction
        const dvn = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
        if (dvn > 0) {
          pi.vx -= dvn * nx;  pi.vy -= dvn * ny
          pj.vx += dvn * nx;  pj.vy += dvn * ny
        }
      }
    }

    // ── Thermostat or cooling ────────────────────────────────────
    if (coolingFactor < 1.0 - 1e-6) {
      // Cooling mode: apply per-substep damping (nth root of the per-step factor)
      const sf = Math.pow(coolingFactor, 1 / SUBSTEPS)
      for (let i = 0; i < n; i++) { particles[i].vx *= sf; particles[i].vy *= sf }
    } else {
      // Langevin thermostat: per-substep damping + Gaussian kick, applied to all atoms.
      // The damping factor (DAMP per substep) bleeds off velocity from spring-force oscillations,
      // keeping edge atoms (fewer bond constraints) as tightly held as interior ones.
      // Without damping, edge atoms accumulate velocity between thermostat events and oscillate
      // more than interior atoms — visually appearing "looser."
      const DAMP              = 1 - THERMOSTAT_TAU
      const kickSigma         = vTarget * Math.sqrt(THERMOSTAT_TAU)
      // crystAnchor/naAnchor atoms get _crystJiggleMult × larger kicks (default 3.3).
      // Higher values keep edge atoms as tight as interior ones; lower values bring
      // measured KE closer to the thermostat target.
      const kickSigmaCryst    = kickSigma * _crystJiggleMult
      for (let i = 0; i < n; i++) {
        const isFreed = latticeFreed[i]
        const rampFrames = phys.reintRampFrames?.[i] ?? 0
        const kickMult = rampFrames > 0
          ? _latticeSpeedMult + (rampFrames / REINT_RAMP_FRAMES) * (_freedSpeedMult - _latticeSpeedMult)
          : (isFreed ? _freedSpeedMult : _latticeSpeedMult)
        const baseSigma = (crystAnchor[i] || naAnchor[i]) ? kickSigmaCryst : kickSigma
        const ks = baseSigma * kickMult
        const u1 = Math.random() || 1e-10
        const r  = Math.sqrt(-2 * Math.log(u1)) * ks
        const a  = Math.random() * Math.PI * 2
        particles[i].vx = particles[i].vx * DAMP + r * Math.cos(a)
        particles[i].vy = particles[i].vy * DAMP + r * Math.sin(a)
      }
    }
    // Speed cap — clamps all particles (including freed KMT bodies) so no particle
    // accumulates insane velocity from repeated spring forces or wall interactions.
    const maxSpeed = vTarget * 5
    for (let i = 0; i < n; i++) {
      const spd = Math.hypot(particles[i].vx, particles[i].vy)
      if (spd > maxSpeed) {
        const sf = maxSpeed / spd
        particles[i].vx *= sf
        particles[i].vy *= sf
      }
    }
  }

  // ── Bond breaking / reforming (strain-based, with feedback) ─────────────────
  // Effective threshold = rb.breakStrain × (1 + GAIN × fBroken).
  // As bonds break, thresholds rise, slowing further breaking until equilibrium.
  // EMA strain (α=0.1) prevents rare fluctuations from trickling bonds forever.
  let brokenCount = 0, totalBreakable = 0
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.breakable) continue
      totalBreakable++
      if (rb.broken) brokenCount++
    }
  }
  const fBroken    = totalBreakable > 0 ? brokenCount / totalBreakable : 0
  const sio2Pct    = phys.sio2Pct ?? 70
  const GAIN       = FEEDBACK_GAIN_SILICA + (FEEDBACK_GAIN_SODA - FEEDBACK_GAIN_SILICA) * Math.max(0, Math.min(1, (100 - sio2Pct) / 30))
  phys.fBroken     = fBroken   // expose for HUD

  let breakKERemoved = 0, breakKEReturned = 0
  let strainSum = 0, thrSum = 0, strainCount = 0, maxAvgStrain = 0
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.breakable) continue
      const dx = miDx(particles[rb.j].x - particles[rb.i].x)
      const dy = miDy(particles[rb.j].y - particles[rb.i].y)
      const d  = Math.hypot(dx, dy)
      const strain = (d - rb.r0) / rb.r0
      rb.avgStrain  = _useEmaStrain ? rb.avgStrain * 0.9 + strain * 0.1 : strain
      const effThreshold = rb.breakStrain * (1 + GAIN * _feedbackGainMult * fBroken)
      rb.effThreshold = effThreshold
      if (!rb.broken) {
        strainSum += rb.avgStrain; thrSum += effThreshold; strainCount++
        if (rb.avgStrain > maxAvgStrain) maxAvgStrain = rb.avgStrain
      }
      const wasBroken = rb.broken
      if (!rb.broken) {
        if (rb.avgStrain > effThreshold) rb.broken = true
      } else {
        if (strain <= _reformStrain) rb.broken = false
      }
      if (rb.broken !== wasBroken) {
        const half = (rb.bondDepth ?? 0) / 2
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0
        const pi = particles[rb.i], pj = particles[rb.j]
        if (rb.broken) {
          // Bond just broke: drain half-depth from each atom's KE.
          // If an atom can't pay the full half, clamp to zero (thermostat restores over ~2 steps).
          breakKERemoved += _removeKE(pi, half)
          breakKERemoved += _removeKE(pj, half)
        } else {
          // Bond just reformed: inject half-depth outward along bond axis (latent heat release).
          _addKE(pi, half, -nx, -ny)
          _addKE(pj, half,  nx,  ny)
          breakKEReturned += rb.bondDepth ?? 0
        }
      }
    }
  }
  phys.breakKERemoved  = breakKERemoved
  phys.breakKEReturned = breakKEReturned
  phys.maxAvgStrain    = maxAvgStrain
  phys.meanAvgStrain   = strainCount > 0 ? strainSum / strainCount : 0
  phys.meanEffThreshold = strainCount > 0 ? thrSum   / strainCount : 0

  // Count intact bonds per atom.
  const intactCount  = new Int32Array(n)
  const hasSiOBond   = new Uint8Array(n)
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.broken) {
        intactCount[rb.i]++; intactCount[rb.j]++
        if (!rb.breakable) { hasSiOBond[rb.i] = 1; hasSiOBond[rb.j] = 1 }
      }
    }
  }
  phys.intactCount = intactCount  // used by next step's thermostat for freed-atom speed boost

  // Auto-free: any atom that just lost all bonds becomes a KMT body immediately.
  // Without this, the crystal anchor spring still pulls it toward x0 for one more step
  // (because the substep loop reads latticeFreed from last step), causing a visible snap.
  // Gate on rigidBonds existing: before buildRigidBondMap all intactCounts are 0 and
  // every atom would be freed spuriously, permanently disabling the crystal anchor spring.
  if (phys.latticeFreed && phys.rigidBonds) {
    const origCount = phys.originalBondCount
    for (let i = 0; i < n; i++) {
      if (phys.latticeFreed[i]) continue
      // Below melt temp, skip crystAnchor atoms — edge atoms can have intactCount=0
      // without their bonds having broken (they just never formed rigid bonds).
      if (crystAnchor[i] && totalEnergy < 1300) continue
      // Na2O atoms use _naLiberateFrac; SiO2 atoms use _liberateFrac.
      const orig = origCount ? origCount[i] : 0
      const frac = naAnchor[i] ? _naLiberateFrac : _liberateFrac
      const threshold = Math.floor(orig * (1 - frac))
      if (intactCount[i] <= threshold) { phys.latticeFreed[i] = 1; _libStats.strainFires++ }
    }
  }

  // Re-integration: freed atoms that hold ≥N bonds for ≥M consecutive frames are
  // cleared from latticeFreed, their anchor rebased, and their thermostat speed
  // ramped down from _freedSpeedMult to _latticeSpeedMult over REINT_RAMP_FRAMES.
  // Only runs during cooling so hot ions don't accidentally re-integrate mid-melt.
  if (phys.latticeFreed && phys.rigidBonds && phys.stableBondFrames && coolingMode !== null) {
    const sbf = phys.stableBondFrames
    const rrf = phys.reintRampFrames
    for (let i = 0; i < n; i++) {
      if (rrf[i] > 0) rrf[i]--
      if (!phys.latticeFreed[i]) continue
      if (intactCount[i] >= _reintBondN) {
        sbf[i]++
        if (sbf[i] >= _reintFrameM) {
          phys.latticeFreed[i] = 0
          sbf[i] = 0
          rrf[i] = REINT_RAMP_FRAMES
          const p = particles[i]
          p.x0 = p.x; p.y0 = p.y
        }
      } else {
        sbf[i] = 0
      }
    }
  }

  // Temperature is now derived from actual KE so latent heat transactions appear directly.
  // breakKERemoved/Returned track per-step latent heat for diagnostics.
  phys.bondBreakPE = breakKERemoved - breakKEReturned   // net KE drained this step
  let keSum2 = 0, keCount2 = 0
  for (let i = 0; i < n; i++) {
    if (intactCount[i] > 0) {
      keSum2 += particles[i].vx * particles[i].vx + particles[i].vy * particles[i].vy; keCount2++
    }
  }
  phys.latticeTemp = Math.max(-273, keCount2 > 0
    ? (keSum2 * 0.5 / keCount2) / ENERGY_UNIT - 273
    : ePerParticle / ENERGY_UNIT - 273)

  // ── SiO2 lattice liberation by contact ───────────────────────────────────
  // Liberators: freed Na2O atoms, or latticeFreed SiO2 atoms that have drifted > FREED_DRIFT_MIN.
  // When j is liberated we also free its immediate Si-O rigid-bond partners so the whole
  // bonded cluster can move — without this j stays trapped by its still-anchored neighbors.
  // A small outward velocity kick starts the motion.
  const FREED_DRIFT_MIN = 4   // px drift before a freed SiO2 atom can liberate others
  const LIBERATE_KICK   = 0.12  // px/substep kick given to a newly freed atom
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    const isFreedNa2O = naAnchor[i] && intactCount[i] === 0
    const isFreedSiO2 = crystAnchor[i] && latticeFreed[i] &&
      Math.hypot(miDx(pi.x - pi.x0), miDy(pi.y - pi.y0)) > FREED_DRIFT_MIN
    if (!isFreedNa2O && !isFreedSiO2) continue
    // Measure liberator's distance to its nearest own-bond partner (for Na2O: its O bond).
    let dLiberatorBond = -1
    if (isFreedNa2O && phys.rigidBonds) {
      let nearest = Infinity
      for (const rb of phys.rigidBonds) {
        const partner = rb.i === i ? rb.j : rb.j === i ? rb.i : -1
        if (partner < 0) continue
        const pp = particles[partner]
        const bd = Math.hypot(miDx(pp.x - pi.x), miDy(pp.y - pi.y))
        if (bd < nearest) nearest = bd
      }
      dLiberatorBond = nearest === Infinity ? -1 : +nearest.toFixed(2)
    }
    for (let j = 0; j < n; j++) {
      if (j === i || !crystAnchor[j] || latticeFreed[j]) continue
      const pj = particles[j]
      const dx = miDx(pj.x - pi.x), dy = miDy(pj.y - pi.y)
      const d2 = dx * dx + dy * dy
      if (d2 < (pi.r + pj.r + 1) ** 2) {
        _libStats.contactFires++
        if (_libStats.contactSeps.length < 200) {
          _libStats.contactSeps.push({
            liberatorType: isFreedNa2O ? 'Na2O' : 'SiO2',
            dToJ: +Math.sqrt(d2).toFixed(2),
            dLiberatorBond,
          })
        }
        latticeFreed[j] = 1
        // Kick j away from i
        const d = Math.sqrt(d2) || 1
        pj.vx += (dx / d) * LIBERATE_KICK
        pj.vy += (dy / d) * LIBERATE_KICK
        // Free j's immediate Si-O bond partners so the cluster drifts together.
        // Without this, j stays trapped by still-anchored neighbors via XPBD.
        if (phys.rigidBonds) {
          for (const rb of phys.rigidBonds) {
            if (rb.broken || rb.breakable) continue   // Si-O only
            const partner = rb.i === j ? rb.j : rb.j === j ? rb.i : -1
            if (partner >= 0 && crystAnchor[partner] && !latticeFreed[partner]) {
              latticeFreed[partner] = 1
              particles[partner].vx += (dx / d) * LIBERATE_KICK * 0.5
              particles[partner].vy += (dy / d) * LIBERATE_KICK * 0.5
            }
          }
        }
      }
    }
  }

  // ── Si-O bond severance by modifier ion contact ──────────────────────────
  // A freed Na⁺ or Ca²⁺ within _sevTriggerDist px of either endpoint of an intact Si-O bond severs it.
  let sevFiresThisStep = 0
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.isSiO || rb.broken) continue
      const pi = particles[rb.i], pj = particles[rb.j]
      for (let k = 0; k < n; k++) {
        const pk = particles[k]
        if (pk.typeId !== 2 && pk.typeId !== 3) continue  // Na, Ca only
        if (intactCount[k] > 0) continue                  // must be a freed ion
        if (Math.hypot(pk.x - pi.x, pk.y - pi.y) < _sevTriggerDist ||
            Math.hypot(pk.x - pj.x, pk.y - pj.y) < _sevTriggerDist) {
          rb.broken = true
          sevFiresThisStep++
          break
        }
      }
    }
  }
  phys._sevFireEma = (phys._sevFireEma ?? 0) * 0.95 + sevFiresThisStep * 0.05
  phys.sevFireRate = phys._sevFireEma * 60  // fires/sec assuming ~60 steps/sec

  // ── Displacement clamp ────────────────────────────────────────────────────
  // Si-O bonded atoms: tight 5px unless freed from lattice by contact, then LOOSE_WANDER.
  // Other bonded atoms (Na-O, Ca-O): loose clamp that grows with temperature so
  //   KE can accumulate into the bond-breaking range (3px → 12px at E:=1200).
  // Freed atoms (intactCount=0): no clamp — roam freely under anchor + walls.
  const LOOSE_WANDER = 3 + Math.max(0, totalEnergy) * 9 / 1200
  for (let i = 0; i < n; i++) {
    if (intactCount[i] === 0) continue
    if (latticeFreed[i]) continue   // freed SiO2: no positional clamp, rigid bonds constrain it
    const limit = hasSiOBond[i] ? 5 : LOOSE_WANDER
    const p = particles[i]
    const dx = miDx(p.x - p.x0), dy = miDy(p.y - p.y0)
    const d2 = dx * dx + dy * dy
    if (d2 > limit * limit) {
      const d  = Math.sqrt(d2)
      const nx = dx / d, ny = dy / d
      let wx = p.x0 + nx * limit, wy = p.y0 + ny * limit
      if (wx <  0)     wx += SIM_W
      if (wx >= SIM_W) wx -= SIM_W
      if (wy <  0)     wy += SIM_H
      if (wy >= SIM_H) wy -= SIM_H
      p.x = wx; p.y = wy
      const vout = p.vx * nx + p.vy * ny
      if (vout > 0) { p.vx -= vout * nx; p.vy -= vout * ny }
    }
  }

  // ── Bond detection for rendering ─────────────────────────────────────────
  // All rigid bonds render until atoms separate past the alpha-fade range (40 px).
  // Broken bonds stay in the list so atoms visibly stretch pink then fade — not snap off.
  // All rigid pairs are excluded from the dynamic scan to prevent double-counting.
  const bonds = []
  const rigidPairSet = new Set()
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      rigidPairSet.add(rb.i * n + rb.j)
      const pi = particles[rb.i], pj = particles[rb.j]
      const d  = Math.hypot(miDx(pj.x - pi.x), miDy(pj.y - pi.y))
      if (d >= 40) continue
      bonds.push({ i: rb.i, j: rb.j, strain: (d - rb.r0) / rb.r0, currentBreakStrain: rb.breakStrain, broken: rb.broken, avgStrain: rb.avgStrain, effThreshold: rb.effThreshold })
    }
  }
  // Dynamic soft bonds: Na-O / Ca-O pairs not already in rigidBonds
  for (let i = 0; i < n; i++) {
    const pi = particles[i]
    for (let j = i + 1; j < n; j++) {
      if (rigidPairSet.has(i * n + j)) continue
      const pj   = particles[j]
      const spec = PAIR_TABLE[pi.typeId][pj.typeId]
      if (!spec || spec.repOnly) continue
      const effMult    = (spec === PAIR_TABLE[0][1]) ? sioMult : spec.mult
      const renderMult = spec.viewMult ?? effMult
      const dx = miDx(pj.x - pi.x)
      if (dx > spec.r0 * renderMult || dx < -spec.r0 * renderMult) continue
      const d = Math.hypot(dx, miDy(pj.y - pi.y))
      if (d > spec.r0 * renderMult) continue
      bonds.push({ i, j, strain: (d - spec.r0) / spec.r0, currentBreakStrain: 0.25 })
    }
  }
  phys.bonds = bonds

  // ── Debug snapshot (read via window.meltDebug()) ──────────────────────────
  if (!phys.dbg) phys.dbg = {}
  const dbg = phys.dbg
  const { ke: bKE, n: bN } = computeBondedKE(phys)
  dbg.totalEnergy   = Math.round(totalEnergy)
  dbg.derivedTempC  = Math.round(bKE / (bN * ENERGY_UNIT) - 273)
  dbg.hasBeenMelted = phys.hasBeenMelted
  dbg.anchorStr     = phys.hasBeenMelted ? 0
    : +(ANCHOR_K * Math.max(0, 1 - totalEnergy / ANCHOR_FADE_TEMP)).toFixed(3)
  dbg.wanderLimit   = +(3 + Math.max(0, totalEnergy) * 9 / 1200).toFixed(1)
  dbg.freeAtoms     = Array.from(intactCount).filter(c => c === 0).length
  if (phys.rigidBonds) {
    const bstats = {}
    for (const rb of phys.rigidBonds) {
      const pi = particles[rb.i], pj = particles[rb.j]
      const key = `${pi.type}-${pj.type}`
      if (!bstats[key]) bstats[key] = { total: 0, broken: 0 }
      bstats[key].total++
      if (rb.broken) bstats[key].broken++
    }
    dbg.bonds = bstats
  }
}

// ── Runtime parameter updates ────────────────────────────────────────────────
// Mutates the shared PREFERRED entry so PAIR_TABLE and the force
// loop all pick up the new value immediately without rebuilding the module.
export function setSiOr0(r0) {
  PREFERRED['O-Si'].r0 = r0
}

// Rebuild phys.bonds from current particle positions — used by replay to
// reconstruct bond display from a stored position snapshot.
export function rebuildBonds(phys) {
  const { particles } = phys
  const n = particles.length
  const sm = phys.sioMult ?? SIO_COLD_MULT
  const bonds = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const spec = PAIR_TABLE[particles[i].typeId][particles[j].typeId]
      if (!spec) continue
      const effMult = (spec === PAIR_TABLE[0][1]) ? sm : spec.mult
      const dx = particles[j].x - particles[i].x
      if (Math.abs(dx) > spec.r0 * effMult) continue
      const d = Math.hypot(dx, particles[j].y - particles[i].y)
      if (d > spec.r0 * effMult) continue
      bonds.push({ i, j, spec, strain: (d - spec.r0) / spec.r0, currentBreakStrain: effMult - 1 })
    }
  }
  phys.bonds = bonds
}

// ── Calibration helper ────────────────────────────────────────────────────────
// Call from browser console: measureStrain95()
// Hold sim at a target temperature, let it settle, then call to read the
// 95th-percentile strain across intact rigid bonds — use as BASE for that preset.
export function measureStrain95(phys) {
  if (!phys?.rigidBonds || !phys?.particles) { console.warn('no phys'); return }
  const ps = phys.particles
  const strains = []
  for (const rb of phys.rigidBonds) {
    if (!rb.breakable || rb.broken) continue
    const d = Math.hypot(miDx(ps[rb.j].x - ps[rb.i].x), miDy(ps[rb.j].y - ps[rb.i].y))
    strains.push(Math.abs((d - rb.r0) / rb.r0))
  }
  if (!strains.length) { console.warn('no intact bonds'); return }
  strains.sort((a, b) => a - b)
  const idx50 = Math.floor(strains.length * 0.50)
  const idx95 = Math.floor(strains.length * 0.95)
  console.table({
    'intact bonds': { value: strains.length },
    'p50 strain':   { value: strains[idx50].toFixed(5) },
    'p95 strain':   { value: strains[idx95].toFixed(5) },
    'fBroken':      { value: (phys.fBroken ?? 0).toFixed(3) },
  })
  return { p50: strains[idx50], p95: strains[idx95] }
}
