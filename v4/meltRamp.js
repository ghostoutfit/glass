// Particles-tab temperature ramps (heat capacity, energy content, cooling latent-heat curve) —
// shared by CompositionView (the live ramps + graph) and meltTrack.js (the background catch-up
// worker), so both drive the physics along the same temperature path. Node/worker-safe.
import { ENERGY_UNIT } from './meltPhysics.js'
import { T as GT } from './glassTemps.js'
const _win = () => (typeof window !== 'undefined' ? window : {})

export const FAST_COOL_FRAMES = 270   // ~4.5 s at simSpeed 1
export const SLOW_COOL_FRAMES = 1440  // ~24 s at simSpeed 1
export const BASE_STEPS_PER_SEC = 60  // sim steps per second at simSpeed 1 (simSpeed scales this)

const HC_LO = 500, HC_HI = 750
export function heatCap(T, na2oPct, plateau) {
  const amp = (plateau - 1) * Math.min(1, na2oPct / 30)
  if (amp <= 0 || T <= HC_LO) return 1
  const t = Math.min(1, (T - HC_LO) / (HC_HI - HC_LO))
  return 1 + amp * t * t * (3 - 2 * t)
}
export function energyContent(T, na2oPct, plateau) {   // per-particle units
  let c = 0
  for (let x = 5; x <= T; x += 5) c += heatCap(x, na2oPct, plateau) * 5
  return c * ENERGY_UNIT
}
// Inverse: temperature whose content equals `target`. Lets ramps interpolate linearly in
// ENERGY (content) instead of temperature, so the kJ readout changes at a constant rate
// through the latent-heat plateau — independent of temperature or bonds breaking.
export function tempForContent(target, na2oPct, plateau) {
  if (target <= 0) return 0
  let c = 0
  for (let x = 5; x <= 2000; x += 5) { c += heatCap(x, na2oPct, plateau) * 5 * ENERGY_UNIT; if (c >= target) return x }
  return 2000
}

// ── Cooling heat capacity (distinct from heating — different physics) ──────────
// On cooling the substance RELEASES latent heat where bonds form, which on the T-vs-energy
// graph is a shallower slope (less temperature drop per unit energy removed). Shape, matching
// what's on screen:
//   • T > 1100: no bonds forming yet → low heat capacity → STEEP (fast temp drop per energy)
//   • 500–1100: bonds forming, lenses fading pink→white → high heat capacity → SHALLOW shelf
//   • T < 500:  solid, energy just leaves the kinetic bucket → low heat capacity → STEEP again
// Slow cool finds more/better bonds, so it releases MORE latent heat → an even taller hump
// (even shallower shelf) than fast. Live-tunable via window._coolLatentSlow / _coolLatentFast.
const COOL_BAND_LO = GT.LATENT_LO, COOL_BAND_HI = GT.CRYST_LOCK, COOL_BAND_W = 60
// The latent-heat shelf scales with Na₂O exactly like heating's heatCap (× min(1, na2o/30)), so
// pure SiO₂ — no bonds break or form — has a flat curve and cools straight back down the heating line.
export function coolHeatCap(T, slow, na2oPct = 30) {
  const amp = 1 + ((slow ? (_win()._coolLatentSlow ?? 7) : (_win()._coolLatentFast ?? 3)) - 1) * Math.min(1, na2oPct / 30)
  const ss = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u) }
  const band = ss(COOL_BAND_LO - COOL_BAND_W, COOL_BAND_LO + COOL_BAND_W, T) *
               (1 - ss(COOL_BAND_HI - COOL_BAND_W, COOL_BAND_HI + COOL_BAND_W, T))
  return 1 + (amp - 1) * band
}
export function coolEnergyContent(T, slow, na2oPct) {
  let c = 0
  for (let x = 5; x <= T; x += 5) c += coolHeatCap(x, slow, na2oPct) * 5
  return c * ENERGY_UNIT
}
export function coolTempForContent(target, slow, na2oPct) {
  if (target <= 0) return 0
  let c = 0
  for (let x = 5; x <= 2000; x += 5) { c += coolHeatCap(x, slow, na2oPct) * 5 * ENERGY_UNIT; if (c >= target) return x }
  return 2000
}
// Ramp ePerParticle so that energy CONTENT moves linearly from the start temp to endTemp.
export function rampEnergyLinearInContent(startE, endTemp, t, na2oPct, plateau) {
  const Tstart = startE / ENERGY_UNIT - 273
  const cStart = energyContent(Math.max(0, Tstart), na2oPct, plateau)
  const cEnd   = energyContent(endTemp, na2oPct, plateau)
  const T = tempForContent(cStart * (1 - t) + cEnd * t, na2oPct, plateau)
  return (T + 273) * ENERGY_UNIT
}
