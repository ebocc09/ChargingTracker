#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   Charging Tracker — local Garage proxy
   ───────────────────────────────────────────────────────────────────────────
   Serves the dashboard and bridges it to Garage's MCP endpoint.

   Why a proxy is required: Garage's /mcp answers a CORS preflight with no
   Access-Control-Allow-Origin header, so a browser page can never call it
   directly. This process makes the call server-side instead.

   Auth is the standard MCP OAuth flow against Bouncer, performed by THIS
   process on behalf of whoever is running it:

     1. Dynamic client registration   POST bouncer/oauth/register
     2. Authorization code + PKCE     GET  bouncer/oauth/authorize
     3. Callback on localhost         GET  /callback
     4. Token exchange / refresh      POST bouncer/oauth/token
     5. Authorised JSON-RPC           POST garage/mcp

   No secrets are baked in and nothing is shared between users — every person
   who clones this repo signs into Bouncer as themselves and receives their
   own token with their own Garage permissions.

   Zero dependencies. Node 18+.
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

const http    = require("node:http");
const https   = require("node:https");
const crypto  = require("node:crypto");
const fs      = require("node:fs");
const path    = require("node:path");
const { URL, URLSearchParams } = require("node:url");
const { exec, execFile } = require("node:child_process");

/* ───────────────────────────── Configuration ───────────────────────────── */

const CONFIG = {
  port: Number(process.env.PORT || 3118),

  // Which Garage instance to talk to. Override with GARAGE_URL for eu / cn /
  // engineering environments — see README.
  garageUrl: process.env.GARAGE_URL || "https://garage.vn.teslamotors.com",

  // How far back to look for a USOE snapshot. Datatank serves cached
  // snapshots, so the vehicle does not need to be online right now.
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 6),

  // Don't re-query Garage for the same VIN more often than this.
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 10_000),

  // Hard ceiling on concurrent Garage calls. The dashboard throttles itself,
  // but this backstops it — several open tabs, or a script hitting /api/usoe
  // directly, still cannot fan out past this.
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 4),

  tokenFile: path.join(__dirname, ".tokens.json"),
  clientFile: path.join(__dirname, ".client.json"),
  teamsFile : path.join(__dirname, ".teams.json"),
  garageFile: path.join(__dirname, ".garage.json"),

  // Live vitals. Opt-in — see the "Live vitals" section below for why.
  // TTL matches cacheTtlMs so a short refresh interval is never served a
  // stale "live" reading. Concurrency matches the MCP path, since with live
  // read on every monitored vehicle goes through here.
  liveTtlMs        : Number(process.env.LIVE_TTL_MS || 10_000),
  liveMaxConcurrent: Number(process.env.LIVE_MAX_CONCURRENT || 4),

  // How a charge-complete alert reaches Teams:
  //   "webhook" — POST the Adaptive Card straight to a Power Automate flow URL.
  //   "outlook" — hand a message to the local Outlook client over COM, for a
  //               flow whose trigger is "When a new email arrives (V3)".
  //   "auto"    — webhook when one is configured, otherwise outlook.
  // See "Microsoft Teams alerts" in the README for why outlook exists.
  transport: process.env.ALERT_TRANSPORT || "auto",

  // Mailbox the Outlook transport sends to. Blank = your own address, read
  // from the Outlook profile at send time.
  alertEmailTo: process.env.ALERT_EMAIL_TO || "",

  // Marker the flow's subject filter matches on. Changing it means changing
  // the filter in Power Automate to match.
  alertSubjectTag: process.env.ALERT_SUBJECT_TAG || "[CHARGING-TRACKER]",

  // Suppress a repeat Teams alert for the same VIN inside this window, so a
  // page refresh or a re-added vehicle doesn't post the message twice.
  teamsDedupeMs: Number(process.env.TEAMS_DEDUPE_MS || 2 * 60 * 60 * 1000),

  mcpProtocolVersion: "2025-06-18",
  scope: "garage:mcp offline_access"
};

const MCP_URL      = CONFIG.garageUrl.replace(/\/+$/, "") + "/mcp";
const REDIRECT_URI = `http://localhost:${CONFIG.port}/callback`;

const log = (...a) => console.log("[charging-tracker]", ...a);
const warn = (...a) => console.warn("[charging-tracker]", ...a);

/* ───────────────────────────── Tiny HTTPS helper ───────────────────────────── */

function request(urlStr, { method = "GET", headers = {}, body = null } = {}){
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status : res.statusCode,
        headers: res.headers,
        body   : Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.setTimeout(45_000, () => req.destroy(new Error("Request to " + url.hostname + " timed out")));
    if(body) req.write(body);
    req.end();
  });
}

function postForm(url, fields){
  const body = new URLSearchParams(fields).toString();
  return request(url, {
    method : "POST",
    headers: {
      "Content-Type"  : "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "Accept"        : "application/json"
    },
    body
  });
}

function postJson(url, obj, extraHeaders = {}){
  const body = JSON.stringify(obj);
  return request(url, {
    method : "POST",
    headers: Object.assign({
      "Content-Type"  : "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Accept"        : "application/json, text/event-stream"
    }, extraHeaders),
    body
  });
}

/* ───────────────────────────── Token / client store ───────────────────────────── */

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeJson(file, obj){
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

let tokens = readJson(CONFIG.tokenFile);   // { access_token, refresh_token, expires_at }
let client = readJson(CONFIG.clientFile);  // { client_id, client_secret? }

/* ───────────────────────────── OAuth: discovery ───────────────────────────── */

let authServerMeta = null;

async function discover(){
  if(authServerMeta) return authServerMeta;

  // Ask the resource which authorization server it trusts, per RFC 9728.
  const prUrl = CONFIG.garageUrl.replace(/\/+$/, "") + "/.well-known/oauth-protected-resource";
  const pr = await request(prUrl, { headers: { Accept: "application/json" } });
  if(pr.status !== 200) throw new Error(`Protected-resource discovery failed (HTTP ${pr.status})`);

  const prMeta = JSON.parse(pr.body);
  const issuer = (prMeta.authorization_servers || [])[0];
  if(!issuer) throw new Error("Garage did not advertise an authorization server");

  const asUrl = issuer.replace(/\/+$/, "") + "/.well-known/oauth-authorization-server";
  const as = await request(asUrl, { headers: { Accept: "application/json" } });
  if(as.status !== 200) throw new Error(`Authorization-server discovery failed (HTTP ${as.status})`);

  authServerMeta = JSON.parse(as.body);
  log("auth server:", authServerMeta.issuer);
  return authServerMeta;
}

/* ───────────────────────────── OAuth: registration ───────────────────────────── */

async function ensureClient(){
  if(client && client.client_id) return client;

  const meta = await discover();
  if(!meta.registration_endpoint) throw new Error("Bouncer does not expose dynamic client registration");

  const res = await postJson(meta.registration_endpoint, {
    client_name               : "Charging Tracker",
    redirect_uris             : [REDIRECT_URI],
    grant_types               : ["authorization_code", "refresh_token"],
    response_types            : ["code"],
    token_endpoint_auth_method: "none",
    scope                     : CONFIG.scope
  });

  if(res.status !== 200 && res.status !== 201){
    throw new Error(`Client registration failed (HTTP ${res.status}): ${res.body.slice(0, 400)}`);
  }

  client = JSON.parse(res.body);
  writeJson(CONFIG.clientFile, client);
  log("registered OAuth client:", client.client_id);
  return client;
}

/* ───────────────────────────── OAuth: authorization code + PKCE ───────────────────────────── */

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let pending = null;   // { verifier, state, resolve, reject }

async function buildAuthorizeUrl(){
  const meta = await discover();
  await ensureClient();

  const verifier  = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));

  pending = { verifier, state };

  const params = new URLSearchParams({
    response_type        : "code",
    client_id            : client.client_id,
    redirect_uri         : REDIRECT_URI,
    scope                : CONFIG.scope,
    state,
    code_challenge       : challenge,
    code_challenge_method: "S256",
    // RFC 8707 — bind the token to this specific MCP resource.
    resource             : MCP_URL
  });

  return meta.authorization_endpoint + "?" + params.toString();
}

async function exchangeCode(code){
  const meta = await discover();
  const res = await postForm(meta.token_endpoint, {
    grant_type   : "authorization_code",
    code,
    redirect_uri : REDIRECT_URI,
    client_id    : client.client_id,
    code_verifier: pending.verifier,
    resource     : MCP_URL
  });
  if(res.status !== 200) throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.body.slice(0, 400)}`);
  storeTokens(JSON.parse(res.body));
}

async function refreshTokens(){
  if(!tokens || !tokens.refresh_token) return false;
  const meta = await discover();
  const res = await postForm(meta.token_endpoint, {
    grant_type   : "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id    : client.client_id,
    resource     : MCP_URL
  });
  if(res.status !== 200){
    warn("refresh failed (HTTP " + res.status + ") — re-authentication required");
    tokens = null;
    try { fs.unlinkSync(CONFIG.tokenFile); } catch {}
    return false;
  }
  storeTokens(JSON.parse(res.body));
  log("access token refreshed");
  return true;
}

function storeTokens(t){
  tokens = {
    access_token : t.access_token,
    refresh_token: t.refresh_token || (tokens && tokens.refresh_token) || null,
    // Renew a minute early so a call never lands on an expiring token.
    expires_at   : Date.now() + ((t.expires_in || 3600) - 60) * 1000
  };
  writeJson(CONFIG.tokenFile, tokens);
  mcpSession = null;   // a new identity needs a new MCP session
}

async function accessToken(){
  if(tokens && tokens.access_token && Date.now() < tokens.expires_at) return tokens.access_token;
  if(tokens && tokens.refresh_token && await refreshTokens()) return tokens.access_token;
  return null;
}

const isAuthed = () => Boolean(tokens && tokens.access_token);

/* ───────────────────────────── MCP client ─────────────────────────────
   Streamable HTTP transport. Responses arrive either as plain JSON or as
   an SSE stream, so both shapes have to be handled.                      */

let mcpSession = null;

function parseMcpBody(res){
  const ctype = String(res.headers["content-type"] || "");
  if(ctype.includes("text/event-stream")){
    // Take the last complete `data:` payload in the stream.
    let last = null;
    for(const line of res.body.split(/\r?\n/)){
      if(!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if(payload && payload !== "[DONE]") last = payload;
    }
    if(!last) throw new Error("SSE stream contained no data frame");
    return JSON.parse(last);
  }
  return JSON.parse(res.body);
}

async function mcpRpc(method, params, { isNotification = false } = {}){
  const token = await accessToken();
  if(!token){ const e = new Error("Not authenticated with Garage"); e.needsAuth = true; throw e; }

  const headers = {
    "Authorization"       : "Bearer " + token,
    "MCP-Protocol-Version": CONFIG.mcpProtocolVersion
  };
  if(mcpSession) headers["Mcp-Session-Id"] = mcpSession;

  const payload = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };

  const res = await postJson(MCP_URL, payload, headers);

  if(res.status === 401){
    // Token rejected — try one refresh, then give up and ask for a login.
    mcpSession = null;
    if(await refreshTokens()) return mcpRpc(method, params, { isNotification });
    const e = new Error("Garage rejected the access token"); e.needsAuth = true; throw e;
  }
  if(res.status === 404 && mcpSession){
    // Session expired server-side; re-initialize and retry once.
    mcpSession = null;
    await mcpInit();
    return mcpRpc(method, params, { isNotification });
  }
  if(res.status >= 400) throw new Error(`Garage MCP returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);

  const sid = res.headers["mcp-session-id"];
  if(sid) mcpSession = sid;

  if(isNotification || res.status === 202 || !res.body.trim()) return null;

  const parsed = parseMcpBody(res);
  if(parsed.error) throw new Error(`Garage MCP error ${parsed.error.code}: ${parsed.error.message}`);
  return parsed.result;
}

async function mcpInit(){
  if(mcpSession) return;
  await mcpRpc("initialize", {
    protocolVersion: CONFIG.mcpProtocolVersion,
    capabilities   : {},
    clientInfo     : { name: "charging-tracker", version: "1.0.0" }
  });
  await mcpRpc("notifications/initialized", {}, { isNotification: true });
  log("MCP session established");
}

async function callTool(name, args){
  await mcpInit();
  const result = await mcpRpc("tools/call", { name, arguments: args });

  if(result && result.isError){
    const text = (result.content || []).map(c => c.text).filter(Boolean).join(" ");
    throw new Error(text || "Tool reported an error");
  }
  // Tool payloads come back as a text block holding JSON.
  if(result && result.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  if(!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/* ───────────────────────────── USOE lookup ─────────────────────────────
   Reads the USOE vitals column specifically. USOE (usable state of energy)
   and SOC are two separate columns in Garage — USOE is the customer-facing
   number and the one this dashboard tracks.                              */

const cache = new Map();   // vin -> { cachedAt, value }

/* Counting semaphore. Callers queue rather than being rejected, so a burst
   is slowed down instead of dropped. */
let inFlight = 0;
const waiting = [];

async function withSlot(fn){
  if(inFlight >= CONFIG.maxConcurrent){
    await new Promise(resolve => waiting.push(resolve));
  }
  inFlight++;
  try{
    return await fn();
  }finally{
    inFlight--;
    const next = waiting.shift();
    if(next) next();
  }
}

/* Collapse concurrent requests for the same VIN into one Garage call —
   with 100 VINs across a couple of tabs this saves a lot of duplicate work. */
const inFlightByVin = new Map();

/* Shape returned by device_historical_vitals:
     { count, hours, asc,
       rows:   [ { USOE: 68.792, source: "was_charging", txid, time } , … ],
       fields: [ { name: "USOE", value_type: "numeric", min, max } ] }

   Two things worth knowing, both verified against live Garage responses:
     · rows arrive OLDEST-first even when asc:false is requested, so the
       newest reading has to be selected by timestamp, not by position;
     · `fields` is an array of column descriptors, not an object keyed
       by column name.                                                    */
function extractUsoe(payload){
  if(!payload) return null;

  const rows = payload.rows || payload.data || payload.results;
  if(Array.isArray(rows) && rows.length){
    let best = null;
    for(const row of rows){
      const raw = row.USOE ?? row.usoe ?? row.value;
      const val = typeof raw === "string" ? Number(raw) : raw;
      if(typeof val !== "number" || Number.isNaN(val)) continue;

      const stamp = row.time || row.timestamp || row.ts || null;
      const t = stamp ? (Date.parse(stamp) || 0) : 0;
      if(!best || t >= best.t) best = { t, val, at: stamp };
    }
    if(best) return { usoe: best.val, at: best.at };
  }

  // Fallback: pull a value out of the column summary.
  const fields = payload.fields;
  const desc = Array.isArray(fields)
    ? fields.find(f => String(f.name).toUpperCase() === "USOE")
    : (fields && (fields.USOE || fields.usoe));
  if(desc){
    for(const k of ["last", "latest", "value", "max"]){
      if(typeof desc[k] === "number") return { usoe: desc[k], at: null };
    }
  }
  return null;
}

async function getUsoe(vin){
  const hit = cache.get(vin);
  if(hit && Date.now() - hit.cachedAt < CONFIG.cacheTtlMs) return hit.value;

  // Already fetching this VIN? Join that request rather than issuing a second.
  const pendingCall = inFlightByVin.get(vin);
  if(pendingCall) return pendingCall;

  const call = withSlot(async () => {
    const payload = await callTool("device_historical_vitals", {
      device_id: vin,
      fields   : ["USOE"],
      hours    : CONFIG.lookbackHours,
      asc      : false
    });

    const found = extractUsoe(payload);
    if(!found){
      throw new Error(`No USOE snapshot for ${vin} in the last ${CONFIG.lookbackHours}h`);
    }

    const value = {
      usoe      : Math.max(0, Math.min(100, found.usoe)),
      readingAt : found.at,
      samples   : payload.count ?? (payload.rows || []).length
    };
    cache.set(vin, { cachedAt: Date.now(), value });
    return value;
  }).finally(() => inFlightByVin.delete(vin));

  inFlightByVin.set(vin, call);
  return call;
}

/* ───────────────────────────── Geofence (TRT) ─────────────────────────────
   Which Tesla facility geofence a vehicle currently sits in. Read from
   Tesladex rather than vitals: GUI_trtId exists as a vitals column but is
   empty on customer cars, whereas Tesladex carries a populated
   `tesla_facility` block plus a top-level `trt_id`.

   Looked up in BATCHES. Tesladex accepts vin:(A OR B OR C), so a 100-VIN
   list costs two queries instead of a hundred — which matters given how
   carefully the rest of the polling is throttled.                          */

const geoCache = new Map();   // vin -> { at, value }
const GEO_TTL  = Number(process.env.GEO_TTL_MS || 5 * 60 * 1000);
const GEO_CHUNK = 50;

async function getGeofences(vins){
  const out = {}, need = [];

  for(const vin of vins){
    const hit = geoCache.get(vin);
    if(hit && Date.now() - hit.at < GEO_TTL) out[vin] = hit.value;
    else need.push(vin);
  }

  for(let i = 0; i < need.length; i += GEO_CHUNK){
    const chunk = need.slice(i, i + GEO_CHUNK);

    const payload = await withSlot(() => callTool("tesladex_search", {
      query : "vin:(" + chunk.join(" OR ") + ")",
      fields: ["vin", "trt_id", "tesla_facility"],
      size  : chunk.length
    }));

    const rows = (payload && (payload.results || payload.rows)) || [];
    const seen = new Set();

    for(const r of rows){
      if(!r || !r.vin) continue;
      const fac = r.tesla_facility || null;
      const value = {
        trtId: r.trt_id == null ? null : Number(r.trt_id),
        name : fac && fac.name     ? fac.name     : null,
        site : fac && fac.sub_name ? fac.sub_name : null,
        type : fac && fac.type     ? fac.type     : null
      };
      geoCache.set(r.vin, { at: Date.now(), value });
      out[r.vin] = value;
      seen.add(r.vin);
    }

    // A VIN Tesladex didn't return has no facility — record that definitively
    // rather than leaving it unknown and re-querying every sweep.
    for(const vin of chunk){
      if(seen.has(vin)) continue;
      const value = { trtId: null, name: null, site: null, type: null };
      geoCache.set(vin, { at: Date.now(), value });
      out[vin] = value;
    }
  }

  return out;
}

/* ───────────────────────────── Live vitals ─────────────────────────────
   The Garage web UI reads current vitals from GET /vehicles/<id>/vitals.
   That endpoint is session-authenticated: a Bouncer token gets exactly the
   same 401 as sending no credential at all, so it needs a cookie copied out
   of a signed-in browser. That is why this is opt-in and off by default.

   Two measured properties shape how it is used:

     · The response is ~140 KB per vehicle — the entire vitals dump, ~4,475
       fields, to obtain two numbers. A cached snapshot is a few hundred
       bytes, so a 100-vehicle sweep moves roughly 14 MB. With live read on,
       every monitored vehicle goes through here anyway: a deliberate call,
       since the lists this runs against are normally small and freshening
       only some vehicles made the dashboard harder to reason about.

     · It is genuinely current. Cached snapshots trail by 8-12 minutes while
       a vehicle is charging, and far longer once it is parked, because the
       car only reports on its own state changes.

   Every failure falls back to the cached path rather than surfacing an
   error — live reading is an accelerator, never a dependency.            */

let live = readJson(CONFIG.garageFile) || { cookie: "", enabled: false, lastError: null };

const liveReady = () => Boolean(live.enabled && live.cookie);

function saveLive(){ writeJson(CONFIG.garageFile, live); }

/* VIN -> numeric Mothership id. The live endpoint is addressed by id, not
   VIN. Ids never change, so this is cached for the life of the process. */
const idCache = new Map();

async function deviceIdFor(vin){
  if(idCache.has(vin)) return idCache.get(vin);

  const payload = await withSlot(() => callTool("tesladex_search", {
    query : "vin:" + vin,
    fields: ["vin", "id"],
    size  : 1
  }));

  const row = ((payload && (payload.results || payload.rows)) || [])[0];
  if(!row || row.id == null) throw new Error(`Tesladex has no numeric id for ${vin}`);

  idCache.set(vin, String(row.id));
  return String(row.id);
}

/* A tighter throttle than the MCP path — these responses are two orders of
   magnitude larger. */
let liveInFlight = 0;
const liveWaiting = [];

async function withLiveSlot(fn){
  if(liveInFlight >= CONFIG.liveMaxConcurrent){
    await new Promise(resolve => liveWaiting.push(resolve));
  }
  liveInFlight++;
  try{ return await fn(); }
  finally{
    liveInFlight--;
    const next = liveWaiting.shift();
    if(next) next();
  }
}

const liveCache = new Map();   // vin -> { at, value }

async function getLiveUsoe(vin){
  if(!live.cookie) throw new Error("No Garage session cookie saved");

  const hit = liveCache.get(vin);
  if(hit && Date.now() - hit.at < CONFIG.liveTtlMs) return hit.value;

  const id  = await deviceIdFor(vin);
  const res = await withLiveSlot(() => request(
    `${CONFIG.garageUrl.replace(/\/+$/, "")}/vehicles/${id}/vitals`,
    { headers: { Accept: "application/json", Cookie: live.cookie,
                 "User-Agent": "Mozilla/5.0 (charging-tracker)" } }
  ));

  if(res.status === 401 || res.status === 403){
    // Garage sessions expire on their own schedule. Switch live off rather
    // than hammering with a dead cookie; the admin panel reports this and
    // asks for a fresh one.
    live.enabled   = false;
    live.lastError = "Session cookie expired or was rejected — paste a fresh one.";
    liveCache.clear();
    saveLive();
    const e = new Error(live.lastError); e.liveExpired = true; throw e;
  }
  if(res.status >= 400) throw new Error(`Live vitals returned HTTP ${res.status}`);

  let body;
  try{ body = JSON.parse(res.body); }
  catch{ throw new Error("Live vitals did not return JSON — the cookie may be a sign-in redirect"); }

  const usoe = Number(body.USOE);
  if(!Number.isFinite(usoe)) throw new Error("Live vitals response carried no USOE");

  const value = {
    usoe     : Math.max(0, Math.min(100, usoe)),
    soc      : Number.isFinite(Number(body.SOC)) ? Number(body.SOC) : null,
    readingAt: body.timestamp || null,
    live     : true
  };

  if(live.lastError){ live.lastError = null; saveLive(); }
  liveCache.set(vin, { at: Date.now(), value });
  return value;
}

/* ───────────────────────────── Microsoft Teams ─────────────────────────────
   Posts to a Power Automate flow using the "When a Teams webhook request is
   received" trigger. That is the supported route now that Microsoft has
   retired the old Office 365 incoming-webhook connectors.

   The call is made here rather than from the browser for two reasons: the
   flow URL contains a signature and shouldn't sit in client-side JavaScript,
   and Power Automate doesn't return CORS headers, so fetch() from the page
   would be blocked anyway.                                                  */

let teams = readJson(CONFIG.teamsFile) || { url: process.env.TEAMS_WEBHOOK_URL || "", alerted: {} };
if(process.env.TEAMS_WEBHOOK_URL) teams.url = process.env.TEAMS_WEBHOOK_URL;

const teamsConfigured = () => Boolean(teams.url);

function saveTeams(){
  // Drop stale dedupe entries so the file doesn't grow without bound.
  const cutoff = Date.now() - CONFIG.teamsDedupeMs;
  for(const [vin, at] of Object.entries(teams.alerted || {})){
    if(at < cutoff) delete teams.alerted[vin];
  }
  writeJson(CONFIG.teamsFile, teams);
}

/* Adaptive Card in the envelope the Workflows trigger forwards verbatim. */
function chargeCompleteCard({ vin, usoe, limit, readingAt }){
  // Labelled SOC because that is what people say, but the value is USOE —
  // see the USOE lookup section for why the two are not interchangeable.
  // `readingAt` is still carried in the flat fields below for the flow.
  const facts = [
    { title: "SOC",    value: `${Number(usoe).toFixed(1)}%` },
    { title: "Target", value: `${Number(limit).toFixed(1)}%` }
  ];

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [
          { type: "ColumnSet", columns: [
            { type: "Column", width: "auto", items: [
              { type: "TextBlock", text: "⚡", size: "ExtraLarge", spacing: "None" }]},
            { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Charging complete", weight: "Bolder",
                size: "Medium", color: "Good", spacing: "None" },
              { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
                isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
          ]},
          { type: "TextBlock", text: vin, size: "Large", weight: "Bolder",
            wrap: true, fontType: "Monospace", spacing: "Medium" },
          { type: "FactSet", facts }
        ]
      }
    }],
    // Flat copies so a hand-built flow can read the values directly.
    event: "charge_complete", vin, usoe, limit, readingAt
  };
}

/* A free-text message, for the admin test button. Carries the text both as an
   Adaptive Card and as a flat `text` field, so a flow can bind to whichever
   shape it already reads. */
function plainMessage(text){
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
            isSubtle: true, size: "Small", spacing: "None", wrap: true },
          { type: "TextBlock", text, wrap: true, spacing: "Small" }
        ]
      }
    }],
    event: "test_message", text
  };
}

async function postToTeams(payload){
  if(!teamsConfigured()) throw new Error("No Teams webhook configured");

  const url = teams.url.trim();
  if(!/^https:\/\//i.test(url)) throw new Error("Teams webhook URL must be https");

  const body = JSON.stringify(payload);
  const res = await request(url, {
    method : "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    body
  });

  // Power Automate answers 200 or 202 on success.
  if(res.status >= 400){
    throw new Error(`Teams webhook returned HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return res.status;
}

/* ───────────────────────────── Outlook transport ─────────────────────────────
   Sends the alert as an ordinary email from the local Outlook client, for a
   Power Automate flow triggered by "When a new email arrives (V3)" with a
   subject filter. The flow then posts to Teams over its own connection.

   Why this exists: the tenant disables SAS auth on flow HTTP triggers, so the
   webhook route answers 401 DirectApiInvalidAuthorizationScheme, and an Entra
   app registration needs an admin. This needs neither.

   Why COM rather than SMTP: mail.teslamotors.com blackholes 25 / 587 / 465, so
   Node cannot send directly. Outlook already holds an authenticated Exchange
   session — handing the message to the client reuses it, so there is no second
   credential anywhere in this path.

   Values reach PowerShell as environment variables, never interpolated into
   the script text, so a VIN can never be read as code.                       */

const PS_SEND = `
$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')

$to = $env:CT_TO
if (-not $to) {
  try { $to = $ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress } catch {}
}
if (-not $to) {
  try { $to = $ns.Accounts.Item(1).SmtpAddress } catch {}
}
if (-not $to) { throw 'No destination address could be read from the Outlook profile' }

$mail = $ol.CreateItem(0)
$mail.To      = $to
$mail.Subject = $env:CT_SUBJECT
$mail.Body    = $env:CT_BODY
$mail.Send()
Write-Output $to
`;

/* Readable for a human reading the mailbox, with a delimited JSON block so the
   flow can parse exact values instead of scraping the subject line. */
function alertEmailBody(f){
  if(f.text){
    return [f.text, "", "Sent by Charging Tracker.", "", "--CT-JSON--",
            JSON.stringify({ event: "test_message", text: f.text }),
            "--CT-END--"].join("\r\n");
  }

  const lines = [
    "Charging complete.",
    "",
    `VIN       ${f.vin}`,
    `USOE      ${Number(f.usoe).toFixed(1)}%`,
    `Target    ${Number(f.limit).toFixed(1)}%`
  ];
  if(f.readingAt) lines.push(`Reported  ${String(f.readingAt).replace("T", " ")} UTC`);
  lines.push("", "Sent by Charging Tracker.", "", "--CT-JSON--",
    JSON.stringify({ event: "charge_complete", vin: f.vin, usoe: f.usoe,
                     limit: f.limit, readingAt: f.readingAt || null }),
    "--CT-END--");
  return lines.join("\r\n");
}

function sendViaOutlook(f){
  if(process.platform !== "win32"){
    return Promise.reject(new Error("The Outlook transport requires Windows"));
  }

  const subject = f.text
    ? `${CONFIG.alertSubjectTag} test message`
    : `${CONFIG.alertSubjectTag} ${f.vin} complete ` +
      `${Number(f.usoe).toFixed(1)}/${Number(f.limit).toFixed(1)}`;

  return new Promise((resolve, reject) => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
       "-EncodedCommand", Buffer.from(PS_SEND, "utf16le").toString("base64")],
      {
        timeout: 60_000,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          CT_TO     : CONFIG.alertEmailTo,
          CT_SUBJECT: subject,
          CT_BODY   : alertEmailBody(f)
        })
      },
      (err, stdout, stderr) => {
        if(err){
          const detail = String(stderr || err.message).trim().split(/\r?\n/)[0];
          // The classic failure here is Outlook's programmatic-access guard,
          // which blocks .Send() rather than the COM object itself.
          return reject(new Error(
            /denied|programmatic|guard/i.test(detail)
              ? `Outlook blocked the send (programmatic access): ${detail}`
              : `Outlook send failed: ${detail}`));
        }
        resolve(String(stdout).trim() || "sent");
      });
  });
}

/* ───────────────────────────── Alert dispatch ───────────────────────────── */

function activeTransport(){
  if(CONFIG.transport === "webhook" || CONFIG.transport === "outlook") return CONFIG.transport;
  return teamsConfigured() ? "webhook" : "outlook";
}

/* Whether an alert has anywhere to go. The Outlook transport needs no setup
   beyond a working Outlook profile, so it is always considered ready. */
const alertsEnabled = () => activeTransport() === "outlook" || teamsConfigured();

async function deliverAlert(f){
  if(activeTransport() === "outlook") return sendViaOutlook(f);
  return postToTeams(f.text ? plainMessage(f.text) : chargeCompleteCard(f));
}

/* ───────────────────────────── HTTP server ───────────────────────────── */

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
               ".css":"text/css; charset=utf-8", ".svg":"image/svg+xml", ".ico":"image/x-icon",
               ".json":"application/json; charset=utf-8", ".png":"image/png" };

function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    // Same-origin in normal use; permissive so you can open index.html
    // straight from the filesystem and still reach this proxy.
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function readBodyOf(req){
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { resolve({}); }
    });
  });
}

function sendHtml(res, status, html){
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveStatic(req, res, pathname){
  const rel  = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(__dirname, rel);

  // Never serve outside the project directory, or the credential files.
  if(!file.startsWith(__dirname) || /(^|[\\/])\.(tokens|client|teams|garage)\.json$/.test(file)){
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if(err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  const p = url.pathname;

  if(req.method === "OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin" : "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type"
    });
    return res.end();
  }

  /* ── USOE for one VIN ── */
  if(p === "/api/usoe"){
    const vin = (url.searchParams.get("vin") || "").trim().toUpperCase();
    if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)){
      return sendJson(res, 400, { error: "A valid 17-character VIN is required" });
    }
    // The page asks for a live read only where it is worth 140 KB — normally
    // a vehicle close to its limit. Any live failure falls through to the
    // cached path, so this can never make the dashboard worse than before.
    const wantLive = url.searchParams.get("live") === "1";

    try{
      let r = null, liveError = null;

      if(wantLive && liveReady()){
        try{ r = await getLiveUsoe(vin); }
        catch(err){ liveError = err.message; }
      }
      if(!r) r = await getUsoe(vin);

      return sendJson(res, 200, {
        vin,
        usoe     : r.usoe,
        soc      : r.soc ?? null,
        readingAt: r.readingAt,      // when the vehicle actually reported it
        samples  : r.samples ?? null,
        live     : Boolean(r.live),
        liveError,
        source   : r.live ? "garage:live" : "garage:USOE",
        ts       : Date.now()
      });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: "Not signed in to Garage", needsAuth: true,
                                    loginUrl: `http://localhost:${CONFIG.port}/auth/login` });
      }
      return sendJson(res, 502, { error: err.message });
    }
  }

  /* ── geofence lookup, batched ── */
  if(p === "/api/geofence" && req.method === "POST"){
    const body = await readBodyOf(req);
    const vins = (Array.isArray(body.vins) ? body.vins : [])
      .map(v => String(v).trim().toUpperCase())
      .filter(v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v));

    if(!vins.length) return sendJson(res, 400, { error: "Provide a vins array" });

    try{
      return sendJson(res, 200, { results: await getGeofences(vins) });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: "Not signed in to Garage", needsAuth: true,
                                    loginUrl: `http://localhost:${CONFIG.port}/auth/login` });
      }
      return sendJson(res, 502, { error: err.message });
    }
  }

  /* ── Live vitals: status / configure / test ── */
  if(p === "/api/live" || p === "/api/live/test"){

    if(p === "/api/live" && req.method === "GET"){
      return sendJson(res, 200, {
        configured: Boolean(live.cookie),
        enabled   : Boolean(live.enabled),
        ready     : liveReady(),
        lastError : live.lastError || null
      });
    }

    if(p === "/api/live" && req.method === "POST"){
      const b = await readBodyOf(req);

      if(typeof b.cookie === "string"){
        live.cookie    = b.cookie.trim();
        live.lastError = null;
        liveCache.clear();          // a new identity invalidates cached reads
      }
      if(typeof b.enabled === "boolean") live.enabled = b.enabled;

      if(live.enabled && !live.cookie){
        live.enabled = false;
        saveLive();
        return sendJson(res, 400, { error: "Paste a session cookie before turning live read on" });
      }

      saveLive();
      return sendJson(res, 200, {
        configured: Boolean(live.cookie),
        enabled   : live.enabled,
        ready     : liveReady(),
        lastError : live.lastError || null
      });
    }

    if(p === "/api/live/test" && req.method === "POST"){
      const b   = await readBodyOf(req);
      const vin = String(b.vin || "").trim().toUpperCase();

      if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)){
        return sendJson(res, 400, { error: "Provide a VIN to test against" });
      }
      // Deliberately independent of the enabled flag, so a cookie can be
      // verified before switching live read on.
      try{
        const out = await getLiveUsoe(vin);
        return sendJson(res, 200, {
          ok: true, vin, usoe: out.usoe, soc: out.soc, readingAt: out.readingAt
        });
      }catch(err){
        return sendJson(res, 502, { error: err.message });
      }
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── Teams: status / configure / test / notify ── */
  if(p.startsWith("/api/teams") || p === "/api/notify"){
    const readBody = () => readBodyOf(req);

    if(p === "/api/teams" && req.method === "GET"){
      const u = teams.url || "";
      return sendJson(res, 200, {
        configured: alertsEnabled(),
        transport : activeTransport(),
        // Never echo the signature back to the page.
        preview: u ? u.replace(/^(https:\/\/[^/]+\/).*$/, "$1…") : "",
        fromEnv: Boolean(process.env.TEAMS_WEBHOOK_URL)
      });
    }

    if(p === "/api/teams" && req.method === "POST"){
      const bodyJson = await readBody();
      const url = String(bodyJson.url || "").trim();
      if(url && !/^https:\/\//i.test(url)){
        return sendJson(res, 400, { error: "URL must start with https://" });
      }
      teams.url = url;
      saveTeams();
      return sendJson(res, 200, { configured: teamsConfigured() });
    }

    if(p === "/api/teams/test" && req.method === "POST"){
      try{
        // Free text if the admin field had any, otherwise a sample card.
        const text = String((await readBody()).text || "").trim().slice(0, 2000);
        const status = await deliverAlert(text ? { text } : {
          vin: "TEST0000000000000", usoe: 80.4, limit: 80.0,
          readingAt: new Date().toISOString().slice(0, 19)
        });
        return sendJson(res, 200, { ok: true, status, transport: activeTransport() });
      }catch(err){
        return sendJson(res, 502, { error: err.message });
      }
    }

    if(p === "/api/notify" && req.method === "POST"){
      const ev = await readBody();
      if(!alertsEnabled()) return sendJson(res, 200, { sent: false, reason: "not configured" });
      if(ev.event !== "charge_complete") return sendJson(res, 200, { sent: false, reason: "ignored event" });

      const vin = String(ev.vin || "").toUpperCase();
      if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return sendJson(res, 400, { error: "Invalid VIN" });

      const last = (teams.alerted || {})[vin];
      if(last && Date.now() - last < CONFIG.teamsDedupeMs){
        return sendJson(res, 200, { sent: false, reason: "duplicate suppressed" });
      }

      try{
        await deliverAlert({ vin, usoe: ev.usoe, limit: ev.limit, readingAt: ev.readingAt });
        teams.alerted = teams.alerted || {};
        teams.alerted[vin] = Date.now();
        saveTeams();
        log(`Teams alert sent via ${activeTransport()}:`, vin);
        return sendJson(res, 200, { sent: true });
      }catch(err){
        warn("Teams alert failed:", err.message);
        return sendJson(res, 502, { error: err.message });
      }
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── auth status ── */
  if(p === "/api/auth/status"){
    return sendJson(res, 200, {
      authenticated: isAuthed(),
      garage       : CONFIG.garageUrl,
      loginUrl     : `http://localhost:${CONFIG.port}/auth/login`
    });
  }

  /* ── start sign-in ── */
  if(p === "/auth/login"){
    try{
      const target = await buildAuthorizeUrl();
      res.writeHead(302, { Location: target });
      return res.end();
    }catch(err){
      return sendHtml(res, 500, page("Sign-in failed", err.message, false));
    }
  }

  /* ── OAuth redirect target ── */
  if(p === "/callback"){
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oaErr = url.searchParams.get("error");

    if(oaErr) return sendHtml(res, 400, page("Sign-in declined",
      `${oaErr}: ${url.searchParams.get("error_description") || ""}`, false));
    if(!pending || state !== pending.state)
      return sendHtml(res, 400, page("Sign-in failed", "State mismatch — start the sign-in again.", false));

    try{
      await exchangeCode(code);
      log("signed in to Garage");
      return sendHtml(res, 200, page("Signed in",
        "You're connected to Garage. This tab can be closed — the dashboard is live.", true));
    }catch(err){
      return sendHtml(res, 500, page("Sign-in failed", err.message, false));
    }
  }

  /* ── sign out ── */
  if(p === "/auth/logout"){
    tokens = null; mcpSession = null; cache.clear();
    try { fs.unlinkSync(CONFIG.tokenFile); } catch {}
    return sendJson(res, 200, { ok: true });
  }

  if(req.method !== "GET"){ res.writeHead(405); return res.end("Method not allowed"); }
  return serveStatic(req, res, p);
});

/* Minimal styled page for the OAuth round-trip. */
function page(title, msg, ok){
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  font:14px/1.6 Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#171A20;color:#fff;text-align:center}
 .c{max-width:420px;padding:32px}
 .d{width:44px;height:44px;border-radius:50%;margin:0 auto 20px;
    background:${ok ? "#12BB6A" : "#E82127"}}
 h1{font-size:20px;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}
 p{color:rgba(255,255,255,.66);margin:0 0 22px}
 a{display:inline-block;padding:11px 26px;border-radius:4px;background:#fff;color:#171A20;
   text-decoration:none;font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
</style>
<div class="c"><div class="d"></div><h1>${title}</h1><p>${msg}</p>
<a href="http://localhost:${CONFIG.port}/">Open dashboard</a></div>`;
}

/* ───────────────────────────── Boot ───────────────────────────── */

function openBrowser(target){
  const cmd = process.platform === "win32" ? `start "" "${target}"`
            : process.platform === "darwin" ? `open "${target}"`
            : `xdg-open "${target}"`;
  exec(cmd, () => {});
}

server.listen(CONFIG.port, "127.0.0.1", async () => {
  const home = `http://localhost:${CONFIG.port}/`;
  console.log("");
  log("Charging Tracker");
  log("dashboard :", home);
  log("garage    :", CONFIG.garageUrl);
  log("reading   : USOE (usable state of energy)");
  log("live read :", liveReady() ? "on (session cookie)"
    : live.cookie ? "off (cookie saved)" : "off (no cookie)");
  log("alerts    :", activeTransport() === "outlook"
    ? `outlook → ${CONFIG.alertEmailTo || "your own mailbox"} (subject ${CONFIG.alertSubjectTag})`
    : teamsConfigured() ? "teams webhook" : "off");
  console.log("");

  if(isAuthed()){
    log("existing Garage token found — starting live");
    openBrowser(home);
  }else{
    log("no Garage token — opening Bouncer sign-in");
    log("(you must be on the Tesla network / VPN)");
    openBrowser(`${home}auth/login`);
  }
});

process.on("unhandledRejection", err => warn("unhandled:", err && err.message ? err.message : err));
