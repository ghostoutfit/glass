import { useRef, useEffect, useMemo } from 'react'

const VW     = 600
const VH     = 372
const HALF   = VW / 2
const PAD    = 10
const A      = 18
const ATOM_H = VH - 22
const LBL_Y  = VH - 7

const C = {
  Si: '#d4a020', O: '#cc3a3a', Na: '#4aaa60', Ca: '#4a96be',
  bg: '#1a1a1e', bond: '#7a6060', lbl: '#aaa', strip: '#111',
}

function makeRand(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000 }
}

function seededShuffle(arr, rand) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// How many of each modifier ion to display (visually scaled down from real molar ratio)
function modCounts(nSi, na2o, cao, sio2) {
  if (sio2 === 0) return { nNa: 0, nCa: 0 }
  return {
    nNa: Math.round(nSi * 2 * na2o / sio2 * 0.15),
    nCa: Math.round(nSi *     cao / sio2 * 0.15),
  }
}

// ── Crystalline panel ──────────────────────────────────────────────────────
// Si at honeycomb vertices, O bridging each edge.
// Na⁺ at ring centers; Ca²⁺ replaces the bridging O on vertical inter-ring bonds.
function makeCrystal(bx, by, bw, bh, na2o, cao, sio2) {
  const a    = A
  const x0   = bx + PAD, y0 = by + PAD
  const a1x  = a * Math.sqrt(3)
  const a2x  = a * Math.sqrt(3) / 2, a2y = a * 1.5
  const bDx  = a * Math.sqrt(3) / 2, bDy = a * 0.5
  const ni   = Math.ceil(bw / a1x) + 2
  const nj   = Math.ceil(bh / a2y) + 2

  // Si atoms
  const seen = new Set(), si = []
  for (let i = -1; i <= ni; i++) {
    for (let j = -1; j <= nj; j++) {
      for (const [dx, dy] of [[0, 0], [bDx, bDy]]) {
        const x = x0 + i * a1x + j * a2x + dx
        const y = y0 + j * a2y + dy
        if (x < bx || x > bx + bw || y < by || y > by + bh) continue
        const key = `${Math.round(x * 4)},${Math.round(y * 4)}`
        if (seen.has(key)) continue
        seen.add(key); si.push({ x, y })
      }
    }
  }

  // Bridging O atoms; track vertical bonds (Ca²⁺ candidates)
  const nnSq = (a * 1.05) ** 2
  const o = [], bonds = [], caoCandIdx = []
  for (let i = 0; i < si.length; i++) {
    for (let j = i + 1; j < si.length; j++) {
      const dx = si[j].x - si[i].x, dy = si[j].y - si[i].y
      if (dx * dx + dy * dy >= nnSq) continue
      const k = o.length
      o.push({ x: (si[i].x + si[j].x) / 2, y: (si[i].y + si[j].y) / 2, si1: i, si2: j })
      bonds.push({ x1: si[i].x, y1: si[i].y, x2: si[j].x, y2: si[j].y })
      if (Math.abs(dx) < 0.5) caoCandIdx.push(k)  // vertical bond → Ca²⁺ site
    }
  }

  // Ring centers (Na⁺ positions): C(n1,n2) = n1·a1 + n2·a2 + (bDx, −bDy)
  const ringCenters = []
  for (let n1 = -1; n1 <= ni + 1; n1++) {
    for (let n2 = -1; n2 <= nj + 1; n2++) {
      const cx = x0 + n1 * a1x + n2 * a2x + bDx
      const cy = y0 + n2 * a2y - bDy
      if (cx < bx + PAD * 2 || cx > bx + bw - PAD * 2) continue
      if (cy < by + PAD * 2 || cy > by + bh - PAD * 2) continue
      ringCenters.push({ x: cx, y: cy })
    }
  }

  const { nNa, nCa } = modCounts(si.length, na2o, cao, sio2)
  const r1 = makeRand(31), r2 = makeRand(97)

  // Select Ca²⁺ sites (remove those bridging O; Ca²⁺ bonds directly to flanking Si)
  const caSiteIdxs = seededShuffle(caoCandIdx, r2).slice(0, nCa)
  const removedO   = new Set(caSiteIdxs)

  const naIons  = seededShuffle(ringCenters, r1).slice(0, nNa)
  const caIons  = caSiteIdxs.map(k => ({ x: o[k].x, y: o[k].y }))

  // Ion bonds: Na⁺ → nearest remaining O; Ca²⁺ → its two Si atoms
  const ionBonds = []
  for (const na of naIons) {
    let best = null, bestD = Infinity
    for (let k = 0; k < o.length; k++) {
      if (removedO.has(k)) continue
      const d = Math.hypot(o[k].x - na.x, o[k].y - na.y)
      if (d < bestD) { bestD = d; best = o[k] }
    }
    if (best) ionBonds.push({ x1: na.x, y1: na.y, x2: best.x, y2: best.y })
  }
  for (let k = 0; k < caSiteIdxs.length; k++) {
    const site = o[caSiteIdxs[k]]
    ionBonds.push(
      { x1: caIons[k].x, y1: caIons[k].y, x2: si[site.si1].x, y2: si[site.si1].y },
      { x1: caIons[k].x, y1: caIons[k].y, x2: si[site.si2].x, y2: si[site.si2].y },
    )
  }

  return {
    si,
    o:        o.filter((_, k) => !removedO.has(k)),
    bonds:    bonds.filter((_, k) => !removedO.has(k)),
    naIons, caIons, ionBonds,
  }
}

// ── Amorphous panel ────────────────────────────────────────────────────────
// Si placed by random sequential addition; O by greedy nearest-3 bonding.
// Modifier ions hang off selected O atoms, perpendicular to the Si-O-Si bond.
function makeAmorphous(bx, by, bw, bh, seed, na2o, cao, sio2) {
  const rand = makeRand(seed)
  const a    = A
  const x0   = bx + PAD, y0 = by + PAD
  const w    = bw - 2 * PAD, h = bh - 2 * PAD
  const minD = a * 0.68

  const density = 2 / (1.5 * a * a * Math.sqrt(3))
  const target  = Math.round(density * w * h)
  const si = []
  let tries = 0
  while (si.length < target && tries < 60000) {
    tries++
    const x = x0 + rand() * w, y = y0 + rand() * h
    let ok = true
    for (const s of si) {
      if (Math.hypot(s.x - x, s.y - y) < minD) { ok = false; break }
    }
    if (ok) si.push({ x, y })
  }

  const minSq = (minD * 0.99) ** 2, maxSq = (a * 1.9) ** 2
  const cands = []
  for (let i = 0; i < si.length; i++) {
    for (let j = i + 1; j < si.length; j++) {
      const dx = si[j].x - si[i].x, dy = si[j].y - si[i].y
      const dSq = dx * dx + dy * dy
      if (dSq > minSq && dSq < maxSq) cands.push({ i, j, dSq })
    }
  }
  cands.sort((a, b) => a.dSq - b.dSq)

  const conn = new Array(si.length).fill(0)
  const o = [], bonds = []
  for (const { i, j } of cands) {
    if (conn[i] < 3 && conn[j] < 3) {
      conn[i]++; conn[j]++
      o.push({ x: (si[i].x + si[j].x) / 2, y: (si[i].y + si[j].y) / 2, si1: i, si2: j })
      bonds.push({ x1: si[i].x, y1: si[i].y, x2: si[j].x, y2: si[j].y })
    }
  }

  const { nNa, nCa } = modCounts(si.length, na2o, cao, sio2)
  const r2 = makeRand(seed + 111)
  const order = seededShuffle([...Array(o.length).keys()], r2)

  const naIons = [], caIons = [], ionBonds = []
  let ptr = 0

  function placeNearO(list, n, r) {
    for (let placed = 0; placed < n && ptr < order.length; ptr++) {
      const oa  = o[order[ptr]]
      const s1  = si[oa.si1], s2 = si[oa.si2]
      const len = Math.hypot(s2.x - s1.x, s2.y - s1.y)
      const px  = -(s2.y - s1.y) / len
      const py  =  (s2.x - s1.x) / len
      const flip = r() < 0.5 ? 1 : -1
      const ix   = oa.x + flip * px * 13
      const iy   = oa.y + flip * py * 13
      if (ix < bx + 4 || ix > bx + bw - 4 || iy < by + 4 || iy > by + bh - 4) continue
      list.push({ x: ix, y: iy })
      ionBonds.push({ x1: ix, y1: iy, x2: oa.x, y2: oa.y })
      placed++
    }
  }

  placeNearO(naIons, nNa, r2)
  placeNearO(caIons, nCa, r2)

  return { si, o, bonds, naIons, caIons, ionBonds }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function drawNet(ctx, net, labelX, label) {
  ctx.strokeStyle = C.bond
  ctx.lineWidth = 1.5
  for (const b of [...net.bonds, ...net.ionBonds]) {
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke()
  }
  ctx.fillStyle = C.O
  for (const o of net.o) { ctx.beginPath(); ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2); ctx.fill() }
  ctx.fillStyle = C.Si
  for (const s of net.si) { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill() }
  ctx.fillStyle = C.Na
  for (const n of net.naIons) { ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, Math.PI * 2); ctx.fill() }
  ctx.fillStyle = C.Ca
  for (const c of net.caIons) { ctx.beginPath(); ctx.arc(c.x, c.y, 6.5, 0, Math.PI * 2); ctx.fill() }
  ctx.fillStyle = C.lbl
  ctx.font = '13px system-ui'
  ctx.textAlign = 'center'
  ctx.fillText(label, labelX, LBL_Y)
}

// ── Component ──────────────────────────────────────────────────────────────
export default function NetworksView({ sio2Pct = 100, na2oPct = 0, caoPct = 0 }) {
  const canvasRef = useRef(null)

  const { crystal, amorphous } = useMemo(() => ({
    crystal:   makeCrystal(0,    0, HALF, ATOM_H, na2oPct, caoPct, sio2Pct),
    amorphous: makeAmorphous(HALF, 0, HALF, ATOM_H, 73821, na2oPct, caoPct, sio2Pct),
  }), [sio2Pct, na2oPct, caoPct])

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d')
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, VW, VH)
    ctx.fillStyle = C.strip; ctx.fillRect(0, ATOM_H, VW, VH - ATOM_H)
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(HALF, 0); ctx.lineTo(HALF, VH); ctx.stroke()
    drawNet(ctx, crystal,   HALF / 2,        'Crystalline SiO₂')
    drawNet(ctx, amorphous, HALF + HALF / 2,  'Amorphous SiO₂ (Glass)')
  }, [crystal, amorphous])

  return (
    <canvas ref={canvasRef} width={VW} height={VH}
      style={{ display: 'block', maxWidth: '100%', margin: '0 auto' }} />
  )
}
