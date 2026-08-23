// Server-side proxy to the Apps Script endpoint.
// Browsers block the cross-origin call to script.google.com; this runs on
// Netlify's side, so there is no CORS involved and the endpoint URL (and any
// shared secret) never reaches the client.
export default async (request) => {
  const url = new URL(request.url);
  const bunit_id = url.searchParams.get("bunit_id");
  const shift = url.searchParams.get("shift");
  const date = url.searchParams.get("date");

  // Prefer the endpoint configured on the site; fall back to one supplied by
  // the caller so the app still works before the env var is set.
  const endpoint = process.env.TRIPS_ENDPOINT || url.searchParams.get("endpoint");
  const secret = process.env.TRIPS_SECRET || "";

  if (!endpoint) {
    return json({ error: "TRIPS_ENDPOINT is not configured on this site." }, 500);
  }
  if (!bunit_id || !shift || !date) {
    return json({ error: "bunit_id, shift and date are all required." }, 400);
  }

  const qs = new URLSearchParams({ bunit_id, shift, date });
  if (secret) qs.set("key", secret);

  try {
    const r = await fetch(`${endpoint}?${qs}`, { redirect: "follow" });
    const text = await r.text();
    if (!r.ok) return json({ error: `Upstream ${r.status}`, body: text.slice(0, 400) }, 502);
    try {
      return json(JSON.parse(text), 200);
    } catch {
      // Apps Script returns an HTML error page when the deployment is wrong
      return json({ error: "Upstream did not return JSON — check the deployment "
                         + "is public and doGet exists.", body: text.slice(0, 300) }, 502);
    }
  } catch (e) {
    return json({ error: "Could not reach the endpoint: " + e.message }, 502);
  }
};

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const config = { path: "/.netlify/functions/trips" };
