/**
 * Component ablation and baseline-parity test on the FROZEN cohort.
 *
 * Responds to the review points that (a) the baselines are handicapped because
 * they are scored on the three-coordinate efficiency triplet while the proposed
 * score uses six coordinates plus category fit, confidence and trust, and
 * (b) the prior ablation conflated the below-threshold deficit factor with
 *     the above-threshold frontier reward.
 *
 * Frozen state: the registry revision and the 2026-10-08 headline payload used
 * by experiments/frontier_evaluation.js, so the "Full pipeline" row here is comparable
 * to the Proposed row of the manuscript's validation table.
 *
 * The proposed-score ablations separate the below-threshold deficit multiplier
 * from the frontier reward. Matched WSM/TOPSIS variants apply the production
 * quality multiplier to the same six-coordinate baseline score. The shared
 * factor is reported both as deficit-only and, for frontier, deficit plus reward.
 *
 * Run: node experiments/matched_penalty_comparison.js
 */
import '../src/engine/env.js'
import { readRegistry } from '../src/engine/registry-store.js'
import { taskQuality, capabilityFit, sourceTrustFactor, computeFinalScore } from '../src/engine/scoring.js'
import { computeBenchmarkBounds, evaluateModelCapabilities } from '../src/engine/benchmarks.js'
import { qualityFactor } from '../src/quality_penalty.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { pinnedIntent } from './pinned-intents.js'

const PROMPTS = { frontier: 'best frontier coding models', budget: 'budget coding models', balanced: 'balanced coding models' }
const BUDGETS = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0]
const MEAN = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const norm = (s) => String(s).replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]/gi, '').toLowerCase()
const strip = (s) => String(s).replace(/^[^:]+:\s*/, '').trim()
const EFFORT = (n) => (/max/i.test(n) ? 3 : /xhigh/i.test(n) ? 2 : /high/i.test(n) ? 1 : 0)

function spearman(x, y) {
  const rank = (v) => {
    const idx = v.map((val, i) => [val, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length)
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1 }
    return r
  }
  const rx = rank(x), ry = rank(y), mx = MEAN(rx), my = MEAN(ry)
  let n = 0, dx = 0, dy = 0
  for (let i = 0; i < rx.length; i++) { n += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2 }
  return n / Math.sqrt(dx * dy)
}
function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function topsis(X, w) {
  const wSum = w.reduce((a, b) => a + b, 0) || 1
  const nrm = X[0].map((_, j) => Math.sqrt(X.reduce((t, r) => t + r[j] * r[j], 0)))
  const V = X.map((r) => r.map((v, j) => (v / (nrm[j] || 1)) * (w[j] / wSum)))
  const best = X[0].map((_, j) => Math.max(...V.map((r) => r[j])))
  const worst = X[0].map((_, j) => Math.min(...V.map((r) => r[j])))
  return V.map((r) => {
    const dp = Math.sqrt(r.reduce((t, v, j) => t + (v - best[j]) ** 2, 0))
    const dm = Math.sqrt(r.reduce((t, v, j) => t + (v - worst[j]) ** 2, 0))
    return dm / (dp + dm || 1)
  })
}

// ── the shipped score, with independently switchable components ─────────────
const MIN_SCORE = 0.08
const softCeiling = (s) => (s <= 86 ? s : 86 + 13.4 * (1 - Math.exp(-(s - 86) / 13.4)))

function qualityFactors(q, archetype, { deficitOff = false, rewardOff = false } = {}) {
  let deficit = 1
  let reward = 1
  if (archetype === 'frontier') {
    if (q < 0.92 && !deficitOff) deficit = qualityFactor(q, archetype)
    if (q >= 0.92 && !rewardOff) reward = qualityFactor(q, archetype)
  } else if (q < 0.70 && !deficitOff) {
    deficit = qualityFactor(q, archetype)
  }
  return { deficit, reward, combined: deficit * reward }
}

function score(model, targetCategory, weights, opts, off = {}) {
  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0)
  if (weightSum <= 0) return MIN_SCORE * 100
  const keys = Object.keys(weights)
  const metricOf = (k) => Math.max(model.metrics?.[k] ?? MIN_SCORE, MIN_SCORE)
  const inner = keys.reduce((sum, k) => sum + weights[k] * Math.sqrt(metricOf(k)), 0) / weightSum
  const metricScore = off.linear ? inner ** 2 : inner ** 2   // power mean both ways; see below
  const metricLinear = keys.reduce((s, k) => s + weights[k] * metricOf(k), 0) / weightSum
  const base = off.linear ? metricLinear : metricScore
  const fit = off.fit ? 1 : Math.pow(capabilityFit(model, targetCategory), 1.2)
  const confidence = model.confidence ?? 0.8
  const conf = off.confidence ? 1 : 1.0 - 0.20 * Math.pow(1 - confidence, 2)
  const trust = off.trust ? 1 : sourceTrustFactor(model)
  let scaled = base * fit * conf * trust * 100
  const q = model.metrics?.quality ?? 0
  const factors = qualityFactors(q, opts.archetype || (opts.qualityFlagged ? 'frontier' : ''), {
    deficitOff: off.deficit,
    rewardOff: off.reward,
  })
  scaled *= factors.combined
  if (off.bonus) { /* specialist bonus disabled */ } else if (opts.isCoding && targetCategory === 'general') {
    const isCodeSpecialist = model.caps?.isCodeSpecialist || (model.secondaryUseCases || []).includes('code') || model.category === 'code'
    const isReasoning = model.caps?.isReasoning
    const hasTools = model.caps?.hasTools
    if (isCodeSpecialist || isReasoning) scaled *= (1 + (isCodeSpecialist ? 0.04 : 0) + (isReasoning ? 0.03 : 0) + (hasTools ? 0.02 : 0))
    else if (q < 0.95) scaled *= 0.92
  }
  return off.ceiling ? Math.max(1, scaled) : Math.max(1, softCeiling(scaled))
}

// ── cohort (identical to experiments/frontier_evaluation.js) ────────────────
const reg = await readRegistry()
const bounds = computeBenchmarkBounds(reg.models)
const regIdx = new Map()
for (const m of reg.models) {
  if (m.aliasOf) continue
  for (const key of [norm(m.name), norm(strip(m.name))]) {
    if (!regIdx.has(key)) regIdx.set(key, [])
    regIdx.get(key).push(m)
  }
}
const snap = JSON.parse(readFileSync('data/permitted_frozen_inputs/arena_snapshot_2026-10-08.json', 'utf8'))
const rows = Array.isArray(snap) ? snap : snap.models
const groups = new Map()
for (const a of rows) {
  const key = norm(a.model)
  const hits = regIdx.get(key) || regIdx.get(norm(strip(a.model)))
  if (!hits || !hits.length) continue
  const m = hits[0]
  const g = groups.get(m.id) || { model: m, rows: [] }
  g.rows.push(a); groups.set(m.id, g)
}
const cohort = []
for (const { model, rows: rs } of groups.values()) {
  rs.sort((a, b) => EFFORT(b.model) - EFFORT(a.model))
  const pick = rs[0]
  const net = pick.net_pct ?? pick.net ?? pick.score_pct
  if (net == null || !Number.isFinite(net)) continue
  const caps = evaluateModelCapabilities(model, bounds)
  const e = { ...model, caps, metrics: { ...model.metrics } }
  for (const k of ['quality', 'speed', 'privacy']) if (!Number.isFinite(e.metrics[k])) e.metrics[k] = caps[k]
  cohort.push({
    name: strip(model.name), net, cost: pick.median_usd, raw: e,
    q: taskQuality(e, ['general', 'code']), a: e.metrics.affordability, s: e.metrics.speed,
    ctx: e.metrics.context ?? MIN_SCORE, priv: e.metrics.privacy ?? MIN_SCORE, avail: e.metrics.availability ?? MIN_SCORE,
  })
}
const priced = cohort.filter((c) => Number.isFinite(c.cost))
const net = cohort.map((c) => c.net)

const out = {
  cohort: cohort.length,
  priced: priced.length,
  design: {
    baselines: 'six benefit-oriented normalized coordinates and the same pinned intent weights as the proposed score',
    matchedPenalty: 'baseline raw score multiplied by the production archetype-specific quality-deficit factor before ranking',
    frontierReward: 'reported separately; an additional combined-factor variant applies both deficit and frontier reward',
    tiers: BUDGETS,
    outcome: 'Agent Arena headline net-improvement; six equally weighted nested budget tiers',
  },
  panels: {},
}
console.log(`FROZEN cohort: ${cohort.length} models, ${priced.length} priced`)

// Faithfulness check: the reimplementation with every component ON must agree
// with the shipped computeFinalScore().exact to floating-point noise.
{
  let maxd = 0
  for (const prompt of Object.values(PROMPTS)) {
    const { analysis } = await pinnedIntent(prompt)
    const opts = { archetype: analysis.archetype, isCoding: Boolean(analysis.isCoding), qualityFlagged: analysis.archetype === 'frontier' }
    for (const c of cohort) {
      const model = { ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }
      const mine = score(model, analysis.targetCategory, analysis.weights, opts)
      const theirs = computeFinalScore(model, analysis.targetCategory, analysis.weights, opts).exact
      maxd = Math.max(maxd, Math.abs(mine - theirs))
    }
  }
  console.log(`reimplementation vs computeFinalScore: max abs diff ${maxd.toExponential(2)}`)
  if (maxd > 1e-9) { console.log('ABORT: reimplementation is not faithful'); process.exit(1) }
}

for (const [arch, prompt] of Object.entries(PROMPTS)) {
  const { analysis } = await pinnedIntent(prompt)
  const w = analysis.weights, category = analysis.targetCategory
  const opts = { archetype: analysis.archetype, isCoding: Boolean(analysis.isCoding), qualityFlagged: analysis.archetype === 'frontier' }
  const W6 = Object.values(w)
  const NW6 = W6.map((v) => v / (W6.reduce((a, b) => a + b, 0) || 1))
  const K = Object.keys(w)
  const X6 = cohort.map((c) => [c.q, c.a, c.s, c.ctx, c.priv, c.avail])
  const qualityAdjusted = (scores, kind) => scores.map((s, i) => {
    const factors = qualityFactors(cohort[i].q, arch)
    return s * (kind === 'deficit' ? factors.deficit : factors.combined)
  })
  const wsm6 = cohort.map((c) => K.reduce((t, k, i) => t + NW6[i] * [c.q, c.a, c.s, c.ctx, c.priv, c.avail][i], 0))
  const topsis6 = topsis(X6, W6)

  const variants = {
    'Full pipeline (shipped)': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts)),
    'minus quality-deficit penalty (reward retained)': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { deficit: true })),
    'minus frontier reward (deficit retained)': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { reward: true })),
    'minus deficit and frontier reward': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { deficit: true, reward: true })),
    'minus confidence discount': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { confidence: true })),
    'minus category fit': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { fit: true })),
    'minus source trust': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { trust: true })),
    'minus specialist bonus': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { bonus: true })),
    'linear aggregator': cohort.map((c) => score({ ...c.raw, metrics: { ...c.raw.metrics, quality: c.q } }, category, w, opts, { linear: true })),
    // baselines given the SAME six coordinates and the SAME weights
    'WSM (6 coords)': wsm6,
    'WSM + deficit penalty': qualityAdjusted(wsm6, 'deficit'),
    'WSM + deficit and frontier reward': qualityAdjusted(wsm6, 'combined'),
    'TOPSIS (6 coords)': topsis6,
    'TOPSIS + deficit penalty': qualityAdjusted(topsis6, 'deficit'),
    'TOPSIS + deficit and frontier reward': qualityAdjusted(topsis6, 'combined'),
    'Cobb-Douglas (6 coords)': cohort.map((c) => K.reduce((t, k, i) => t * Math.pow(Math.max([c.q, c.a, c.s, c.ctx, c.priv, c.avail][i], 0.05), NW6[i]), 1)),
    'CES only (6 coords)': cohort.map((c) => { const r = K.reduce((t, k, i) => t + NW6[i] * Math.sqrt([c.q, c.a, c.s, c.ctx, c.priv, c.avail][i]), 0); return r * r }),
    // the baselines as the manuscript actually runs them (triplet only)
    'WSM (triplet)': cohort.map((c) => { const t = [w.quality, w.affordability, w.speed]; const s = t[0] + t[1] + t[2] || 1; return (t[0] * c.q + t[1] * c.a + t[2] * c.s) / s }),
    'CES only (triplet)': cohort.map((c) => { const t = [w.quality, w.affordability, w.speed]; const s = t[0] + t[1] + t[2] || 1; const r = t[0] * Math.sqrt(c.q) / s + t[1] * Math.sqrt(c.a) / s + t[2] * Math.sqrt(c.s) / s; return r * r }),
  }

  const keys = Object.keys(variants)
  const rowsOut = []
  const pickedByMethod = {}
  for (const k of keys) {
    const v = variants[k]
    let regSum = 0, worst = -Infinity, hits = 0, tiers = 0, pickedNets = [], oracleNets = []
    const pickedIndices = []
    for (const B of BUDGETS) {
      const elig = cohort.map((c, i) => i).filter((i) => Number.isFinite(cohort[i].cost) && cohort[i].cost <= B)
      if (elig.length < 3) continue
      const oracle = Math.max(...elig.map((i) => net[i]))
      let best = -Infinity, pick = elig[0]
      for (const i of elig) if (v[i] > best) { best = v[i]; pick = i }
      const r = oracle - net[pick]
      regSum += r; if (r > worst) worst = r; if (r <= 1e-9) hits++; tiers++
      pickedNets.push(net[pick]); oracleNets.push(oracle)
      pickedIndices.push(pick)
    }
    const topIdx = (x) => x.map((val, i) => [val, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((p) => p[1])
    const outTop = new Set(topIdx(net))
    const top3 = topIdx(v).filter((i) => outTop.has(i)).length
    rowsOut.push({ method: k, mean_regret: +(regSum / tiers).toFixed(3), worst: +worst.toFixed(3), value_captured: +(MEAN(pickedNets) / MEAN(oracleNets)).toFixed(3), oracle_hits: `${hits}/${tiers}`, spearman: +spearman(v, net).toFixed(3), top3: `${top3}/3` })
    pickedByMethod[k] = pickedIndices
  }
  for (const row of rowsOut) {
    let ref = 'Full pipeline (shipped)'
    if (row.method.startsWith('WSM +')) ref = 'WSM (6 coords)'
    if (row.method.startsWith('TOPSIS +')) ref = 'TOPSIS (6 coords)'
    row.pick_comparison_reference = ref
    row.changed_pick_tiers = pickedByMethod[row.method].filter((pick, i) => pick !== pickedByMethod[ref][i]).length
  }
  // Paired model bootstrap: resample the same model indices for every method,
  // recompute each tier oracle, then store regret differences vs the full score.
  const REPS = 2000
  const random = mulberry32(20261020)
  const deltaBoot = Object.fromEntries(keys.map((k) => [k, []]))
  for (let rep = 0; rep < REPS; rep++) {
    const idx = Array.from({ length: cohort.length }, () => Math.floor(random() * cohort.length))
    const methodRegs = Object.fromEntries(keys.map((k) => [k, []]))
    for (const B of BUDGETS) {
      const eligible = idx.map((source, pos) => ({ source, pos })).filter(({ source }) => Number.isFinite(cohort[source].cost) && cohort[source].cost <= B)
      if (eligible.length < 3) continue
      const oracle = Math.max(...eligible.map(({ source }) => net[source]))
      for (const k of keys) {
        const v = variants[k]
        let pick = eligible[0].source, best = -Infinity
        for (const { source, pos } of eligible) {
          if (v[source] > best) { best = v[source]; pick = source }
        }
        methodRegs[k].push(oracle - net[pick])
      }
    }
    const fullRegret = MEAN(methodRegs['Full pipeline (shipped)'])
    for (const k of keys) deltaBoot[k].push(MEAN(methodRegs[k]) - fullRegret)
  }
  const quantile = (values, p) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
  }
  for (const row of rowsOut) {
    row.delta_regret_vs_full = +(row.mean_regret - rowsOut[0].mean_regret).toFixed(3)
    row.paired_delta_ci_vs_full = [
      +quantile(deltaBoot[row.method], 0.025).toFixed(3),
      +quantile(deltaBoot[row.method], 0.975).toFixed(3),
    ]
  }
  out.bootstrap = { reps: REPS, seed: 20261020, unit: 'models; paired across methods; tier oracle recomputed in each resample' }
  console.log(`\n===== ${arch.toUpperCase()}  weights ${JSON.stringify(w)}`)
  console.log('method                                       mean   worst  value  hits   rho  top3  pickΔ  delta[95% CI]')
  for (const r of rowsOut) {
    console.log(`  ${r.method.padEnd(42)} ${String(r.mean_regret).padStart(6)} ${String(r.worst).padStart(6)} ${String(r.value_captured).padStart(6)} ${r.oracle_hits.padStart(5)} ${String(r.spearman).padStart(6)} ${r.top3.padEnd(4)} ${String(r.changed_pick_tiers).padStart(5)} [${r.paired_delta_ci_vs_full.join(', ')}]`)
  }
  out.panels[arch] = { weights: w, rows: rowsOut }
}

writeFileSync('scratch/ablation_components.json', JSON.stringify(out, null, 1))
console.log('\nwrote scratch/ablation_components.json')
