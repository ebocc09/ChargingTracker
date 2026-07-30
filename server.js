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

   That whole flow runs once per environment — Production and Engineering are
   separate Garage instances with separate Bouncer registrations, and the
   dashboard can be pointed at either from the admin panel.

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

  /* The two Garage instances this can talk to. Both are defined up front;
     exactly one is current at a time, chosen in the admin panel and
     remembered in .garage.json.

     Override either host for eu / cn with GARAGE_URL / GARAGE_ENG_URL, and
     pin the starting environment with GARAGE_ENV=prod|eng — see README. */
  environments: {
    prod: {
      key       : "prod",
      label     : "Production",
      garageUrl : process.env.GARAGE_URL || "https://garage.vn.teslamotors.com",
      tokenFile : path.join(__dirname, ".tokens.json"),
      clientFile: path.join(__dirname, ".client.json")
    },
    eng: {
      key       : "eng",
      label     : "Engineering",
      garageUrl : process.env.GARAGE_ENG_URL || "https://garage.dev.teslamotors.com",
      tokenFile : path.join(__dirname, ".tokens.eng.json"),
      clientFile: path.join(__dirname, ".client.eng.json")
    }
  },

  // How far back to look for a USOE snapshot. Datatank serves cached
  // snapshots, so the vehicle does not need to be online right now.
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 6),

  // Don't re-query Garage for the same VIN more often than this.
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 10_000),

  // Hard ceiling on concurrent Garage calls. The dashboard throttles itself,
  // but this backstops it — several open tabs, or a script hitting /api/usoe
  // directly, still cannot fan out past this.
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 4),

  teamsFile : path.join(__dirname, ".teams.json"),
  garageFile: path.join(__dirname, ".garage.json"),

  // Live vitals. Opt-in — see the "Live vitals" section below for why.
  // TTL matches cacheTtlMs so a short refresh interval is never served a
  // stale "live" reading. Concurrency matches the MCP path, since with live
  // read on every monitored vehicle goes through here.
  liveTtlMs        : Number(process.env.LIVE_TTL_MS || 10_000),
  liveMaxConcurrent: Number(process.env.LIVE_MAX_CONCURRENT || 4),

  // How often to confirm the saved session cookie is still good. Deliberately
  // infrequent: the probe is one redirect with no body, but there is nothing
  // to gain from checking often — a Garage session lasts hours to days, and
  // the only cost of noticing late is a few minutes of cached-only readings.
  cookieCheckMs: Number(process.env.COOKIE_CHECK_MS || 15 * 60 * 1000),

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
  // The mode is honoured on POSIX and silently ignored on Windows, where NTFS
  // ACLs govern instead — these files are still per-user secrets either way.
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/* ───────────────────────────── Environments ─────────────────────────────
   Production and Engineering are two entirely separate Garage instances:
   different hosts, different Bouncer registrations, different fleets. Every
   piece of state that could leak across that boundary is held per
   environment rather than globally — the OAuth client, the tokens, the MCP
   session, all four caches, and the live-read session cookie.

   The consequence worth relying on: switching is instant and lossless.
   Signing in to Engineering does not sign you out of Production, and a VIN
   read in one environment is never answered out of the other's cache.     */

function makeEnv(def){
  const base = def.garageUrl.replace(/\/+$/, "");
  return {
    def,
    key      : def.key,
    label    : def.label,
    garageUrl: base,
    mcpUrl   : base + "/mcp",

    tokens: readJson(def.tokenFile),    // { access_token, refresh_token, expires_at }
    client: readJson(def.clientFile),   // { client_id, client_secret? }

    authServerMeta: null,
    mcpSession    : null,
    pending       : null,               // in-flight authorization-code exchange

    cache        : new Map(),           // vin -> { cachedAt, value }
    inFlightByVin: new Map(),           // vin -> Promise
    geoCache     : new Map(),           // vin -> { at, value }
    idCache      : new Map(),           // vin -> numeric Mothership id
    liveCache    : new Map(),           // vin -> { at, value }

    live: { cookie: "", enabled: false, lastError: null },

    // Runtime health, deliberately NOT persisted — it describes this process's
    // observations, not configuration, and writing it would rewrite
    // .garage.json every quarter of an hour for nothing.
    health: { lastCheck: null, lastOk: null, lastRead: null, checking: false }
  };
}

const ENVS = Object.fromEntries(
  Object.values(CONFIG.environments).map(def => [def.key, makeEnv(def)])
);

/* GARAGE_ENV pins the environment for this process; without it the last
   choice made in the admin panel is restored from .garage.json. */
const ENV_FORCED = process.env.GARAGE_ENV === "eng" || process.env.GARAGE_ENV === "prod";
let currentEnvKey = ENV_FORCED ? process.env.GARAGE_ENV : "prod";

const env      = () => ENVS[currentEnvKey];
const envByKey = k  => ENVS[k] || null;

/* .garage.json carries the live-read cookie for each environment plus the
   last selected environment. Builds before this change wrote a single flat
   { cookie, enabled, lastError }; that shape is migrated into Production,
   which is the only environment those builds could talk to. */
(function loadGarageFile(){
  const raw = readJson(CONFIG.garageFile);
  if(!raw) return;

  if(!raw.envs && typeof raw.cookie === "string"){
    ENVS.prod.live = {
      cookie   : raw.cookie || "",
      enabled  : Boolean(raw.enabled),
      lastError: raw.lastError || null
    };
    log("migrated .garage.json to the per-environment format");
    return;
  }

  for(const [key, saved] of Object.entries(raw.envs || {})){
    if(!ENVS[key] || !saved) continue;
    ENVS[key].live = {
      cookie   : saved.cookie || "",
      enabled  : Boolean(saved.enabled),
      lastError: saved.lastError || null
    };
  }
  if(!ENV_FORCED && raw.current && ENVS[raw.current]) currentEnvKey = raw.current;
})();

function saveGarageFile(){
  writeJson(CONFIG.garageFile, {
    current: currentEnvKey,
    envs   : Object.fromEntries(Object.entries(ENVS).map(([k, e]) => [k, e.live]))
  });
}

/* ───────────────────────────── OAuth: discovery ───────────────────────────── */

async function discover(e){
  if(e.authServerMeta) return e.authServerMeta;

  // Ask the resource which authorization server it trusts, per RFC 9728.
  const prUrl = e.garageUrl + "/.well-known/oauth-protected-resource";
  const pr = await request(prUrl, { headers: { Accept: "application/json" } });
  if(pr.status !== 200) throw new Error(`Protected-resource discovery failed (HTTP ${pr.status})`);

  const prMeta = JSON.parse(pr.body);
  const issuer = (prMeta.authorization_servers || [])[0];
  if(!issuer) throw new Error("Garage did not advertise an authorization server");

  const asUrl = issuer.replace(/\/+$/, "") + "/.well-known/oauth-authorization-server";
  const as = await request(asUrl, { headers: { Accept: "application/json" } });
  if(as.status !== 200) throw new Error(`Authorization-server discovery failed (HTTP ${as.status})`);

  e.authServerMeta = JSON.parse(as.body);
  log(`auth server (${e.key}):`, e.authServerMeta.issuer);
  return e.authServerMeta;
}

/* ───────────────────────────── OAuth: registration ───────────────────────────── */

async function ensureClient(e){
  if(e.client && e.client.client_id) return e.client;

  const meta = await discover(e);
  if(!meta.registration_endpoint) throw new Error("Bouncer does not expose dynamic client registration");

  const res = await postJson(meta.registration_endpoint, {
    client_name               : `Charging Tracker (${e.label})`,
    redirect_uris             : [REDIRECT_URI],
    grant_types               : ["authorization_code", "refresh_token"],
    response_types            : ["code"],
    token_endpoint_auth_method: "none",
    scope                     : CONFIG.scope
  });

  if(res.status !== 200 && res.status !== 201){
    throw new Error(`Client registration failed (HTTP ${res.status}): ${res.body.slice(0, 400)}`);
  }

  e.client = JSON.parse(res.body);
  writeJson(e.def.clientFile, e.client);
  log(`registered OAuth client (${e.key}):`, e.client.client_id);
  return e.client;
}

/* ───────────────────────────── OAuth: authorization code + PKCE ───────────────────────────── */

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function buildAuthorizeUrl(e){
  const meta = await discover(e);
  await ensureClient(e);

  const verifier  = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  // The environment key rides in the state parameter so /callback can route
  // the code back to the right environment — two sign-ins can be in flight
  // in two tabs without landing on each other.
  const state = e.key + "." + b64url(crypto.randomBytes(16));

  e.pending = { verifier, state };

  const params = new URLSearchParams({
    response_type        : "code",
    client_id            : e.client.client_id,
    redirect_uri         : REDIRECT_URI,
    scope                : CONFIG.scope,
    state,
    code_challenge       : challenge,
    code_challenge_method: "S256",
    // RFC 8707 — bind the token to this specific MCP resource.
    resource             : e.mcpUrl
  });

  return meta.authorization_endpoint + "?" + params.toString();
}

async function exchangeCode(e, code){
  const meta = await discover(e);
  const res = await postForm(meta.token_endpoint, {
    grant_type   : "authorization_code",
    code,
    redirect_uri : REDIRECT_URI,
    client_id    : e.client.client_id,
    code_verifier: e.pending.verifier,
    resource     : e.mcpUrl
  });
  if(res.status !== 200) throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.body.slice(0, 400)}`);
  storeTokens(e, JSON.parse(res.body));
}

async function refreshTokens(e){
  if(!e.tokens || !e.tokens.refresh_token) return false;
  const meta = await discover(e);
  const res = await postForm(meta.token_endpoint, {
    grant_type   : "refresh_token",
    refresh_token: e.tokens.refresh_token,
    client_id    : e.client.client_id,
    resource     : e.mcpUrl
  });
  if(res.status !== 200){
    warn(`refresh failed for ${e.key} (HTTP ${res.status}) — re-authentication required`);
    e.tokens = null;
    try { fs.unlinkSync(e.def.tokenFile); } catch {}
    return false;
  }
  storeTokens(e, JSON.parse(res.body));
  log(`access token refreshed (${e.key})`);
  return true;
}

function storeTokens(e, t){
  e.tokens = {
    access_token : t.access_token,
    refresh_token: t.refresh_token || (e.tokens && e.tokens.refresh_token) || null,
    // Renew a minute early so a call never lands on an expiring token.
    expires_at   : Date.now() + ((t.expires_in || 3600) - 60) * 1000
  };
  writeJson(e.def.tokenFile, e.tokens);
  e.mcpSession = null;   // a new identity needs a new MCP session
}

async function accessToken(e){
  if(e.tokens && e.tokens.access_token && Date.now() < e.tokens.expires_at) return e.tokens.access_token;
  if(e.tokens && e.tokens.refresh_token && await refreshTokens(e)) return e.tokens.access_token;
  return null;
}

const isAuthed = e => Boolean(e.tokens && e.tokens.access_token);

/* ───────────────────────────── MCP client ─────────────────────────────
   Streamable HTTP transport. Responses arrive either as plain JSON or as
   an SSE stream, so both shapes have to be handled.                      */

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

async function mcpRpc(e, method, params, { isNotification = false } = {}){
  const token = await accessToken(e);
  if(!token){
    const err = new Error(`Not authenticated with Garage (${e.label})`);
    err.needsAuth = true; err.env = e.key;
    throw err;
  }

  const headers = {
    "Authorization"       : "Bearer " + token,
    "MCP-Protocol-Version": CONFIG.mcpProtocolVersion
  };
  if(e.mcpSession) headers["Mcp-Session-Id"] = e.mcpSession;

  const payload = isNotification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };

  const res = await postJson(e.mcpUrl, payload, headers);

  if(res.status === 401){
    // Token rejected — try one refresh, then give up and ask for a login.
    e.mcpSession = null;
    if(await refreshTokens(e)) return mcpRpc(e, method, params, { isNotification });
    const err = new Error(`Garage rejected the access token (${e.label})`);
    err.needsAuth = true; err.env = e.key;
    throw err;
  }
  if(res.status === 404 && e.mcpSession){
    // Session expired server-side; re-initialize and retry once.
    e.mcpSession = null;
    await mcpInit(e);
    return mcpRpc(e, method, params, { isNotification });
  }
  if(res.status >= 400) throw new Error(`Garage MCP returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);

  const sid = res.headers["mcp-session-id"];
  if(sid) e.mcpSession = sid;

  if(isNotification || res.status === 202 || !res.body.trim()) return null;

  const parsed = parseMcpBody(res);
  if(parsed.error) throw new Error(`Garage MCP error ${parsed.error.code}: ${parsed.error.message}`);
  return parsed.result;
}

async function mcpInit(e){
  if(e.mcpSession) return;
  await mcpRpc(e, "initialize", {
    protocolVersion: CONFIG.mcpProtocolVersion,
    capabilities   : {},
    clientInfo     : { name: "charging-tracker", version: "1.1.0" }
  });
  await mcpRpc(e, "notifications/initialized", {}, { isNotification: true });
  log(`MCP session established (${e.key})`);
}

async function callTool(e, name, args){
  await mcpInit(e);
  const result = await mcpRpc(e, "tools/call", { name, arguments: args });

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

/* Counting semaphore. Callers queue rather than being rejected, so a burst
   is slowed down instead of dropped. Deliberately global rather than
   per-environment: it exists to protect this process's own socket budget,
   and only one environment is ever being polled at a time.               */
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

async function getUsoe(e, vin){
  const hit = e.cache.get(vin);
  if(hit && Date.now() - hit.cachedAt < CONFIG.cacheTtlMs) return hit.value;

  // Already fetching this VIN? Join that request rather than issuing a second.
  const pendingCall = e.inFlightByVin.get(vin);
  if(pendingCall) return pendingCall;

  const call = withSlot(async () => {
    const payload = await callTool(e, "device_historical_vitals", {
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
    e.cache.set(vin, { cachedAt: Date.now(), value });
    return value;
  }).finally(() => e.inFlightByVin.delete(vin));

  e.inFlightByVin.set(vin, call);
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

const GEO_TTL  = Number(process.env.GEO_TTL_MS || 5 * 60 * 1000);
const GEO_CHUNK = 50;

async function getGeofences(e, vins){
  const out = {}, need = [];

  for(const vin of vins){
    const hit = e.geoCache.get(vin);
    if(hit && Date.now() - hit.at < GEO_TTL) out[vin] = hit.value;
    else need.push(vin);
  }

  for(let i = 0; i < need.length; i += GEO_CHUNK){
    const chunk = need.slice(i, i + GEO_CHUNK);

    const payload = await withSlot(() => callTool(e, "tesladex_search", {
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
      e.geoCache.set(r.vin, { at: Date.now(), value });
      out[r.vin] = value;
      seen.add(r.vin);
    }

    // A VIN Tesladex didn't return has no facility — record that definitively
    // rather than leaving it unknown and re-querying every sweep.
    for(const vin of chunk){
      if(seen.has(vin)) continue;
      const value = { trtId: null, name: null, site: null, type: null };
      e.geoCache.set(vin, { at: Date.now(), value });
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

   The cookie is held PER ENVIRONMENT. A production Garage session is not
   valid against garage.dev and vice versa, so each has its own — turning
   live read on in one says nothing about the other.

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

const liveReady = e => Boolean(e.live.enabled && e.live.cookie);

/* VIN -> numeric Mothership id. The live endpoint is addressed by id, not
   VIN. Ids never change, so this is cached for the life of the process. */
async function deviceIdFor(e, vin){
  if(e.idCache.has(vin)) return e.idCache.get(vin);

  const payload = await withSlot(() => callTool(e, "tesladex_search", {
    query : "vin:" + vin,
    fields: ["vin", "id"],
    size  : 1
  }));

  const row = ((payload && (payload.results || payload.rows)) || [])[0];
  if(!row || row.id == null) throw new Error(`Tesladex has no numeric id for ${vin}`);

  e.idCache.set(vin, String(row.id));
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

async function getLiveUsoe(e, vin){
  if(!e.live.cookie) throw new Error(`No ${e.label} session cookie saved`);

  const hit = e.liveCache.get(vin);
  if(hit && Date.now() - hit.at < CONFIG.liveTtlMs) return hit.value;

  const id  = await deviceIdFor(e, vin);
  const res = await withLiveSlot(() => request(
    `${e.garageUrl}/vehicles/${id}/vitals`,
    { headers: { Accept: "application/json", Cookie: e.live.cookie,
                 "User-Agent": "Mozilla/5.0 (charging-tracker)" } }
  ));

  if(res.status === 401 || res.status === 403){
    // Garage sessions expire on their own schedule. Switch live off rather
    // than hammering with a dead cookie; the admin panel reports this and
    // asks for a fresh one.
    e.live.enabled   = false;
    e.live.lastError = `${e.label} session cookie expired or was rejected — paste a fresh one.`;
    e.liveCache.clear();
    saveGarageFile();
    const err = new Error(e.live.lastError); err.liveExpired = true; throw err;
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
    // Charge-port proximity — the "Proximity: DISCONNECTED / LATCHED" line in
    // Garage's vitals tab. This is a LIVE-ONLY field: the cached historical
    // vitals set carries no CP_* columns at all (only the unrelated `cp_type`
    // config value), so with live read off it is simply unknowable and the
    // dashboard has to treat it as such.
    //
    // Deliberately NOT CP_latchState — that reads ENGAGED on a car with
    // nothing plugged in at all, because it describes the latch mechanism
    // rather than whether a connector is present. Verified against a parked
    // vehicle reporting CP_proximity DISCONNECTED and CP_latchState ENGAGED
    // simultaneously. Using it would have flagged every idle car.
    proximity: typeof body.CP_proximity === "string"
                 ? body.CP_proximity.trim().toUpperCase() : null,

    // Pack current in amps. Negative is discharge, positive is energy going
    // in. Reported as a STRING ("-0.500") in BMS_packCurrent and as a number
    // in bms_current — prefer the former, fall back to the latter, and let
    // anything unparseable become null rather than 0, which would read as a
    // measurement of "not charging".
    packAmps : (() => {
      const raw = body.BMS_packCurrent ?? body.bms_current;
      const n   = Number(raw);
      return Number.isFinite(n) ? n : null;
    })(),

    live     : true
  };

  if(e.live.lastError){ e.live.lastError = null; saveGarageFile(); }
  // A successful read is the strongest possible proof the cookie is alive,
  // and it is what makes the admin indicator read "active" rather than merely
  // "configured".
  e.health.lastOk = e.health.lastRead = Date.now();
  e.liveCache.set(vin, { at: Date.now(), value });
  return value;
}

/* ── Cookie health ─────────────────────────────────────────────────────
   A dead cookie used to be discovered only when a live read happened to hit
   an AWAKE vehicle: a sleeping car answers 408 whether the session is good or
   not, so a fleet that is all asleep would 408 forever and never reveal that
   the cookie had expired hours ago.

   This probes it directly. GET / on Garage answers 302 either way, but the
   destination gives it away — /vehicles when the session is live,
   /users/sign_in when it is not. Verified against a valid cookie, a corrupted
   one and no cookie at all. It is a redirect with no body and touches no
   vehicle, so it cannot wake anything or be confused with a 408.            */
const SIGN_IN_RE = /\/users\/sign_in/;

async function checkCookie(e){
  if(!e.live.cookie || e.health.checking) return null;
  e.health.checking = true;

  try{
    const res = await request(e.garageUrl + "/", {
      headers: { Accept: "text/html,application/json",
                 Cookie: e.live.cookie,
                 "User-Agent": "Mozilla/5.0 (charging-tracker)" }
    });

    e.health.lastCheck = Date.now();
    const dead = res.status === 401 || res.status === 403 ||
                 SIGN_IN_RE.test(String(res.headers.location || ""));

    if(dead){
      const wasEnabled = e.live.enabled;
      e.live.enabled   = false;
      e.live.lastError = `${e.label} session cookie has expired — time for a refresh.`;
      e.liveCache.clear();
      saveGarageFile();
      if(wasEnabled) warn(`${e.key} session cookie expired — live read switched off`);
      return false;
    }

    e.health.lastOk = Date.now();
    if(e.live.lastError){ e.live.lastError = null; saveGarageFile(); }
    return true;

  }catch(err){
    // A network failure says nothing about the cookie — off VPN, Garage down.
    // Record the attempt and change no state; guessing here would switch live
    // read off every time the laptop briefly lost its connection.
    e.health.lastCheck = Date.now();
    return null;
  }finally{
    e.health.checking = false;
  }
}

function startCookieWatch(){
  const sweep = async () => {
    for(const e of Object.values(ENVS)){
      if(e.live.cookie) await checkCookie(e).catch(() => {});
    }
  };
  // Shortly after boot as well as on the interval, so a cookie that died
  // overnight is reported before the first sweep rather than after it.
  setTimeout(sweep, 8_000).unref?.();
  setInterval(sweep, CONFIG.cookieCheckMs).unref?.();
}

/* Shape the admin panel reads for one environment. */
function liveStatusOf(e){
  return {
    env       : e.key,
    label     : e.label,
    configured: Boolean(e.live.cookie),
    enabled   : Boolean(e.live.enabled),
    ready     : liveReady(e),
    lastError : e.live.lastError || null,
    // Health, for the activity indicator in the admin panel.
    lastCheck : e.health.lastCheck,
    lastOk    : e.health.lastOk,
    lastRead  : e.health.lastRead,
    checkEvery: CONFIG.cookieCheckMs
  };
}

function envSummary(){
  return {
    current: currentEnvKey,
    forced : ENV_FORCED,
    environments: Object.values(ENVS).map(e => ({
      key          : e.key,
      label        : e.label,
      garageUrl    : e.garageUrl,
      authenticated: isAuthed(e),
      loginUrl     : `http://localhost:${CONFIG.port}/auth/login?env=${e.key}`,
      live         : liveStatusOf(e)
    }))
  };
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

/* Master switch, independent of whether a webhook is configured. Clearing the
   URL also stops alerts, but it throws the configuration away — this is the
   mute button: keep the flow wired up, just stop posting to it. Defaults to
   on so an existing install behaves exactly as before. */
if(typeof teams.muted !== "boolean") teams.muted = false;

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
function chargeCompleteCard({ vin, usoe, limit, readingAt, envLabel }){
  // Labelled SOC because that is what people say, but the value is USOE —
  // see the USOE lookup section for why the two are not interchangeable.
  // `readingAt` is still carried in the flat fields below for the flow.
  const facts = [
    { title: "SOC",    value: `${Number(usoe).toFixed(1)}%` },
    { title: "Target", value: `${Number(limit).toFixed(1)}%` }
  ];
  // Only ever stated when it isn't production, so the ordinary card is
  // unchanged and an engineering card can't be mistaken for a real one.
  if(envLabel && envLabel !== "Production") facts.push({ title: "Environment", value: envLabel });

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
    event: "charge_complete", vin, usoe, limit, readingAt, environment: envLabel || null
  };
}

/* Charge finished but the connector is still latched — the car is occupying a
   stall it no longer needs. Same envelope as the completion card so an
   existing flow renders it with no changes, but coloured Attention (red) and
   headed differently, because this one is asking someone to go and do
   something rather than reporting good news.

   `reminderIndex` counts up across repeats, and is what stops the dedupe in
   /api/notify from swallowing the second and subsequent reminders. */
function stillLatchedCard({ vin, usoe, limit, readingAt, envLabel, reminderIndex, minutes }){
  const facts = [
    { title: "SOC",    value: `${Number(usoe).toFixed(1)}%` },
    { title: "Target", value: `${Number(limit).toFixed(1)}%` },
    { title: "Status", value: "Charge complete · still latched" }
  ];
  if(Number.isFinite(minutes) && minutes > 0){
    facts.push({ title: "Latched for", value: minutes < 60
      ? `${Math.round(minutes)} min`
      : `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` });
  }
  if(envLabel && envLabel !== "Production") facts.push({ title: "Environment", value: envLabel });

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
              { type: "TextBlock", text: "🔌", size: "ExtraLarge", spacing: "None" }]},
            { type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Still plugged in", weight: "Bolder",
                size: "Medium", color: "Attention", spacing: "None" },
              { type: "TextBlock", text: "Charging Tracker | Powered by Zo' Projects",
                isSubtle: true, size: "Small", spacing: "None", wrap: true }]}
          ]},
          { type: "TextBlock", text: vin, size: "Large", weight: "Bolder",
            wrap: true, fontType: "Monospace", spacing: "Medium" },
          { type: "TextBlock", color: "Attention", wrap: true, spacing: "Small",
            text: "This vehicle finished charging and is still latched to the Supercharger. "
                + "Reminders repeat until it is unplugged." },
          { type: "FactSet", facts }
        ]
      }
    }],
    event: "still_latched", vin, usoe, limit, readingAt,
    reminderIndex: reminderIndex || 1, environment: envLabel || null
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

  const lines = f.stillLatched
    ? ["STILL PLUGGED IN.",
       "",
       "This vehicle finished charging and is still latched to the Supercharger.",
       ""]
    : ["Charging complete.", ""];

  lines.push(
    `VIN       ${f.vin}`,
    `USOE      ${Number(f.usoe).toFixed(1)}%`,
    `Target    ${Number(f.limit).toFixed(1)}%`
  );
  if(f.stillLatched) lines.push(`Reminder  #${f.reminderIndex || 1}`);
  if(f.envLabel && f.envLabel !== "Production") lines.push(`Env       ${f.envLabel}`);
  if(f.readingAt) lines.push(`Reported  ${String(f.readingAt).replace("T", " ")} UTC`);

  lines.push("", "Sent by Charging Tracker.", "", "--CT-JSON--",
    JSON.stringify({ event: f.stillLatched ? "still_latched" : "charge_complete",
                     vin: f.vin, usoe: f.usoe, limit: f.limit,
                     readingAt: f.readingAt || null,
                     reminderIndex: f.stillLatched ? (f.reminderIndex || 1) : undefined,
                     environment: f.envLabel || null }),
    "--CT-END--");
  return lines.join("\r\n");
}

function sendViaOutlook(f){
  if(process.platform !== "win32"){
    return Promise.reject(new Error("The Outlook transport requires Windows"));
  }

  const subject = f.text
    ? `${CONFIG.alertSubjectTag} test message`
    : f.stillLatched
      ? `${CONFIG.alertSubjectTag} ${f.vin} STILL LATCHED (reminder ${f.reminderIndex || 1})`
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

/* Whether an alert has anywhere to go AND is allowed to go there. The Outlook
   transport needs no setup beyond a working Outlook profile, so it is always
   considered ready; the mute switch overrides either transport. */
const alertsEnabled = () =>
  !teams.muted && (activeTransport() === "outlook" || teamsConfigured());

async function deliverAlert(f){
  if(activeTransport() === "outlook") return sendViaOutlook(f);
  if(f.text)      return postToTeams(plainMessage(f.text));
  if(f.stillLatched) return postToTeams(stillLatchedCard(f));
  return postToTeams(chargeCompleteCard(f));
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

/* Credential files, whichever environment they belong to, are never served.
   Matched by prefix rather than by an exact list so a future .tokens.<env>
   cannot be exposed by being forgotten here. */
const SECRET_FILE = /(^|[\\/])\.(tokens|client|teams|garage)(\.[a-z0-9]+)?\.json$/i;

function serveStatic(req, res, pathname){
  const rel  = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(__dirname, rel);

  // Never serve outside the project directory, or the credential files.
  if(!file.startsWith(__dirname) || SECRET_FILE.test(file)){
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

  /* ── environment: read / switch ── */
  if(p === "/api/env"){
    if(req.method === "GET") return sendJson(res, 200, envSummary());

    if(req.method === "POST"){
      if(ENV_FORCED){
        return sendJson(res, 409, {
          error: `Environment is pinned to ${env().label} by GARAGE_ENV — unset it to switch from the dashboard.`,
          ...envSummary()
        });
      }
      const want = String((await readBodyOf(req)).env || "").trim();
      if(!envByKey(want)) return sendJson(res, 400, { error: `Unknown environment "${want}"` });

      if(want !== currentEnvKey){
        currentEnvKey = want;
        saveGarageFile();
        log("environment switched to", env().label, `(${env().garageUrl})`);
      }
      return sendJson(res, 200, envSummary());
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── USOE for one VIN ── */
  if(p === "/api/usoe"){
    const vin = (url.searchParams.get("vin") || "").trim().toUpperCase();
    if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)){
      return sendJson(res, 400, { error: "A valid 17-character VIN is required" });
    }
    // Pinned for the duration of the call so a switch mid-sweep can never
    // attribute one environment's reading to the other.
    const e = env();

    // The page asks for a live read only where it is worth 140 KB — normally
    // a vehicle close to its limit. Any live failure falls through to the
    // cached path, so this can never make the dashboard worse than before.
    const wantLive = url.searchParams.get("live") === "1";

    try{
      let r = null, liveError = null;

      if(wantLive && liveReady(e)){
        try{ r = await getLiveUsoe(e, vin); }
        catch(err){ liveError = err.message; }
      }
      if(!r) r = await getUsoe(e, vin);

      return sendJson(res, 200, {
        vin,
        env      : e.key,
        usoe     : r.usoe,
        soc      : r.soc ?? null,
        // Both null on the cached path — the live dump is the only place
        // charge-port and pack-current readings exist.
        proximity: r.proximity ?? null,
        packAmps : r.packAmps ?? null,
        readingAt: r.readingAt,      // when the vehicle actually reported it
        samples  : r.samples ?? null,
        live     : Boolean(r.live),
        liveError,
        source   : r.live ? "garage:live" : "garage:USOE",
        ts       : Date.now()
      });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label,
                                    loginUrl: `http://localhost:${CONFIG.port}/auth/login?env=${e.key}` });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── geofence lookup, batched ── */
  if(p === "/api/geofence" && req.method === "POST"){
    const body = await readBodyOf(req);
    const vins = (Array.isArray(body.vins) ? body.vins : [])
      .map(v => String(v).trim().toUpperCase())
      .filter(v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v));

    if(!vins.length) return sendJson(res, 400, { error: "Provide a vins array" });

    const e = env();
    try{
      return sendJson(res, 200, { env: e.key, results: await getGeofences(e, vins) });
    }catch(err){
      if(err.needsAuth){
        return sendJson(res, 401, { error: `Not signed in to Garage (${e.label})`, needsAuth: true,
                                    env: e.key, envLabel: e.label,
                                    loginUrl: `http://localhost:${CONFIG.port}/auth/login?env=${e.key}` });
      }
      return sendJson(res, 502, { error: err.message, env: e.key });
    }
  }

  /* ── Live vitals: status / configure / test ──
     Always operates on the CURRENT environment, so the admin panel edits the
     cookie for whichever Garage is selected and can never cross-write. */
  if(p === "/api/live" || p === "/api/live/test" || p === "/api/live/check"){
    const e = env();

    if(p === "/api/live" && req.method === "GET"){
      return sendJson(res, 200, liveStatusOf(e));
    }

    if(p === "/api/live" && req.method === "POST"){
      const b = await readBodyOf(req);

      if(typeof b.cookie === "string"){
        e.live.cookie    = b.cookie.trim();
        e.live.lastError = null;
        e.liveCache.clear();        // a new identity invalidates cached reads
      }
      if(typeof b.enabled === "boolean") e.live.enabled = b.enabled;

      if(e.live.enabled && !e.live.cookie){
        e.live.enabled = false;
        saveGarageFile();
        return sendJson(res, 400, { error: `Paste a session cookie for ${e.label} before turning live read on` });
      }

      saveGarageFile();
      return sendJson(res, 200, liveStatusOf(e));
    }

    /* An immediate cookie probe, so opening the panel shows current truth
       rather than whatever the last scheduled check found. */
    if(p === "/api/live/check" && req.method === "POST"){
      const ok = await checkCookie(e);
      return sendJson(res, 200, Object.assign({ ok }, liveStatusOf(e)));
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
        const out = await getLiveUsoe(e, vin);
        return sendJson(res, 200, {
          ok: true, vin, env: e.key, usoe: out.usoe, soc: out.soc, readingAt: out.readingAt
        });
      }catch(err){
        return sendJson(res, 502, { error: err.message, env: e.key });
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
        // Distinct from `configured`: a webhook can be set up perfectly and
        // still be muted, and the panel needs to say which of the two it is.
        hasTarget : activeTransport() === "outlook" || teamsConfigured(),
        muted     : Boolean(teams.muted),
        transport : activeTransport(),
        // Never echo the signature back to the page.
        preview: u ? u.replace(/^(https:\/\/[^/]+\/).*$/, "$1…") : "",
        fromEnv: Boolean(process.env.TEAMS_WEBHOOK_URL)
      });
    }

    if(p === "/api/teams" && req.method === "POST"){
      const bodyJson = await readBody();

      // The mute switch and the URL are set independently, so a body carrying
      // only { muted } must not blank the webhook.
      if(typeof bodyJson.muted === "boolean"){
        teams.muted = bodyJson.muted;
        saveTeams();
        log("alerts", teams.muted ? "muted" : "unmuted");
      }

      if(typeof bodyJson.url === "string"){
        const url = bodyJson.url.trim();
        if(url && !/^https:\/\//i.test(url)){
          return sendJson(res, 400, { error: "URL must start with https://" });
        }
        teams.url = url;
        saveTeams();
      }

      return sendJson(res, 200, {
        configured: alertsEnabled(),
        hasTarget : activeTransport() === "outlook" || teamsConfigured(),
        muted     : Boolean(teams.muted)
      });
    }

    if(p === "/api/teams/test" && req.method === "POST"){
      try{
        // Free text if the admin field had any, otherwise a sample card.
        const text = String((await readBody()).text || "").trim().slice(0, 2000);
        const status = await deliverAlert(text ? { text } : {
          vin: "TEST0000000000000", usoe: 80.4, limit: 80.0,
          readingAt: new Date().toISOString().slice(0, 19),
          envLabel: env().label
        });
        // Deliberately ignores the mute switch: pressing Send test is an
        // explicit request, and a test button that silently did nothing while
        // muted would be indistinguishable from a broken webhook.
        return sendJson(res, 200, { ok: true, status, transport: activeTransport(),
                                    mutedOverride: Boolean(teams.muted) });
      }catch(err){
        return sendJson(res, 502, { error: err.message });
      }
    }

    if(p === "/api/notify" && req.method === "POST"){
      const ev = await readBody();
      if(teams.muted) return sendJson(res, 200, { sent: false, reason: "muted" });
      if(!alertsEnabled()) return sendJson(res, 200, { sent: false, reason: "not configured" });

      const stillLatched = ev.event === "still_latched";
      if(ev.event !== "charge_complete" && !stillLatched){
        return sendJson(res, 200, { sent: false, reason: "ignored event" });
      }

      const vin = String(ev.vin || "").toUpperCase();
      if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return sendJson(res, 400, { error: "Invalid VIN" });

      // Dedupe per environment: the same VIN can legitimately exist in both,
      // and a production completion must not silence an engineering one.
      //
      // Latch reminders additionally key on the reminder number. That is what
      // lets reminder #2 through while still swallowing a duplicate #2 caused
      // by a page refresh — a plain per-VIN key would suppress every repeat
      // after the first and the reminders would stop.
      const e = env();
      const base = e.key === "prod" ? vin : `${e.key}:${vin}`;
      const key  = stillLatched
        ? `latched:${base}:${Number(ev.reminderIndex) || 1}`
        : base;

      const last = (teams.alerted || {})[key];
      if(last && Date.now() - last < CONFIG.teamsDedupeMs){
        return sendJson(res, 200, { sent: false, reason: "duplicate suppressed" });
      }

      try{
        await deliverAlert({
          vin, usoe: ev.usoe, limit: ev.limit, readingAt: ev.readingAt,
          envLabel: e.label,
          stillLatched,
          reminderIndex: Number(ev.reminderIndex) || 1,
          minutes: Number(ev.minutes) || null
        });
        teams.alerted = teams.alerted || {};
        teams.alerted[key] = Date.now();
        saveTeams();
        log(`Teams ${stillLatched ? "latch reminder" : "alert"} sent via ` +
            `${activeTransport()} (${e.key}):`, vin);
        return sendJson(res, 200, { sent: true });
      }catch(err){
        warn("Teams alert failed:", err.message);
        return sendJson(res, 502, { error: err.message });
      }
    }

    res.writeHead(405); return res.end("Method not allowed");
  }

  /* ── auth status ──
     Reports the current environment for the banner, and every environment so
     the admin panel can show both sign-in states at once. */
  if(p === "/api/auth/status"){
    const e = env();
    return sendJson(res, 200, {
      authenticated: isAuthed(e),
      env          : e.key,
      envLabel     : e.label,
      garage       : e.garageUrl,
      loginUrl     : `http://localhost:${CONFIG.port}/auth/login?env=${e.key}`,
      environments : envSummary().environments
    });
  }

  /* ── start sign-in ── */
  if(p === "/auth/login"){
    const e = envByKey(url.searchParams.get("env")) || env();
    try{
      const target = await buildAuthorizeUrl(e);
      res.writeHead(302, { Location: target });
      return res.end();
    }catch(err){
      return sendHtml(res, 500, page("Sign-in failed", err.message, false, e));
    }
  }

  /* ── OAuth redirect target ── */
  if(p === "/callback"){
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const oaErr = url.searchParams.get("error");

    // The environment key is the part of state before the first dot — see
    // buildAuthorizeUrl. Fall back to the current one for a malformed state
    // so the error page still renders in the right colours.
    const e = envByKey(state.split(".")[0]) || env();

    if(oaErr) return sendHtml(res, 400, page("Sign-in declined",
      `${oaErr}: ${url.searchParams.get("error_description") || ""}`, false, e));
    if(!e.pending || state !== e.pending.state)
      return sendHtml(res, 400, page("Sign-in failed", "State mismatch — start the sign-in again.", false, e));

    try{
      await exchangeCode(e, code);
      e.pending = null;
      log(`signed in to Garage (${e.key})`);
      return sendHtml(res, 200, page(`Signed in to ${e.label}`,
        "You're connected to Garage. This tab can be closed — the dashboard is live.", true, e));
    }catch(err){
      return sendHtml(res, 500, page("Sign-in failed", err.message, false, e));
    }
  }

  /* ── sign out ── */
  if(p === "/auth/logout"){
    const e = envByKey(url.searchParams.get("env")) || env();
    e.tokens = null;
    e.mcpSession = null;
    e.cache.clear();
    e.geoCache.clear();
    e.liveCache.clear();
    try { fs.unlinkSync(e.def.tokenFile); } catch {}
    log(`signed out of Garage (${e.key})`);
    return sendJson(res, 200, { ok: true, env: e.key });
  }

  if(req.method !== "GET"){ res.writeHead(405); return res.end("Method not allowed"); }
  return serveStatic(req, res, p);
});

/* Minimal styled page for the OAuth round-trip. The accent follows the
   environment, matching the dashboard: red for production, yellow for
   engineering — so a sign-in tab is never ambiguous about which Garage it
   just authorised. */
function page(title, msg, ok, e){
  const accent = ok ? "#12BB6A" : (e && e.key === "eng" ? "#FFC61E" : "#E82127");
  const tag = e && e.key !== "prod"
    ? `<div class="tag">${e.label}</div>` : "";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  font:14px/1.6 Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:#171A20;color:#fff;text-align:center}
 .c{max-width:420px;padding:32px}
 .d{width:44px;height:44px;border-radius:50%;margin:0 auto 20px;background:${accent}}
 .tag{display:inline-block;margin:0 0 12px;padding:3px 10px;border-radius:11px;
   background:#FFC61E;color:#171A20;font-size:10px;font-weight:700;
   letter-spacing:.12em;text-transform:uppercase}
 h1{font-size:20px;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}
 p{color:rgba(255,255,255,.66);margin:0 0 22px}
 a{display:inline-block;padding:11px 26px;border-radius:4px;background:#fff;color:#171A20;
   text-decoration:none;font-weight:600;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
</style>
<div class="c"><div class="d"></div>${tag}<h1>${title}</h1><p>${msg}</p>
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
  const e = env();

  console.log("");
  log("Charging Tracker");
  log("dashboard :", home);
  log("environment:", `${e.label} — ${e.garageUrl}` + (ENV_FORCED ? "  (pinned by GARAGE_ENV)" : ""));

  for(const other of Object.values(ENVS)){
    log(`  ${other.key === currentEnvKey ? "▸" : " "} ${other.label.padEnd(11)}`,
        `${isAuthed(other) ? "signed in " : "signed out"}  ·  live read ` +
        (liveReady(other) ? "on" : other.live.cookie ? "off (cookie saved)" : "off (no cookie)"));
  }

  log("reading   : USOE (usable state of energy)");
  log("alerts    :", teams.muted ? "MUTED (target still configured)"
    : activeTransport() === "outlook"
      ? `outlook → ${CONFIG.alertEmailTo || "your own mailbox"} (subject ${CONFIG.alertSubjectTag})`
      : teamsConfigured() ? "teams webhook" : "off");
  log("cookie chk:", `every ${Math.round(CONFIG.cookieCheckMs / 60000)} min`);
  console.log("");

  startCookieWatch();

  if(isAuthed(e)){
    log(`existing ${e.label} token found — starting live`);
    openBrowser(home);
  }else{
    log(`no ${e.label} token — opening Bouncer sign-in`);
    log("(you must be on the Tesla network / VPN)");
    openBrowser(`${home}auth/login?env=${e.key}`);
  }
});

process.on("unhandledRejection", err => warn("unhandled:", err && err.message ? err.message : err));
