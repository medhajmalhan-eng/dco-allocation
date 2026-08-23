/* DCO plan reconciliation — all logic, no server.
   Location resolution is a direct port of _resolve_location from the
   production cab-recommender (services/cab_recommender.py). Qualification
   (direction + client + shift tolerance + within-scope) matches _score_cab.
   Keep in sync if the Python changes. */

const SHIFT_TOL_MIN = 45;          // production constant
const KM_PER_DEG = [111.0, 105.9]; // HYD
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STORE = "dco-plan-v1";

let ZONES = {}, REGIONS = {}, REQ = null, SHIFTS = {}, META = {};
const $ = (i) => document.getElementById(i);

/* ---------- helpers ported from recommender.py ---------- */
const normClient = (s) =>
  String(s || "").trim().toLowerCase()
    .split("_")[0].split("-")[0]
    .replace(/\d+$/, "").replace(/[^a-z]/g, "");

const mins = (hhmm) => {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};
const circ = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };
const km = (a, b) => Math.hypot((a[0] - b[0]) * KM_PER_DEG[0], (a[1] - b[1]) * KM_PER_DEG[1]);
const geo = (s) => {
  const m = String(s || "").match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
};

function resolveLocation(loc, byId) {
  const mode = (loc || {}).mode;
  let coord = null, scope = 1e9, mtype = "flexible", regionPts = null, zone = null;
  if (mode === "zone" || mode === "pocket") {
    const mag = loc.magnet;
    if (mag && mag.centre && mag.centre.length >= 2) {
      coord = [+mag.centre[0], +mag.centre[1]];
      scope = mag.radius_km || mag.core_km || 3.0;
      mtype = "specific"; zone = loc.label;
    } else {
      for (const v of (loc.value || [])) {
        if (ZONES[v]) { coord = ZONES[v]; scope = 4.0; mtype = "specific"; zone = v; break; }
      }
    }
  } else if (mode === "point" || mode === "magnet") {
    const val = loc.value || [];
    if (val.length >= 2 && typeof val[0] === "number") {
      coord = [+val[0], +val[1]];
      scope = loc.radius_km || loc.core_km || (mode === "point" ? 0.5 : 3.0);
      mtype = "specific"; zone = loc.label;
    }
  } else if (mode === "direction") {
    for (const v of (loc.value || [])) {
      const k = String(v).trim().toLowerCase();
      if (REGIONS[k] && REGIONS[k].length) { regionPts = REGIONS[k]; scope = 15.0; mtype = "region"; break; }
    }
  } else if (mode === "paired_area") {
    const ref = byId[loc.ref] || {}, rloc = ref.location || {}, rmag = rloc.magnet || {};
    if (rmag.centre && rmag.centre.length >= 2) {
      coord = [+rmag.centre[0], +rmag.centre[1]];
      scope = rmag.radius_km || 3.0; mtype = "specific"; zone = rloc.label;
    }
  }
  return { coord, scope, mtype, regionPts, zone };
}

/* ---------- plan -> requirements ---------- */
function buildRequirements(plan) {
  const req = {};
  let cabCount = 0;
  for (const c of (plan.cabs || [])) {
    const cid = c.cab_id || "";
    if (cid.includes("-MS-") || c.volatile || c.needs_manual_plan) continue;
    cabCount++;
    const byId = {};
    for (const d of (c.days || [])) for (const b of (d.blocks || [])) if (b.id) byId[b.id] = byId[b.id] || b;
    for (const d of (c.days || [])) {
      const wd = d.day;
      if (!d.working || d.no_commitment) continue;
      for (const b of (d.blocks || [])) {
        if (b.kind !== "one") continue;
        const st = (b.weekday_status || {})[wd];
        if (st === "suppress" || st === "off") continue;
        const lo = (b.count || [0, 0])[0];
        if (lo <= 0) continue;                       // firm commitments only
        const L = resolveLocation(b.location || {}, byId);
        const dirn = String(b.direction || "").toUpperCase();
        const label = L.zone || (L.mtype === "flexible"
          ? "Anywhere (no location constraint)" : "Directional area");
        for (const bu of (b.bus || [])) {
          if (!bu.client) continue;
          for (const sh of (b.anchor_shifts || [])) {
            const key = `${wd}|${normClient(bu.client)}|${dirn}|${sh}`;
            const e = req[key] || (req[key] = { client: bu.client, locs: {} });
            const z = e.locs[label] || (e.locs[label] = {
              n: 0, hard: 0, cabs: [], mt: L.mtype,
              c: L.coord, r: L.scope > 1e6 ? null : Math.round(L.scope * 100) / 100,
            });
            z.n += lo;
            if (b.firmness === "hard") z.hard += lo;
            if (!z.cabs.includes(cid)) z.cabs.push(cid);
          }
        }
      }
    }
  }
  const shifts = {};
  for (const k of Object.keys(req)) {
    const [, bu, dirn, sh] = k.split("|");
    ((shifts[bu] = shifts[bu] || {})[dirn] = shifts[bu][dirn] || new Set()).add(sh);
  }
  for (const b in shifts) for (const d in shifts[b]) shifts[b][d] = [...shifts[b][d]].sort();
  return {
    req, shifts,
    meta: {
      city: plan.city || "", start: plan.plan_start || "", end: plan.plan_end || "",
      cabs: cabCount, combos: Object.keys(req).length,
      locs: Object.values(req).reduce((n, v) => n + Object.keys(v.locs).length, 0),
    },
  };
}

/* ---------- trips -> reconciliation ---------- */
function reconcile(locs, trips, dir, dcoName) {
  const isDco = (v) => String(v || "").trim().toLowerCase() === dcoName.toLowerCase();
  const seen = {};
  for (const t of trips) {
    const id = String(t.trip_id ?? "").replace(/[^0-9A-Za-z]/g, "");
    if (!id || seen[id]) continue;
    seen[id] = {
      id,
      vendor: String(t.subvendor_name || t.vendor_name || "").trim(),
      anchor: dir === "LOGIN" ? geo(t.planned_pickup_geo) : geo(t.planned_drop_geo),
      addr: String((dir === "LOGIN" ? t.pickup_address : t.drop_location) || ""),
    };
  }
  const all = Object.values(seen);

  // tightest scope claims first, mirroring smallest-scope-wins
  const zones = Object.entries(locs)
    .filter(([, z]) => z.mt === "specific" && z.c)
    .sort((a, b) => (a[1].r || 99) - (b[1].r || 99));

  const taken = {};
  const rows = zones.map(([label, z]) => {
    const inside = all
      .filter((t) => !taken[t.id] && t.anchor && km(t.anchor, z.c) <= Math.max(z.r || 3, 1))
      .sort((p, q) => km(p.anchor, z.c) - km(q.anchor, z.c));
    const dco = inside.filter((t) => isDco(t.vendor));
    const other = inside.filter((t) => t.vendor && !isDco(t.vendor));
    const none = inside.filter((t) => !t.vendor);
    dco.slice(0, z.n).forEach((t) => (taken[t.id] = 1));
    const have = Math.min(dco.length, z.n);
    const gap = z.n - have;
    const movable = [...none, ...other].slice(0, gap);
    movable.forEach((t) => (taken[t.id] = 1));
    return {
      label, need: z.n, hard: z.hard, cabs: z.cabs, r: z.r, centre: z.c,
      have, gap, movable, dco, other, none,
      generate: Math.max(0, gap - movable.length),
      dist: (t) => Math.round(km(t.anchor, z.c) * 10) / 10,
    };
  });

  const loose = Object.entries(locs)
    .filter(([, z]) => z.mt !== "specific" || !z.c)
    .map(([label, z]) => ({ label, need: z.n, cabs: z.cabs }));
  return { rows, loose, all, unclaimed: all.filter((t) => !taken[t.id]) };
}

/* ---------- fetching ---------- */
async function getTrips(bu, dir, shift, date) {
  const pasted = $("paste").value.trim();
  if (pasted) return unwrap(JSON.parse(pasted));
  const ep = $("ep").value.trim();
  const qs = `bunit_id=${encodeURIComponent(bu)}&shift=${encodeURIComponent(dir + " " + shift)}&date=${encodeURIComponent(date)}`;
  // Netlify function proxy avoids the browser's cross-origin block on Apps Script
  const url = ep ? `/.netlify/functions/trips?${qs}&endpoint=${encodeURIComponent(ep)}`
                 : `/.netlify/functions/trips?${qs}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Data service returned HTTP ${r.status}. ${await r.text().catch(() => "")}`.slice(0, 220));
  return unwrap(await r.json());
}
function unwrap(d) {
  if (Array.isArray(d)) return d;
  for (const k of ["data", "rows", "trips", "result"]) if (Array.isArray(d[k])) return d[k];
  throw new Error("Response was not a list of trips");
}

/* ---------- rendering ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function render(ctx, R) {
  const dco = META.dco;
  const need = R.rows.reduce((n, z) => n + z.need, 0);
  const have = R.rows.reduce((n, z) => n + z.have, 0);
  const give = R.rows.reduce((n, z) => n + z.movable.length, 0);
  const gen = R.rows.reduce((n, z) => n + z.generate, 0);
  const looseNeed = R.loose.reduce((n, z) => n + z.need, 0);

  let h = `<div class="combo"><b>${esc(ctx.bu)}</b> / <b>${ctx.dir} ${esc(ctx.shift)}</b> / <b>${ctx.date}</b>
    <span class="tripcount">${R.all.length} trips on this shift</span></div>
  <div class="score">
    <div class="sc"><div class="k">Routes required</div><div class="v">${need}</div></div>
    <div class="sc dco"><div class="k">Already on ${esc(dco)}</div><div class="v">${have}</div></div>
    <div class="sc act"><div class="k">Give to ${esc(dco)}</div><div class="v">${give}</div></div>
    <div class="sc gen"><div class="k">Generate</div><div class="v">${gen}</div></div>
  </div>`;

  /* 1 */
  h += `<section><div class="sec-h"><span class="sn">1</span><h2>What the plan requires here</h2>
    <span class="hint">Each row is a location the plan pins a cab to on this shift, and how many are already fulfilled.</span></div>
    <div class="panel"><table><thead><tr><th>Location</th><th class="num">Required</th>
      <th class="num">On ${esc(dco)}</th><th class="num">Gap</th><th class="barcell">Fulfilled</th><th>Cabs</th></tr></thead><tbody>`;
  if (!R.rows.length) h += `<tr><td colspan="6" class="empty-msg">No location-constrained cabs planned for this shift.</td></tr>`;
  for (const z of R.rows) {
    const cls = z.gap === 0 ? "r-full" : (z.have ? "r-part" : "r-empty");
    h += `<tr class="${cls}"><td class="loc"><span class="dot"></span>${esc(z.label)}
        <span class="mt">${z.r ?? "–"} km</span>${z.hard ? `<span class="mt hard">HARD</span>` : ""}</td>
      <td class="num">${z.need}</td>
      <td class="num ${z.have ? "strong" : "zero"}">${z.have}</td>
      <td class="num ${z.gap ? "gap" : "zero"}">${z.gap || "&mdash;"}</td>
      <td class="barcell"><span class="bar"><span class="fill" style="width:${z.need ? z.have / z.need * 100 : 0}%"></span></span></td>
      <td class="cabs">${z.cabs.map(esc).join("<br>")}</td></tr>`;
  }
  h += `</tbody></table></div>`;
  if (looseNeed) h += `<p class="planning-note">A further <b>${looseNeed}</b> planned route${looseNeed > 1 ? "s" : ""} on this
    shift carry no location constraint — any route here can serve them.</p>`;
  h += `</section>`;

  /* 2 */
  const moves = R.rows.filter((z) => z.movable.length);
  h += `<section><div class="sec-h"><span class="sn">2</span>
    <h2>Give these to ${esc(dco)} <span class="cnt">${give} route${give === 1 ? "" : "s"}</span></h2>
    <span class="hint">A trip already exists for these — with another vendor, or unallocated. Move it on the MDS allocation screen.</span></div>`;
  if (!moves.length) {
    h += `<div class="panel"><p class="empty-msg">Nothing to move — every location that has a trip is already on ${esc(dco)}.</p></div>`;
  } else {
    h += `<div class="cards">`;
    for (const z of moves) {
      const ids = z.movable.map((t) => t.id).join("\n");
      h += `<div class="card"><div class="card-h">
          <div><div class="card-title">${esc(z.label)}</div>
            <div class="card-sub">needs ${z.need} · ${z.have} on ${esc(dco)} · ${z.movable.length} to move</div></div>
          <button class="copy" data-ids="${esc(ids)}">Copy ${z.movable.length} ID${z.movable.length > 1 ? "s" : ""}</button>
        </div><ul class="trips">`;
      for (const t of z.movable) {
        h += `<li><span class="pill ${t.vendor ? "swap" : "grab"}">${t.vendor ? "SWAP" : "GRAB"}</span>
          <code>${esc(t.id)}</code>
          <span class="vend">${t.vendor ? esc(t.vendor) : "no vendor yet"}</span>
          <span class="dist">${z.dist(t)} km${t.addr ? " · " + esc(t.addr.slice(0, 40)) : ""}</span></li>`;
      }
      h += `</ul></div>`;
    }
    h += `</div>`;
  }
  h += `</section>`;

  /* 3 */
  const gens = R.rows.filter((z) => z.generate > 0);
  h += `<section><div class="sec-h"><span class="sn">3</span>
    <h2>Generate a route <span class="cnt">${gens.length} location${gens.length === 1 ? "" : "s"}</span></h2>
    <span class="hint">No vendor has a trip here at all. Swapping cannot fix these — a route has to be created.</span></div>
    <div class="panel gen"><table><thead><tr><th>Location</th><th class="num">Routes short</th><th>Cabs waiting</th></tr></thead><tbody>`;
  if (!gens.length) {
    h += `<tr><td colspan="3" class="empty-msg">Every required location has a trip somewhere — nothing to generate.</td></tr>`;
  } else {
    for (const z of gens) {
      h += `<tr><td class="loc"><span class="dot warn"></span>${esc(z.label)}
          <span class="mt">${z.r ?? "–"} km</span></td>
        <td class="num gap">${z.generate}</td>
        <td class="cabs">${z.cabs.map(esc).join(", ")}</td></tr>`;
    }
  }
  h += `</tbody></table></div>
    <p class="planning-note">Section 3 is a planning action, not an ops swap — the route is created upstream, then allocated to ${esc(dco)}.</p></section>`;

  $("out").innerHTML = h;
  $("out").querySelectorAll(".copy").forEach((b) =>
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(b.dataset.ids).then(() => {
        const t = b.textContent; b.textContent = "Copied"; b.classList.add("done");
        setTimeout(() => { b.textContent = t; b.classList.remove("done"); }, 1400);
      });
    }));
}

/* ---------- plan loading ---------- */
function activate(built, note) {
  REQ = built.req; SHIFTS = built.shifts;
  META = Object.assign({ dco: "DCO MIS" }, built.meta);
  $("upload").hidden = true; $("app").hidden = false;
  $("hmeta").textContent =
    `PLAN ${META.start} – ${META.end} · ${META.cabs} CABS · ${META.combos} SHIFT COMBINATIONS · ${META.locs} LOCATION REQUIREMENTS`;
  $("hcity").textContent = META.city ? "· " + META.city : "";
  $("bulist").innerHTML = Object.keys(SHIFTS).sort().map((b) => `<option value="${b}">`).join("");
  if (note) { $("plannote").textContent = note; }
  const d = $("date");
  if (!d.value && META.start) d.value = META.start;
}

function loadPlanFile(file) {
  $("upstatus").textContent = `Reading ${file.name}…`;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const plan = JSON.parse(fr.result);
      const built = buildRequirements(plan);
      if (!built.meta.combos) throw new Error("No firm commitments found in this plan.");
      try { localStorage.setItem(STORE, JSON.stringify(built)); } catch (e) { /* too big; session only */ }
      activate(built, `${file.name} · loaded just now`);
    } catch (e) {
      $("upstatus").innerHTML = `<span class="bad">Could not read that file — ${esc(e.message)}</span>`;
    }
  };
  fr.readAsText(file);
}

/* ---------- wiring ---------- */
(async function init() {
  const z = await fetch("zones.json").then((r) => r.json()).catch(() => ({ zones: {}, regions: {} }));
  ZONES = z.zones || {}; REGIONS = z.regions || {};

  const cached = localStorage.getItem(STORE);
  if (cached) {
    try { activate(JSON.parse(cached), "using the plan saved in this browser"); } catch (e) { }
  }

  $("file").addEventListener("change", (e) => e.target.files[0] && loadPlanFile(e.target.files[0]));
  const dz = $("drop");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && loadPlanFile(e.dataTransfer.files[0]));

  $("newplan").addEventListener("click", () => {
    localStorage.removeItem(STORE);
    $("app").hidden = true; $("upload").hidden = false; $("upstatus").textContent = "";
  });

  const refresh = () => {
    const b = normClient($("bu").value), d = $("dir").value;
    const list = ((SHIFTS[b] || {})[d] || []);
    $("shlist").innerHTML = list.map((s) => `<option value="${s}">`).join("");
  };
  ["bu", "dir"].forEach((i) => $(i).addEventListener("input", refresh));

  $("go").addEventListener("click", async () => {
    const bu = $("bu").value.trim(), date = $("date").value,
          dir = $("dir").value, shift = $("shift").value.trim();
    if (!bu || !date || !shift) {
      $("out").innerHTML = `<div class="msg err"><h2>Missing details</h2>Business unit, date and shift are all needed.</div>`;
      return;
    }
    const wd = WD[new Date(date + "T12:00:00").getDay()];
    const entry = REQ[`${wd}|${normClient(bu)}|${dir}|${shift}`];
    if (!entry) {
      const avail = ((SHIFTS[normClient(bu)] || {})[dir] || []);
      $("out").innerHTML = `<div class="msg err"><h2>The plan asks for nothing here</h2>
        No firm commitment for ${esc(bu)} · ${dir} · ${esc(shift)} on ${wd}.
        ${avail.length ? "Shifts the plan does need: <b>" + avail.map(esc).join(", ") + "</b>"
                       : "This business unit has no planned " + dir.toLowerCase() + " work."}</div>`;
      return;
    }
    $("go").disabled = true; $("go").textContent = "Checking…";
    $("out").innerHTML = `<div class="msg"><h2>Pulling trips</h2>${esc(bu)} · ${dir} ${esc(shift)} · ${date}</div>`;
    try {
      const trips = await getTrips(bu, dir, shift, date);
      if (!trips.length) {
        $("out").innerHTML = `<div class="msg err"><h2>No trips came back</h2>
          Nothing returned for ${esc(bu)} ${dir} ${esc(shift)} on ${date}.
          Check the business unit id matches what the data service expects.</div>`;
      } else {
        render({ bu, dir, shift, date }, reconcile(entry.locs, trips, dir, META.dco));
      }
    } catch (err) {
      $("out").innerHTML = `<div class="msg err"><h2>Could not load the trips</h2>${esc(err.message)}
        <br><br>You can paste the API response under “Data source” instead.</div>`;
    }
    $("go").disabled = false; $("go").textContent = "Check shift";
  });
})();
