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
let _breakStrain     = 0.04  // strain threshold for bond breaking: bond breaks when (d−r₀)/r₀ > _breakStrain
let _reformStrain    = 0.0   // strain threshold for bond reform: bond reforms when (d−r₀)/r₀ ≤ _reformStrain
let _crystAnchorK    = 0.06  // crystAnchor spring constant for SiO2 network atoms
let _liberateFrac    = 0.5   // liberation fraction for SiO2 atoms (1.0 = all broken, 0.5 = majority broken)
let _naAnchorK       = 0.06  // naAnchor spring constant for Na2O atoms (independent of _crystAnchorK)
let _naLiberateFrac  = 0.5   // liberation fraction for Na2O atoms
let _naBreakStrain   = 0.02  // break strain for Na-O bonds (independent of Si-O _breakStrain)
let _breakStrainSpread = 0.15 // per-bond random ± factor drawn at buildRigidBondMap; 0 = uniform
let _useEmaStrain     = false // true = EMA-smoothed strain for break check; false = instantaneous
let _sevTriggerDist   = 13   // px — freed modifier ion must be within this distance of a Si or O to sever the Si-O bond
// Feedback loop calibration: GAIN interpolated on sio2Pct between soda (70%) and silica (100%)
const FEEDBACK_GAIN_SODA   = 0.437  // 70% SiO2 / 30% Na2O: f=0 at 500°C, f=1 at 1322°C
// Si-O XPBD projection holds grains rigid up to this temperature. Pure sand (100% SiO₂) is set
// above the model's reach so it never melts; any modifier content drops it so grains dissolve.
const sioProjCutoff = sio2Pct => sio2Pct >= 100 ? 1800 : 1300
const FEEDBACK_GAIN_SILICA = 0.112  // 100% SiO2:             f=0 at 1500°C, f=1 at 1920°C
let _feedbackGainMult = 40          // scalar multiplier on GAIN — dial up/down feedback ramp speed
let _latticeSpeedMult = 1.0  // kick-sigma multiplier for bonded (non-freed) atoms
let _freedSpeedMult   = 5    // kick-sigma multiplier for freed atoms
let _reintBondN       = 2    // min intact bonds to count toward re-integration
let _reintFrameM      = 30   // consecutive frames with ≥N bonds before cleared
const REINT_RAMP_FRAMES = 10  // frames to ramp speed mult from freed→lattice after re-integration
let _sevCooldown       = 60    // steps a severed Si-O bond can't reform (counts down only once the ion has left)
let _sevPullK          = 0.01  // ion→O pull strength after severance (0 = off)
let _freedTau          = 0.01  // Langevin coupling for freed atoms; lower = longer straight runs, same temperature
let _bondStiffMult     = 1.0   // multiplier on intact rigid-bond restoring spring (above projection cutoff)
let _coolBondScale     = 1.0   // "Longer cooled bonds": scales rigid-bond rest length during cooling (1.0→1.1 over 300°C), latched. Set from CompositionView; reset to 1 on reheat.
let _motifStrength    = 0.004 // max motif-bias spring k at full cooling ramp (see applyMotifBias)
let _motifAlign       = 0.85  // slow cool: fraction of the neighbour-orientation offset each Si's slots adopt (0–1). Higher = domains spread into a bigger hex crystal. (fast cool passes align=0)
// Console-tunable knobs (crystallinity tuning). Guarded so headless Node (meltStructure after a
// slow cool) doesn't throw on a missing `window`; defaults apply when unset.
const _win = typeof window !== 'undefined' ? window : {}
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
export const setSevCooldown        = v => { _sevCooldown = v }
export const setSevPullK           = v => { _sevPullK = v }
export const setFreedTau           = v => { _freedTau = v }
export const setBondStiffMult      = v => { _bondStiffMult = v }
export const setCoolBondScale      = v => { _coolBondScale = v }
export const setMotifStrength      = v => { _motifStrength = v }
export const setMotifAlign         = v => { _motifAlign = v }
export const setSiSiRepR0          = v => { PAIR_TABLE[0][0].r0 = v }
export const getSiSiRepR0          = () => PAIR_TABLE[0][0].r0
export const setNaNaRepR0          = v => { PAIR_TABLE[2][2].r0 = v }
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

// ── Toroidal uniform-grid spatial hash (ported from sandPhysics.js) ──────────
// The sand grid has walls; this one wraps (the melt domain is toroidal — see miDx/miDy).
// It buckets atoms so the pair loops scan only the same + 8 adjacent cells instead of all
// O(n²) pairs. Correctness invariant: the cell size must be ≥ the loop's per-axis gate, so
// that any pair within `gate` in each axis lies in the same or an adjacent cell and the ±1
// scan cannot miss it. Cell size is tied to FORCE_CUTOFF, the largest gate among the loops
// routed through it. The grid must also be ≥3 cells per axis, so the ±1 offsets wrap to
// three DISTINCT cells and no pair is visited twice. At 600×350 / 20 that is 30×17 cells.
// ⚠️ If FORCE_CUTOFF ever rises (e.g. the Na-Na continuous-force option in CLAUDE.md), the
// cell size rises with it automatically — but re-check the ≥3-cells-per-axis bound.
let _useMeltHash = true            // window._useMeltHash toggles it (brute force when false)
let _mgCols = 0, _mgRows = 0, _mgCW = 0, _mgCH = 0
let _mgHead = null, _mgNext = null
function allocMeltGrid(n) {
  _mgCols = Math.max(3, Math.floor(SIM_W / FORCE_CUTOFF))
  _mgRows = Math.max(3, Math.floor(SIM_H / FORCE_CUTOFF))
  _mgCW   = SIM_W / _mgCols
  _mgCH   = SIM_H / _mgRows
  _mgHead = new Int32Array(_mgCols * _mgRows)
  _mgNext = new Int32Array(n)
}
function rebuildMeltGrid(particles, n) {
  _mgHead.fill(-1)
  for (let i = 0; i < n; i++) {
    const p = particles[i]
    let cx = (p.x / _mgCW) | 0; if (cx < 0) cx = 0; else if (cx >= _mgCols) cx = _mgCols - 1
    let cy = (p.y / _mgCH) | 0; if (cy < 0) cy = 0; else if (cy >= _mgRows) cy = _mgRows - 1
    const k = cy * _mgCols + cx
    _mgNext[i] = _mgHead[k]
    _mgHead[k] = i
  }
}
// Visit each unordered pair of same-or-adjacent-cell atoms exactly once. Mirrors the
// brute-force `j > i` dedup, so the callback always gets i < j — keeping the sign of
// miDx/miDy (and therefore the force math) identical to the O(n²) path.
function eachMeltPair(particles, n, fn) {
  rebuildMeltGrid(particles, n)
  for (let ai = 0; ai < n; ai++) {
    const p = particles[ai]
    let acx = (p.x / _mgCW) | 0; if (acx < 0) acx = 0; else if (acx >= _mgCols) acx = _mgCols - 1
    let acy = (p.y / _mgCH) | 0; if (acy < 0) acy = 0; else if (acy >= _mgRows) acy = _mgRows - 1
    for (let dcy = -1; dcy <= 1; dcy++) {
      let cy = acy + dcy; if (cy < 0) cy += _mgRows; else if (cy >= _mgRows) cy -= _mgRows
      for (let dcx = -1; dcx <= 1; dcx++) {
        let cx = acx + dcx; if (cx < 0) cx += _mgCols; else if (cx >= _mgCols) cx -= _mgCols
        let bi = _mgHead[cy * _mgCols + cx]
        while (bi !== -1) {
          if (bi > ai) fn(ai, bi)
          bi = _mgNext[bi]
        }
      }
    }
  }
}
export function setMeltHash(on) { _useMeltHash = !!on }

// Stage-1 verification: prove the hash visits EXACTLY the in-gate pair set the brute-force
// force loop would — and each such pair exactly once. Order-independent (compares sets), so
// it is immune to the FP summation-order differences the hash legitimately introduces.
// Run `window.verifyHashPairs()` from the console on any live state (hot, cold, mid-melt).
// ok === true means the two paths apply force to the identical set of pairs.
export function verifyHashPairs(phys) {
  const { particles, n } = phys
  const g = FORCE_CUTOFF
  const inGate = (i, j) => {
    const dx = miDx(particles[j].x - particles[i].x)
    if (dx > g || dx < -g) return false
    const dy = miDy(particles[j].y - particles[i].y)
    if (dy > g || dy < -g) return false
    return dx * dx + dy * dy >= 0.01
  }
  const brute = new Set()
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (inGate(i, j)) brute.add(i * n + j)
  const visits = new Map()
  eachMeltPair(particles, n, (i, j) => { const k = i * n + j; visits.set(k, (visits.get(k) || 0) + 1) })
  let missing = 0, doubled = 0
  for (const k of brute) if (!visits.has(k)) missing++
  for (const [, c] of visits) if (c > 1) doubled++
  const res = {
    n, cells: `${_mgCols}×${_mgRows}`, cellSize: `${_mgCW.toFixed(1)}×${_mgCH.toFixed(1)}`,
    brutePairs: brute.size, hashVisits: visits.size,
    missingInHash: missing, doubleVisited: doubled,
    ok: missing === 0 && doubled === 0,
  }
  console.table([res])
  return res
}
// 4×4 pair-spec table indexed by [typeIdA][typeIdB]
const PAIR_TABLE = Array.from({ length: 4 }, () => new Array(4).fill(null))
PAIR_TABLE[0][1] = PAIR_TABLE[1][0] = PREFERRED['O-Si']
PAIR_TABLE[2][1] = PAIR_TABLE[1][2] = PREFERRED['Na-O']
PAIR_TABLE[3][1] = PAIR_TABLE[1][3] = PREFERRED['Ca-O']
// Like-charge repulsion: same-sign ions push each other away.
// repOnly:true means force only fires at d < r0 (pure repulsion, never attractive).
// freeRepR0/freeRepK: extra floor repulsion when both atoms are freed (not in original crystal).
// Si-Si r0 15.6: with Si-O r0=9 this keeps Si-O-Si ≥ ~120°, so the melt can't fold denser
// than the crystal (Si-Si = 18px there, unaffected). Tunable via setSiSiRepR0 dev slider.
PAIR_TABLE[0][0] = { r0: 15.6, k: 0.22, mult: 1, repOnly: true }                                             // Si-Si  (Si⁴⁺)
PAIR_TABLE[1][1] = { r0:  8, k: 0.32, mult: 1, repOnly: true, freeRepR0: 6, freeRepK: 0.3 }                 // O-O    (O²⁻; extra push when freed)
// Na-Na r0 16 (was 8): spreads Na through the melt instead of clumping; crystal Na-Na = 24px, unaffected.
PAIR_TABLE[2][2] = { r0: 35, k: 0.45, mult: 1, repOnly: true }                                               // Na-Na  (Na⁺)
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

// ── Motif bias (cooling) ─────────────────────────────────────────────────────
// Relative targets instead of absolute positions: each Si prefers its bonded O at
// 120° slots (distance r0), each 2-coordinated O prefers its two Si roughly opposite.
// Slots are fixed once per step from step-start positions; forces are momentum-
// conserving springs so the thermostat keeps temperature honest.
const PI2 = Math.PI * 2
const wrapPi = a => { a = ((a + Math.PI) % PI2 + PI2) % PI2; return a - Math.PI }
const PERMS3 = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]

// Best-fit 3-fold orientation φ (mod 120°) of a set of bond angles.
function fitPhi(angles) {
  let c = 0, sn = 0
  for (const t of angles) { c += Math.cos(3 * t); sn += Math.sin(3 * t) }
  return Math.atan2(sn, c) / 3
}

// Builds per-step motif data. align=0 → each Si only regularises its own angles
// (amorphous). align>0 → each Si's φ is pulled toward its Si neighbours' orientation
// mod 60° (both honeycomb sublattices share φ mod 60°), so domains spread (crystal).
function buildMotif(particles, siO, oSi, align) {
  const phiOwn = new Map()
  for (const [s, os] of siO) {
    if (os.length < 2 || os.length > 3) continue   // >3 only via uncapped rigid bonds; no 3-slot motif fits
    const ps = particles[s]
    phiOwn.set(s, fitPhi(os.map(o => Math.atan2(miDy(particles[o].y - ps.y), miDx(particles[o].x - ps.x)))))
  }
  const sites = []
  for (const [s, os] of siO) {
    if (!phiOwn.has(s)) continue
    let phi = phiOwn.get(s)
    if (align > 0) {
      let c = 0, sn = 0
      for (const o of os) for (const s2 of (oSi.get(o) ?? [])) {
        if (s2 === s || !phiOwn.has(s2)) continue
        c += Math.cos(6 * phiOwn.get(s2)); sn += Math.sin(6 * phiOwn.get(s2))
      }
      if (c !== 0 || sn !== 0) {
        const dom = Math.atan2(sn, c) / 6
        const off = ((dom - phi) % (Math.PI / 3) + Math.PI / 3 * 1.5) % (Math.PI / 3) - Math.PI / 6  // wrap ±30°
        phi += align * off
      }
    }
    // Assign O to unique slots minimising total angular error
    const ps = particles[s]
    const ang = os.map(o => Math.atan2(miDy(particles[o].y - ps.y), miDx(particles[o].x - ps.x)))
    const slots = [phi, phi + PI2 / 3, phi - PI2 / 3]
    let best = null, bestErr = Infinity
    for (const perm of PERMS3) {
      let err = 0
      for (let k = 0; k < os.length; k++) { const e = wrapPi(ang[k] - slots[perm[k]]); err += e * e }
      if (err < bestErr) { bestErr = err; best = perm }
    }
    sites.push({ s, os, slotAng: os.map((_, k) => slots[best[k]]) })
  }
  const bridges = []
  for (const [o, ss] of oSi) if (ss.length === 2) bridges.push([o, ss[0], ss[1]])
  return { sites, bridges }
}

function applyMotifForces(particles, motif, k, r0, fx, fy) {
  for (const { s, os, slotAng } of motif.sites) {
    const ps = particles[s]
    for (let m = 0; m < os.length; m++) {
      const o = os[m], po = particles[o]
      const tx = r0 * Math.cos(slotAng[m]) - miDx(po.x - ps.x)
      const ty = r0 * Math.sin(slotAng[m]) - miDy(po.y - ps.y)
      fx[o] += k * tx;  fy[o] += k * ty
      fx[s] -= k * tx;  fy[s] -= k * ty
    }
  }
  // O bridge: pull O toward the midpoint of its two Si → straightens Si-O-Si toward 180°
  const kb = k * 0.5
  for (const [o, s1, s2] of motif.bridges) {
    const po = particles[o], p1 = particles[s1]
    const mx = miDx(p1.x - po.x) + miDx(particles[s2].x - p1.x) * 0.5
    const my = miDy(p1.y - po.y) + miDy(particles[s2].y - p1.y) * 0.5
    fx[o]  += kb * mx;        fy[o]  += kb * my
    fx[s1] -= kb * mx * 0.5;  fy[s1] -= kb * my * 0.5
    fx[s2] -= kb * mx * 0.5;  fy[s2] -= kb * my * 0.5
  }
}

// Harmonic O–Si–O angle-bending toward 120° (the trigonal unit that tiles into the hex
// network). Applied on slow cool with a stiffness that ramps up as the melt cools, so the
// bonds progressively "lock" to crystal angles and hexagons emerge — the direct geometric
// constraint the soft orientation motif only approximates. Standard angle force (forces on the
// two O plus an equal-and-opposite reaction on the Si, so momentum and the thermostat stay
// honest). `siO` maps each Si → its bonded O list. theta0 = 120°.
const ANGLE_120 = (2 * Math.PI) / 3
function applyAngleBend(particles, siO, k, fx, fy) {
  for (const [s, os] of siO) {
    if (os.length < 2) continue
    const ps = particles[s]
    for (let i = 0; i < os.length; i++) {
      for (let j = i + 1; j < os.length; j++) {
        const a = os[i], b = os[j]
        const ax = miDx(particles[a].x - ps.x), ay = miDy(particles[a].y - ps.y)
        const bx = miDx(particles[b].x - ps.x), by = miDy(particles[b].y - ps.y)
        const l1 = Math.hypot(ax, ay), l2 = Math.hypot(bx, by)
        if (l1 < 1e-4 || l2 < 1e-4) continue
        const inv1 = 1 / l1, inv2 = 1 / l2
        const u1x = ax * inv1, u1y = ay * inv1, u2x = bx * inv2, u2y = by * inv2
        let c = u1x * u2x + u1y * u2y
        if (c > 1) c = 1; else if (c < -1) c = -1
        const sinT = Math.max(1e-3, Math.sqrt(1 - c * c))
        const theta = Math.acos(c)
        const coef = k * (theta - ANGLE_120) / sinT   // → pushes theta toward 120°
        const fax = coef * inv1 * (u2x - c * u1x), fay = coef * inv1 * (u2y - c * u1y)
        const fbx = coef * inv2 * (u1x - c * u2x), fby = coef * inv2 * (u1y - c * u2y)
        fx[a] += fax;  fy[a] += fay
        fx[b] += fbx;  fy[b] += fby
        fx[s] -= fax + fbx;  fy[s] -= fay + fby
      }
    }
  }
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
  const chunks = cellData.map(({ idx, type, pts, bg, bdr }) => {
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
    return { idx, type, pts, bg, bdr, origCx, origCy, origSpread: Math.max(origSpread, 4), pIdxs }
  })

  allocMeltGrid(n)   // spatial hash sized to this composition's atom count

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
  const sioCut  = sioProjCutoff(phys.sio2Pct ?? 70)
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
          projectionCutoff: isSiO ? sioCut : 650 + 480 * Math.random(),  // Na-O/Ca-O uniform over the 650-1130 melt window → broken% ramps linearly with T; Si-O exact
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

// Promote atom i's live dynamic bonds to rigid bonds (on re-integration during cooling)
// so XPBD projection + strain breaking hold the new solid. r0 = spec.r0 (not current d).
function promoteBonds(phys, i) {
  const { particles, n } = phys
  const sioCut = sioProjCutoff(phys.sio2Pct ?? 70)
  if (!phys.rigidKeys) phys.rigidKeys = new Set(phys.rigidBonds.map(rb => rb.i * n + rb.j))
  for (const b of (phys.bonds ?? [])) {
    if (b.broken || (b.i !== i && b.j !== i)) continue
    const a = Math.min(b.i, b.j), c = Math.max(b.i, b.j)
    if (phys.rigidKeys.has(a * n + c)) continue
    const spec = PAIR_TABLE[particles[a].typeId][particles[c].typeId]
    if (!spec || spec.repOnly) continue
    const isSiO  = spec === PAIR_TABLE[0][1]
    const factor = 1 + (Math.random() * 2 - 1) * _breakStrainSpread
    phys.rigidBonds.push({
      i: a, j: c, r0: spec.r0,
      broken: false,
      breakable: true,
      isSiO,
      specMult: isSiO ? null : spec.mult,
      bondDepth: 0.5 * spec.k * (spec.r0 * (spec.mult - 1)) ** 2,
      breakStrain:      (isSiO ? _breakStrain : _naBreakStrain) * factor,
      projectionCutoff: isSiO ? sioCut : 650 + 480 * Math.random(),  // Na-O/Ca-O uniform over the 650-1130 melt window → broken% ramps linearly with T; Si-O exact
      avgStrain:        0,
      promoted:         true,
    })
    phys.rigidKeys.add(a * n + c)
  }
}

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
  // Broken rigid bonds stay in phys.bonds (for the pink fade) until 40px apart — they
  // must not count toward coordination, or freshly-broken atoms look saturated.
  const liveCount = new Int32Array(n)   // live opposite-charge bonds per atom
  const siOCount  = new Int32Array(n)   // Si: bonded O; O: bonded Si
  const siOPairs  = new Set()           // live Si-O pairs, key = min·n + max
  for (const b of (phys.bonds ?? [])) {
    if (b.broken) continue
    liveCount[b.i]++; liveCount[b.j]++
    if (particles[b.i].typeId + particles[b.j].typeId === 1) {
      siOCount[b.i]++; siOCount[b.j]++
      siOPairs.add(b.i < b.j ? b.i * n + b.j : b.j * n + b.i)
    }
  }
  const doAttract = attractK > 0 && coolingMode !== null
  const bondCount = doAttract ? liveCount : null

  // For slow cool: map each Si → array of current O-bond angles so idealHexAngle()
  // can direct incoming O toward the correct 120° slot rather than Si's center.
  const siBondAngles = (doAttract && coolingMode === 'slow') ? new Map() : null
  if (siBondAngles) {
    for (const b of (phys.bonds ?? [])) {
      if (b.broken) continue
      const { i, j } = b
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

  // Motif bias during cooling: ramps 0 → _motifStrength as target T falls 1500 → 600°C.
  // Fast: half strength, no orientation alignment → amorphous. Slow: full + alignment → crystal.
  const isCooling = coolingMode === 'fast' || coolingMode === 'slow'
  const motifRamp = isCooling ? Math.max(0, Math.min(1, (1500 - totalEnergy) / 900)) : 0
  // Slow cool drives the Si hex motif harder than fast (× slowBoost vs × 0.5) so clean
  // 6-ring crystal domains actually form instead of a slightly-tidier melt. Live-tunable via
  // window._slowCrystBoost; lock the value here once dialed in.
  const slowBoost = coolingMode === 'slow' ? (_win._slowCrystBoost ?? 4.0) : 0.5
  const motifK    = motifRamp * _motifStrength * slowBoost
  let motif = null
  let orderedSi = null
  let crystalO = null   // O atoms belonging to the ordered Si network — the negative sites Na seeks
  let siOMap = null   // Si → bonded-O list, reused by the slow-cool angle-bend
  if (motifK > 0) {
    const siO = new Map(), oSi = new Map()
    for (const key of siOPairs) {
      const a = Math.floor(key / n), b = key % n
      const [s, o] = particles[a].typeId === 0 ? [a, b] : [b, a]
      if (!siO.has(s)) siO.set(s, []); siO.get(s).push(o)
      if (!oSi.has(o)) oSi.set(o, []); oSi.get(o).push(s)
    }
    motif = buildMotif(particles, siO, oSi, coolingMode === 'slow' ? _motifAlign : 0)
    // Si atoms that belong to an ordered motif site — the crystallising network that rejects Na.
    orderedSi = motif.sites.map(st => st.s)
    // The O atoms of that ordered network — the negatively-charged crystal sites Na is drawn to.
    const crO = new Set()
    for (const st of motif.sites) for (const o of st.os) crO.add(o)
    crystalO = Array.from(crO)
    siOMap = siO
  }
  phys.motifK = motifK
  // Crystallisation lock temperature (°C): above it, no net bonds form (see reform/re-integration
  // gates below) so the melt stays mobile; below it bonds form and the geometry builds.
  const CRYST_LOCK = _win._crystLockTemp ?? 1050
  // O–Si–O angle-bending stiffness for slow cool: zero above CRYST_LOCK, ramping to full by
  // 650°C — the rigid hex geometry builds inside the mobile 1050→650 window and is set by 650.
  // Live-tunable via window._angleBendK.
  const geoRamp    = Math.max(0, Math.min(1, (CRYST_LOCK - totalEnergy) / (CRYST_LOCK - 650)))
  const angleBendK = coolingMode === 'slow' ? (_win._angleBendK ?? 0.3) * geoRamp : 0
  // Na-Na repulsion (normally r0=35, spreads Na through the melt) fades as the melt cools, so
  // Na can cluster together against the crystal boundaries instead of staying apart. Scales the
  // Na-Na repulsive force from full (hot, ≥CRYST_LOCK) down to _naNaCoolFloor (default 0) by
  // ~500°C. Slow cool only. Live-tunable via window._naNaCoolFloor.
  const naNaFloor  = _win._naNaCoolFloor ?? 0.0
  const naNaScale  = coolingMode === 'slow'
    ? naNaFloor + (1 - naNaFloor) * Math.max(0, Math.min(1, (totalEnergy - 500) / (CRYST_LOCK - 500)))
    : 1
  // Freed atoms' extra thermal kick fades to lattice level as cooling passes 1300 → 600°C,
  // otherwise freed atoms run ~12× hotter than the target and can never freeze.
  const coolFrac     = isCooling ? Math.max(0, Math.min(1, (1300 - totalEnergy) / 700)) : 0
  const freedMultEff = _freedSpeedMult + (_latticeSpeedMult - _freedSpeedMult) * coolFrac

  // Per-pair interaction force (the body of the old O(n²) force loop, verbatim), hoisted so
  // the same code runs whether pairs come from the brute-force sweep or the spatial hash.
  // Defined once per step: everything it closes over (fx/fy, latticeFreed, siOPairs/siOCount,
  // sioMult, coolingMode) is stable across substeps; fx/fy are the same arrays, zeroed each
  // substep. Its own gate makes the hash's superset of neighbour pairs yield an identical set.
  const forcePair = (i, j) => {
    const pi = particles[i], pj = particles[j]
    const dx = miDx(pj.x - pi.x)
    if (dx > FORCE_CUTOFF || dx < -FORCE_CUTOFF) return
    const dy = miDy(pj.y - pi.y)
    if (dy > FORCE_CUTOFF || dy < -FORCE_CUTOFF) return
    const d2 = dx * dx + dy * dy
    if (d2 < 0.01) return
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
      // Coordination cap (Si ≤ 3 O, O ≤ 2 Si): a freed Si-O pair that isn't already
      // bonded gets no spring/attract if either side is full. Without this ~6 O pack
      // around each Si and the melt goes denser than the crystal.
      const siOSat = isSiOSpec && isFreedPair && !siOPairs.has(i * n + j) &&
        (siOCount[i] >= COORD_TARGET[pi.typeId] || siOCount[j] >= COORD_TARGET[pj.typeId])
      if (!siOSat && d < spec.r0 * effMult && (!effOneSided || d > spec.r0) && (!spec.repOnly || d < spec.r0)) {
        // Freed-freed: skip the attractive part for non-Si-O pairs while hot so dissolved
        // Na/Ca ions disperse. Gate on coolingMode so ions can re-bond during cooling.
        // Si-O is always exempt — freed Si must be able to re-bond with freed O.
        if (!(isFreedPair && d >= spec.r0 && !isSiOSpec && coolingMode === null)) {
          // Na-Na repulsion fades on cooling (naNaScale) so Na can cluster near the crystal.
          const naNaMul = (spec.repOnly && pi.typeId === 2 && pj.typeId === 2) ? naNaScale : 1
          const f = spec.k * (d - spec.r0) * naNaMul
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
      // Saturated pair: plain repulsion inside r0 so extra O can't pack in around a full Si.
      if (siOSat && d < spec.r0) {
        const f = spec.k * (d - spec.r0)   // negative → push apart
        fx[i] += f * nx;  fy[i] += f * ny
        fx[j] -= f * nx;  fy[j] -= f * ny
      }
      if (isSiOSpec && isFreedPair && !siOSat && _freeAttractSiOMult > 0 && d > spec.r0 * effMult && d < ATTRACT_RANGE) {
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

  // Hard-sphere collision resolution for one pair (body of the old O(n²) collision loop,
  // verbatim). Position-mutating Gauss-Seidel, like the sand solver — routing it through the
  // hash changes the sweep ORDER (so it diverges from the brute path the same way the sand
  // solver's own order affects it), but each pair is resolved identically for a given state.
  // Gate COLLIDE_CUTOFF (10) ≤ cell size (20), so the ±1 scan is a safe superset.
  const collidePair = (i, j) => {
    const pi = particles[i], pj = particles[j]
    const dx = miDx(pj.x - pi.x)
    if (dx > COLLIDE_CUTOFF || dx < -COLLIDE_CUTOFF) return
    const dy   = miDy(pj.y - pi.y)
    const minD = pi.r + pj.r
    const d2   = dx * dx + dy * dy
    if (d2 >= minD * minD || d2 < 1e-6) return
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

  // Freed-ion exclusion for one pair (body of the old O(n²) freed-excl loop, verbatim).
  // Only freed-freed pairs act; gate FORCE_CUTOFF (20) == cell size. Also position-mutating.
  const FREE_EXCL = 2.0   // exclusion = 2× contact radius (~10-11 px for Na+O)
  const freedExclPair = (i, j) => {
    if (!latticeFreed[i] || !latticeFreed[j]) return
    const pi = particles[i], pj = particles[j]
    const dx = miDx(pj.x - pi.x)
    if (dx > FORCE_CUTOFF || dx < -FORCE_CUTOFF) return
    const dy   = miDy(pj.y - pi.y)
    const isSiOPair = pi.typeId + pj.typeId === 1  // Si(0)+O(1) uniquely sums to 1
    let minD = (pi.r + pj.r) * (isSiOPair ? _sioExclMult : FREE_EXCL)
    // During cooling, opposite-charge modifier pairs (Na-O, Ca-O) may close to 0.9·r0 so
    // they can actually bond — FREE_EXCL alone puts Ca-O's floor (13.6px) past r0 (12px).
    if (isCooling && !isSiOPair) {
      const xs = PAIR_TABLE[pi.typeId][pj.typeId]
      if (xs && !xs.repOnly) minD = Math.min(minD, xs.r0 * 0.9)
    }
    const d2   = dx * dx + dy * dy
    if (d2 >= minD * minD || d2 < 1e-6) return
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

  for (let sub = 0; sub < SUBSTEPS; sub++) {
    fx.fill(0); fy.fill(0)
    if (motif) applyMotifForces(particles, motif, motifK, PREFERRED['O-Si'].r0, fx, fy)
    if (angleBendK > 0 && siOMap) applyAngleBend(particles, siOMap, angleBendK, fx, fy)

    // ── Na rejection (slow cool) ──────────────────────────────────
    // A growing silica crystal expels the Na modifier, which doesn't fit the hex lattice.
    // Each freed Na is pushed away from nearby ORDERED Si (motif-site Si) so it migrates to
    // grain boundaries while the hex rings form. The push RAMPS DOWN as the melt cools (full
    // near CRYST_LOCK, zero by ~500°C) so that once the Si crystal is built, Na is free to
    // drift back in and grab onto the crystal's edge O atoms — the structure tightens up as it
    // cools instead of Na being held off forever. Live-tunable via window._naRejectK / _naRejectRange.
    if (coolingMode === 'slow' && orderedSi && orderedSi.length) {
      const rejectRamp = Math.max(0, Math.min(1, (totalEnergy - 500) / (CRYST_LOCK - 500)))
      const kR    = (_win._naRejectK ?? 0.08) * rejectRamp
      const range = _win._naRejectRange ?? 26
      if (kR > 0) {
        for (let a = 0; a < n; a++) {
          const pa = particles[a]
          if (pa.typeId !== 2 || !latticeFreed[a]) continue   // freed Na only
          for (let s = 0; s < orderedSi.length; s++) {
            const j = orderedSi[s], pj = particles[j]
            const dx = miDx(pa.x - pj.x)
            if (dx > range || dx < -range) continue
            const dy = miDy(pa.y - pj.y)
            if (dy > range || dy < -range) continue
            const d2 = dx * dx + dy * dy
            if (d2 >= range * range || d2 < 1e-6) continue
            const d  = Math.sqrt(d2), nx = dx / d, ny = dy / d
            const f  = kR * (range - d) / range   // push Na out, equal-opposite on Si
            fx[a] += f * nx;  fy[a] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }

    // ── Na → crystal-O attraction (slow cool) ─────────────────────
    // Na⁺ is drawn to the negatively-charged O of the already-formed crystal (charge balance at
    // the non-bridging oxygens). This grows as the melt cools (zero near CRYST_LOCK, full by
    // ~500°C — the inverse of the rejection above), so once the Si hex is built Na migrates in
    // and decorates the crystal's O sites. Longer range than the plain Na-O spring so Na can
    // actually find the crystal. Live-tunable via window._naAttractK / window._naAttractRange.
    if (coolingMode === 'slow' && crystalO && crystalO.length) {
      const attrRamp = Math.max(0, Math.min(1, (CRYST_LOCK - totalEnergy) / (CRYST_LOCK - 500)))
      const kA    = (_win._naAttractK ?? 0.03) * attrRamp
      const rangeA = _win._naAttractRange ?? 32
      if (kA > 0) {
        for (let a = 0; a < n; a++) {
          const pa = particles[a]
          if (pa.typeId !== 2 || !latticeFreed[a]) continue   // freed Na only
          for (let s = 0; s < crystalO.length; s++) {
            const j = crystalO[s], pj = particles[j]
            const dx = miDx(pj.x - pa.x)   // toward the O
            if (dx > rangeA || dx < -rangeA) continue
            const dy = miDy(pj.y - pa.y)
            if (dy > rangeA || dy < -rangeA) continue
            const d2 = dx * dx + dy * dy
            if (d2 >= rangeA * rangeA || d2 < 1e-6) continue
            const d  = Math.sqrt(d2), nx = dx / d, ny = dy / d
            const f  = kA * (rangeA - d) / rangeA   // pull Na toward crystal O
            fx[a] += f * nx;  fy[a] += f * ny
            fx[j] -= f * nx;  fy[j] -= f * ny
          }
        }
      }
    }
    // Severance pull-off: the ion that severed a Si-O bond drags that bond's O out of the
    // network (Na⁺/Ca²⁺ grabbing a non-bridging O). Stops once they're at ion-O bond length.
    if (_sevPullK > 0 && phys.sevPulls?.size) {
      for (const [o, pull] of phys.sevPulls) {
        const po = particles[o], pk = particles[pull.ion]
        const dx = miDx(pk.x - po.x), dy = miDy(pk.y - po.y)
        const d  = Math.hypot(dx, dy)
        const spec = PAIR_TABLE[pk.typeId][1]
        if (!spec || d <= spec.r0 || d > ATTRACT_RANGE) continue
        const f = _sevPullK, nx = dx / d, ny = dy / d
        fx[o] += f * nx;  fy[o] += f * ny
        fx[pull.ion] -= f * nx;  fy[pull.ion] -= f * ny
      }
    }

    // ── Pairwise interaction forces ──────────────────────────────
    // Fast early-reject on single axis before computing full distance.
    // The per-pair body is `forcePair`, driven either by the O(n²) sweep or the spatial
    // hash (both visit each unordered pair once, i < j). The body keeps its own gate, so
    // the hash's superset of neighbour pairs yields an identical result set.
    if (_useMeltHash) eachMeltPair(particles, n, forcePair)
    else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) forcePair(i, j)

    // ── Intact rigid-bond restoring spring (above XPBD projection cutoff) ────
    // The pair spring only acts inside the capture range (r0·mult ≈ +3–7%), so an intact
    // bond stretched past it had NO restoring force and drifted apart while still "intact".
    // This spring extends the pair spring (same k × _bondStiffMult) out to any stretch, so an
    // intact bond is always pulled back toward r0 and only breaks when a fluctuation beats
    // effThreshold. Inside the capture range the pair spring already supplies 1×k.
    if (phys.rigidBonds) {
      for (const rb of phys.rigidBonds) {
        if (rb.broken || totalEnergy <= rb.projectionCutoff) continue
        const pi = particles[rb.i], pj = particles[rb.j]
        const spec = PAIR_TABLE[pi.typeId][pj.typeId]
        if (!spec) continue
        const r0e = rb.r0 * _coolBondScale   // "Longer cooled bonds" lengthens the rest length
        const dx = miDx(pj.x - pi.x), dy = miDy(pj.y - pi.y)
        const d  = Math.hypot(dx, dy)
        if (d <= r0e || d < 0.01) continue   // stretch only; compression handled by hard-sphere
        const stiff   = _bondStiffMult
        const capture = spec.r0 * _coolBondScale * (spec === PAIR_TABLE[0][1] ? sioMult : spec.mult)
        const kEff    = d < capture ? spec.k * Math.max(0, stiff - 1) : spec.k * stiff
        const f = kEff * (d - r0e)
        const nx = dx / d, ny = dy / d
        fx[rb.i] += f * nx;  fy[rb.i] += f * ny
        fx[rb.j] -= f * nx;  fy[rb.j] -= f * ny
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
        const r0e = rb.r0 * _coolBondScale   // "Longer cooled bonds" lengthens the rest length
        const dx = miDx(pj.x - pi.x), dy = miDy(pj.y - pi.y)
        const d  = Math.hypot(dx, dy)
        if (d < 0.01 || d > r0e * 3) continue
        const nx   = dx / d,       ny   = dy / d
        const half = (d - r0e) * 0.5
        pi.x += nx * half;  pi.y += ny * half
        pj.x -= nx * half;  pj.y -= ny * half
        const dvn = (pi.vx - pj.vx) * nx + (pi.vy - pj.vy) * ny
        const imp = dvn * 0.5
        pi.vx -= imp * nx;  pi.vy -= imp * ny
        pj.vx += imp * nx;  pj.vy += imp * ny
      }
    }

    // ── Elastic hard-sphere collision resolution ─────────────────
    if (_useMeltHash) eachMeltPair(particles, n, collidePair)
    else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) collidePair(i, j)

    // ── Freed-ion exclusion zone (XPBD position correction) ──────
    // Force-based springs can be overpowered at high velocities. Position
    // correction is unconditionally stable: freed ions are pushed apart
    // to minD = (r_i + r_j) * FREE_EXCL regardless of velocity or force.
    // Si-O uses _sioExclMult (default 1.4, tunable via dev slider) so that
    // freed Si-O can reach r0=9px and settle there (1.4×5.5=7.7px < r0=9px < capture=9.63px).
    // Values 1.5–1.7 place the floor inside the capture window but above r0, creating a
    // resonance band that inflates KE to ~3.8× target; values ≥1.8 exceed the capture radius.
    if (_useMeltHash) eachMeltPair(particles, n, freedExclPair)
    else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) freedExclPair(i, j)

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
      // Freed atoms use their own coupling: v_rms is τ-independent, but the distance an atom
      // travels before its direction is randomised scales ~1/τ.
      const DAMP_F            = 1 - _freedTau
      const kickSigmaF        = vTarget * Math.sqrt(_freedTau)
      for (let i = 0; i < n; i++) {
        const isFreed = latticeFreed[i]
        const rampFrames = phys.reintRampFrames?.[i] ?? 0
        const kickMult = rampFrames > 0
          ? _latticeSpeedMult + (rampFrames / REINT_RAMP_FRAMES) * (freedMultEff - _latticeSpeedMult)
          : (isFreed ? freedMultEff : _latticeSpeedMult)
        const baseSigma = isFreed ? kickSigmaF : (crystAnchor[i] || naAnchor[i]) ? kickSigmaCryst : kickSigma
        const damp      = isFreed ? DAMP_F : DAMP
        const ks = baseSigma * kickMult
        const u1 = Math.random() || 1e-10
        const r  = Math.sqrt(-2 * Math.log(u1)) * ks
        const a  = Math.random() * Math.PI * 2
        particles[i].vx = particles[i].vx * damp + r * Math.cos(a)
        particles[i].vy = particles[i].vy * damp + r * Math.sin(a)
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
  // Feedback fraction is computed PER bond population (Si-O vs Na-O/Ca-O). A single global
  // fBroken is diluted by the ~550 always-intact Si-O bonds below the projection cutoff, so a
  // Na-O break barely moves it and the Na-O threshold never rises — bonds creep forever.
  // Per-type fBroken lets each type's threshold respond to its own broken fraction and halt.
  let brokeSiO = 0, totSiO = 0, brokeMod = 0, totMod = 0
  if (phys.rigidBonds) {
    for (const rb of phys.rigidBonds) {
      if (!rb.breakable) continue
      if (rb.isSiO) { totSiO++; if (rb.broken) brokeSiO++ }
      else          { totMod++; if (rb.broken) brokeMod++ }
    }
  }
  const fBrokenSiO = totSiO > 0 ? brokeSiO / totSiO : 0
  const fBrokenMod = totMod > 0 ? brokeMod / totMod : 0
  const fBroken    = (brokeSiO + brokeMod) / Math.max(1, totSiO + totMod)   // HUD only
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
      const effThreshold = rb.breakStrain * (1 + GAIN * _feedbackGainMult * (rb.isSiO ? fBrokenSiO : fBrokenMod))
      rb.effThreshold = effThreshold
      if (!rb.broken) {
        strainSum += rb.avgStrain; thrSum += effThreshold; strainCount++
        if (rb.avgStrain > maxAvgStrain) maxAvgStrain = rb.avgStrain
      }
      const wasBroken = rb.broken
      if (!rb.broken) {
        if (rb.avgStrain > effThreshold) rb.broken = true
      } else {
        // No net bond formation above the crystallisation lock temperature during cooling —
        // keeps the melt mobile until it is cool enough to crystallise (see CRYST_LOCK).
        const allowReform = coolingMode === null || totalEnergy < CRYST_LOCK
        if (allowReform && strain <= _reformStrain && !(rb.severFrames > 0)) rb.broken = false
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
  // Runs during cooling, and at any hold below the Si-O melt cutoff. Without the latter, a hold
  // ratchets freed-atom count upward forever: every transient full-break frees an atom permanently
  // (latticeFreed is sticky) with no path back. The ≥N-bonds-for-M-frames test self-regulates —
  // genuinely molten atoms never hold N bonds that long, so they stay freed above the cutoff.
  // Re-integration (locking atoms into the solid) is gated to the crystallisation window: during
  // cooling it only fires below CRYST_LOCK, so atoms stay mobile above it and don't freeze the
  // scrambled melt layout at high T (the bug that made slow look like fast).
  const reintGate = coolingMode !== null ? CRYST_LOCK : sioProjCutoff(phys.sio2Pct ?? 70)
  const reintActive = totalEnergy < reintGate
  if (phys.latticeFreed && phys.rigidBonds && phys.stableBondFrames && reintActive) {
    const sbf = phys.stableBondFrames
    const rrf = phys.reintRampFrames
    for (let i = 0; i < n; i++) {
      if (rrf[i] > 0) rrf[i]--
      if (!phys.latticeFreed[i]) continue
      // Live bonds (rigid or dynamic) — rigid bonds only reform with original partners,
      // which are long gone after a melt, so intactCount alone never re-integrates anyone.
      // Slow cool demands FULL coordination before an atom locks (Si needs its 3rd O, not
      // just 2), so rings actually close into hexagons instead of freezing under-coordinated.
      // Other modes keep _reintBondN. Live-tunable via window._slowReintBondN.
      const reintN = coolingMode === 'slow' ? (_win._slowReintBondN ?? 3) : _reintBondN
      const need = Math.min(reintN, COORD_TARGET[particles[i].typeId])
      if (liveCount[i] >= need) {
        sbf[i]++
        if (sbf[i] >= _reintFrameM) {
          phys.latticeFreed[i] = 0
          sbf[i] = 0
          rrf[i] = REINT_RAMP_FRAMES
          const p = particles[i]
          p.x0 = p.x; p.y0 = p.y
          promoteBonds(phys, i)
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
        // Each freed modifier ion depolymerises only up to its coordination capacity (Na→1 O,
        // Ca→2). Once it holds that many O (liveCount), it's saturated and severs no more —
        // otherwise a few lingering ions eat an entire grain, creeping forever at a hold.
        if (liveCount[k] >= COORD_TARGET[pk.typeId]) continue
        if (Math.hypot(pk.x - pi.x, pk.y - pi.y) < _sevTriggerDist ||
            Math.hypot(pk.x - pj.x, pk.y - pj.y) < _sevTriggerDist) {
          rb.broken = true
          rb.severFrames = _sevCooldown
          rb.severIon = k
          const o = pi.typeId === 1 ? rb.i : rb.j
          if (!phys.sevPulls) phys.sevPulls = new Map()
          if (!phys.sevPulls.has(o)) phys.sevPulls.set(o, { ion: k, frames: _sevCooldown })
          sevFiresThisStep++
          break
        }
      }
    }
    // Cooldown: a severed bond can't reform while its ion is still within trigger distance;
    // once the ion leaves, it counts down _sevCooldown steps before reform is allowed.
    for (const rb of phys.rigidBonds) {
      if (!(rb.severFrames > 0)) continue
      const pk = particles[rb.severIon]
      const near = Math.hypot(miDx(pk.x - particles[rb.i].x), miDy(pk.y - particles[rb.i].y)) < _sevTriggerDist ||
                   Math.hypot(miDx(pk.x - particles[rb.j].x), miDy(pk.y - particles[rb.j].y)) < _sevTriggerDist
      if (near) rb.severFrames = _sevCooldown
      else rb.severFrames--
    }
  }
  if (phys.sevPulls) {
    for (const [o, pull] of phys.sevPulls) if (--pull.frames <= 0) phys.sevPulls.delete(o)
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
  // Dynamic soft bonds: opposite-charge pairs not already in rigidBonds.
  // Si-O candidates are accepted nearest-first under the coordination cap (Si ≤ 3, O ≤ 2,
  // counting intact rigid Si-O first) so the bond list never shows over-coordination.
  const sioCoord = new Int32Array(n)
  for (const b of bonds) {
    if (!b.broken && particles[b.i].typeId + particles[b.j].typeId === 1) { sioCoord[b.i]++; sioCoord[b.j]++ }
  }
  const sioCands = []
  // One candidate pair for the dynamic-bond scan (body of the old O(n²) loop, verbatim).
  // Gate is spec.r0·renderMult ≤ 15.6px (Na-O) < cell size 20, so the hash is a safe superset.
  // The result set is visitation-order-independent: Si-O candidates are sorted by distance
  // and accepted nearest-first below, and non-Si-O bonds are a set regardless of push order.
  const bondScanPair = (i, j) => {
    if (rigidPairSet.has(i * n + j)) return
    const pi = particles[i], pj = particles[j]
    const spec = PAIR_TABLE[pi.typeId][pj.typeId]
    if (!spec || spec.repOnly) return
    const isSiO      = spec === PAIR_TABLE[0][1]
    const effMult    = isSiO ? sioMult : spec.mult
    const renderMult = spec.viewMult ?? effMult
    const dx = miDx(pj.x - pi.x)
    if (dx > spec.r0 * renderMult || dx < -spec.r0 * renderMult) return
    const d = Math.hypot(dx, miDy(pj.y - pi.y))
    if (d > spec.r0 * renderMult) return
    const b = { i, j, strain: (d - spec.r0) / spec.r0, currentBreakStrain: 0.25, broken: false }
    if (isSiO) { b.d = d; sioCands.push(b) } else bonds.push(b)
  }
  if (_useMeltHash) eachMeltPair(particles, n, bondScanPair)
  else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) bondScanPair(i, j)
  sioCands.sort((a, b) => a.d - b.d)
  for (const b of sioCands) {
    if (sioCoord[b.i] >= COORD_TARGET[particles[b.i].typeId]) continue
    if (sioCoord[b.j] >= COORD_TARGET[particles[b.j].typeId]) continue
    sioCoord[b.i]++; sioCoord[b.j]++
    delete b.d
    bonds.push(b)
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
      bonds.push({ i, j, spec, strain: (d - spec.r0) / spec.r0, currentBreakStrain: effMult - 1, broken: false })
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

// ── Structure diagnostic ──────────────────────────────────────────────────────
// Call from browser console: meltStructure()
// Run at startup (crystal reference) and in the melt; a melt denser than the crystal
// shows up as higher Si coord / more close Si-Si pairs / higher local density.
export function meltStructure(phys) {
  if (!phys?.particles || !phys?.bonds) { console.warn('no phys'); return }
  const ps = phys.particles, n = ps.length
  const siSiR0 = PAIR_TABLE[0][0].r0
  const coord = new Int32Array(n)
  for (const b of phys.bonds) {
    if (b.broken) continue
    if (ps[b.i].typeId + ps[b.j].typeId === 1) { coord[b.i]++; coord[b.j]++ }
  }
  const si = [], o = []
  for (let i = 0; i < n; i++) {
    if (ps[i].typeId === 0) si.push(i)
    else if (ps[i].typeId === 1 && ps[i].cellType === 'SiO2') o.push(i)
  }
  if (!si.length) { console.warn('no Si'); return }
  const mean = arr => arr.reduce((s, i) => s + coord[i], 0) / (arr.length || 1)
  let close = 0, pairs = 0, nbrSum = 0, nnSum = 0
  for (const a of si) {
    let nn = Infinity
    for (let j = 0; j < n; j++) {
      if (j === a) continue
      const d = Math.hypot(miDx(ps[j].x - ps[a].x), miDy(ps[j].y - ps[a].y))
      if (d < 20) nbrSum++
      if (ps[j].typeId === 0) {
        if (d < nn) nn = d
        if (j > a) { pairs++; if (d < siSiR0) close++ }
      }
    }
    if (nn < Infinity) nnSum += nn
  }
  // Orientational order: |⟨e^{6iφ}⟩| over Si with exactly 3 O (φ = best-fit 3-fold angle).
  // ~1 = one shared crystal orientation (all grains start aligned), ~0 = random (amorphous).
  const siONbr = new Map()
  for (const b of phys.bonds) {
    if (b.broken || ps[b.i].typeId + ps[b.j].typeId !== 1) continue
    const [s, o] = ps[b.i].typeId === 0 ? [b.i, b.j] : [b.j, b.i]
    if (!siONbr.has(s)) siONbr.set(s, []); siONbr.get(s).push(o)
  }
  let oc = 0, os = 0, on = 0, angErr = 0
  for (const [s, nb] of siONbr) {
    if (nb.length !== 3) continue
    const ang = nb.map(o => Math.atan2(miDy(ps[o].y - ps[s].y), miDx(ps[o].x - ps[s].x)))
    const phi = fitPhi(ang)
    oc += Math.cos(6 * phi); os += Math.sin(6 * phi); on++
    for (const a of ang) { const e = wrapPi(3 * (a - phi)) / 3; angErr += e * e }
  }
  // Local order: mean cos(6Δφ) between 3-coordinated Si that share an O (domain coherence).
  const phiOf = new Map()
  for (const [s, nb] of siONbr) {
    if (nb.length === 3) phiOf.set(s, fitPhi(nb.map(o => Math.atan2(miDy(ps[o].y - ps[s].y), miDx(ps[o].x - ps[s].x)))))
  }
  const oToSi = new Map()
  for (const [s, nb] of siONbr) for (const o of nb) { if (!oToSi.has(o)) oToSi.set(o, []); oToSi.get(o).push(s) }
  let loc = 0, locN = 0
  for (const ss of oToSi.values()) {
    if (ss.length !== 2 || !phiOf.has(ss[0]) || !phiOf.has(ss[1])) continue
    loc += Math.cos(6 * (phiOf.get(ss[0]) - phiOf.get(ss[1]))); locN++
  }
  const T = phys.dbg?.totalEnergy ?? '—'
  const row = {
    'T target °C':            T,
    'Si count':               si.length,
    'mean Si coord (O)':      +mean(si).toFixed(2),
    'mean O coord (Si)':      +mean(o).toFixed(2),
    '% Si with >3 O':         +(100 * si.filter(i => coord[i] > 3).length / si.length).toFixed(1),
    '% Si with <3 O':         +(100 * si.filter(i => coord[i] < 3).length / si.length).toFixed(1),
    'Si-Si pairs < r0':       close,
    'mean Si-Si nearest px':  +(nnSum / si.length).toFixed(2),
    'atoms within 20px / Si': +(nbrSum / si.length).toFixed(2),
    'hex order ψ6 (0–1)':     on ? +(Math.hypot(oc, os) / on).toFixed(2) : '—',
    'local order (0–1)':      locN ? +(loc / locN).toFixed(2) : '—',
    'O-Si-O rms err °':       on ? +(Math.sqrt(angErr / (3 * on)) * 180 / Math.PI).toFixed(1) : '—',
    'Si-Si rep r0 px':        siSiR0,
    'Si-O r0 px':             PREFERRED['O-Si'].r0,
    'motif k':                +(phys.motifK ?? 0).toExponential(2),
  }
  console.table(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { value: v }])))
  return row
}
