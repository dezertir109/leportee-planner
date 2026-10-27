/* Le Portée Hotel Upgrade Finder: static, no dependencies, no trackers.
 *
 * The arithmetic mirrors the research dashboard's /planner page (mishka-research):
 *   effect here   = archetype effect, shifted along its quantile curve to the property's
 *                   position on the score scale (basics fade as the score rises)
 *   the bundle    = free items first, then best score-per-€ (capex + 3 years of opex)
 *                   while the capex budget lasts
 *   the total     = (Σ effects + k × facility-count slope) × out-of-sample calibration,
 *                   capped at the archetype's median→top-decile facility gap
 *   rate uplift   = only A/B-graded rate effects, same calibration, capped likewise
 * Data, per country: data/<cc>.model.json (effects, costs, distributions) + data/<cc>.json
 * (lean hotel layer), loaded when its chip is picked.
 */
"use strict";

const UNLOCK_HASH = "ee3bb2f52127383f8930e82f7502b9c41c9a2fe647b9ed6dbfc7a6c0b3aee6d8";
const SUB_URL = "https://www.leportee.com/subscribe";
const EMBED_URL = "https://www.leportee.com/embed";
// Each country is its own study (own facility list, price bands, archetypes), so each has its
// own model file; nothing is pooled across borders.
const COUNTRIES = [
  { cc: "de", name: "Germany", adj: "German", eg: "Gasthof zur Post" },
  { cc: "fr", name: "France", adj: "French", eg: "Hôtel de la Gare" },
  { cc: "es", name: "Spain", adj: "Spanish", eg: "Hostal Central" },
  { cc: "it", name: "Italy", adj: "Italian", eg: "Albergo Roma" },
  { cc: "at", name: "Austria", adj: "Austrian", eg: "Gasthof Post" },
];
let C = COUNTRIES[0];
const BUY = new Set(["in_room", "property", "service", "policy"]);
const KIND_LABEL = { in_room: "per room", property: "build", service: "service",
  policy: "policy", listing: "tick the box" };
const RADII = [10, 25];
const MIN_PEERS = 8;

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = "") => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (v) => "€" + Math.round(v).toLocaleString("en-GB");
const sgn = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const median = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let M = null;      // model
let D = null;      // hotel layer
let mode = null;
let arch = null;   // archetype name (mode new)
let picked = null; // hotel index (mode existing)
let last = null;   // last computed plan, for sharing

// ---------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------

const cache = {};

async function load(cc) {
  // Model only: the per-hotel layer was taken off the public site on 2026-10-27 (database
  // right risk). The hotel modes stay in the code but are no longer reachable.
  if (!cache[cc]) {
    const m = await fetch(`data/${cc}.model.json`).then((r) => r.json());
    const d = { h: [], towns: [], townByName: new Map(), built: m.built };
    cache[cc] = { m, d };
  }
  M = cache[cc].m;
  D = cache[cc].d;
}

function facSet(h) {
  if (!h._fac) {
    const bin = atob(h.fac64);
    const s = new Set();
    for (let b = 0; b < bin.length; b++) {
      const byte = bin.charCodeAt(b);
      for (let k = 0; k < 8; k++) if (byte & (1 << k)) s.add(b * 8 + k);
    }
    h._fac = s;
  }
  return h._fac;
}

function km(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 +
    Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

function peersOf(lat, lng, archName, skip) {
  for (const R of RADII) {
    const p = D.h.filter((h) => h.arch === archName && h.i !== skip && km(lat, lng, h.lat, h.lng) <= R);
    if (p.length >= MIN_PEERS) return { list: p, label: `within ${R} km`, R };
  }
  return { list: D.h.filter((h) => h.arch === archName && h.i !== skip), label: `across ${C.name}`, R: null };
}

function prevalence(list) {
  const n = new Array(M.facilities.length).fill(0);
  for (const h of list) for (const i of facSet(h)) n[i]++;
  return n.map((c) => (list.length ? (100 * c) / list.length : 0));
}

function pctOf(archName, score) {
  const q = M.dist[archName].pct;            // 101 quantiles, p0 … p100
  if (score <= q[0]) return 0;
  if (score >= q[100]) return 100;
  let lo = 0, hi = 100;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= score) lo = mid; else hi = mid; }
  const span = q[hi] - q[lo];
  return lo + (span > 0 ? (score - q[lo]) / span : 0);
}
const tauIdx = (p) => (p < 17.5 ? 0 : p < 37.5 ? 1 : p < 62.5 ? 2 : p < 82.5 ? 3 : 4);

// ---------------------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------------------

function plan({ archName, rooms, adr, occ, budget, have, score, localPrev, isNew }) {
  const E = M.effects[archName];
  const t = tauIdx(pctOf(archName, score));
  const rows = M.facilities.map((f, i) => {
    const eff = E.eff[i] == null ? 0 : E.eff[i] + (E.curve[i][t] - E.curve[i][2]);
    const capex = f.capex_room * rooms + f.capex_fixed;
    const opex = f.opex_room * rooms + f.opex_fixed;
    return { i, f, eff, capex, opex, cost3: capex + 3 * opex, rate: E.rate[i] || 0,
      grade: E.grade[i], prev: E.prev[i] || 0, top: E.top[i] || 0, role: E.role[i],
      src: E.src[i], local: localPrev[i] };
  });
  const good = (r) => (r.grade === "A" || r.grade === "B") && r.eff > 0.01;

  // a new property gets the archetype's standard kit (what half the archetype already
  // lists) before anything else; it is what the local median already assumes
  const kit = isNew ? rows.filter((r) => good(r) && r.prev >= 50 && r.f.kind !== "structural") : [];
  const kitCapex = kit.reduce((s, r) => s + (BUY.has(r.f.kind) ? r.capex : 0), 0);
  const kitSet = new Set(kit.map((r) => r.i));

  // free items first, then the best score per € of capex + three years of running costs
  const cand = rows.filter((r) => good(r) && BUY.has(r.f.kind) && !have.has(r.i) && !kitSet.has(r.i))
    .sort((a, b) => (b.cost3 === 0) - (a.cost3 === 0) ||
      b.eff / Math.max(b.cost3, 1) - a.eff / Math.max(a.cost3, 1) || a.f.name.localeCompare(b.f.name));
  let left = Math.max(budget - kitCapex, 0);
  const picks = [];
  for (const r of cand) if (r.capex <= left) { picks.push(r); left -= r.capex; }

  const k = picks.length;
  const raw = picks.reduce((s, r) => s + r.eff, 0);
  // saturating rather than a hard cap: a small plan keeps (almost) all of its effect, a big
  // one approaches (never passes) the archetype's median→top-decile facility gap
  const ceil = M.ceiling[archName];
  const sat = (x, c) => (x <= 0 ? 0 : c * (1 - Math.exp(-x / c)));
  const x = M.meta.k_score * (raw + k * M.meta.nfac);
  const gain = sat(x, ceil.score);
  const capped = x > 0.5 * ceil.score;
  const ratePct = sat(M.meta.k_price * picks.reduce((s, r) => s + r.rate, 0), ceil.rate);
  const capex = picks.reduce((s, r) => s + r.capex, 0);
  const opex = picks.reduce((s, r) => s + r.opex, 0);
  const revenue = rooms * 365 * (occ / 100) * adr * (ratePct / 100);
  const newScore = Math.min(score + gain, 10);

  const free = rows.filter((r) => good(r) && (r.f.kind === "policy" || r.f.kind === "listing") &&
    !have.has(r.i) && r.prev < 95).sort((a, b) => b.eff - a.eff);
  const gap = rows.filter((r) => good(r) && BUY.has(r.f.kind) &&
    !have.has(r.i) && r.local < 30 && r.eff > 0.03).sort((a, b) => b.eff - a.eff).slice(0, 8);
  const fits = rows.filter((r) => r.f.kind === "context" && good(r) && !have.has(r.i))
    .sort((a, b) => b.eff - a.eff);
  const skip = rows.filter((r) => ["in_room", "property", "service"].includes(r.f.kind) &&
    r.cost3 >= 5000 && (r.role === "no reliable effect" || r.role === "drag") && !have.has(r.i))
    .sort((a, b) => b.cost3 - a.cost3).slice(0, 8);
  return { rows, kit, kitCapex, picks, k, raw, gain, capped, ratePct, capex, opex, revenue,
    newScore, payback: revenue - opex > 0 ? capex / (revenue - opex) : null, free, gap, skip, fits,
    budgetShort: isNew && budget < kitCapex };
}

// The same plan at a ladder of budgets: where spending stops buying score. This is the
// answer to "if I max the budget, why does the score barely move": facilities have a ceiling.
const BUDGETS = [0, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

function budgetCurve(args) {
  return BUDGETS.map((b) => ({ b, gain: plan({ ...args, budget: b }).gain }));
}

function renderCurve(points, budget, archName) {
  const ceil = M.ceiling[archName].score;
  const W = 640, H = 210, L = 46, R = 14, T = 16, B = 34;
  const n = points.length;
  const x = (j) => L + ((W - L - R) * j) / (n - 1);
  const ymax = Math.max(ceil * 1.12, 0.05);
  const y = (v) => T + (H - T - B) * (1 - v / ymax);
  const label = (b) => (b === 0 ? "€0" : b >= 1e6 ? `€${b / 1e6}M` : `€${b / 1000}k`);
  const path = points.map((p, j) => `${j ? "L" : "M"}${x(j).toFixed(1)},${y(p.gain).toFixed(1)}`).join(" ");
  const area = `${path} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  // where the user's budget sits on the ladder
  let jb = 0;
  for (let j = 0; j < n; j++) if (budget >= points[j].b) jb = j;
  const here = points[jb].gain;
  const best = points[n - 1].gain;
  const flat = points.find((p) => p.gain >= 0.8 * best) || points[n - 1];
  let g = "";
  for (let v = 0; v <= ymax + 1e-9; v += ymax > 0.4 ? 0.2 : 0.1) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">+${v.toFixed(1)}</text>`;
  }
  points.forEach((p, j) => { g += `<text x="${x(j)}" y="${H - 12}" text-anchor="middle">${label(p.b)}</text>`; });
  $("#curve").innerHTML = `<div class="ttl">What more budget buys</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score gain by budget">
      ${g}
      <line class="ceil" x1="${L}" x2="${W - R}" y1="${y(ceil)}" y2="${y(ceil)}"/>
      <text x="${W - R}" y="${y(ceil) - 6}" text-anchor="end" style="fill:var(--green)">facility ceiling for this type +${ceil.toFixed(2)}</text>
      <path class="ar" d="${area}"/><path class="ln" d="${path}"/>
      <circle class="dot" cx="${x(jb)}" cy="${y(here)}" r="6"/>
    </svg>
    <p class="cap">Score gain from the best plan at each budget. Most of it arrives by about <b>${label(flat.b)}</b>; beyond that the line flattens towards the ceiling, the most any facility list adds for a ${esc(archName.toLowerCase())}. The rest of a review score is service, cleanliness and upkeep, which no facility buys.</p>`;
}

// ---------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------

function stat(v, l, d = "", cls = "") {
  return `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div>${d ? `<div class="d ${cls}">${d}</div>` : ""}</div>`;
}

function ruler(marks) {
  const lo = 6, hi = 10, x = (s) => `${(100 * (Math.min(Math.max(s, lo), hi) - lo)) / (hi - lo)}%`;
  let h = `<div class="track"></div>`;
  for (let s = lo; s <= hi; s += 0.5) h += `<span class="ax" style="left:${x(s)}">${s % 1 ? "" : s.toFixed(0)}</span>`;
  // labels stagger downwards so close scores (7.9 / 8.4 / 8.8) never print over each other
  marks.forEach((m, j) => { h += `<span class="mk ${m.cls}" style="left:${x(m.s)}"><i></i><em style="top:${44 + 15 * j}px">${esc(m.label)} ${m.s.toFixed(1)}</em></span>`; });
  $("#ruler").innerHTML = h;
}

function bars(items, max, fmt, cls = "") {
  return `<div class="bars">${items.map((it) => `<div class="bar"><span class="n" title="${esc(it.n)}">${esc(it.n)}</span><span class="t"><i class="${it.cls || cls}" style="width:${Math.max(2, (100 * Math.abs(it.v)) / (max || 1))}%"></i></span><span class="x">${fmt(it.v)}</span></div>`).join("")}</div>`;
}

function topMoves(p) {
  const best = [...p.picks].sort((a, b) => b.eff - a.eff).slice(0, 3);
  if (!best.length) {
    $("#moves").innerHTML = `<p class="note">Nothing in the budget clears the evidence bar. Raise the budget, or the property already lists what moves the score for its type.</p>`;
    $("#movesNote").textContent = "";
    return;
  }
  $("#moves").innerHTML = best.map((r) => `<div class="move"><div><b>${esc(r.f.name)}</b><span>${r.cost3 === 0 ? "No capex: " + (r.f.kind === "policy" ? "a policy change" : "costs nothing") : eur(r.capex) + " for your rooms"}${r.opex ? ` + ${eur(r.opex)}/yr` : ""} · ${Math.round(r.local)}% of local competitors have it</span></div><div class="e">${sgn(r.eff)}</div></div>`).join("");
  $("#movesNote").textContent = "Score points each one adds for this property type at this score level. The full plan below has the rest, costed.";
}

function fullPlan(p, ctx) {
  const tr = (r) => `<tr><td>${esc(r.f.name)}</td><td><span class="tag ${r.f.kind === "policy" ? "g" : r.f.kind === "service" ? "b" : ""}">${KIND_LABEL[r.f.kind] || r.f.kind}</span></td><td class="num">${sgn(r.eff, 3)}</td><td class="num">${r.capex ? eur(r.capex) : "–"}</td><td class="num">${r.opex ? eur(r.opex) : "–"}</td><td class="num">${r.rate ? sgn(r.rate, 1) + "%" : "–"}</td><td class="num">${Math.round(r.local)}%</td></tr>`;
  let h = `<h2>The full plan · ${p.k} additions</h2>`;
  if (ctx.isNew) {
    h += p.budgetShort
      ? `<p class="note down">The standard kit alone costs ${eur(p.kitCapex)} for ${ctx.rooms} rooms, more than the budget. Everything below assumes the kit first.</p>`
      : `<p class="note">${eur(p.kitCapex)} of the budget goes on the standard kit; ${eur(Math.max(ctx.budget - p.kitCapex, 0))} is left for differentiators.</p>`;
  }
  h += p.picks.length ? `<div class="scroll"><table><thead><tr><th>Add</th><th>Kind</th><th class="num">Score</th><th class="num">Capex</th><th class="num">Opex/yr</th><th class="num" title="What the market charges for it, holding class, size and city constant">Rate premium</th><th class="num">Local share</th></tr></thead><tbody>${p.picks.map(tr).join("")}</tbody><tfoot><tr><td><b>Together</b></td><td></td><td class="num"><b>${sgn(p.gain)}</b></td><td class="num"><b>${eur(p.capex)}</b></td><td class="num"><b>${eur(p.opex)}</b></td><td class="num"><b>${sgn(p.ratePct, 1)}%</b></td><td></td></tr></tfoot></table></div>` : `<p class="note">No additions fit the budget.</p>`;
  h += `<div class="stats" style="margin-top:16px">${stat(eur(p.revenue), "Rate uplift per year", `${sgn(p.ratePct, 1)}% on ${ctx.rooms} rooms at ${ctx.occ}%`)}${stat(p.payback == null ? "–" : p.payback.toFixed(1) + " yrs", "Payback", p.payback == null ? "the rate effect does not cover the running costs" : "if you can charge the market premium: capex ÷ (uplift − opex)")}${stat(sgn(p.gain), "Score gain", p.capped ? "near the most a facility list can add for this type; beyond this it is service, not stuff" : "after overlap and out-of-sample shrinkage")}</div>`;

  if (ctx.isNew && p.kit.length) {
    h += `<h2>The standard kit for a ${esc(ctx.archName.toLowerCase())}</h2><p class="note">Half or more of the type already lists these, and each lifts the score. Missing one is what gets punished.</p><div class="scroll"><table><thead><tr><th>Facility</th><th>Kind</th><th class="num">Score</th><th class="num">Capex</th><th class="num">Of the type</th><th class="num">Of its top quarter</th></tr></thead><tbody>${p.kit.sort((a, b) => b.eff - a.eff).map((r) => `<tr><td>${esc(r.f.name)}</td><td><span class="tag m">${KIND_LABEL[r.f.kind] || r.f.kind}</span></td><td class="num">${sgn(r.eff, 3)}</td><td class="num">${BUY.has(r.f.kind) && r.capex ? eur(r.capex) : "–"}</td><td class="num">${Math.round(r.prev)}%</td><td class="num">${Math.round(r.top)}%</td></tr>`).join("")}</tbody></table></div>`;
  }

  if (p.free.length) {
    h += `<h2>Free wins</h2><p class="note">Zero capex. Policies are a decision; “tick the box” items you may already have, because Booking only counts what is listed on the extranet.</p>${bars(p.free.slice(0, 10).map((r) => ({ n: r.f.name + (r.f.kind === "listing" ? " (tick)" : ""), v: r.eff, cls: "g" })), p.free[0].eff, (v) => sgn(v))}`;
  }

  if (p.gap.length) {
    h += `<h2>Where you can stand out locally</h2><p class="note">Guests reward these, and fewer than 30% of the ${ctx.peers.list.length} competitors ${esc(ctx.peers.label)} list them.</p>${bars(p.gap.map((r) => ({ n: `${r.f.name} · ${Math.round(r.local)}% have it`, v: r.eff, cls: "b" })), p.gap[0].eff, (v) => sgn(v))}`;
  }

  if (ctx.hotel) {
    const subs = M.subs.map((s, j) => {
      const mine = ctx.hotel.subs[j];
      const loc = median(ctx.peers.list.map((h) => h.subs[j]));
      return { s, mine, loc, d: mine != null && loc != null ? mine - loc : null };
    }).filter((x) => x.d != null);
    if (subs.length) {
      const worst = [...subs].sort((a, b) => a.d - b.d)[0];
      const key = worst.s === "WiFi" ? "Free WiFi" : worst.s;
      const fix = (M.sub_effects[key] || []).filter(([i]) => !facSet(ctx.hotel).has(i)).slice(0, 5);
      const maxd = Math.max(...subs.map((x) => Math.abs(x.d)), 0.1);
      h += `<h2>Sub-scores against local competitors</h2><p class="note">Your score minus the median of ${ctx.peers.list.length} competitors ${esc(ctx.peers.label)}.</p>${bars(subs.map((x) => ({ n: `${x.s} · ${x.mine.toFixed(1)}`, v: x.d, cls: x.d >= 0 ? "g" : "r" })), maxd, (v) => sgn(v, 1))}`;
      if (fix.length && worst.d < 0) {
        h += `<p class="note" style="margin-top:12px"><b>${esc(worst.s)}</b> is where you lose most. Listed facilities that measurably move it, which you do not list: ${fix.map(([i, c]) => `${esc(M.facilities[i].name)} (${sgn(c)})`).join(", ")}.</p>`;
      }
    }
  }

  const offers = (M.offerings[ctx.archName] || []).filter((o) => o.rate_q != null);
  if (offers.length) {
    const verdict = (o) => (o.rate_q < 0.05 && o.rate > 0 && o.score_q < 0.05 && o.score > 0) ? ["pays twice", "g"]
      : (o.rate_q < 0.05 && o.rate > 0) ? ["earns rate", "b"] : (o.score_q < 0.05 && o.score > 0) ? ["earns score", "b"]
        : (o.rate_q < 0.05 || o.score_q < 0.05) ? ["costs you", ""] : ["no measurable return", "m"];
    h += `<h2>The big decisions for this type</h2><div class="scroll"><table><thead><tr><th>Offering</th><th>Verdict</th><th class="num">Rate</th><th class="num">Score</th></tr></thead><tbody>${offers.sort((a, b) => b.rate - a.rate).map((o) => { const [v, c] = verdict(o); return `<tr><td>${esc(o.offering)}</td><td><span class="tag ${c}">${v}</span></td><td class="num">${sgn(o.rate, 1)}%</td><td class="num">${sgn(o.score, 3)}</td></tr>`; }).join("")}</tbody></table></div>`;
  }

  if (p.fits.length) {
    h += `<h2>Only if it fits where you are</h2><p class="note">These lift scores where they belong and nowhere else, so they are never in the plan above.</p><ul class="note" style="padding-left:18px">${p.fits.map((r) => `<li><b>${esc(r.f.name)}</b> ${sgn(r.eff)}: ${esc(r.f.note || "")}</li>`).join("")}</ul>`;
  }

  if (p.skip.length) {
    h += `<h2>Money you would spend for nothing</h2><p class="note">Capex plus three years of running costs for your size, with no reliable effect on the score for this type, or a negative one. They may be right for other reasons; the score is not one of them.</p>${bars(p.skip.map((r) => ({ n: r.f.name, v: r.cost3, cls: r.role === "drag" ? "r" : "a" })), p.skip[0].cost3, (v) => eur(v))}`;
  }
  h += `<p class="note" style="margin-top:22px">Summed effects overlap, so the total is shrunk to what held up in towns the model never saw (score ×${M.meta.k_score}, rate ×${M.meta.k_price}) and saturates towards the gap between this type's median and top-decile facility set (${sgn(M.ceiling[ctx.archName].score)}). No property in the data gets more out of its list than that. Running costs are counted for three years when ranking.</p>`;
  $("#full").innerHTML = h;
}

function show(p, ctx) {
  last = ctx;
  $("#result").classList.remove("hide");
  const pctNow = pctOf(ctx.archName, ctx.score);
  const pctNew = pctOf(ctx.archName, p.newScore);
  const locMed = median(ctx.peers.list.map((h) => h.rating));
  if (ctx.hotel) {
    $("#resTitle").textContent = "Your plan";
    $("#resHead").innerHTML = `${esc(ctx.hotel.name)} <mark>${esc(ctx.hotel.city)}</mark>`;
    $("#resSub").textContent = `${ctx.archName} · ${ctx.hotel.rating.toFixed(1)} from ${ctx.hotel.reviews.toLocaleString("en-GB")} reviews · ${ctx.peers.list.length} competitors of the same type ${ctx.peers.label}.`;
    $("#stats").innerHTML =
      stat(`Top ${Math.max(1, Math.round(100 - pctNow))}%`, `of ${ctx.archName.toLowerCase()} in ${C.name}`) +
      stat(sgn(ctx.score - locMed, 1), `vs local median ${locMed.toFixed(1)}`, ctx.peers.label, ctx.score >= locMed ? "up" : "down") +
      stat(p.newScore.toFixed(2), "with the full plan", `${sgn(p.gain)} → top ${Math.max(1, Math.round(100 - pctNew))}%`, "up") +
      stat(eur(p.capex), "capex in the plan", `${p.k} additions within ${eur(ctx.budget)}`);
    ruler([{ s: locMed, label: "local", cls: "loc" }, { s: ctx.score, label: "now", cls: "now" }, { s: p.newScore, label: "plan", cls: "new" }]);
    $("#lockExtra").textContent = ", and which sub-score is costing you most";
  } else {
    $("#resTitle").textContent = "Your stack";
    $("#resHead").innerHTML = `A new ${esc(ctx.archName.toLowerCase())} in <mark>${esc(ctx.town.name)}</mark>`;
    $("#resSub").textContent = `${ctx.peers.list.length} competitors of this type ${ctx.peers.label}, median score ${locMed.toFixed(1)}. A new property that matches the standard kit starts around that median.`;
    $("#stats").innerHTML =
      stat(String(ctx.peers.list.length), "local competitors", ctx.peers.label) +
      stat(locMed.toFixed(1), "local median score", `the type's top 10% in ${C.name} score ${M.dist[ctx.archName].pct[90].toFixed(1)}+`) +
      stat(eur(p.kitCapex), "standard kit", `${p.kit.length} items for ${ctx.rooms} rooms`) +
      stat(p.newScore.toFixed(2), "with your differentiators", `${sgn(p.gain)} → top ${Math.max(1, Math.round(100 - pctNew))}%`, "up");
    ruler([{ s: locMed, label: "local median", cls: "loc" }, { s: p.newScore, label: "your plan", cls: "new" }]);
    $("#lockExtra").textContent = ", the standard kit for the type";
  }
  renderCurve(budgetCurve(ctx.args), ctx.budget, ctx.archName);
  topMoves(p);
  fullPlan(p, ctx);
  applyLock();
  writeHash(ctx);
  $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------------------

const num = (sel, dflt) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : dflt; };

function runNew() {
  const town = D.townByName.get($("#town").value.trim().toLowerCase());
  if (!town) { $("#newErr").textContent = "Pick a town from the list."; return; }
  if (!arch) { $("#newErr").textContent = "Pick a property type."; return; }
  $("#newErr").textContent = "";
  const peers = peersOf(town.lat, town.lng, arch, -1);
  const score = median(peers.list.map((h) => h.rating)) ?? M.dist[arch].pct[50];
  const ctx = { isNew: true, town, archName: arch, rooms: num("#nRooms", 40), adr: num("#nAdr", M.dist[arch].adr),
    occ: num("#nOcc", 70), budget: num("#nBudget", 150000), score, peers };
  ctx.args = { ...ctx, have: new Set(), localPrev: prevalence(peers.list) };
  show(plan(ctx.args), ctx);
}

function runExisting() {
  if (picked == null) { $("#exErr").textContent = "Find and pick your hotel first."; return; }
  $("#exErr").textContent = "";
  const h = D.h[picked];
  const peers = peersOf(h.lat, h.lng, h.arch, h.i);
  const ctx = { isNew: false, hotel: h, archName: h.arch, rooms: num("#eRooms", 40), adr: num("#eAdr", M.dist[h.arch].adr),
    occ: num("#eOcc", 70), budget: num("#eBudget", 50000), score: h.rating, peers };
  ctx.args = { ...ctx, have: facSet(h), localPrev: prevalence(peers.list) };
  show(plan(ctx.args), ctx);
}

function pick(i) {
  picked = i;
  const h = D.h[i];
  $("#hits").classList.add("hide");
  $("#q").value = h.name;
  $("#picked").classList.remove("hide");
  $("#picked").innerHTML = `<div><b>${esc(h.name)}</b><br><span class="hint">${esc(h.city)} · ${esc(h.arch)} · ${h.rating.toFixed(1)} from ${h.reviews.toLocaleString("en-GB")} reviews</span></div><button class="cta ghost" id="unpick">Change</button>`;
  $("#unpick").onclick = () => { picked = null; $("#picked").classList.add("hide"); $("#q").value = ""; $("#q").focus(); };
  if (!$("#eAdr").value) $("#eAdr").value = M.dist[h.arch].adr;
  $("#eAdrHint").textContent = `Median for ${h.arch.toLowerCase()} in the data: €${M.dist[h.arch].adr}`;
}

function search(q) {
  const ul = $("#hits");
  q = q.trim().toLowerCase();
  if (q.length < 2) { ul.classList.add("hide"); return; }
  const words = q.split(/\s+/);
  const hits = [];
  for (const h of D.h) {
    if (words.every((w) => h.lname.includes(w))) {
      hits.push(h);
      if (hits.length >= 12) break;
    }
  }
  ul.innerHTML = hits.length ? hits.map((h) => `<li role="option" data-i="${h.i}"><span>${esc(h.name)}</span><span class="c">${esc(h.city)} · ${h.rating.toFixed(1)}</span></li>`).join("")
    : `<li><span class="hint">No match with 20+ reviews. Try fewer words, or plan it as a new property.</span></li>`;
  ul.classList.remove("hide");
  ul.querySelectorAll("li[data-i]").forEach((li) => li.addEventListener("click", () => pick(+li.dataset.i)));
}

function setMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#formNew").classList.toggle("hide", m !== "new");
  $("#formExisting").classList.toggle("hide", m !== "existing");
  $("#formCheck").classList.toggle("hide", m !== "check");
  $("#formBig").classList.toggle("hide", m !== "big");
  $("#result").classList.add("hide");
  if (m === "check") { renderBrowse(); $("#cFac").focus({ preventScroll: true }); }
  else if (m === "big") renderBig();
  else (m === "new" ? $("#town") : $("#q")).focus({ preventScroll: true });
}

function setArch(name) {
  arch = name;
  document.querySelectorAll(".arch").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.a === name)));
  $("#nAdr").placeholder = M.dist[name].adr;
  if (!$("#nAdr").value) $("#nAdr").value = M.dist[name].adr;
  $("#adrHint").textContent = `Median for this type in the data: €${M.dist[name].adr}`;
}

// ---------------------------------------------------------------------------------------
// check one facility
// ---------------------------------------------------------------------------------------

let subByFac = null;   // facility index → [[sub-score, coef]] from model E
function subsFor(i) {
  if (!subByFac) {
    subByFac = new Map();
    for (const [t, list] of Object.entries(M.sub_effects || {})) {
      for (const [fi, c] of list) {
        if (!subByFac.has(fi)) subByFac.set(fi, []);
        subByFac.get(fi).push([t === "Free WiFi" ? "WiFi" : t, c]);
      }
    }
  }
  return [...(subByFac.get(i) || [])].sort((a, b) => b[1] - a[1]);
}

const facIndex = (name) => {
  const n = name.trim().toLowerCase();
  return M.facilities.findIndex((f) => f.name.toLowerCase() === n);
};

function verdictFor(f, eff, grade, prev, rate, cost3) {
  if (f.kind === "structural") return ["no", "Not something you can buy", "It describes the building or the location. Shown for reference."];
  if (f.kind === "context") return ["no", "Only where it fits", f.note || "It pays only in the right location."];
  const solid = grade === "A" || grade === "B";
  if (solid && eff < -0.01) return ["bad", "Guests score it worse", "Properties that list it score lower than comparable ones without it."];
  if (!solid || Math.abs(eff) <= 0.01) {
    if (rate > 0) return ["no", "No score effect, but it earns rate", "Guests do not score it higher; the market does charge for it."];
    return ["no", "Skip it for the score", "No reliable effect on the review score for this type."];
  }
  if (prev >= 50) return ["hy", "A basic for this type", "Most of the type lists it, and missing it costs you."];
  if (eff < 0.05) return ["no", "A small lift", "Real, but small: under a twentieth of a point. Buy it for its own reasons, not for the score."];
  return ["go", "Worth it: guests notice it", cost3 === 0 ? "And it costs nothing to switch on." : "A differentiator: fewer than half of the type have it."];
}

const GRADE_TXT = { A: "strong: significant and stable across 200 re-draws of towns",
  B: "likely: significant, stable in 9 of 10 re-draws", C: "weak: could be noise" };

function renderCheck() {
  const i = facIndex($("#cFac").value);
  if (i < 0) { $("#chErr").textContent = "Pick a facility from the list."; return; }
  $("#chErr").textContent = "";
  const a = $("#cArch").value, E = M.effects[a], f = M.facilities[i];
  const rooms = num("#cRooms", 40), adr = num("#cAdr", M.dist[a].adr), occ = num("#cOcc", 70);
  const score = num("#cScore", M.dist[a].pct[50]);
  const t = tauIdx(pctOf(a, score));
  const base = E.eff[i] ?? 0;
  const eff = base + (E.curve[i][t] - E.curve[i][2]);
  const rate = E.rate[i] || 0, grade = E.grade[i], prev = E.prev[i] || 0, top = E.top[i] || 0;
  const capex = f.capex_room * rooms + f.capex_fixed, opex = f.opex_room * rooms + f.opex_fixed;
  const rev = rooms * 365 * (occ / 100) * adr * (M.meta.k_price * rate / 100);
  const payback = rev - opex > 0 ? capex / (rev - opex) : null;
  const [vc, vt, vd] = verdictFor(f, eff, grade, prev, rate, capex + 3 * opex);
  const lv = ["weakest 10%", "lower quarter", "median", "upper quarter", "strongest 10%"]
    .map((n, j) => ({ n, v: base + (E.curve[i][j] - E.curve[i][2]) }));
  const across = M.archetypes.map((x) => ({ n: x.name + (M.effects[x.name].src[i] === "archetype" ? "" : " *"),
    v: M.effects[x.name].eff[i] ?? 0, cls: x.name === a ? "" : "b" }));
  const subs = subsFor(i);
  const maxL = Math.max(...lv.map((x) => Math.abs(x.v)), 0.02);
  const maxA = Math.max(...across.map((x) => Math.abs(x.v)), 0.02);
  $("#checkOut").innerHTML = `<div class="fcard">
    <span class="verdict ${vc}">${esc(vt)}</span>
    <h3>${esc(f.name)} <mark>${esc(a.toLowerCase())}</mark></h3>
    <p class="note">${esc(vd)}</p>
    <div class="stats" style="margin-top:12px">
      ${stat(sgn(eff), "on the review score", `at a current score of ${score.toFixed(1)}`, eff >= 0 ? "up" : "down")}
      ${stat(rate ? sgn(rate, 1) + "%" : "–", "rate premium", rate ? "what the market charges for it" : "no reliable premium")}
      ${stat(Math.round(prev) + "%", "of the type list it", `${Math.round(top)}% of its top-scoring quarter`)}
      ${stat(grade || "–", "evidence", GRADE_TXT[grade] || "not measured")}
    </div>
    <div class="two">
      <div><h2>By current score</h2>${bars(lv.map((x) => ({ ...x, cls: x.v >= 0 ? "g" : "r" })), maxL, (v) => sgn(v))}<p class="note" style="margin-top:6px">Basics fade: they matter most to the weakest properties.</p></div>
      <div><h2>By property type</h2>${bars(across, maxA, (v) => sgn(v))}<p class="note" style="margin-top:6px">* no type-specific effect found; the all-types number is shown.</p></div>
    </div>
    ${subs.length ? `<h2 style="margin-top:22px">Which sub-scores it moves</h2>${bars(subs.map(([s, c]) => ({ n: s, v: c, cls: "b" })), subs[0][1], (v) => sgn(v))}<p class="note" style="margin-top:6px">Only sub-scores where the effect is significant. A facility that moves Cleanliness or Staff is changing how the whole stay feels.</p>` : ""}
    <div class="money ${unlocked() ? "" : "locked"}" style="margin-top:22px">
      <div class="mb"><h2>For your property</h2><div class="stats">
        ${stat(capex ? eur(capex) : "€0", "one-off", f.note ? esc(f.note) : `for ${rooms} rooms`)}
        ${stat(opex ? eur(opex) + "/yr" : "€0", "running costs")}
        ${stat(rate ? eur(rev) : "–", "rate uplift per year", rate ? `if you charge the premium, at ${occ}% occupancy` : "no premium to charge")}
        ${stat(payback == null ? "–" : payback.toFixed(1) + " yrs", "payback", payback == null ? "the premium does not cover it" : "capex ÷ (uplift − running costs)")}
      </div></div>
      <div class="ml"><div class="lockbox"><p><b>Costs and payback for your rooms</b> are free for Le Portée subscribers. The code is in your welcome email.</p><div class="lockrow"><a class="cta" target="_blank" rel="noopener" href="${SUB_URL}?utm_source=planner&amp;utm_medium=tool&amp;utm_campaign=check">Subscribe free</a><input class="mcode" placeholder="Subscriber code" autocomplete="off"><button class="cta ghost mgo">Unlock</button></div><div class="err merr"></div></div></div>
    </div>
  </div>`;
  wireMiniLock($("#checkOut"));
  setHash({ m: "c", f: f.name, a });
}

function renderBrowse() {
  const a = $("#cArch").value, E = M.effects[a];
  const q = $("#bQ").value.trim().toLowerCase(), g = $("#bGroup").value, s = $("#bSort").value;
  const rows = M.facilities.map((f, i) => ({ f, i, eff: E.eff[i] ?? 0, rate: E.rate[i] || 0, prev: E.prev[i] || 0, grade: E.grade[i] }))
    .filter((r) => (!q || r.f.name.toLowerCase().includes(q)) && (!g || r.f.group === g));
  const key = { eff: (r) => -r.eff, rate: (r) => -r.rate, prev: (r) => -r.prev };
  rows.sort((x, y) => (s === "name" ? x.f.name.localeCompare(y.f.name) : key[s](x) - key[s](y)));
  const gl = { A: "strong", B: "likely", C: "weak" };
  const cls = (r) => (r.grade !== "C" && r.eff > 0.01 ? "up" : r.grade !== "C" && r.eff < -0.01 ? "down" : "");
  const tag = (r) => (r.f.kind === "context" ? ' <span class="tag m">only where it fits</span>'
    : r.f.kind === "structural" ? ' <span class="tag m">not for sale</span>' : "");
  $("#bRows").innerHTML = rows.map((r) => `<tr data-f="${esc(r.f.name)}"><td>${esc(r.f.name)}${tag(r)}</td><td>${esc(r.f.group || "")}</td><td class="num ${cls(r)}">${sgn(r.eff, 3)}</td><td class="num">${r.rate ? sgn(r.rate, 1) + "%" : "–"}</td><td class="num">${Math.round(r.prev)}%</td><td>${gl[r.grade] || "–"}</td></tr>`).join("");
  $("#bRows").querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => {
    $("#cFac").value = tr.dataset.f;
    renderCheck();
    $("#checkOut").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function checkDefaults() {
  const a = $("#cArch").value;
  $("#cAdr").value = M.dist[a].adr;
  $("#cScore").value = M.dist[a].pct[50].toFixed(1);
}

// ---------------------------------------------------------------------------------------
// the big decisions
// ---------------------------------------------------------------------------------------

function offerVerdict(o) {
  if (o.rate_q < 0.05 && o.rate > 0 && o.score_q < 0.05 && o.score > 0) return ["pays twice", "g"];
  if (o.rate_q < 0.05 && o.rate > 0) return ["earns rate", "b"];
  if (o.score_q < 0.05 && o.score > 0) return ["earns score", "b"];
  if (o.rate_q < 0.05 || o.score_q < 0.05) return ["costs you", ""];
  return ["no measurable return", "m"];
}

function cell(v, q, fmt) {
  if (v == null) return `<td class="c">–</td>`;
  const sig = q < 0.05;
  const bg = !sig ? "transparent" : v > 0 ? "color-mix(in srgb,var(--green) 22%,var(--card))" : "color-mix(in srgb,var(--red) 18%,var(--card))";
  return `<td class="c" style="background:${bg};${sig ? "" : "color:var(--mute)"}">${fmt(v)}</td>`;
}

function renderBig() {
  const a = $("#gArch").value;
  const offers = (M.offerings[a] || []).filter((o) => o.rate_q != null).sort((x, y) => y.rate - x.rate);
  const names = (M.offerings.All || []).map((o) => o.offering);
  const at = (arch, name) => (M.offerings[arch] || []).find((o) => o.offering === name) || {};
  const maxR = Math.max(...offers.map((o) => Math.abs(o.rate)), 1);
  let h = `<h2 style="margin-top:22px">For a ${esc(a.toLowerCase())}</h2>
    <p class="note">Rate effect inside this type, holding class, size, location and how much is listed constant. Colour = what it does to rate and score together.</p>
    ${bars(offers.map((o) => { const [v, c] = offerVerdict(o); return { n: `${o.offering} · ${v}`, v: o.rate, cls: c === "g" ? "g" : c === "b" ? "b" : c === "" ? "r" : "a" }; }), maxR, (v) => sgn(v, 1) + "%")}
    <div class="scroll" style="margin-top:14px"><table><thead><tr><th>Offering</th><th>Verdict</th><th class="num">Rate</th><th class="num">Score</th></tr></thead><tbody>
    ${offers.map((o) => { const [v, c] = offerVerdict(o); return `<tr><td>${esc(o.offering)}</td><td><span class="tag ${c}">${v}</span></td><td class="num">${sgn(o.rate, 1)}%</td><td class="num">${sgn(o.score, 3)}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  const archs = M.archetypes.map((x) => x.name);
  const head = `<tr><th>Offering</th>${archs.map((x) => `<th class="c">${esc(x.split(" / ")[0])}</th>`).join("")}</tr>`;
  h += `<h2 style="margin-top:30px">Every type at once: rate</h2>
    <p class="note">% of nightly rate. Green or red = significant; grey = no measurable effect. The same offering pays in one type and costs in another.</p>
    <div class="scroll"><table class="mx"><thead>${head}</thead><tbody>
    ${names.map((n) => `<tr><td>${esc(n)}</td>${archs.map((x) => { const o = at(x, n); return cell(o.rate, o.rate_q, (v) => sgn(v, 1) + "%"); }).join("")}</tr>`).join("")}
    </tbody></table></div>
    <h2 style="margin-top:30px">Every type at once: review score</h2>
    <div class="scroll"><table class="mx"><thead>${head}</thead><tbody>
    ${names.map((n) => `<tr><td>${esc(n)}</td>${archs.map((x) => { const o = at(x, n); return cell(o.score, o.score_q, (v) => sgn(v, 2)); }).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  const pairs = M.pairs || [];
  if (pairs.length) {
    h += `<h2 style="margin-top:30px">Pairs that change each other</h2>
      <p class="note">Most offerings do not depend on each other. These are the combinations that do, estimated together so a third offering cannot fake the effect.</p>
      <ul class="pairs note" style="padding-left:18px">${pairs.map((p) => `<li><b>${esc(p.a)} + ${esc(p.b)}</b>: ${p.target === "rating" ? sgn(p.effect, 2) + " on the score" : sgn(p.effect, 1) + "% on rate"} together beyond what each does alone${p.verdict ? ` (${esc(p.verdict)})` : ""}, ${Number(p.n_both).toLocaleString("en-GB")} properties have both.</li>`).join("")}</ul>`;
  }
  $("#bigOut").innerHTML = h;
  setHash({ m: "b", a });
}

// ---------------------------------------------------------------------------------------
// gate, share, state
// ---------------------------------------------------------------------------------------

function setHash(obj) {
  history.replaceState(null, "", "#" + new URLSearchParams({ cc: C.cc, ...obj }).toString());
}

function wireMiniLock(root) {
  root.querySelectorAll(".mgo").forEach((btn) => btn.addEventListener("click", async () => {
    const box = btn.closest(".lockbox");
    const code = box.querySelector(".mcode").value.trim().toLowerCase();
    if (code && (await sha256(code)) === UNLOCK_HASH) {
      store.set("lp_planner_unlocked", "1");
      document.querySelectorAll(".money.locked").forEach((m) => m.classList.remove("locked"));
      applyLock();
    } else {
      box.querySelector(".merr").textContent = "That code doesn't match. It's in the Le Portée welcome email.";
    }
  }));
}

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const unlocked = () => store.get("lp_planner_unlocked") === "1";
function applyLock() { $("#gated").classList.toggle("locked", !unlocked()); }

async function tryCode() {
  const code = $("#code").value.trim().toLowerCase();
  if (!code) { $("#codeErr").textContent = "Enter the code from your welcome email."; return; }
  if ((await sha256(code)) === UNLOCK_HASH) {
    store.set("lp_planner_unlocked", "1");
    $("#codeErr").textContent = "";
    applyLock();
  } else {
    $("#codeErr").textContent = "That code doesn't match. It's in the Le Portée welcome email.";
  }
}

function openSubscribe(campaign) {
  const box = $("#embed");
  box.classList.remove("hide");
  box.innerHTML = `<iframe src="${EMBED_URL}" title="Subscribe to Le Portée" loading="lazy"></iframe><p class="hint">Or <a href="${SUB_URL}?utm_source=planner&amp;utm_medium=tool&amp;utm_campaign=${encodeURIComponent(campaign)}" target="_blank" rel="noopener">subscribe on leportee.com</a>. Your code arrives with the welcome email.</p>`;
}

function writeHash(ctx) {
  const p = new URLSearchParams({ cc: C.cc });
  if (ctx.hotel) { p.set("m", "e"); p.set("h", ctx.hotel.name); p.set("c", ctx.hotel.city); }
  else { p.set("m", "n"); p.set("t", ctx.town.name); p.set("a", ctx.archName); p.set("adr", ctx.adr); p.set("occ", ctx.occ); }
  p.set("r", ctx.rooms); p.set("b", ctx.budget);
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const m = p.get("m");
  if (m === "e" || m === "n") return;   // hotel modes retired: old share links open the menu
  if (m === "e") {
    const h = D.h.find((x) => x.name === p.get("h") && x.city === p.get("c"));
    if (!h) return;
    setMode("existing"); pick(h.i);
    if (p.get("r")) $("#eRooms").value = p.get("r");
    if (p.get("b")) $("#eBudget").value = p.get("b");
    runExisting();
  } else if (m === "n") {
    setMode("new");
    $("#town").value = p.get("t") || "";
    if (M.dist[p.get("a")]) setArch(p.get("a"));
    for (const [k, s] of [["r", "#nRooms"], ["adr", "#nAdr"], ["occ", "#nOcc"], ["b", "#nBudget"]]) if (p.get(k)) $(s).value = p.get(k);
    runNew();
  } else if (m === "c") {
    if (M.dist[p.get("a")]) { $("#cArch").value = p.get("a"); checkDefaults(); }
    setMode("check");
    $("#cFac").value = p.get("f") || "";
    if (facIndex($("#cFac").value) >= 0) renderCheck();
  } else if (m === "b") {
    if (M.dist[p.get("a")]) $("#gArch").value = p.get("a");
    setMode("big");
  }
}

function shareText() {
  if (!last) return "";
  if (last.hotel) {
    const top = Math.max(1, Math.round(100 - pctOf(last.archName, last.hotel.rating)));
    return `${last.hotel.name} (${last.hotel.city}) is in the top ${top}% of ${last.archName.toLowerCase()} in ${C.name} on Booking.com. Here's what it should add next:`;
  }
  return `What a new ${last.archName.toLowerCase()} in ${last.town.name} should be built with, from ${D.h.length.toLocaleString("en-GB")} ${C.adj} Booking.com listings:`;
}

// ---------------------------------------------------------------------------------------

// fill every country-dependent part of the page from the loaded model + hotel layer
function populate() {
  document.querySelectorAll("#countries .chip").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.cc === C.cc)));
  $("#kCountry").textContent = C.name;
  $("#nHotels").textContent = Object.values(M.dist).reduce((t, x) => t + (x.n || 0), 0).toLocaleString("en-GB");
  $("#adj").textContent = C.adj;
  $("#q").placeholder = `Hotel name, e.g. ${C.eg}`;
  $("#qNote").textContent = `${C.name} · properties with 20+ reviews.`;
  $("#built").textContent = `Data built ${D.built}`;
  $("#towns").innerHTML = D.towns.map((t) => `<option value="${esc(t.name)}">${t.n} hotels</option>`).join("");
  $("#archs").innerHTML = M.archetypes.map((a) => `<button class="arch" data-a="${esc(a.name)}" aria-pressed="false"><b>${esc(a.name)}</b><span>${esc(a.blurb)}</span></button>`).join("");
  document.querySelectorAll(".arch").forEach((b) => b.addEventListener("click", () => setArch(b.dataset.a)));

  // check one facility + big decisions
  const archOpts = M.archetypes.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  $("#cArch").innerHTML = archOpts;
  $("#gArch").innerHTML = archOpts;
  $("#cArch").value = $("#gArch").value = "Midscale / standard";
  checkDefaults();
  $("#facs").innerHTML = M.facilities.map((f) => `<option value="${esc(f.name)}"></option>`).join("");
  const groups = [...new Set(M.facilities.map((f) => f.group).filter(Boolean))].sort();
  $("#bGroup").innerHTML = `<option value="">All groups</option>` + groups.map((g) => `<option>${esc(g)}</option>`).join("");
}

// another country: its own hotels and facility list, so anything half-done is cleared
async function setCountry(cc) {
  const next = COUNTRIES.find((c) => c.cc === cc);
  if (!next) return;
  document.body.classList.add("loading");
  try {
    await load(cc);
  } finally {
    document.body.classList.remove("loading");
  }
  C = next;
  store.set("lp_planner_cc", cc);
  arch = null; picked = null; last = null;
  for (const s of ["#q", "#town", "#cFac", "#nAdr"]) $(s).value = "";
  $("#hits")?.classList.add("hide");
  $("#result").classList.add("hide");
  populate();
  if (mode) setMode(mode);
}

async function init() {
  const cc = $("#countries");
  for (const c of COUNTRIES) {
    const b = el("button", { class: "chip", "data-cc": c.cc, "aria-pressed": "false" }, c.name);
    b.addEventListener("click", () => { if (c.cc !== C.cc) setCountry(c.cc).then(() => setHash({})); });
    cc.appendChild(b);
  }
  document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#goNew").addEventListener("click", runNew);
  $("#goExisting").addEventListener("click", runExisting);
  $("#unlock").addEventListener("click", tryCode);
  $("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") tryCode(); });
  $("#openSub").addEventListener("click", () => openSubscribe("unlock"));
  $("#copyLink").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); $("#shareMsg").textContent = "Link copied."; }
    catch { $("#shareMsg").textContent = location.href; }
  });
  $("#shareBtn").addEventListener("click", async () => {
    if (navigator.share) { try { await navigator.share({ title: "Le Portée Hotel Upgrade Finder", text: shareText(), url: location.href }); } catch { /* dismissed */ } }
    else { try { await navigator.clipboard.writeText(shareText() + " " + location.href); $("#shareMsg").textContent = "Copied to share."; } catch { /* no clipboard */ } }
  });
  let t;
  $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => search(e.target.value), 120); });
  $("#goCheck").addEventListener("click", renderCheck);
  $("#cFac").addEventListener("change", () => { if (facIndex($("#cFac").value) >= 0) renderCheck(); });
  $("#cArch").addEventListener("change", () => { checkDefaults(); renderBrowse(); if (facIndex($("#cFac").value) >= 0) renderCheck(); });
  $("#bQ").addEventListener("input", renderBrowse);
  $("#bGroup").addEventListener("change", renderBrowse);
  $("#bSort").addEventListener("change", renderBrowse);
  $("#gArch").addEventListener("change", renderBig);
  applyLock();

  // a shared link names its country; otherwise the visitor's last choice, else Germany
  const want = new URLSearchParams(location.hash.slice(1)).get("cc") || store.get("lp_planner_cc") || "de";
  C = COUNTRIES.find((c) => c.cc === want) || COUNTRIES[0];
  try {
    await load(C.cc);
  } catch (e) {
    $(".sub").insertAdjacentHTML("afterend", `<p class="err">The data did not load. Refresh the page.</p>`);
    return;
  }
  populate();

  if (location.hash.length > 1) readHash();
}

init();
