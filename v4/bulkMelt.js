// Bulk-tab melt progression — the ONE implementation shared by the live Bulk loop (GlassViewer),
// the in-app candidate generator, and scripts/gen-candidates.mjs (which used to carry its own copy
// of all this and drifted). Node-safe: no DOM; window overrides are read only if window exists.
import {
  initSandParticles, mergeSodaGrains, mergeSilicateGrains, convertLargeNaGrains,
  absorbNearbyGrains, stepNaBlobSprings, stepSandPhysics, checkNaBlobMerges, snapshotSand,
} from './sandPhysics.js'
import { FIXED_DT } from './glassPhysics.js'

const _win = () => (typeof window !== 'undefined' ? window : {})

// ── The Particles heating curve ───────────────────────────────────────────────────────────────
// Measured in the app (High Na₂O, Fast + Slow Heat, 2 runs each, averaged): the Particles tab's
// broken-bond fraction fBroken(T), normalised by its value at the end of heating (1800 °C), so
// 0 = intact solid, 1 = as melted as the particle view gets. Bulk melts to exactly this progress, so
// the two tabs agree by construction. Re-measure after retuning the particle melt
// (scratchpad fbcurve.mjs → fBroken samples, binned per 50 °C).
export const PARTICLE_MELT_CURVE = [
  // [°C, progress 0–1] — measured 2026-10-26, v95 particle physics. Fast vs Slow Heat agree to ±0.05.
  [500, 0], [550, 0], [600, 0.006], [650, 0.014], [700, 0.033], [750, 0.042], [800, 0.06],
  [850, 0.087], [900, 0.12], [950, 0.165], [1000, 0.208], [1050, 0.248], [1100, 0.296],
  [1150, 0.368], [1200, 0.444], [1250, 0.542], [1300, 0.657], [1350, 0.723], [1400, 0.765],
  [1450, 0.798], [1500, 0.829], [1550, 0.859], [1600, 0.879], [1650, 0.909], [1700, 0.935],
  [1750, 0.957], [1800, 1],   // end of heating = fully melted (measured 0.96–0.98; Bulk finishes clean)
]
export const PARTICLE_FB_END = 0.41   // measured fBroken at the end of heating (1800 °C, avg of 4 runs) — the curve's 100 %
let _bulkLead = 0   // °C: + = Bulk runs that far AHEAD of the particle curve, − = behind. Dev panel.
export const setBulkMeltLead = v => { _bulkLead = v }
export const getBulkMeltLead = () => _bulkLead
export function particleMeltProgress(T) {
  const c = PARTICLE_MELT_CURVE
  if (T <= c[0][0]) return c[0][1]
  for (let k = 1; k < c.length; k++) {
    if (T <= c[k][0]) { const [t0, p0] = c[k - 1], [t1, p1] = c[k]; return p0 + (p1 - p0) * (T - t0) / (t1 - t0) }
  }
  return c[c.length - 1][1]
}

// Macro melt progress (0–1): share of the original grains no longer free — merged together or
// absorbed into the melt blob. Reaches exactly 1 when every grain is in the melt (the old metric,
// orbs ÷ original grains, topped out at ~0.74 because merges consume grains, so its "100%" target
// was unreachable and the meld ran flat out from ~1300 °C).
export function macroMeltFrac(phys) {
  if (!phys?.sandParticles || !phys.nGrainOriginal) return 0
  let free = 0
  for (const g of phys.sandParticles) if (g.type === 'sand' || g.type === 'na' || g.type === 'silicate') free++
  return 1 - free / phys.nGrainOriginal
}
// Target macro melt at temperature T = the particle curve (shifted by the lead). Melt is driven
// TOWARD this and then holds, so a paused temperature keeps a fixed, matched melt degree. The top
// of the curve means "everything": past 99.5 % the target is 1 so no last grains linger.
export function macroMeltTarget(T) {
  const p = particleMeltProgress(T + _bulkLead)
  return p >= 0.995 ? 1 : p
}

// One frame of the irreversible Na₂O melting (grain merging + absorption). `temp` is the drive
// temperature the merge chain runs at (MELT_DRIVE_TEMP: its own 700/1000/1200 °C gates would
// otherwise stall it); `realTemp` sets the Na-merge rate. HOW MUCH melts is decided by the caller's
// macroMeltTarget gate. `probMult` lets the generator / catch-up take coarse steps (one pass
// standing in for `probMult` live frames, with the per-call caps scaled to match).
export const MELT_DRIVE_TEMP = 1500
export function meldSandFrame(phys, temp, isSoda, probMult = 1, realTemp = temp) {
  if (!(isSoda && phys.sandParticles && phys.nNaOriginal > 0)) return
  // White Na₂O grain merging follows the particle curve at the REAL temperature (not the drive
  // temp — at that, every touching Na pair merged the instant melting began).
  const tempFactor = Math.min(1, particleMeltProgress(realTemp + _bulkLead) * 1.5)
  const meldFrac   = Math.min(1, phys.meldCount / phys.nNaOriginal)
  const meldProb   = Math.min(1, tempFactor * 0.015 * (1 + meldFrac * 5) * (_win()._naMeldMult ?? 1) * probMult)
  const cap = Math.max(1, Math.round(probMult))
  if (meldProb > 0) phys.meldCount += mergeSodaGrains(phys.sandParticles, meldProb)
  convertLargeNaGrains(phys.sandParticles, phys.naBlobs, cap)
  absorbNearbyGrains(phys.sandParticles, phys.naBlobs, temp, cap)
  const siFactor  = Math.max(0, Math.min(1, (temp - 1000) / 200))
  const silFactor = Math.max(0, Math.min(1, (temp - 1200) / 200))
  mergeSilicateGrains(phys.sandParticles, Math.min(1, siFactor * 0.004 * probMult), Math.min(1, silFactor * 0.004 * probMult), Math.max(3, Math.round(3 * probMult)))
}

// ── Candidate states ──────────────────────────────────────────────────────────────────────────
// Benchmark temperatures with a precomputed melted state (bundled in candidates.generated.js).
// Macro melt is irreversible, so these are a HEATING track, each melted to macroMeltTarget(T).
// Cooling reuses the peak-temperature snapshot (only rigidity / look change on cooling).
export const BULK_BENCH_TEMPS = [25, 700, 850, 1000, 1150, 1300, 1450, 1600]
export const GEN_MELD_K = 20   // coarse meld during generation
// Resumable generator so the in-app version can be time-boxed across frames.
export function makeBulkGenState(HS, na2o, nGrains, multiRadius = true) {
  const phys = { sandParticles: initSandParticles(HS, multiRadius, na2o, nGrains), naBlobs: [], blobMct: {}, meldCount: 0 }
  phys.nNaOriginal    = phys.sandParticles.filter(g => g.type === 'na').length
  phys.nGrainOriginal = phys.sandParticles.length
  for (let i = 0; i < 20; i++) stepSandPhysics(phys.sandParticles, FIXED_DT, HS, 0)
  return { phys, HS, na2o, benchIdx: 0, frame: 0, out: [], done: false }
}
// Advance for up to budgetMs (Infinity = to completion); snapshots each benchmark once its melt
// goal is reached OR the melt saturates (stall detection, so a goal can never hang it).
export function stepBulkGen(G, budgetMs = 60) {
  const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + budgetMs
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  while (!G.done && now() < deadline) {
    const T = BULK_BENCH_TEMPS[G.benchIdx]
    const goal = G.na2o > 0 ? macroMeltTarget(T) : 0
    const frac = macroMeltFrac(G.phys)
    if (frac > (G.benchBest ?? -1) + 0.002) { G.benchBest = frac; G.benchStall = 0 }
    else G.benchStall = (G.benchStall ?? 0) + 1
    if (frac >= goal || G.benchStall > 150) {
      for (let i = 0; i < 12; i++) stepSandPhysics(G.phys.sandParticles, FIXED_DT, G.HS, 0)
      G.out.push({ temp: T, melt: +frac.toFixed(3), snap: snapshotSand(G.phys) })
      G.benchBest = -1; G.benchStall = 0
      if (++G.benchIdx >= BULK_BENCH_TEMPS.length) G.done = true
      continue
    }
    meldSandFrame(G.phys, MELT_DRIVE_TEMP, G.na2o > 0, GEN_MELD_K, T)
    if (G.frame % 6 === 0) {
      stepNaBlobSprings(G.phys.naBlobs, FIXED_DT, 0, T)
      stepSandPhysics(G.phys.sandParticles, FIXED_DT, G.HS, 0, G.phys.naBlobs)
      checkNaBlobMerges(G.phys.naBlobs, G.phys.blobMct, G.phys.sandParticles, T)
    }
    G.frame++
  }
  return G.benchIdx / BULK_BENCH_TEMPS.length   // progress 0..1
}
export function pickBulkCandidate(cands, temp) {
  let best = cands[0]
  for (const c of cands) if (c.temp <= temp && c.temp >= best.temp) best = c
  return best
}
