# DCO allocation check — Netlify deployment

Static site. All logic runs in the browser; one serverless function proxies the
trip API to avoid the browser's cross-origin block on Apps Script.

## Deploy

1. Push this folder to a Git repo, then in Netlify: **Add new site → Import from
   Git**. Publish directory `.`, functions directory `netlify/functions`
   (already set in `netlify.toml`, so accept the defaults).
   Or drag the folder onto Netlify's **Deploys** tab — but functions only work
   from a Git deploy or the CLI.

2. Set the environment variables under **Site configuration → Environment variables**:

   | Key | Value |
   |---|---|
   | `TRIPS_ENDPOINT` | `https://script.google.com/macros/s/<ID>/exec` |
   | `TRIPS_SECRET` | optional shared secret, sent as `&key=` |

3. Redeploy so the function picks up the variables.

## Why the proxy

The browser cannot call `script.google.com` directly from another origin —
Apps Script does not return usable CORS headers on the redirect it issues.
`netlify/functions/trips.js` makes the call server-side, so there is no CORS,
the endpoint URL is never exposed to the client, and a secret can be attached.

If you leave `TRIPS_ENDPOINT` unset, the app still works: paste the endpoint in
the **Data source** panel, or paste a JSON response directly.

## Securing the endpoint

The Apps Script deployment has to be "Anyone", so the URL is the only thing
protecting employee pickup coordinates. Add a `key` check inside `doGet`:

```javascript
function doGet(e) {
  if (e.parameter.key !== 'YOUR-SECRET') {
    return ContentService.createTextOutput(JSON.stringify({error:'unauthorised'}))
      .setMimeType(ContentService.MimeType.JSON);
  }
  ...
}
```

Then set the same value as `TRIPS_SECRET` in Netlify. The browser never sees it.

## Files

| File | What |
|---|---|
| `index.html` | shell, upload screen, controls, styles |
| `app.js` | all logic — plan parsing, location resolution, reconciliation, rendering |
| `zones.json` | 209 KML zone centroids + derived regions, pre-baked |
| `netlify/functions/trips.js` | server-side proxy |

## Keeping in sync with production

`resolveLocation` in `app.js` is a direct port of `_resolve_location` from
`services/cab_recommender.py`, and `SHIFT_TOL_MIN = 45` matches the production
constant. Verified against the Python on the live plan: 1,541 shift combinations
and 3,352 location requirements, zero mismatches.

**If the Python changes, re-port.** If they drift, this tool will tell ops to
move trips that MDS then refuses to recommend a cab for.

## How the plan is handled

Uploaded in the browser, parsed client-side, never sent anywhere. The derived
requirements (~440 KB) are cached in `localStorage`, so the upload is only
needed when the plan changes. **New plan** clears it.
