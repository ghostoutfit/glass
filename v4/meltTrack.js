// Particles-tab catch-up: precomputed states along the standard runs + an exact catch-up from the
// nearest one. Runs in a Web Worker (meltTrackWorker.js) so the page never stalls; node-safe too.
//
// Why: while the Bulk tab is showing, the Particles physics is frozen (its temperature ramp keeps
// going). On return, the particle state must be the one the run WOULD have reached at the current
// temperature — not the frozen state drifting visibly to catch up. The worker walks the physics
// along the three standard runs once at page load (Fast Heat to 1800, then Fast Cool and Slow Cool
// from 1800), keeping a full snapshot every TRACK_EVERY steps. A catch-up restores the closest
// state at/behind the target (that snapshot, or the frozen state if it's closer) and runs the few
// remaining steps with the same driver the live ramps use (meltRamp.js).
import { initPhysics, buildRigidBondMap, stepPhysics, setCoolBondScale, ENERGY_UNIT } from './meltPhysics.js'
import { buildGrid, buildAllAtoms } from './meltGrid.js'
import { heatCap, energyContent, coolEnergyContent, coolTempForContent, FAST_COOL_FRAMES, SLOW_COOL_FRAMES, BASE_STEPS_PER_SEC } from './meltRamp.js'

export const TRACK_EVERY = 40   // steps between stored states → a catch-up runs at most this many
const HEAT_POWER  = 200          // °C·heat-capacity per wall-second at Fast Heat (GlassViewer baseRate × input 100%)
const T_START     = 100          // page-load / Reset temperature
const T_TOP       = 1800         // heating ceiling = where the standard cool runs start

// ── Full state snapshot ───────────────────────────────────────────────────────────────────────
// Every phys field that evolves (generic, so new physics state is captured automatically), minus
// static structure, per-frame scratch and the main thread's measurement-only bookkeeping.
const NOT_STATE = new Set(['particles', 'chunks', 'n', 'fx', 'fy', 'dbg', 'unitBonds', 'sio2Pct',
  'everBroken', 'wasIntact', 'currentIntact', 'lifetimeTotal', 'lifetimeBreaks', 'totalEnergyAdded',
  'cumulativeKE', 'chunkDissolved', 'dissolveFrozen'])
const cloneVal = v => {
  if (v == null || typeof v !== 'object') return v
  if (ArrayBuffer.isView(v)) return v.slice()
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? { ...x } : x))
  if (v instanceof Set) return new Set(v)
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, x && typeof x === 'object' ? { ...x } : x]))
  return { ...v }
}
export function snapshotFull(phys, coolBondScale = 1) {
  const P = phys.particles, n = P.length, pos = new Float64Array(n * 8)
  for (let i = 0; i < n; i++) {
    const p = P[i], o = i * 8
    pos[o] = p.x0; pos[o + 1] = p.y0; pos[o + 2] = p.x; pos[o + 3] = p.y
    pos[o + 4] = p.px; pos[o + 5] = p.py; pos[o + 6] = p.vx; pos[o + 7] = p.vy
  }
  const f = {}
  for (const k of Object.keys(phys)) if (!NOT_STATE.has(k)) f[k] = cloneVal(phys[k])
  return { n, pos, f, coolBondScale }
}
// Restore into an existing phys of the same composition. Run-state keys missing from the snapshot
// (e.g. cooling-only fields when restoring a heating state) are removed.
export function restoreFull(phys, snap) {
  const P = phys.particles
  for (let i = 0; i < P.length && i < snap.n; i++) {
    const p = P[i], o = i * 8, a = snap.pos
    p.x0 = a[o]; p.y0 = a[o + 1]; p.x = a[o + 2]; p.y = a[o + 3]
    p.px = a[o + 4]; p.py = a[o + 5]; p.vx = a[o + 6]; p.vy = a[o + 7]
  }
  for (const k of Object.keys(phys)) if (!NOT_STATE.has(k) && !(k in snap.f)) delete phys[k]
  for (const k of Object.keys(snap.f)) phys[k] = cloneVal(snap.f[k])
}

// ── Building the same physics the Particles tab builds ────────────────────────────────────────
export function buildMeltPhys({ sio2, na2o, cao, sioR0 = 9, startTemp = T_START }) {
  const types = buildGrid(sio2, na2o, cao), atoms = buildAllAtoms(types, sioR0)
  const cellData = types.map((type, idx) => ({ idx, type, atoms: atoms.filter(a => a.chunkIdx === idx), bonds: [], pts: null, bg: '', bdr: '' }))
  const phys = initPhysics(cellData)
  phys.sio2Pct = sio2
  for (let s = 0; s < 5; s++) stepPhysics(phys, 1 * ENERGY_UNIT)
  buildRigidBondMap(phys)
  const eWarm = (startTemp + 273) * ENERGY_UNIT
  for (let s = 0; s < 20; s++) stepPhysics(phys, eWarm)
  setCoolBondScale(1)
  return phys
}

// ── Run drivers: one sim step at a time, same target path as CompositionView's live ramps ─────
// P = { na2o, plateau, speed, heatLeadSteps, attractK, speedMult, attractFalloff, longerBonds }
// Heating (cm null): the shared-temperature integrator at Fast Heat power, advanced per sim step;
// the physics target includes the heat lead (same integration as CompositionView).
function heatLead(T0, P) {
  if (!(P.heatLeadSteps > 0)) return 0
  let T = T0, budget = HEAT_POWER * P.heatLeadSteps / Math.max(1e-6, BASE_STEPS_PER_SEC * P.speed)
  while (budget > 1e-6 && T < T_TOP) { const h = heatCap(T, P.na2o, P.plateau); const dT = Math.min(5, budget / h); T += dT; budget -= dT * h }
  return T - T0
}
export function heatStep(phys, st, P) {      // st = { T }
  const physT = Math.min(T_TOP, st.T + heatLead(st.T, P))
  setCoolBondScale(1)
  stepPhysics(phys, (physT + 273) * ENERGY_UNIT, 1.0, P.attractK, null, P.speedMult, P.attractFalloff)
  const dTperStep = HEAT_POWER / (BASE_STEPS_PER_SEC * P.speed)          // °C·hc per sim step
  st.T = Math.min(T_TOP, st.T + dTperStep / heatCap(st.T, P.na2o, P.plateau))
}
// Cooling (cm 'fast' | 'slow') from T_TOP: frame f → temperature through the cooling latent-heat
// curve (CompositionView's formula), "longer cooled bonds" latch included.
export function coolTempAt(f, kind, P, Tstart = T_TOP) {
  const slow = kind === 'slow', dur = slow ? SLOW_COOL_FRAMES : FAST_COOL_FRAMES
  const t = Math.min(1, f / dur)
  const eTop = energyContent(Tstart, P.na2o, P.plateau), cTop = coolEnergyContent(Tstart, slow, P.na2o)
  const scale = cTop > 0 ? eTop / cTop : 1
  return coolTempForContent(eTop * (1 - t) / scale, slow, P.na2o)
}
export function coolStep(phys, st, kind, P) {   // st = { f }
  st.f++
  const T = coolTempAt(st.f, kind, P)
  setCoolBondScale(P.longerBonds ? 1 + 0.1 * Math.max(0, Math.min(1, (T_TOP - T) / 300)) : 1)
  stepPhysics(phys, (T + 273) * ENERGY_UNIT, 1.0, P.attractK, kind, P.speedMult, P.attractFalloff)
  st.T = T
}
// First cooling frame at or below temperature T (the live run may have started below 1800; the
// state is matched by temperature on the standard run).
export function coolFrameForTemp(T, kind, P) {
  const dur = kind === 'slow' ? SLOW_COOL_FRAMES : FAST_COOL_FRAMES
  for (let f = 0; f <= dur; f++) if (coolTempAt(f, kind, P) <= T) return f
  return dur
}

// ── Track generation (resumable, so the worker can answer requests between chunks) ────────────
// tracks = { heat: [{T, snap}], fast: [{f, T, snap}], slow: [...] }
export function makeTrackGen(comp, P) {
  const phys = buildMeltPhys(comp)
  return { comp, P, phys, stage: 'heat', st: { T: T_START }, steps: 0, top: null,
           tracks: { heat: [{ T: T_START, snap: snapshotFull(phys, 1) }], fast: [], slow: [] }, done: false }
}
export function stepTrackGen(G, maxSteps = 20) {
  for (let k = 0; k < maxSteps && !G.done; k++) {
    if (G.stage === 'heat') {
      heatStep(G.phys, G.st, G.P); G.steps++
      if (G.steps % TRACK_EVERY === 0 || G.st.T >= T_TOP) G.tracks.heat.push({ T: G.st.T, snap: snapshotFull(G.phys, 1) })
      if (G.st.T >= T_TOP) { G.top = G.tracks.heat[G.tracks.heat.length - 1].snap; G.stage = 'fast'; startCool(G) }
    } else {
      const kind = G.stage, dur = kind === 'slow' ? SLOW_COOL_FRAMES : FAST_COOL_FRAMES
      coolStep(G.phys, G.st, kind, G.P)
      const scale = G.P.longerBonds ? 1 + 0.1 * Math.max(0, Math.min(1, (T_TOP - G.st.T) / 300)) : 1
      if (G.st.f % TRACK_EVERY === 0 || G.st.f >= dur) G.tracks[kind].push({ f: G.st.f, T: G.st.T, snap: snapshotFull(G.phys, scale) })
      if (G.st.f >= dur) { if (kind === 'fast') { G.stage = 'slow'; startCool(G) } else G.done = true }
    }
  }
  return G.done
}
function startCool(G) {
  restoreFull(G.phys, G.top)
  G.st = { f: 0, T: T_TOP }
  G.tracks[G.stage].push({ f: 0, T: T_TOP, snap: G.top })
}
// Is the track far enough along to serve this request?
export function trackCovers(G, req) {
  if (req.kind === 'heat') return G.stage !== 'heat' || G.st.T >= req.T
  if (G.stage === 'heat') return false
  if (req.kind === 'fast') return G.stage !== 'fast' || G.st.T <= req.T
  return G.done || (G.stage === 'slow' && G.st.T <= req.T)
}

// ── Catch-up ───────────────────────────────────────────────────────────────────────────────────
// req = { kind: 'heat'|'fast'|'slow', T, frozen?: { kind, T, snap } }. Picks the closest start at or
// behind the target — a stored track state, or the frozen state if it's on the same run and nearer
// — then steps to the target with the matching driver. Returns { snap, from, steps }.
export function runCatchup(G, req) {
  const { kind, T, frozen } = req, P = G.P, phys = G.phys
  if (kind === 'heat') {
    let best = null
    for (const c of G.tracks.heat) if (c.T <= T && (!best || c.T > best.T)) best = c
    let start = best ? { T: best.T, snap: best.snap, from: 'track' } : null
    if (frozen && frozen.kind === 'heat' && frozen.T <= T && (!start || frozen.T > start.T)) start = { T: frozen.T, snap: frozen.snap, from: 'frozen' }
    if (!start) return null
    restoreFull(phys, start.snap)
    const st = { T: start.T }; let steps = 0
    while (st.T < T - 0.5 && steps < 5000) { heatStep(phys, st, P); steps++ }
    return { snap: snapshotFull(phys, 1), from: start.from, steps }
  }
  const fTarget = coolFrameForTemp(T, kind, P)
  let best = null
  for (const c of G.tracks[kind]) if (c.f <= fTarget && (!best || c.f > best.f)) best = c
  let start = best ? { f: best.f, snap: best.snap, from: 'track' } : null
  if (frozen && frozen.kind === kind) {
    const ff = coolFrameForTemp(frozen.T, kind, P)
    if (ff <= fTarget && (!start || ff > start.f)) start = { f: ff, snap: frozen.snap, from: 'frozen' }
  }
  if (!start) return null
  restoreFull(phys, start.snap)
  const st = { f: start.f, T: coolTempAt(start.f, kind, P) }; let steps = 0
  while (st.f < fTarget) { coolStep(phys, st, kind, P); steps++ }
  const scale = P.longerBonds ? 1 + 0.1 * Math.max(0, Math.min(1, (T_TOP - st.T) / 300)) : 1
  return { snap: snapshotFull(phys, scale), from: start.from, steps }
}
