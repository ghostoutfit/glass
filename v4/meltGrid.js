// Grain-grid layout for the melt tab — atom placement by composition. Extracted from
// CompositionView so the dev candidate-state generator (Node) can import it too.

const VW      = 600
const VH_GRID = 350
const COLS    = 5
const ROWS    = 4
const CELL_W  = VW / COLS       // 120
const CELL_H  = VH_GRID / ROWS  // 87.5

// SI_A is derived from sioR0 at call time (SI_A = 2 * sioR0)
const NA_A = 24   // Na-O bond: O at midpoints = 12px = r0_NaO
const CA_A = 24   // Ca-O bond: O at midpoints = 12px = r0_CaO

const GRAIN_MARGIN = 5

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

export function buildGrid(sio2Pct, na2oPct, caoPct) {
  const total = COLS * ROWS
  const nSio2 = Math.round(sio2Pct / 100 * total)
  const nNa2o = Math.round(na2oPct / 100 * total)
  const nCao  = Math.max(0, total - nSio2 - nNa2o)

  const types = [
    ...Array(nSio2).fill('SiO2'),
    ...Array(nNa2o).fill('Na2O'),
    ...Array(nCao).fill('CaO'),
  ]
  while (types.length < total) types.push('SiO2')
  while (types.length > total) types.pop()

  const rand = makeRand(sio2Pct * 10000 + na2oPct * 100 + caoPct)
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[types[i], types[j]] = [types[j], types[i]]
  }
  declumpGrid(types, rand)
  return types
}

// Count orthogonally-adjacent cell pairs that share a grain type.
function likeAdjacency(types) {
  let c = 0
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const t = types[r * COLS + col]
      if (col + 1 < COLS && types[r * COLS + col + 1] === t) c++
      if (r + 1 < ROWS && types[(r + 1) * COLS + col] === t) c++
    }
  }
  return c
}

// Up to 3 SiO2↔Na2O swaps, each the one that most reduces like-type adjacency.
// Ties broken by the seeded rand so the layout is stable per composition.
function declumpGrid(types, rand, maxSwaps = 3) {
  for (let s = 0; s < maxSwaps; s++) {
    const base = likeAdjacency(types)
    let best = 0, bestPairs = []
    for (let a = 0; a < types.length; a++) {
      if (types[a] !== 'SiO2') continue
      for (let b = 0; b < types.length; b++) {
        if (types[b] !== 'Na2O') continue
        types[a] = 'Na2O'; types[b] = 'SiO2'
        const gain = base - likeAdjacency(types)
        types[a] = 'SiO2'; types[b] = 'Na2O'
        if (gain > best) { best = gain; bestPairs = [[a, b]] }
        else if (gain === best && gain > 0) bestPairs.push([a, b])
      }
    }
    if (best <= 0) break
    const [a, b] = bestPairs[Math.floor(rand() * bestPairs.length)]
    types[a] = 'Na2O'; types[b] = 'SiO2'
  }
}

// ── Per-species hex lattice placement ────────────────────────────────────────
// Each cation type gets its own honeycomb lattice scaled so O midpoints land at r0:
//   Si: a = 2*sioR0  →  O at sioR0 from Si  =  r0_SiO  (zero initial spring force)
//   Na: a = NA_A=32  →  O at 16px from Na   =  r0_NaO
//   Ca: a = CA_A=24  →  O at 12px from Ca   =  r0_CaO
//
// GRAIN_MARGIN: atoms are inset from every chunk boundary by this many pixels so
// no atom from chunk A is within the attractive cutoff of any atom from chunk B.
// This gives each chunk an isolated "grain of sand" at startup.
// O atoms are only placed between same-chunk cation pairs (no cross-chunk bridges).
function buildHexLayer(a, chunkFilter, types, cationType, catRadius) {
  const a1x = a * Math.sqrt(3), a2x = a * Math.sqrt(3) / 2, a2y = a * 1.5
  const bDx = a * Math.sqrt(3) / 2, bDy = a * 0.5
  const ni = Math.ceil(VW      / a1x) + 2
  const nj = Math.ceil(VH_GRID / a2y) + 2
  // The hex lattice shears right by j*a2x (= j*a1x/2) per row, so cells in the
  // lower-left need negative i down to about -nj/2. Starting at i=-1 left the
  // bottom-left SiO₂ chunks empty/sparse; begin far enough left to cover the
  // shear. Out-of-range points are clipped by the x/y bounds and `seen` below.
  const iStart = -Math.ceil(nj / 2) - 1
  const cats = [], seen = new Set()
  for (let i = iStart; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      for (const [dx, dy] of [[0, 0], [bDx, bDy]]) {
        const x = i * a1x + j * a2x + dx, y = j * a2y + dy
        if (x < 0 || x >= VW || y < 0 || y >= VH_GRID) continue
        const col      = Math.min(COLS - 1, Math.floor(x / CELL_W))
        const row      = Math.min(ROWS - 1, Math.floor(y / CELL_H))
        const chunkIdx = row * COLS + col
        if (types[chunkIdx] !== chunkFilter) continue
        // Reject atoms within GRAIN_MARGIN of any chunk boundary (grain isolation)
        const cellL = col * CELL_W, cellR = (col + 1) * CELL_W
        const cellT = row * CELL_H, cellB = (row + 1) * CELL_H
        if (x - cellL < GRAIN_MARGIN || cellR - x < GRAIN_MARGIN) continue
        if (y - cellT < GRAIN_MARGIN || cellB - y < GRAIN_MARGIN) continue
        const key = `${Math.round(x * 4)},${Math.round(y * 4)}`
        if (seen.has(key)) continue
        seen.add(key)
        cats.push({ x, y, type: cationType, r: catRadius, chunkIdx })
      }
    }
  }
  const nnSq = (a * 1.05) ** 2
  const oAtoms = []
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      if (cats[i].chunkIdx !== cats[j].chunkIdx) continue  // no cross-chunk O bridges
      const dx = cats[j].x - cats[i].x, dy = cats[j].y - cats[i].y
      if (dx * dx + dy * dy >= nnSq) continue
      const ox = (cats[i].x + cats[j].x) / 2, oy = (cats[i].y + cats[j].y) / 2
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(ox / CELL_W)))
      const row = Math.min(ROWS - 1, Math.max(0, Math.floor(oy / CELL_H)))
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.3, chunkIdx: row * COLS + col })
    }
  }
  return { cats, oAtoms }
}

// Orthogonal (square) lattice for modifier oxides (Na₂O, CaO).
// Cations sit on an a×a square grid; O atoms bridge every horizontal and vertical
// nearest-neighbor pair at the midpoint.  nnSq with 1.05× factor rejects diagonals
// (√2·a ≈ 1.414a >> 1.05a) so only the 4 axis-aligned bonds are bridged.
function buildSquareLayer(a, chunkFilter, types, cationType, catRadius) {
  const ni = Math.ceil(VW      / a) + 2
  const nj = Math.ceil(VH_GRID / a) + 2
  const cats = [], seen = new Set()
  for (let i = -1; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      const x = i * a, y = j * a
      if (x < 0 || x >= VW || y < 0 || y >= VH_GRID) continue
      const col      = Math.min(COLS - 1, Math.floor(x / CELL_W))
      const row      = Math.min(ROWS - 1, Math.floor(y / CELL_H))
      const chunkIdx = row * COLS + col
      if (types[chunkIdx] !== chunkFilter) continue
      const cellL = col * CELL_W, cellR = (col + 1) * CELL_W
      const cellT = row * CELL_H, cellB = (row + 1) * CELL_H
      if (x - cellL < GRAIN_MARGIN || cellR - x < GRAIN_MARGIN) continue
      if (y - cellT < GRAIN_MARGIN || cellB - y < GRAIN_MARGIN) continue
      const key = `${Math.round(x * 4)},${Math.round(y * 4)}`
      if (seen.has(key)) continue
      seen.add(key)
      cats.push({ x, y, type: cationType, r: catRadius, chunkIdx })
    }
  }
  const nnSq = (a * 1.05) ** 2
  const oAtoms = []
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      if (cats[i].chunkIdx !== cats[j].chunkIdx) continue
      const dx = cats[j].x - cats[i].x, dy = cats[j].y - cats[i].y
      if (dx * dx + dy * dy >= nnSq) continue
      const ox = (cats[i].x + cats[j].x) / 2, oy = (cats[i].y + cats[j].y) / 2
      const col = Math.min(COLS - 1, Math.max(0, Math.floor(ox / CELL_W)))
      const row = Math.min(ROWS - 1, Math.max(0, Math.floor(oy / CELL_H)))
      oAtoms.push({ x: ox, y: oy, type: 'O', r: 2.3, chunkIdx: row * COLS + col })
    }
  }
  return { cats, oAtoms }
}

export function buildAllAtoms(types, sioR0) {
  const siA = 2 * sioR0   // Si-Si spacing so O midpoints land at exactly sioR0 from Si
  const si  = buildHexLayer(siA,  'SiO2', types, 'Si', 3.2)
  const na  = buildSquareLayer(NA_A, 'Na2O', types, 'Na', 3.6)
  const ca  = buildSquareLayer(CA_A, 'CaO',  types, 'Ca', 4.5)
  return [...si.cats, ...na.cats, ...ca.cats, ...si.oAtoms, ...na.oAtoms, ...ca.oAtoms]
}
