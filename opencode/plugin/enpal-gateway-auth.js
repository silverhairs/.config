var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/loader/entry.ts
import { homedir as homedir9 } from "node:os";
import { join as join23 } from "node:path";

// src/oauthClient.ts
class ReLoginRequiredError extends Error {
  constructor(message = "re_login_required") {
    super(message);
    this.name = "ReLoginRequiredError";
  }
}
function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function generateVerifier() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return base64url(raw);
}
function generateState() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return base64url(raw);
}
async function challengeS256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}
function isSecureEndpoint(url) {
  return url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1";
}
function assertSecureEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (isSecureEndpoint(url))
    return;
  throw new Error(`insecure_endpoint: ${url.protocol}//${url.hostname} (https or 127.0.0.1 required)`);
}
function buildAuthorizeUrl(config, params) {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}
function handleCallback(callbackUrl, expectedState) {
  const url = new URL(callbackUrl);
  const returnedState = url.searchParams.get("state");
  if (!returnedState || returnedState !== expectedState) {
    throw new Error("state_mismatch");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("missing_code");
  }
  return code;
}
async function tokenRequest(config, deps, form, reloginOn400) {
  const response = await deps.fetch(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString()
  });
  if (reloginOn400 && response.status === 400) {
    deps.log?.("oauth.refresh_rejected re_login_required");
    throw new ReLoginRequiredError;
  }
  if (!response.ok) {
    throw new Error(`token_request_failed status=${response.status}`);
  }
  const json = await response.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: deps.now() + json.expires_in
  };
}
function exchangeAuthorizationCode(config, deps, input) {
  return tokenRequest(config, deps, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: config.clientId,
    redirect_uri: input.redirectUri
  }, false);
}
function refreshAccessToken(config, deps, refreshToken) {
  return tokenRequest(config, deps, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId
  }, true);
}

// src/loopback.ts
import { createServer } from "node:http";

// src/timeouts.ts
var BROWSER_LOGIN_DEADLINE_MS = 600000;
var BROWSER_LOGIN_CALL_MS = 30000;

// src/loopback.ts
function startLoopback(expectedState, preferredPort = 0, timeoutMs = BROWSER_LOGIN_DEADLINE_MS) {
  return new Promise((resolveLoopback, rejectLoopback) => {
    let resolveCode;
    let rejectCode;
    let settled = false;
    const codePromise = new Promise((res, rej) => {
      resolveCode = (c) => {
        settled = true;
        res(c);
      };
      rejectCode = (e) => {
        settled = true;
        rej(e);
      };
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/callback")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (err || !code || returnedState !== expectedState) {
        res.statusCode = 400;
        res.end("<html><body><h2>Enpal gateway login failed.</h2>You can close this tab.</body></html>");
        rejectCode(new Error(err ? `authorize_error: ${err}` : !code ? "missing_code" : "state_mismatch"));
        return;
      }
      res.end("<html><body><h2>Enpal gateway login complete.</h2>You can close this tab and return to opencode.</body></html>");
      resolveCode(code);
    });
    const timer = setTimeout(() => {
      if (!settled) {
        rejectCode(new Error("login_timeout"));
        server.close();
      }
    }, timeoutMs);
    if (typeof timer.unref === "function")
      timer.unref();
    server.on("error", rejectLoopback);
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferredPort;
      resolveLoopback({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        port,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timer);
          server.close();
        }
      });
    });
  });
}

// src/browser.ts
import { spawn } from "node:child_process";
import { platform } from "node:os";
function defaultBrowserSys() {
  return { platform, spawn, canOpenBrowser: defaultCanOpenBrowser };
}
function openBrowser(url, sys) {
  const p = sys.platform();
  const [cmd, args] = p === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : p === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = sys.spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
  } catch {}
}
function browserSwitchedOff(env = process.env) {
  const forced = (env.ENPAL_GATEWAY_INTERACTIVE ?? "").trim().toLowerCase();
  return forced === "0" || forced === "false" || forced === "no";
}
function defaultCanOpenBrowser(env = process.env, stdin = process.stdin) {
  if (browserSwitchedOff(env))
    return false;
  const forced = (env.ENPAL_GATEWAY_INTERACTIVE ?? "").trim().toLowerCase();
  if (forced === "1" || forced === "true" || forced === "yes")
    return true;
  if ((env.CI ?? "").trim().length > 0)
    return false;
  return stdin?.isTTY !== false;
}

// src/build/ids.ts
var PROVIDER_ID = "enpal-gateway";
var API_NPM = "@ai-sdk/openai-compatible";
var CATALOG_PATH = "/v1/models";
var PICKER_PATH = "/store/opencode.json";
var PICKER_REFRESH_HEADER = "X-Enpal-Picker-Refresh";
var PLUGIN_BUILD = "2026-10-20.1";
var PLUGIN_HIGHLIGHTS = ["OpenCode 2.x: sessions on gpt-6-luna and gpt-5.6-luna get a title"];
var PLUGIN_NOTES = "# Enpal AI Gateway plugin 2026-10-20.1\n\n- **OpenCode 2.x: sessions on gpt-6-luna and gpt-5.6-luna get a title.** OpenCode 2.x put an extra field, `provider`, into every request to the gateway. OpenAI refused the hidden request that names a new session, so those sessions stayed untitled. The plugin now leaves that field out of what it sends to the gateway. Your settings do not change.";
var DEFAULT_MODEL = `${PROVIDER_ID}/medium`;
var PLUGIN_BUILD_HEADER = "X-Enpal-Plugin-Build";
var PLUGIN_LINE = "v1";
var PLUGIN_LINE_HEADER = "X-Enpal-Plugin-Line";
var CONFIG_HOOK_TIMEOUT_MS = 2000;

// src/build/state.ts
import { createHash } from "node:crypto";
var KEY = Symbol.for("enpal.gateway.plugin.state.v1");
function processState() {
  const g = globalThis;
  const s = g[KEY] ??= { renew: new Map, relogin: new Map, picks: new Map, claims: new Map, unsaved: new Map, loginUrls: new Map, flights: new Map };
  s.unsaved ??= new Map;
  s.loginUrls ??= new Map;
  s.flights ??= new Map;
  return s;
}
function normalisedBase(base) {
  const trimmed = String(base ?? "").trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
function gatewayBaseOf(config) {
  return normalisedBase(config.tokenEndpoint.replace(/\/oauth\/token\/?$/, ""));
}
function baseKey(base) {
  const n = normalisedBase(base);
  const slug = n.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${slug || "gateway"}-${createHash("sha256").update(n).digest("hex").slice(0, 8)}`;
}
function oncePerProcess(map, key, start) {
  const existing = map.get(key);
  if (existing)
    return existing;
  const promise = start();
  map.set(key, promise);
  return promise;
}
function renewKey(base, clientId, refresh) {
  return JSON.stringify([normalisedBase(base), clientId, refresh]);
}
function reloginKey(base, clientId) {
  return JSON.stringify([normalisedBase(base), clientId]);
}
function singleFlight(map, key, start) {
  const inflight = map.get(key);
  if (inflight)
    return inflight;
  const promise = start();
  map.set(key, promise);
  const done = () => {
    if (map.get(key) === promise)
      map.delete(key);
  };
  promise.then(done, done);
  return promise;
}
function defaultDeps() {
  return { fetch: globalThis.fetch, now: () => Math.floor(Date.now() / 1000) };
}

// src/build/http.ts
async function readBounded(res, max) {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > max) {
    try {
      await res.body?.cancel();
    } catch {}
    throw new Error("body_oversize");
  }
  const body = res.body;
  if (!body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max)
      throw new Error("body_oversize");
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error("body_oversize");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
async function readBoundedJson(res, max) {
  return JSON.parse(new TextDecoder().decode(await readBounded(res, max)));
}
function untilAborted(promise, signal) {
  if (!signal)
    return promise;
  if (signal.aborted)
    return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((v) => {
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    }, (e) => {
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}
function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// src/build/auth.ts
function configFor(base, clientId) {
  const config = {
    authorizeEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    clientId: clientId ?? "opencode",
    skewSeconds: 60
  };
  assertSecureEndpoint(config.authorizeEndpoint);
  assertSecureEndpoint(config.tokenEndpoint);
  return config;
}
function serviceKeyFromEnv(env = process.env) {
  const raw = (env.ENPAL_GATEWAY_SERVICE_KEY ?? "").trim();
  return raw.length > 0 ? raw : null;
}
class NonInteractiveLoginRequiredError extends Error {
  constructor() {
    super("enpal_gateway_login_expired: the stored login has expired and this process cannot open a browser " + "(no TTY, or CI is set). For automation, mint a service key and set ENPAL_GATEWAY_SERVICE_KEY — it " + "does not expire mid-run and carries its own budget. For an interactive session, run `opencode auth " + "login` once and retry.");
    this.name = "NonInteractiveLoginRequiredError";
  }
}
function sharedRefresh(config, deps, persist, refresh, opts = {}) {
  const key = renewKey(gatewayBaseOf(config), config.clientId, refresh);
  return singleFlight(processState().renew, key, async () => {
    const unsaved = processState().unsaved;
    const held = unsaved.get(key);
    const sameFamily = held ? held.sameFamily : true;
    const skew = config.skewSeconds ?? 60;
    let t;
    if (held && deps.now() < held.tokens.expires_at - skew && held.tokens.access_token !== opts.staleAccess) {
      t = held.tokens;
    } else {
      try {
        t = await refreshAccessToken(config, boundedFetch(deps, REFRESH_TIMEOUT_MS), held?.tokens.refresh_token ?? refresh);
      } catch (e) {
        if (e instanceof ReLoginRequiredError)
          unsaved.delete(key);
        throw e;
      }
    }
    const renewed = { ...t, sameFamily };
    try {
      await persist(t);
      unsaved.delete(key);
    } catch (e) {
      unsaved.set(key, { tokens: t, sameFamily });
      throw new PersistFailedError(renewed, e);
    }
    return renewed;
  });
}
function unsavedSuccessor(config, refresh) {
  return processState().unsaved.get(renewKey(gatewayBaseOf(config), config.clientId, refresh));
}
var REFRESH_TIMEOUT_MS = 30000;
function boundedFetch(deps, ms) {
  return { ...deps, fetch: (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    return deps.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } };
}

class PersistFailedError extends Error {
  tokens;
  constructor(tokens, cause) {
    super(`persist_failed: ${cause?.message ?? String(cause)}`);
    this.name = "PersistFailedError";
    this.tokens = tokens;
  }
}
function persistVia(client) {
  return async (t) => {
    const r = await client.auth.set({
      path: { id: PROVIDER_ID },
      body: { type: "oauth", access: t.access_token, refresh: t.refresh_token, expires: t.expires_at * 1000 },
      throwOnError: true
    });
    const err = r && typeof r === "object" ? r.error : undefined;
    if (err)
      throw new Error(`auth store refused the pair: ${err?.message ?? "error"}`);
  };
}
var BROWSER_REOPEN_AFTER_MS = 5000;
function browserFlight(config, deps, opts = {}) {
  const key = reloginKey(gatewayBaseOf(config), config.clientId);
  const state0 = processState();
  const flights = state0.flights;
  const existing = flights.get(key);
  if (existing && !existing.settled()) {
    existing.attach(opts);
    return existing;
  }
  const deadlineMs = opts.deadlineMs ?? BROWSER_LOGIN_DEADLINE_MS;
  const callMs = opts.callMs ?? BROWSER_LOGIN_CALL_MS;
  let resolveUrl;
  let rejectUrl;
  const url = new Promise((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  url.catch(() => {});
  done.catch(() => {});
  let resolveCode;
  let rejectCode;
  const delivered = new Promise((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  delivered.catch(() => {});
  const controller = new AbortController;
  let persist = opts.persist;
  let afterSave = opts.afterSave;
  let authorizeUrl = "";
  let openedAt = -Infinity;
  const openWith = (open) => {
    openedAt = Date.now();
    open(authorizeUrl);
  };
  let owners = 0;
  let settled = false;
  let saved = false;
  let loopback = null;
  let state = "";
  const end = (err, t) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    controller.abort();
    try {
      loopback?.close();
    } catch {}
    if (flights.get(key) === flight)
      flights.delete(key);
    if (state0.relogin.get(key) === done)
      state0.relogin.delete(key);
    if (state0.loginUrls.get(key))
      state0.loginUrls.delete(key);
    if (t)
      resolveDone(t);
    else {
      rejectUrl(err);
      rejectDone(err);
    }
  };
  const flight = {
    url,
    done,
    saved: () => saved,
    settled: () => settled,
    attach(o) {
      persist ??= o.persist;
      afterSave ??= o.afterSave;
      if (o.open && authorizeUrl && Date.now() - openedAt >= BROWSER_REOPEN_AFTER_MS)
        openWith(o.open);
    },
    join() {
      owners += 1;
      let released = false;
      return () => {
        if (released)
          return;
        released = true;
        owners -= 1;
        if (owners <= 0 && !settled) {
          deps.log?.("oauth.relogin_closed no_owner");
          end(new Error("login_cancelled"));
        }
      };
    },
    deliver(callbackUrl) {
      try {
        resolveCode(handleCallback(callbackUrl, state));
      } catch (e) {
        rejectCode(e);
      }
    }
  };
  const timer = setTimeout(() => end(new Error("login_timeout")), deadlineMs);
  flights.set(key, flight);
  state0.relogin.set(key, done);
  const bounded = { ...deps, fetch: (input, init) => {
    const signals = [controller.signal, AbortSignal.timeout(callMs)];
    if (init?.signal)
      signals.push(init.signal);
    return deps.fetch(input, { ...init, signal: AbortSignal.any(signals) });
  } };
  (async () => {
    try {
      const verifier = generateVerifier();
      state = generateState();
      const codeChallenge = await challengeS256(verifier);
      if (settled)
        return;
      loopback = await startLoopback(state, 0, deadlineMs);
      if (settled) {
        loopback.close();
        return;
      }
      const u = buildAuthorizeUrl(config, { redirectUri: loopback.redirectUri, codeChallenge, state });
      state0.loginUrls.set(key, u);
      resolveUrl(u);
      deps.log?.("oauth.relogin_started");
      authorizeUrl = u;
      if (opts.open)
        openWith(opts.open);
      const code = await untilAborted(Promise.race([loopback.waitForCode(), delivered]), controller.signal);
      openedAt = Infinity;
      loopback.close();
      const t = await exchangeAuthorizationCode(config, bounded, { code, codeVerifier: verifier, redirectUri: loopback.redirectUri });
      if (settled)
        return;
      if (persist) {
        const saving = persist(t);
        saving.then(() => {
          saved = true;
          try {
            afterSave?.();
          } catch {}
        }, () => {});
        try {
          await untilAborted(Promise.race([saving, new Promise((_, rej) => {
            const s = setTimeout(() => rej(new Error("save_timeout")), callMs);
            s.unref?.();
          })]), controller.signal);
        } catch (e) {
          if (settled)
            return;
          end(new PersistFailedError({ ...t, sameFamily: false }, e));
          return;
        }
      }
      end(undefined, t);
    } catch (e) {
      end(e);
    }
  })();
  return flight;
}
function interactiveRelogin(config, deps, sys, persist, opts = {}) {
  const key = reloginKey(gatewayBaseOf(config), config.clientId);
  if (opts.join !== false) {
    const flight2 = processState().flights.get(key);
    if (flight2 && !flight2.settled()) {
      flight2.attach({ persist, afterSave: opts.afterSave });
      const release2 = flight2.join();
      flight2.done.then(release2, release2);
      return flight2.done;
    }
    const inflight = processState().relogin.get(key);
    if (inflight)
      return inflight;
  }
  if (opts.join === false || sys.canOpenBrowser?.() === false) {
    deps.log?.("oauth.relogin_skipped non_interactive");
    return Promise.reject(new NonInteractiveLoginRequiredError);
  }
  const flight = browserFlight(config, deps, { open: (u) => openBrowser(u, sys), persist, afterSave: opts.afterSave, deadlineMs: opts.loopbackTimeoutMs });
  const release = flight.join();
  flight.done.then(release, release);
  return flight.done;
}
function buildAuthHook(client, config, deps = defaultDeps(), sys = defaultBrowserSys(), notes, events = {}, method = {}) {
  const skew = config.skewSeconds ?? 60;
  const persist = persistVia(client);
  const browserLogin = async (stored) => {
    try {
      return await interactiveRelogin(config, deps, sys, persist, { afterSave: () => {
        try {
          events.onLoginReplaced?.(stored);
        } catch {}
      } });
    } catch (e) {
      if (!(e instanceof PersistFailedError))
        throw e;
      deps.log?.("oauth.persist_failed after_login");
      processState().unsaved.set(renewKey(gatewayBaseOf(config), config.clientId, stored), { tokens: e.tokens, sameFamily: false });
      return e.tokens;
    }
  };
  const renew = async (refresh, opts = {}) => {
    let t;
    let savedRotation = false;
    try {
      t = await sharedRefresh(config, deps, persist, refresh, opts);
      savedRotation = true;
    } catch (e) {
      if (e instanceof PersistFailedError) {
        deps.log?.("oauth.persist_failed");
        t = e.tokens;
      } else if (!(e instanceof ReLoginRequiredError)) {
        throw e;
      } else {
        t = { ...await browserLogin(refresh), sameFamily: false };
      }
    }
    if (savedRotation && t.refresh_token !== refresh) {
      try {
        if (t.sameFamily)
          events.onRotated?.(refresh, t.refresh_token);
        else
          events.onLoginReplaced?.(refresh);
      } catch {}
    }
    return t;
  };
  const latestAccess = async (getAuth, current) => {
    const latest = await getAuth();
    if (!latest || latest.type !== "oauth")
      return null;
    if (latest.refresh !== current.refresh && latest.access && latest.access !== current.access) {
      return { access: latest.access, refresh: latest.refresh, rotated: true };
    }
    return { access: latest.access, refresh: latest.refresh, rotated: false };
  };
  return {
    provider: PROVIDER_ID,
    loader: async (getAuth) => {
      const auth = await getAuth();
      if (!auth || auth.type !== "oauth")
        return null;
      return {
        apiKey: "",
        async fetch(input, init) {
          const send = async (token) => {
            const headers = new Headers(init?.headers);
            headers.set("Authorization", `Bearer ${token}`);
            headers.set(PLUGIN_BUILD_HEADER, PLUGIN_BUILD);
            headers.set(PLUGIN_LINE_HEADER, PLUGIN_LINE);
            const response2 = await deps.fetch(input, { ...init, headers });
            try {
              events.onResponse?.(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, response2);
            } catch {}
            try {
              if (response2.ok)
                notes?.record(headers, response2.headers);
            } catch {}
            return response2;
          };
          const serviceKey = serviceKeyFromEnv();
          if (serviceKey)
            return send(serviceKey);
          const current = await getAuth();
          let access = current.access;
          const expiresAt = current.expires ? Math.floor(current.expires / 1000) : 0;
          const held = unsavedSuccessor(config, current.refresh);
          if (held && deps.now() < held.tokens.expires_at - skew) {
            access = held.tokens.access_token;
          } else if (held || !access || deps.now() >= expiresAt - skew) {
            access = (await renew(current.refresh)).access_token;
          }
          const response = await send(access);
          if (response.status !== 401)
            return response;
          deps.log?.("oauth.retry_after_401");
          const latest = await latestAccess(getAuth, current);
          if (latest?.rotated && latest.access && latest.access !== access)
            return send(latest.access);
          let renewed = await renew(latest?.refresh || current.refresh, { staleAccess: access });
          if (renewed.access_token === access)
            renewed = await renew(latest?.refresh || current.refresh, { staleAccess: access });
          return send(renewed.access_token);
        }
      };
    },
    methods: [
      {
        type: "oauth",
        label: "Enpal AI Gateway (browser login)",
        authorize: async () => {
          const env = method.env ?? process.env;
          const open = browserSwitchedOff(env) || (env.CI ?? "").trim().length > 0 ? undefined : (u) => openBrowser(u, sys);
          const flight = browserFlight(config, deps, { open, deadlineMs: method.deadlineMs });
          const release = flight.join();
          let url;
          try {
            url = await flight.url;
          } catch (e) {
            release();
            throw e;
          }
          return {
            url,
            instructions: open ? "A browser window opens for the Enpal sign-in. If it does not, open the link above. Then return to OpenCode." : "Open the link above and sign in with your Enpal account, then return to OpenCode.",
            method: "auto",
            callback: async (callbackUrl) => {
              try {
                if (callbackUrl)
                  flight.deliver(callbackUrl);
                const t = await flight.done;
                return {
                  type: "success",
                  access: t.access_token,
                  refresh: t.refresh_token,
                  expires: t.expires_at * 1000
                };
              } finally {
                release();
              }
            }
          };
        }
      }
    ]
  };
}

// src/base.ts
var DEFAULT_BASE = "https://api.core.enpal.io/ai/aep/gateway";
function resolveBase(env = process.env) {
  const raw = env.ENPAL_GATEWAY_BASE ?? DEFAULT_BASE;
  if (raw.startsWith("__ENPAL_")) {
    throw new Error("unsubstituted_gateway_base: this bundle was not served by the gateway store, so it carries no " + "default host. Set ENPAL_GATEWAY_BASE, or fetch the bundle from <gateway>/store/.");
  }
  return raw.replace(/\/+$/, "");
}

// src/build/server.ts
import { homedir as homedir7 } from "node:os";
import { join as join16 } from "node:path";
import { readFileSync as readFileSync12, statSync as statSync10 } from "node:fs";

// src/build/catalog.ts
var FALLBACK_CATALOG = [
  {
    id: "medium",
    object: "model",
    name: "medium (Qwen3-235B) — offline fallback",
    capabilities: { toolcall: true },
    status: "active"
  },
  {
    id: "low",
    object: "model",
    name: "low (Qwen3-30B) — offline fallback",
    capabilities: { toolcall: true },
    status: "active"
  }
];
var LYCEUM_FAMILY = new Set([
  "minimax-m3",
  "kimi-k3",
  "qwen3.8",
  "glm-5.2",
  "glm-5.2-instant",
  "glm-5.3-flash-lyceum",
  "gpt-oss-120b",
  "qwen2.5-vl-72b",
  "deepseek-v4-flash-lyceum"
]);
var OPENROUTER_FAMILY = new Set(["glm-5.3-flash-openrouter", "kimi-k3-openrouter"]);
var REQUESTY_FAMILY = new Set([
  "glm-5.3-flash-requesty",
  "glm-5.3-requesty",
  "gemini-3.7-flash-requesty",
  "gemini-3.8-flash-requesty",
  "grok-4.6-requesty",
  "deepseek-v4-pro-requesty",
  "deepseek-v4-flash-requesty",
  "kimi-k3-requesty",
  "glm-5.2-requesty",
  "minimax-m3-requesty",
  "kimi-k2.7-code-requesty",
  "qwen3.8-requesty"
]);
function catalogFamily(id) {
  if (id.endsWith("-nebius"))
    return "Nebius";
  if (REQUESTY_FAMILY.has(id))
    return "Requesty";
  if (OPENROUTER_FAMILY.has(id))
    return "OpenRouter";
  if (id.startsWith("gemini-"))
    return "Google";
  if (id.startsWith("claude-"))
    return "Anthropic";
  if (id === "gpt-5-codex" || id.startsWith("gpt-5.6-") || id.startsWith("gpt-6-"))
    return "OpenAI";
  if (LYCEUM_FAMILY.has(id))
    return "Lyceum";
  return "";
}
var SAMPLING_PRESETS = {
  low: { temperature: 0.2 },
  medium: { temperature: 0.5 },
  high: { temperature: 0.8 },
  max: { temperature: 1 }
};
function mapCatalogEntryToModel(entry, base) {
  const caps = entry.capabilities ?? {};
  return {
    id: entry.id,
    providerID: PROVIDER_ID,
    api: { id: entry.id, url: `${base}/v1`, npm: API_NPM },
    name: entry.name ?? entry.id,
    family: catalogFamily(entry.id),
    capabilities: {
      temperature: caps.temperature ?? true,
      reasoning: caps.reasoning ?? false,
      attachment: caps.attachment ?? ((caps.image || caps.pdf) ?? false),
      toolcall: caps.toolcall ?? true,
      input: { text: true, audio: false, image: caps.image ?? false, video: false, pdf: caps.pdf ?? false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: caps.reasoning ?? false ? { field: "reasoning_content" } : false
    },
    cost: {
      input: entry.cost?.input ?? 0,
      output: entry.cost?.output ?? 0,
      cache: { read: entry.cost?.cache?.read ?? 0, write: entry.cost?.cache?.write ?? 0 }
    },
    limit: { context: entry.limit?.context ?? 0, input: entry.limit?.input, output: entry.limit?.output ?? 0 },
    status: entry.status ?? "active",
    options: {},
    headers: {},
    release_date: entry.release_date ?? "",
    variants: (entry.effort?.length ?? 0) > 0 ? Object.fromEntries((entry.effort ?? []).map((level) => [level, { reasoningEffort: level }])) : { ...SAMPLING_PRESETS }
  };
}
function toModelRecord(entries, base) {
  const out = {};
  for (const e of entries)
    out[e.id] = mapCatalogEntryToModel(e, base);
  return out;
}
function buildProviderHook(base, deps = defaultDeps(), timeoutMs = CONFIG_HOOK_TIMEOUT_MS) {
  return {
    id: PROVIDER_ID,
    models: async (_provider, ctx) => {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const access = ctx?.auth?.type === "oauth" ? ctx.auth.access : ctx?.auth?.access;
        const headers = {};
        if (access)
          headers["Authorization"] = `Bearer ${access}`;
        const res = await deps.fetch(`${base}${CATALOG_PATH}`, { headers, signal: controller.signal });
        if (!res.ok)
          throw new Error(`catalog_http_${res.status}`);
        const body = await res.json();
        const entries = body?.data;
        if (!Array.isArray(entries) || entries.length === 0)
          throw new Error("catalog_empty");
        return toModelRecord(entries, base);
      } catch {
        return toModelRecord(FALLBACK_CATALOG, base);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

// src/build/features.ts
import { createHash as createHash3 } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// src/build/picker.ts
import { createHash as createHash2 } from "node:crypto";
var PICKER_ROW_FIELDS = [
  "name",
  "limit",
  "modalities",
  "attachment",
  "reasoning",
  "release_date",
  "variants",
  "tool_call",
  "temperature",
  "cost",
  "status"
];
var PICKER_HEADER_PREFIX = "x-enpal-";
function pickEnpalHeaders(headers) {
  if (typeof headers !== "object" || headers === null)
    return;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase().startsWith(PICKER_HEADER_PREFIX) && typeof v === "string")
      out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
function pickRowFields(row) {
  const out = {};
  for (const k of PICKER_ROW_FIELDS)
    if (k in row)
      out[k] = row[k];
  const headers = pickEnpalHeaders(row.headers);
  if (headers)
    out.headers = headers;
  return out;
}
var MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
var MODEL_STATUSES = new Set(["alpha", "beta", "deprecated", "active"]);
var RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
var isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
function isValidPickerRow(row) {
  if (!isPlainObject(row) || typeof row.name !== "string")
    return false;
  const limit = row.limit;
  if (!isPlainObject(limit) || !isFiniteNumber(limit.context) || !isFiniteNumber(limit.output))
    return false;
  if (limit.input !== undefined && !isFiniteNumber(limit.input))
    return false;
  if (row.modalities !== undefined) {
    const m = row.modalities;
    if (!isPlainObject(m))
      return false;
    for (const side of [m.input, m.output]) {
      if (!Array.isArray(side) || !side.every((x) => typeof x === "string" && MODALITIES.has(x)))
        return false;
    }
  }
  for (const k of ["attachment", "reasoning", "tool_call", "temperature"]) {
    if (row[k] !== undefined && typeof row[k] !== "boolean")
      return false;
  }
  if (row.status !== undefined && !MODEL_STATUSES.has(row.status))
    return false;
  if (row.release_date !== undefined && typeof row.release_date !== "string")
    return false;
  if (row.variants !== undefined && !(isPlainObject(row.variants) && Object.values(row.variants).every(isPlainObject))) {
    return false;
  }
  if (row.cost !== undefined) {
    const c = row.cost;
    if (!isPlainObject(c) || !isFiniteNumber(c.input) || !isFiniteNumber(c.output))
      return false;
  }
  return true;
}
async function fetchServedPicker(base, deps, signal) {
  if (signal?.aborted)
    return { ok: false, reason: "timeout" };
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CONFIG_HOOK_TIMEOUT_MS);
  const onOuter = () => controller.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await deps.fetch(`${base}${PICKER_PATH}`, {
      headers: { Accept: "application/json", [PLUGIN_BUILD_HEADER]: PLUGIN_BUILD, [PLUGIN_LINE_HEADER]: deps.line ?? PLUGIN_LINE },
      signal: controller.signal,
      redirect: "error"
    });
    if (!res.ok)
      return { ok: false, reason: `http_${res.status}` };
    const refresh = res.headers?.get?.(PICKER_REFRESH_HEADER) === "1";
    const served = await readBoundedJson(res, PICKER_FILE_MAX);
    const models = served?.provider?.[PROVIDER_ID]?.models;
    if (!isPlainObject(models))
      return { ok: false, reason: "no_served_models" };
    const ids = Object.keys(models);
    if (ids.length === 0)
      return { ok: false, reason: "served_map_empty" };
    if (!ids.every((id) => !RESERVED_IDS.has(id) && isValidPickerRow(models[id]))) {
      return { ok: false, reason: "served_row_malformed" };
    }
    const enabled = Array.isArray(served.enabled_providers) && served.enabled_providers.every((x) => typeof x === "string" && x) ? [...served.enabled_providers] : [];
    return { ok: true, refresh, models, enabled_providers: enabled };
  } catch (e) {
    const name = e?.name;
    return { ok: false, reason: name === "AbortError" || controller.signal.aborted ? "timeout" : e?.message === "body_oversize" ? "oversize" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuter);
  }
}
var PICKER_FILE_MAX = 512 * 1024;
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function rowsDigest(models) {
  const rows = {};
  for (const [id, row] of Object.entries(models))
    rows[id] = isPlainObject(row) ? pickRowFields(row) : null;
  return createHash2("sha256").update(canonicalJson(rows)).digest("hex");
}
function servedDigest(served) {
  if (!served.ok)
    return "";
  return createHash2("sha256").update(canonicalJson({ rows: rowsDigest(served.models), refresh: served.refresh, enabled: served.enabled_providers })).digest("hex");
}

// src/build/features.ts
var FEATURES_PATH = "/me/features";
var FEATURES_BODY_MAX = 256 * 1024;
var FEATURES_FILE_MAX = 256 * 1024;
var KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
var ROW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
var RESERVED_IDS2 = new Set(["__proto__", "constructor", "prototype"]);
var REVISION_RE = /^[0-9a-f]{16,64}$/;
var LIVE_PICKER = "live-picker";
var LIVE_BUILDS = "live-builds";
var LIVE_KEYS = new Set([LIVE_PICKER, LIVE_BUILDS]);
var BUILD_EFFECT_KEYS = new Set(["auto", ...LIVE_KEYS]);
function keyOn(answer, key) {
  const entries = answer.features.filter((f) => f.key === key);
  return entries.length === 1 && entries[0].on === true;
}
function linkOf(refresh) {
  return createHash3("sha256").update(refresh).digest("hex");
}
function cacheLinked(c, refresh) {
  const h = linkOf(refresh);
  return c.link === h || c.prev === h;
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function readJsonFile(path, max) {
  try {
    if (statSync(path).size > max)
      return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonAtomically(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 384 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}
function fileFeaturesStore(dir) {
  const cachePath = join(dir, "features.json");
  const daysPath = join(dir, "feature-notices.json");
  const load = () => {
    const raw = readJsonFile(cachePath, FEATURES_FILE_MAX);
    if (!isRecord(raw) || typeof raw.subject !== "string" || typeof raw.link !== "string")
      return null;
    const answer = parseFeaturesAnswer(raw.answer);
    if (!answer)
      return null;
    return { subject: raw.subject, link: raw.link, ...typeof raw.prev === "string" ? { prev: raw.prev } : {}, answer, at: typeof raw.at === "number" ? raw.at : 0 };
  };
  return {
    load,
    save: (f) => {
      try {
        writeJsonAtomically(cachePath, f);
      } catch {}
    },
    clear: () => {
      try {
        writeJsonAtomically(cachePath, {});
      } catch {}
    },
    relink: (from, to) => {
      const f = load();
      if (f && (f.link === from || f.prev === from)) {
        try {
          writeJsonAtomically(cachePath, { ...f, link: to, prev: from });
        } catch {}
      }
    },
    reminders: () => {
      const raw = readJsonFile(daysPath, FEATURES_FILE_MAX);
      if (!isRecord(raw))
        return {};
      const out = {};
      for (const [subject, keys] of Object.entries(raw)) {
        if (!isRecord(keys))
          continue;
        for (const [key, v] of Object.entries(keys)) {
          if (isRecord(v) && typeof v.version === "number" && typeof v.day === "string")
            (out[subject] ??= {})[key] = { version: v.version, day: v.day };
        }
      }
      return out;
    },
    saveReminders: (d) => {
      try {
        writeJsonAtomically(daysPath, d);
      } catch {}
    }
  };
}
function parseFeaturesAnswer(body) {
  if (!isRecord(body) || !Array.isArray(body.features))
    return null;
  const count = new Map;
  for (const raw of body.features) {
    if (isRecord(raw) && typeof raw.key === "string" && KEY_RE.test(raw.key))
      count.set(raw.key, (count.get(raw.key) ?? 0) + 1);
  }
  const features = [];
  for (const raw of body.features) {
    if (!isRecord(raw) || typeof raw.key !== "string" || !KEY_RE.test(raw.key) || count.get(raw.key) !== 1 || typeof raw.on !== "boolean")
      continue;
    const entry = { key: raw.key, on: raw.on };
    if (typeof raw.why === "string")
      entry.why = raw.why;
    if (typeof raw.name === "string" && raw.name.trim())
      entry.name = raw.name.trim();
    if (isRecord(raw.notice) && typeof raw.notice.version === "number" && Number.isInteger(raw.notice.version) && typeof raw.notice.text === "string") {
      entry.notice = { version: raw.notice.version, text: raw.notice.text };
    } else {
      entry.notice = null;
    }
    entry.notice_seen = typeof raw.notice_seen === "number" && Number.isInteger(raw.notice_seen) ? raw.notice_seen : null;
    const rows = {};
    const ids = new Set;
    if (isRecord(raw.picker_rows)) {
      for (const [id, row] of Object.entries(raw.picker_rows)) {
        if (RESERVED_IDS2.has(id) || !ROW_ID_RE.test(id))
          continue;
        ids.add(id);
        if (isValidPickerRow(row))
          rows[id] = pickRowFields(row);
      }
    }
    if (Array.isArray(raw.row_ids)) {
      for (const id of raw.row_ids)
        if (typeof id === "string" && ROW_ID_RE.test(id) && !RESERVED_IDS2.has(id))
          ids.add(id);
    }
    if (ids.size)
      entry.row_ids = [...ids];
    if (Object.keys(rows).length)
      entry.picker_rows = rows;
    features.push(entry);
  }
  const out = { features };
  if (typeof body.subject === "string" && body.subject)
    out.subject = body.subject;
  out.portal_url = typeof body.portal_url === "string" && body.portal_url.startsWith("https://") ? body.portal_url : null;
  out.plugin_build_current = typeof body.plugin_build_current === "string" ? body.plugin_build_current : null;
  if (typeof body.revision === "string" && REVISION_RE.test(body.revision))
    out.revision = body.revision;
  return out;
}
function followRotation(store, from, t) {
  if (t.refresh_token === from)
    return;
  if (t.sameFamily)
    store.relink(linkOf(from), linkOf(t.refresh_token));
  else {
    const c = store.load();
    if (c && cacheLinked(c, from))
      store.clear();
  }
}
async function readFeaturesAtStart(d) {
  const log = (m) => {
    try {
      d.log?.(m);
    } catch {}
  };
  if (d.serviceKey)
    return { kind: "no_subject" };
  if (!d.login)
    return { kind: "no_subject" };
  let { access, refresh } = d.login.record;
  const cached = () => {
    const c = d.store.load();
    return c && cacheLinked(c, refresh) ? { kind: "answer", answer: c.answer, fresh: false, subject: c.subject } : { kind: "unknown" };
  };
  if (d.signal?.aborted) {
    log("features: no time left at start");
    return cached();
  }
  const skew = d.skewSeconds ?? d.config.skewSeconds ?? 60;
  const expiresAt = Math.floor(d.login.record.expires / 1000);
  if (!access || d.deps.now() >= expiresAt - skew) {
    if (d.login.source === "env") {
      log("features: login from OPENCODE_AUTH_CONTENT expired; not refreshed here");
      return cached();
    }
    if (d.silentRefresh === false) {
      log("features: the host's credential is expired; not refreshed here");
      return cached();
    }
    try {
      const flight = sharedRefresh(d.config, d.deps, d.persist, refresh);
      flight.then((t2) => followRotation(d.store, refresh, t2)).catch(() => {});
      const t = await untilAborted(flight, d.signal);
      access = t.access_token;
      refresh = t.refresh_token;
    } catch (e) {
      if (e instanceof ReLoginRequiredError) {
        log("features: the login was refused; a sign-in is needed");
        return { kind: "no_subject", refused: linkOf(refresh) };
      }
      if (e instanceof PersistFailedError) {
        log("features: the refreshed pair could not be saved; not used");
        return cached();
      }
      log(`features: refresh did not finish in time (${e?.message ?? e})`);
      return cached();
    }
    if (d.signal?.aborted) {
      log("features: no time left after the refresh");
      return cached();
    }
  }
  try {
    const res = await d.deps.fetch(`${d.base}${FEATURES_PATH}`, {
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json", [PLUGIN_BUILD_HEADER]: PLUGIN_BUILD, [PLUGIN_LINE_HEADER]: d.line ?? PLUGIN_LINE },
      signal: d.signal,
      redirect: "error"
    });
    if (res.status === 404) {
      d.store.clear();
      return { kind: "disabled" };
    }
    if (res.status === 401 || res.status === 403)
      return { kind: "no_subject" };
    if (!res.ok) {
      log(`features: http ${res.status}`);
      return cached();
    }
    const answer = parseFeaturesAnswer(await readBoundedJson(res, FEATURES_BODY_MAX));
    if (!answer) {
      log("features: answer malformed");
      return cached();
    }
    if (answer.subject)
      d.store.save({ subject: answer.subject, link: linkOf(refresh), answer, at: d.deps.now() });
    else
      d.store.clear();
    return { kind: "answer", answer, fresh: true, subject: answer.subject ?? null };
  } catch (e) {
    log(`features: unreachable (${e?.message ?? e})`);
    return cached();
  }
}
function ownershipOf(state, catalogue, log) {
  const claims = new Map;
  const claim = (key, id) => {
    if (RESERVED_IDS2.has(id))
      return;
    const keys = claims.get(id) ?? new Set;
    keys.add(key);
    claims.set(id, keys);
  };
  if (isRecord(catalogue)) {
    for (const [key, v] of Object.entries(catalogue)) {
      if (KEY_RE.test(key) && isRecord(v) && isRecord(v.picker_rows))
        for (const id of Object.keys(v.picker_rows))
          claim(key, id);
    }
  }
  if (state.kind === "answer")
    for (const f of state.answer.features)
      for (const id of f.row_ids ?? [])
        claim(f.key, id);
  const disputed = new Set([...claims].filter(([, keys]) => keys.size > 1).map(([id]) => id));
  if (disputed.size) {
    try {
      log?.(`features: row ids claimed by two features are dropped: ${[...disputed].join(", ")}`);
    } catch {}
  }
  const owned = {};
  for (const [id, keys] of claims)
    if (!disputed.has(id))
      for (const key of keys)
        (owned[key] ??= []).push(id);
  return { owned, disputed };
}
function rowsFor(state, catalogue, log) {
  const { owned, disputed } = ownershipOf(state, catalogue, log);
  const out = { add: {}, remove: new Set, owned };
  if (state.kind !== "answer")
    return out;
  const on = new Set(state.answer.features.filter((f) => f.on).map((f) => f.key));
  for (const f of state.answer.features) {
    if (f.on) {
      for (const [id, row] of Object.entries(f.picker_rows ?? {}))
        if (!disputed.has(id))
          out.add[id] = row;
    }
  }
  for (const [key, ids] of Object.entries(owned))
    if (!on.has(key))
      for (const id of ids)
        out.remove.add(id);
  for (const id of disputed)
    out.remove.add(id);
  return out;
}
function recognised(f, catalogue) {
  if (BUILD_EFFECT_KEYS.has(f.key))
    return true;
  if (f.picker_rows && Object.keys(f.picker_rows).length)
    return true;
  const snap = isRecord(catalogue) ? catalogue[f.key] : undefined;
  return !!(isRecord(snap) && isRecord(snap.picker_rows) && Object.keys(snap.picker_rows).length);
}
function createReminders(store, showToast, today = () => new Date().toISOString().slice(0, 10)) {
  let state = null;
  let catalogue = null;
  let armedModel = null;
  const done = new Set;
  const remind = () => {
    if (armedModel === null || !state || state.kind !== "answer" || !showToast)
      return;
    const subject = state.subject ?? "-";
    const days = store.reminders();
    const { owned } = ownershipOf(state, catalogue);
    let changed = false;
    for (const f of state.answer.features) {
      if (!f.on || !f.notice || (f.notice_seen ?? 0) >= f.notice.version || !recognised(f, catalogue))
        continue;
      const mine = owned[f.key];
      if (mine?.length && !mine.includes(armedModel))
        continue;
      const tag = `${subject}:${f.key}:${f.notice.version}`;
      if (done.has(tag))
        continue;
      const seen = days[subject]?.[f.key];
      if (seen && seen.version === f.notice.version && seen.day === today()) {
        done.add(tag);
        continue;
      }
      done.add(tag);
      (days[subject] ??= {})[f.key] = { version: f.notice.version, day: today() };
      changed = true;
      const where = state.answer.portal_url ? `${state.answer.portal_url}/#my-features` : "the Enpal AI portal, under My features";
      const notice = f.notice;
      const identity = { subject, key: f.key, version: notice.version, day: today() };
      Promise.resolve().then(() => showToast(`${f.name ?? f.key} is on for you`, `${notice.text} Read what it means, or switch it off: ${where}`, identity)).catch(() => {});
    }
    if (changed)
      store.saveReminders(days);
  };
  return {
    arm(s, snapshot) {
      state = s;
      catalogue = snapshot ?? null;
      remind();
    },
    modelCall(input) {
      if (input?.agent === "title" || input?.agent === "compaction")
        return;
      if (input?.model?.providerID !== PROVIDER_ID || typeof input.model.id !== "string")
        return;
      armedModel = input.model.id;
      remind();
    }
  };
}

// src/build/notices.ts
import { join as join2 } from "node:path";
import { readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
function retiredNotice(id, replacement, isDefault) {
  return {
    id: `retired:${id}`,
    title: `${id} was retired`,
    variant: "warning",
    group: "retired",
    item: replacement ? `${id} (use ${replacement})` : id,
    flag: isDefault,
    message: `${id} was retired and removed from your picker${replacement ? `; use ${replacement}` : ""}.` + (isDefault ? " Your default model still points at it; pick another one (/enpal-doctor can help)." : "")
  };
}
function welcomeNotice(line) {
  return {
    id: "welcome",
    title: "Welcome to Enpal AI Gateway",
    variant: "info",
    duration: 60000,
    ephemeral: true,
    message: "This OpenCode is powered by Enpal AI Gateway. Please run " + (line === "v2" ? "`opencode auth login` and choose Enpal AI Gateway" : "/enpal-login") + " to log in."
  };
}
function restartHint(line) {
  return line === "v2" ? "Type `/enpal-restart` in OpenCode" : "Restart OpenCode";
}
var JOIN = "|";
function idsOf(id) {
  return id.split(JOIN).filter(Boolean);
}
function batches(list) {
  const out = [];
  const groups = new Map;
  for (const n of list) {
    if (!n.group) {
      out.push(n);
      continue;
    }
    const members = groups.get(n.group) ?? [];
    members.push(n);
    groups.set(n.group, members);
  }
  for (const [group, members] of groups) {
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    const items = members.map((n) => n.item ?? n.id);
    const flagged = members.some((n) => n.flag);
    out.push({
      id: members.map((n) => n.id).join(JOIN),
      group,
      variant: "warning",
      title: `${members.length} models were retired`,
      message: `${items.join(", ")} were retired and removed from your picker.` + (flagged ? " Your default model still points at one of them; pick another one (/enpal-doctor can help)." : "")
    });
  }
  return out;
}
var TOAST_MS = 20000;
function fileNoticeStore(dir) {
  const path = join2(dir, "notices.json");
  const read = () => {
    try {
      if (statSync2(path).size > 64 * 1024)
        return {};
      const raw = JSON.parse(readFileSync2(path, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return {};
      return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string"));
    } catch {
      return {};
    }
  };
  return {
    shown: read,
    markShown: (id, day) => {
      const all = read();
      delete all[id];
      all[id] = day;
      const entries = Object.entries(all).slice(-200);
      try {
        writeJsonAtomically(path, Object.fromEntries(entries));
      } catch {}
    }
  };
}
function createNotices(store, showToast, quiet = false, today = () => new Date().toISOString().slice(0, 10)) {
  const pending = [];
  const handled = new Set;
  return {
    queue(list) {
      for (const n of list)
        if (!handled.has(n.id) && !pending.some((p) => p.id === n.id))
          pending.push(n);
    },
    flush() {
      if (!showToast || !pending.length)
        return;
      const shown = store.shown();
      const due = [];
      for (const n of pending.splice(0)) {
        handled.add(n.id);
        if (shown[n.id] && !n.ephemeral || quiet && n.variant !== "warning")
          continue;
        due.push(n);
      }
      for (const n of batches(due)) {
        if (!n.ephemeral)
          for (const id of idsOf(n.id))
            store.markShown(id, today());
        Promise.resolve().then(() => showToast(n.title, n.message, n.variant ?? "info", n.duration)).catch(() => {});
      }
    },
    pending: () => [...pending]
  };
}

// src/build/defaults.ts
import { createHash as createHash4 } from "node:crypto";
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
var DATA_CLASS_HEADER = "X-Data-Class";
var DEFAULT_DATA_CLASS = "internal";
var RESERVED_IDS3 = new Set(["__proto__", "constructor", "prototype"]);
var isPlainObject2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function stable(v) {
  if (Array.isArray(v))
    return `[${v.map(stable).join(",")}]`;
  if (isPlainObject2(v))
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
function rowFingerprint(row) {
  return createHash4("sha256").update(stable(row)).digest("hex").slice(0, 32);
}
function setsNothingNew(row, ref) {
  if (!isPlainObject2(ref))
    return false;
  const pinned = pickRowFields(ref);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  return Object.entries(row).every(([k, v]) => own(ref, k) && stable(v) === stable(ref[k]) || own(pinned, k) && stable(v) === stable(pinned[k]));
}
function featureRowOf(id, features, snapshot) {
  if (features.kind === "answer")
    for (const f of features.answer.features) {
      const r = f.picker_rows?.[id];
      if (isPlainObject2(r))
        return r;
    }
  for (const f of Object.values(snapshot ?? {})) {
    const r = f?.picker_rows?.[id];
    if (isPlainObject2(r))
      return r;
  }
  return null;
}
function isCopy(id, row, i) {
  if (!Object.keys(row).length)
    return false;
  if (i.copies?.get(id)?.includes(rowFingerprint(row)))
    return true;
  return setsNothingNew(row, i.official?.catalogue.models[id]) || setsNothingNew(row, featureRowOf(id, i.features, i.official?.catalogue.features));
}
var LEDGER_SHAPES_PER_ID = 16;
function fileCopyLedger(cacheDir) {
  const path = join3(cacheDir, "copied-rows.json");
  const load = () => {
    try {
      const raw = JSON.parse(readFileSync3(path, "utf8"));
      const out = new Map;
      if (isPlainObject2(raw)) {
        for (const [id, v] of Object.entries(raw)) {
          const list = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
          if (list.length)
            out.set(id, list);
        }
      }
      return out;
    } catch {
      return new Map;
    }
  };
  return {
    load,
    save: (add) => {
      if (!Object.keys(add).length)
        return;
      const next = load();
      let changed = false;
      for (const [id, fp] of Object.entries(add)) {
        const list = next.get(id) ?? [];
        if (list.includes(fp))
          continue;
        next.set(id, [...list, fp].slice(-LEDGER_SHAPES_PER_ID));
        changed = true;
      }
      if (changed) {
        try {
          writeJsonAtomically(path, Object.fromEntries(next));
        } catch {}
      }
    }
  };
}
function headerKey(headers, name) {
  return headers ? Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) : undefined;
}
function personalSettings(merged, managed, generated) {
  const models = {};
  for (const [id, row] of Object.entries(merged.models ?? {})) {
    if (RESERVED_IDS3.has(id) || !isPlainObject2(row) || generated?.has(id))
      continue;
    const theirs2 = managed?.models?.[id];
    if (!isPlainObject2(theirs2)) {
      models[id] = row;
      continue;
    }
    const diff = Object.fromEntries(Object.entries(row).filter(([k, v]) => !same(v, theirs2[k])));
    if (Object.keys(diff).length)
      models[id] = diff;
  }
  const headers = isPlainObject2(merged.options?.headers) ? merged.options.headers : undefined;
  const key = headerKey(headers, DATA_CLASS_HEADER);
  const mine = key ? headers[key] : undefined;
  const managedHeaders = isPlainObject2(managed?.options?.headers) ? managed.options.headers : undefined;
  const theirKey = headerKey(managedHeaders, DATA_CLASS_HEADER);
  const theirs = theirKey ? managedHeaders[theirKey] : undefined;
  const dataClass = typeof mine === "string" && mine.trim() && !same(mine, theirs) ? mine.trim() : null;
  return { models, dataClass };
}
function enpalBlock(base) {
  return { npm: API_NPM, name: "Enpal AI Gateway", options: { baseURL: `${base.replace(/\/+$/, "")}/v1`, headers: { [DATA_CLASS_HEADER]: DEFAULT_DATA_CLASS } }, models: {} };
}
function ensureEnpalBlock(merged, base) {
  const providers = isPlainObject2(merged.provider) ? merged.provider : {};
  if (isPlainObject2(providers[PROVIDER_ID]))
    return false;
  merged.provider = { ...providers, [PROVIDER_ID]: enpalBlock(base) };
  return true;
}
function composeGatewayBlock(i) {
  const log = (m) => {
    try {
      i.log?.(m);
    } catch {}
  };
  const block = i.merged.provider?.[PROVIDER_ID];
  if (!block)
    return { applied: false, reason: "no_provider_block", notices: [] };
  if (!i.official)
    return { applied: false, reason: "no_catalogue", notices: [] };
  const models = {};
  for (const [id, row] of Object.entries(i.official.catalogue.models)) {
    if (!RESERVED_IDS3.has(id) && isValidPickerRow(row))
      models[id] = pickRowFields(row);
  }
  if (!Object.keys(models).length)
    return { applied: false, reason: "catalogue_empty", notices: [] };
  const managedBlock = isPlainObject2(i.managed?.provider) && isPlainObject2(i.managed.provider[PROVIDER_ID]) ? i.managed.provider[PROVIDER_ID] : null;
  const personal = personalSettings(block, managedBlock, i.generated);
  const copies = {};
  for (const [id, row] of Object.entries(personal.models)) {
    if (!isCopy(id, row, i))
      continue;
    copies[id] = rowFingerprint(row);
    delete personal.models[id];
  }
  const rows = rowsFor(i.features, i.official.catalogue.features, log);
  const added = [];
  const removed = [];
  for (const id of rows.remove)
    if (id in models && !(id in personal.models)) {
      delete models[id];
      removed.push(id);
    }
  const preexisting = new Set(Object.keys(block.models ?? {}).filter((id) => !i.generated?.has(id) && !(id in copies)));
  for (const [id, row] of Object.entries(rows.add))
    if (!(id in models)) {
      models[id] = row;
      if (!preexisting.has(id))
        added.push(id);
    }
  for (const [id, row] of Object.entries(personal.models)) {
    const base = models[id];
    const whole = block.models?.[id];
    models[id] = isPlainObject2(base) ? { ...base, ...row } : isPlainObject2(whole) ? { ...whole } : row;
  }
  const copied = Object.keys(copies);
  const retired = [];
  const notices = [];
  for (const [id, replacement] of Object.entries(i.policy?.retired ?? {})) {
    if (!(id in models))
      continue;
    delete models[id];
    retired.push(id);
    notices.push(retiredNotice(id, replacement ?? null, i.merged.model === `${PROVIDER_ID}/${id}`));
  }
  block.models = models;
  const options = isPlainObject2(block.options) ? { ...block.options } : {};
  const headers = isPlainObject2(options.headers) ? { ...options.headers } : {};
  const existing = headerKey(headers, DATA_CLASS_HEADER);
  if (existing && existing !== DATA_CLASS_HEADER)
    delete headers[existing];
  headers[DATA_CLASS_HEADER] = personal.dataClass ?? DEFAULT_DATA_CLASS;
  options.headers = headers;
  block.options = options;
  let providerLock = null;
  const managedLock = i.managed?.enabled_providers;
  if (Array.isArray(managedLock) && managedLock.length && managedLock.every((p) => typeof p === "string" && p)) {
    const list = i.policy?.enabled_providers;
    if (Array.isArray(list) && list.length && list.every((p) => typeof p === "string" && p)) {
      i.merged.enabled_providers = [...list];
      providerLock = "gateway";
    } else {
      i.merged.enabled_providers = [...managedLock];
      providerLock = "managed";
    }
  }
  return {
    applied: true,
    source: i.official.source,
    models: Object.keys(models).length,
    personal: Object.keys(personal.models),
    copied: copied.filter((id) => !retired.includes(id)),
    copies,
    retired,
    featureRows: { added, removed, owned: rows.owned },
    providerLock,
    notices
  };
}
function chooseCatalogue(served, saved, snapshot) {
  const features = snapshot?.features;
  if (served.ok && served.refresh)
    return { source: "served", catalogue: { models: served.models, enabled_providers: served.enabled_providers, features } };
  if (served.ok)
    return snapshot ? { source: "snapshot", catalogue: snapshot } : null;
  if (saved)
    return { source: "saved", catalogue: { ...saved, features: saved.features ?? features } };
  return snapshot ? { source: "snapshot", catalogue: snapshot } : null;
}
function asCatalogue(raw) {
  if (!isPlainObject2(raw) || !isPlainObject2(raw.models))
    return null;
  const enabled = Array.isArray(raw.enabled_providers) && raw.enabled_providers.every((p) => typeof p === "string" && p) ? raw.enabled_providers : undefined;
  const out = { models: raw.models, enabled_providers: enabled };
  if (isPlainObject2(raw.features))
    out.features = raw.features;
  return out;
}

// src/build/disabled.ts
import { homedir as homedir4 } from "node:os";
import { join as join10, relative, resolve as resolve3, isAbsolute as isAbsolute2 } from "node:path";

// src/build/doctor.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync6, renameSync as renameSync2, statSync as statSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import * as nodePath from "node:path";
import { dirname as dirname2, isAbsolute, join as join7, resolve as resolve2 } from "node:path";

// src/doctor/skill.ts
var SKILL_NAME = "enpal-doctor";
var SKILL_MD = `---
name: ${SKILL_NAME}
description: Check this laptop's Enpal AI Gateway setup for OpenCode against what the gateway says it should be, explain differences in plain words, and offer fixes. Use when the person asks why a model is missing, why a setting does not apply, whether the plugin is up to date, or types /enpal-doctor.
---

# Enpal AI Gateway doctor

You are checking one laptop's OpenCode setup for the Enpal AI Gateway. The gateway is the source of truth for what
the setup should be; the \`enpal_setup\` tool tells you both sides. You compare, explain and suggest. You never change
anything without the person's explicit yes in this conversation.

## Steps

1. Call the \`enpal_setup\` tool with no arguments. It returns a fixed list of facts about the desired state (the
   live plugin build, the official model catalogue, retired models, this person's features and the gateway's release
   policy) and the local state (the running build and why, the login state, the person's own settings, named config
   sources, the composed picker, notes and log locations). It never returns a token or another provider's key.
2. Compare the two sides. Typical differences, in the order to check them:
   - The running build is not the live build: with \`build.why\` approved, the plugin updates itself at the next
     OpenCode start; with \`build.why\` last_good or builtin, the live build failed to start on this laptop: read the
     loader log named in the facts and report its last two lines. A live build of null means the gateway approves no
     build (the switch is off, or nothing is approved yet): the built-in or last good build is expected then.
   - Enpal AI Gateway was switched off in a config file (\`disabled_provider\`): OpenCode 1.x's Settings > Providers >
     Disconnect writes \`"disabled_providers": ["enpal-gateway"]\` into the person's config; an \`enabled_providers\`
     list without it, or a \`provider.use\` deny in \`experimental.policies\`, can also restrict it. Distinguish
     \`detected\`, \`attempted\`, \`restored\` and \`currently_available\`: a finding, registered callback or past
     restore is not proof that Enpal is available now. Say it is back on only after an actual restore and a checked
     available provider view. Unknown is unknown; a contained failure or central emergency OFF is reported plainly.
     Report \`summary\`. \`files_now\` names remaining config residue, not proof that each file's setting won.
     For permanent cleanup, use this \`/enpal-doctor\` workflow only after the person says yes and OpenCode grants
     its own file-edit permission. The in-memory restore is the availability fix at every start.
     Offer \`repair\` only for a named personal file and an exact-id list edit: remove only \`"enpal-gateway"\`
     from \`disabled_providers\`, or add it to a valid \`enabled_providers\` list. Keep every other id. Never delete
     or rewrite a \`provider.use\` policy statement, including a wildcard; it can affect other providers too.
     A managed or unidentified source is diagnosis only. Installers and ordinary \`enpal-ai doctor\` only warn
     about this residue; they do not clean it. The plugin restores availability in memory and never writes the config.
   - A model is missing from the picker: it was retired (the facts name the replacement), or it belongs to a feature
     that is off for this person (the facts say why, with the portal link), or the person's own settings hide it.
   - A setting does not apply: explain the current release policy and the named config source from the facts.
     A managed source, if reported, is diagnosis only; never edit it or infer a laptop-specific lock rule from it.
   - Rows in the person's config that are copies of the Enpal defaults (\`picker.copied\`): they follow the gateway
     already (a catalogue change updates them, a feature switched off removes them), so nothing is wrong. Offer to
     delete them from the file for tidiness only. Rows the person changed (\`picker.personal\`) are theirs and win.
   - A default model that points at a retired id: suggest the replacement.
   - The login is missing or expired: on OpenCode 1.18 tell the person to type \`/enpal-login\` (\`/enpal-login --relogin\`
     to switch accounts); otherwise to run \`opencode auth login\` and pick the Enpal AI Gateway. \`az login\` is not needed
     for the gateway.
   - The person asks what changed in the plugin: on OpenCode 1.18 tell them to type \`/enpal-news\` (the release notes of
     the running build); otherwise give them \`build.notes_url\`.
3. Explain what differs in plain words, one line per difference, and say what you suggest for each.
4. Before an approved disabled-provider edit, check that the named target is a personal regular file, with no linked
   parents, and validate its complete JSONC object and the intended exact-id list edit. Refuse an unsupported edit
   before creating a backup. Only if the person agrees: make a backup copy of every file you are about to change (same folder, suffix
   \`.bak-<yyyymmdd-hhmmss>\`), then edit with your ordinary file tools. Keep every setting the person made that they
   did not ask you to change. Then call \`enpal_setup\` again: its \`config_files\` facts are read from disk when the
   tool runs (each global file on its own and merged the way OpenCode merges them), so use them to confirm the edit
   landed. For a disabled-provider edit, refuse a managed target or a link (including linked parents), preserve
   comments, encoding, BOM and line endings, and validate the complete document as a JSONC object before and after.
   Re-read immediately before committing; if another writer changed it, stop instead of overwriting their edit.
   Name the backup and report any refusal without claiming the file was repaired. Re-check \`files_now\` separately
   from \`currently_available\`: disk residue and the running provider view can change at different times.

## Rules

- Suggest first. No edit without the person's yes, given in this conversation.
- Back up every file before editing it.
- Never edit a managed config source. Report it when the facts identify one; the gateway's release policy applies
  on every laptop with the plugin.
- Never print, copy or move a token, a refresh token, a service key or another provider's API key, even if a file
  you read contains one. Say that the file holds a credential and leave it there.
- Keep the person's own settings. Only the fixes they accepted change anything.
- Never read a credential file such as \`auth.json\`; the tool's login-status facts are sufficient.
- If OpenCode itself will not start, run \`enpal-ai doctor\` in a terminal on an IT laptop (Windows or macOS).
  On a self-service install, use the doctor the installer kept: \`sh "$HOME/.enpal/gateway/bin/doctor.sh"\`
  (macOS/Linux) or \`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HOME/.enpal/gateway/bin/doctor.ps1"\`
  (Windows PowerShell). If that copy is missing, get the current doctor from the gateway's store. These checks are
  read-only: they do not sign in, start OpenCode, read auth.json, or change the plugin, config or chats. Setup is a
  separate repair; suggest \`enpal-ai setup\` on an IT laptop only when the diagnosis calls for it. Do not claim that
  setup or an installer permanently repairs a disabled-provider config entry; the terminal doctor only reports it.
  The permanent cleanup is this skill's exact-id edit, made only after the person says yes.
`;

// src/build/disabled-discovery.ts
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join as join4, resolve } from "node:path";
var NAMES = ["opencode.json", "opencode.jsonc"];
var WALK_MAX = 64;
var truthy = (value) => value?.toLowerCase() === "true" || value === "1";
var homeOf = (env, home) => home ?? env.OPENCODE_TEST_HOME ?? env.HOME ?? homedir();
var defaultGlobal = (env, home) => join4(env.XDG_CONFIG_HOME || join4(home, ".config"), "opencode");
function configDirectory(env, line, home) {
  return line === "v2" && env.OPENCODE_CONFIG_DIR ? resolve(env.OPENCODE_CONFIG_DIR) : defaultGlobal(env, homeOf(env, home));
}
function walk(directory, stop) {
  const chain = [];
  let dir = resolve(directory);
  const boundary = stop ? canonical(stop) : null;
  for (let i = 0;i < WALK_MAX; i++) {
    chain.push(dir);
    if (boundary && canonical(dir) === boundary)
      return { chain, complete: true };
    const parent = dirname(dir);
    if (parent === dir)
      return { chain, complete: !boundary };
    dir = parent;
  }
  return { chain, complete: false };
}
function canonical(path) {
  let parent = resolve(path);
  const tail = [];
  for (let i = 0;i < WALK_MAX; i++) {
    try {
      return resolve(realpathSync(parent), ...tail.reverse());
    } catch {}
    const next = dirname(parent);
    if (next === parent)
      break;
    tail.push(basename(parent));
    parent = next;
  }
  return resolve(path);
}
function personFiles1x(env, directory, home, worktree) {
  const personHome = homeOf(env, home);
  const files = ["config.json", ...NAMES].map((name) => join4(defaultGlobal(env, personHome), name));
  if (env.OPENCODE_CONFIG)
    files.push(resolve(env.OPENCODE_CONFIG));
  const dotDirs = [];
  if (directory && !truthy(env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
    const walked = walk(directory, worktree);
    const top = worktree ? -1 : walked.chain.findIndex((dir) => existsSync(join4(dir, ".git")));
    const project = top < 0 ? walked.chain : walked.chain.slice(0, top + 1);
    for (const dir of [...project].reverse())
      for (const name of NAMES)
        files.push(join4(dir, name));
    for (const dir of project)
      dotDirs.push(join4(dir, ".opencode"));
  }
  dotDirs.push(join4(personHome, ".opencode"));
  if (env.OPENCODE_CONFIG_DIR)
    dotDirs.push(resolve(env.OPENCODE_CONFIG_DIR));
  for (const dir of [...new Set(dotDirs)])
    for (const name of NAMES)
      files.push(join4(dir, name));
  return files;
}
function personFiles2x(env, directory, home) {
  const personHome = homeOf(env, home);
  const globalDir = configDirectory(env, "v2", personHome);
  const globals = NAMES.map((name) => join4(globalDir, name));
  const files = [...globals];
  if (env.OPENCODE_CONFIG)
    files.push(resolve(env.OPENCODE_CONFIG));
  const projectOff = truthy(env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG);
  let complete = !env.OPENCODE_CONFIG_CONTENT;
  if (!directory)
    return { files, complete: false };
  if (projectOff || canonical(directory) === canonical(globalDir))
    return { files, complete };
  const walked = walk(directory);
  complete &&= walked.complete;
  const roots = [globalDir, join4(personHome, ".claude"), join4(personHome, ".agents")].map(canonical);
  const globalFiles = globals.map(canonical);
  const visible = (path) => !roots.includes(canonical(path)) && !globalFiles.includes(canonical(path));
  const farthest = [...walked.chain].reverse();
  for (const dir of farthest)
    for (const name of NAMES) {
      const path = join4(dir, name);
      if (visible(path))
        files.push(path);
    }
  for (const dir of farthest) {
    const dot = join4(dir, ".opencode");
    if (!visible(dot))
      continue;
    for (const name of NAMES)
      files.push(join4(dot, name));
  }
  return { files, complete };
}

// src/build/login.ts
import { readFileSync as readFileSync4, statSync as statSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";
var AUTH_FILE_MAX = 256 * 1024;
function opencodeDataDir(env = process.env) {
  const xdg = (env.XDG_DATA_HOME ?? "").trim();
  return join5(xdg || join5(homedir2(), ".local", "share"), "opencode");
}
function asRecord(v) {
  if (typeof v !== "object" || v === null)
    return null;
  const r = v;
  if (r.type !== "oauth" || typeof r.refresh !== "string" || !r.refresh || typeof r.access !== "string")
    return null;
  if (typeof r.expires !== "number" || !Number.isInteger(r.expires) || r.expires < 0)
    return null;
  return { type: "oauth", refresh: r.refresh, access: r.access, expires: r.expires };
}
function readStoredLogin(env = process.env, dataDir = opencodeDataDir(env), providerId = PROVIDER_ID) {
  const content = env.OPENCODE_AUTH_CONTENT;
  if (content) {
    try {
      const record = asRecord(JSON.parse(content)?.[providerId]);
      return record ? { source: "env", record } : null;
    } catch {
      return null;
    }
  }
  const path = join5(dataDir, "auth.json");
  try {
    if (statSync3(path).size > AUTH_FILE_MAX)
      return null;
    const record = asRecord(JSON.parse(readFileSync4(path, "utf8"))?.[providerId]);
    return record ? { source: "file", record } : null;
  } catch {
    return null;
  }
}

// src/build/jsonc.ts
import { readFileSync as readFileSync5, statSync as statSync4 } from "node:fs";
var isPlainObject3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseJsonc(text) {
  if (text.charCodeAt(0) === 65279)
    text = text.slice(1);
  let stripped = "";
  let inString = false;
  for (let i = 0;i < text.length; i++) {
    const c = text[i];
    if (inString) {
      stripped += c;
      if (c === "\\") {
        stripped += text[++i] ?? "";
      } else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      stripped += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== `
`)
        i++;
      stripped += `
`;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0)
        throw new SyntaxError("unterminated block comment");
      stripped += " ";
      i = end + 1;
      continue;
    }
    stripped += c;
  }
  let out = "";
  inString = false;
  for (let i = 0;i < stripped.length; i++) {
    const c = stripped[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += stripped[++i] ?? "";
      } else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j]))
        j++;
      if (stripped[j] === "}" || stripped[j] === "]")
        continue;
    }
    out += c;
  }
  return JSON.parse(out);
}
function mergeDeep(target, source) {
  if (!isPlainObject3(target) || !isPlainObject3(source))
    return source === undefined ? target : source;
  const out = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype")
      continue;
    out[k] = isPlainObject3(v) && isPlainObject3(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out;
}
function readJsoncFile(path, max) {
  let text;
  try {
    if (statSync4(path).size > max)
      return { present: true, value: null };
    text = readFileSync5(path, "utf8");
  } catch {
    return { present: false, value: null };
  }
  try {
    const parsed = parseJsonc(text);
    return { present: true, value: isPlainObject3(parsed) ? parsed : null };
  } catch {
    return { present: true, value: null };
  }
}
function readMergedJsonc(paths, max) {
  let merged = null;
  for (const path of paths) {
    const { value } = readJsoncFile(path, max);
    if (value)
      merged = mergeDeep(merged ?? {}, value);
  }
  return merged;
}

// src/build/managed.ts
import { join as join6 } from "node:path";
var MANAGED_FILE_MAX = 512 * 1024;
function managedConfigDir(env = process.env, platform2 = process.platform) {
  if (env.OPENCODE_TEST_MANAGED_CONFIG_DIR)
    return env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  if (platform2 === "darwin")
    return "/Library/Application Support/opencode";
  if (platform2 === "win32")
    return join6(env.ProgramData || "C:\\ProgramData", "opencode");
  return "/etc/opencode";
}
function readManagedConfig(env = process.env, platform2 = process.platform) {
  const dir = managedConfigDir(env, platform2);
  return readMergedJsonc([join6(dir, "opencode.json"), join6(dir, "opencode.jsonc")], MANAGED_FILE_MAX);
}

// src/build/doctor.ts
var isRecord2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function skillsRoot(cacheDir) {
  return join7(cacheDir, "skills");
}
function skillParent(cacheDir, build) {
  return join7(skillsRoot(cacheDir), build ?? "legacy");
}
function skillFolder(cacheDir, build) {
  return join7(skillParent(cacheDir, build), SKILL_NAME);
}
function ensureSkillFolder(cacheDir, build, text = SKILL_MD) {
  const folder = skillFolder(cacheDir, build);
  const path = join7(folder, "SKILL.md");
  try {
    if (existsSync2(path) && readFileSync6(path, "utf8") === text)
      return folder;
    mkdirSync2(folder, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync2(tmp, text, { mode: 420 });
    renameSync2(tmp, path);
    return folder;
  } catch {
    return null;
  }
}
var SCAN_MAX_FILES = 20000;
var SCAN_MAX_DEPTH = 24;
var SCAN_BUDGET_MS = 150;
function yamlScalar(raw) {
  const s = raw.trim();
  if (!s)
    return { value: null, uncertain: false };
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1;i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        const e = s[++i];
        if (e === undefined || !['"', "\\", "/", "n", "t", " "].includes(e))
          return { value: null, uncertain: true };
        out += e === "n" ? `
` : e === "t" ? "\t" : e;
        continue;
      }
      if (c === '"')
        return /^\s*(#.*)?$/.test(s.slice(i + 1)) ? { value: out, uncertain: false } : { value: null, uncertain: true };
      out += c;
    }
    return { value: null, uncertain: true };
  }
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1;i < s.length; i++) {
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return /^\s*(#.*)?$/.test(s.slice(i + 1)) ? { value: out, uncertain: false } : { value: null, uncertain: true };
      }
      out += c;
    }
    return { value: null, uncertain: true };
  }
  if (/^[|>&*!%@\x60[{]/.test(s))
    return { value: null, uncertain: true };
  const cut = s.search(/\s#/);
  return { value: (cut >= 0 ? s.slice(0, cut) : s).trim(), uncertain: false };
}
function skillName(path) {
  try {
    if (statSync5(path).size > 256 * 1024)
      return { name: null, uncertain: true };
    const text = readFileSync6(path, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m)
      return { name: null, uncertain: false };
    const line = m[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l));
    if (!line)
      return { name: null, uncertain: false };
    const scalar = yamlScalar(line.replace(/^name\s*:/, ""));
    return { name: scalar.value, uncertain: scalar.uncertain };
  } catch {
    return { name: null, uncertain: true };
  }
}
function isWithin(root, path, p = nodePath) {
  return (p.resolve(path) + p.sep).startsWith(p.resolve(root) + p.sep);
}
function findPersonalSkill(name, o = {}) {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir3();
  const roots = [];
  let complete = true;
  const configHome = (env.XDG_CONFIG_HOME ?? "").trim() || join7(home, ".config");
  for (const dir of [join7(configHome, "opencode"), ...env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : []]) {
    roots.push(join7(dir, "skill"), join7(dir, "skills"));
  }
  roots.push(join7(home, ".claude", "skills"), join7(home, ".agents", "skills"));
  if (o.directory) {
    let dir = resolve2(o.directory);
    let reachedRoot = false;
    for (let i = 0;i < 16; i++) {
      roots.push(join7(dir, ".opencode", "skill"), join7(dir, ".opencode", "skills"), join7(dir, ".claude", "skills"), join7(dir, ".agents", "skills"));
      const parent = dirname2(dir);
      if (parent === dir) {
        reachedRoot = true;
        break;
      }
      dir = parent;
    }
    if (!reachedRoot)
      complete = false;
  }
  if (Array.isArray(o.configPaths)) {
    for (const item of o.configPaths) {
      if (typeof item !== "string" || !item)
        continue;
      const expanded = item.startsWith("~/") ? join7(home, item.slice(2)) : item;
      if (isAbsolute(expanded))
        roots.push(expanded);
      else if (o.directory)
        roots.push(join7(o.directory, expanded));
      else
        complete = false;
    }
  }
  const ours = (path) => !!o.exclude && isWithin(o.exclude, path);
  let budget = SCAN_MAX_FILES;
  const clock = o.clock ?? (() => performance.now());
  const deadline = clock() + (o.budgetMs ?? SCAN_BUDGET_MS);
  let expired = false;
  const late = () => {
    if (!expired && clock() > deadline) {
      expired = true;
      complete = false;
    }
    return expired;
  };
  const walk2 = (dir, depth) => {
    if (late())
      return null;
    if (depth > SCAN_MAX_DEPTH) {
      complete = false;
      return null;
    }
    if (budget <= 0) {
      complete = false;
      return null;
    }
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    if (late())
      return null;
    for (const entry of entries) {
      if (late())
        return null;
      if (--budget <= 0) {
        complete = false;
        return null;
      }
      const path = join7(dir, entry);
      if (entry === "SKILL.md") {
        if (ours(path))
          continue;
        const read = skillName(path);
        if (late())
          return null;
        if (read.uncertain)
          complete = false;
        if (read.name === name)
          return path;
        continue;
      }
      let isDir = false;
      try {
        isDir = statSync5(path).isDirectory();
      } catch {}
      if (late())
        return null;
      if (isDir && entry !== "node_modules" && !entry.startsWith(".git") && !ours(path)) {
        const found = walk2(path, depth + 1);
        if (found)
          return found;
      }
    }
    return null;
  };
  for (const root of roots) {
    if (late())
      break;
    if (ours(root))
      continue;
    const found = walk2(root, 0);
    if (found)
      return { found, complete: true };
  }
  return { found: null, complete };
}
function addSkillPath(cfg, folder) {
  const skills = isRecord2(cfg.skills) ? { ...cfg.skills } : {};
  const paths = Array.isArray(skills.paths) ? [...skills.paths] : [];
  if (paths.includes(folder))
    return false;
  paths.push(folder);
  skills.paths = paths;
  cfg.skills = skills;
  return true;
}
var DOCTOR_COMMAND = {
  description: "Check this laptop's Enpal AI Gateway setup against the gateway and explain differences (read-only until you agree).",
  template: SKILL_MD.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
};
function addDoctorCommand(cfg) {
  if (cfg.command !== undefined && !isRecord2(cfg.command))
    return false;
  const commands = isRecord2(cfg.command) ? cfg.command : {};
  if (SKILL_NAME in commands)
    return false;
  cfg.command = { ...commands, [SKILL_NAME]: { description: DOCTOR_COMMAND.description, template: DOCTOR_COMMAND.template } };
  return true;
}
var NEWS_COMMAND = "enpal-news";
function newsCommand(build = PLUGIN_BUILD, notes = PLUGIN_NOTES) {
  return {
    description: "Show the release notes of the Enpal AI Gateway plugin version you run.",
    template: notes ? `Show the person these release notes of the Enpal AI Gateway plugin build ${build} exactly as written, nothing else:

${notes}` : `Reply with exactly one short line: "Enpal AI Gateway plugin build ${build} carries no release notes."`
  };
}
function addNewsCommand(cfg) {
  if (cfg.command !== undefined && !isRecord2(cfg.command))
    return false;
  const commands = isRecord2(cfg.command) ? cfg.command : {};
  if (NEWS_COMMAND in commands)
    return false;
  cfg.command = { ...commands, [NEWS_COMMAND]: newsCommand() };
  return true;
}
function defaultModelFact(model) {
  if (typeof model !== "string" || !model)
    return null;
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  return provider === PROVIDER_ID ? { provider: PROVIDER_ID, id: model.slice(slash + 1) } : { provider: "other" };
}
var VERIFY_NOTE = "picker and features are the composition at this start; an edit to a config file shows under config_files at " + "once and takes effect at the next OpenCode start (2.x: the next service start).";
function opencodeConfigDir(env = process.env, home = homedir3()) {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  return join7(xdg || join7(home, ".config"), "opencode");
}
var CONFIG_FILE_MAX = 2 * 1024 * 1024;
var GLOBAL_CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"];
function gatewayFactsOf(cfg) {
  const rows = new Set;
  for (const key of ["provider", "providers"]) {
    const table = cfg && isRecord2(cfg[key]) ? cfg[key] : null;
    const block = table && isRecord2(table[PROVIDER_ID]) ? table[PROVIDER_ID] : null;
    if (block && isRecord2(block.models))
      for (const id of Object.keys(block.models))
        rows.add(id);
  }
  const enabled = cfg && Array.isArray(cfg.enabled_providers) && cfg.enabled_providers.every((p) => typeof p === "string") ? [...cfg.enabled_providers] : null;
  return { gateway_rows: [...rows], default_model: defaultModelFact(cfg?.model), enabled_providers: enabled };
}
function configFileFacts(env, home = homedir3(), line = "v1") {
  const dir = configDirectory(env, line, home);
  const files = [];
  let merged = null;
  for (const name of line === "v2" ? ["opencode.json", "opencode.jsonc"] : GLOBAL_CONFIG_FILES) {
    const { present, value } = readJsoncFile(join7(dir, name), CONFIG_FILE_MAX);
    files.push({ name, present, parse_ok: !present || value !== null, ...gatewayFactsOf(value) });
    if (value)
      merged = mergeDeep(merged ?? {}, value);
  }
  return { dir, files, merged: gatewayFactsOf(merged) };
}
var PLUGIN_FILE_MAX = 4 * 1024 * 1024;
var LOADER_MARK = /\bLOADER_VERSION\s=\s\d/;
function pluginFileFacts(env, home = homedir3()) {
  const dir = opencodeConfigDir(env, home);
  const out = [];
  const look = (folder) => {
    let entries;
    try {
      entries = readdirSync(folder);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (!/\.(js|mjs|cjs|ts)$/.test(entry))
        continue;
      const path = join7(folder, entry);
      try {
        const bytes = statSync5(path).size;
        let kind = "other";
        if (bytes <= PLUGIN_FILE_MAX) {
          const text = readFileSync6(path, "utf8");
          kind = LOADER_MARK.test(text) ? "loader" : text.includes(`"${PROVIDER_ID}"`) ? "legacy" : "other";
        }
        out.push({ path, bytes, kind });
      } catch {}
    }
  };
  look(join7(dir, "plugin"));
  look(join7(dir, "plugins"));
  let folders = [];
  try {
    folders = readdirSync(join7(dir, "plugins")).filter((f) => f.startsWith("enpal-gateway"));
  } catch {}
  for (const f of folders)
    look(join7(dir, "plugins", f));
  return out;
}
function loginFacts(login, serviceKey, env, now = Date.now()) {
  return {
    present: !!login,
    source: login?.source ?? null,
    expired: login ? now >= login.record.expires : null,
    data_dir: opencodeDataDir(env),
    service_key: serviceKey
  };
}
function managedFacts(managed, env) {
  const provider = isRecord2(managed?.provider) ? managed.provider : null;
  const block = provider && isRecord2(provider[PROVIDER_ID]) ? provider[PROVIDER_ID] : null;
  const headers = block && isRecord2(block.options) && isRecord2(block.options.headers) ? Object.keys(block.options.headers) : [];
  const lock = Array.isArray(managed?.enabled_providers) && managed.enabled_providers.every((p) => typeof p === "string") ? [...managed.enabled_providers] : null;
  return {
    dir: managedConfigDir(env),
    present: managed !== null,
    sets: {
      model: typeof managed?.model === "string",
      enabled_providers: lock,
      gateway_rows: block && isRecord2(block.models) ? Object.keys(block.models) : [],
      gateway_header_names: headers
    }
  };
}
function catalogueFacts(official, state, retired) {
  const models = official ? Object.entries(official.catalogue.models).map(([id, row]) => ({ id, name: isRecord2(row) && typeof row.name === "string" ? row.name : null })) : [];
  return { source: official?.source ?? null, models, retired, feature_owned: ownershipOf(state, official?.catalogue.features).owned };
}
function featureFacts(state, catalogue) {
  if (state.kind !== "answer")
    return { state: state.kind, fresh: null, subject_known: false, list: [] };
  const { owned } = ownershipOf(state, catalogue);
  return {
    state: "answer",
    fresh: state.fresh,
    subject_known: state.subject !== null,
    list: state.answer.features.map((f) => ({
      key: f.key,
      name: f.name ?? null,
      on: f.on,
      why: f.why ?? null,
      recognised: recognised(f, catalogue),
      rows: owned[f.key] ?? [],
      notice_version: f.notice?.version ?? null,
      notice_seen: f.notice_seen ?? null
    }))
  };
}
function pickerFacts(outcome, merged, generated, policy) {
  if (!outcome)
    return null;
  const block = merged && isRecord2(merged.provider) && isRecord2(merged.provider[PROVIDER_ID]) ? merged.provider[PROVIDER_ID] : null;
  const headers = block && isRecord2(block.options) && isRecord2(block.options.headers) ? block.options.headers : {};
  const dataClassKey = Object.keys(headers).find((k) => k.toLowerCase() === "x-data-class");
  const effective = Array.isArray(merged?.enabled_providers) && merged.enabled_providers.every((p) => typeof p === "string") ? [...merged.enabled_providers] : null;
  return {
    applied: outcome.applied,
    reason: outcome.reason ?? null,
    models: block && isRecord2(block.models) ? Object.keys(block.models) : [],
    personal: outcome.personal ?? [],
    copied: outcome.copied ?? [],
    generated: [...generated],
    removed_by_features: outcome.featureRows?.removed ?? [],
    added_by_features: outcome.featureRows?.added ?? [],
    retired_removed: outcome.retired ?? [],
    provider_lock: { applied: outcome.providerLock ?? null, gateway: policy?.enabled_providers ? [...policy.enabled_providers] : null, effective },
    data_class: dataClassKey ? String(headers[dataClassKey]) : null,
    default_model: defaultModelFact(merged?.model)
  };
}
function readLastStart(cacheDir) {
  try {
    const path = join7(cacheDir, "last-start.json");
    if (statSync5(path).size > 64 * 1024)
      return null;
    const raw = JSON.parse(readFileSync6(path, "utf8"));
    if (!isRecord2(raw))
      return null;
    const str = (v) => typeof v === "string" ? v : null;
    const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
    return { build: str(raw.build), why: str(raw.why), line: str(raw.line), loader: num(raw.loader), at: num(raw.at) };
  } catch {
    return null;
  }
}
function buildFacts(options, cacheDir, live) {
  const running = options.build ?? "legacy";
  return {
    running,
    why: options.why ?? (options.build ? "unknown" : "legacy"),
    line: options.line ?? "v1",
    loader_version: options.loaderVersion ?? 0,
    live,
    notes_url: options.notesUrl ?? null,
    last_start: readLastStart(cacheDir),
    loader_log: join7(cacheDir, "loader.log"),
    cache_dir: cacheDir
  };
}
function assembleFacts(i) {
  const s = i.startup;
  const live = i.options.approved !== undefined ? i.options.approved : i.options.why === "approved" && s.features.kind === "answer" ? s.features.answer.plugin_build_current ?? null : null;
  return {
    gateway: { base: i.base, portal_url: s.features.kind === "answer" ? s.features.answer.portal_url ?? null : null },
    build: buildFacts(i.options, i.cacheDir, live),
    login: loginFacts(i.login, serviceKeyFromEnv(i.env) !== null, i.env),
    features: featureFacts(s.features, s.official?.catalogue.features),
    catalogue: catalogueFacts(s.official, s.features, i.options.policy?.retired ?? {}),
    picker: pickerFacts(i.last.outcome, i.last.merged, i.last.generated, i.options.policy ?? null),
    managed: managedFacts(readManagedConfig(i.env), i.env),
    config_files: configFileFacts(i.env, undefined, i.line === "v2" ? "v2" : "v1"),
    plugin_files: pluginFileFacts(i.env),
    disabled_provider: i.disabled,
    opencode: { version: i.opencodeVersion, line: i.line },
    doctor: i.last.skill
  };
}
function createSetupTool(facts) {
  return {
    description: "Enpal AI Gateway setup facts for this laptop, read-only: the live plugin build and the running one, the " + "official catalogue and retired models, this person's features, the composed picker, what IT's managed file sets, " + "the login state and where the loader logs. Never returns a token or another provider's key. Call it with no arguments.",
    args: {},
    async execute() {
      try {
        return { title: "Enpal AI Gateway setup", output: JSON.stringify(await facts(), null, 2) };
      } catch {
        return { title: "Enpal AI Gateway setup", output: JSON.stringify({ error: "facts unavailable" }) };
      }
    }
  };
}
function buildUpdateNotice(options, highlights = options.build === PLUGIN_BUILD ? PLUGIN_HIGHLIGHTS : []) {
  if (!options.build || !options.notesUrl)
    return null;
  const lastGood = options.why === "last_good" ? " (the last good build)" : "";
  const message = highlights.length ? `What's new in build ${options.build}${lastGood}:
${highlights.map((h) => `• ${h}`).join(`
`)}
Full notes: ${options.line === "v2" ? options.notesUrl : `/${NEWS_COMMAND}`}` : `Now running build ${options.build}${lastGood}. What changed: ${options.notesUrl}`;
  return {
    id: `build:${options.build}`,
    title: "Enpal AI Gateway plugin updated",
    variant: "info",
    duration: 300000,
    message
  };
}
function buildLoadFailedNotice(options) {
  const approved = options.approved;
  if (typeof approved !== "string" || !approved || !options.build || options.build === approved || options.why === "approved")
    return null;
  return {
    id: `load-failed:${approved}:${options.build}`,
    title: "Enpal AI Gateway plugin not updated",
    variant: "warning",
    message: `Couldn't load build ${approved}; still on ${options.build}. ${restartHint(options.line ?? "v1")} to try again.`
  };
}
// node_modules/@ai-sdk/provider/dist/index.mjs
var marker = "vercel.ai.error";
var symbol = Symbol.for(marker);
var _a;
var _b;
var AISDKError = class _AISDKError extends (_b = Error, _a = symbol, _b) {
  constructor({
    name: name14,
    message,
    cause
  }) {
    super(message);
    this[_a] = true;
    this.name = name14;
    this.cause = cause;
  }
  static isInstance(error) {
    return _AISDKError.hasMarker(error, marker);
  }
  static hasMarker(error, marker15) {
    const markerSymbol = Symbol.for(marker15);
    return error != null && typeof error === "object" && markerSymbol in error && typeof error[markerSymbol] === "boolean" && error[markerSymbol] === true;
  }
};
var name = "AI_APICallError";
var marker2 = `vercel.ai.error.${name}`;
var symbol2 = Symbol.for(marker2);
var _a2;
var _b2;
var APICallError = class extends (_b2 = AISDKError, _a2 = symbol2, _b2) {
  constructor({
    message,
    url,
    requestBodyValues,
    statusCode,
    responseHeaders,
    responseBody,
    cause,
    isRetryable = statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500),
    data
  }) {
    super({ name, message, cause });
    this[_a2] = true;
    this.url = url;
    this.requestBodyValues = requestBodyValues;
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
    this.responseBody = responseBody;
    this.isRetryable = isRetryable;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker2);
  }
};
var name2 = "AI_EmptyResponseBodyError";
var marker3 = `vercel.ai.error.${name2}`;
var symbol3 = Symbol.for(marker3);
var _a3;
var _b3;
var EmptyResponseBodyError = class extends (_b3 = AISDKError, _a3 = symbol3, _b3) {
  constructor({ message = "Empty response body" } = {}) {
    super({ name: name2, message });
    this[_a3] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker3);
  }
};
function getErrorMessage(error) {
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}
var name3 = "AI_InvalidArgumentError";
var marker4 = `vercel.ai.error.${name3}`;
var symbol4 = Symbol.for(marker4);
var _a4;
var _b4;
var InvalidArgumentError = class extends (_b4 = AISDKError, _a4 = symbol4, _b4) {
  constructor({
    message,
    cause,
    argument
  }) {
    super({ name: name3, message, cause });
    this[_a4] = true;
    this.argument = argument;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker4);
  }
};
var name4 = "AI_InvalidPromptError";
var marker5 = `vercel.ai.error.${name4}`;
var symbol5 = Symbol.for(marker5);
var _a5;
var _b5;
var InvalidPromptError = class extends (_b5 = AISDKError, _a5 = symbol5, _b5) {
  constructor({
    prompt,
    message,
    cause
  }) {
    super({ name: name4, message: `Invalid prompt: ${message}`, cause });
    this[_a5] = true;
    this.prompt = prompt;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker5);
  }
};
var name5 = "AI_InvalidResponseDataError";
var marker6 = `vercel.ai.error.${name5}`;
var symbol6 = Symbol.for(marker6);
var _a6;
var _b6;
var InvalidResponseDataError = class extends (_b6 = AISDKError, _a6 = symbol6, _b6) {
  constructor({
    data,
    message = `Invalid response data: ${JSON.stringify(data)}.`
  }) {
    super({ name: name5, message });
    this[_a6] = true;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker6);
  }
};
var name6 = "AI_JSONParseError";
var marker7 = `vercel.ai.error.${name6}`;
var symbol7 = Symbol.for(marker7);
var _a7;
var _b7;
var JSONParseError = class extends (_b7 = AISDKError, _a7 = symbol7, _b7) {
  constructor({ text, cause }) {
    super({
      name: name6,
      message: `JSON parsing failed: Text: ${text}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a7] = true;
    this.text = text;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker7);
  }
};
var name7 = "AI_LoadAPIKeyError";
var marker8 = `vercel.ai.error.${name7}`;
var symbol8 = Symbol.for(marker8);
var _a8;
var _b8;
var LoadAPIKeyError = class extends (_b8 = AISDKError, _a8 = symbol8, _b8) {
  constructor({ message }) {
    super({ name: name7, message });
    this[_a8] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker8);
  }
};
var name8 = "AI_LoadSettingError";
var marker9 = `vercel.ai.error.${name8}`;
var symbol9 = Symbol.for(marker9);
var _a9;
var _b9;
var LoadSettingError = class extends (_b9 = AISDKError, _a9 = symbol9, _b9) {
  constructor({ message }) {
    super({ name: name8, message });
    this[_a9] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker9);
  }
};
var name9 = "AI_NoContentGeneratedError";
var marker10 = `vercel.ai.error.${name9}`;
var symbol10 = Symbol.for(marker10);
var _a10;
var _b10;
var NoContentGeneratedError = class extends (_b10 = AISDKError, _a10 = symbol10, _b10) {
  constructor({
    message = "No content generated."
  } = {}) {
    super({ name: name9, message });
    this[_a10] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker10);
  }
};
var name10 = "AI_NoSuchModelError";
var marker11 = `vercel.ai.error.${name10}`;
var symbol11 = Symbol.for(marker11);
var _a11;
var _b11;
var NoSuchModelError = class extends (_b11 = AISDKError, _a11 = symbol11, _b11) {
  constructor({
    errorName = name10,
    modelId,
    modelType,
    message = `No such ${modelType}: ${modelId}`
  }) {
    super({ name: errorName, message });
    this[_a11] = true;
    this.modelId = modelId;
    this.modelType = modelType;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker11);
  }
};
var name11 = "AI_TooManyEmbeddingValuesForCallError";
var marker12 = `vercel.ai.error.${name11}`;
var symbol12 = Symbol.for(marker12);
var _a12;
var _b12;
var TooManyEmbeddingValuesForCallError = class extends (_b12 = AISDKError, _a12 = symbol12, _b12) {
  constructor(options) {
    super({
      name: name11,
      message: `Too many values for a single embedding call. The ${options.provider} model "${options.modelId}" can only embed up to ${options.maxEmbeddingsPerCall} values per call, but ${options.values.length} values were provided.`
    });
    this[_a12] = true;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.maxEmbeddingsPerCall = options.maxEmbeddingsPerCall;
    this.values = options.values;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker12);
  }
};
var name12 = "AI_TypeValidationError";
var marker13 = `vercel.ai.error.${name12}`;
var symbol13 = Symbol.for(marker13);
var _a13;
var _b13;
var TypeValidationError = class _TypeValidationError extends (_b13 = AISDKError, _a13 = symbol13, _b13) {
  constructor({
    value,
    cause,
    context
  }) {
    let contextPrefix = "Type validation failed";
    if (context == null ? undefined : context.field) {
      contextPrefix += ` for ${context.field}`;
    }
    if ((context == null ? undefined : context.entityName) || (context == null ? undefined : context.entityId)) {
      contextPrefix += " (";
      const parts = [];
      if (context.entityName) {
        parts.push(context.entityName);
      }
      if (context.entityId) {
        parts.push(`id: "${context.entityId}"`);
      }
      contextPrefix += parts.join(", ");
      contextPrefix += ")";
    }
    super({
      name: name12,
      message: `${contextPrefix}: Value: ${JSON.stringify(value)}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a13] = true;
    this.value = value;
    this.context = context;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker13);
  }
  static wrap({
    value,
    cause,
    context
  }) {
    var _a15, _b15, _c;
    if (_TypeValidationError.isInstance(cause) && cause.value === value && ((_a15 = cause.context) == null ? undefined : _a15.field) === (context == null ? undefined : context.field) && ((_b15 = cause.context) == null ? undefined : _b15.entityName) === (context == null ? undefined : context.entityName) && ((_c = cause.context) == null ? undefined : _c.entityId) === (context == null ? undefined : context.entityId)) {
      return cause;
    }
    return new _TypeValidationError({ value, cause, context });
  }
};
var name13 = "AI_UnsupportedFunctionalityError";
var marker14 = `vercel.ai.error.${name13}`;
var symbol14 = Symbol.for(marker14);
var _a14;
var _b14;
var UnsupportedFunctionalityError = class extends (_b14 = AISDKError, _a14 = symbol14, _b14) {
  constructor({
    functionality,
    message = `'${functionality}' functionality not supported.`
  }) {
    super({ name: name13, message });
    this[_a14] = true;
    this.functionality = functionality;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker14);
  }
};

// node_modules/zod/v4/classic/external.js
var exports_external = {};
__export(exports_external, {
  xid: () => xid2,
  void: () => _void2,
  uuidv7: () => uuidv7,
  uuidv6: () => uuidv6,
  uuidv4: () => uuidv4,
  uuid: () => uuid2,
  util: () => exports_util,
  url: () => url,
  uppercase: () => _uppercase,
  unknown: () => unknown,
  union: () => union,
  undefined: () => _undefined3,
  ulid: () => ulid2,
  uint64: () => uint64,
  uint32: () => uint32,
  tuple: () => tuple,
  trim: () => _trim,
  treeifyError: () => treeifyError,
  transform: () => transform,
  toUpperCase: () => _toUpperCase,
  toLowerCase: () => _toLowerCase,
  toJSONSchema: () => toJSONSchema,
  templateLiteral: () => templateLiteral,
  symbol: () => symbol15,
  superRefine: () => superRefine,
  success: () => success,
  stringbool: () => stringbool,
  stringFormat: () => stringFormat,
  string: () => string2,
  strictObject: () => strictObject,
  startsWith: () => _startsWith,
  size: () => _size,
  setErrorMap: () => setErrorMap,
  set: () => set,
  safeParseAsync: () => safeParseAsync2,
  safeParse: () => safeParse2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeEncode: () => safeEncode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeDecode: () => safeDecode2,
  registry: () => registry,
  regexes: () => exports_regexes,
  regex: () => _regex,
  refine: () => refine,
  record: () => record,
  readonly: () => readonly,
  property: () => _property,
  promise: () => promise,
  prettifyError: () => prettifyError,
  preprocess: () => preprocess,
  prefault: () => prefault,
  positive: () => _positive,
  pipe: () => pipe,
  partialRecord: () => partialRecord,
  parseAsync: () => parseAsync2,
  parse: () => parse3,
  overwrite: () => _overwrite,
  optional: () => optional,
  object: () => object,
  number: () => number2,
  nullish: () => nullish2,
  nullable: () => nullable,
  null: () => _null3,
  normalize: () => _normalize,
  nonpositive: () => _nonpositive,
  nonoptional: () => nonoptional,
  nonnegative: () => _nonnegative,
  never: () => never,
  negative: () => _negative,
  nativeEnum: () => nativeEnum,
  nanoid: () => nanoid2,
  nan: () => nan,
  multipleOf: () => _multipleOf,
  minSize: () => _minSize,
  minLength: () => _minLength,
  mime: () => _mime,
  maxSize: () => _maxSize,
  maxLength: () => _maxLength,
  map: () => map,
  lte: () => _lte,
  lt: () => _lt,
  lowercase: () => _lowercase,
  looseObject: () => looseObject,
  locales: () => exports_locales,
  literal: () => literal,
  length: () => _length,
  lazy: () => lazy,
  ksuid: () => ksuid2,
  keyof: () => keyof,
  jwt: () => jwt,
  json: () => json,
  iso: () => exports_iso,
  ipv6: () => ipv62,
  ipv4: () => ipv42,
  intersection: () => intersection,
  int64: () => int64,
  int32: () => int32,
  int: () => int,
  instanceof: () => _instanceof,
  includes: () => _includes,
  httpUrl: () => httpUrl,
  hostname: () => hostname2,
  hex: () => hex2,
  hash: () => hash,
  guid: () => guid2,
  gte: () => _gte,
  gt: () => _gt,
  globalRegistry: () => globalRegistry,
  getErrorMap: () => getErrorMap,
  function: () => _function,
  formatError: () => formatError,
  float64: () => float64,
  float32: () => float32,
  flattenError: () => flattenError,
  file: () => file,
  enum: () => _enum2,
  endsWith: () => _endsWith,
  encodeAsync: () => encodeAsync2,
  encode: () => encode2,
  emoji: () => emoji2,
  email: () => email2,
  e164: () => e1642,
  discriminatedUnion: () => discriminatedUnion,
  decodeAsync: () => decodeAsync2,
  decode: () => decode2,
  date: () => date3,
  custom: () => custom,
  cuid2: () => cuid22,
  cuid: () => cuid3,
  core: () => exports_core2,
  config: () => config,
  coerce: () => exports_coerce,
  codec: () => codec,
  clone: () => clone,
  cidrv6: () => cidrv62,
  cidrv4: () => cidrv42,
  check: () => check,
  catch: () => _catch2,
  boolean: () => boolean2,
  bigint: () => bigint2,
  base64url: () => base64url3,
  base64: () => base642,
  array: () => array,
  any: () => any,
  _function: () => _function,
  _default: () => _default2,
  _ZodString: () => _ZodString,
  ZodXID: () => ZodXID,
  ZodVoid: () => ZodVoid,
  ZodUnknown: () => ZodUnknown,
  ZodUnion: () => ZodUnion,
  ZodUndefined: () => ZodUndefined,
  ZodUUID: () => ZodUUID,
  ZodURL: () => ZodURL,
  ZodULID: () => ZodULID,
  ZodType: () => ZodType,
  ZodTuple: () => ZodTuple,
  ZodTransform: () => ZodTransform,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodSymbol: () => ZodSymbol,
  ZodSuccess: () => ZodSuccess,
  ZodStringFormat: () => ZodStringFormat,
  ZodString: () => ZodString,
  ZodSet: () => ZodSet,
  ZodRecord: () => ZodRecord,
  ZodRealError: () => ZodRealError,
  ZodReadonly: () => ZodReadonly,
  ZodPromise: () => ZodPromise,
  ZodPrefault: () => ZodPrefault,
  ZodPipe: () => ZodPipe,
  ZodOptional: () => ZodOptional,
  ZodObject: () => ZodObject,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodNumber: () => ZodNumber,
  ZodNullable: () => ZodNullable,
  ZodNull: () => ZodNull,
  ZodNonOptional: () => ZodNonOptional,
  ZodNever: () => ZodNever,
  ZodNanoID: () => ZodNanoID,
  ZodNaN: () => ZodNaN,
  ZodMap: () => ZodMap,
  ZodLiteral: () => ZodLiteral,
  ZodLazy: () => ZodLazy,
  ZodKSUID: () => ZodKSUID,
  ZodJWT: () => ZodJWT,
  ZodIssueCode: () => ZodIssueCode,
  ZodIntersection: () => ZodIntersection,
  ZodISOTime: () => ZodISOTime,
  ZodISODuration: () => ZodISODuration,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODate: () => ZodISODate,
  ZodIPv6: () => ZodIPv6,
  ZodIPv4: () => ZodIPv4,
  ZodGUID: () => ZodGUID,
  ZodFunction: () => ZodFunction,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFile: () => ZodFile,
  ZodError: () => ZodError,
  ZodEnum: () => ZodEnum,
  ZodEmoji: () => ZodEmoji,
  ZodEmail: () => ZodEmail,
  ZodE164: () => ZodE164,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodDefault: () => ZodDefault,
  ZodDate: () => ZodDate,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodCustom: () => ZodCustom,
  ZodCodec: () => ZodCodec,
  ZodCatch: () => ZodCatch,
  ZodCUID2: () => ZodCUID2,
  ZodCUID: () => ZodCUID,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodBoolean: () => ZodBoolean,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBigInt: () => ZodBigInt,
  ZodBase64URL: () => ZodBase64URL,
  ZodBase64: () => ZodBase64,
  ZodArray: () => ZodArray,
  ZodAny: () => ZodAny,
  TimePrecision: () => TimePrecision,
  NEVER: () => NEVER,
  $output: () => $output,
  $input: () => $input,
  $brand: () => $brand
});

// node_modules/zod/v4/core/index.js
var exports_core2 = {};
__export(exports_core2, {
  version: () => version,
  util: () => exports_util,
  treeifyError: () => treeifyError,
  toJSONSchema: () => toJSONSchema,
  toDotPath: () => toDotPath,
  safeParseAsync: () => safeParseAsync,
  safeParse: () => safeParse,
  safeEncodeAsync: () => safeEncodeAsync,
  safeEncode: () => safeEncode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeDecode: () => safeDecode,
  registry: () => registry,
  regexes: () => exports_regexes,
  prettifyError: () => prettifyError,
  parseAsync: () => parseAsync,
  parse: () => parse,
  locales: () => exports_locales,
  isValidJWT: () => isValidJWT,
  isValidBase64URL: () => isValidBase64URL,
  isValidBase64: () => isValidBase64,
  globalRegistry: () => globalRegistry,
  globalConfig: () => globalConfig,
  formatError: () => formatError,
  flattenError: () => flattenError,
  encodeAsync: () => encodeAsync,
  encode: () => encode,
  decodeAsync: () => decodeAsync,
  decode: () => decode,
  config: () => config,
  clone: () => clone,
  _xid: () => _xid,
  _void: () => _void,
  _uuidv7: () => _uuidv7,
  _uuidv6: () => _uuidv6,
  _uuidv4: () => _uuidv4,
  _uuid: () => _uuid,
  _url: () => _url,
  _uppercase: () => _uppercase,
  _unknown: () => _unknown,
  _union: () => _union,
  _undefined: () => _undefined2,
  _ulid: () => _ulid,
  _uint64: () => _uint64,
  _uint32: () => _uint32,
  _tuple: () => _tuple,
  _trim: () => _trim,
  _transform: () => _transform,
  _toUpperCase: () => _toUpperCase,
  _toLowerCase: () => _toLowerCase,
  _templateLiteral: () => _templateLiteral,
  _symbol: () => _symbol,
  _superRefine: () => _superRefine,
  _success: () => _success,
  _stringbool: () => _stringbool,
  _stringFormat: () => _stringFormat,
  _string: () => _string,
  _startsWith: () => _startsWith,
  _size: () => _size,
  _set: () => _set,
  _safeParseAsync: () => _safeParseAsync,
  _safeParse: () => _safeParse,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeEncode: () => _safeEncode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeDecode: () => _safeDecode,
  _regex: () => _regex,
  _refine: () => _refine,
  _record: () => _record,
  _readonly: () => _readonly,
  _property: () => _property,
  _promise: () => _promise,
  _positive: () => _positive,
  _pipe: () => _pipe,
  _parseAsync: () => _parseAsync,
  _parse: () => _parse,
  _overwrite: () => _overwrite,
  _optional: () => _optional,
  _number: () => _number,
  _nullable: () => _nullable,
  _null: () => _null2,
  _normalize: () => _normalize,
  _nonpositive: () => _nonpositive,
  _nonoptional: () => _nonoptional,
  _nonnegative: () => _nonnegative,
  _never: () => _never,
  _negative: () => _negative,
  _nativeEnum: () => _nativeEnum,
  _nanoid: () => _nanoid,
  _nan: () => _nan,
  _multipleOf: () => _multipleOf,
  _minSize: () => _minSize,
  _minLength: () => _minLength,
  _min: () => _gte,
  _mime: () => _mime,
  _maxSize: () => _maxSize,
  _maxLength: () => _maxLength,
  _max: () => _lte,
  _map: () => _map,
  _lte: () => _lte,
  _lt: () => _lt,
  _lowercase: () => _lowercase,
  _literal: () => _literal,
  _length: () => _length,
  _lazy: () => _lazy,
  _ksuid: () => _ksuid,
  _jwt: () => _jwt,
  _isoTime: () => _isoTime,
  _isoDuration: () => _isoDuration,
  _isoDateTime: () => _isoDateTime,
  _isoDate: () => _isoDate,
  _ipv6: () => _ipv6,
  _ipv4: () => _ipv4,
  _intersection: () => _intersection,
  _int64: () => _int64,
  _int32: () => _int32,
  _int: () => _int,
  _includes: () => _includes,
  _guid: () => _guid,
  _gte: () => _gte,
  _gt: () => _gt,
  _float64: () => _float64,
  _float32: () => _float32,
  _file: () => _file,
  _enum: () => _enum,
  _endsWith: () => _endsWith,
  _encodeAsync: () => _encodeAsync,
  _encode: () => _encode,
  _emoji: () => _emoji2,
  _email: () => _email,
  _e164: () => _e164,
  _discriminatedUnion: () => _discriminatedUnion,
  _default: () => _default,
  _decodeAsync: () => _decodeAsync,
  _decode: () => _decode,
  _date: () => _date,
  _custom: () => _custom,
  _cuid2: () => _cuid2,
  _cuid: () => _cuid,
  _coercedString: () => _coercedString,
  _coercedNumber: () => _coercedNumber,
  _coercedDate: () => _coercedDate,
  _coercedBoolean: () => _coercedBoolean,
  _coercedBigint: () => _coercedBigint,
  _cidrv6: () => _cidrv6,
  _cidrv4: () => _cidrv4,
  _check: () => _check,
  _catch: () => _catch,
  _boolean: () => _boolean,
  _bigint: () => _bigint,
  _base64url: () => _base64url,
  _base64: () => _base64,
  _array: () => _array,
  _any: () => _any,
  TimePrecision: () => TimePrecision,
  NEVER: () => NEVER,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  JSONSchema: () => exports_json_schema,
  Doc: () => Doc,
  $output: () => $output,
  $input: () => $input,
  $constructor: () => $constructor,
  $brand: () => $brand,
  $ZodXID: () => $ZodXID,
  $ZodVoid: () => $ZodVoid,
  $ZodUnknown: () => $ZodUnknown,
  $ZodUnion: () => $ZodUnion,
  $ZodUndefined: () => $ZodUndefined,
  $ZodUUID: () => $ZodUUID,
  $ZodURL: () => $ZodURL,
  $ZodULID: () => $ZodULID,
  $ZodType: () => $ZodType,
  $ZodTuple: () => $ZodTuple,
  $ZodTransform: () => $ZodTransform,
  $ZodTemplateLiteral: () => $ZodTemplateLiteral,
  $ZodSymbol: () => $ZodSymbol,
  $ZodSuccess: () => $ZodSuccess,
  $ZodStringFormat: () => $ZodStringFormat,
  $ZodString: () => $ZodString,
  $ZodSet: () => $ZodSet,
  $ZodRegistry: () => $ZodRegistry,
  $ZodRecord: () => $ZodRecord,
  $ZodRealError: () => $ZodRealError,
  $ZodReadonly: () => $ZodReadonly,
  $ZodPromise: () => $ZodPromise,
  $ZodPrefault: () => $ZodPrefault,
  $ZodPipe: () => $ZodPipe,
  $ZodOptional: () => $ZodOptional,
  $ZodObjectJIT: () => $ZodObjectJIT,
  $ZodObject: () => $ZodObject,
  $ZodNumberFormat: () => $ZodNumberFormat,
  $ZodNumber: () => $ZodNumber,
  $ZodNullable: () => $ZodNullable,
  $ZodNull: () => $ZodNull,
  $ZodNonOptional: () => $ZodNonOptional,
  $ZodNever: () => $ZodNever,
  $ZodNanoID: () => $ZodNanoID,
  $ZodNaN: () => $ZodNaN,
  $ZodMap: () => $ZodMap,
  $ZodLiteral: () => $ZodLiteral,
  $ZodLazy: () => $ZodLazy,
  $ZodKSUID: () => $ZodKSUID,
  $ZodJWT: () => $ZodJWT,
  $ZodIntersection: () => $ZodIntersection,
  $ZodISOTime: () => $ZodISOTime,
  $ZodISODuration: () => $ZodISODuration,
  $ZodISODateTime: () => $ZodISODateTime,
  $ZodISODate: () => $ZodISODate,
  $ZodIPv6: () => $ZodIPv6,
  $ZodIPv4: () => $ZodIPv4,
  $ZodGUID: () => $ZodGUID,
  $ZodFunction: () => $ZodFunction,
  $ZodFile: () => $ZodFile,
  $ZodError: () => $ZodError,
  $ZodEnum: () => $ZodEnum,
  $ZodEncodeError: () => $ZodEncodeError,
  $ZodEmoji: () => $ZodEmoji,
  $ZodEmail: () => $ZodEmail,
  $ZodE164: () => $ZodE164,
  $ZodDiscriminatedUnion: () => $ZodDiscriminatedUnion,
  $ZodDefault: () => $ZodDefault,
  $ZodDate: () => $ZodDate,
  $ZodCustomStringFormat: () => $ZodCustomStringFormat,
  $ZodCustom: () => $ZodCustom,
  $ZodCodec: () => $ZodCodec,
  $ZodCheckUpperCase: () => $ZodCheckUpperCase,
  $ZodCheckStringFormat: () => $ZodCheckStringFormat,
  $ZodCheckStartsWith: () => $ZodCheckStartsWith,
  $ZodCheckSizeEquals: () => $ZodCheckSizeEquals,
  $ZodCheckRegex: () => $ZodCheckRegex,
  $ZodCheckProperty: () => $ZodCheckProperty,
  $ZodCheckOverwrite: () => $ZodCheckOverwrite,
  $ZodCheckNumberFormat: () => $ZodCheckNumberFormat,
  $ZodCheckMultipleOf: () => $ZodCheckMultipleOf,
  $ZodCheckMinSize: () => $ZodCheckMinSize,
  $ZodCheckMinLength: () => $ZodCheckMinLength,
  $ZodCheckMimeType: () => $ZodCheckMimeType,
  $ZodCheckMaxSize: () => $ZodCheckMaxSize,
  $ZodCheckMaxLength: () => $ZodCheckMaxLength,
  $ZodCheckLowerCase: () => $ZodCheckLowerCase,
  $ZodCheckLessThan: () => $ZodCheckLessThan,
  $ZodCheckLengthEquals: () => $ZodCheckLengthEquals,
  $ZodCheckIncludes: () => $ZodCheckIncludes,
  $ZodCheckGreaterThan: () => $ZodCheckGreaterThan,
  $ZodCheckEndsWith: () => $ZodCheckEndsWith,
  $ZodCheckBigIntFormat: () => $ZodCheckBigIntFormat,
  $ZodCheck: () => $ZodCheck,
  $ZodCatch: () => $ZodCatch,
  $ZodCUID2: () => $ZodCUID2,
  $ZodCUID: () => $ZodCUID,
  $ZodCIDRv6: () => $ZodCIDRv6,
  $ZodCIDRv4: () => $ZodCIDRv4,
  $ZodBoolean: () => $ZodBoolean,
  $ZodBigIntFormat: () => $ZodBigIntFormat,
  $ZodBigInt: () => $ZodBigInt,
  $ZodBase64URL: () => $ZodBase64URL,
  $ZodBase64: () => $ZodBase64,
  $ZodAsyncError: () => $ZodAsyncError,
  $ZodArray: () => $ZodArray,
  $ZodAny: () => $ZodAny
});

// node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
function $constructor(name14, initializer, params) {
  function init(inst, def) {
    var _a15;
    Object.defineProperty(inst, "_zod", {
      value: inst._zod ?? {},
      enumerable: false
    });
    (_a15 = inst._zod).traits ?? (_a15.traits = new Set);
    inst._zod.traits.add(name14);
    initializer(inst, def);
    for (const k in _.prototype) {
      if (!(k in inst))
        Object.defineProperty(inst, k, { value: _.prototype[k].bind(inst) });
    }
    inst._zod.constr = _;
    inst._zod.def = def;
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name14 });
  function _(def) {
    var _a15;
    const inst = params?.Parent ? new Definition : this;
    init(inst, def);
    (_a15 = inst._zod).deferred ?? (_a15.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name14);
    }
  });
  Object.defineProperty(_, "name", { value: name14 });
  return _;
}
var $brand = Symbol("zod_brand");

class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name14) {
    super(`Encountered unidirectional transform during encode: ${name14}`);
    this.name = "ZodEncodeError";
  }
}
var globalConfig = {};
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// node_modules/zod/v4/core/util.js
var exports_util = {};
__export(exports_util, {
  unwrapMessage: () => unwrapMessage,
  uint8ArrayToHex: () => uint8ArrayToHex,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  stringifyPrimitive: () => stringifyPrimitive,
  shallowClone: () => shallowClone,
  safeExtend: () => safeExtend,
  required: () => required,
  randomString: () => randomString,
  propertyKeyTypes: () => propertyKeyTypes,
  promiseAllObject: () => promiseAllObject,
  primitiveTypes: () => primitiveTypes,
  prefixIssues: () => prefixIssues,
  pick: () => pick,
  partial: () => partial,
  optionalKeys: () => optionalKeys,
  omit: () => omit,
  objectClone: () => objectClone,
  numKeys: () => numKeys,
  nullish: () => nullish,
  normalizeParams: () => normalizeParams,
  mergeDefs: () => mergeDefs,
  merge: () => merge,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  joinValues: () => joinValues,
  issue: () => issue,
  isPlainObject: () => isPlainObject4,
  isObject: () => isObject,
  hexToUint8Array: () => hexToUint8Array,
  getSizableOrigin: () => getSizableOrigin,
  getParsedType: () => getParsedType,
  getLengthableOrigin: () => getLengthableOrigin,
  getEnumValues: () => getEnumValues,
  getElementAtPath: () => getElementAtPath,
  floatSafeRemainder: () => floatSafeRemainder,
  finalizeIssue: () => finalizeIssue,
  extend: () => extend,
  escapeRegex: () => escapeRegex,
  esc: () => esc,
  defineLazy: () => defineLazy,
  createTransparentProxy: () => createTransparentProxy,
  cloneDef: () => cloneDef,
  clone: () => clone,
  cleanRegex: () => cleanRegex,
  cleanEnum: () => cleanEnum,
  captureStackTrace: () => captureStackTrace,
  cached: () => cached,
  base64urlToUint8Array: () => base64urlToUint8Array,
  base64ToUint8Array: () => base64ToUint8Array,
  assignProp: () => assignProp,
  assertNotEqual: () => assertNotEqual,
  assertNever: () => assertNever,
  assertIs: () => assertIs,
  assertEqual: () => assertEqual,
  assert: () => assert,
  allowsEval: () => allowsEval,
  aborted: () => aborted,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  Class: () => Class,
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {}
function assertNever(_x) {
  throw new Error;
}
function assert(_) {}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0;i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0;i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject4(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject4(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = new Set(["string", "number", "symbol"]);
var primitiveTypes = new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject4(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error("Object schemas containing refinements cannot be extended. Use `.safeExtend()` instead.");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject4(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = {
    ...schema._zod.def,
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: schema._zod.def.checks
  };
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
  });
  return clone(a, def);
}
function partial(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a15;
    (_a15 = iss).path ?? (_a15.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config2) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config2.customError?.(iss)) ?? unwrapMessage(config2.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0;i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0;i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url2) {
  const base64 = base64url2.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  return base64ToUint8Array(base64 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex) {
  const cleanHex = hex.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0;i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Class {
  constructor(..._args) {}
}

// node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error, mapper = (issue2) => issue2.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const fieldErrors = { _errors: [] };
  const processError = (error2) => {
    for (const issue2 of error2.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues });
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues });
      } else if (issue2.path.length === 0) {
        fieldErrors._errors.push(mapper(issue2));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue2.path.length) {
          const el = issue2.path[i];
          const terminal = i === issue2.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue2));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}
function treeifyError(error, _mapper) {
  const mapper = _mapper || function(issue2) {
    return issue2.message;
  };
  const result = { errors: [] };
  const processError = (error2, path = []) => {
    var _a15, _b15;
    for (const issue2 of error2.issues) {
      if (issue2.code === "invalid_union" && issue2.errors.length) {
        issue2.errors.map((issues) => processError({ issues }, issue2.path));
      } else if (issue2.code === "invalid_key") {
        processError({ issues: issue2.issues }, issue2.path);
      } else if (issue2.code === "invalid_element") {
        processError({ issues: issue2.issues }, issue2.path);
      } else {
        const fullpath = [...path, ...issue2.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue2));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a15 = curr.properties)[el] ?? (_a15[el] = { errors: [] });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b15 = curr.items)[el] ?? (_b15[el] = { errors: [] });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue2));
          }
          i++;
        }
      }
    }
  };
  processError(error);
  return result;
}
function toDotPath(_path) {
  const segs = [];
  const path = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path) {
    if (typeof seg === "number")
      segs.push(`[${seg}]`);
    else if (typeof seg === "symbol")
      segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg))
      segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length)
        segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
function prettifyError(error) {
  const lines = [];
  const issues = [...error.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue2 of issues) {
    lines.push(`✖ ${issue2.message}`);
    if (issue2.path?.length)
      lines.push(`  → at ${toDotPath(issue2.path)}`);
  }
  return lines.join(`
`);
}

// node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var encode = /* @__PURE__ */ _encode($ZodRealError);
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var decode = /* @__PURE__ */ _decode($ZodRealError);
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var encodeAsync = /* @__PURE__ */ _encodeAsync($ZodRealError);
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var decodeAsync = /* @__PURE__ */ _decodeAsync($ZodRealError);
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var safeEncode = /* @__PURE__ */ _safeEncode($ZodRealError);
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var safeDecode = /* @__PURE__ */ _safeDecode($ZodRealError);
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);
// node_modules/zod/v4/core/regexes.js
var exports_regexes = {};
__export(exports_regexes, {
  xid: () => xid,
  uuid7: () => uuid7,
  uuid6: () => uuid6,
  uuid4: () => uuid4,
  uuid: () => uuid,
  uppercase: () => uppercase,
  unicodeEmail: () => unicodeEmail,
  undefined: () => _undefined,
  ulid: () => ulid,
  time: () => time,
  string: () => string,
  sha512_hex: () => sha512_hex,
  sha512_base64url: () => sha512_base64url,
  sha512_base64: () => sha512_base64,
  sha384_hex: () => sha384_hex,
  sha384_base64url: () => sha384_base64url,
  sha384_base64: () => sha384_base64,
  sha256_hex: () => sha256_hex,
  sha256_base64url: () => sha256_base64url,
  sha256_base64: () => sha256_base64,
  sha1_hex: () => sha1_hex,
  sha1_base64url: () => sha1_base64url,
  sha1_base64: () => sha1_base64,
  rfc5322Email: () => rfc5322Email,
  number: () => number,
  null: () => _null,
  nanoid: () => nanoid,
  md5_hex: () => md5_hex,
  md5_base64url: () => md5_base64url,
  md5_base64: () => md5_base64,
  lowercase: () => lowercase,
  ksuid: () => ksuid,
  ipv6: () => ipv6,
  ipv4: () => ipv4,
  integer: () => integer,
  idnEmail: () => idnEmail,
  html5Email: () => html5Email,
  hostname: () => hostname,
  hex: () => hex,
  guid: () => guid,
  extendedDuration: () => extendedDuration,
  emoji: () => emoji,
  email: () => email,
  e164: () => e164,
  duration: () => duration,
  domain: () => domain,
  datetime: () => datetime,
  date: () => date,
  cuid2: () => cuid2,
  cuid: () => cuid,
  cidrv6: () => cidrv6,
  cidrv4: () => cidrv4,
  browserEmail: () => browserEmail,
  boolean: () => boolean,
  bigint: () => bigint,
  base64url: () => base64url2,
  base64: () => base64
});
var cuid = /^[cC][^\s-]{8,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var extendedDuration = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var html5Email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rfc5322Email = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var unicodeEmail = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url2 = /^[A-Za-z0-9_-]*$/;
var hostname = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var e164 = /^\+(?:[0-9]){6,14}[0-9]$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time2 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time2}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var _undefined = /^undefined$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
var hex = /^[0-9a-fA-F]*$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(`^[A-Za-z0-9+/]{${bodyLength}}${padding}$`);
}
function fixedBase64url(length) {
  return new RegExp(`^[A-Za-z0-9_-]{${length}}$`);
}
var md5_hex = /^[0-9a-fA-F]{32}$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a15;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a15 = inst._zod).onattach ?? (_a15.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    var _a15;
    (_a15 = inst2._zod.bag).multipleOf ?? (_a15.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckBigIntFormat = /* @__PURE__ */ $constructor("$ZodCheckBigIntFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckMaxSize = /* @__PURE__ */ $constructor("$ZodCheckMaxSize", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinSize = /* @__PURE__ */ $constructor("$ZodCheckMinSize", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckSizeEquals = /* @__PURE__ */ $constructor("$ZodCheckSizeEquals", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size)
      return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? { code: "too_big", maximum: def.size } : { code: "too_small", minimum: def.size },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst2._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const curr = inst2._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst2._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a15;
  $ZodCheck.init(inst, def);
  (_a15 = inst._zod.def).when ?? (_a15.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a15, _b15;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = new Set);
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a15 = inst._zod).check ?? (_a15.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b15 = inst._zod).check ?? (_b15.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
var $ZodCheckProperty = /* @__PURE__ */ $constructor("$ZodCheckProperty", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result2) => handleCheckPropertyResult(result2, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var $ZodCheckMimeType = /* @__PURE__ */ $constructor("$ZodCheckMimeType", (inst, def) => {
  $ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type))
      return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join(`
`));
  }
}

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 1,
  patch: 8
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a15;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a15 = inst._zod).deferred ?? (_a15.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks2, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks2) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult2) => inst._zod.parse(checkResult2, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary2) => {
            return handleCanaryResult(canary2, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result2) => runChecks(result2, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  inst["~standard"] = {
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  };
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_2) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv4`;
  });
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    const bag = inst2._zod.bag;
    bag.format = `ipv6`;
  });
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error;
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error;
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error;
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error;
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url2.test(data))
    return false;
  const base642 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base642.padEnd(Math.ceil(base642.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url2);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst2) => {
    inst2._zod.bag.contentEncoding = "base64url";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCustomStringFormat = /* @__PURE__ */ $constructor("$ZodCustomStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {}
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodBigIntFormat = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodCheckBigIntFormat.init(inst, def);
  $ZodBigInt.init(inst, def);
});
var $ZodSymbol = /* @__PURE__ */ $constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol")
      return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = new Set([undefined]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodVoid = /* @__PURE__ */ $constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {}
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleArrayResult(result2, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === undefined) {
    if (key in input) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  for (const key of Object.keys(input)) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
    } else {
      handlePropertyResult(r, payload, key, input);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = new Set);
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r2) => handlePropertyResult(r2, payload, key, input)));
      } else {
        handlePropertyResult(r, payload, key, input);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      doc.write(`const ${id} = ${parseStr(key)};`);
      doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results2) => {
      return handleUnionResults(results2, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = new Set;
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map = new Map;
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map.set(v, o);
      }
    }
    return map;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left2, right2]) => {
        return handleIntersectionResults(payload, left2, right2);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject4(a) && isPlainObject4(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [...items].reverse().findIndex((item) => item._zod.optin !== "optional");
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? { code: "too_big", maximum: items.length } : { code: "too_small", minimum: items.length },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart)
          continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => handleTupleResult(result2, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject4(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result2) => {
              if (result2.issues.length) {
                payload.issues.push(...prefixIssues(key, result2.issues));
              }
              payload.value[key] = result2.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        if (keyResult.issues.length) {
          payload.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
            input: key,
            path: [key],
            inst
          });
          payload.value[keyResult.value] = keyResult.value;
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result2) => {
            if (result2.issues.length) {
              payload.issues.push(...prefixIssues(key, result2.issues));
            }
            payload.value[keyResult.value] = result2.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodMap = /* @__PURE__ */ $constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = new Map;
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value, issues: [] }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([keyResult, valueResult]).then(([keyResult2, valueResult2]) => {
          handleMapResult(keyResult2, valueResult2, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
var $ZodSet = /* @__PURE__ */ $constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = new Set;
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result2) => handleSetResult(result2, payload)));
      } else
        handleSetResult(result, payload);
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  inst._zod.values = new Set(def.values);
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodFile = /* @__PURE__ */ $constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File)
      return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === undefined) {
    return { issues: [], value: undefined };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, undefined]) : undefined;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === undefined) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleDefaultResult(result2, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => handleNonOptionalResult(result2, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodSuccess = /* @__PURE__ */ $constructor("$ZodSuccess", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result2) => {
        payload.value = result2.value;
        if (result2.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result2.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var $ZodNaN = /* @__PURE__ */ $constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handlePipeResult(right2, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left2) => handlePipeResult(left2, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodCodec = /* @__PURE__ */ $constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left2) => handleCodecAResult(left2, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right2) => handleCodecAResult(right2, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({ value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodTemplateLiteral = /* @__PURE__ */ $constructor("$ZodTemplateLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(`Invalid template literal part, no pattern found: ${[...part._zod.traits].shift()}`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source)
        throw new Error(`Invalid template literal part: ${part._zod.traits}`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(`${part}`));
    } else {
      throw new Error(`Invalid template literal part: ${part}`);
    }
  }
  inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "template_literal",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var $ZodPromise = /* @__PURE__ */ $constructor("$ZodPromise", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? undefined);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? undefined);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r2) => handleRefineResult(r2, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// node_modules/zod/v4/locales/index.js
var exports_locales = {};
__export(exports_locales, {
  zhTW: () => zh_TW_default,
  zhCN: () => zh_CN_default,
  yo: () => yo_default,
  vi: () => vi_default,
  ur: () => ur_default,
  uk: () => uk_default,
  ua: () => ua_default,
  tr: () => tr_default,
  th: () => th_default,
  ta: () => ta_default,
  sv: () => sv_default,
  sl: () => sl_default,
  ru: () => ru_default,
  pt: () => pt_default,
  ps: () => ps_default,
  pl: () => pl_default,
  ota: () => ota_default,
  no: () => no_default,
  nl: () => nl_default,
  ms: () => ms_default,
  mk: () => mk_default,
  lt: () => lt_default,
  ko: () => ko_default,
  km: () => km_default,
  kh: () => kh_default,
  ka: () => ka_default,
  ja: () => ja_default,
  it: () => it_default,
  is: () => is_default,
  id: () => id_default,
  hu: () => hu_default,
  he: () => he_default,
  frCA: () => fr_CA_default,
  fr: () => fr_default,
  fi: () => fi_default,
  fa: () => fa_default,
  es: () => es_default,
  eo: () => eo_default,
  en: () => en_default,
  de: () => de_default,
  da: () => da_default,
  cs: () => cs_default,
  ca: () => ca_default,
  be: () => be_default,
  az: () => az_default,
  ar: () => ar_default
});

// node_modules/zod/v4/locales/ar.js
var error = () => {
  const Sizable = {
    string: { unit: "حرف", verb: "أن يحوي" },
    file: { unit: "بايت", verb: "أن يحوي" },
    array: { unit: "عنصر", verb: "أن يحوي" },
    set: { unit: "عنصر", verb: "أن يحوي" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "مدخل",
    email: "بريد إلكتروني",
    url: "رابط",
    emoji: "إيموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاريخ ووقت بمعيار ISO",
    date: "تاريخ بمعيار ISO",
    time: "وقت بمعيار ISO",
    duration: "مدة بمعيار ISO",
    ipv4: "عنوان IPv4",
    ipv6: "عنوان IPv6",
    cidrv4: "مدى عناوين بصيغة IPv4",
    cidrv6: "مدى عناوين بصيغة IPv6",
    base64: "نَص بترميز base64-encoded",
    base64url: "نَص بترميز base64url-encoded",
    json_string: "نَص على هيئة JSON",
    e164: "رقم هاتف بمعيار E.164",
    jwt: "JWT",
    template_literal: "مدخل"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `مدخلات غير مقبولة: يفترض إدخال ${issue2.expected}، ولكن تم إدخال ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `مدخلات غير مقبولة: يفترض إدخال ${stringifyPrimitive(issue2.values[0])}`;
        return `اختيار غير مقبول: يتوقع انتقاء أحد هذه الخيارات: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return ` أكبر من اللازم: يفترض أن تكون ${issue2.origin ?? "القيمة"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "عنصر"}`;
        return `أكبر من اللازم: يفترض أن تكون ${issue2.origin ?? "القيمة"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `أصغر من اللازم: يفترض لـ ${issue2.origin} أن يكون ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `أصغر من اللازم: يفترض لـ ${issue2.origin} أن يكون ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `نَص غير مقبول: يجب أن يبدأ بـ "${issue2.prefix}"`;
        if (_issue.format === "ends_with")
          return `نَص غير مقبول: يجب أن ينتهي بـ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `نَص غير مقبول: يجب أن يتضمَّن "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `نَص غير مقبول: يجب أن يطابق النمط ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} غير مقبول`;
      }
      case "not_multiple_of":
        return `رقم غير مقبول: يجب أن يكون من مضاعفات ${issue2.divisor}`;
      case "unrecognized_keys":
        return `معرف${issue2.keys.length > 1 ? "ات" : ""} غريب${issue2.keys.length > 1 ? "ة" : ""}: ${joinValues(issue2.keys, "، ")}`;
      case "invalid_key":
        return `معرف غير مقبول في ${issue2.origin}`;
      case "invalid_union":
        return "مدخل غير مقبول";
      case "invalid_element":
        return `مدخل غير مقبول في ${issue2.origin}`;
      default:
        return "مدخل غير مقبول";
    }
  };
};
function ar_default() {
  return {
    localeError: error()
  };
}
// node_modules/zod/v4/locales/az.js
var error2 = () => {
  const Sizable = {
    string: { unit: "simvol", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "element", verb: "olmalıdır" },
    set: { unit: "element", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Yanlış dəyər: gözlənilən ${issue2.expected}, daxil olan ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Yanlış dəyər: gözlənilən ${stringifyPrimitive(issue2.values[0])}`;
        return `Yanlış seçim: aşağıdakılardan biri olmalıdır: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çox böyük: gözlənilən ${issue2.origin ?? "dəyər"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        return `Çox böyük: gözlənilən ${issue2.origin ?? "dəyər"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çox kiçik: gözlənilən ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `Çox kiçik: gözlənilən ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Yanlış mətn: "${_issue.prefix}" ilə başlamalıdır`;
        if (_issue.format === "ends_with")
          return `Yanlış mətn: "${_issue.suffix}" ilə bitməlidir`;
        if (_issue.format === "includes")
          return `Yanlış mətn: "${_issue.includes}" daxil olmalıdır`;
        if (_issue.format === "regex")
          return `Yanlış mətn: ${_issue.pattern} şablonuna uyğun olmalıdır`;
        return `Yanlış ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Yanlış ədəd: ${issue2.divisor} ilə bölünə bilən olmalıdır`;
      case "unrecognized_keys":
        return `Tanınmayan açar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} daxilində yanlış açar`;
      case "invalid_union":
        return "Yanlış dəyər";
      case "invalid_element":
        return `${issue2.origin} daxilində yanlış dəyər`;
      default:
        return `Yanlış dəyər`;
    }
  };
};
function az_default() {
  return {
    localeError: error2()
  };
}
// node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error3 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "сімвал",
        few: "сімвалы",
        many: "сімвалаў"
      },
      verb: "мець"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    file: {
      unit: {
        one: "байт",
        few: "байты",
        many: "байтаў"
      },
      verb: "мець"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "лік";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масіў";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "увод",
    email: "email адрас",
    url: "URL",
    emoji: "эмодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата і час",
    date: "ISO дата",
    time: "ISO час",
    duration: "ISO працягласць",
    ipv4: "IPv4 адрас",
    ipv6: "IPv6 адрас",
    cidrv4: "IPv4 дыяпазон",
    cidrv6: "IPv6 дыяпазон",
    base64: "радок у фармаце base64",
    base64url: "радок у фармаце base64url",
    json_string: "JSON радок",
    e164: "нумар E.164",
    jwt: "JWT",
    template_literal: "увод"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Няправільны ўвод: чакаўся ${issue2.expected}, атрымана ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Няправільны ўвод: чакалася ${stringifyPrimitive(issue2.values[0])}`;
        return `Няправільны варыянт: чакаўся адзін з ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта вялікі: чакалася, што ${issue2.origin ?? "значэнне"} павінна ${sizing.verb} ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `Занадта вялікі: чакалася, што ${issue2.origin ?? "значэнне"} павінна быць ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта малы: чакалася, што ${issue2.origin} павінна ${sizing.verb} ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `Занадта малы: чакалася, што ${issue2.origin} павінна быць ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Няправільны радок: павінен пачынацца з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Няправільны радок: павінен заканчвацца на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Няправільны радок: павінен змяшчаць "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Няправільны радок: павінен адпавядаць шаблону ${_issue.pattern}`;
        return `Няправільны ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Няправільны лік: павінен быць кратным ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нераспазнаны ${issue2.keys.length > 1 ? "ключы" : "ключ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Няправільны ключ у ${issue2.origin}`;
      case "invalid_union":
        return "Няправільны ўвод";
      case "invalid_element":
        return `Няправільнае значэнне ў ${issue2.origin}`;
      default:
        return `Няправільны ўвод`;
    }
  };
};
function be_default() {
  return {
    localeError: error3()
  };
}
// node_modules/zod/v4/locales/ca.js
var error4 = () => {
  const Sizable = {
    string: { unit: "caràcters", verb: "contenir" },
    file: { unit: "bytes", verb: "contenir" },
    array: { unit: "elements", verb: "contenir" },
    set: { unit: "elements", verb: "contenir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "adreça electrònica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adreça IPv4",
    ipv6: "adreça IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipus invàlid: s'esperava ${issue2.expected}, s'ha rebut ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Valor invàlid: s'esperava ${stringifyPrimitive(issue2.values[0])}`;
        return `Opció invàlida: s'esperava una de ${joinValues(issue2.values, " o ")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "com a màxim" : "menys de";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} contingués ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${issue2.origin ?? "el valor"} fos ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "com a mínim" : "més de";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Massa petit: s'esperava que ${issue2.origin} contingués ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Massa petit: s'esperava que ${issue2.origin} fos ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Format invàlid: ha de començar amb "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Format invàlid: ha d'acabar amb "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Format invàlid: ha d'incloure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Format invàlid: ha de coincidir amb el patró ${_issue.pattern}`;
        return `Format invàlid per a ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Número invàlid: ha de ser múltiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clau${issue2.keys.length > 1 ? "s" : ""} no reconeguda${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clau invàlida a ${issue2.origin}`;
      case "invalid_union":
        return "Entrada invàlida";
      case "invalid_element":
        return `Element invàlid a ${issue2.origin}`;
      default:
        return `Entrada invàlida`;
    }
  };
};
function ca_default() {
  return {
    localeError: error4()
  };
}
// node_modules/zod/v4/locales/cs.js
var error5 = () => {
  const Sizable = {
    string: { unit: "znaků", verb: "mít" },
    file: { unit: "bajtů", verb: "mít" },
    array: { unit: "prvků", verb: "mít" },
    set: { unit: "prvků", verb: "mít" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "číslo";
      }
      case "string": {
        return "řetězec";
      }
      case "boolean": {
        return "boolean";
      }
      case "bigint": {
        return "bigint";
      }
      case "function": {
        return "funkce";
      }
      case "symbol": {
        return "symbol";
      }
      case "undefined": {
        return "undefined";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "pole";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "regulární výraz",
    email: "e-mailová adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a čas ve formátu ISO",
    date: "datum ve formátu ISO",
    time: "čas ve formátu ISO",
    duration: "doba trvání ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "řetězec zakódovaný ve formátu base64",
    base64url: "řetězec zakódovaný ve formátu base64url",
    json_string: "řetězec ve formátu JSON",
    e164: "číslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neplatný vstup: očekáváno ${issue2.expected}, obdrženo ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neplatný vstup: očekáváno ${stringifyPrimitive(issue2.values[0])}`;
        return `Neplatná možnost: očekávána jedna z hodnot ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je příliš velká: ${issue2.origin ?? "hodnota"} musí mít ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš velká: ${issue2.origin ?? "hodnota"} musí být ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Hodnota je příliš malá: ${issue2.origin ?? "hodnota"} musí mít ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš malá: ${issue2.origin ?? "hodnota"} musí být ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Neplatný řetězec: musí začínat na "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Neplatný řetězec: musí končit na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neplatný řetězec: musí obsahovat "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neplatný řetězec: musí odpovídat vzoru ${_issue.pattern}`;
        return `Neplatný formát ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neplatné číslo: musí být násobkem ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neznámé klíče: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neplatný klíč v ${issue2.origin}`;
      case "invalid_union":
        return "Neplatný vstup";
      case "invalid_element":
        return `Neplatná hodnota v ${issue2.origin}`;
      default:
        return `Neplatný vstup`;
    }
  };
};
function cs_default() {
  return {
    localeError: error5()
  };
}
// node_modules/zod/v4/locales/da.js
var error6 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "havde" },
    file: { unit: "bytes", verb: "havde" },
    array: { unit: "elementer", verb: "indeholdt" },
    set: { unit: "elementer", verb: "indeholdt" }
  };
  const TypeNames = {
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "sæt",
    file: "fil"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
        return "objekt";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslæt",
    date: "ISO-dato",
    time: "ISO-klokkeslæt",
    duration: "ISO-varighed",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldigt input: forventede ${getTypeName(issue2.expected)}, fik ${getTypeName(parsedType(issue2.input))}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig værdi: forventede ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldigt valg: forventede en af følgende ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `For stor: forventede ${origin ?? "value"} ${sizing.verb} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor: forventede ${origin ?? "value"} havde ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `For lille: forventede ${origin} ${sizing.verb} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lille: forventede ${origin} havde ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: skal starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: skal ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: skal indeholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: skal matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldigt tal: skal være deleligt med ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukendte nøgler" : "Ukendt nøgle"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøgle i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return `Ugyldig værdi i ${issue2.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function da_default() {
  return {
    localeError: error6()
  };
}
// node_modules/zod/v4/locales/de.js
var error7 = () => {
  const Sizable = {
    string: { unit: "Zeichen", verb: "zu haben" },
    file: { unit: "Bytes", verb: "zu haben" },
    array: { unit: "Elemente", verb: "zu haben" },
    set: { unit: "Elemente", verb: "zu haben" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "Zahl";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "Array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ungültige Eingabe: erwartet ${issue2.expected}, erhalten ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ungültige Eingabe: erwartet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ungültige Option: erwartet eine von ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Zu groß: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "Elemente"} hat`;
        return `Zu groß: erwartet, dass ${issue2.origin ?? "Wert"} ${adj}${issue2.maximum.toString()} ist`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} hat`;
        }
        return `Zu klein: erwartet, dass ${issue2.origin} ${adj}${issue2.minimum.toString()} ist`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ungültiger String: muss mit "${_issue.prefix}" beginnen`;
        if (_issue.format === "ends_with")
          return `Ungültiger String: muss mit "${_issue.suffix}" enden`;
        if (_issue.format === "includes")
          return `Ungültiger String: muss "${_issue.includes}" enthalten`;
        if (_issue.format === "regex")
          return `Ungültiger String: muss dem Muster ${_issue.pattern} entsprechen`;
        return `Ungültig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ungültige Zahl: muss ein Vielfaches von ${issue2.divisor} sein`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Unbekannte Schlüssel" : "Unbekannter Schlüssel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ungültiger Schlüssel in ${issue2.origin}`;
      case "invalid_union":
        return "Ungültige Eingabe";
      case "invalid_element":
        return `Ungültiger Wert in ${issue2.origin}`;
      default:
        return `Ungültige Eingabe`;
    }
  };
};
function de_default() {
  return {
    localeError: error7()
  };
}
// node_modules/zod/v4/locales/en.js
var parsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error8 = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Invalid input: expected ${issue2.expected}, received ${parsedType(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Too big: expected ${issue2.origin ?? "value"} to have ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue2.origin ?? "value"} to be ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Too small: expected ${issue2.origin} to have ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue2.origin} to be ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue2.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue2.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error8()
  };
}
// node_modules/zod/v4/locales/eo.js
var parsedType2 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "nombro";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "tabelo";
      }
      if (data === null) {
        return "senvalora";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error9 = () => {
  const Sizable = {
    string: { unit: "karaktrojn", verb: "havi" },
    file: { unit: "bajtojn", verb: "havi" },
    array: { unit: "elementojn", verb: "havi" },
    set: { unit: "elementojn", verb: "havi" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emoĝio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-daŭro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nevalida enigo: atendiĝis ${issue2.expected}, riceviĝis ${parsedType2(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nevalida enigo: atendiĝis ${stringifyPrimitive(issue2.values[0])}`;
        return `Nevalida opcio: atendiĝis unu el ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tro granda: atendiĝis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementojn"}`;
        return `Tro granda: atendiĝis ke ${issue2.origin ?? "valoro"} havu ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Tro malgranda: atendiĝis ke ${issue2.origin} havu ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Tro malgranda: atendiĝis ke ${issue2.origin} estu ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nevalida karaktraro: devas komenciĝi per "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nevalida karaktraro: devas finiĝi per "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nevalida karaktraro: devas inkluzivi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nevalida karaktraro: devas kongrui kun la modelo ${_issue.pattern}`;
        return `Nevalida ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${issue2.keys.length > 1 ? "j" : ""} ŝlosilo${issue2.keys.length > 1 ? "j" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida ŝlosilo en ${issue2.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${issue2.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function eo_default() {
  return {
    localeError: error9()
  };
}
// node_modules/zod/v4/locales/es.js
var error10 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "tener" },
    file: { unit: "bytes", verb: "tener" },
    array: { unit: "elementos", verb: "tener" },
    set: { unit: "elementos", verb: "tener" }
  };
  const TypeNames = {
    string: "texto",
    number: "número",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "número grande",
    symbol: "símbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "función",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeración",
    union: "unión",
    literal: "literal",
    promise: "promesa",
    void: "vacío",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype) {
          return data.constructor.name;
        }
        return "object";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "dirección de correo electrónico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duración ISO",
    ipv4: "dirección IPv4",
    ipv6: "dirección IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrada inválida: se esperaba ${getTypeName(issue2.expected)}, recibido ${getTypeName(parsedType3(issue2.input))}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inválida: se esperaba ${stringifyPrimitive(issue2.values[0])}`;
        return `Opción inválida: se esperaba una de ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing)
          return `Demasiado grande: se esperaba que ${origin ?? "valor"} tuviera ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${origin ?? "valor"} fuera ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        const origin = getTypeName(issue2.origin);
        if (sizing) {
          return `Demasiado pequeño: se esperaba que ${origin} tuviera ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Demasiado pequeño: se esperaba que ${origin} fuera ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Cadena inválida: debe comenzar con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cadena inválida: debe terminar en "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cadena inválida: debe incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cadena inválida: debe coincidir con el patrón ${_issue.pattern}`;
        return `Inválido ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Número inválido: debe ser múltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Llave${issue2.keys.length > 1 ? "s" : ""} desconocida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Llave inválida en ${getTypeName(issue2.origin)}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido en ${getTypeName(issue2.origin)}`;
      default:
        return `Entrada inválida`;
    }
  };
};
function es_default() {
  return {
    localeError: error10()
  };
}
// node_modules/zod/v4/locales/fa.js
var error11 = () => {
  const Sizable = {
    string: { unit: "کاراکتر", verb: "داشته باشد" },
    file: { unit: "بایت", verb: "داشته باشد" },
    array: { unit: "آیتم", verb: "داشته باشد" },
    set: { unit: "آیتم", verb: "داشته باشد" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرایه";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودی",
    email: "آدرس ایمیل",
    url: "URL",
    emoji: "ایموجی",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاریخ و زمان ایزو",
    date: "تاریخ ایزو",
    time: "زمان ایزو",
    duration: "مدت زمان ایزو",
    ipv4: "IPv4 آدرس",
    ipv6: "IPv6 آدرس",
    cidrv4: "IPv4 دامنه",
    cidrv6: "IPv6 دامنه",
    base64: "base64-encoded رشته",
    base64url: "base64url-encoded رشته",
    json_string: "JSON رشته",
    e164: "E.164 عدد",
    jwt: "JWT",
    template_literal: "ورودی"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ورودی نامعتبر: می‌بایست ${issue2.expected} می‌بود، ${parsedType3(issue2.input)} دریافت شد`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `ورودی نامعتبر: می‌بایست ${stringifyPrimitive(issue2.values[0])} می‌بود`;
        }
        return `گزینه نامعتبر: می‌بایست یکی از ${joinValues(issue2.values, "|")} می‌بود`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `خیلی بزرگ: ${issue2.origin ?? "مقدار"} باید ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عنصر"} باشد`;
        }
        return `خیلی بزرگ: ${issue2.origin ?? "مقدار"} باید ${adj}${issue2.maximum.toString()} باشد`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `خیلی کوچک: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} ${sizing.unit} باشد`;
        }
        return `خیلی کوچک: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} باشد`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `رشته نامعتبر: باید با "${_issue.prefix}" شروع شود`;
        }
        if (_issue.format === "ends_with") {
          return `رشته نامعتبر: باید با "${_issue.suffix}" تمام شود`;
        }
        if (_issue.format === "includes") {
          return `رشته نامعتبر: باید شامل "${_issue.includes}" باشد`;
        }
        if (_issue.format === "regex") {
          return `رشته نامعتبر: باید با الگوی ${_issue.pattern} مطابقت داشته باشد`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} نامعتبر`;
      }
      case "not_multiple_of":
        return `عدد نامعتبر: باید مضرب ${issue2.divisor} باشد`;
      case "unrecognized_keys":
        return `کلید${issue2.keys.length > 1 ? "های" : ""} ناشناس: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `کلید ناشناس در ${issue2.origin}`;
      case "invalid_union":
        return `ورودی نامعتبر`;
      case "invalid_element":
        return `مقدار نامعتبر در ${issue2.origin}`;
      default:
        return `ورودی نامعتبر`;
    }
  };
};
function fa_default() {
  return {
    localeError: error11()
  };
}
// node_modules/zod/v4/locales/fi.js
var error12 = () => {
  const Sizable = {
    string: { unit: "merkkiä", subject: "merkkijonon" },
    file: { unit: "tavua", subject: "tiedoston" },
    array: { unit: "alkiota", subject: "listan" },
    set: { unit: "alkiota", subject: "joukon" },
    number: { unit: "", subject: "luvun" },
    bigint: { unit: "", subject: "suuren kokonaisluvun" },
    int: { unit: "", subject: "kokonaisluvun" },
    date: { unit: "", subject: "päivämäärän" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "säännöllinen lauseke",
    email: "sähköpostiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-päivämäärä",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${issue2.expected}, oli ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Virheellinen syöte: täytyy olla ${stringifyPrimitive(issue2.values[0])}`;
        return `Virheellinen valinta: täytyy olla yksi seuraavista: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian suuri: ${sizing.subject} täytyy olla ${adj}${issue2.maximum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian suuri: arvon täytyy olla ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Liian pieni: ${sizing.subject} täytyy olla ${adj}${issue2.minimum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian pieni: arvon täytyy olla ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Virheellinen syöte: täytyy alkaa "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Virheellinen syöte: täytyy loppua "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Virheellinen syöte: täytyy sisältää "${_issue.includes}"`;
        if (_issue.format === "regex") {
          return `Virheellinen syöte: täytyy vastata säännöllistä lauseketta ${_issue.pattern}`;
        }
        return `Virheellinen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: täytyy olla luvun ${issue2.divisor} monikerta`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return `Virheellinen syöte`;
    }
  };
};
function fi_default() {
  return {
    localeError: error12()
  };
}
// node_modules/zod/v4/locales/fr.js
var error13 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombre";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tableau";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrée invalide : ${issue2.expected} attendu, ${parsedType3(issue2.input)} reçu`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrée invalide : ${stringifyPrimitive(issue2.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${joinValues(issue2.values, "|")} attendue`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : ${issue2.origin ?? "valeur"} doit ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "élément(s)"}`;
        return `Trop grand : ${issue2.origin ?? "valeur"} doit être ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : ${issue2.origin} doit ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : ${issue2.origin} doit être ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au modèle ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_default() {
  return {
    localeError: error13()
  };
}
// node_modules/zod/v4/locales/fr-CA.js
var error14 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Entrée invalide : attendu ${issue2.expected}, reçu ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrée invalide : attendu ${stringifyPrimitive(issue2.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "≤" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} ait ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `Trop grand : attendu que ${issue2.origin ?? "la valeur"} soit ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "≥" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Trop petit : attendu que ${issue2.origin} ait ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : attendu que ${issue2.origin} soit ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au motif ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue2.keys.length > 1 ? "s" : ""} non reconnue${issue2.keys.length > 1 ? "s" : ""} : ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue2.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue2.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_CA_default() {
  return {
    localeError: error14()
  };
}
// node_modules/zod/v4/locales/he.js
var error15 = () => {
  const Sizable = {
    string: { unit: "אותיות", verb: "לכלול" },
    file: { unit: "בייטים", verb: "לכלול" },
    array: { unit: "פריטים", verb: "לכלול" },
    set: { unit: "פריטים", verb: "לכלול" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "קלט",
    email: "כתובת אימייל",
    url: "כתובת רשת",
    emoji: "אימוג'י",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "תאריך וזמן ISO",
    date: "תאריך ISO",
    time: "זמן ISO",
    duration: "משך זמן ISO",
    ipv4: "כתובת IPv4",
    ipv6: "כתובת IPv6",
    cidrv4: "טווח IPv4",
    cidrv6: "טווח IPv6",
    base64: "מחרוזת בבסיס 64",
    base64url: "מחרוזת בבסיס 64 לכתובות רשת",
    json_string: "מחרוזת JSON",
    e164: "מספר E.164",
    jwt: "JWT",
    template_literal: "קלט"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `קלט לא תקין: צריך ${issue2.expected}, התקבל ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `קלט לא תקין: צריך ${stringifyPrimitive(issue2.values[0])}`;
        return `קלט לא תקין: צריך אחת מהאפשרויות  ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `גדול מדי: ${issue2.origin ?? "value"} צריך להיות ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `גדול מדי: ${issue2.origin ?? "value"} צריך להיות ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `קטן מדי: ${issue2.origin} צריך להיות ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `קטן מדי: ${issue2.origin} צריך להיות ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `מחרוזת לא תקינה: חייבת להתחיל ב"${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `מחרוזת לא תקינה: חייבת להסתיים ב "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `מחרוזת לא תקינה: חייבת לכלול "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `מחרוזת לא תקינה: חייבת להתאים לתבנית ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} לא תקין`;
      }
      case "not_multiple_of":
        return `מספר לא תקין: חייב להיות מכפלה של ${issue2.divisor}`;
      case "unrecognized_keys":
        return `מפתח${issue2.keys.length > 1 ? "ות" : ""} לא מזוה${issue2.keys.length > 1 ? "ים" : "ה"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `מפתח לא תקין ב${issue2.origin}`;
      case "invalid_union":
        return "קלט לא תקין";
      case "invalid_element":
        return `ערך לא תקין ב${issue2.origin}`;
      default:
        return `קלט לא תקין`;
    }
  };
};
function he_default() {
  return {
    localeError: error15()
  };
}
// node_modules/zod/v4/locales/hu.js
var error16 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "legyen" },
    file: { unit: "byte", verb: "legyen" },
    array: { unit: "elem", verb: "legyen" },
    set: { unit: "elem", verb: "legyen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "szám";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tömb";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "bemenet",
    email: "email cím",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO időbélyeg",
    date: "ISO dátum",
    time: "ISO idő",
    duration: "ISO időintervallum",
    ipv4: "IPv4 cím",
    ipv6: "IPv6 cím",
    cidrv4: "IPv4 tartomány",
    cidrv6: "IPv6 tartomány",
    base64: "base64-kódolt string",
    base64url: "base64url-kódolt string",
    json_string: "JSON string",
    e164: "E.164 szám",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Érvénytelen bemenet: a várt érték ${issue2.expected}, a kapott érték ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Érvénytelen bemenet: a várt érték ${stringifyPrimitive(issue2.values[0])}`;
        return `Érvénytelen opció: valamelyik érték várt ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Túl nagy: ${issue2.origin ?? "érték"} mérete túl nagy ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elem"}`;
        return `Túl nagy: a bemeneti érték ${issue2.origin ?? "érték"} túl nagy: ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Túl kicsi: a bemeneti érték ${issue2.origin} mérete túl kicsi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Túl kicsi: a bemeneti érték ${issue2.origin} túl kicsi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Érvénytelen string: "${_issue.prefix}" értékkel kell kezdődnie`;
        if (_issue.format === "ends_with")
          return `Érvénytelen string: "${_issue.suffix}" értékkel kell végződnie`;
        if (_issue.format === "includes")
          return `Érvénytelen string: "${_issue.includes}" értéket kell tartalmaznia`;
        if (_issue.format === "regex")
          return `Érvénytelen string: ${_issue.pattern} mintának kell megfelelnie`;
        return `Érvénytelen ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Érvénytelen szám: ${issue2.divisor} többszörösének kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Érvénytelen kulcs ${issue2.origin}`;
      case "invalid_union":
        return "Érvénytelen bemenet";
      case "invalid_element":
        return `Érvénytelen érték: ${issue2.origin}`;
      default:
        return `Érvénytelen bemenet`;
    }
  };
};
function hu_default() {
  return {
    localeError: error16()
  };
}
// node_modules/zod/v4/locales/id.js
var error17 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "memiliki" },
    file: { unit: "byte", verb: "memiliki" },
    array: { unit: "item", verb: "memiliki" },
    set: { unit: "item", verb: "memiliki" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType3 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${issue2.expected}, diterima ${parsedType3(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak valid: diharapkan ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} memiliki ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${issue2.origin ?? "value"} menjadi ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: diharapkan ${issue2.origin} memiliki ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: diharapkan ${issue2.origin} menjadi ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak valid: harus dimulai dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak valid: harus berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak valid: harus menyertakan "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak valid: harus sesuai pola ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${issue2.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function id_default() {
  return {
    localeError: error17()
  };
}
// node_modules/zod/v4/locales/is.js
var parsedType3 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "númer";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "fylki";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error18 = () => {
  const Sizable = {
    string: { unit: "stafi", verb: "að hafa" },
    file: { unit: "bæti", verb: "að hafa" },
    array: { unit: "hluti", verb: "að hafa" },
    set: { unit: "hluti", verb: "að hafa" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "gildi",
    email: "netfang",
    url: "vefslóð",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og tími",
    date: "ISO dagsetning",
    time: "ISO tími",
    duration: "ISO tímalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 tölugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Rangt gildi: Þú slóst inn ${parsedType3(issue2.input)} þar sem á að vera ${issue2.expected}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Rangt gildi: gert ráð fyrir ${stringifyPrimitive(issue2.values[0])}`;
        return `Ógilt val: má vera eitt af eftirfarandi ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Of stórt: gert er ráð fyrir að ${issue2.origin ?? "gildi"} hafi ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "hluti"}`;
        return `Of stórt: gert er ráð fyrir að ${issue2.origin ?? "gildi"} sé ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Of lítið: gert er ráð fyrir að ${issue2.origin} hafi ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Of lítið: gert er ráð fyrir að ${issue2.origin} sé ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ógildur strengur: verður að byrja á "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ógildur strengur: verður að enda á "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ógildur strengur: verður að innihalda "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ógildur strengur: verður að fylgja mynstri ${_issue.pattern}`;
        return `Rangt ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Röng tala: verður að vera margfeldi af ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Óþekkt ${issue2.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Rangur lykill í ${issue2.origin}`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return `Rangt gildi í ${issue2.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function is_default() {
  return {
    localeError: error18()
  };
}
// node_modules/zod/v4/locales/it.js
var error19 = () => {
  const Sizable = {
    string: { unit: "caratteri", verb: "avere" },
    file: { unit: "byte", verb: "avere" },
    array: { unit: "elementi", verb: "avere" },
    set: { unit: "elementi", verb: "avere" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType4 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "vettore";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input non valido: atteso ${issue2.expected}, ricevuto ${parsedType4(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input non valido: atteso ${stringifyPrimitive(issue2.values[0])}`;
        return `Opzione non valida: atteso uno tra ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Troppo grande: ${issue2.origin ?? "valore"} deve avere ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementi"}`;
        return `Troppo grande: ${issue2.origin ?? "valore"} deve essere ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Troppo piccolo: ${issue2.origin} deve avere ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Troppo piccolo: ${issue2.origin} deve essere ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Stringa non valida: deve iniziare con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Stringa non valida: deve terminare con "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Stringa non valida: deve includere "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Stringa non valida: deve corrispondere al pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chiav${issue2.keys.length > 1 ? "i" : "e"} non riconosciut${issue2.keys.length > 1 ? "e" : "a"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${issue2.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${issue2.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function it_default() {
  return {
    localeError: error19()
  };
}
// node_modules/zod/v4/locales/ja.js
var error20 = () => {
  const Sizable = {
    string: { unit: "文字", verb: "である" },
    file: { unit: "バイト", verb: "である" },
    array: { unit: "要素", verb: "である" },
    set: { unit: "要素", verb: "である" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType4 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "数値";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "配列";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "入力値",
    email: "メールアドレス",
    url: "URL",
    emoji: "絵文字",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日時",
    date: "ISO日付",
    time: "ISO時刻",
    duration: "ISO期間",
    ipv4: "IPv4アドレス",
    ipv6: "IPv6アドレス",
    cidrv4: "IPv4範囲",
    cidrv6: "IPv6範囲",
    base64: "base64エンコード文字列",
    base64url: "base64urlエンコード文字列",
    json_string: "JSON文字列",
    e164: "E.164番号",
    jwt: "JWT",
    template_literal: "入力値"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `無効な入力: ${issue2.expected}が期待されましたが、${parsedType4(issue2.input)}が入力されました`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `無効な入力: ${stringifyPrimitive(issue2.values[0])}が期待されました`;
        return `無効な選択: ${joinValues(issue2.values, "、")}のいずれかである必要があります`;
      case "too_big": {
        const adj = issue2.inclusive ? "以下である" : "より小さい";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `大きすぎる値: ${issue2.origin ?? "値"}は${issue2.maximum.toString()}${sizing.unit ?? "要素"}${adj}必要があります`;
        return `大きすぎる値: ${issue2.origin ?? "値"}は${issue2.maximum.toString()}${adj}必要があります`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "以上である" : "より大きい";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `小さすぎる値: ${issue2.origin}は${issue2.minimum.toString()}${sizing.unit}${adj}必要があります`;
        return `小さすぎる値: ${issue2.origin}は${issue2.minimum.toString()}${adj}必要があります`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `無効な文字列: "${_issue.prefix}"で始まる必要があります`;
        if (_issue.format === "ends_with")
          return `無効な文字列: "${_issue.suffix}"で終わる必要があります`;
        if (_issue.format === "includes")
          return `無効な文字列: "${_issue.includes}"を含む必要があります`;
        if (_issue.format === "regex")
          return `無効な文字列: パターン${_issue.pattern}に一致する必要があります`;
        return `無効な${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `無効な数値: ${issue2.divisor}の倍数である必要があります`;
      case "unrecognized_keys":
        return `認識されていないキー${issue2.keys.length > 1 ? "群" : ""}: ${joinValues(issue2.keys, "、")}`;
      case "invalid_key":
        return `${issue2.origin}内の無効なキー`;
      case "invalid_union":
        return "無効な入力";
      case "invalid_element":
        return `${issue2.origin}内の無効な値`;
      default:
        return `無効な入力`;
    }
  };
};
function ja_default() {
  return {
    localeError: error20()
  };
}
// node_modules/zod/v4/locales/ka.js
var parsedType4 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "რიცხვი";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "მასივი";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  const typeMap = {
    string: "სტრინგი",
    boolean: "ბულეანი",
    undefined: "undefined",
    bigint: "bigint",
    symbol: "symbol",
    function: "ფუნქცია"
  };
  return typeMap[t] ?? t;
};
var error21 = () => {
  const Sizable = {
    string: { unit: "სიმბოლო", verb: "უნდა შეიცავდეს" },
    file: { unit: "ბაიტი", verb: "უნდა შეიცავდეს" },
    array: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" },
    set: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "შეყვანა",
    email: "ელ-ფოსტის მისამართი",
    url: "URL",
    emoji: "ემოჯი",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "თარიღი-დრო",
    date: "თარიღი",
    time: "დრო",
    duration: "ხანგრძლივობა",
    ipv4: "IPv4 მისამართი",
    ipv6: "IPv6 მისამართი",
    cidrv4: "IPv4 დიაპაზონი",
    cidrv6: "IPv6 დიაპაზონი",
    base64: "base64-კოდირებული სტრინგი",
    base64url: "base64url-კოდირებული სტრინგი",
    json_string: "JSON სტრინგი",
    e164: "E.164 ნომერი",
    jwt: "JWT",
    template_literal: "შეყვანა"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `არასწორი შეყვანა: მოსალოდნელი ${issue2.expected}, მიღებული ${parsedType4(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `არასწორი შეყვანა: მოსალოდნელი ${stringifyPrimitive(issue2.values[0])}`;
        return `არასწორი ვარიანტი: მოსალოდნელია ერთ-ერთი ${joinValues(issue2.values, "|")}-დან`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `ზედმეტად დიდი: მოსალოდნელი ${issue2.origin ?? "მნიშვნელობა"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit}`;
        return `ზედმეტად დიდი: მოსალოდნელი ${issue2.origin ?? "მნიშვნელობა"} იყოს ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ზედმეტად პატარა: მოსალოდნელი ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `ზედმეტად პატარა: მოსალოდნელი ${issue2.origin} იყოს ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `არასწორი სტრინგი: უნდა იწყებოდეს "${_issue.prefix}"-ით`;
        }
        if (_issue.format === "ends_with")
          return `არასწორი სტრინგი: უნდა მთავრდებოდეს "${_issue.suffix}"-ით`;
        if (_issue.format === "includes")
          return `არასწორი სტრინგი: უნდა შეიცავდეს "${_issue.includes}"-ს`;
        if (_issue.format === "regex")
          return `არასწორი სტრინგი: უნდა შეესაბამებოდეს შაბლონს ${_issue.pattern}`;
        return `არასწორი ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `არასწორი რიცხვი: უნდა იყოს ${issue2.divisor}-ის ჯერადი`;
      case "unrecognized_keys":
        return `უცნობი გასაღებ${issue2.keys.length > 1 ? "ები" : "ი"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `არასწორი გასაღები ${issue2.origin}-ში`;
      case "invalid_union":
        return "არასწორი შეყვანა";
      case "invalid_element":
        return `არასწორი მნიშვნელობა ${issue2.origin}-ში`;
      default:
        return `არასწორი შეყვანა`;
    }
  };
};
function ka_default() {
  return {
    localeError: error21()
  };
}
// node_modules/zod/v4/locales/km.js
var error22 = () => {
  const Sizable = {
    string: { unit: "តួអក្សរ", verb: "គួរមាន" },
    file: { unit: "បៃ", verb: "គួរមាន" },
    array: { unit: "ធាតុ", verb: "គួរមាន" },
    set: { unit: "ធាតុ", verb: "គួរមាន" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType5 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "មិនមែនជាលេខ (NaN)" : "លេខ";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "អារេ (Array)";
        }
        if (data === null) {
          return "គ្មានតម្លៃ (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ទិន្នន័យបញ្ចូល",
    email: "អាសយដ្ឋានអ៊ីមែល",
    url: "URL",
    emoji: "សញ្ញាអារម្មណ៍",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "កាលបរិច្ឆេទ និងម៉ោង ISO",
    date: "កាលបរិច្ឆេទ ISO",
    time: "ម៉ោង ISO",
    duration: "រយៈពេល ISO",
    ipv4: "អាសយដ្ឋាន IPv4",
    ipv6: "អាសយដ្ឋាន IPv6",
    cidrv4: "ដែនអាសយដ្ឋាន IPv4",
    cidrv6: "ដែនអាសយដ្ឋាន IPv6",
    base64: "ខ្សែអក្សរអ៊ិកូដ base64",
    base64url: "ខ្សែអក្សរអ៊ិកូដ base64url",
    json_string: "ខ្សែអក្សរ JSON",
    e164: "លេខ E.164",
    jwt: "JWT",
    template_literal: "ទិន្នន័យបញ្ចូល"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${issue2.expected} ប៉ុន្តែទទួលបាន ${parsedType5(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${stringifyPrimitive(issue2.values[0])}`;
        return `ជម្រើសមិនត្រឹមត្រូវ៖ ត្រូវជាមួយក្នុងចំណោម ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `ធំពេក៖ ត្រូវការ ${issue2.origin ?? "តម្លៃ"} ${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "ធាតុ"}`;
        return `ធំពេក៖ ត្រូវការ ${issue2.origin ?? "តម្លៃ"} ${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `តូចពេក៖ ត្រូវការ ${issue2.origin} ${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `តូចពេក៖ ត្រូវការ ${issue2.origin} ${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវចាប់ផ្តើមដោយ "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវបញ្ចប់ដោយ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវមាន "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវតែផ្គូផ្គងនឹងទម្រង់ដែលបានកំណត់ ${_issue.pattern}`;
        return `មិនត្រឹមត្រូវ៖ ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `លេខមិនត្រឹមត្រូវ៖ ត្រូវតែជាពហុគុណនៃ ${issue2.divisor}`;
      case "unrecognized_keys":
        return `រកឃើញសោមិនស្គាល់៖ ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `សោមិនត្រឹមត្រូវនៅក្នុង ${issue2.origin}`;
      case "invalid_union":
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
      case "invalid_element":
        return `ទិន្នន័យមិនត្រឹមត្រូវនៅក្នុង ${issue2.origin}`;
      default:
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
    }
  };
};
function km_default() {
  return {
    localeError: error22()
  };
}

// node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}
// node_modules/zod/v4/locales/ko.js
var error23 = () => {
  const Sizable = {
    string: { unit: "문자", verb: "to have" },
    file: { unit: "바이트", verb: "to have" },
    array: { unit: "개", verb: "to have" },
    set: { unit: "개", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType5 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "입력",
    email: "이메일 주소",
    url: "URL",
    emoji: "이모지",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 날짜시간",
    date: "ISO 날짜",
    time: "ISO 시간",
    duration: "ISO 기간",
    ipv4: "IPv4 주소",
    ipv6: "IPv6 주소",
    cidrv4: "IPv4 범위",
    cidrv6: "IPv6 범위",
    base64: "base64 인코딩 문자열",
    base64url: "base64url 인코딩 문자열",
    json_string: "JSON 문자열",
    e164: "E.164 번호",
    jwt: "JWT",
    template_literal: "입력"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `잘못된 입력: 예상 타입은 ${issue2.expected}, 받은 타입은 ${parsedType5(issue2.input)}입니다`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `잘못된 입력: 값은 ${stringifyPrimitive(issue2.values[0])} 이어야 합니다`;
        return `잘못된 옵션: ${joinValues(issue2.values, "또는 ")} 중 하나여야 합니다`;
      case "too_big": {
        const adj = issue2.inclusive ? "이하" : "미만";
        const suffix = adj === "미만" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing)
          return `${issue2.origin ?? "값"}이 너무 큽니다: ${issue2.maximum.toString()}${unit} ${adj}${suffix}`;
        return `${issue2.origin ?? "값"}이 너무 큽니다: ${issue2.maximum.toString()} ${adj}${suffix}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "이상" : "초과";
        const suffix = adj === "이상" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue2.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing) {
          return `${issue2.origin ?? "값"}이 너무 작습니다: ${issue2.minimum.toString()}${unit} ${adj}${suffix}`;
        }
        return `${issue2.origin ?? "값"}이 너무 작습니다: ${issue2.minimum.toString()} ${adj}${suffix}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `잘못된 문자열: "${_issue.prefix}"(으)로 시작해야 합니다`;
        }
        if (_issue.format === "ends_with")
          return `잘못된 문자열: "${_issue.suffix}"(으)로 끝나야 합니다`;
        if (_issue.format === "includes")
          return `잘못된 문자열: "${_issue.includes}"을(를) 포함해야 합니다`;
        if (_issue.format === "regex")
          return `잘못된 문자열: 정규식 ${_issue.pattern} 패턴과 일치해야 합니다`;
        return `잘못된 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `잘못된 숫자: ${issue2.divisor}의 배수여야 합니다`;
      case "unrecognized_keys":
        return `인식할 수 없는 키: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `잘못된 키: ${issue2.origin}`;
      case "invalid_union":
        return `잘못된 입력`;
      case "invalid_element":
        return `잘못된 값: ${issue2.origin}`;
      default:
        return `잘못된 입력`;
    }
  };
};
function ko_default() {
  return {
    localeError: error23()
  };
}
// node_modules/zod/v4/locales/lt.js
var parsedType5 = (data) => {
  const t = typeof data;
  return parsedTypeFromType(t, data);
};
var parsedTypeFromType = (t, data = undefined) => {
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "skaičius";
    }
    case "bigint": {
      return "sveikasis skaičius";
    }
    case "string": {
      return "eilutė";
    }
    case "boolean": {
      return "loginė reikšmė";
    }
    case "undefined":
    case "void": {
      return "neapibrėžta reikšmė";
    }
    case "function": {
      return "funkcija";
    }
    case "symbol": {
      return "simbolis";
    }
    case "object": {
      if (data === undefined)
        return "nežinomas objektas";
      if (data === null)
        return "nulinė reikšmė";
      if (Array.isArray(data))
        return "masyvas";
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
      return "objektas";
    }
    case "null": {
      return "nulinė reikšmė";
    }
  }
  return t;
};
var capitalizeFirstCharacter = (text) => {
  return text.charAt(0).toUpperCase() + text.slice(1);
};
function getUnitTypeFromNumber(number2) {
  const abs = Math.abs(number2);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0)
    return "many";
  if (last === 1)
    return "one";
  return "few";
}
var error24 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simbolių"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne ilgesnė kaip",
          notInclusive: "turi būti trumpesnė kaip"
        },
        bigger: {
          inclusive: "turi būti ne trumpesnė kaip",
          notInclusive: "turi būti ilgesnė kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "baitų"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne didesnis kaip",
          notInclusive: "turi būti mažesnis kaip"
        },
        bigger: {
          inclusive: "turi būti ne mažesnis kaip",
          notInclusive: "turi būti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null)
      return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  const Nouns = {
    regex: "įvestis",
    email: "el. pašto adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukmė",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 užkoduota eilutė",
    base64url: "base64url užkoduota eilutė",
    json_string: "JSON eilutė",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "įvestis"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Gautas tipas ${parsedType5(issue2.input)}, o tikėtasi - ${parsedTypeFromType(issue2.expected)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Privalo būti ${stringifyPrimitive(issue2.values[0])}`;
        return `Privalo būti vienas iš ${joinValues(issue2.values, "|")} pasirinkimų`;
      case "too_big": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.maximum)), issue2.inclusive ?? false, "smaller");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} ${sizing.verb} ${issue2.maximum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue2.inclusive ? "ne didesnis kaip" : "mažesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi būti ${adj} ${issue2.maximum.toString()} ${sizing?.unit}`;
      }
      case "too_small": {
        const origin = parsedTypeFromType(issue2.origin);
        const sizing = getSizing(issue2.origin, getUnitTypeFromNumber(Number(issue2.minimum)), issue2.inclusive ?? false, "bigger");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} ${sizing.verb} ${issue2.minimum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue2.inclusive ? "ne mažesnis kaip" : "didesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi būti ${adj} ${issue2.minimum.toString()} ${sizing?.unit}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Eilutė privalo prasidėti "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Eilutė privalo pasibaigti "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Eilutė privalo įtraukti "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Eilutė privalo atitikti ${_issue.pattern}`;
        return `Neteisingas ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Skaičius privalo būti ${issue2.divisor} kartotinis.`;
      case "unrecognized_keys":
        return `Neatpažint${issue2.keys.length > 1 ? "i" : "as"} rakt${issue2.keys.length > 1 ? "ai" : "as"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga įvestis";
      case "invalid_element": {
        const origin = parsedTypeFromType(issue2.origin);
        return `${capitalizeFirstCharacter(origin ?? issue2.origin ?? "reikšmė")} turi klaidingą įvestį`;
      }
      default:
        return "Klaidinga įvestis";
    }
  };
};
function lt_default() {
  return {
    localeError: error24()
  };
}
// node_modules/zod/v4/locales/mk.js
var error25 = () => {
  const Sizable = {
    string: { unit: "знаци", verb: "да имаат" },
    file: { unit: "бајти", verb: "да имаат" },
    array: { unit: "ставки", verb: "да имаат" },
    set: { unit: "ставки", verb: "да имаат" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "број";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "низа";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "внес",
    email: "адреса на е-пошта",
    url: "URL",
    emoji: "емоџи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO датум и време",
    date: "ISO датум",
    time: "ISO време",
    duration: "ISO времетраење",
    ipv4: "IPv4 адреса",
    ipv6: "IPv6 адреса",
    cidrv4: "IPv4 опсег",
    cidrv6: "IPv6 опсег",
    base64: "base64-енкодирана низа",
    base64url: "base64url-енкодирана низа",
    json_string: "JSON низа",
    e164: "E.164 број",
    jwt: "JWT",
    template_literal: "внес"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Грешен внес: се очекува ${issue2.expected}, примено ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue2.values[0])}`;
        return `Грешана опција: се очекува една ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Премногу голем: се очекува ${issue2.origin ?? "вредноста"} да има ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "елементи"}`;
        return `Премногу голем: се очекува ${issue2.origin ?? "вредноста"} да биде ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Премногу мал: се очекува ${issue2.origin} да има ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Премногу мал: се очекува ${issue2.origin} да биде ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Неважечка низа: мора да започнува со "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Неважечка низа: мора да завршува со "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неважечка низа: мора да вклучува "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неважечка низа: мора да одгоара на патернот ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Грешен број: мора да биде делив со ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Непрепознаени клучеви" : "Непрепознаен клуч"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Грешен клуч во ${issue2.origin}`;
      case "invalid_union":
        return "Грешен внес";
      case "invalid_element":
        return `Грешна вредност во ${issue2.origin}`;
      default:
        return `Грешен внес`;
    }
  };
};
function mk_default() {
  return {
    localeError: error25()
  };
}
// node_modules/zod/v4/locales/ms.js
var error26 = () => {
  const Sizable = {
    string: { unit: "aksara", verb: "mempunyai" },
    file: { unit: "bait", verb: "mempunyai" },
    array: { unit: "elemen", verb: "mempunyai" },
    set: { unit: "elemen", verb: "mempunyai" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombor";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${issue2.expected}, diterima ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Input tidak sah: dijangka ${stringifyPrimitive(issue2.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${issue2.origin ?? "nilai"} adalah ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Terlalu kecil: dijangka ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: dijangka ${issue2.origin} adalah ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `String tidak sah: mesti bermula dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak sah: mesti berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak sah: mesti mengandungi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak sah: mesti sepadan dengan corak ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${issue2.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${issue2.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function ms_default() {
  return {
    localeError: error26()
  };
}
// node_modules/zod/v4/locales/nl.js
var error27 = () => {
  const Sizable = {
    string: { unit: "tekens" },
    file: { unit: "bytes" },
    array: { unit: "elementen" },
    set: { unit: "elementen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "getal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${issue2.expected}, ontving ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ongeldige invoer: verwacht ${stringifyPrimitive(issue2.values[0])}`;
        return `Ongeldige optie: verwacht één van ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${issue2.origin ?? "waarde"} ${adj}${issue2.maximum.toString()} is`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} bevat`;
        }
        return `Te kort: verwacht dat ${issue2.origin} ${adj}${issue2.minimum.toString()} is`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ongeldige tekst: moet met "${_issue.prefix}" beginnen`;
        }
        if (_issue.format === "ends_with")
          return `Ongeldige tekst: moet op "${_issue.suffix}" eindigen`;
        if (_issue.format === "includes")
          return `Ongeldige tekst: moet "${_issue.includes}" bevatten`;
        if (_issue.format === "regex")
          return `Ongeldige tekst: moet overeenkomen met patroon ${_issue.pattern}`;
        return `Ongeldig: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${issue2.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${issue2.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${issue2.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function nl_default() {
  return {
    localeError: error27()
  };
}
// node_modules/zod/v4/locales/no.js
var error28 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "å ha" },
    file: { unit: "bytes", verb: "å ha" },
    array: { unit: "elementer", verb: "å inneholde" },
    set: { unit: "elementer", verb: "å inneholde" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tall";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${issue2.expected}, fikk ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ugyldig verdi: forventet ${stringifyPrimitive(issue2.values[0])}`;
        return `Ugyldig valg: forventet en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `For stor(t): forventet ${issue2.origin ?? "value"} til å ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor(t): forventet ${issue2.origin ?? "value"} til å ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `For lite(n): forventet ${issue2.origin} til å ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `For lite(n): forventet ${issue2.origin} til å ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: må starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: må ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: må inneholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: må matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: må være et multiplum av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Ukjente nøkler" : "Ukjent nøkkel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøkkel i ${issue2.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${issue2.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function no_default() {
  return {
    localeError: error28()
  };
}
// node_modules/zod/v4/locales/ota.js
var error29 = () => {
  const Sizable = {
    string: { unit: "harf", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "unsur", verb: "olmalıdır" },
    set: { unit: "unsur", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numara";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "saf";
        }
        if (data === null) {
          return "gayb";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "giren",
    email: "epostagâh",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO hengâmı",
    date: "ISO tarihi",
    time: "ISO zamanı",
    duration: "ISO müddeti",
    ipv4: "IPv4 nişânı",
    ipv6: "IPv6 nişânı",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-şifreli metin",
    base64url: "base64url-şifreli metin",
    json_string: "JSON metin",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "giren"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Fâsit giren: umulan ${issue2.expected}, alınan ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Fâsit giren: umulan ${stringifyPrimitive(issue2.values[0])}`;
        return `Fâsit tercih: mûteberler ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Fazla büyük: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elements"} sahip olmalıydı.`;
        return `Fazla büyük: ${issue2.origin ?? "value"}, ${adj}${issue2.maximum.toString()} olmalıydı.`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Fazla küçük: ${issue2.origin}, ${adj}${issue2.minimum.toString()} ${sizing.unit} sahip olmalıydı.`;
        }
        return `Fazla küçük: ${issue2.origin}, ${adj}${issue2.minimum.toString()} olmalıydı.`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Fâsit metin: "${_issue.prefix}" ile başlamalı.`;
        if (_issue.format === "ends_with")
          return `Fâsit metin: "${_issue.suffix}" ile bitmeli.`;
        if (_issue.format === "includes")
          return `Fâsit metin: "${_issue.includes}" ihtivâ etmeli.`;
        if (_issue.format === "regex")
          return `Fâsit metin: ${_issue.pattern} nakşına uymalı.`;
        return `Fâsit ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Fâsit sayı: ${issue2.divisor} katı olmalıydı.`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar ${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} için tanınmayan anahtar var.`;
      case "invalid_union":
        return "Giren tanınamadı.";
      case "invalid_element":
        return `${issue2.origin} için tanınmayan kıymet var.`;
      default:
        return `Kıymet tanınamadı.`;
    }
  };
};
function ota_default() {
  return {
    localeError: error29()
  };
}
// node_modules/zod/v4/locales/ps.js
var error30 = () => {
  const Sizable = {
    string: { unit: "توکي", verb: "ولري" },
    file: { unit: "بایټس", verb: "ولري" },
    array: { unit: "توکي", verb: "ولري" },
    set: { unit: "توکي", verb: "ولري" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "ارې";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودي",
    email: "بریښنالیک",
    url: "یو آر ال",
    emoji: "ایموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "نیټه او وخت",
    date: "نېټه",
    time: "وخت",
    duration: "موده",
    ipv4: "د IPv4 پته",
    ipv6: "د IPv6 پته",
    cidrv4: "د IPv4 ساحه",
    cidrv6: "د IPv6 ساحه",
    base64: "base64-encoded متن",
    base64url: "base64url-encoded متن",
    json_string: "JSON متن",
    e164: "د E.164 شمېره",
    jwt: "JWT",
    template_literal: "ورودي"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ناسم ورودي: باید ${issue2.expected} وای, مګر ${parsedType6(issue2.input)} ترلاسه شو`;
      case "invalid_value":
        if (issue2.values.length === 1) {
          return `ناسم ورودي: باید ${stringifyPrimitive(issue2.values[0])} وای`;
        }
        return `ناسم انتخاب: باید یو له ${joinValues(issue2.values, "|")} څخه وای`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ډیر لوی: ${issue2.origin ?? "ارزښت"} باید ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عنصرونه"} ولري`;
        }
        return `ډیر لوی: ${issue2.origin ?? "ارزښت"} باید ${adj}${issue2.maximum.toString()} وي`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `ډیر کوچنی: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} ${sizing.unit} ولري`;
        }
        return `ډیر کوچنی: ${issue2.origin} باید ${adj}${issue2.minimum.toString()} وي`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `ناسم متن: باید د "${_issue.prefix}" سره پیل شي`;
        }
        if (_issue.format === "ends_with") {
          return `ناسم متن: باید د "${_issue.suffix}" سره پای ته ورسيږي`;
        }
        if (_issue.format === "includes") {
          return `ناسم متن: باید "${_issue.includes}" ولري`;
        }
        if (_issue.format === "regex") {
          return `ناسم متن: باید د ${_issue.pattern} سره مطابقت ولري`;
        }
        return `${Nouns[_issue.format] ?? issue2.format} ناسم دی`;
      }
      case "not_multiple_of":
        return `ناسم عدد: باید د ${issue2.divisor} مضرب وي`;
      case "unrecognized_keys":
        return `ناسم ${issue2.keys.length > 1 ? "کلیډونه" : "کلیډ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `ناسم کلیډ په ${issue2.origin} کې`;
      case "invalid_union":
        return `ناسمه ورودي`;
      case "invalid_element":
        return `ناسم عنصر په ${issue2.origin} کې`;
      default:
        return `ناسمه ورودي`;
    }
  };
};
function ps_default() {
  return {
    localeError: error30()
  };
}
// node_modules/zod/v4/locales/pl.js
var error31 = () => {
  const Sizable = {
    string: { unit: "znaków", verb: "mieć" },
    file: { unit: "bajtów", verb: "mieć" },
    array: { unit: "elementów", verb: "mieć" },
    set: { unit: "elementów", verb: "mieć" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "liczba";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tablica";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "wyrażenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ciąg znaków zakodowany w formacie base64",
    base64url: "ciąg znaków zakodowany w formacie base64url",
    json_string: "ciąg znaków w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wejście"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Nieprawidłowe dane wejściowe: oczekiwano ${issue2.expected}, otrzymano ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Nieprawidłowe dane wejściowe: oczekiwano ${stringifyPrimitive(issue2.values[0])}`;
        return `Nieprawidłowa opcja: oczekiwano jednej z wartości ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za duża wartość: oczekiwano, że ${issue2.origin ?? "wartość"} będzie mieć ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt duż(y/a/e): oczekiwano, że ${issue2.origin ?? "wartość"} będzie wynosić ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Za mała wartość: oczekiwano, że ${issue2.origin ?? "wartość"} będzie mieć ${adj}${issue2.minimum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt mał(y/a/e): oczekiwano, że ${issue2.origin ?? "wartość"} będzie wynosić ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Nieprawidłowy ciąg znaków: musi zaczynać się od "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nieprawidłowy ciąg znaków: musi kończyć się na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nieprawidłowy ciąg znaków: musi zawierać "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nieprawidłowy ciąg znaków: musi odpowiadać wzorcowi ${_issue.pattern}`;
        return `Nieprawidłow(y/a/e) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nieprawidłowa liczba: musi być wielokrotnością ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawidłowy klucz w ${issue2.origin}`;
      case "invalid_union":
        return "Nieprawidłowe dane wejściowe";
      case "invalid_element":
        return `Nieprawidłowa wartość w ${issue2.origin}`;
      default:
        return `Nieprawidłowe dane wejściowe`;
    }
  };
};
function pl_default() {
  return {
    localeError: error31()
  };
}
// node_modules/zod/v4/locales/pt.js
var error32 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "ter" },
    file: { unit: "bytes", verb: "ter" },
    array: { unit: "itens", verb: "ter" },
    set: { unit: "itens", verb: "ter" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "número";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "nulo";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "padrão",
    email: "endereço de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "duração ISO",
    ipv4: "endereço IPv4",
    ipv6: "endereço IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Tipo inválido: esperado ${issue2.expected}, recebido ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Entrada inválida: esperado ${stringifyPrimitive(issue2.values[0])}`;
        return `Opção inválida: esperada uma das ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Muito grande: esperado que ${issue2.origin ?? "valor"} tivesse ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${issue2.origin ?? "valor"} fosse ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Muito pequeno: esperado que ${issue2.origin} tivesse ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Muito pequeno: esperado que ${issue2.origin} fosse ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Texto inválido: deve começar com "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Texto inválido: deve terminar com "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Texto inválido: deve incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Texto inválido: deve corresponder ao padrão ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} inválido`;
      }
      case "not_multiple_of":
        return `Número inválido: deve ser múltiplo de ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Chave${issue2.keys.length > 1 ? "s" : ""} desconhecida${issue2.keys.length > 1 ? "s" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Chave inválida em ${issue2.origin}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido em ${issue2.origin}`;
      default:
        return `Campo inválido`;
    }
  };
};
function pt_default() {
  return {
    localeError: error32()
  };
}
// node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error33 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "символ",
        few: "символа",
        many: "символов"
      },
      verb: "иметь"
    },
    file: {
      unit: {
        one: "байт",
        few: "байта",
        many: "байт"
      },
      verb: "иметь"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "массив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ввод",
    email: "email адрес",
    url: "URL",
    emoji: "эмодзи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата и время",
    date: "ISO дата",
    time: "ISO время",
    duration: "ISO длительность",
    ipv4: "IPv4 адрес",
    ipv6: "IPv6 адрес",
    cidrv4: "IPv4 диапазон",
    cidrv6: "IPv6 диапазон",
    base64: "строка в формате base64",
    base64url: "строка в формате base64url",
    json_string: "JSON строка",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "ввод"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Неверный ввод: ожидалось ${issue2.expected}, получено ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Неверный ввод: ожидалось ${stringifyPrimitive(issue2.values[0])}`;
        return `Неверный вариант: ожидалось одно из ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const maxValue = Number(issue2.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком большое значение: ожидалось, что ${issue2.origin ?? "значение"} будет иметь ${adj}${issue2.maximum.toString()} ${unit}`;
        }
        return `Слишком большое значение: ожидалось, что ${issue2.origin ?? "значение"} будет ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          const minValue = Number(issue2.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком маленькое значение: ожидалось, что ${issue2.origin} будет иметь ${adj}${issue2.minimum.toString()} ${unit}`;
        }
        return `Слишком маленькое значение: ожидалось, что ${issue2.origin} будет ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Неверная строка: должна начинаться с "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неверная строка: должна заканчиваться на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неверная строка: должна содержать "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неверная строка: должна соответствовать шаблону ${_issue.pattern}`;
        return `Неверный ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Неверное число: должно быть кратным ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нераспознанн${issue2.keys.length > 1 ? "ые" : "ый"} ключ${issue2.keys.length > 1 ? "и" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Неверный ключ в ${issue2.origin}`;
      case "invalid_union":
        return "Неверные входные данные";
      case "invalid_element":
        return `Неверное значение в ${issue2.origin}`;
      default:
        return `Неверные входные данные`;
    }
  };
};
function ru_default() {
  return {
    localeError: error33()
  };
}
// node_modules/zod/v4/locales/sl.js
var error34 = () => {
  const Sizable = {
    string: { unit: "znakov", verb: "imeti" },
    file: { unit: "bajtov", verb: "imeti" },
    array: { unit: "elementov", verb: "imeti" },
    set: { unit: "elementov", verb: "imeti" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "število";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tabela";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "vnos",
    email: "e-poštni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in čas",
    date: "ISO datum",
    time: "ISO čas",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 številka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Neveljaven vnos: pričakovano ${issue2.expected}, prejeto ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Neveljaven vnos: pričakovano ${stringifyPrimitive(issue2.values[0])}`;
        return `Neveljavna možnost: pričakovano eno izmed ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Preveliko: pričakovano, da bo ${issue2.origin ?? "vrednost"} imelo ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "elementov"}`;
        return `Preveliko: pričakovano, da bo ${issue2.origin ?? "vrednost"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Premajhno: pričakovano, da bo ${issue2.origin} imelo ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Premajhno: pričakovano, da bo ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Neveljaven niz: mora se začeti z "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Neveljaven niz: mora se končati z "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neveljaven niz: mora vsebovati "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neveljaven niz: mora ustrezati vzorcu ${_issue.pattern}`;
        return `Neveljaven ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno število: mora biti večkratnik ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${issue2.keys.length > 1 ? "i ključi" : " ključ"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven ključ v ${issue2.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${issue2.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function sl_default() {
  return {
    localeError: error34()
  };
}
// node_modules/zod/v4/locales/sv.js
var error35 = () => {
  const Sizable = {
    string: { unit: "tecken", verb: "att ha" },
    file: { unit: "bytes", verb: "att ha" },
    array: { unit: "objekt", verb: "att innehålla" },
    set: { unit: "objekt", verb: "att innehålla" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "antal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "lista";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "reguljärt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad sträng",
    base64url: "base64url-kodad sträng",
    json_string: "JSON-sträng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ogiltig inmatning: förväntat ${issue2.expected}, fick ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ogiltig inmatning: förväntat ${stringifyPrimitive(issue2.values[0])}`;
        return `Ogiltigt val: förväntade en av ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `För stor(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "element"}`;
        }
        return `För stor(t): förväntat ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `För lite(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `För lite(t): förväntade ${issue2.origin ?? "värdet"} att ha ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `Ogiltig sträng: måste börja med "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ogiltig sträng: måste sluta med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ogiltig sträng: måste innehålla "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ogiltig sträng: måste matcha mönstret "${_issue.pattern}"`;
        return `Ogiltig(t) ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: måste vara en multipel av ${issue2.divisor}`;
      case "unrecognized_keys":
        return `${issue2.keys.length > 1 ? "Okända nycklar" : "Okänd nyckel"}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${issue2.origin ?? "värdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt värde i ${issue2.origin ?? "värdet"}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function sv_default() {
  return {
    localeError: error35()
  };
}
// node_modules/zod/v4/locales/ta.js
var error36 = () => {
  const Sizable = {
    string: { unit: "எழுத்துக்கள்", verb: "கொண்டிருக்க வேண்டும்" },
    file: { unit: "பைட்டுகள்", verb: "கொண்டிருக்க வேண்டும்" },
    array: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" },
    set: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "எண் அல்லாதது" : "எண்";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "அணி";
        }
        if (data === null) {
          return "வெறுமை";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "உள்ளீடு",
    email: "மின்னஞ்சல் முகவரி",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO தேதி நேரம்",
    date: "ISO தேதி",
    time: "ISO நேரம்",
    duration: "ISO கால அளவு",
    ipv4: "IPv4 முகவரி",
    ipv6: "IPv6 முகவரி",
    cidrv4: "IPv4 வரம்பு",
    cidrv6: "IPv6 வரம்பு",
    base64: "base64-encoded சரம்",
    base64url: "base64url-encoded சரம்",
    json_string: "JSON சரம்",
    e164: "E.164 எண்",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${issue2.expected}, பெறப்பட்டது ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${stringifyPrimitive(issue2.values[0])}`;
        return `தவறான விருப்பம்: எதிர்பார்க்கப்பட்டது ${joinValues(issue2.values, "|")} இல் ஒன்று`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue2.origin ?? "மதிப்பு"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "உறுப்புகள்"} ஆக இருக்க வேண்டும்`;
        }
        return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue2.origin ?? "மதிப்பு"} ${adj}${issue2.maximum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit} ஆக இருக்க வேண்டும்`;
        }
        return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue2.origin} ${adj}${issue2.minimum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `தவறான சரம்: "${_issue.prefix}" இல் தொடங்க வேண்டும்`;
        if (_issue.format === "ends_with")
          return `தவறான சரம்: "${_issue.suffix}" இல் முடிவடைய வேண்டும்`;
        if (_issue.format === "includes")
          return `தவறான சரம்: "${_issue.includes}" ஐ உள்ளடக்க வேண்டும்`;
        if (_issue.format === "regex")
          return `தவறான சரம்: ${_issue.pattern} முறைபாட்டுடன் பொருந்த வேண்டும்`;
        return `தவறான ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `தவறான எண்: ${issue2.divisor} இன் பலமாக இருக்க வேண்டும்`;
      case "unrecognized_keys":
        return `அடையாளம் தெரியாத விசை${issue2.keys.length > 1 ? "கள்" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} இல் தவறான விசை`;
      case "invalid_union":
        return "தவறான உள்ளீடு";
      case "invalid_element":
        return `${issue2.origin} இல் தவறான மதிப்பு`;
      default:
        return `தவறான உள்ளீடு`;
    }
  };
};
function ta_default() {
  return {
    localeError: error36()
  };
}
// node_modules/zod/v4/locales/th.js
var error37 = () => {
  const Sizable = {
    string: { unit: "ตัวอักษร", verb: "ควรมี" },
    file: { unit: "ไบต์", verb: "ควรมี" },
    array: { unit: "รายการ", verb: "ควรมี" },
    set: { unit: "รายการ", verb: "ควรมี" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType6 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "ไม่ใช่ตัวเลข (NaN)" : "ตัวเลข";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "อาร์เรย์ (Array)";
        }
        if (data === null) {
          return "ไม่มีค่า (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ข้อมูลที่ป้อน",
    email: "ที่อยู่อีเมล",
    url: "URL",
    emoji: "อิโมจิ",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "วันที่เวลาแบบ ISO",
    date: "วันที่แบบ ISO",
    time: "เวลาแบบ ISO",
    duration: "ช่วงเวลาแบบ ISO",
    ipv4: "ที่อยู่ IPv4",
    ipv6: "ที่อยู่ IPv6",
    cidrv4: "ช่วง IP แบบ IPv4",
    cidrv6: "ช่วง IP แบบ IPv6",
    base64: "ข้อความแบบ Base64",
    base64url: "ข้อความแบบ Base64 สำหรับ URL",
    json_string: "ข้อความแบบ JSON",
    e164: "เบอร์โทรศัพท์ระหว่างประเทศ (E.164)",
    jwt: "โทเคน JWT",
    template_literal: "ข้อมูลที่ป้อน"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น ${issue2.expected} แต่ได้รับ ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `ค่าไม่ถูกต้อง: ควรเป็น ${stringifyPrimitive(issue2.values[0])}`;
        return `ตัวเลือกไม่ถูกต้อง: ควรเป็นหนึ่งใน ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "ไม่เกิน" : "น้อยกว่า";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `เกินกำหนด: ${issue2.origin ?? "ค่า"} ควรมี${adj} ${issue2.maximum.toString()} ${sizing.unit ?? "รายการ"}`;
        return `เกินกำหนด: ${issue2.origin ?? "ค่า"} ควรมี${adj} ${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? "อย่างน้อย" : "มากกว่า";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `น้อยกว่ากำหนด: ${issue2.origin} ควรมี${adj} ${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `น้อยกว่ากำหนด: ${issue2.origin} ควรมี${adj} ${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องขึ้นต้นด้วย "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องลงท้ายด้วย "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องมี "${_issue.includes}" อยู่ในข้อความ`;
        if (_issue.format === "regex")
          return `รูปแบบไม่ถูกต้อง: ต้องตรงกับรูปแบบที่กำหนด ${_issue.pattern}`;
        return `รูปแบบไม่ถูกต้อง: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `ตัวเลขไม่ถูกต้อง: ต้องเป็นจำนวนที่หารด้วย ${issue2.divisor} ได้ลงตัว`;
      case "unrecognized_keys":
        return `พบคีย์ที่ไม่รู้จัก: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `คีย์ไม่ถูกต้องใน ${issue2.origin}`;
      case "invalid_union":
        return "ข้อมูลไม่ถูกต้อง: ไม่ตรงกับรูปแบบยูเนียนที่กำหนดไว้";
      case "invalid_element":
        return `ข้อมูลไม่ถูกต้องใน ${issue2.origin}`;
      default:
        return `ข้อมูลไม่ถูกต้อง`;
    }
  };
};
function th_default() {
  return {
    localeError: error37()
  };
}
// node_modules/zod/v4/locales/tr.js
var parsedType6 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error38 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "olmalı" },
    file: { unit: "bayt", verb: "olmalı" },
    array: { unit: "öğe", verb: "olmalı" },
    set: { unit: "öğe", verb: "olmalı" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO süre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aralığı",
    cidrv6: "IPv6 aralığı",
    base64: "base64 ile şifrelenmiş metin",
    base64url: "base64url ile şifrelenmiş metin",
    json_string: "JSON dizesi",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "Şablon dizesi"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Geçersiz değer: beklenen ${issue2.expected}, alınan ${parsedType6(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Geçersiz değer: beklenen ${stringifyPrimitive(issue2.values[0])}`;
        return `Geçersiz seçenek: aşağıdakilerden biri olmalı: ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çok büyük: beklenen ${issue2.origin ?? "değer"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "öğe"}`;
        return `Çok büyük: beklenen ${issue2.origin ?? "değer"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Çok küçük: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        return `Çok küçük: beklenen ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Geçersiz metin: "${_issue.prefix}" ile başlamalı`;
        if (_issue.format === "ends_with")
          return `Geçersiz metin: "${_issue.suffix}" ile bitmeli`;
        if (_issue.format === "includes")
          return `Geçersiz metin: "${_issue.includes}" içermeli`;
        if (_issue.format === "regex")
          return `Geçersiz metin: ${_issue.pattern} desenine uymalı`;
        return `Geçersiz ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Geçersiz sayı: ${issue2.divisor} ile tam bölünebilmeli`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar${issue2.keys.length > 1 ? "lar" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} içinde geçersiz anahtar`;
      case "invalid_union":
        return "Geçersiz değer";
      case "invalid_element":
        return `${issue2.origin} içinde geçersiz değer`;
      default:
        return `Geçersiz değer`;
    }
  };
};
function tr_default() {
  return {
    localeError: error38()
  };
}
// node_modules/zod/v4/locales/uk.js
var error39 = () => {
  const Sizable = {
    string: { unit: "символів", verb: "матиме" },
    file: { unit: "байтів", verb: "матиме" },
    array: { unit: "елементів", verb: "матиме" },
    set: { unit: "елементів", verb: "матиме" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "вхідні дані",
    email: "адреса електронної пошти",
    url: "URL",
    emoji: "емодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "дата та час ISO",
    date: "дата ISO",
    time: "час ISO",
    duration: "тривалість ISO",
    ipv4: "адреса IPv4",
    ipv6: "адреса IPv6",
    cidrv4: "діапазон IPv4",
    cidrv6: "діапазон IPv6",
    base64: "рядок у кодуванні base64",
    base64url: "рядок у кодуванні base64url",
    json_string: "рядок JSON",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "вхідні дані"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Неправильні вхідні дані: очікується ${issue2.expected}, отримано ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Неправильні вхідні дані: очікується ${stringifyPrimitive(issue2.values[0])}`;
        return `Неправильна опція: очікується одне з ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Занадто велике: очікується, що ${issue2.origin ?? "значення"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "елементів"}`;
        return `Занадто велике: очікується, що ${issue2.origin ?? "значення"} буде ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Занадто мале: очікується, що ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Занадто мале: очікується, що ${issue2.origin} буде ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Неправильний рядок: повинен починатися з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неправильний рядок: повинен закінчуватися на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неправильний рядок: повинен містити "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неправильний рядок: повинен відповідати шаблону ${_issue.pattern}`;
        return `Неправильний ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Неправильне число: повинно бути кратним ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Нерозпізнаний ключ${issue2.keys.length > 1 ? "і" : ""}: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Неправильний ключ у ${issue2.origin}`;
      case "invalid_union":
        return "Неправильні вхідні дані";
      case "invalid_element":
        return `Неправильне значення у ${issue2.origin}`;
      default:
        return `Неправильні вхідні дані`;
    }
  };
};
function uk_default() {
  return {
    localeError: error39()
  };
}

// node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}
// node_modules/zod/v4/locales/ur.js
var error40 = () => {
  const Sizable = {
    string: { unit: "حروف", verb: "ہونا" },
    file: { unit: "بائٹس", verb: "ہونا" },
    array: { unit: "آئٹمز", verb: "ہونا" },
    set: { unit: "آئٹمز", verb: "ہونا" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "نمبر";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرے";
        }
        if (data === null) {
          return "نل";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ان پٹ",
    email: "ای میل ایڈریس",
    url: "یو آر ایل",
    emoji: "ایموجی",
    uuid: "یو یو آئی ڈی",
    uuidv4: "یو یو آئی ڈی وی 4",
    uuidv6: "یو یو آئی ڈی وی 6",
    nanoid: "نینو آئی ڈی",
    guid: "جی یو آئی ڈی",
    cuid: "سی یو آئی ڈی",
    cuid2: "سی یو آئی ڈی 2",
    ulid: "یو ایل آئی ڈی",
    xid: "ایکس آئی ڈی",
    ksuid: "کے ایس یو آئی ڈی",
    datetime: "آئی ایس او ڈیٹ ٹائم",
    date: "آئی ایس او تاریخ",
    time: "آئی ایس او وقت",
    duration: "آئی ایس او مدت",
    ipv4: "آئی پی وی 4 ایڈریس",
    ipv6: "آئی پی وی 6 ایڈریس",
    cidrv4: "آئی پی وی 4 رینج",
    cidrv6: "آئی پی وی 6 رینج",
    base64: "بیس 64 ان کوڈڈ سٹرنگ",
    base64url: "بیس 64 یو آر ایل ان کوڈڈ سٹرنگ",
    json_string: "جے ایس او این سٹرنگ",
    e164: "ای 164 نمبر",
    jwt: "جے ڈبلیو ٹی",
    template_literal: "ان پٹ"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `غلط ان پٹ: ${issue2.expected} متوقع تھا، ${parsedType7(issue2.input)} موصول ہوا`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `غلط ان پٹ: ${stringifyPrimitive(issue2.values[0])} متوقع تھا`;
        return `غلط آپشن: ${joinValues(issue2.values, "|")} میں سے ایک متوقع تھا`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `بہت بڑا: ${issue2.origin ?? "ویلیو"} کے ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "عناصر"} ہونے متوقع تھے`;
        return `بہت بڑا: ${issue2.origin ?? "ویلیو"} کا ${adj}${issue2.maximum.toString()} ہونا متوقع تھا`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `بہت چھوٹا: ${issue2.origin} کے ${adj}${issue2.minimum.toString()} ${sizing.unit} ہونے متوقع تھے`;
        }
        return `بہت چھوٹا: ${issue2.origin} کا ${adj}${issue2.minimum.toString()} ہونا متوقع تھا`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `غلط سٹرنگ: "${_issue.prefix}" سے شروع ہونا چاہیے`;
        }
        if (_issue.format === "ends_with")
          return `غلط سٹرنگ: "${_issue.suffix}" پر ختم ہونا چاہیے`;
        if (_issue.format === "includes")
          return `غلط سٹرنگ: "${_issue.includes}" شامل ہونا چاہیے`;
        if (_issue.format === "regex")
          return `غلط سٹرنگ: پیٹرن ${_issue.pattern} سے میچ ہونا چاہیے`;
        return `غلط ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `غلط نمبر: ${issue2.divisor} کا مضاعف ہونا چاہیے`;
      case "unrecognized_keys":
        return `غیر تسلیم شدہ کی${issue2.keys.length > 1 ? "ز" : ""}: ${joinValues(issue2.keys, "، ")}`;
      case "invalid_key":
        return `${issue2.origin} میں غلط کی`;
      case "invalid_union":
        return "غلط ان پٹ";
      case "invalid_element":
        return `${issue2.origin} میں غلط ویلیو`;
      default:
        return `غلط ان پٹ`;
    }
  };
};
function ur_default() {
  return {
    localeError: error40()
  };
}
// node_modules/zod/v4/locales/vi.js
var error41 = () => {
  const Sizable = {
    string: { unit: "ký tự", verb: "có" },
    file: { unit: "byte", verb: "có" },
    array: { unit: "phần tử", verb: "có" },
    set: { unit: "phần tử", verb: "có" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "số";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "mảng";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "đầu vào",
    email: "địa chỉ email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ngày giờ ISO",
    date: "ngày ISO",
    time: "giờ ISO",
    duration: "khoảng thời gian ISO",
    ipv4: "địa chỉ IPv4",
    ipv6: "địa chỉ IPv6",
    cidrv4: "dải IPv4",
    cidrv6: "dải IPv6",
    base64: "chuỗi mã hóa base64",
    base64url: "chuỗi mã hóa base64url",
    json_string: "chuỗi JSON",
    e164: "số E.164",
    jwt: "JWT",
    template_literal: "đầu vào"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Đầu vào không hợp lệ: mong đợi ${issue2.expected}, nhận được ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Đầu vào không hợp lệ: mong đợi ${stringifyPrimitive(issue2.values[0])}`;
        return `Tùy chọn không hợp lệ: mong đợi một trong các giá trị ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Quá lớn: mong đợi ${issue2.origin ?? "giá trị"} ${sizing.verb} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "phần tử"}`;
        return `Quá lớn: mong đợi ${issue2.origin ?? "giá trị"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `Quá nhỏ: mong đợi ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `Quá nhỏ: mong đợi ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Chuỗi không hợp lệ: phải bắt đầu bằng "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chuỗi không hợp lệ: phải kết thúc bằng "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chuỗi không hợp lệ: phải bao gồm "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chuỗi không hợp lệ: phải khớp với mẫu ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue2.format} không hợp lệ`;
      }
      case "not_multiple_of":
        return `Số không hợp lệ: phải là bội số của ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Khóa không được nhận dạng: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Khóa không hợp lệ trong ${issue2.origin}`;
      case "invalid_union":
        return "Đầu vào không hợp lệ";
      case "invalid_element":
        return `Giá trị không hợp lệ trong ${issue2.origin}`;
      default:
        return `Đầu vào không hợp lệ`;
    }
  };
};
function vi_default() {
  return {
    localeError: error41()
  };
}
// node_modules/zod/v4/locales/zh-CN.js
var error42 = () => {
  const Sizable = {
    string: { unit: "字符", verb: "包含" },
    file: { unit: "字节", verb: "包含" },
    array: { unit: "项", verb: "包含" },
    set: { unit: "项", verb: "包含" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "非数字(NaN)" : "数字";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "数组";
        }
        if (data === null) {
          return "空值(null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "输入",
    email: "电子邮件",
    url: "URL",
    emoji: "表情符号",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日期时间",
    date: "ISO日期",
    time: "ISO时间",
    duration: "ISO时长",
    ipv4: "IPv4地址",
    ipv6: "IPv6地址",
    cidrv4: "IPv4网段",
    cidrv6: "IPv6网段",
    base64: "base64编码字符串",
    base64url: "base64url编码字符串",
    json_string: "JSON字符串",
    e164: "E.164号码",
    jwt: "JWT",
    template_literal: "输入"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `无效输入：期望 ${issue2.expected}，实际接收 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `无效输入：期望 ${stringifyPrimitive(issue2.values[0])}`;
        return `无效选项：期望以下之一 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `数值过大：期望 ${issue2.origin ?? "值"} ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "个元素"}`;
        return `数值过大：期望 ${issue2.origin ?? "值"} ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `数值过小：期望 ${issue2.origin} ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `数值过小：期望 ${issue2.origin} ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `无效字符串：必须以 "${_issue.prefix}" 开头`;
        if (_issue.format === "ends_with")
          return `无效字符串：必须以 "${_issue.suffix}" 结尾`;
        if (_issue.format === "includes")
          return `无效字符串：必须包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `无效字符串：必须满足正则表达式 ${_issue.pattern}`;
        return `无效${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `无效数字：必须是 ${issue2.divisor} 的倍数`;
      case "unrecognized_keys":
        return `出现未知的键(key): ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `${issue2.origin} 中的键(key)无效`;
      case "invalid_union":
        return "无效输入";
      case "invalid_element":
        return `${issue2.origin} 中包含无效值(value)`;
      default:
        return `无效输入`;
    }
  };
};
function zh_CN_default() {
  return {
    localeError: error42()
  };
}
// node_modules/zod/v4/locales/zh-TW.js
var error43 = () => {
  const Sizable = {
    string: { unit: "字元", verb: "擁有" },
    file: { unit: "位元組", verb: "擁有" },
    array: { unit: "項目", verb: "擁有" },
    set: { unit: "項目", verb: "擁有" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "輸入",
    email: "郵件地址",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 日期時間",
    date: "ISO 日期",
    time: "ISO 時間",
    duration: "ISO 期間",
    ipv4: "IPv4 位址",
    ipv6: "IPv6 位址",
    cidrv4: "IPv4 範圍",
    cidrv6: "IPv6 範圍",
    base64: "base64 編碼字串",
    base64url: "base64url 編碼字串",
    json_string: "JSON 字串",
    e164: "E.164 數值",
    jwt: "JWT",
    template_literal: "輸入"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `無效的輸入值：預期為 ${issue2.expected}，但收到 ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `無效的輸入值：預期為 ${stringifyPrimitive(issue2.values[0])}`;
        return `無效的選項：預期為以下其中之一 ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `數值過大：預期 ${issue2.origin ?? "值"} 應為 ${adj}${issue2.maximum.toString()} ${sizing.unit ?? "個元素"}`;
        return `數值過大：預期 ${issue2.origin ?? "值"} 應為 ${adj}${issue2.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing) {
          return `數值過小：預期 ${issue2.origin} 應為 ${adj}${issue2.minimum.toString()} ${sizing.unit}`;
        }
        return `數值過小：預期 ${issue2.origin} 應為 ${adj}${issue2.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with") {
          return `無效的字串：必須以 "${_issue.prefix}" 開頭`;
        }
        if (_issue.format === "ends_with")
          return `無效的字串：必須以 "${_issue.suffix}" 結尾`;
        if (_issue.format === "includes")
          return `無效的字串：必須包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `無效的字串：必須符合格式 ${_issue.pattern}`;
        return `無效的 ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `無效的數字：必須為 ${issue2.divisor} 的倍數`;
      case "unrecognized_keys":
        return `無法識別的鍵值${issue2.keys.length > 1 ? "們" : ""}：${joinValues(issue2.keys, "、")}`;
      case "invalid_key":
        return `${issue2.origin} 中有無效的鍵值`;
      case "invalid_union":
        return "無效的輸入值";
      case "invalid_element":
        return `${issue2.origin} 中有無效的值`;
      default:
        return `無效的輸入值`;
    }
  };
};
function zh_TW_default() {
  return {
    localeError: error43()
  };
}
// node_modules/zod/v4/locales/yo.js
var error44 = () => {
  const Sizable = {
    string: { unit: "àmi", verb: "ní" },
    file: { unit: "bytes", verb: "ní" },
    array: { unit: "nkan", verb: "ní" },
    set: { unit: "nkan", verb: "ní" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType7 = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nọ́mbà";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "akopọ";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ẹ̀rọ ìbáwọlé",
    email: "àdírẹ́sì ìmẹ́lì",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "àkókò ISO",
    date: "ọjọ́ ISO",
    time: "àkókò ISO",
    duration: "àkókò tó pé ISO",
    ipv4: "àdírẹ́sì IPv4",
    ipv6: "àdírẹ́sì IPv6",
    cidrv4: "àgbègbè IPv4",
    cidrv6: "àgbègbè IPv6",
    base64: "ọ̀rọ̀ tí a kọ́ ní base64",
    base64url: "ọ̀rọ̀ base64url",
    json_string: "ọ̀rọ̀ JSON",
    e164: "nọ́mbà E.164",
    jwt: "JWT",
    template_literal: "ẹ̀rọ ìbáwọlé"
  };
  return (issue2) => {
    switch (issue2.code) {
      case "invalid_type":
        return `Ìbáwọlé aṣìṣe: a ní láti fi ${issue2.expected}, àmọ̀ a rí ${parsedType7(issue2.input)}`;
      case "invalid_value":
        if (issue2.values.length === 1)
          return `Ìbáwọlé aṣìṣe: a ní láti fi ${stringifyPrimitive(issue2.values[0])}`;
        return `Àṣàyàn aṣìṣe: yan ọ̀kan lára ${joinValues(issue2.values, "|")}`;
      case "too_big": {
        const adj = issue2.inclusive ? "<=" : "<";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Tó pọ̀ jù: a ní láti jẹ́ pé ${issue2.origin ?? "iye"} ${sizing.verb} ${adj}${issue2.maximum} ${sizing.unit}`;
        return `Tó pọ̀ jù: a ní láti jẹ́ ${adj}${issue2.maximum}`;
      }
      case "too_small": {
        const adj = issue2.inclusive ? ">=" : ">";
        const sizing = getSizing(issue2.origin);
        if (sizing)
          return `Kéré ju: a ní láti jẹ́ pé ${issue2.origin} ${sizing.verb} ${adj}${issue2.minimum} ${sizing.unit}`;
        return `Kéré ju: a ní láti jẹ́ ${adj}${issue2.minimum}`;
      }
      case "invalid_format": {
        const _issue = issue2;
        if (_issue.format === "starts_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bẹ̀rẹ̀ pẹ̀lú "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ parí pẹ̀lú "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ ní "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bá àpẹẹrẹ mu ${_issue.pattern}`;
        return `Aṣìṣe: ${Nouns[_issue.format] ?? issue2.format}`;
      }
      case "not_multiple_of":
        return `Nọ́mbà aṣìṣe: gbọ́dọ̀ jẹ́ èyà pípín ti ${issue2.divisor}`;
      case "unrecognized_keys":
        return `Bọtìnì àìmọ̀: ${joinValues(issue2.keys, ", ")}`;
      case "invalid_key":
        return `Bọtìnì aṣìṣe nínú ${issue2.origin}`;
      case "invalid_union":
        return "Ìbáwọlé aṣìṣe";
      case "invalid_element":
        return `Iye aṣìṣe nínú ${issue2.origin}`;
      default:
        return "Ìbáwọlé aṣìṣe";
    }
  };
};
function yo_default() {
  return {
    localeError: error44()
  };
}
// node_modules/zod/v4/core/registries.js
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");

class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      if (this._idmap.has(meta.id)) {
        throw new Error(`ID ${meta.id} already exists in the registry`);
      }
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
var globalRegistry = /* @__PURE__ */ registry();
// node_modules/zod/v4/core/api.js
function _string(Class2, params) {
  return new Class2({
    type: "string",
    ...normalizeParams(params)
  });
}
function _coercedString(Class2, params) {
  return new Class2({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _email(Class2, params) {
  return new Class2({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class2, params) {
  return new Class2({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class2, params) {
  return new Class2({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class2, params) {
  return new Class2({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class2, params) {
  return new Class2({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class2, params) {
  return new Class2({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class2, params) {
  return new Class2({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class2, params) {
  return new Class2({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class2, params) {
  return new Class2({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class2, params) {
  return new Class2({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class2, params) {
  return new Class2({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class2, params) {
  return new Class2({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class2, params) {
  return new Class2({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
function _isoDateTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class2, params) {
  return new Class2({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class2, params) {
  return new Class2({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class2, params) {
  return new Class2({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class2, params) {
  return new Class2({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _coercedNumber(Class2, params) {
  return new Class2({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _float32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
function _float64(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
function _int32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
function _uint32(Class2, params) {
  return new Class2({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
function _boolean(Class2, params) {
  return new Class2({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _coercedBoolean(Class2, params) {
  return new Class2({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _bigint(Class2, params) {
  return new Class2({
    type: "bigint",
    ...normalizeParams(params)
  });
}
function _coercedBigint(Class2, params) {
  return new Class2({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _int64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
function _uint64(Class2, params) {
  return new Class2({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
function _symbol(Class2, params) {
  return new Class2({
    type: "symbol",
    ...normalizeParams(params)
  });
}
function _undefined2(Class2, params) {
  return new Class2({
    type: "undefined",
    ...normalizeParams(params)
  });
}
function _null2(Class2, params) {
  return new Class2({
    type: "null",
    ...normalizeParams(params)
  });
}
function _any(Class2) {
  return new Class2({
    type: "any"
  });
}
function _unknown(Class2) {
  return new Class2({
    type: "unknown"
  });
}
function _never(Class2, params) {
  return new Class2({
    type: "never",
    ...normalizeParams(params)
  });
}
function _void(Class2, params) {
  return new Class2({
    type: "void",
    ...normalizeParams(params)
  });
}
function _date(Class2, params) {
  return new Class2({
    type: "date",
    ...normalizeParams(params)
  });
}
function _coercedDate(Class2, params) {
  return new Class2({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _nan(Class2, params) {
  return new Class2({
    type: "nan",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _positive(params) {
  return _gt(0, params);
}
function _negative(params) {
  return _lt(0, params);
}
function _nonpositive(params) {
  return _lte(0, params);
}
function _nonnegative(params) {
  return _gte(0, params);
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxSize(maximum, params) {
  return new $ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
function _minSize(minimum, params) {
  return new $ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
function _size(size, params) {
  return new $ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _property(property, schema, params) {
  return new $ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
function _mime(types, params) {
  return new $ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _array(Class2, element, params) {
  return new Class2({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _union(Class2, options, params) {
  return new Class2({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
function _discriminatedUnion(Class2, discriminator, options, params) {
  return new Class2({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
function _intersection(Class2, left, right) {
  return new Class2({
    type: "intersection",
    left,
    right
  });
}
function _tuple(Class2, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class2({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
function _record(Class2, keyType, valueType, params) {
  return new Class2({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _map(Class2, keyType, valueType, params) {
  return new Class2({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _set(Class2, valueType, params) {
  return new Class2({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
function _enum(Class2, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _nativeEnum(Class2, entries, params) {
  return new Class2({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _literal(Class2, value, params) {
  return new Class2({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
function _file(Class2, params) {
  return new Class2({
    type: "file",
    ...normalizeParams(params)
  });
}
function _transform(Class2, fn) {
  return new Class2({
    type: "transform",
    transform: fn
  });
}
function _optional(Class2, innerType) {
  return new Class2({
    type: "optional",
    innerType
  });
}
function _nullable(Class2, innerType) {
  return new Class2({
    type: "nullable",
    innerType
  });
}
function _default(Class2, innerType, defaultValue) {
  return new Class2({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
function _nonoptional(Class2, innerType, params) {
  return new Class2({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
function _success(Class2, innerType) {
  return new Class2({
    type: "success",
    innerType
  });
}
function _catch(Class2, innerType, catchValue) {
  return new Class2({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
function _pipe(Class2, in_, out) {
  return new Class2({
    type: "pipe",
    in: in_,
    out
  });
}
function _readonly(Class2, innerType) {
  return new Class2({
    type: "readonly",
    innerType
  });
}
function _templateLiteral(Class2, parts, params) {
  return new Class2({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
function _lazy(Class2, getter) {
  return new Class2({
    type: "lazy",
    getter
  });
}
function _promise(Class2, innerType) {
  return new Class2({
    type: "promise",
    innerType
  });
}
function _custom(Class2, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
function _refine(Class2, fn, _params) {
  const schema = new Class2({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsyArray = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? $ZodCodec;
  const _Boolean = Classes.Boolean ?? $ZodBoolean;
  const _String = Classes.String ?? $ZodString;
  const stringSchema = new _String({ type: "string", error: params.error });
  const booleanSchema = new _Boolean({ type: "boolean", error: params.error });
  const codec = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: (input, payload) => {
      let data = input;
      if (params.case !== "sensitive")
        data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [...truthySet, ...falsySet],
          input: payload.value,
          inst: codec,
          continue: false
        });
        return {};
      }
    },
    reverseTransform: (input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    },
    error: params.error
  });
  return codec;
}
function _stringFormat(Class2, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class2(def);
  return inst;
}
// node_modules/zod/v4/core/to-json-schema.js
class JSONSchemaGenerator {
  constructor(params) {
    this.counter = 0;
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {});
    this.io = params?.io ?? "output";
    this.seen = new Map;
  }
  process(schema, _params = { path: [], schemaPath: [] }) {
    var _a15;
    const def = schema._zod.def;
    const formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
    };
    const seen = this.seen.get(schema);
    if (seen) {
      seen.count++;
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }
      return seen.schema;
    }
    const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
    this.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) {
      result.schema = overrideSchema;
    } else {
      const params = {
        ..._params,
        schemaPath: [..._params.schemaPath, schema],
        path: _params.path
      };
      const parent = schema._zod.parent;
      if (parent) {
        result.ref = parent;
        this.process(parent, params);
        this.seen.get(parent).isParent = true;
      } else {
        const _json = result.schema;
        switch (def.type) {
          case "string": {
            const json = _json;
            json.type = "string";
            const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minLength = minimum;
            if (typeof maximum === "number")
              json.maxLength = maximum;
            if (format) {
              json.format = formatMap[format] ?? format;
              if (json.format === "")
                delete json.format;
            }
            if (contentEncoding)
              json.contentEncoding = contentEncoding;
            if (patterns && patterns.size > 0) {
              const regexes = [...patterns];
              if (regexes.length === 1)
                json.pattern = regexes[0].source;
              else if (regexes.length > 1) {
                result.schema.allOf = [
                  ...regexes.map((regex) => ({
                    ...this.target === "draft-7" || this.target === "draft-4" || this.target === "openapi-3.0" ? { type: "string" } : {},
                    pattern: regex.source
                  }))
                ];
              }
            }
            break;
          }
          case "number": {
            const json = _json;
            const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
            if (typeof format === "string" && format.includes("int"))
              json.type = "integer";
            else
              json.type = "number";
            if (typeof exclusiveMinimum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.minimum = exclusiveMinimum;
                json.exclusiveMinimum = true;
              } else {
                json.exclusiveMinimum = exclusiveMinimum;
              }
            }
            if (typeof minimum === "number") {
              json.minimum = minimum;
              if (typeof exclusiveMinimum === "number" && this.target !== "draft-4") {
                if (exclusiveMinimum >= minimum)
                  delete json.minimum;
                else
                  delete json.exclusiveMinimum;
              }
            }
            if (typeof exclusiveMaximum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.maximum = exclusiveMaximum;
                json.exclusiveMaximum = true;
              } else {
                json.exclusiveMaximum = exclusiveMaximum;
              }
            }
            if (typeof maximum === "number") {
              json.maximum = maximum;
              if (typeof exclusiveMaximum === "number" && this.target !== "draft-4") {
                if (exclusiveMaximum <= maximum)
                  delete json.maximum;
                else
                  delete json.exclusiveMaximum;
              }
            }
            if (typeof multipleOf === "number")
              json.multipleOf = multipleOf;
            break;
          }
          case "boolean": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") {
              throw new Error("BigInt cannot be represented in JSON Schema");
            }
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") {
              throw new Error("Symbols cannot be represented in JSON Schema");
            }
            break;
          }
          case "null": {
            if (this.target === "openapi-3.0") {
              _json.type = "string";
              _json.nullable = true;
              _json.enum = [null];
            } else
              _json.type = "null";
            break;
          }
          case "any": {
            break;
          }
          case "unknown": {
            break;
          }
          case "undefined": {
            if (this.unrepresentable === "throw") {
              throw new Error("Undefined cannot be represented in JSON Schema");
            }
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") {
              throw new Error("Void cannot be represented in JSON Schema");
            }
            break;
          }
          case "never": {
            _json.not = {};
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") {
              throw new Error("Date cannot be represented in JSON Schema");
            }
            break;
          }
          case "array": {
            const json = _json;
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            json.type = "array";
            json.items = this.process(def.element, { ...params, path: [...params.path, "items"] });
            break;
          }
          case "object": {
            const json = _json;
            json.type = "object";
            json.properties = {};
            const shape = def.shape;
            for (const key in shape) {
              json.properties[key] = this.process(shape[key], {
                ...params,
                path: [...params.path, "properties", key]
              });
            }
            const allKeys = new Set(Object.keys(shape));
            const requiredKeys = new Set([...allKeys].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === undefined;
              } else {
                return v.optout === undefined;
              }
            }));
            if (requiredKeys.size > 0) {
              json.required = Array.from(requiredKeys);
            }
            if (def.catchall?._zod.def.type === "never") {
              json.additionalProperties = false;
            } else if (!def.catchall) {
              if (this.io === "output")
                json.additionalProperties = false;
            } else if (def.catchall) {
              json.additionalProperties = this.process(def.catchall, {
                ...params,
                path: [...params.path, "additionalProperties"]
              });
            }
            break;
          }
          case "union": {
            const json = _json;
            const options = def.options.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, "anyOf", i]
            }));
            json.anyOf = options;
            break;
          }
          case "intersection": {
            const json = _json;
            const a = this.process(def.left, {
              ...params,
              path: [...params.path, "allOf", 0]
            });
            const b = this.process(def.right, {
              ...params,
              path: [...params.path, "allOf", 1]
            });
            const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
            const allOf = [
              ...isSimpleIntersection(a) ? a.allOf : [a],
              ...isSimpleIntersection(b) ? b.allOf : [b]
            ];
            json.allOf = allOf;
            break;
          }
          case "tuple": {
            const json = _json;
            json.type = "array";
            const prefixPath = this.target === "draft-2020-12" ? "prefixItems" : "items";
            const restPath = this.target === "draft-2020-12" ? "items" : this.target === "openapi-3.0" ? "items" : "additionalItems";
            const prefixItems = def.items.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, prefixPath, i]
            }));
            const rest = def.rest ? this.process(def.rest, {
              ...params,
              path: [...params.path, restPath, ...this.target === "openapi-3.0" ? [def.items.length] : []]
            }) : null;
            if (this.target === "draft-2020-12") {
              json.prefixItems = prefixItems;
              if (rest) {
                json.items = rest;
              }
            } else if (this.target === "openapi-3.0") {
              json.items = {
                anyOf: prefixItems
              };
              if (rest) {
                json.items.anyOf.push(rest);
              }
              json.minItems = prefixItems.length;
              if (!rest) {
                json.maxItems = prefixItems.length;
              }
            } else {
              json.items = prefixItems;
              if (rest) {
                json.additionalItems = rest;
              }
            }
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            break;
          }
          case "record": {
            const json = _json;
            json.type = "object";
            if (this.target === "draft-7" || this.target === "draft-2020-12") {
              json.propertyNames = this.process(def.keyType, {
                ...params,
                path: [...params.path, "propertyNames"]
              });
            }
            json.additionalProperties = this.process(def.valueType, {
              ...params,
              path: [...params.path, "additionalProperties"]
            });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") {
              throw new Error("Map cannot be represented in JSON Schema");
            }
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") {
              throw new Error("Set cannot be represented in JSON Schema");
            }
            break;
          }
          case "enum": {
            const json = _json;
            const values = getEnumValues(def.entries);
            if (values.every((v) => typeof v === "number"))
              json.type = "number";
            if (values.every((v) => typeof v === "string"))
              json.type = "string";
            json.enum = values;
            break;
          }
          case "literal": {
            const json = _json;
            const vals = [];
            for (const val of def.values) {
              if (val === undefined) {
                if (this.unrepresentable === "throw") {
                  throw new Error("Literal `undefined` cannot be represented in JSON Schema");
                }
              } else if (typeof val === "bigint") {
                if (this.unrepresentable === "throw") {
                  throw new Error("BigInt literals cannot be represented in JSON Schema");
                } else {
                  vals.push(Number(val));
                }
              } else {
                vals.push(val);
              }
            }
            if (vals.length === 0) {} else if (vals.length === 1) {
              const val = vals[0];
              json.type = val === null ? "null" : typeof val;
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.enum = [val];
              } else {
                json.const = val;
              }
            } else {
              if (vals.every((v) => typeof v === "number"))
                json.type = "number";
              if (vals.every((v) => typeof v === "string"))
                json.type = "string";
              if (vals.every((v) => typeof v === "boolean"))
                json.type = "string";
              if (vals.every((v) => v === null))
                json.type = "null";
              json.enum = vals;
            }
            break;
          }
          case "file": {
            const json = _json;
            const file = {
              type: "string",
              format: "binary",
              contentEncoding: "binary"
            };
            const { minimum, maximum, mime } = schema._zod.bag;
            if (minimum !== undefined)
              file.minLength = minimum;
            if (maximum !== undefined)
              file.maxLength = maximum;
            if (mime) {
              if (mime.length === 1) {
                file.contentMediaType = mime[0];
                Object.assign(json, file);
              } else {
                json.anyOf = mime.map((m) => {
                  const mFile = { ...file, contentMediaType: m };
                  return mFile;
                });
              }
            } else {
              Object.assign(json, file);
            }
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") {
              throw new Error("Transforms cannot be represented in JSON Schema");
            }
            break;
          }
          case "nullable": {
            const inner = this.process(def.innerType, params);
            if (this.target === "openapi-3.0") {
              result.ref = def.innerType;
              _json.nullable = true;
            } else {
              _json.anyOf = [inner, { type: "null" }];
            }
            break;
          }
          case "nonoptional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "success": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "default": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.default = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "prefault": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            if (this.io === "input")
              _json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "catch": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            let catchValue;
            try {
              catchValue = def.catchValue(undefined);
            } catch {
              throw new Error("Dynamic catch values are not supported in JSON Schema");
            }
            _json.default = catchValue;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") {
              throw new Error("NaN cannot be represented in JSON Schema");
            }
            break;
          }
          case "template_literal": {
            const json = _json;
            const pattern = schema._zod.pattern;
            if (!pattern)
              throw new Error("Pattern not found in template literal");
            json.type = "string";
            json.pattern = pattern.source;
            break;
          }
          case "pipe": {
            const innerType = this.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "readonly": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.readOnly = true;
            break;
          }
          case "promise": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "optional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "lazy": {
            const innerType = schema._zod.innerType;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") {
              throw new Error("Custom types cannot be represented in JSON Schema");
            }
            break;
          }
          case "function": {
            if (this.unrepresentable === "throw") {
              throw new Error("Function types cannot be represented in JSON Schema");
            }
            break;
          }
          default: {}
        }
      }
    }
    const meta = this.metadataRegistry.get(schema);
    if (meta)
      Object.assign(result.schema, meta);
    if (this.io === "input" && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (this.io === "input" && result.schema._prefault)
      (_a15 = result.schema).default ?? (_a15.default = result.schema._prefault);
    delete result.schema._prefault;
    const _result = this.seen.get(schema);
    return _result.schema;
  }
  emit(schema, _params) {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      external: _params?.external ?? undefined
    };
    const root = this.seen.get(schema);
    if (!root)
      throw new Error("Unprocessed schema. This is a bug in Zod.");
    const makeURI = (entry) => {
      const defsSegment = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id;
        const uriGenerator = params.external.uri ?? ((id2) => id2);
        if (externalId) {
          return { ref: uriGenerator(externalId) };
        }
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${this.counter++}`;
        entry[1].defId = id;
        return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
      }
      if (entry[1] === root) {
        return { ref: "#" };
      }
      const uriPrefix = `#`;
      const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${this.counter++}`;
      return { defId, ref: defUriPrefix + defId };
    };
    const extractToDef = (entry) => {
      if (entry[1].schema.$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = { ...seen.schema };
      if (defId)
        seen.defId = defId;
      const schema2 = seen.schema;
      for (const key in schema2) {
        delete schema2[key];
      }
      schema2.$ref = ref;
    };
    if (params.cycles === "throw") {
      for (const entry of this.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle) {
          throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
        }
      }
    }
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          continue;
        }
      }
    }
    const flattenRef = (zodSchema, params2) => {
      const seen = this.seen.get(zodSchema);
      const schema2 = seen.def ?? seen.schema;
      const _cached = { ...schema2 };
      if (seen.ref === null) {
        return;
      }
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params2);
        const refSchema = this.seen.get(ref).schema;
        if (refSchema.$ref && (params2.target === "draft-7" || params2.target === "draft-4" || params2.target === "openapi-3.0")) {
          schema2.allOf = schema2.allOf ?? [];
          schema2.allOf.push(refSchema);
        } else {
          Object.assign(schema2, refSchema);
          Object.assign(schema2, _cached);
        }
      }
      if (!seen.isParent)
        this.override({
          zodSchema,
          jsonSchema: schema2,
          path: seen.path ?? []
        });
    };
    for (const entry of [...this.seen.entries()].reverse()) {
      flattenRef(entry[0], { target: this.target });
    }
    const result = {};
    if (this.target === "draft-2020-12") {
      result.$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.$schema = "http://json-schema.org/draft-07/schema#";
    } else if (this.target === "draft-4") {
      result.$schema = "http://json-schema.org/draft-04/schema#";
    } else if (this.target === "openapi-3.0") {} else {
      console.warn(`Invalid target: ${this.target}`);
    }
    if (params.external?.uri) {
      const id = params.external.registry.get(schema)?.id;
      if (!id)
        throw new Error("Schema is missing an `id` property");
      result.$id = params.external.uri(id);
    }
    Object.assign(result, root.def);
    const defs = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }
    if (params.external) {} else {
      if (Object.keys(defs).length > 0) {
        if (this.target === "draft-2020-12") {
          result.$defs = defs;
        } else {
          result.definitions = defs;
        }
      }
    }
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
}
function toJSONSchema(input, _params) {
  if (input instanceof $ZodRegistry) {
    const gen2 = new JSONSchemaGenerator(_params);
    const defs = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen2.process(schema);
    }
    const schemas = {};
    const external = {
      registry: input,
      uri: _params?.uri,
      defs
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen2.emit(schema, {
        ..._params,
        external
      });
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = gen2.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);
  return gen.emit(input, _params);
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const schema = _schema;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array": {
      return isTransforming(def.element, ctx);
    }
    case "object": {
      for (const key in def.shape) {
        if (isTransforming(def.shape[key], ctx))
          return true;
      }
      return false;
    }
    case "union": {
      for (const option of def.options) {
        if (isTransforming(option, ctx))
          return true;
      }
      return false;
    }
    case "intersection": {
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    }
    case "tuple": {
      for (const item of def.items) {
        if (isTransforming(item, ctx))
          return true;
      }
      if (def.rest && isTransforming(def.rest, ctx))
        return true;
      return false;
    }
    case "record": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "map": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "set": {
      return isTransforming(def.valueType, ctx);
    }
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return isTransforming(def.innerType, ctx);
    case "lazy":
      return isTransforming(def.getter(), ctx);
    case "default": {
      return isTransforming(def.innerType, ctx);
    }
    case "prefault": {
      return isTransforming(def.innerType, ctx);
    }
    case "custom": {
      return false;
    }
    case "transform": {
      return true;
    }
    case "pipe": {
      return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    }
    case "success": {
      return false;
    }
    case "catch": {
      return false;
    }
    case "function": {
      return false;
    }
    default:
  }
  throw new Error(`Unknown schema type: ${def.type}`);
}
// node_modules/zod/v4/core/json-schema.js
var exports_json_schema = {};
// node_modules/zod/v4/classic/iso.js
var exports_iso = {};
__export(exports_iso, {
  time: () => time2,
  duration: () => duration2,
  datetime: () => datetime2,
  date: () => date2,
  ZodISOTime: () => ZodISOTime,
  ZodISODuration: () => ZodISODuration,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODate: () => ZodISODate
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
    },
    addIssue: {
      value: (issue2) => {
        inst.issues.push(issue2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    addIssues: {
      value: (issues2) => {
        inst.issues.push(...issues2);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
};
var ZodError = $constructor("ZodError", initializer2);
var ZodRealError = $constructor("ZodError", initializer2, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse3 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks2) => {
    return inst.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks2.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    });
  };
  inst.clone = (def2, params) => clone(inst, def2, params);
  inst.brand = () => inst;
  inst.register = (reg, meta) => {
    reg.add(inst, meta);
    return inst;
  };
  inst.parse = (data, params) => parse3(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check, params) => inst.check(refine(check, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def2) => _default2(inst, def2);
  inst.prefault = (def2) => prefault(inst, def2);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(undefined).success;
  inst.isNullable = () => inst.safeParse(null).success;
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?$/,
    hostname: exports_regexes.domain,
    ...exports_util.normalizeParams(params)
  });
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url3(params) {
  return _base64url(ZodBase64URL, params);
}
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
var ZodCustomStringFormat = /* @__PURE__ */ $constructor("ZodCustomStringFormat", (inst, def) => {
  $ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", exports_regexes.hostname, _params);
}
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", exports_regexes.hex, _params);
}
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = `${alg}_${enc}`;
  const regex = exports_regexes[format];
  if (!regex)
    throw new Error(`Unrecognized hash format: ${format}`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
var ZodBigIntFormat = /* @__PURE__ */ $constructor("ZodBigIntFormat", (inst, def) => {
  $ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
var ZodSymbol = /* @__PURE__ */ $constructor("ZodSymbol", (inst, def) => {
  $ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
});
function symbol15(params) {
  return _symbol(ZodSymbol, params);
}
var ZodUndefined = /* @__PURE__ */ $constructor("ZodUndefined", (inst, def) => {
  $ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodVoid = /* @__PURE__ */ $constructor("ZodVoid", (inst, def) => {
  $ZodVoid.init(inst, def);
  ZodType.init(inst, def);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  exports_util.defineLazy(inst, "shape", () => def.shape);
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: undefined });
  inst.extend = (incoming) => {
    return exports_util.extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return exports_util.safeExtend(inst, incoming);
  };
  inst.merge = (other) => exports_util.merge(inst, other);
  inst.pick = (mask) => exports_util.pick(inst, mask);
  inst.omit = (mask) => exports_util.omit(inst, mask);
  inst.partial = (...args) => exports_util.partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => exports_util.required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", shape ? exports_util.objectClone(shape) : {});
      return this.shape;
    },
    ...exports_util.normalizeParams(params)
  };
  return new ZodObject(def);
}
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", exports_util.objectClone(shape));
      return this.shape;
    },
    catchall: never(),
    ...exports_util.normalizeParams(params)
  });
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      exports_util.assignProp(this, "shape", exports_util.objectClone(shape));
      return this.shape;
    },
    catchall: unknown(),
    ...exports_util.normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...exports_util.normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...exports_util.normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...exports_util.normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = undefined;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodMap = /* @__PURE__ */ $constructor("ZodMap", (inst, def) => {
  $ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodSet = /* @__PURE__ */ $constructor("ZodSet", (inst, def) => {
  $ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...exports_util.normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...exports_util.normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...exports_util.normalizeParams(params)
  });
}
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...exports_util.normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...exports_util.normalizeParams(params)
  });
}
var ZodFile = /* @__PURE__ */ $constructor("ZodFile", (inst, def) => {
  $ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [types], params));
});
function file(params) {
  return _file(ZodFile, params);
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(exports_util.issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(exports_util.issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output2) => {
        payload.value = output2;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function nullish2(innerType) {
  return optional(nullable(innerType));
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : exports_util.shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : exports_util.shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...exports_util.normalizeParams(params)
  });
}
var ZodSuccess = /* @__PURE__ */ $constructor("ZodSuccess", (inst, def) => {
  $ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodNaN = /* @__PURE__ */ $constructor("ZodNaN", (inst, def) => {
  $ZodNaN.init(inst, def);
  ZodType.init(inst, def);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodCodec = /* @__PURE__ */ $constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodTemplateLiteral = /* @__PURE__ */ $constructor("ZodTemplateLiteral", (inst, def) => {
  $ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...exports_util.normalizeParams(params)
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodPromise = /* @__PURE__ */ $constructor("ZodPromise", (inst, def) => {
  $ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
var ZodFunction = /* @__PURE__ */ $constructor("ZodFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodType.init(inst, def);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
});
function check(fn) {
  const ch = new $ZodCheck({
    check: "custom"
  });
  ch._zod.check = fn;
  return ch;
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return _superRefine(fn);
}
function _instanceof(cls, params = {
  error: `Input not instance of ${cls.name}`
}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: (data) => data instanceof cls,
    abort: true,
    ...exports_util.normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  return inst;
}
var stringbool = (...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args);
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}
// node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map2) {
  config({
    customError: map2
  });
}
function getErrorMap() {
  return config().customError;
}
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
// node_modules/zod/v4/classic/coerce.js
var exports_coerce = {};
__export(exports_coerce, {
  string: () => string3,
  number: () => number3,
  date: () => date4,
  boolean: () => boolean3,
  bigint: () => bigint3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date4(params) {
  return _coercedDate(ZodDate, params);
}

// node_modules/zod/v4/classic/external.js
config(en_default());
// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {};
  function assertIs2(_arg) {}
  util2.assertIs = assertIs2;
  function assertNever2(_x) {
    throw new Error;
  }
  util2.assertNever = assertNever2;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object2) => {
    const keys = [];
    for (const key in object2) {
      if (Object.prototype.hasOwnProperty.call(object2, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues2(array2, separator = " | ") {
    return array2.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues2;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType2 = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode2 = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError2 extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue2) {
      return issue2.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error45) => {
      for (const issue2 of error45.issues) {
        if (issue2.code === "invalid_union") {
          issue2.unionErrors.map(processError);
        } else if (issue2.code === "invalid_return_type") {
          processError(issue2.returnTypeError);
        } else if (issue2.code === "invalid_arguments") {
          processError(issue2.argumentsError);
        } else if (issue2.path.length === 0) {
          fieldErrors._errors.push(mapper(issue2));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue2.path.length) {
            const el = issue2.path[i];
            const terminal = i === issue2.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue2));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError2)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue2) => issue2.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError2.create = (issues) => {
  const error45 = new ZodError2(issues);
  return error45;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue2, _ctx) => {
  let message;
  switch (issue2.code) {
    case ZodIssueCode2.invalid_type:
      if (issue2.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue2.expected}, received ${issue2.received}`;
      }
      break;
    case ZodIssueCode2.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue2.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode2.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue2.keys, ", ")}`;
      break;
    case ZodIssueCode2.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode2.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue2.options)}`;
      break;
    case ZodIssueCode2.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue2.options)}, received '${issue2.received}'`;
      break;
    case ZodIssueCode2.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode2.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode2.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode2.invalid_string:
      if (typeof issue2.validation === "object") {
        if ("includes" in issue2.validation) {
          message = `Invalid input: must include "${issue2.validation.includes}"`;
          if (typeof issue2.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue2.validation.position}`;
          }
        } else if ("startsWith" in issue2.validation) {
          message = `Invalid input: must start with "${issue2.validation.startsWith}"`;
        } else if ("endsWith" in issue2.validation) {
          message = `Invalid input: must end with "${issue2.validation.endsWith}"`;
        } else {
          util.assertNever(issue2.validation);
        }
      } else if (issue2.validation !== "regex") {
        message = `Invalid ${issue2.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode2.too_small:
      if (issue2.type === "array")
        message = `Array must contain ${issue2.exact ? "exactly" : issue2.inclusive ? `at least` : `more than`} ${issue2.minimum} element(s)`;
      else if (issue2.type === "string")
        message = `String must contain ${issue2.exact ? "exactly" : issue2.inclusive ? `at least` : `over`} ${issue2.minimum} character(s)`;
      else if (issue2.type === "number")
        message = `Number must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${issue2.minimum}`;
      else if (issue2.type === "bigint")
        message = `Number must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${issue2.minimum}`;
      else if (issue2.type === "date")
        message = `Date must be ${issue2.exact ? `exactly equal to ` : issue2.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue2.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode2.too_big:
      if (issue2.type === "array")
        message = `Array must contain ${issue2.exact ? `exactly` : issue2.inclusive ? `at most` : `less than`} ${issue2.maximum} element(s)`;
      else if (issue2.type === "string")
        message = `String must contain ${issue2.exact ? `exactly` : issue2.inclusive ? `at most` : `under`} ${issue2.maximum} character(s)`;
      else if (issue2.type === "number")
        message = `Number must be ${issue2.exact ? `exactly` : issue2.inclusive ? `less than or equal to` : `less than`} ${issue2.maximum}`;
      else if (issue2.type === "bigint")
        message = `BigInt must be ${issue2.exact ? `exactly` : issue2.inclusive ? `less than or equal to` : `less than`} ${issue2.maximum}`;
      else if (issue2.type === "date")
        message = `Date must be ${issue2.exact ? `exactly` : issue2.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue2.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode2.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode2.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode2.not_multiple_of:
      message = `Number must be a multiple of ${issue2.multipleOf}`;
      break;
    case ZodIssueCode2.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue2);
  }
  return { message };
};
var en_default2 = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default2;
function getErrorMap2() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map2 of maps) {
    errorMessage = map2(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap2();
  const issue2 = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default2 ? undefined : en_default2
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue2);
}

class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error45 = new ZodError2(ctx.common.issues);
        this._error = error45;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType2 {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType2(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType2(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus,
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType2(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType2(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check2, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check2(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode2.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check2, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check2(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind2.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional2.create(this, this._def);
  }
  nullable() {
    return ZodNullable2.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray2.create(this);
  }
  promise() {
    return ZodPromise2.create(this, this._def);
  }
  or(option) {
    return ZodUnion2.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection2.create(this, incoming, this._def);
  }
  transform(transform2) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind2.ZodEffects,
      effect: { type: "transform", transform: transform2 }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault2({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind2.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind2.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch2({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind2.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly2.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT2(jwt2, alg) {
  if (!jwtRegex.test(jwt2))
    return false;
  try {
    const [header] = jwt2.split(".");
    if (!header)
      return false;
    const base643 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base643));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version2) {
  if ((version2 === "v4" || !version2) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version2 === "v6" || !version2) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString2 extends ZodType2 {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        if (input.data.length < check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            minimum: check2.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        if (input.data.length > check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            maximum: check2.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "length") {
        const tooBig = input.data.length > check2.value;
        const tooSmall = input.data.length < check2.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode2.too_big,
              maximum: check2.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check2.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode2.too_small,
              minimum: check2.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check2.message
            });
          }
          status.dirty();
        }
      } else if (check2.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "regex") {
        check2.regex.lastIndex = 0;
        const testResult = check2.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "trim") {
        input.data = input.data.trim();
      } else if (check2.kind === "includes") {
        if (!input.data.includes(check2.value, check2.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: { includes: check2.value, position: check2.position },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check2.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check2.kind === "startsWith") {
        if (!input.data.startsWith(check2.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: { startsWith: check2.value },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "endsWith") {
        if (!input.data.endsWith(check2.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: { endsWith: check2.value },
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "datetime") {
        const regex = datetimeRegex(check2);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "datetime",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "date",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "time") {
        const regex = timeRegex(check2);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_string,
            validation: "time",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "ip") {
        if (!isValidIP(input.data, check2.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "jwt") {
        if (!isValidJWT2(input.data, check2.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "cidr") {
        if (!isValidCidr(input.data, check2.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode2.invalid_string,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode2.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check2) {
    return new ZodString2({
      ...this._def,
      checks: [...this._def.checks, check2]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString2({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString2({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString2({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString2.create = (params) => {
  return new ZodString2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder2(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}

class ZodNumber2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check2 of this._def.checks) {
      if (check2.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.invalid_type,
            expected: "integer",
            received: "float",
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "min") {
        const tooSmall = check2.inclusive ? input.data < check2.value : input.data <= check2.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            minimum: check2.value,
            type: "number",
            inclusive: check2.inclusive,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        const tooBig = check2.inclusive ? input.data > check2.value : input.data >= check2.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            maximum: check2.value,
            type: "number",
            inclusive: check2.inclusive,
            exact: false,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "multipleOf") {
        if (floatSafeRemainder2(input.data, check2.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_multiple_of,
            multipleOf: check2.value,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_finite,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber2({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check2) {
    return new ZodNumber2({
      ...this._def,
      checks: [...this._def.checks, check2]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber2.create = (params) => {
  return new ZodNumber2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodBigInt2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        const tooSmall = check2.inclusive ? input.data < check2.value : input.data <= check2.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            type: "bigint",
            minimum: check2.value,
            inclusive: check2.inclusive,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        const tooBig = check2.inclusive ? input.data > check2.value : input.data >= check2.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            type: "bigint",
            maximum: check2.value,
            inclusive: check2.inclusive,
            message: check2.message
          });
          status.dirty();
        }
      } else if (check2.kind === "multipleOf") {
        if (input.data % check2.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.not_multiple_of,
            multipleOf: check2.value,
            message: check2.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode2.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt2({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check2) {
    return new ZodBigInt2({
      ...this._def,
      checks: [...this._def.checks, check2]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt2.create = (params) => {
  return new ZodBigInt2({
    checks: [],
    typeName: ZodFirstPartyTypeKind2.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};

class ZodBoolean2 extends ZodType2 {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean2.create = (params) => {
  return new ZodBoolean2({
    typeName: ZodFirstPartyTypeKind2.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodDate2 extends ZodType2 {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check2 of this._def.checks) {
      if (check2.kind === "min") {
        if (input.data.getTime() < check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_small,
            message: check2.message,
            inclusive: true,
            exact: false,
            minimum: check2.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check2.kind === "max") {
        if (input.data.getTime() > check2.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode2.too_big,
            message: check2.message,
            inclusive: true,
            exact: false,
            maximum: check2.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check2);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check2) {
    return new ZodDate2({
      ...this._def,
      checks: [...this._def.checks, check2]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate2.create = (params) => {
  return new ZodDate2({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind2.ZodDate,
    ...processCreateParams(params)
  });
};

class ZodSymbol2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol2.create = (params) => {
  return new ZodSymbol2({
    typeName: ZodFirstPartyTypeKind2.ZodSymbol,
    ...processCreateParams(params)
  });
};

class ZodUndefined2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined2.create = (params) => {
  return new ZodUndefined2({
    typeName: ZodFirstPartyTypeKind2.ZodUndefined,
    ...processCreateParams(params)
  });
};

class ZodNull2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull2.create = (params) => {
  return new ZodNull2({
    typeName: ZodFirstPartyTypeKind2.ZodNull,
    ...processCreateParams(params)
  });
};

class ZodAny2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny2.create = (params) => {
  return new ZodAny2({
    typeName: ZodFirstPartyTypeKind2.ZodAny,
    ...processCreateParams(params)
  });
};

class ZodUnknown2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown2.create = (params) => {
  return new ZodUnknown2({
    typeName: ZodFirstPartyTypeKind2.ZodUnknown,
    ...processCreateParams(params)
  });
};

class ZodNever2 extends ZodType2 {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode2.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever2.create = (params) => {
  return new ZodNever2({
    typeName: ZodFirstPartyTypeKind2.ZodNever,
    ...processCreateParams(params)
  });
};

class ZodVoid2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid2.create = (params) => {
  return new ZodVoid2({
    typeName: ZodFirstPartyTypeKind2.ZodVoid,
    ...processCreateParams(params)
  });
};

class ZodArray2 extends ZodType2 {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode2.too_big : ZodIssueCode2.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray2({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray2({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray2({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray2.create = (schema, params) => {
  return new ZodArray2({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind2.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject2) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional2.create(deepPartialify(fieldSchema));
    }
    return new ZodObject2({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray2) {
    return new ZodArray2({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional2) {
    return ZodOptional2.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable2) {
    return ZodNullable2.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple2) {
    return ZodTuple2.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever2 && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever2) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode2.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {} else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject2({
      ...this._def,
      unknownKeys: "strict",
      ...message !== undefined ? {
        errorMap: (issue2, ctx) => {
          const defaultError = this._def.errorMap?.(issue2, ctx).message ?? ctx.defaultError;
          if (issue2.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject2({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject2({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new ZodObject2({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new ZodObject2({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind2.ZodObject
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject2({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject2({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject2({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject2({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional2) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject2({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject2.create = (shape, params) => {
  return new ZodObject2({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject2.strictCreate = (shape, params) => {
  return new ZodObject2({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject2.lazycreate = (shape, params) => {
  return new ZodObject2({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever2.create(),
    typeName: ZodFirstPartyTypeKind2.ZodObject,
    ...processCreateParams(params)
  });
};

class ZodUnion2 extends ZodType2 {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError2(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError2(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion2.create = (types, params) => {
  return new ZodUnion2({
    options: types,
    typeName: ZodFirstPartyTypeKind2.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy2) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral2) {
    return [type.value];
  } else if (type instanceof ZodEnum2) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault2) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined2) {
    return [undefined];
  } else if (type instanceof ZodNull2) {
    return [null];
  } else if (type instanceof ZodOptional2) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable2) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly2) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch2) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion2 extends ZodType2 {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map;
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion2({
      typeName: ZodFirstPartyTypeKind2.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues2(a, b) {
  const aType = getParsedType2(a);
  const bType = getParsedType2(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues2(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues2(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection2 extends ZodType2 {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues2(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection2.create = (left, right, params) => {
  return new ZodIntersection2({
    left,
    right,
    typeName: ZodFirstPartyTypeKind2.ZodIntersection,
    ...processCreateParams(params)
  });
};

class ZodTuple2 extends ZodType2 {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple2({
      ...this._def,
      rest
    });
  }
}
ZodTuple2.create = (schemas3, params) => {
  if (!Array.isArray(schemas3)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple2({
    items: schemas3,
    typeName: ZodFirstPartyTypeKind2.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};

class ZodRecord2 extends ZodType2 {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType2) {
      return new ZodRecord2({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind2.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord2({
      keyType: ZodString2.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind2.ZodRecord,
      ...processCreateParams(second)
    });
  }
}

class ZodMap2 extends ZodType2 {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map;
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map;
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap2.create = (keyType, valueType, params) => {
  return new ZodMap2({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind2.ZodMap,
    ...processCreateParams(params)
  });
};

class ZodSet2 extends ZodType2 {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode2.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = new Set;
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet2({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet2({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet2.create = (valueType, params) => {
  return new ZodSet2({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind2.ZodSet,
    ...processCreateParams(params)
  });
};

class ZodFunction2 extends ZodType2 {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error45) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap2(), en_default2].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode2.invalid_arguments,
          argumentsError: error45
        }
      });
    }
    function makeReturnsIssue(returns, error45) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap2(), en_default2].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode2.invalid_return_type,
          returnTypeError: error45
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise2) {
      const me = this;
      return OK(async function(...args) {
        const error45 = new ZodError2([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error45.addIssue(makeArgsIssue(args, e));
          throw error45;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error45.addIssue(makeReturnsIssue(result, e));
          throw error45;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError2([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError2([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction2({
      ...this._def,
      args: ZodTuple2.create(items).rest(ZodUnknown2.create())
    });
  }
  returns(returnType) {
    return new ZodFunction2({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction2({
      args: args ? args : ZodTuple2.create([]).rest(ZodUnknown2.create()),
      returns: returns || ZodUnknown2.create(),
      typeName: ZodFirstPartyTypeKind2.ZodFunction,
      ...processCreateParams(params)
    });
  }
}

class ZodLazy2 extends ZodType2 {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy2.create = (getter, params) => {
  return new ZodLazy2({
    getter,
    typeName: ZodFirstPartyTypeKind2.ZodLazy,
    ...processCreateParams(params)
  });
};

class ZodLiteral2 extends ZodType2 {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral2.create = (value, params) => {
  return new ZodLiteral2({
    value,
    typeName: ZodFirstPartyTypeKind2.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum2({
    values,
    typeName: ZodFirstPartyTypeKind2.ZodEnum,
    ...processCreateParams(params)
  });
}

class ZodEnum2 extends ZodType2 {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode2.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum2.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum2.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum2.create = createZodEnum;

class ZodNativeEnum extends ZodType2 {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode2.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode2.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind2.ZodNativeEnum,
    ...processCreateParams(params)
  });
};

class ZodPromise2 extends ZodType2 {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise2.create = (schema, params) => {
  return new ZodPromise2({
    type: schema,
    typeName: ZodFirstPartyTypeKind2.ZodPromise,
    ...processCreateParams(params)
  });
};

class ZodEffects extends ZodType2 {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind2.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind2.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess2, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess2 },
    typeName: ZodFirstPartyTypeKind2.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional2.create = (type, params) => {
  return new ZodOptional2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodOptional,
    ...processCreateParams(params)
  });
};

class ZodNullable2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable2.create = (type, params) => {
  return new ZodNullable2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodNullable,
    ...processCreateParams(params)
  });
};

class ZodDefault2 extends ZodType2 {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault2.create = (type, params) => {
  return new ZodDefault2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};

class ZodCatch2 extends ZodType2 {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError2(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError2(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch2.create = (type, params) => {
  return new ZodCatch2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};

class ZodNaN2 extends ZodType2 {
  _parse(input) {
    const parsedType7 = this._getType(input);
    if (parsedType7 !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode2.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN2.create = (params) => {
  return new ZodNaN2({
    typeName: ZodFirstPartyTypeKind2.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");

class ZodBranded extends ZodType2 {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType2 {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind2.ZodPipeline
    });
  }
}

class ZodReadonly2 extends ZodType2 {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly2.create = (type, params) => {
  return new ZodReadonly2({
    innerType: type,
    typeName: ZodFirstPartyTypeKind2.ZodReadonly,
    ...processCreateParams(params)
  });
};
var late = {
  object: ZodObject2.lazycreate
};
var ZodFirstPartyTypeKind2;
(function(ZodFirstPartyTypeKind3) {
  ZodFirstPartyTypeKind3["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind3["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind3["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind3["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind3["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind3["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind3["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind3["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind3["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind3["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind3["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind3["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind3["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind3["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind3["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind3["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind3["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind3["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind3["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind3["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind3["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind3["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind3["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind3["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind3["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind3["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind3["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind3["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind3["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind3["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind3["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind3["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind3["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind3["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind3["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind3["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind2 || (ZodFirstPartyTypeKind2 = {}));
var stringType = ZodString2.create;
var numberType = ZodNumber2.create;
var nanType = ZodNaN2.create;
var bigIntType = ZodBigInt2.create;
var booleanType = ZodBoolean2.create;
var dateType = ZodDate2.create;
var symbolType = ZodSymbol2.create;
var undefinedType = ZodUndefined2.create;
var nullType = ZodNull2.create;
var anyType = ZodAny2.create;
var unknownType = ZodUnknown2.create;
var neverType = ZodNever2.create;
var voidType = ZodVoid2.create;
var arrayType = ZodArray2.create;
var objectType = ZodObject2.create;
var strictObjectType = ZodObject2.strictCreate;
var unionType = ZodUnion2.create;
var discriminatedUnionType = ZodDiscriminatedUnion2.create;
var intersectionType = ZodIntersection2.create;
var tupleType = ZodTuple2.create;
var recordType = ZodRecord2.create;
var mapType = ZodMap2.create;
var setType = ZodSet2.create;
var functionType = ZodFunction2.create;
var lazyType = ZodLazy2.create;
var literalType = ZodLiteral2.create;
var enumType = ZodEnum2.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise2.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional2.create;
var nullableType = ZodNullable2.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;

// node_modules/eventsource-parser/dist/index.js
class ParseError extends Error {
  constructor(message, options) {
    super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
  }
}
var LF = 10;
var CR = 13;
var SPACE = 32;
function noop(_arg) {}
function createParser(config2) {
  if (typeof config2 == "function")
    throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
  const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config2, pendingFragments = [];
  let pendingFragmentsLength = 0, isFirstChunk = true, id, data = "", dataLines = 0, eventType, terminated = false;
  function feed(chunk) {
    if (terminated)
      throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
    if (isFirstChunk && (isFirstChunk = false, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
      const trailing2 = processLines(chunk);
      trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
      return;
    }
    if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
      pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
      return;
    }
    pendingFragments.push(chunk);
    const input = pendingFragments.join("");
    pendingFragments.length = 0, pendingFragmentsLength = 0;
    const trailing = processLines(input);
    trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
  }
  function checkBufferSize() {
    maxBufferSize !== undefined && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = true, pendingFragments.length = 0, pendingFragmentsLength = 0, id = undefined, data = "", dataLines = 0, eventType = undefined, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, {
      type: "max-buffer-size-exceeded"
    }))));
  }
  function processLines(chunk) {
    let searchIndex = 0;
    if (chunk.indexOf("\r") === -1) {
      let lfIndex = chunk.indexOf(`
`, searchIndex);
      for (;lfIndex !== -1; ) {
        if (searchIndex === lfIndex) {
          dataLines > 0 && onEvent({ id, event: eventType, data }), id = undefined, data = "", dataLines = 0, eventType = undefined, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
          continue;
        }
        const firstCharCode = chunk.charCodeAt(searchIndex);
        if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
          const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
          if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
            onEvent({ id, event: eventType, data: value }), id = undefined, data = "", eventType = undefined, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
            continue;
          }
          data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        } else
          isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || undefined : parseLine(chunk, searchIndex, lfIndex);
        searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
      }
      return chunk.slice(searchIndex);
    }
    for (;searchIndex < chunk.length; ) {
      const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
      let lineEnd = -1;
      if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1)
        break;
      parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
    }
    return chunk.slice(searchIndex);
  }
  function parseLine(chunk, start, end) {
    if (start === end) {
      dispatchEvent();
      return;
    }
    const firstCharCode = chunk.charCodeAt(start);
    if (isDataPrefix(chunk, start, firstCharCode)) {
      const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
      data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
      return;
    }
    if (isEventPrefix(chunk, start, firstCharCode)) {
      eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || undefined;
      return;
    }
    if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
      const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
      value2.includes("\x00") || (id = value2);
      return;
    }
    if (firstCharCode === 58) {
      if (onComment) {
        const line2 = chunk.slice(start, end);
        onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
      }
      return;
    }
    const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex === -1) {
      processField(line, "", line);
      return;
    }
    const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
    processField(field, value, line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value || undefined;
        break;
      case "data":
        data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        break;
      case "id":
        value.includes("\x00") || (id = value);
        break;
      case "retry":
        /^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
          type: "invalid-retry",
          value,
          line
        }));
        break;
      default:
        onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}…` : field}"`, { type: "unknown-field", field, value, line }));
        break;
    }
  }
  function dispatchEvent() {
    dataLines > 0 && onEvent({
      id,
      event: eventType,
      data
    }), id = undefined, data = "", dataLines = 0, eventType = undefined;
  }
  function reset(options = {}) {
    if (options.consume && pendingFragments.length > 0) {
      const incompleteLine = pendingFragments.join("");
      parseLine(incompleteLine, 0, incompleteLine.length);
    }
    isFirstChunk = true, id = undefined, data = "", dataLines = 0, eventType = undefined, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = false;
  }
  return { feed, reset };
}
function isDataPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}

// node_modules/eventsource-parser/dist/stream.js
class EventSourceParserStream extends TransformStream {
  constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
    let parser;
    super({
      start(controller) {
        parser = createParser({
          onEvent: (event) => {
            controller.enqueue(event);
          },
          onError(error45) {
            typeof onError == "function" && onError(error45), (onError === "terminate" || error45.type === "max-buffer-size-exceeded") && controller.error(error45);
          },
          onRetry,
          onComment,
          maxBufferSize
        });
      },
      transform(chunk) {
        parser.feed(chunk);
      }
    });
  }
}

// node_modules/@ai-sdk/provider-utils/dist/index.mjs
function combineHeaders(...headers) {
  return headers.reduce((combinedHeaders, currentHeaders) => ({
    ...combinedHeaders,
    ...currentHeaders != null ? currentHeaders : {}
  }), {});
}
function extractResponseHeaders(response) {
  return Object.fromEntries([...response.headers]);
}
var { btoa: btoa2, atob: atob2 } = globalThis;
function convertBase64ToUint8Array(base64String) {
  const base64Url = base64String.replace(/-/g, "+").replace(/_/g, "/");
  const latin1string = atob2(base64Url);
  return Uint8Array.from(latin1string, (byte) => byte.codePointAt(0));
}
function convertUint8ArrayToBase64(array2) {
  let latin1string = "";
  for (let i = 0;i < array2.length; i++) {
    latin1string += String.fromCodePoint(array2[i]);
  }
  return btoa2(latin1string);
}
function convertToBase64(value) {
  return value instanceof Uint8Array ? convertUint8ArrayToBase64(value) : value;
}
function convertToFormData(input, options = {}) {
  const { useArrayBrackets = true } = options;
  const formData = new FormData;
  for (const [key, value] of Object.entries(input)) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 1) {
        formData.append(key, value[0]);
        continue;
      }
      const arrayKey = useArrayBrackets ? `${key}[]` : key;
      for (const item of value) {
        formData.append(arrayKey, item);
      }
      continue;
    }
    formData.append(key, value);
  }
  return formData;
}
var name14 = "AI_DownloadError";
var marker15 = `vercel.ai.error.${name14}`;
var symbol17 = Symbol.for(marker15);
var _a15;
var _b15;
var DownloadError = class extends (_b15 = AISDKError, _a15 = symbol17, _b15) {
  constructor({
    url: url2,
    statusCode,
    statusText,
    cause,
    message = cause == null ? `Failed to download ${url2}: ${statusCode} ${statusText}` : `Failed to download ${url2}: ${cause}`
  }) {
    super({ name: name14, message, cause });
    this[_a15] = true;
    this.url = url2;
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
  static isInstance(error45) {
    return AISDKError.hasMarker(error45, marker15);
  }
};
var DEFAULT_MAX_DOWNLOAD_SIZE = 2 * 1024 * 1024 * 1024;
async function readResponseWithSizeLimit({
  response,
  url: url2,
  maxBytes = DEFAULT_MAX_DOWNLOAD_SIZE
}) {
  const contentLength = response.headers.get("content-length");
  if (contentLength != null) {
    const length = parseInt(contentLength, 10);
    if (!isNaN(length) && length > maxBytes) {
      throw new DownloadError({
        url: url2,
        message: `Download of ${url2} exceeded maximum size of ${maxBytes} bytes (Content-Length: ${length}).`
      });
    }
  }
  const body = response.body;
  if (body == null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        throw new DownloadError({
          url: url2,
          message: `Download of ${url2} exceeded maximum size of ${maxBytes} bytes.`
        });
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function validateDownloadUrl(url2) {
  let parsed;
  try {
    parsed = new URL(url2);
  } catch (e) {
    throw new DownloadError({
      url: url2,
      message: `Invalid URL: ${url2}`
    });
  }
  if (parsed.protocol === "data:") {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DownloadError({
      url: url2,
      message: `URL scheme must be http, https, or data, got ${parsed.protocol}`
    });
  }
  const hostname3 = parsed.hostname;
  if (!hostname3) {
    throw new DownloadError({
      url: url2,
      message: `URL must have a hostname`
    });
  }
  if (hostname3 === "localhost" || hostname3.endsWith(".local") || hostname3.endsWith(".localhost")) {
    throw new DownloadError({
      url: url2,
      message: `URL with hostname ${hostname3} is not allowed`
    });
  }
  if (hostname3.startsWith("[") && hostname3.endsWith("]")) {
    const ipv63 = hostname3.slice(1, -1);
    if (isPrivateIPv6(ipv63)) {
      throw new DownloadError({
        url: url2,
        message: `URL with IPv6 address ${hostname3} is not allowed`
      });
    }
    return;
  }
  if (isIPv4(hostname3)) {
    if (isPrivateIPv4(hostname3)) {
      throw new DownloadError({
        url: url2,
        message: `URL with IP address ${hostname3} is not allowed`
      });
    }
    return;
  }
}
function isIPv4(hostname3) {
  const parts = hostname3.split(".");
  if (parts.length !== 4)
    return false;
  return parts.every((part) => {
    const num = Number(part);
    return Number.isInteger(num) && num >= 0 && num <= 255 && String(num) === part;
  });
}
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0)
    return true;
  if (a === 10)
    return true;
  if (a === 127)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  return false;
}
function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1")
    return true;
  if (normalized === "::")
    return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedPart = normalized.slice(7);
    if (isIPv4(mappedPart)) {
      return isPrivateIPv4(mappedPart);
    }
    const hexParts = mappedPart.split(":");
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      if (!isNaN(high) && !isNaN(low)) {
        const a = high >> 8 & 255;
        const b = high & 255;
        const c = low >> 8 & 255;
        const d = low & 255;
        return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
      }
    }
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd"))
    return true;
  if (normalized.startsWith("fe80"))
    return true;
  return false;
}
async function downloadBlob(url2, options) {
  var _a22, _b22;
  validateDownloadUrl(url2);
  try {
    const response = await fetch(url2, {
      signal: options == null ? undefined : options.abortSignal
    });
    if (response.redirected) {
      validateDownloadUrl(response.url);
    }
    if (!response.ok) {
      throw new DownloadError({
        url: url2,
        statusCode: response.status,
        statusText: response.statusText
      });
    }
    const data = await readResponseWithSizeLimit({
      response,
      url: url2,
      maxBytes: (_a22 = options == null ? undefined : options.maxBytes) != null ? _a22 : DEFAULT_MAX_DOWNLOAD_SIZE
    });
    const contentType = (_b22 = response.headers.get("content-type")) != null ? _b22 : undefined;
    return new Blob([data], contentType ? { type: contentType } : undefined);
  } catch (error45) {
    if (DownloadError.isInstance(error45)) {
      throw error45;
    }
    throw new DownloadError({ url: url2, cause: error45 });
  }
}
var createIdGenerator = ({
  prefix,
  size = 16,
  alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  separator = "-"
} = {}) => {
  const generator = () => {
    const alphabetLength = alphabet.length;
    const chars = new Array(size);
    for (let i = 0;i < size; i++) {
      chars[i] = alphabet[Math.random() * alphabetLength | 0];
    }
    return chars.join("");
  };
  if (prefix == null) {
    return generator;
  }
  if (alphabet.includes(separator)) {
    throw new InvalidArgumentError({
      argument: "separator",
      message: `The separator "${separator}" must not be part of the alphabet "${alphabet}".`
    });
  }
  return () => `${prefix}${separator}${generator()}`;
};
var generateId = createIdGenerator();
function isAbortError(error45) {
  return (error45 instanceof Error || error45 instanceof DOMException) && (error45.name === "AbortError" || error45.name === "ResponseAborted" || error45.name === "TimeoutError");
}
var FETCH_FAILED_ERROR_MESSAGES = ["fetch failed", "failed to fetch"];
var BUN_ERROR_CODES = [
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE"
];
function isBunNetworkError(error45) {
  if (!(error45 instanceof Error)) {
    return false;
  }
  const code = error45.code;
  if (typeof code === "string" && BUN_ERROR_CODES.includes(code)) {
    return true;
  }
  return false;
}
function handleFetchError({
  error: error45,
  url: url2,
  requestBodyValues
}) {
  if (isAbortError(error45)) {
    return error45;
  }
  if (error45 instanceof TypeError && FETCH_FAILED_ERROR_MESSAGES.includes(error45.message.toLowerCase())) {
    const cause = error45.cause;
    if (cause != null) {
      return new APICallError({
        message: `Cannot connect to API: ${cause.message}`,
        cause,
        url: url2,
        requestBodyValues,
        isRetryable: true
      });
    }
  }
  if (isBunNetworkError(error45)) {
    return new APICallError({
      message: `Cannot connect to API: ${error45.message}`,
      cause: error45,
      url: url2,
      requestBodyValues,
      isRetryable: true
    });
  }
  return error45;
}
function getRuntimeEnvironmentUserAgent(globalThisAny = globalThis) {
  var _a22, _b22, _c;
  if (globalThisAny.window) {
    return `runtime/browser`;
  }
  if ((_a22 = globalThisAny.navigator) == null ? undefined : _a22.userAgent) {
    return `runtime/${globalThisAny.navigator.userAgent.toLowerCase()}`;
  }
  if ((_c = (_b22 = globalThisAny.process) == null ? undefined : _b22.versions) == null ? undefined : _c.node) {
    return `runtime/node.js/${globalThisAny.process.version.substring(0)}`;
  }
  if (globalThisAny.EdgeRuntime) {
    return `runtime/vercel-edge`;
  }
  return "runtime/unknown";
}
function normalizeHeaders(headers) {
  if (headers == null) {
    return {};
  }
  const normalized = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
  } else {
    if (!Array.isArray(headers)) {
      headers = Object.entries(headers);
    }
    for (const [key, value] of headers) {
      if (value != null) {
        normalized[key.toLowerCase()] = value;
      }
    }
  }
  return normalized;
}
function withUserAgentSuffix(headers, ...userAgentSuffixParts) {
  const normalizedHeaders = new Headers(normalizeHeaders(headers));
  const currentUserAgentHeader = normalizedHeaders.get("user-agent") || "";
  normalizedHeaders.set("user-agent", [currentUserAgentHeader, ...userAgentSuffixParts].filter(Boolean).join(" "));
  return Object.fromEntries(normalizedHeaders.entries());
}
var VERSION = "4.0.23";
var suspectProtoRx = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/;
var suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
function _parse2(text) {
  const obj = JSON.parse(text);
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (suspectProtoRx.test(text) === false && suspectConstructorRx.test(text) === false) {
    return obj;
  }
  return filter(obj);
}
function filter(obj) {
  let next = [obj];
  while (next.length) {
    const nodes = next;
    next = [];
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(node, "__proto__")) {
        throw new SyntaxError("Object contains forbidden prototype property");
      }
      if (Object.prototype.hasOwnProperty.call(node, "constructor") && node.constructor !== null && typeof node.constructor === "object" && Object.prototype.hasOwnProperty.call(node.constructor, "prototype")) {
        throw new SyntaxError("Object contains forbidden prototype property");
      }
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === "object") {
          next.push(value);
        }
      }
    }
  }
  return obj;
}
function secureJsonParse(text) {
  const { stackTraceLimit } = Error;
  try {
    Error.stackTraceLimit = 0;
  } catch (e) {
    return _parse2(text);
  }
  try {
    return _parse2(text);
  } finally {
    Error.stackTraceLimit = stackTraceLimit;
  }
}
function addAdditionalPropertiesToJsonSchema(jsonSchema2) {
  if (jsonSchema2.type === "object" || Array.isArray(jsonSchema2.type) && jsonSchema2.type.includes("object")) {
    jsonSchema2.additionalProperties = false;
    const { properties } = jsonSchema2;
    if (properties != null) {
      for (const key of Object.keys(properties)) {
        properties[key] = visit(properties[key]);
      }
    }
  }
  if (jsonSchema2.items != null) {
    jsonSchema2.items = Array.isArray(jsonSchema2.items) ? jsonSchema2.items.map(visit) : visit(jsonSchema2.items);
  }
  if (jsonSchema2.anyOf != null) {
    jsonSchema2.anyOf = jsonSchema2.anyOf.map(visit);
  }
  if (jsonSchema2.allOf != null) {
    jsonSchema2.allOf = jsonSchema2.allOf.map(visit);
  }
  if (jsonSchema2.oneOf != null) {
    jsonSchema2.oneOf = jsonSchema2.oneOf.map(visit);
  }
  const { definitions } = jsonSchema2;
  if (definitions != null) {
    for (const key of Object.keys(definitions)) {
      definitions[key] = visit(definitions[key]);
    }
  }
  return jsonSchema2;
}
function visit(def) {
  if (typeof def === "boolean")
    return def;
  return addAdditionalPropertiesToJsonSchema(def);
}
var ignoreOverride = /* @__PURE__ */ Symbol("Let zodToJsonSchema decide on which parser to use");
var defaultOptions = {
  name: undefined,
  $refStrategy: "root",
  basePath: ["#"],
  effectStrategy: "input",
  pipeStrategy: "all",
  dateStrategy: "format:date-time",
  mapStrategy: "entries",
  removeAdditionalStrategy: "passthrough",
  allowedAdditionalProperties: true,
  rejectedAdditionalProperties: false,
  definitionPath: "definitions",
  strictUnions: false,
  definitions: {},
  errorMessages: false,
  patternStrategy: "escape",
  applyRegexFlags: false,
  emailStrategy: "format:email",
  base64Strategy: "contentEncoding:base64",
  nameStrategy: "ref"
};
var getDefaultOptions = (options) => typeof options === "string" ? {
  ...defaultOptions,
  name: options
} : {
  ...defaultOptions,
  ...options
};
function parseAnyDef() {
  return {};
}
function parseArrayDef(def, refs) {
  var _a22, _b22, _c;
  const res = {
    type: "array"
  };
  if (((_a22 = def.type) == null ? undefined : _a22._def) && ((_c = (_b22 = def.type) == null ? undefined : _b22._def) == null ? undefined : _c.typeName) !== ZodFirstPartyTypeKind2.ZodAny) {
    res.items = parseDef(def.type._def, {
      ...refs,
      currentPath: [...refs.currentPath, "items"]
    });
  }
  if (def.minLength) {
    res.minItems = def.minLength.value;
  }
  if (def.maxLength) {
    res.maxItems = def.maxLength.value;
  }
  if (def.exactLength) {
    res.minItems = def.exactLength.value;
    res.maxItems = def.exactLength.value;
  }
  return res;
}
function parseBigintDef(def) {
  const res = {
    type: "integer",
    format: "int64"
  };
  if (!def.checks)
    return res;
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "min":
        if (check2.inclusive) {
          res.minimum = check2.value;
        } else {
          res.exclusiveMinimum = check2.value;
        }
        break;
      case "max":
        if (check2.inclusive) {
          res.maximum = check2.value;
        } else {
          res.exclusiveMaximum = check2.value;
        }
        break;
      case "multipleOf":
        res.multipleOf = check2.value;
        break;
    }
  }
  return res;
}
function parseBooleanDef() {
  return { type: "boolean" };
}
function parseBrandedDef(_def, refs) {
  return parseDef(_def.type._def, refs);
}
var parseCatchDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};
function parseDateDef(def, refs, overrideDateStrategy) {
  const strategy = overrideDateStrategy != null ? overrideDateStrategy : refs.dateStrategy;
  if (Array.isArray(strategy)) {
    return {
      anyOf: strategy.map((item, i) => parseDateDef(def, refs, item))
    };
  }
  switch (strategy) {
    case "string":
    case "format:date-time":
      return {
        type: "string",
        format: "date-time"
      };
    case "format:date":
      return {
        type: "string",
        format: "date"
      };
    case "integer":
      return integerDateParser(def);
  }
}
var integerDateParser = (def) => {
  const res = {
    type: "integer",
    format: "unix-time"
  };
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "min":
        res.minimum = check2.value;
        break;
      case "max":
        res.maximum = check2.value;
        break;
    }
  }
  return res;
};
function parseDefaultDef(_def, refs) {
  return {
    ...parseDef(_def.innerType._def, refs),
    default: _def.defaultValue()
  };
}
function parseEffectsDef(_def, refs) {
  return refs.effectStrategy === "input" ? parseDef(_def.schema._def, refs) : parseAnyDef();
}
function parseEnumDef(def) {
  return {
    type: "string",
    enum: Array.from(def.values)
  };
}
var isJsonSchema7AllOfType = (type) => {
  if ("type" in type && type.type === "string")
    return false;
  return "allOf" in type;
};
function parseIntersectionDef(def, refs) {
  const allOf = [
    parseDef(def.left._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "0"]
    }),
    parseDef(def.right._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "1"]
    })
  ].filter((x) => !!x);
  const mergedAllOf = [];
  allOf.forEach((schema) => {
    if (isJsonSchema7AllOfType(schema)) {
      mergedAllOf.push(...schema.allOf);
    } else {
      let nestedSchema = schema;
      if ("additionalProperties" in schema && schema.additionalProperties === false) {
        const { additionalProperties, ...rest } = schema;
        nestedSchema = rest;
      }
      mergedAllOf.push(nestedSchema);
    }
  });
  return mergedAllOf.length ? { allOf: mergedAllOf } : undefined;
}
function parseLiteralDef(def) {
  const parsedType7 = typeof def.value;
  if (parsedType7 !== "bigint" && parsedType7 !== "number" && parsedType7 !== "boolean" && parsedType7 !== "string") {
    return {
      type: Array.isArray(def.value) ? "array" : "object"
    };
  }
  return {
    type: parsedType7 === "bigint" ? "integer" : parsedType7,
    const: def.value
  };
}
var emojiRegex2 = undefined;
var zodPatterns = {
  cuid: /^[cC][^\s-]{8,}$/,
  cuid2: /^[0-9a-z]+$/,
  ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/,
  emoji: () => {
    if (emojiRegex2 === undefined) {
      emojiRegex2 = RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
    }
    return emojiRegex2;
  },
  uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  ipv4Cidr: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/,
  ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
  ipv6Cidr: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,
  base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
  base64url: /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/,
  nanoid: /^[a-zA-Z0-9_-]{21}$/,
  jwt: /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/
};
function parseStringDef(def, refs) {
  const res = {
    type: "string"
  };
  if (def.checks) {
    for (const check2 of def.checks) {
      switch (check2.kind) {
        case "min":
          res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check2.value) : check2.value;
          break;
        case "max":
          res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check2.value) : check2.value;
          break;
        case "email":
          switch (refs.emailStrategy) {
            case "format:email":
              addFormat(res, "email", check2.message, refs);
              break;
            case "format:idn-email":
              addFormat(res, "idn-email", check2.message, refs);
              break;
            case "pattern:zod":
              addPattern(res, zodPatterns.email, check2.message, refs);
              break;
          }
          break;
        case "url":
          addFormat(res, "uri", check2.message, refs);
          break;
        case "uuid":
          addFormat(res, "uuid", check2.message, refs);
          break;
        case "regex":
          addPattern(res, check2.regex, check2.message, refs);
          break;
        case "cuid":
          addPattern(res, zodPatterns.cuid, check2.message, refs);
          break;
        case "cuid2":
          addPattern(res, zodPatterns.cuid2, check2.message, refs);
          break;
        case "startsWith":
          addPattern(res, RegExp(`^${escapeLiteralCheckValue(check2.value, refs)}`), check2.message, refs);
          break;
        case "endsWith":
          addPattern(res, RegExp(`${escapeLiteralCheckValue(check2.value, refs)}$`), check2.message, refs);
          break;
        case "datetime":
          addFormat(res, "date-time", check2.message, refs);
          break;
        case "date":
          addFormat(res, "date", check2.message, refs);
          break;
        case "time":
          addFormat(res, "time", check2.message, refs);
          break;
        case "duration":
          addFormat(res, "duration", check2.message, refs);
          break;
        case "length":
          res.minLength = typeof res.minLength === "number" ? Math.max(res.minLength, check2.value) : check2.value;
          res.maxLength = typeof res.maxLength === "number" ? Math.min(res.maxLength, check2.value) : check2.value;
          break;
        case "includes": {
          addPattern(res, RegExp(escapeLiteralCheckValue(check2.value, refs)), check2.message, refs);
          break;
        }
        case "ip": {
          if (check2.version !== "v6") {
            addFormat(res, "ipv4", check2.message, refs);
          }
          if (check2.version !== "v4") {
            addFormat(res, "ipv6", check2.message, refs);
          }
          break;
        }
        case "base64url":
          addPattern(res, zodPatterns.base64url, check2.message, refs);
          break;
        case "jwt":
          addPattern(res, zodPatterns.jwt, check2.message, refs);
          break;
        case "cidr": {
          if (check2.version !== "v6") {
            addPattern(res, zodPatterns.ipv4Cidr, check2.message, refs);
          }
          if (check2.version !== "v4") {
            addPattern(res, zodPatterns.ipv6Cidr, check2.message, refs);
          }
          break;
        }
        case "emoji":
          addPattern(res, zodPatterns.emoji(), check2.message, refs);
          break;
        case "ulid": {
          addPattern(res, zodPatterns.ulid, check2.message, refs);
          break;
        }
        case "base64": {
          switch (refs.base64Strategy) {
            case "format:binary": {
              addFormat(res, "binary", check2.message, refs);
              break;
            }
            case "contentEncoding:base64": {
              res.contentEncoding = "base64";
              break;
            }
            case "pattern:zod": {
              addPattern(res, zodPatterns.base64, check2.message, refs);
              break;
            }
          }
          break;
        }
        case "nanoid": {
          addPattern(res, zodPatterns.nanoid, check2.message, refs);
        }
        case "toLowerCase":
        case "toUpperCase":
        case "trim":
          break;
        default:
      }
    }
  }
  return res;
}
function escapeLiteralCheckValue(literal2, refs) {
  return refs.patternStrategy === "escape" ? escapeNonAlphaNumeric(literal2) : literal2;
}
var ALPHA_NUMERIC = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
function escapeNonAlphaNumeric(source) {
  let result = "";
  for (let i = 0;i < source.length; i++) {
    if (!ALPHA_NUMERIC.has(source[i])) {
      result += "\\";
    }
    result += source[i];
  }
  return result;
}
function addFormat(schema, value, message, refs) {
  var _a22;
  if (schema.format || ((_a22 = schema.anyOf) == null ? undefined : _a22.some((x) => x.format))) {
    if (!schema.anyOf) {
      schema.anyOf = [];
    }
    if (schema.format) {
      schema.anyOf.push({
        format: schema.format
      });
      delete schema.format;
    }
    schema.anyOf.push({
      format: value,
      ...message && refs.errorMessages && { errorMessage: { format: message } }
    });
  } else {
    schema.format = value;
  }
}
function addPattern(schema, regex, message, refs) {
  var _a22;
  if (schema.pattern || ((_a22 = schema.allOf) == null ? undefined : _a22.some((x) => x.pattern))) {
    if (!schema.allOf) {
      schema.allOf = [];
    }
    if (schema.pattern) {
      schema.allOf.push({
        pattern: schema.pattern
      });
      delete schema.pattern;
    }
    schema.allOf.push({
      pattern: stringifyRegExpWithFlags(regex, refs),
      ...message && refs.errorMessages && { errorMessage: { pattern: message } }
    });
  } else {
    schema.pattern = stringifyRegExpWithFlags(regex, refs);
  }
}
function stringifyRegExpWithFlags(regex, refs) {
  var _a22;
  if (!refs.applyRegexFlags || !regex.flags) {
    return regex.source;
  }
  const flags = {
    i: regex.flags.includes("i"),
    m: regex.flags.includes("m"),
    s: regex.flags.includes("s")
  };
  const source = flags.i ? regex.source.toLowerCase() : regex.source;
  let pattern = "";
  let isEscaped = false;
  let inCharGroup = false;
  let inCharRange = false;
  for (let i = 0;i < source.length; i++) {
    if (isEscaped) {
      pattern += source[i];
      isEscaped = false;
      continue;
    }
    if (flags.i) {
      if (inCharGroup) {
        if (source[i].match(/[a-z]/)) {
          if (inCharRange) {
            pattern += source[i];
            pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
            inCharRange = false;
          } else if (source[i + 1] === "-" && ((_a22 = source[i + 2]) == null ? undefined : _a22.match(/[a-z]/))) {
            pattern += source[i];
            inCharRange = true;
          } else {
            pattern += `${source[i]}${source[i].toUpperCase()}`;
          }
          continue;
        }
      } else if (source[i].match(/[a-z]/)) {
        pattern += `[${source[i]}${source[i].toUpperCase()}]`;
        continue;
      }
    }
    if (flags.m) {
      if (source[i] === "^") {
        pattern += `(^|(?<=[\r
]))`;
        continue;
      } else if (source[i] === "$") {
        pattern += `($|(?=[\r
]))`;
        continue;
      }
    }
    if (flags.s && source[i] === ".") {
      pattern += inCharGroup ? `${source[i]}\r
` : `[${source[i]}\r
]`;
      continue;
    }
    pattern += source[i];
    if (source[i] === "\\") {
      isEscaped = true;
    } else if (inCharGroup && source[i] === "]") {
      inCharGroup = false;
    } else if (!inCharGroup && source[i] === "[") {
      inCharGroup = true;
    }
  }
  try {
    new RegExp(pattern);
  } catch (e) {
    console.warn(`Could not convert regex pattern at ${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source`);
    return regex.source;
  }
  return pattern;
}
function parseRecordDef(def, refs) {
  var _a22, _b22, _c, _d, _e, _f;
  const schema = {
    type: "object",
    additionalProperties: (_a22 = parseDef(def.valueType._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    })) != null ? _a22 : refs.allowedAdditionalProperties
  };
  if (((_b22 = def.keyType) == null ? undefined : _b22._def.typeName) === ZodFirstPartyTypeKind2.ZodString && ((_c = def.keyType._def.checks) == null ? undefined : _c.length)) {
    const { type, ...keyType } = parseStringDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  } else if (((_d = def.keyType) == null ? undefined : _d._def.typeName) === ZodFirstPartyTypeKind2.ZodEnum) {
    return {
      ...schema,
      propertyNames: {
        enum: def.keyType._def.values
      }
    };
  } else if (((_e = def.keyType) == null ? undefined : _e._def.typeName) === ZodFirstPartyTypeKind2.ZodBranded && def.keyType._def.type._def.typeName === ZodFirstPartyTypeKind2.ZodString && ((_f = def.keyType._def.type._def.checks) == null ? undefined : _f.length)) {
    const { type, ...keyType } = parseBrandedDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  }
  return schema;
}
function parseMapDef(def, refs) {
  if (refs.mapStrategy === "record") {
    return parseRecordDef(def, refs);
  }
  const keys = parseDef(def.keyType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "0"]
  }) || parseAnyDef();
  const values = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "1"]
  }) || parseAnyDef();
  return {
    type: "array",
    maxItems: 125,
    items: {
      type: "array",
      items: [keys, values],
      minItems: 2,
      maxItems: 2
    }
  };
}
function parseNativeEnumDef(def) {
  const object2 = def.values;
  const actualKeys = Object.keys(def.values).filter((key) => {
    return typeof object2[object2[key]] !== "number";
  });
  const actualValues = actualKeys.map((key) => object2[key]);
  const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
  return {
    type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : ["string", "number"],
    enum: actualValues
  };
}
function parseNeverDef() {
  return { not: parseAnyDef() };
}
function parseNullDef() {
  return {
    type: "null"
  };
}
var primitiveMappings = {
  ZodString: "string",
  ZodNumber: "number",
  ZodBigInt: "integer",
  ZodBoolean: "boolean",
  ZodNull: "null"
};
function parseUnionDef(def, refs) {
  const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
  if (options.every((x) => (x._def.typeName in primitiveMappings) && (!x._def.checks || !x._def.checks.length))) {
    const types = options.reduce((types2, x) => {
      const type = primitiveMappings[x._def.typeName];
      return type && !types2.includes(type) ? [...types2, type] : types2;
    }, []);
    return {
      type: types.length > 1 ? types : types[0]
    };
  } else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
    const types = options.reduce((acc, x) => {
      const type = typeof x._def.value;
      switch (type) {
        case "string":
        case "number":
        case "boolean":
          return [...acc, type];
        case "bigint":
          return [...acc, "integer"];
        case "object":
          if (x._def.value === null)
            return [...acc, "null"];
        case "symbol":
        case "undefined":
        case "function":
        default:
          return acc;
      }
    }, []);
    if (types.length === options.length) {
      const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
      return {
        type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
        enum: options.reduce((acc, x) => {
          return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
        }, [])
      };
    }
  } else if (options.every((x) => x._def.typeName === "ZodEnum")) {
    return {
      type: "string",
      enum: options.reduce((acc, x) => [
        ...acc,
        ...x._def.values.filter((x2) => !acc.includes(x2))
      ], [])
    };
  }
  return asAnyOf(def, refs);
}
var asAnyOf = (def, refs) => {
  const anyOf = (def.options instanceof Map ? Array.from(def.options.values()) : def.options).map((x, i) => parseDef(x._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", `${i}`]
  })).filter((x) => !!x && (!refs.strictUnions || typeof x === "object" && Object.keys(x).length > 0));
  return anyOf.length ? { anyOf } : undefined;
};
function parseNullableDef(def, refs) {
  if (["ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodNull"].includes(def.innerType._def.typeName) && (!def.innerType._def.checks || !def.innerType._def.checks.length)) {
    return {
      type: [
        primitiveMappings[def.innerType._def.typeName],
        "null"
      ]
    };
  }
  const base = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "0"]
  });
  return base && { anyOf: [base, { type: "null" }] };
}
function parseNumberDef(def) {
  const res = {
    type: "number"
  };
  if (!def.checks)
    return res;
  for (const check2 of def.checks) {
    switch (check2.kind) {
      case "int":
        res.type = "integer";
        break;
      case "min":
        if (check2.inclusive) {
          res.minimum = check2.value;
        } else {
          res.exclusiveMinimum = check2.value;
        }
        break;
      case "max":
        if (check2.inclusive) {
          res.maximum = check2.value;
        } else {
          res.exclusiveMaximum = check2.value;
        }
        break;
      case "multipleOf":
        res.multipleOf = check2.value;
        break;
    }
  }
  return res;
}
function parseObjectDef(def, refs) {
  const result = {
    type: "object",
    properties: {}
  };
  const required2 = [];
  const shape = def.shape();
  for (const propName in shape) {
    let propDef = shape[propName];
    if (propDef === undefined || propDef._def === undefined) {
      continue;
    }
    const propOptional = safeIsOptional(propDef);
    const parsedDef = parseDef(propDef._def, {
      ...refs,
      currentPath: [...refs.currentPath, "properties", propName],
      propertyPath: [...refs.currentPath, "properties", propName]
    });
    if (parsedDef === undefined) {
      continue;
    }
    result.properties[propName] = parsedDef;
    if (!propOptional) {
      required2.push(propName);
    }
  }
  if (required2.length) {
    result.required = required2;
  }
  const additionalProperties = decideAdditionalProperties(def, refs);
  if (additionalProperties !== undefined) {
    result.additionalProperties = additionalProperties;
  }
  return result;
}
function decideAdditionalProperties(def, refs) {
  if (def.catchall._def.typeName !== "ZodNever") {
    return parseDef(def.catchall._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    });
  }
  switch (def.unknownKeys) {
    case "passthrough":
      return refs.allowedAdditionalProperties;
    case "strict":
      return refs.rejectedAdditionalProperties;
    case "strip":
      return refs.removeAdditionalStrategy === "strict" ? refs.allowedAdditionalProperties : refs.rejectedAdditionalProperties;
  }
}
function safeIsOptional(schema) {
  try {
    return schema.isOptional();
  } catch (e) {
    return true;
  }
}
var parseOptionalDef = (def, refs) => {
  var _a22;
  if (refs.currentPath.toString() === ((_a22 = refs.propertyPath) == null ? undefined : _a22.toString())) {
    return parseDef(def.innerType._def, refs);
  }
  const innerSchema = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "1"]
  });
  return innerSchema ? { anyOf: [{ not: parseAnyDef() }, innerSchema] } : parseAnyDef();
};
var parsePipelineDef = (def, refs) => {
  if (refs.pipeStrategy === "input") {
    return parseDef(def.in._def, refs);
  } else if (refs.pipeStrategy === "output") {
    return parseDef(def.out._def, refs);
  }
  const a = parseDef(def.in._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", "0"]
  });
  const b = parseDef(def.out._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", a ? "1" : "0"]
  });
  return {
    allOf: [a, b].filter((x) => x !== undefined)
  };
};
function parsePromiseDef(def, refs) {
  return parseDef(def.type._def, refs);
}
function parseSetDef(def, refs) {
  const items = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items"]
  });
  const schema = {
    type: "array",
    uniqueItems: true,
    items
  };
  if (def.minSize) {
    schema.minItems = def.minSize.value;
  }
  if (def.maxSize) {
    schema.maxItems = def.maxSize.value;
  }
  return schema;
}
function parseTupleDef(def, refs) {
  if (def.rest) {
    return {
      type: "array",
      minItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === undefined ? acc : [...acc, x], []),
      additionalItems: parseDef(def.rest._def, {
        ...refs,
        currentPath: [...refs.currentPath, "additionalItems"]
      })
    };
  } else {
    return {
      type: "array",
      minItems: def.items.length,
      maxItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === undefined ? acc : [...acc, x], [])
    };
  }
}
function parseUndefinedDef() {
  return {
    not: parseAnyDef()
  };
}
function parseUnknownDef() {
  return parseAnyDef();
}
var parseReadonlyDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};
var selectParser = (def, typeName, refs) => {
  switch (typeName) {
    case ZodFirstPartyTypeKind2.ZodString:
      return parseStringDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodNumber:
      return parseNumberDef(def);
    case ZodFirstPartyTypeKind2.ZodObject:
      return parseObjectDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodBigInt:
      return parseBigintDef(def);
    case ZodFirstPartyTypeKind2.ZodBoolean:
      return parseBooleanDef();
    case ZodFirstPartyTypeKind2.ZodDate:
      return parseDateDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodUndefined:
      return parseUndefinedDef();
    case ZodFirstPartyTypeKind2.ZodNull:
      return parseNullDef();
    case ZodFirstPartyTypeKind2.ZodArray:
      return parseArrayDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodUnion:
    case ZodFirstPartyTypeKind2.ZodDiscriminatedUnion:
      return parseUnionDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodIntersection:
      return parseIntersectionDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodTuple:
      return parseTupleDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodRecord:
      return parseRecordDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodLiteral:
      return parseLiteralDef(def);
    case ZodFirstPartyTypeKind2.ZodEnum:
      return parseEnumDef(def);
    case ZodFirstPartyTypeKind2.ZodNativeEnum:
      return parseNativeEnumDef(def);
    case ZodFirstPartyTypeKind2.ZodNullable:
      return parseNullableDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodOptional:
      return parseOptionalDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodMap:
      return parseMapDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodSet:
      return parseSetDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodLazy:
      return () => def.getter()._def;
    case ZodFirstPartyTypeKind2.ZodPromise:
      return parsePromiseDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodNaN:
    case ZodFirstPartyTypeKind2.ZodNever:
      return parseNeverDef();
    case ZodFirstPartyTypeKind2.ZodEffects:
      return parseEffectsDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodAny:
      return parseAnyDef();
    case ZodFirstPartyTypeKind2.ZodUnknown:
      return parseUnknownDef();
    case ZodFirstPartyTypeKind2.ZodDefault:
      return parseDefaultDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodBranded:
      return parseBrandedDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodReadonly:
      return parseReadonlyDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodCatch:
      return parseCatchDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodPipeline:
      return parsePipelineDef(def, refs);
    case ZodFirstPartyTypeKind2.ZodFunction:
    case ZodFirstPartyTypeKind2.ZodVoid:
    case ZodFirstPartyTypeKind2.ZodSymbol:
      return;
    default:
      return /* @__PURE__ */ ((_) => {
        return;
      })(typeName);
  }
};
var getRelativePath = (pathA, pathB) => {
  let i = 0;
  for (;i < pathA.length && i < pathB.length; i++) {
    if (pathA[i] !== pathB[i])
      break;
  }
  return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};
function parseDef(def, refs, forceResolution = false) {
  var _a22;
  const seenItem = refs.seen.get(def);
  if (refs.override) {
    const overrideResult = (_a22 = refs.override) == null ? undefined : _a22.call(refs, def, refs, seenItem, forceResolution);
    if (overrideResult !== ignoreOverride) {
      return overrideResult;
    }
  }
  if (seenItem && !forceResolution) {
    const seenSchema = get$ref(seenItem, refs);
    if (seenSchema !== undefined) {
      return seenSchema;
    }
  }
  const newItem = { def, path: refs.currentPath, jsonSchema: undefined };
  refs.seen.set(def, newItem);
  const jsonSchemaOrGetter = selectParser(def, def.typeName, refs);
  const jsonSchema2 = typeof jsonSchemaOrGetter === "function" ? parseDef(jsonSchemaOrGetter(), refs) : jsonSchemaOrGetter;
  if (jsonSchema2) {
    addMeta(def, refs, jsonSchema2);
  }
  if (refs.postProcess) {
    const postProcessResult = refs.postProcess(jsonSchema2, def, refs);
    newItem.jsonSchema = jsonSchema2;
    return postProcessResult;
  }
  newItem.jsonSchema = jsonSchema2;
  return jsonSchema2;
}
var get$ref = (item, refs) => {
  switch (refs.$refStrategy) {
    case "root":
      return { $ref: item.path.join("/") };
    case "relative":
      return { $ref: getRelativePath(refs.currentPath, item.path) };
    case "none":
    case "seen": {
      if (item.path.length < refs.currentPath.length && item.path.every((value, index) => refs.currentPath[index] === value)) {
        console.warn(`Recursive reference detected at ${refs.currentPath.join("/")}! Defaulting to any`);
        return parseAnyDef();
      }
      return refs.$refStrategy === "seen" ? parseAnyDef() : undefined;
    }
  }
};
var addMeta = (def, refs, jsonSchema2) => {
  if (def.description) {
    jsonSchema2.description = def.description;
  }
  return jsonSchema2;
};
var getRefs = (options) => {
  const _options = getDefaultOptions(options);
  const currentPath = _options.name !== undefined ? [..._options.basePath, _options.definitionPath, _options.name] : _options.basePath;
  return {
    ..._options,
    currentPath,
    propertyPath: undefined,
    seen: new Map(Object.entries(_options.definitions).map(([name22, def]) => [
      def._def,
      {
        def: def._def,
        path: [..._options.basePath, _options.definitionPath, name22],
        jsonSchema: undefined
      }
    ]))
  };
};
var zod3ToJsonSchema = (schema, options) => {
  var _a22;
  const refs = getRefs(options);
  let definitions = typeof options === "object" && options.definitions ? Object.entries(options.definitions).reduce((acc, [name32, schema2]) => {
    var _a32;
    return {
      ...acc,
      [name32]: (_a32 = parseDef(schema2._def, {
        ...refs,
        currentPath: [...refs.basePath, refs.definitionPath, name32]
      }, true)) != null ? _a32 : parseAnyDef()
    };
  }, {}) : undefined;
  const name22 = typeof options === "string" ? options : (options == null ? undefined : options.nameStrategy) === "title" ? undefined : options == null ? undefined : options.name;
  const main = (_a22 = parseDef(schema._def, name22 === undefined ? refs : {
    ...refs,
    currentPath: [...refs.basePath, refs.definitionPath, name22]
  }, false)) != null ? _a22 : parseAnyDef();
  const title = typeof options === "object" && options.name !== undefined && options.nameStrategy === "title" ? options.name : undefined;
  if (title !== undefined) {
    main.title = title;
  }
  const combined = name22 === undefined ? definitions ? {
    ...main,
    [refs.definitionPath]: definitions
  } : main : {
    $ref: [
      ...refs.$refStrategy === "relative" ? [] : refs.basePath,
      refs.definitionPath,
      name22
    ].join("/"),
    [refs.definitionPath]: {
      ...definitions,
      [name22]: main
    }
  };
  combined.$schema = "http://json-schema.org/draft-07/schema#";
  return combined;
};
var schemaSymbol = /* @__PURE__ */ Symbol.for("vercel.ai.schema");
function jsonSchema(jsonSchema2, {
  validate
} = {}) {
  return {
    [schemaSymbol]: true,
    _type: undefined,
    get jsonSchema() {
      if (typeof jsonSchema2 === "function") {
        jsonSchema2 = jsonSchema2();
      }
      return jsonSchema2;
    },
    validate
  };
}
function isSchema(value) {
  return typeof value === "object" && value !== null && schemaSymbol in value && value[schemaSymbol] === true && "jsonSchema" in value && "validate" in value;
}
function asSchema(schema) {
  return schema == null ? jsonSchema({ properties: {}, additionalProperties: false }) : isSchema(schema) ? schema : ("~standard" in schema) ? schema["~standard"].vendor === "zod" ? zodSchema(schema) : standardSchema(schema) : schema();
}
function standardSchema(standardSchema2) {
  return jsonSchema(() => addAdditionalPropertiesToJsonSchema(standardSchema2["~standard"].jsonSchema.input({
    target: "draft-07"
  })), {
    validate: async (value) => {
      const result = await standardSchema2["~standard"].validate(value);
      return "value" in result ? { success: true, value: result.value } : {
        success: false,
        error: new TypeValidationError({
          value,
          cause: result.issues
        })
      };
    }
  });
}
function zod3Schema(zodSchema2, options) {
  var _a22;
  const useReferences = (_a22 = options == null ? undefined : options.useReferences) != null ? _a22 : false;
  return jsonSchema(() => zod3ToJsonSchema(zodSchema2, {
    $refStrategy: useReferences ? "root" : "none"
  }), {
    validate: async (value) => {
      const result = await zodSchema2.safeParseAsync(value);
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
    }
  });
}
function zod4Schema(zodSchema2, options) {
  var _a22;
  const useReferences = (_a22 = options == null ? undefined : options.useReferences) != null ? _a22 : false;
  return jsonSchema(() => addAdditionalPropertiesToJsonSchema(toJSONSchema(zodSchema2, {
    target: "draft-7",
    io: "input",
    reused: useReferences ? "ref" : "inline"
  })), {
    validate: async (value) => {
      const result = await safeParseAsync2(zodSchema2, value);
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
    }
  });
}
function isZod4Schema(zodSchema2) {
  return "_zod" in zodSchema2;
}
function zodSchema(zodSchema2, options) {
  if (isZod4Schema(zodSchema2)) {
    return zod4Schema(zodSchema2, options);
  } else {
    return zod3Schema(zodSchema2, options);
  }
}
async function validateTypes({
  value,
  schema,
  context
}) {
  const result = await safeValidateTypes({ value, schema, context });
  if (!result.success) {
    throw TypeValidationError.wrap({ value, cause: result.error, context });
  }
  return result.value;
}
async function safeValidateTypes({
  value,
  schema,
  context
}) {
  const actualSchema = asSchema(schema);
  try {
    if (actualSchema.validate == null) {
      return { success: true, value, rawValue: value };
    }
    const result = await actualSchema.validate(value);
    if (result.success) {
      return { success: true, value: result.value, rawValue: value };
    }
    return {
      success: false,
      error: TypeValidationError.wrap({ value, cause: result.error, context }),
      rawValue: value
    };
  } catch (error45) {
    return {
      success: false,
      error: TypeValidationError.wrap({ value, cause: error45, context }),
      rawValue: value
    };
  }
}
async function parseJSON({
  text,
  schema
}) {
  try {
    const value = secureJsonParse(text);
    if (schema == null) {
      return value;
    }
    return validateTypes({ value, schema });
  } catch (error45) {
    if (JSONParseError.isInstance(error45) || TypeValidationError.isInstance(error45)) {
      throw error45;
    }
    throw new JSONParseError({ text, cause: error45 });
  }
}
async function safeParseJSON({
  text,
  schema
}) {
  try {
    const value = secureJsonParse(text);
    if (schema == null) {
      return { success: true, value, rawValue: value };
    }
    return await safeValidateTypes({ value, schema });
  } catch (error45) {
    return {
      success: false,
      error: JSONParseError.isInstance(error45) ? error45 : new JSONParseError({ text, cause: error45 }),
      rawValue: undefined
    };
  }
}
function isParsableJson(input) {
  try {
    secureJsonParse(input);
    return true;
  } catch (e) {
    return false;
  }
}
function parseJsonEventStream({
  stream,
  schema
}) {
  return stream.pipeThrough(new TextDecoderStream).pipeThrough(new EventSourceParserStream).pipeThrough(new TransformStream({
    async transform({ data }, controller) {
      if (data === "[DONE]") {
        return;
      }
      controller.enqueue(await safeParseJSON({ text: data, schema }));
    }
  }));
}
async function parseProviderOptions({
  provider,
  providerOptions,
  schema
}) {
  if ((providerOptions == null ? undefined : providerOptions[provider]) == null) {
    return;
  }
  const parsedProviderOptions = await safeValidateTypes({
    value: providerOptions[provider],
    schema
  });
  if (!parsedProviderOptions.success) {
    throw new InvalidArgumentError({
      argument: "providerOptions",
      message: `invalid ${provider} provider options`,
      cause: parsedProviderOptions.error
    });
  }
  return parsedProviderOptions.value;
}
var getOriginalFetch2 = () => globalThis.fetch;
var postJsonToApi = async ({
  url: url2,
  headers,
  body,
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
}) => postToApi({
  url: url2,
  headers: {
    "Content-Type": "application/json",
    ...headers
  },
  body: {
    content: JSON.stringify(body),
    values: body
  },
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
});
var postFormDataToApi = async ({
  url: url2,
  headers,
  formData,
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
}) => postToApi({
  url: url2,
  headers,
  body: {
    content: formData,
    values: Object.fromEntries(formData.entries())
  },
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
});
var postToApi = async ({
  url: url2,
  headers = {},
  body,
  successfulResponseHandler,
  failedResponseHandler,
  abortSignal,
  fetch: fetch2 = getOriginalFetch2()
}) => {
  try {
    const response = await fetch2(url2, {
      method: "POST",
      headers: withUserAgentSuffix(headers, `ai-sdk/provider-utils/${VERSION}`, getRuntimeEnvironmentUserAgent()),
      body: body.content,
      signal: abortSignal
    });
    const responseHeaders = extractResponseHeaders(response);
    if (!response.ok) {
      let errorInformation;
      try {
        errorInformation = await failedResponseHandler({
          response,
          url: url2,
          requestBodyValues: body.values
        });
      } catch (error45) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
        throw new APICallError({
          message: "Failed to process error response",
          cause: error45,
          statusCode: response.status,
          url: url2,
          responseHeaders,
          requestBodyValues: body.values
        });
      }
      throw errorInformation.value;
    }
    try {
      return await successfulResponseHandler({
        response,
        url: url2,
        requestBodyValues: body.values
      });
    } catch (error45) {
      if (error45 instanceof Error) {
        if (isAbortError(error45) || APICallError.isInstance(error45)) {
          throw error45;
        }
      }
      throw new APICallError({
        message: "Failed to process successful response",
        cause: error45,
        statusCode: response.status,
        url: url2,
        responseHeaders,
        requestBodyValues: body.values
      });
    }
  } catch (error45) {
    throw handleFetchError({ error: error45, url: url2, requestBodyValues: body.values });
  }
};
var createJsonErrorResponseHandler = ({
  errorSchema,
  errorToMessage,
  isRetryable
}) => async ({ response, url: url2, requestBodyValues }) => {
  const responseBody = await response.text();
  const responseHeaders = extractResponseHeaders(response);
  if (responseBody.trim() === "") {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? undefined : isRetryable(response)
      })
    };
  }
  try {
    const parsedError = await parseJSON({
      text: responseBody,
      schema: errorSchema
    });
    return {
      responseHeaders,
      value: new APICallError({
        message: errorToMessage(parsedError),
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        data: parsedError,
        isRetryable: isRetryable == null ? undefined : isRetryable(response, parsedError)
      })
    };
  } catch (parseError) {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url: url2,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? undefined : isRetryable(response)
      })
    };
  }
};
var createEventSourceResponseHandler = (chunkSchema) => async ({ response }) => {
  const responseHeaders = extractResponseHeaders(response);
  if (response.body == null) {
    throw new EmptyResponseBodyError({});
  }
  return {
    responseHeaders,
    value: parseJsonEventStream({
      stream: response.body,
      schema: chunkSchema
    })
  };
};
var createJsonResponseHandler = (responseSchema) => async ({ response, url: url2, requestBodyValues }) => {
  const responseBody = await response.text();
  const parsedResult = await safeParseJSON({
    text: responseBody,
    schema: responseSchema
  });
  const responseHeaders = extractResponseHeaders(response);
  if (!parsedResult.success) {
    throw new APICallError({
      message: "Invalid JSON response",
      cause: parsedResult.error,
      statusCode: response.status,
      responseHeaders,
      responseBody,
      url: url2,
      requestBodyValues
    });
  }
  return {
    responseHeaders,
    value: parsedResult.value,
    rawValue: parsedResult.rawValue
  };
};
function withoutTrailingSlash(url2) {
  return url2 == null ? undefined : url2.replace(/\/$/, "");
}

// node_modules/@ai-sdk/openai-compatible/dist/index.mjs
function toCamelCase(str) {
  return str.replace(/[_-]([a-z])/g, (g) => g[1].toUpperCase());
}
function resolveProviderOptionsKey(rawName, providerOptions) {
  const camelName = toCamelCase(rawName);
  if (camelName !== rawName && (providerOptions == null ? undefined : providerOptions[camelName]) != null) {
    return camelName;
  }
  return rawName;
}
var openaiCompatibleErrorDataSchema = exports_external.object({
  error: exports_external.object({
    message: exports_external.string(),
    type: exports_external.string().nullish(),
    param: exports_external.any().nullish(),
    code: exports_external.union([exports_external.string(), exports_external.number()]).nullish()
  })
});
var defaultOpenAICompatibleErrorStructure = {
  errorSchema: openaiCompatibleErrorDataSchema,
  errorToMessage: (data) => data.error.message
};
function convertOpenAICompatibleChatUsage(usage) {
  var _a16, _b16, _c, _d, _e, _f;
  if (usage == null) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined
      },
      raw: undefined
    };
  }
  const promptTokens = (_a16 = usage.prompt_tokens) != null ? _a16 : 0;
  const completionTokens = (_b16 = usage.completion_tokens) != null ? _b16 : 0;
  const cacheReadTokens = (_d = (_c = usage.prompt_tokens_details) == null ? undefined : _c.cached_tokens) != null ? _d : 0;
  const reasoningTokens = (_f = (_e = usage.completion_tokens_details) == null ? undefined : _e.reasoning_tokens) != null ? _f : 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheReadTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: undefined
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens
    },
    raw: usage
  };
}
function getOpenAIMetadata(message) {
  var _a16, _b16;
  return (_b16 = (_a16 = message == null ? undefined : message.providerOptions) == null ? undefined : _a16.openaiCompatible) != null ? _b16 : {};
}
function getAudioFormat(mediaType) {
  switch (mediaType) {
    case "audio/wav":
      return "wav";
    case "audio/mp3":
    case "audio/mpeg":
      return "mp3";
    default:
      return null;
  }
}
function convertToOpenAICompatibleChatMessages(prompt) {
  var _a16, _b16, _c;
  const messages = [];
  for (const { role, content, ...message } of prompt) {
    const metadata = getOpenAIMetadata({ ...message });
    switch (role) {
      case "system": {
        messages.push({ role: "system", content, ...metadata });
        break;
      }
      case "user": {
        if (content.length === 1 && content[0].type === "text") {
          messages.push({
            role: "user",
            content: content[0].text,
            ...getOpenAIMetadata(content[0])
          });
          break;
        }
        messages.push({
          role: "user",
          content: content.map((part) => {
            var _a22;
            const partMetadata = getOpenAIMetadata(part);
            switch (part.type) {
              case "text": {
                return { type: "text", text: part.text, ...partMetadata };
              }
              case "file": {
                if (part.mediaType.startsWith("image/")) {
                  const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
                  return {
                    type: "image_url",
                    image_url: {
                      url: part.data instanceof URL ? part.data.toString() : `data:${mediaType};base64,${convertToBase64(part.data)}`
                    },
                    ...partMetadata
                  };
                }
                if (part.mediaType.startsWith("audio/")) {
                  if (part.data instanceof URL) {
                    throw new UnsupportedFunctionalityError({
                      functionality: "audio file parts with URLs"
                    });
                  }
                  const format = getAudioFormat(part.mediaType);
                  if (format === null) {
                    throw new UnsupportedFunctionalityError({
                      functionality: `audio media type ${part.mediaType}`
                    });
                  }
                  return {
                    type: "input_audio",
                    input_audio: {
                      data: convertToBase64(part.data),
                      format
                    },
                    ...partMetadata
                  };
                }
                if (part.mediaType === "application/pdf") {
                  if (part.data instanceof URL) {
                    throw new UnsupportedFunctionalityError({
                      functionality: "PDF file parts with URLs"
                    });
                  }
                  return {
                    type: "file",
                    file: {
                      filename: (_a22 = part.filename) != null ? _a22 : "document.pdf",
                      file_data: `data:application/pdf;base64,${convertToBase64(part.data)}`
                    },
                    ...partMetadata
                  };
                }
                if (part.mediaType.startsWith("text/")) {
                  const textContent = part.data instanceof URL ? part.data.toString() : typeof part.data === "string" ? new TextDecoder().decode(convertBase64ToUint8Array(part.data)) : new TextDecoder().decode(part.data);
                  return {
                    type: "text",
                    text: textContent,
                    ...partMetadata
                  };
                }
                throw new UnsupportedFunctionalityError({
                  functionality: `file part media type ${part.mediaType}`
                });
              }
            }
          }),
          ...metadata
        });
        break;
      }
      case "assistant": {
        let text = "";
        let reasoning = "";
        const toolCalls = [];
        for (const part of content) {
          const partMetadata = getOpenAIMetadata(part);
          switch (part.type) {
            case "text": {
              text += part.text;
              break;
            }
            case "reasoning": {
              reasoning += part.text;
              break;
            }
            case "tool-call": {
              const thoughtSignature = (_b16 = (_a16 = part.providerOptions) == null ? undefined : _a16.google) == null ? undefined : _b16.thoughtSignature;
              toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input)
                },
                ...partMetadata,
                ...thoughtSignature ? {
                  extra_content: {
                    google: {
                      thought_signature: String(thoughtSignature)
                    }
                  }
                } : {}
              });
              break;
            }
          }
        }
        messages.push({
          role: "assistant",
          content: text,
          ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...metadata
        });
        break;
      }
      case "tool": {
        for (const toolResponse of content) {
          if (toolResponse.type === "tool-approval-response") {
            continue;
          }
          const output = toolResponse.output;
          let contentValue;
          switch (output.type) {
            case "text":
            case "error-text":
              contentValue = output.value;
              break;
            case "execution-denied":
              contentValue = (_c = output.reason) != null ? _c : "Tool execution denied.";
              break;
            case "content":
            case "json":
            case "error-json":
              contentValue = JSON.stringify(output.value);
              break;
          }
          const toolResponseMetadata = getOpenAIMetadata(toolResponse);
          messages.push({
            role: "tool",
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
            ...toolResponseMetadata
          });
        }
        break;
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  return messages;
}
function getResponseMetadata({
  id,
  model,
  created
}) {
  return {
    id: id != null ? id : undefined,
    modelId: model != null ? model : undefined,
    timestamp: created != null ? new Date(created * 1000) : undefined
  };
}
function mapOpenAICompatibleFinishReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "function_call":
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}
var openaiCompatibleLanguageModelChatOptions = exports_external.object({
  user: exports_external.string().optional(),
  reasoningEffort: exports_external.string().optional(),
  textVerbosity: exports_external.string().optional(),
  strictJsonSchema: exports_external.boolean().optional()
});
function prepareTools({
  tools,
  toolChoice
}) {
  tools = (tools == null ? undefined : tools.length) ? tools : undefined;
  const toolWarnings = [];
  if (tools == null) {
    return { tools: undefined, toolChoice: undefined, toolWarnings };
  }
  const openaiCompatTools = [];
  for (const tool of tools) {
    if (tool.type === "provider") {
      toolWarnings.push({
        type: "unsupported",
        feature: `provider-defined tool ${tool.id}`
      });
    } else {
      openaiCompatTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          ...tool.strict != null ? { strict: tool.strict } : {}
        }
      });
    }
  }
  if (toolChoice == null) {
    return { tools: openaiCompatTools, toolChoice: undefined, toolWarnings };
  }
  const type = toolChoice.type;
  switch (type) {
    case "auto":
    case "none":
    case "required":
      return { tools: openaiCompatTools, toolChoice: type, toolWarnings };
    case "tool":
      return {
        tools: openaiCompatTools,
        toolChoice: {
          type: "function",
          function: { name: toolChoice.toolName }
        },
        toolWarnings
      };
    default: {
      const _exhaustiveCheck = type;
      throw new UnsupportedFunctionalityError({
        functionality: `tool choice type: ${_exhaustiveCheck}`
      });
    }
  }
}
var OpenAICompatibleChatLanguageModel = class {
  constructor(modelId, config2) {
    this.specificationVersion = "v3";
    var _a16, _b16;
    this.modelId = modelId;
    this.config = config2;
    const errorStructure = (_a16 = config2.errorStructure) != null ? _a16 : defaultOpenAICompatibleErrorStructure;
    this.chunkSchema = createOpenAICompatibleChatChunkSchema(errorStructure.errorSchema);
    this.failedResponseHandler = createJsonErrorResponseHandler(errorStructure);
    this.supportsStructuredOutputs = (_b16 = config2.supportsStructuredOutputs) != null ? _b16 : false;
  }
  get provider() {
    return this.config.provider;
  }
  get providerOptionsName() {
    return this.config.provider.split(".")[0].trim();
  }
  get supportedUrls() {
    var _a16, _b16, _c;
    return (_c = (_b16 = (_a16 = this.config).supportedUrls) == null ? undefined : _b16.call(_a16)) != null ? _c : {};
  }
  transformRequestBody(args) {
    var _a16, _b16, _c;
    return (_c = (_b16 = (_a16 = this.config).transformRequestBody) == null ? undefined : _b16.call(_a16, args)) != null ? _c : args;
  }
  async getArgs({
    prompt,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    providerOptions,
    stopSequences,
    responseFormat,
    seed,
    toolChoice,
    tools
  }) {
    var _a16, _b16, _c, _d, _e;
    const warnings = [];
    const deprecatedOptions = await parseProviderOptions({
      provider: "openai-compatible",
      providerOptions,
      schema: openaiCompatibleLanguageModelChatOptions
    });
    if (deprecatedOptions != null) {
      warnings.push({
        type: "other",
        message: `The 'openai-compatible' key in providerOptions is deprecated. Use 'openaiCompatible' instead.`
      });
    }
    const compatibleOptions = Object.assign(deprecatedOptions != null ? deprecatedOptions : {}, (_a16 = await parseProviderOptions({
      provider: "openaiCompatible",
      providerOptions,
      schema: openaiCompatibleLanguageModelChatOptions
    })) != null ? _a16 : {}, (_b16 = await parseProviderOptions({
      provider: this.providerOptionsName,
      providerOptions,
      schema: openaiCompatibleLanguageModelChatOptions
    })) != null ? _b16 : {}, (_c = await parseProviderOptions({
      provider: toCamelCase(this.providerOptionsName),
      providerOptions,
      schema: openaiCompatibleLanguageModelChatOptions
    })) != null ? _c : {});
    const strictJsonSchema = (_d = compatibleOptions == null ? undefined : compatibleOptions.strictJsonSchema) != null ? _d : true;
    if (topK != null) {
      warnings.push({ type: "unsupported", feature: "topK" });
    }
    if ((responseFormat == null ? undefined : responseFormat.type) === "json" && responseFormat.schema != null && !this.supportsStructuredOutputs) {
      warnings.push({
        type: "unsupported",
        feature: "responseFormat",
        details: "JSON response format schema is only supported with structuredOutputs"
      });
    }
    const {
      tools: openaiTools,
      toolChoice: openaiToolChoice,
      toolWarnings
    } = prepareTools({
      tools,
      toolChoice
    });
    const metadataKey = resolveProviderOptionsKey(this.providerOptionsName, providerOptions);
    return {
      metadataKey,
      args: {
        model: this.modelId,
        user: compatibleOptions.user,
        max_tokens: maxOutputTokens,
        temperature,
        top_p: topP,
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        response_format: (responseFormat == null ? undefined : responseFormat.type) === "json" ? this.supportsStructuredOutputs === true && responseFormat.schema != null ? {
          type: "json_schema",
          json_schema: {
            schema: responseFormat.schema,
            strict: strictJsonSchema,
            name: (_e = responseFormat.name) != null ? _e : "response",
            description: responseFormat.description
          }
        } : { type: "json_object" } : undefined,
        stop: stopSequences,
        seed,
        ...Object.fromEntries(Object.entries({
          ...providerOptions == null ? undefined : providerOptions[this.providerOptionsName],
          ...providerOptions == null ? undefined : providerOptions[toCamelCase(this.providerOptionsName)]
        }).filter(([key]) => !Object.keys(openaiCompatibleLanguageModelChatOptions.shape).includes(key))),
        reasoning_effort: compatibleOptions.reasoningEffort,
        verbosity: compatibleOptions.textVerbosity,
        messages: convertToOpenAICompatibleChatMessages(prompt),
        tools: openaiTools,
        tool_choice: openaiToolChoice
      },
      warnings: [...warnings, ...toolWarnings]
    };
  }
  async doGenerate(options) {
    var _a16, _b16, _c, _d, _e, _f, _g, _h;
    const { args, warnings, metadataKey } = await this.getArgs({ ...options });
    const transformedBody = this.transformRequestBody(args);
    const body = JSON.stringify(transformedBody);
    const {
      responseHeaders,
      value: responseBody,
      rawValue: rawResponse
    } = await postJsonToApi({
      url: this.config.url({
        path: "/chat/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body: transformedBody,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(OpenAICompatibleChatResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const choice = responseBody.choices[0];
    const content = [];
    const text = choice.message.content;
    if (text != null && text.length > 0) {
      content.push({ type: "text", text });
    }
    const reasoning = (_a16 = choice.message.reasoning_content) != null ? _a16 : choice.message.reasoning;
    if (reasoning != null && reasoning.length > 0) {
      content.push({
        type: "reasoning",
        text: reasoning
      });
    }
    if (choice.message.tool_calls != null) {
      for (const toolCall of choice.message.tool_calls) {
        const thoughtSignature = (_c = (_b16 = toolCall.extra_content) == null ? undefined : _b16.google) == null ? undefined : _c.thought_signature;
        content.push({
          type: "tool-call",
          toolCallId: (_d = toolCall.id) != null ? _d : generateId(),
          toolName: toolCall.function.name,
          input: toolCall.function.arguments,
          ...thoughtSignature ? {
            providerMetadata: {
              [metadataKey]: { thoughtSignature }
            }
          } : {}
        });
      }
    }
    const providerMetadata = {
      [metadataKey]: {},
      ...await ((_f = (_e = this.config.metadataExtractor) == null ? undefined : _e.extractMetadata) == null ? undefined : _f.call(_e, {
        parsedBody: rawResponse
      }))
    };
    const completionTokenDetails = (_g = responseBody.usage) == null ? undefined : _g.completion_tokens_details;
    if ((completionTokenDetails == null ? undefined : completionTokenDetails.accepted_prediction_tokens) != null) {
      providerMetadata[metadataKey].acceptedPredictionTokens = completionTokenDetails == null ? undefined : completionTokenDetails.accepted_prediction_tokens;
    }
    if ((completionTokenDetails == null ? undefined : completionTokenDetails.rejected_prediction_tokens) != null) {
      providerMetadata[metadataKey].rejectedPredictionTokens = completionTokenDetails == null ? undefined : completionTokenDetails.rejected_prediction_tokens;
    }
    return {
      content,
      finishReason: {
        unified: mapOpenAICompatibleFinishReason(choice.finish_reason),
        raw: (_h = choice.finish_reason) != null ? _h : undefined
      },
      usage: convertOpenAICompatibleChatUsage(responseBody.usage),
      providerMetadata,
      request: { body },
      response: {
        ...getResponseMetadata(responseBody),
        headers: responseHeaders,
        body: rawResponse
      },
      warnings
    };
  }
  async doStream(options) {
    var _a16;
    const { args, warnings, metadataKey } = await this.getArgs({ ...options });
    const body = this.transformRequestBody({
      ...args,
      stream: true,
      stream_options: this.config.includeUsage ? { include_usage: true } : undefined
    });
    const metadataExtractor = (_a16 = this.config.metadataExtractor) == null ? undefined : _a16.createStreamExtractor();
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/chat/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(this.chunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const toolCalls = [];
    let finishReason = {
      unified: "other",
      raw: undefined
    };
    let usage = undefined;
    let isFirstChunk = true;
    const providerOptionsName = metadataKey;
    let isActiveReasoning = false;
    let isActiveText = false;
    return {
      stream: response.pipeThrough(new TransformStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
        },
        transform(chunk, controller) {
          var _a22, _b16, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: chunk.rawValue });
          }
          if (!chunk.success) {
            finishReason = { unified: "error", raw: undefined };
            controller.enqueue({ type: "error", error: chunk.error });
            return;
          }
          metadataExtractor == null || metadataExtractor.processChunk(chunk.rawValue);
          if ("error" in chunk.value) {
            finishReason = { unified: "error", raw: undefined };
            controller.enqueue({
              type: "error",
              error: chunk.value.error.message
            });
            return;
          }
          const value = chunk.value;
          if (isFirstChunk) {
            isFirstChunk = false;
            controller.enqueue({
              type: "response-metadata",
              ...getResponseMetadata(value)
            });
          }
          if (value.usage != null) {
            usage = value.usage;
          }
          const choice = value.choices[0];
          if ((choice == null ? undefined : choice.finish_reason) != null) {
            finishReason = {
              unified: mapOpenAICompatibleFinishReason(choice.finish_reason),
              raw: (_a22 = choice.finish_reason) != null ? _a22 : undefined
            };
          }
          if ((choice == null ? undefined : choice.delta) == null) {
            return;
          }
          const delta = choice.delta;
          const reasoningContent = (_b16 = delta.reasoning_content) != null ? _b16 : delta.reasoning;
          if (reasoningContent) {
            if (!isActiveReasoning) {
              controller.enqueue({
                type: "reasoning-start",
                id: "reasoning-0"
              });
              isActiveReasoning = true;
            }
            controller.enqueue({
              type: "reasoning-delta",
              id: "reasoning-0",
              delta: reasoningContent
            });
          }
          if (delta.content) {
            if (isActiveReasoning) {
              controller.enqueue({
                type: "reasoning-end",
                id: "reasoning-0"
              });
              isActiveReasoning = false;
            }
            if (!isActiveText) {
              controller.enqueue({ type: "text-start", id: "txt-0" });
              isActiveText = true;
            }
            controller.enqueue({
              type: "text-delta",
              id: "txt-0",
              delta: delta.content
            });
          }
          if (delta.tool_calls != null) {
            if (isActiveReasoning) {
              controller.enqueue({
                type: "reasoning-end",
                id: "reasoning-0"
              });
              isActiveReasoning = false;
            }
            for (const toolCallDelta of delta.tool_calls) {
              const index = (_c = toolCallDelta.index) != null ? _c : toolCalls.length;
              if (toolCalls[index] == null) {
                if (toolCallDelta.id == null) {
                  throw new InvalidResponseDataError({
                    data: toolCallDelta,
                    message: `Expected 'id' to be a string.`
                  });
                }
                if (((_d = toolCallDelta.function) == null ? undefined : _d.name) == null) {
                  throw new InvalidResponseDataError({
                    data: toolCallDelta,
                    message: `Expected 'function.name' to be a string.`
                  });
                }
                controller.enqueue({
                  type: "tool-input-start",
                  id: toolCallDelta.id,
                  toolName: toolCallDelta.function.name
                });
                toolCalls[index] = {
                  id: toolCallDelta.id,
                  type: "function",
                  function: {
                    name: toolCallDelta.function.name,
                    arguments: (_e = toolCallDelta.function.arguments) != null ? _e : ""
                  },
                  hasFinished: false,
                  thoughtSignature: (_h = (_g = (_f = toolCallDelta.extra_content) == null ? undefined : _f.google) == null ? undefined : _g.thought_signature) != null ? _h : undefined
                };
                const toolCall2 = toolCalls[index];
                if (((_i = toolCall2.function) == null ? undefined : _i.name) != null && ((_j = toolCall2.function) == null ? undefined : _j.arguments) != null) {
                  if (toolCall2.function.arguments.length > 0) {
                    controller.enqueue({
                      type: "tool-input-delta",
                      id: toolCall2.id,
                      delta: toolCall2.function.arguments
                    });
                  }
                  if (isParsableJson(toolCall2.function.arguments)) {
                    controller.enqueue({
                      type: "tool-input-end",
                      id: toolCall2.id
                    });
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: (_k = toolCall2.id) != null ? _k : generateId(),
                      toolName: toolCall2.function.name,
                      input: toolCall2.function.arguments,
                      ...toolCall2.thoughtSignature ? {
                        providerMetadata: {
                          [providerOptionsName]: {
                            thoughtSignature: toolCall2.thoughtSignature
                          }
                        }
                      } : {}
                    });
                    toolCall2.hasFinished = true;
                  }
                }
                continue;
              }
              const toolCall = toolCalls[index];
              if (toolCall.hasFinished) {
                continue;
              }
              if (((_l = toolCallDelta.function) == null ? undefined : _l.arguments) != null) {
                toolCall.function.arguments += (_n = (_m = toolCallDelta.function) == null ? undefined : _m.arguments) != null ? _n : "";
              }
              controller.enqueue({
                type: "tool-input-delta",
                id: toolCall.id,
                delta: (_o = toolCallDelta.function.arguments) != null ? _o : ""
              });
              if (((_p = toolCall.function) == null ? undefined : _p.name) != null && ((_q = toolCall.function) == null ? undefined : _q.arguments) != null && isParsableJson(toolCall.function.arguments)) {
                controller.enqueue({
                  type: "tool-input-end",
                  id: toolCall.id
                });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: (_r = toolCall.id) != null ? _r : generateId(),
                  toolName: toolCall.function.name,
                  input: toolCall.function.arguments,
                  ...toolCall.thoughtSignature ? {
                    providerMetadata: {
                      [providerOptionsName]: {
                        thoughtSignature: toolCall.thoughtSignature
                      }
                    }
                  } : {}
                });
                toolCall.hasFinished = true;
              }
            }
          }
        },
        flush(controller) {
          var _a22, _b16, _c, _d, _e;
          if (isActiveReasoning) {
            controller.enqueue({ type: "reasoning-end", id: "reasoning-0" });
          }
          if (isActiveText) {
            controller.enqueue({ type: "text-end", id: "txt-0" });
          }
          for (const toolCall of toolCalls.filter((toolCall2) => !toolCall2.hasFinished)) {
            controller.enqueue({
              type: "tool-input-end",
              id: toolCall.id
            });
            controller.enqueue({
              type: "tool-call",
              toolCallId: (_a22 = toolCall.id) != null ? _a22 : generateId(),
              toolName: toolCall.function.name,
              input: toolCall.function.arguments,
              ...toolCall.thoughtSignature ? {
                providerMetadata: {
                  [providerOptionsName]: {
                    thoughtSignature: toolCall.thoughtSignature
                  }
                }
              } : {}
            });
          }
          const providerMetadata = {
            [providerOptionsName]: {},
            ...metadataExtractor == null ? undefined : metadataExtractor.buildMetadata()
          };
          if (((_b16 = usage == null ? undefined : usage.completion_tokens_details) == null ? undefined : _b16.accepted_prediction_tokens) != null) {
            providerMetadata[providerOptionsName].acceptedPredictionTokens = (_c = usage == null ? undefined : usage.completion_tokens_details) == null ? undefined : _c.accepted_prediction_tokens;
          }
          if (((_d = usage == null ? undefined : usage.completion_tokens_details) == null ? undefined : _d.rejected_prediction_tokens) != null) {
            providerMetadata[providerOptionsName].rejectedPredictionTokens = (_e = usage == null ? undefined : usage.completion_tokens_details) == null ? undefined : _e.rejected_prediction_tokens;
          }
          controller.enqueue({
            type: "finish",
            finishReason,
            usage: convertOpenAICompatibleChatUsage(usage),
            providerMetadata
          });
        }
      })),
      request: { body },
      response: { headers: responseHeaders }
    };
  }
};
var openaiCompatibleTokenUsageSchema = exports_external.looseObject({
  prompt_tokens: exports_external.number().nullish(),
  completion_tokens: exports_external.number().nullish(),
  total_tokens: exports_external.number().nullish(),
  prompt_tokens_details: exports_external.object({
    cached_tokens: exports_external.number().nullish()
  }).nullish(),
  completion_tokens_details: exports_external.object({
    reasoning_tokens: exports_external.number().nullish(),
    accepted_prediction_tokens: exports_external.number().nullish(),
    rejected_prediction_tokens: exports_external.number().nullish()
  }).nullish()
}).nullish();
var OpenAICompatibleChatResponseSchema = exports_external.looseObject({
  id: exports_external.string().nullish(),
  created: exports_external.number().nullish(),
  model: exports_external.string().nullish(),
  choices: exports_external.array(exports_external.object({
    message: exports_external.object({
      role: exports_external.literal("assistant").nullish(),
      content: exports_external.string().nullish(),
      reasoning_content: exports_external.string().nullish(),
      reasoning: exports_external.string().nullish(),
      tool_calls: exports_external.array(exports_external.object({
        id: exports_external.string().nullish(),
        function: exports_external.object({
          name: exports_external.string(),
          arguments: exports_external.string()
        }),
        extra_content: exports_external.object({
          google: exports_external.object({
            thought_signature: exports_external.string().nullish()
          }).nullish()
        }).nullish()
      })).nullish()
    }),
    finish_reason: exports_external.string().nullish()
  })),
  usage: openaiCompatibleTokenUsageSchema
});
var chunkBaseSchema = exports_external.looseObject({
  id: exports_external.string().nullish(),
  created: exports_external.number().nullish(),
  model: exports_external.string().nullish(),
  choices: exports_external.array(exports_external.object({
    delta: exports_external.object({
      role: exports_external.enum(["assistant"]).nullish(),
      content: exports_external.string().nullish(),
      reasoning_content: exports_external.string().nullish(),
      reasoning: exports_external.string().nullish(),
      tool_calls: exports_external.array(exports_external.object({
        index: exports_external.number().nullish(),
        id: exports_external.string().nullish(),
        function: exports_external.object({
          name: exports_external.string().nullish(),
          arguments: exports_external.string().nullish()
        }),
        extra_content: exports_external.object({
          google: exports_external.object({
            thought_signature: exports_external.string().nullish()
          }).nullish()
        }).nullish()
      })).nullish()
    }).nullish(),
    finish_reason: exports_external.string().nullish()
  })),
  usage: openaiCompatibleTokenUsageSchema
});
var createOpenAICompatibleChatChunkSchema = (errorSchema) => exports_external.union([chunkBaseSchema, errorSchema]);
function convertOpenAICompatibleCompletionUsage(usage) {
  var _a16, _b16;
  if (usage == null) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined
      },
      raw: undefined
    };
  }
  const promptTokens = (_a16 = usage.prompt_tokens) != null ? _a16 : 0;
  const completionTokens = (_b16 = usage.completion_tokens) != null ? _b16 : 0;
  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens,
      reasoning: undefined
    },
    raw: usage
  };
}
function convertToOpenAICompatibleCompletionPrompt({
  prompt,
  user = "user",
  assistant = "assistant"
}) {
  let text = "";
  if (prompt[0].role === "system") {
    text += `${prompt[0].content}

`;
    prompt = prompt.slice(1);
  }
  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        throw new InvalidPromptError({
          message: "Unexpected system message in prompt: ${content}",
          prompt
        });
      }
      case "user": {
        const userMessage = content.map((part) => {
          switch (part.type) {
            case "text": {
              return part.text;
            }
          }
        }).filter(Boolean).join("");
        text += `${user}:
${userMessage}

`;
        break;
      }
      case "assistant": {
        const assistantMessage = content.map((part) => {
          switch (part.type) {
            case "text": {
              return part.text;
            }
            case "tool-call": {
              throw new UnsupportedFunctionalityError({
                functionality: "tool-call messages"
              });
            }
          }
        }).join("");
        text += `${assistant}:
${assistantMessage}

`;
        break;
      }
      case "tool": {
        throw new UnsupportedFunctionalityError({
          functionality: "tool messages"
        });
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  text += `${assistant}:
`;
  return {
    prompt: text,
    stopSequences: [`
${user}:`]
  };
}
function getResponseMetadata2({
  id,
  model,
  created
}) {
  return {
    id: id != null ? id : undefined,
    modelId: model != null ? model : undefined,
    timestamp: created != null ? new Date(created * 1000) : undefined
  };
}
function mapOpenAICompatibleFinishReason2(finishReason) {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "function_call":
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}
var openaiCompatibleLanguageModelCompletionOptions = exports_external.object({
  echo: exports_external.boolean().optional(),
  logitBias: exports_external.record(exports_external.string(), exports_external.number()).optional(),
  suffix: exports_external.string().optional(),
  user: exports_external.string().optional()
});
var OpenAICompatibleCompletionLanguageModel = class {
  constructor(modelId, config2) {
    this.specificationVersion = "v3";
    var _a16;
    this.modelId = modelId;
    this.config = config2;
    const errorStructure = (_a16 = config2.errorStructure) != null ? _a16 : defaultOpenAICompatibleErrorStructure;
    this.chunkSchema = createOpenAICompatibleCompletionChunkSchema(errorStructure.errorSchema);
    this.failedResponseHandler = createJsonErrorResponseHandler(errorStructure);
  }
  get provider() {
    return this.config.provider;
  }
  get providerOptionsName() {
    return this.config.provider.split(".")[0].trim();
  }
  get supportedUrls() {
    var _a16, _b16, _c;
    return (_c = (_b16 = (_a16 = this.config).supportedUrls) == null ? undefined : _b16.call(_a16)) != null ? _c : {};
  }
  async getArgs({
    prompt,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences: userStopSequences,
    responseFormat,
    seed,
    providerOptions,
    tools,
    toolChoice
  }) {
    var _a16, _b16;
    const warnings = [];
    const completionOptions = Object.assign((_a16 = await parseProviderOptions({
      provider: this.providerOptionsName,
      providerOptions,
      schema: openaiCompatibleLanguageModelCompletionOptions
    })) != null ? _a16 : {}, (_b16 = await parseProviderOptions({
      provider: toCamelCase(this.providerOptionsName),
      providerOptions,
      schema: openaiCompatibleLanguageModelCompletionOptions
    })) != null ? _b16 : {});
    if (topK != null) {
      warnings.push({ type: "unsupported", feature: "topK" });
    }
    if (tools == null ? undefined : tools.length) {
      warnings.push({ type: "unsupported", feature: "tools" });
    }
    if (toolChoice != null) {
      warnings.push({ type: "unsupported", feature: "toolChoice" });
    }
    if (responseFormat != null && responseFormat.type !== "text") {
      warnings.push({
        type: "unsupported",
        feature: "responseFormat",
        details: "JSON response format is not supported."
      });
    }
    const { prompt: completionPrompt, stopSequences } = convertToOpenAICompatibleCompletionPrompt({ prompt });
    const stop = [...stopSequences != null ? stopSequences : [], ...userStopSequences != null ? userStopSequences : []];
    return {
      args: {
        model: this.modelId,
        echo: completionOptions.echo,
        logit_bias: completionOptions.logitBias,
        suffix: completionOptions.suffix,
        user: completionOptions.user,
        max_tokens: maxOutputTokens,
        temperature,
        top_p: topP,
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        seed,
        ...providerOptions == null ? undefined : providerOptions[this.providerOptionsName],
        ...providerOptions == null ? undefined : providerOptions[toCamelCase(this.providerOptionsName)],
        prompt: completionPrompt,
        stop: stop.length > 0 ? stop : undefined
      },
      warnings
    };
  }
  async doGenerate(options) {
    const { args, warnings } = await this.getArgs(options);
    const {
      responseHeaders,
      value: response,
      rawValue: rawResponse
    } = await postJsonToApi({
      url: this.config.url({
        path: "/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body: args,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(openaiCompatibleCompletionResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const choice = response.choices[0];
    const content = [];
    if (choice.text != null && choice.text.length > 0) {
      content.push({ type: "text", text: choice.text });
    }
    return {
      content,
      usage: convertOpenAICompatibleCompletionUsage(response.usage),
      finishReason: {
        unified: mapOpenAICompatibleFinishReason2(choice.finish_reason),
        raw: choice.finish_reason
      },
      request: { body: args },
      response: {
        ...getResponseMetadata2(response),
        headers: responseHeaders,
        body: rawResponse
      },
      warnings
    };
  }
  async doStream(options) {
    const { args, warnings } = await this.getArgs(options);
    const body = {
      ...args,
      stream: true,
      stream_options: this.config.includeUsage ? { include_usage: true } : undefined
    };
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: this.failedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(this.chunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    let finishReason = {
      unified: "other",
      raw: undefined
    };
    let usage = undefined;
    let isFirstChunk = true;
    return {
      stream: response.pipeThrough(new TransformStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
        },
        transform(chunk, controller) {
          var _a16;
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: chunk.rawValue });
          }
          if (!chunk.success) {
            finishReason = { unified: "error", raw: undefined };
            controller.enqueue({ type: "error", error: chunk.error });
            return;
          }
          const value = chunk.value;
          if ("error" in value) {
            finishReason = { unified: "error", raw: undefined };
            controller.enqueue({ type: "error", error: value.error });
            return;
          }
          if (isFirstChunk) {
            isFirstChunk = false;
            controller.enqueue({
              type: "response-metadata",
              ...getResponseMetadata2(value)
            });
            controller.enqueue({
              type: "text-start",
              id: "0"
            });
          }
          if (value.usage != null) {
            usage = value.usage;
          }
          const choice = value.choices[0];
          if ((choice == null ? undefined : choice.finish_reason) != null) {
            finishReason = {
              unified: mapOpenAICompatibleFinishReason2(choice.finish_reason),
              raw: (_a16 = choice.finish_reason) != null ? _a16 : undefined
            };
          }
          if ((choice == null ? undefined : choice.text) != null) {
            controller.enqueue({
              type: "text-delta",
              id: "0",
              delta: choice.text
            });
          }
        },
        flush(controller) {
          if (!isFirstChunk) {
            controller.enqueue({ type: "text-end", id: "0" });
          }
          controller.enqueue({
            type: "finish",
            finishReason,
            usage: convertOpenAICompatibleCompletionUsage(usage)
          });
        }
      })),
      request: { body },
      response: { headers: responseHeaders }
    };
  }
};
var usageSchema = exports_external.object({
  prompt_tokens: exports_external.number(),
  completion_tokens: exports_external.number(),
  total_tokens: exports_external.number()
});
var openaiCompatibleCompletionResponseSchema = exports_external.object({
  id: exports_external.string().nullish(),
  created: exports_external.number().nullish(),
  model: exports_external.string().nullish(),
  choices: exports_external.array(exports_external.object({
    text: exports_external.string(),
    finish_reason: exports_external.string()
  })),
  usage: usageSchema.nullish()
});
var createOpenAICompatibleCompletionChunkSchema = (errorSchema) => exports_external.union([
  exports_external.object({
    id: exports_external.string().nullish(),
    created: exports_external.number().nullish(),
    model: exports_external.string().nullish(),
    choices: exports_external.array(exports_external.object({
      text: exports_external.string(),
      finish_reason: exports_external.string().nullish(),
      index: exports_external.number()
    })),
    usage: usageSchema.nullish()
  }),
  errorSchema
]);
var openaiCompatibleEmbeddingModelOptions = exports_external.object({
  dimensions: exports_external.number().optional(),
  user: exports_external.string().optional()
});
var OpenAICompatibleEmbeddingModel = class {
  constructor(modelId, config2) {
    this.specificationVersion = "v3";
    this.modelId = modelId;
    this.config = config2;
  }
  get provider() {
    return this.config.provider;
  }
  get maxEmbeddingsPerCall() {
    var _a16;
    return (_a16 = this.config.maxEmbeddingsPerCall) != null ? _a16 : 2048;
  }
  get supportsParallelCalls() {
    var _a16;
    return (_a16 = this.config.supportsParallelCalls) != null ? _a16 : true;
  }
  get providerOptionsName() {
    return this.config.provider.split(".")[0].trim();
  }
  async doEmbed({
    values,
    headers,
    abortSignal,
    providerOptions
  }) {
    var _a16, _b16, _c;
    const warnings = [];
    const deprecatedOptions = await parseProviderOptions({
      provider: "openai-compatible",
      providerOptions,
      schema: openaiCompatibleEmbeddingModelOptions
    });
    if (deprecatedOptions != null) {
      warnings.push({
        type: "other",
        message: `The 'openai-compatible' key in providerOptions is deprecated. Use 'openaiCompatible' instead.`
      });
    }
    const compatibleOptions = Object.assign(deprecatedOptions != null ? deprecatedOptions : {}, (_a16 = await parseProviderOptions({
      provider: "openaiCompatible",
      providerOptions,
      schema: openaiCompatibleEmbeddingModelOptions
    })) != null ? _a16 : {}, (_b16 = await parseProviderOptions({
      provider: this.providerOptionsName,
      providerOptions,
      schema: openaiCompatibleEmbeddingModelOptions
    })) != null ? _b16 : {});
    if (values.length > this.maxEmbeddingsPerCall) {
      throw new TooManyEmbeddingValuesForCallError({
        provider: this.provider,
        modelId: this.modelId,
        maxEmbeddingsPerCall: this.maxEmbeddingsPerCall,
        values
      });
    }
    const {
      responseHeaders,
      value: response,
      rawValue
    } = await postJsonToApi({
      url: this.config.url({
        path: "/embeddings",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), headers),
      body: {
        model: this.modelId,
        input: values,
        encoding_format: "float",
        dimensions: compatibleOptions.dimensions,
        user: compatibleOptions.user
      },
      failedResponseHandler: createJsonErrorResponseHandler((_c = this.config.errorStructure) != null ? _c : defaultOpenAICompatibleErrorStructure),
      successfulResponseHandler: createJsonResponseHandler(openaiTextEmbeddingResponseSchema),
      abortSignal,
      fetch: this.config.fetch
    });
    return {
      warnings,
      embeddings: response.data.map((item) => item.embedding),
      usage: response.usage ? { tokens: response.usage.prompt_tokens } : undefined,
      providerMetadata: response.providerMetadata,
      response: { headers: responseHeaders, body: rawValue }
    };
  }
};
var openaiTextEmbeddingResponseSchema = exports_external.object({
  data: exports_external.array(exports_external.object({ embedding: exports_external.array(exports_external.number()) })),
  usage: exports_external.object({ prompt_tokens: exports_external.number() }).nullish(),
  providerMetadata: exports_external.record(exports_external.string(), exports_external.record(exports_external.string(), exports_external.any())).optional()
});
var OpenAICompatibleImageModel = class {
  constructor(modelId, config2) {
    this.modelId = modelId;
    this.config = config2;
    this.specificationVersion = "v3";
    this.maxImagesPerCall = 10;
  }
  get provider() {
    return this.config.provider;
  }
  get providerOptionsKey() {
    return this.config.provider.split(".")[0].trim();
  }
  getArgs(providerOptions) {
    return {
      ...providerOptions[this.providerOptionsKey],
      ...providerOptions[toCamelCase(this.providerOptionsKey)]
    };
  }
  async doGenerate({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    providerOptions,
    headers,
    abortSignal,
    files,
    mask
  }) {
    var _a16, _b16, _c, _d, _e;
    const warnings = [];
    if (aspectRatio != null) {
      warnings.push({
        type: "unsupported",
        feature: "aspectRatio",
        details: "This model does not support aspect ratio. Use `size` instead."
      });
    }
    if (seed != null) {
      warnings.push({ type: "unsupported", feature: "seed" });
    }
    const currentDate = (_c = (_b16 = (_a16 = this.config._internal) == null ? undefined : _a16.currentDate) == null ? undefined : _b16.call(_a16)) != null ? _c : /* @__PURE__ */ new Date;
    const args = this.getArgs(providerOptions);
    if (files != null && files.length > 0) {
      const { value: response2, responseHeaders: responseHeaders2 } = await postFormDataToApi({
        url: this.config.url({
          path: "/images/edits",
          modelId: this.modelId
        }),
        headers: combineHeaders(this.config.headers(), headers),
        formData: convertToFormData({
          model: this.modelId,
          prompt,
          image: await Promise.all(files.map((file2) => fileToBlob(file2))),
          mask: mask != null ? await fileToBlob(mask) : undefined,
          n,
          size,
          ...args
        }),
        failedResponseHandler: createJsonErrorResponseHandler((_d = this.config.errorStructure) != null ? _d : defaultOpenAICompatibleErrorStructure),
        successfulResponseHandler: createJsonResponseHandler(openaiCompatibleImageResponseSchema),
        abortSignal,
        fetch: this.config.fetch
      });
      return {
        images: response2.data.map((item) => item.b64_json),
        warnings,
        response: {
          timestamp: currentDate,
          modelId: this.modelId,
          headers: responseHeaders2
        }
      };
    }
    const { value: response, responseHeaders } = await postJsonToApi({
      url: this.config.url({
        path: "/images/generations",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), headers),
      body: {
        model: this.modelId,
        prompt,
        n,
        size,
        ...args,
        response_format: "b64_json"
      },
      failedResponseHandler: createJsonErrorResponseHandler((_e = this.config.errorStructure) != null ? _e : defaultOpenAICompatibleErrorStructure),
      successfulResponseHandler: createJsonResponseHandler(openaiCompatibleImageResponseSchema),
      abortSignal,
      fetch: this.config.fetch
    });
    return {
      images: response.data.map((item) => item.b64_json),
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders
      }
    };
  }
};
var openaiCompatibleImageResponseSchema = exports_external.object({
  data: exports_external.array(exports_external.object({ b64_json: exports_external.string() }))
});
async function fileToBlob(file2) {
  if (file2.type === "url") {
    return downloadBlob(file2.url);
  }
  const data = file2.data instanceof Uint8Array ? file2.data : convertBase64ToUint8Array(file2.data);
  return new Blob([data], { type: file2.mediaType });
}
var VERSION2 = "2.0.41";
function createOpenAICompatible(options) {
  const baseURL = withoutTrailingSlash(options.baseURL);
  const providerName = options.name;
  const headers = {
    ...options.apiKey && { Authorization: `Bearer ${options.apiKey}` },
    ...options.headers
  };
  const getHeaders = () => withUserAgentSuffix(headers, `ai-sdk/openai-compatible/${VERSION2}`);
  const getCommonModelConfig = (modelType) => ({
    provider: `${providerName}.${modelType}`,
    url: ({ path }) => {
      const url2 = new URL(`${baseURL}${path}`);
      if (options.queryParams) {
        url2.search = new URLSearchParams(options.queryParams).toString();
      }
      return url2.toString();
    },
    headers: getHeaders,
    fetch: options.fetch
  });
  const createLanguageModel = (modelId) => createChatModel(modelId);
  const createChatModel = (modelId) => new OpenAICompatibleChatLanguageModel(modelId, {
    ...getCommonModelConfig("chat"),
    includeUsage: options.includeUsage,
    supportsStructuredOutputs: options.supportsStructuredOutputs,
    transformRequestBody: options.transformRequestBody,
    metadataExtractor: options.metadataExtractor
  });
  const createCompletionModel = (modelId) => new OpenAICompatibleCompletionLanguageModel(modelId, {
    ...getCommonModelConfig("completion"),
    includeUsage: options.includeUsage
  });
  const createEmbeddingModel = (modelId) => new OpenAICompatibleEmbeddingModel(modelId, {
    ...getCommonModelConfig("embedding")
  });
  const createImageModel = (modelId) => new OpenAICompatibleImageModel(modelId, getCommonModelConfig("image"));
  const provider = (modelId) => createLanguageModel(modelId);
  provider.specificationVersion = "v3";
  provider.languageModel = createLanguageModel;
  provider.chatModel = createChatModel;
  provider.completionModel = createCompletionModel;
  provider.embeddingModel = createEmbeddingModel;
  provider.textEmbeddingModel = createEmbeddingModel;
  provider.imageModel = createImageModel;
  return provider;
}

// src/build/provider-factory.ts
function baseOf(baseURL) {
  const url2 = new URL(baseURL);
  return { origin: url2.origin, path: url2.pathname.replace(/\/+$/, "") };
}
function refusal(type, message) {
  return new Response(JSON.stringify({ error: { type, code: type, message, retryable: false } }), { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json", "x-enpal-refused": type } });
}
var urlOf = (input) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
function underBase(url2, base) {
  return url2.origin === base.origin && (url2.pathname === base.path || url2.pathname.startsWith(`${base.path}/`));
}
function conditionalGet(input, init) {
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
  return method === "GET" && headers.has("if-none-match");
}
var LANGUAGE_STAMP_HEADER = "x-enpal-transport";
var STAMP_KEY = Symbol.for("enpal-gateway.language-stamp");
function languageStamp() {
  const g = globalThis;
  return g[STAMP_KEY] ??= crypto.randomUUID();
}
var DROPPED_BODY_KEY = "provider";
function withoutProviderKey(body) {
  let text;
  if (typeof body === "string")
    text = body;
  else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return null;
    }
  } else
    return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, DROPPED_BODY_KEY))
    return null;
  delete parsed[DROPPED_BODY_KEY];
  const out = JSON.stringify(parsed);
  return typeof body === "string" ? out : new TextEncoder().encode(out);
}
function guardedFetch(inner, base, opts = {}) {
  return async (input, init) => {
    let url2;
    try {
      url2 = new URL(urlOf(input));
    } catch {
      return refusal("enpal_off_base", "The request URL could not be parsed; nothing was sent.");
    }
    if (!underBase(url2, base)) {
      return refusal("enpal_off_base", `The Enpal AI Gateway plugin sends its login token only to ${base.origin}${base.path}; the request to ${url2.origin}${url2.pathname} was not sent.`);
    }
    let sent = { ...init, redirect: "manual" };
    const body = withoutProviderKey(init?.body);
    if (body !== null)
      sent = { ...sent, body };
    if (opts.stamp || body !== null) {
      const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
      if (opts.stamp)
        headers.set(LANGUAGE_STAMP_HEADER, languageStamp());
      if (body !== null && headers.has("content-length")) {
        headers.set("content-length", String(typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength));
      }
      sent = { ...sent, headers };
    }
    const res = await inner(input, sent);
    if (res.status === 304 && opts.allowNotModified && conditionalGet(input, init))
      return res;
    if (res.status >= 300 && res.status < 400) {
      try {
        await res.body?.cancel();
      } catch {}
      return refusal("enpal_redirect_refused", `The Enpal AI Gateway answered ${res.status} with a redirect; the plugin does not follow redirects for a request that carries the login token. Nothing was sent to the redirect target.`);
    }
    return res;
  };
}
var knownBase = null;
function rememberBase(base) {
  knownBase = baseOf(`${base.replace(/\/+$/, "")}/v1`);
}
function createEnpalProvider(options = {}) {
  const base = knownBase ?? (options.baseURL ? baseOf(options.baseURL) : null);
  if (!base)
    throw new Error("enpal-gateway: no gateway base for the provider factory");
  const { fetch: inner, ...rest } = options;
  let own = false;
  try {
    own = typeof options.baseURL === "string" && underBase(new URL(options.baseURL), base);
  } catch {}
  return createOpenAICompatible({
    ...rest,
    name: options.name ?? "enpal-gateway",
    baseURL: own ? options.baseURL : `${base.origin}${base.path}`,
    fetch: guardedFetch(inner ?? ((i, init) => fetch(i, init)), base, { stamp: true })
  });
}

// src/build/models-policy.ts
import { createHash as createHash6 } from "node:crypto";
import { mkdirSync as mkdirSync4, readFileSync as readFileSync8, statSync as statSync6 } from "node:fs";
import { join as join9 } from "node:path";

// src/loader/cache.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync7, renameSync as renameSync3, unlinkSync as unlinkSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join8 } from "node:path";

// src/loader/descriptor.ts
import { createHash as createHash5 } from "node:crypto";
var SCHEMA = 1;
var BUILD_RE = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;
var FILE_RE = /^enpal-plugin-(\d{4}-\d{2}-\d{2}\.\d{1,3})-(v1|v2|v2-ui|skill|catalog|notes)\.(js|md|json)$/;
var CAPABILITY_RE = /^[a-z][a-z0-9-]{0,31}$/;
var DESCRIPTOR_MAX = 64 * 1024;
var POINTER_NAME = "plugin-release.json";
var MIB = 1024 * 1024;
var ROLES = {
  v1: { ext: "js", max: 2 * MIB },
  v2: { ext: "js", max: 2 * MIB },
  "v2-ui": { ext: "js", max: 2 * MIB },
  skill: { ext: "md", max: 256 * 1024 },
  catalog: { ext: "json", max: 512 * 1024 },
  notes: { ext: "md", max: 256 * 1024 }
};
var ROLE_NAMES = Object.keys(ROLES);
function sha256Hex(data) {
  return createHash5("sha256").update(data).digest("hex");
}
var isRecord3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isInt = (v) => typeof v === "number" && Number.isInteger(v);
function validateDescriptor(obj, expectedBuild) {
  const errors3 = [];
  if (!isRecord3(obj))
    return { ok: false, errors: ["descriptor is not an object"] };
  if (obj.schema !== SCHEMA)
    errors3.push(`schema is not ${SCHEMA}`);
  const build = typeof obj.build === "string" && BUILD_RE.test(obj.build) ? obj.build : "";
  if (!build)
    errors3.push("build id is malformed");
  else if (expectedBuild !== undefined && build !== expectedBuild)
    errors3.push(`build ${build} is not ${expectedBuild}`);
  if (!isInt(obj.min_loader) || obj.min_loader < 1)
    errors3.push("min_loader must be a positive integer");
  const caps = obj.capabilities;
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string" && CAPABILITY_RE.test(c))) {
    errors3.push("capabilities must be a list of names");
  } else if (new Set(caps).size !== caps.length) {
    errors3.push("a capability repeats");
  }
  const files = obj.files;
  if (!isRecord3(files))
    return { ok: false, errors: [...errors3, "files must be an object"] };
  for (const role of Object.keys(files))
    if (!(role in ROLES))
      errors3.push(`unknown file role ${role}`);
  for (const role of ROLE_NAMES)
    if (!(role in files))
      errors3.push(`missing file role ${role}`);
  const seen = new Set;
  for (const role of ROLE_NAMES) {
    const entry = files[role];
    if (!isRecord3(entry)) {
      if (role in files)
        errors3.push(`${role}: not an object`);
      continue;
    }
    const { name: name15, sha256, size } = entry;
    const m = typeof name15 === "string" ? FILE_RE.exec(name15) : null;
    if (!m || m[1] !== build || m[2] !== role || m[3] !== ROLES[role].ext) {
      errors3.push(`${role}: name is not enpal-plugin-${build}-${role}.${ROLES[role].ext}`);
    } else if (seen.has(name15)) {
      errors3.push(`${role}: name repeats`);
    } else {
      seen.add(name15);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
      errors3.push(`${role}: sha256 is not 64 hex characters`);
    if (!isInt(size) || size < 1 || size > ROLES[role].max)
      errors3.push(`${role}: size must be 1..${ROLES[role].max}`);
  }
  for (const key of Object.keys(obj)) {
    if (!["schema", "build", "min_loader", "capabilities", "files"].includes(key))
      errors3.push(`unknown key ${key}`);
  }
  if (errors3.length)
    return { ok: false, errors: errors3 };
  return { ok: true, descriptor: obj };
}
function fileMatches(entry, data) {
  return data.byteLength === entry.size && sha256Hex(data) === entry.sha256;
}

// src/loader/cache.ts
var POINTER_MAX = DESCRIPTOR_MAX + 64 * 1024;
var ROLES_FOR_LINE = { v1: ["v1", "skill", "catalog"], v2: ["v2", "v2-ui", "skill", "catalog"] };
function storeUrlFor(base, name15) {
  const root = base.replace(/\/+$/, "");
  const baseUrl = new URL(root);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name15))
    throw new Error("off_base");
  const url2 = new URL(`${root}/store/${name15}`);
  if (url2.origin !== baseUrl.origin || !url2.pathname.startsWith(`${basePath}/store/`) || url2.search || url2.hash || url2.username || url2.password) {
    throw new Error("off_base");
  }
  assertSecureEndpoint(url2.href);
  return url2.href;
}
function writeAtomically(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync3(tmp, data);
    renameSync3(tmp, path);
  } catch (e) {
    try {
      unlinkSync2(tmp);
    } catch {}
    throw e;
  }
}
async function downloadVerified(c, name15, expected, max, signal) {
  const res = await c.fetch(storeUrlFor(c.base, name15), { signal, redirect: "error" });
  if (!res.ok)
    throw new Error(`download_http_${res.status}`);
  const data = await readBounded(res, Math.min(max, expected.size));
  if (!fileMatches(expected, data))
    throw new Error("download_digest");
  return data;
}
async function ensureBuildFiles(c, descriptor, roles, signal) {
  mkdirSync3(c.dir, { recursive: true });
  const buildDir = join8(c.dir, "builds", descriptor.build);
  mkdirSync3(buildDir, { recursive: true });
  for (const role of roles) {
    const entry = descriptor.files[role];
    const path = join8(buildDir, entry.name);
    if (existsSync3(path)) {
      try {
        if (fileMatches(entry, readFileSync7(path)))
          continue;
      } catch {}
      try {
        c.log?.(`cache: ${entry.name} does not match its descriptor, fetching it again`);
      } catch {}
    }
    const data = await downloadVerified(c, entry.name, entry, ROLES[role].max, signal);
    writeAtomically(path, data);
  }
}

// src/build/models-policy.ts
var ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
var record2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var control = /[\u0000-\u001f\u007f-\u009f]/;
function providerIds(v) {
  return Array.isArray(v) && v.every((p) => typeof p === "string" && ID_RE.test(p)) ? [...new Set(v)] : null;
}
var dnsHost = (v) => typeof v === "string" && v.length <= 253 && !/^[0-9.]+$/.test(v) && v.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
var plainPath = (v) => typeof v === "string" && /^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*\/?)?$/.test(v) && !v.split("/").some((s) => s === "." || s === "..");
function freezePolicy(p) {
  return Object.freeze({ ...p, hosted: Object.freeze({
    providers: Object.freeze([...p.hosted.providers]),
    destinations: Object.freeze(p.hosted.destinations.map((d) => Object.freeze({ ...d })))
  }) });
}
function readModelsPolicy(raw, log) {
  if (!record2(raw) || raw.schema !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !record2(raw.hosted))
    return null;
  const providers = providerIds(raw.hosted.providers);
  const destinations = raw.hosted.destinations;
  if (!providers || !Array.isArray(raw.hosted.providers) || raw.hosted.providers.length > 64 || providers.includes(PROVIDER_ID))
    return null;
  if (!Array.isArray(destinations) || destinations.length > 16 || destinations.some((d) => !record2(d) || !dnsHost(d.host) || !plainPath(d.path)))
    return null;
  if (typeof raw.default_model !== "string" || !raw.default_model.startsWith(PROVIDER_ID + "/") || !ID_RE.test(raw.default_model.slice(PROVIDER_ID.length + 1)))
    return null;
  if (typeof raw.notice !== "string" || !raw.notice.length || raw.notice.length > 400 || control.test(raw.notice))
    return null;
  const restore = Object.hasOwn(raw, "restore_enpal") ? raw.restore_enpal : undefined;
  if (Object.hasOwn(raw, "restore_enpal") && typeof restore !== "boolean")
    safeLog(log, "models policy restore_enpal is not boolean; using true");
  return freezePolicy({
    schema: 1,
    revision: raw.revision,
    restore_enpal: typeof restore === "boolean" ? restore : true,
    hosted: { providers, destinations: destinations.map((d) => ({ host: d.host, path: d.path })) },
    default_model: raw.default_model,
    notice: raw.notice
  });
}
var BUILTIN_MODELS_POLICY = freezePolicy({
  schema: 1,
  revision: 0,
  restore_enpal: true,
  hosted: { providers: ["opencode", "opencode-go"], destinations: [{ host: "opencode.ai", path: "/zen" }] },
  default_model: DEFAULT_MODEL,
  notice: "Only Enpal's EU gateway is approved for company and customer data. Other providers are your own responsibility (AI course)."
});
var modelsPolicyDigest = (p) => createHash6("sha256").update(JSON.stringify(p)).digest("hex");
var hostOf = (u) => u.hostname.toLowerCase().replace(/\.+$/, "");
var transportUrl = (raw) => {
  if (typeof raw !== "string")
    return null;
  try {
    const u = new URL(raw);
    return /^(https?|wss?):$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};
var pathUnder = (path, base) => base === "/" || path === base || path.startsWith(base.replace(/\/+$/, "") + "/");
function decodedPath(raw) {
  let path = raw;
  for (let i = 0;i < 8; i++) {
    const next = path.replace(/%([0-9a-f]{2})/gi, (_, hex3) => String.fromCharCode(parseInt(hex3, 16)));
    if (next === path)
      break;
    path = next;
  }
  const out = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..")
      out.pop();
    else if (part && part !== ".")
      out.push(part);
  }
  return "/" + out.join("/");
}
function hostedDestination(policy, raw) {
  const u = transportUrl(raw);
  if (!u)
    return false;
  const path = decodedPath(u.pathname).toLowerCase();
  return policy.hosted.destinations.some((d) => d.host === hostOf(u) && (pathUnder(path, d.path.toLowerCase().replace(/\/+$/, "") || "/") || path.startsWith(d.path.toLowerCase().replace(/\/+$/, "") + "%")));
}
var hostedRefusal = (providerID) => `OpenCode's hosted models (Zen, Go) are blocked for Enpal: they run outside the EU. Choose Enpal AI Gateway or another provider. This request (${String(providerID)}) was not sent.`;
function hostedProvider(policy, id) {
  return typeof id === "string" && policy.hosted.providers.includes(id);
}
function hostedRoute(policy, route) {
  if (hostedProvider(policy, route.providerID) || hostedDestination(policy, route.baseURL))
    return true;
  const u = transportUrl(route.baseURL);
  const concrete = typeof route.baseURL === "string" && !route.baseURL.includes("${");
  if (route.effectiveOverride && concrete && u && u.origin !== "https://ai-sdk.local")
    return false;
  if (hostedProvider(policy, route.canonical))
    return true;
  const pkg = typeof route.package === "string" ? route.package.replace(/^aisdk:/, "") : "";
  const zen = pkg === "@opencode/ai/providers/opencode-zen" || pkg === "opencode-zen";
  return zen && (hostedProvider(policy, "opencode") || hostedDestination(policy, "https://opencode.ai/zen/v1"));
}
function modelsPolicyCompatible(policy, base) {
  const u = transportUrl(base);
  if (!u)
    return false;
  const path = decodedPath(u.pathname).toLowerCase();
  return !policy.hosted.destinations.some((d) => d.host === hostOf(u) && (pathUnder(path, d.path.toLowerCase()) || pathUnder(d.path.toLowerCase(), path)));
}
function readRetired(raw) {
  if (!record2(raw))
    return null;
  const entries = Object.entries(raw);
  return entries.some(([id, v]) => !id || v !== null && typeof v !== "string") ? null : Object.fromEntries(entries);
}
function readReleasePolicy(raw, log) {
  if (!record2(raw))
    return null;
  const retired = readRetired(raw.retired), enabled_providers = providerIds(raw.enabled_providers);
  if (!retired || !enabled_providers)
    return null;
  const models_policy = readModelsPolicy(raw.models_policy, log);
  return { retired, enabled_providers, ...models_policy ? { models_policy } : {} };
}
function mergePolicySnapshot(previous, raw, base, log) {
  const x = record2(raw) ? raw : {};
  const retired = readRetired(x.retired), enabled = providerIds(x.enabled_providers);
  let models = readModelsPolicy(x.models_policy, log);
  if (models && !modelsPolicyCompatible(models, base))
    models = null;
  const old = previous?.policy;
  const stale = !!models && !!old?.models_policy && models.revision < old.models_policy.revision;
  if (stale)
    models = null;
  const policy = {
    retired: Object.freeze(retired ?? { ...old?.retired }),
    enabled_providers: Object.freeze(enabled ?? [...old?.enabled_providers ?? []]),
    ...models ?? old?.models_policy ? { models_policy: models ?? old.models_policy } : {}
  };
  const status = (v, valid, held) => valid ? "valid" : held ? "held" : v === undefined ? "missing" : "invalid";
  return Object.freeze({ policy: Object.freeze(policy), sections: Object.freeze({
    retired: status(x.retired, retired !== null, !!old),
    enabled_providers: status(x.enabled_providers, enabled !== null, !!old),
    models_policy: stale ? "stale_revision" : status(x.models_policy, models !== null, !!old?.models_policy)
  }) });
}
var POLICY_SNAPSHOT_MAX = 64 * 1024;
var safeLog = (log, message) => {
  try {
    log?.(message);
  } catch {}
};
function savePolicySnapshot(cacheDir, snapshot, at, log) {
  try {
    const bytes = Buffer.from(JSON.stringify({ policy: snapshot.policy, sections: snapshot.sections, at }));
    if (bytes.length > POLICY_SNAPSHOT_MAX)
      throw new Error("too large");
    mkdirSync4(cacheDir, { recursive: true });
    writeAtomically(join9(cacheDir, "policy.json"), bytes);
    return true;
  } catch {
    safeLog(log, "models policy not saved for offline start");
    return false;
  }
}
function readPolicySnapshot(cacheDir, base, log) {
  try {
    const path = join9(cacheDir, "policy.json");
    if (statSync6(path).size > POLICY_SNAPSHOT_MAX)
      return null;
    const raw = JSON.parse(readFileSync8(path, "utf8"));
    if (!record2(raw) || !record2(raw.policy))
      return null;
    const snapshot = mergePolicySnapshot(null, raw.policy, base, log);
    if (!Object.values(snapshot.sections).includes("valid"))
      return null;
    return snapshot;
  } catch {
    return null;
  }
}
var RULES = Symbol.for("enpal.gateway.models-policy.v1");
function modelsPolicyState(base) {
  const registry2 = globalThis;
  const states = registry2[RULES] ??= new Map;
  const key = normalisedBase(base);
  let state = states.get(key);
  if (!state) {
    state = { policy: BUILTIN_MODELS_POLICY, source: "builtin", digest: modelsPolicyDigest(BUILTIN_MODELS_POLICY), status: "accepted" };
    states.set(key, state);
  }
  return state;
}
function acceptModelsPolicy(state, candidates, base, log) {
  const rank = { gateway: 0, handed: 2, pointer: 3, saved: 4 };
  const valid = candidates.map((c) => ({ ...c, policy: readModelsPolicy(c.raw, log) })).filter((c) => !!c.policy && modelsPolicyCompatible(c.policy, base)).sort((a, b) => b.policy.revision - a.policy.revision || rank[a.source] - rank[b.source]);
  const pick2 = valid[0];
  if (!pick2) {
    state.status = "invalid";
    return false;
  }
  if (state.source !== "builtin" && pick2.policy.revision < state.policy.revision) {
    state.status = "stale_revision";
    safeLog(log, "models policy stale_revision");
    return false;
  }
  if (state.source !== "builtin" && pick2.policy.revision === state.policy.revision && pick2.source !== "gateway")
    return false;
  const changed = state.digest !== modelsPolicyDigest(pick2.policy);
  Object.assign(state, { policy: pick2.policy, source: pick2.source, digest: modelsPolicyDigest(pick2.policy), status: "accepted" });
  return changed;
}
function acceptPolicySnapshot(state, raw, base, source = "gateway", log) {
  const previous = state.source === "builtin" ? state.snapshot ?? null : mergePolicySnapshot(state.snapshot ?? null, { models_policy: state.policy }, base);
  const merged = mergePolicySnapshot(previous, raw, base);
  if (record2(raw) && Object.hasOwn(raw, "models_policy"))
    acceptModelsPolicy(state, [{ raw: raw.models_policy, source }], base, log);
  const winner = state.source === "builtin" ? merged.policy.models_policy : state.policy;
  state.snapshot = Object.freeze({ ...merged, policy: Object.freeze({ ...merged.policy, ...winner ? { models_policy: winner } : {} }) });
  return state.snapshot;
}

// src/build/disabled.ts
var restoreControl = { read: modelsPolicyState };
function restoreControlState(base) {
  let state;
  try {
    state = restoreControl.read?.(base);
  } catch {
    state = null;
  }
  const source = !state ? "builtin" : typeof state.source === "string" ? state.source : "policy";
  const revision = typeof state?.policy?.revision === "number" ? state.policy.revision : null;
  return { restore_enpal: state?.policy?.restore_enpal !== false, source, revision };
}
var restoreEnpalEnabled = (base) => restoreControlState(base).restore_enpal;
var FILE_MAX = 2 * 1024 * 1024;
var isRecord4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
function holdsEnpal(value) {
  return isRecord4(value) && strings(value.disabled_providers).includes(PROVIDER_ID);
}
function leavesOutEnpal(value) {
  return isRecord4(value) && Array.isArray(value.enabled_providers) && !strings(value.enabled_providers).includes(PROVIDER_ID);
}
function setter1x(field, o, unread = []) {
  if (o.managed && Object.hasOwn(o.managed, field)) {
    const dir = managedConfigDir(o.env);
    const file2 = [join10(dir, "opencode.jsonc"), join10(dir, "opencode.json")].find((p) => {
      const v = readJsoncFile(p, FILE_MAX).value;
      return !!v && Object.hasOwn(v, field);
    });
    return { kind: "managed", file: file2 ?? dir };
  }
  if (o.env.OPENCODE_CONFIG_CONTENT) {
    let parsed = null;
    try {
      parsed = parseJsonc(o.env.OPENCODE_CONFIG_CONTENT);
    } catch {}
    if (isRecord4(parsed) && Object.hasOwn(parsed, field))
      return { kind: "content" };
  }
  let found = { kind: "unknown" };
  for (const path of personFiles1x(o.env, o.directory, o.home, o.worktree)) {
    const { present, value } = readJsoncFile(path, FILE_MAX);
    if (present && !value)
      unread.push(path);
    if (value && Object.hasOwn(value, field))
      found = { kind: "file", path, value };
  }
  return found;
}
function switchedOff1x(merged) {
  return holdsEnpal(merged) || leavesOutEnpal(merged);
}
function provenance1x(merged, o) {
  const unread = [];
  const reasons = [];
  if (holdsEnpal(merged))
    reasons.push({ setting: "disabled_providers", setter: setter1x("disabled_providers", o, unread), theirs: holdsEnpal });
  if (leavesOutEnpal(merged))
    reasons.push({ setting: "enabled_providers", setter: setter1x("enabled_providers", o, unread), theirs: leavesOutEnpal });
  if (!reasons.length)
    return { source: null, unreadable: unread.length > 0 };
  const managed = reasons.find((r2) => r2.setter.kind === "managed");
  const foreign = reasons.find((r2) => r2.setter.kind !== "file" || !r2.theirs(r2.setter.value));
  const r = managed ?? foreign ?? reasons[0];
  const file2 = r.setter.kind === "managed" ? r.setter.file : r.setter.kind === "content" ? "OPENCODE_CONFIG_CONTENT" : r.setter.kind === "file" && r.theirs(r.setter.value) ? r.setter.path : null;
  return { source: sourceOf({ file: file2, setting: r.setting, managed: r === managed }, o.env, o.home), unreadable: unread.length > 0 };
}
function reenableInMemory(cfg) {
  if (Array.isArray(cfg.disabled_providers))
    cfg.disabled_providers = cfg.disabled_providers.filter((p) => p !== PROVIDER_ID);
  if (leavesOutEnpal(cfg))
    cfg.enabled_providers = [...cfg.enabled_providers, PROVIDER_ID];
}
function enpalOffered1x(cfg) {
  return isRecord4(cfg.provider) && isRecord4(cfg.provider[PROVIDER_ID]) && !switchedOff1x(cfg);
}
function trustedAddress(address, base) {
  try {
    return typeof address === "string" && underBase(new URL(address), baseOf(base));
  } catch {
    return false;
  }
}
function pinTransport1x(cfg, base, apply = true) {
  const block = isRecord4(cfg.provider) ? cfg.provider[PROVIDER_ID] : undefined;
  if (!isRecord4(block))
    return [];
  const trusted = `${base.replace(/\/+$/, "")}/v1`;
  const changed = [];
  if (block.npm !== undefined && block.npm !== API_NPM) {
    changed.push("npm");
    if (apply)
      block.npm = API_NPM;
  }
  if (block.api !== undefined && !trustedAddress(block.api, base)) {
    changed.push("api");
    if (apply)
      block.api = trusted;
  }
  const options = isRecord4(block.options) ? block.options : {};
  if (!trustedAddress(options.baseURL, base)) {
    if (options.baseURL !== undefined)
      changed.push("options.baseURL");
    if (apply)
      block.options = { ...options, baseURL: trusted };
  }
  const models = isRecord4(block.models) ? block.models : {};
  for (const [id, row] of Object.entries(models)) {
    if (!isRecord4(row) || !isRecord4(row.provider))
      continue;
    const own = { ...row.provider };
    const before = changed.length;
    if (own.npm !== undefined && own.npm !== API_NPM) {
      changed.push(`models.${id}.provider.npm`);
      own.npm = API_NPM;
    }
    if (own.api !== undefined && !trustedAddress(own.api, base)) {
      changed.push(`models.${id}.provider.api`);
      own.api = trusted;
    }
    if (apply && changed.length > before)
      block.models = { ...block.models, [id]: { ...row, provider: own } };
  }
  return changed;
}
var inside = (path, dir) => {
  const r = relative(resolve3(dir), resolve3(path));
  return r === "" || !!r && !r.startsWith("..") && !isAbsolute2(r);
};
function sourceOf(f, env, home = homedir4()) {
  const file2 = f.file;
  const kind = f.managed ? "managed" : !file2 ? "unknown" : file2 === "OPENCODE_CONFIG_CONTENT" ? "content" : env.OPENCODE_CONFIG && resolve3(env.OPENCODE_CONFIG) === resolve3(file2) || env.OPENCODE_CONFIG_DIR && inside(file2, env.OPENCODE_CONFIG_DIR) ? "explicit" : inside(file2, opencodeConfigDir(env, home)) || inside(file2, join10(home, ".opencode")) ? "personal" : "project";
  return { kind, file: kind === "content" ? "OPENCODE_CONFIG_CONTENT" : file2, setting: f.setting };
}
function wildcardMatch(input, pattern, platform2 = process.platform) {
  const normalized = input.replace(/\\/g, "/");
  let escaped = pattern.replace(/\\/g, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*"))
    escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", platform2 === "win32" ? "si" : "s").test(normalized);
}
function statementsOf(value, path) {
  const out = [];
  if (Object.hasOwn(value, "enabled_providers") && Array.isArray(value.enabled_providers)) {
    const ids = strings(value.enabled_providers);
    if (!value.enabled_providers.length || ids.length) {
      out.push({ effect: "deny", resource: "*", path, setting: "enabled_providers" });
      for (const id of ids)
        out.push({ effect: "allow", resource: id, path, setting: "enabled_providers" });
    }
  }
  for (const id of strings(value.disabled_providers))
    out.push({ effect: "deny", resource: id, path, setting: "disabled_providers" });
  const policies = isRecord4(value.experimental) && Array.isArray(value.experimental.policies) ? value.experimental.policies : [];
  for (const p of policies) {
    if (isRecord4(p) && p.action === "provider.use" && typeof p.resource === "string" && (p.effect === "allow" || p.effect === "deny")) {
      out.push({ effect: p.effect, resource: p.resource, path, setting: "experimental.policies" });
    }
  }
  return out;
}
function verdict2x(docs, platform2) {
  return [...docs].reverse().flatMap((d) => statementsOf(d.value, d.path)).findLast((s) => wildcardMatch(PROVIDER_ID, s.resource, platform2));
}
function provenance2x(o) {
  const { files, complete: walked } = personFiles2x(o.env, o.directory, o.home);
  let complete = walked;
  const docs = [];
  for (const path of files) {
    const { present, value } = readJsoncFile(path, FILE_MAX);
    if (present && !value)
      complete = false;
    if (value)
      docs.push({ path, value });
  }
  const decides = verdict2x(docs, o.platform ?? process.platform);
  if (decides?.effect !== "deny")
    return { input: "unknown", source: null, unreadable: !complete };
  return { input: "deny", source: sourceOf({ file: decides.path, setting: decides.setting }, o.env, o.home), unreadable: !complete };
}
function switchesOff(value, line, platform2 = process.platform) {
  if (!value)
    return false;
  return line === "v1" ? holdsEnpal(value) || leavesOutEnpal(value) : verdict2x([{ path: "", value }], platform2)?.effect === "deny";
}
function filesSwitchingOff(env, directory, line, home, worktree) {
  const managedDir = managedConfigDir(env);
  const paths = line === "v1" ? [...personFiles1x(env, directory, home, worktree), join10(managedDir, "opencode.json"), join10(managedDir, "opencode.jsonc")] : personFiles2x(env, directory, home).files;
  return [...new Set(paths)].filter((p) => switchesOff(readJsoncFile(p, FILE_MAX).value, line));
}
var KICK_MAX = 6;
var KICK_WINDOW_MS = 1e4;
var RESTORED_IN = Symbol.for("enpal.gateway.plugin.restored-in.v1");
var restoredIn = globalThis[RESTORED_IN] ??= new WeakSet;
function pinProvider2x(p, pkg, base) {
  let changed = false;
  if (p.package !== pkg) {
    p.package = pkg;
    changed = true;
  }
  if (!trustedAddress(p.settings?.baseURL, base)) {
    p.settings = { ...p.settings ?? {}, baseURL: `${base.replace(/\/+$/, "")}/v1` };
    changed = true;
  }
  return changed;
}
function pinModel2x(model, pkg, base) {
  const trusted = `${base.replace(/\/+$/, "")}/v1`;
  let changed = false;
  if (pkg && model.package !== pkg) {
    model.package = pkg;
    changed = true;
  }
  const settings = isRecord4(model.settings) ? model.settings : null;
  if (settings && settings.baseURL !== undefined && !trustedAddress(settings.baseURL, base)) {
    model.settings = { ...settings, baseURL: trusted };
    changed = true;
  }
  for (const v of Array.isArray(model.variants) ? model.variants : []) {
    if (isRecord4(v) && isRecord4(v.settings) && v.settings.baseURL !== undefined && !trustedAddress(v.settings.baseURL, base)) {
      v.settings = { ...v.settings, baseURL: trusted };
      changed = true;
    }
  }
  return changed;
}
function createRestoreRegistrations(ctx, o) {
  const now = o.now ?? Date.now;
  let restored = 0;
  let found = null;
  let current = [];
  const owned = new Set;
  const releaseOne = async (r) => {
    if (owned.delete(r))
      await r.dispose().catch(() => {});
  };
  let disposed = false;
  let registering = null;
  let again = false;
  const kicks = [];
  const note = (what, e) => {
    try {
      o.log(`disabled_providers: ${what} failed and was contained: ${e?.message ?? e}`);
    } catch {}
  };
  const tell = (ev) => {
    try {
      o.outcome?.(ev);
    } catch (err) {
      note("outcome", err);
    }
  };
  const kick = () => {
    const t = now();
    while (kicks.length && t - kicks[0] > KICK_WINDOW_MS)
      kicks.shift();
    if (kicks.length >= KICK_MAX)
      return;
    kicks.push(t);
    Promise.resolve().then(() => relast()).catch(() => {});
  };
  const take = async (set2, r) => {
    owned.add(r);
    set2.push(r);
    if (!disposed)
      return true;
    for (const x of set2.reverse())
      await releaseOne(x);
    return false;
  };
  const registerSet = async () => {
    const set2 = [];
    try {
      if (!await take(set2, await ctx.provider.transform((e) => {
        if (disposed)
          return;
        let present = false;
        try {
          present = !!e.get(PROVIDER_ID);
        } catch (err) {
          note("restore", err);
          tell({ kind: "failed", phase: "observe", error: err });
          return;
        }
        if (present) {
          found = restoredIn.has(e) ? "restored" : "present";
          try {
            o.pin(e);
          } catch (err) {
            note("transport pin", err);
          }
          return;
        }
        found = "missing";
        try {
          if (!o.restoreOn()) {
            tell({ kind: "missing", attempted: false, restored: false });
            return;
          }
          o.add(e);
          restoredIn.add(e);
          const ok = !!e.get(PROVIDER_ID);
          if (ok)
            restored++;
          tell({ kind: "missing", attempted: true, restored: ok, ...ok ? {} : { failure: "the provider was not there after it was added" } });
        } catch (err) {
          note("restore", err);
          tell({ kind: "missing", attempted: true, restored: false, failure: String(err?.message ?? err) });
        }
      })))
        return null;
      if (!await take(set2, await ctx.model.transform((m) => {
        if (disposed)
          return;
        try {
          const present = !!m.provider.get(PROVIDER_ID);
          tell({ kind: "final", present, found });
          if (!present && (o.restoreOn() || found !== "missing"))
            kick();
        } catch (err) {
          note("order check", err);
          tell({ kind: "failed", phase: "order_check", error: err });
        }
      })))
        return null;
      return set2;
    } catch (e) {
      for (const r of set2.reverse())
        await releaseOne(r);
      throw e;
    }
  };
  const once = async () => {
    try {
      o.reread?.();
    } catch (e) {
      note("read", e);
    }
    try {
      const next = await registerSet();
      if (!next)
        return;
      if (disposed) {
        for (const r of next.reverse())
          await releaseOne(r);
        return;
      }
      const old = current;
      current = next;
      for (const r of old.reverse())
        await releaseOne(r);
    } catch (e) {
      note("register", e);
      tell({ kind: "failed", phase: "register", error: e });
    }
  };
  const relast = () => {
    if (disposed)
      return Promise.resolve();
    if (registering) {
      again = true;
      return registering;
    }
    return registering = (async () => {
      try {
        await once();
        while (again && !disposed) {
          again = false;
          await once();
        }
      } finally {
        registering = null;
        again = false;
      }
    })();
  };
  const registration = {
    dispose: async () => {
      disposed = true;
      current = [];
      for (const r of [...owned].reverse())
        await releaseOne(r);
    }
  };
  return { relast, registration, restored: () => restored };
}

// src/build/disabled-diagnostics.ts
import { createHash as createHash7 } from "node:crypto";
import { readFileSync as readFileSync9, statSync as statSync7 } from "node:fs";
import { join as join11 } from "node:path";
var UNKNOWN = { kind: "unknown", file: null, setting: null };
var MAX_FILES = 50;
var LEDGER_MAX = 64 * 1024;
var MAX_ENTRIES = 50;
var record3 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var digest = (v) => createHash7("sha256").update(v).digest("hex").slice(0, 32);
function disabledRepair(source) {
  if (source.kind === "managed")
    return "This is managed configuration. Report the leftover to IT; never edit the managed file.";
  if (source.setting === "experimental.policies")
    return "A provider policy is reported here. Do not delete or rewrite its statements; /enpal-doctor can explain the restriction.";
  if (!["personal", "project", "explicit"].includes(source.kind) || !source.file || !source.setting)
    return null;
  const edit = source.setting === "enabled_providers" ? `add only "${PROVIDER_ID}" to the valid top-level "enabled_providers" list` : `remove only the exact "${PROVIDER_ID}" entry from the top-level "disabled_providers" list`;
  return `In ${source.file}, ${edit}. Keep every other id and setting. /enpal-doctor can offer this edit with your consent and a backup; the plugin itself changes no config file.`;
}
function createDisabledDiagnostics(o) {
  const now = o.now ?? Date.now;
  const key = digest(JSON.stringify([o.base.replace(/\/+$/, ""), o.line, o.directory ?? "unknown-location"]));
  const ledgerPath = join11(o.cacheDir, "disabled-provider-generations.json");
  let token = 0;
  let generation = 0;
  let observation = { input: "unknown" };
  let outcome = { attempted: false, restored: false, currently_available: null, failure: null };
  const control2 = (value) => ({
    enabled: !value || ("restore_enpal" in value ? value.restore_enpal !== false : value.enabled !== false),
    source: value?.source ?? "builtin",
    revision: value?.revision ?? null
  });
  const readLedger = () => {
    try {
      if (statSync7(ledgerPath).size > LEDGER_MAX)
        return {};
      const parsed = JSON.parse(readFileSync9(ledgerPath, "utf8"));
      if (!record3(parsed))
        return {};
      const entries = {};
      for (const [id, e] of Object.entries(parsed)) {
        if (!/^[a-f0-9]{32}$/.test(id) || !record3(e) || !Number.isSafeInteger(e.generation) || e.generation < 0 || typeof e.denied !== "boolean" || typeof e.updated !== "number" || !Number.isFinite(e.updated))
          continue;
        entries[id] = { generation: e.generation, denied: e.denied, updated: e.updated };
      }
      return entries;
    } catch {
      return {};
    }
  };
  const advance = (input) => {
    const entries = readLedger();
    const before = entries[key];
    generation = before?.generation ?? 0;
    if (input === "unknown")
      return;
    const denied = input === "deny";
    if (before?.denied === denied)
      return;
    if (denied)
      generation = Math.min(generation + 1, Number.MAX_SAFE_INTEGER);
    entries[key] = { generation, denied, updated: now() };
    const kept = Object.entries(entries).sort((a, b) => b[1].updated - a[1].updated).slice(0, MAX_ENTRIES);
    try {
      writeJsonAtomically(ledgerPath, Object.fromEntries(kept));
    } catch {}
  };
  const facts = () => {
    const source = observation.source ?? UNKNOWN;
    const policy = control2(observation.policy);
    const detected = observation.input === "unknown" ? null : observation.input === "deny";
    const available = outcome.currently_available;
    const restored = outcome.restored && available === true;
    const state = !policy.enabled ? "central_off" : available === true ? restored ? "reenabled" : detected === false && !observation.transport_overridden ? "none" : "available" : outcome.failure ? "failed" : available === false ? "pending" : observation.input === "unknown" ? "unknown" : detected ? "pending" : "none";
    const where = source.kind === "content" ? "OPENCODE_CONFIG_CONTENT" : source.file ?? "an unidentified configuration source";
    const transport = observation.transport_overridden && available === true ? ` Enpal's address or package in ${where} is overridden in memory with the installed gateway's trusted transport.` : "";
    const summary = !policy.enabled ? "Enpal restore is switched off centrally by AI Platform. The trusted transport guards remain active. " + "A setting that switches Enpal off (yours or one set elsewhere) is kept for now; where no setting mentions Enpal, the plugin still adds it." : state === "failed" ? `Enpal restoration failed during ${outcome.failure}; ${available === false ? "the checked provider view still has no Enpal" : "current availability is unknown"}.` : available === false ? `Enpal is currently absent from the checked provider view. ${outcome.restored ? "An earlier restore in this observation did not survive the final fold." : "Restoration has not been verified."}` : state === "reenabled" ? `Enpal was restored in memory and is available in the checked provider view. Configuration residue: ${where}.${transport}` : state === "available" ? `Enpal is available in the checked provider view. Configuration residue: ${where}.${transport}` : state === "pending" ? `Enpal was missing or restricted before recovery (${where}); restoration has not been verified.` : state === "unknown" ? "Enpal's current restriction or availability has not been verified." : null;
    return {
      state,
      detected,
      attempted: outcome.attempted,
      restored: outcome.restored,
      currently_available: available,
      file: source.file,
      setting: source.setting,
      source_kind: source.kind,
      restore_policy: { ...policy },
      failure: outcome.failure,
      reenabled_in_memory: restored,
      summary,
      repair: disabledRepair(source),
      files_now: o.env ? filesSwitchingOff(o.env, o.directory, o.line, undefined, o.worktree) : [...observation.files ?? []],
      unreadable: Array.isArray(observation.unreadable) ? [...observation.unreadable] : [],
      provenance_unreadable: observation.unreadable === true || Array.isArray(observation.unreadable) && observation.unreadable.length > 0,
      transport_override_detected: observation.transport_overridden === true,
      transport_overridden: observation.transport_overridden === true && available === true && !outcome.failure
    };
  };
  return {
    observe(input) {
      observation = {
        input: input.input,
        source: input.source ? { kind: input.source.kind, file: input.source.file, setting: input.source.setting } : undefined,
        files: [...input.files ?? []].slice(0, MAX_FILES),
        unreadable: Array.isArray(input.unreadable) ? input.unreadable.slice(0, MAX_FILES) : input.unreadable === true,
        policy: control2(input.policy),
        transport_overridden: input.transport_overridden === true
      };
      token++;
      outcome = { attempted: false, restored: false, currently_available: null, failure: null };
      advance(input.input);
      return token;
    },
    report(currentToken, result) {
      if (token === 0 || currentToken !== token)
        return;
      if (result.attempted !== undefined)
        outcome.attempted ||= result.attempted;
      if (result.restored !== undefined)
        outcome.restored ||= result.restored;
      if (result.restored === true)
        outcome.attempted = true;
      if (result.currently_available !== undefined)
        outcome.currently_available = result.currently_available;
      if (result.failure !== undefined)
        outcome.failure = result.failure === null ? null : ["register", "restore", "order_check", "observe"].includes(result.failure) ? result.failure : "restore";
      if (result.currently_available === true)
        outcome.failure = null;
    },
    facts,
    notice() {
      const f = facts();
      if (observation.input === "clean" && f.restore_policy.enabled && !f.transport_overridden)
        return null;
      const settled = ["reenabled", "available", "failed", "central_off"].includes(f.state);
      if (!settled)
        return null;
      const id = `disabled:${key}:${generation}:${f.state}`;
      const signIn = o.line === "v1" ? "If signed out, type /enpal-login." : "If signed out, run opencode auth login and choose Enpal AI Gateway.";
      return {
        id,
        title: f.state === "reenabled" ? "Enpal AI Gateway is back on" : f.state === "available" ? "Enpal AI Gateway is available" : "Enpal AI Gateway needs attention",
        variant: f.state === "reenabled" || f.state === "available" ? "info" : "warning",
        duration: 60000,
        message: [f.summary, f.currently_available === true ? signIn : null, f.repair].filter(Boolean).join(" ")
      };
    }
  };
}

// src/build/hosted-v1.ts
var record4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var strings2 = (v) => Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
var nonEmpty = (v) => typeof v === "string" && v !== "";
function optionsBase(block) {
  return record4(block) && record4(block.options) && nonEmpty(block.options.baseURL) ? block.options.baseURL : undefined;
}
function providerApi(block) {
  return record4(block) && nonEmpty(block.api) ? block.api : undefined;
}
function modelApi(block, modelID) {
  const model = record4(block) && record4(block.models) ? block.models[modelID] : undefined;
  return record4(model) && record4(model.provider) && nonEmpty(model.provider.api) ? model.provider.api : undefined;
}
function modelBase(block, modelID) {
  const listed = record4(block) && record4(block.models) && Object.hasOwn(block.models, modelID);
  return optionsBase(block) ?? (listed ? modelApi(block, modelID) ?? providerApi(block) : undefined);
}
function wholeHosted(policy, block) {
  return hostedDestination(policy, optionsBase(block));
}
function hostedProviderV1(cfg, policy, providerID) {
  if (typeof providerID !== "string" || providerID === PROVIDER_ID)
    return false;
  if (hostedProvider(policy, providerID))
    return true;
  return wholeHosted(policy, record4(cfg.provider) ? cfg.provider[providerID] : undefined);
}
function hostedModelRef(cfg, policy, ref) {
  if (typeof ref !== "string" || !ref.includes("/"))
    return false;
  const providerID = ref.slice(0, ref.indexOf("/")), modelID = ref.slice(ref.indexOf("/") + 1);
  if (providerID === PROVIDER_ID)
    return false;
  if (hostedProviderV1(cfg, policy, providerID))
    return true;
  const block = record4(cfg.provider) ? cfg.provider[providerID] : undefined;
  return hostedDestination(policy, modelBase(block, modelID));
}
function hostedResolvedV1(policy, input) {
  const provider = record4(input.provider) ? input.provider : undefined;
  const model = record4(input.model) ? input.model : undefined;
  if (record4(model) && model.providerID === PROVIDER_ID)
    return false;
  const url2 = optionsBase(provider) ?? (record4(model) && record4(model.api) && nonEmpty(model.api.url) ? model.api.url : undefined);
  return hostedDestination(policy, url2);
}
function hideHostedV1(cfg, policy, usable) {
  const out = { disabled: [], blacklisted: [], moved: [] };
  const ids = new Set(policy.hosted.providers.filter((id) => id !== PROVIDER_ID));
  const providers = record4(cfg.provider) ? cfg.provider : {};
  for (const [id, block] of Object.entries(providers)) {
    if (id === PROVIDER_ID || !record4(block))
      continue;
    if (wholeHosted(policy, block)) {
      ids.add(id);
      continue;
    }
    if (optionsBase(block) || !record4(block.models))
      continue;
    for (const modelID of Object.keys(block.models)) {
      if (!hostedDestination(policy, modelBase(block, modelID)))
        continue;
      const list = strings2(block.blacklist) ?? [];
      if (!list.includes(modelID))
        block.blacklist = [...list, modelID];
      out.blacklisted.push(`${id}/${modelID}`);
    }
  }
  const before = cfg.disabled_providers === undefined ? [] : strings2(cfg.disabled_providers);
  if (before) {
    const disabled = [...before];
    for (const id of ids)
      if (!disabled.includes(id)) {
        disabled.push(id);
        out.disabled.push(id);
      }
    if (out.disabled.length)
      cfg.disabled_providers = disabled;
  }
  for (const field of ["model", "small_model"]) {
    const ref = cfg[field];
    if (typeof ref !== "string" || !hostedModelRef(cfg, policy, ref))
      continue;
    if (usable(policy.default_model)) {
      cfg[field] = policy.default_model;
      out.moved.push({ field, from: ref, to: policy.default_model });
    } else {
      delete cfg[field];
      out.moved.push({ field, from: ref, to: null });
    }
  }
  return out;
}
var hostedRefusalV1 = hostedRefusal;
function hostedDefaultNoticeV1(m) {
  return {
    id: `hosted-default:${m.from}:${m.to ?? "none"}`,
    title: "Default model changed",
    variant: "warning",
    message: `Your default model ${m.from} uses an OpenCode-hosted service blocked by company policy` + (m.to ? `; OpenCode uses ${m.to} instead.` : ". No usable model was found; choose an Enpal model or your own provider.")
  };
}

// src/build/provider-notices.ts
import { createHash as createHash8 } from "node:crypto";
import { mkdirSync as mkdirSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join12 } from "node:path";
var OTHER_NOTICE_PREFIX = "other-provider:";
function localDay(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
var otherNoticeId = (providerID, day, text) => OTHER_NOTICE_PREFIX + createHash8("sha256").update(JSON.stringify([providerID, day, text])).digest("hex");
function otherProviderNotices(cacheDir, now = Date.now, log = () => {}, shown = fileNoticeStore(cacheDir).shown) {
  const owned = new Map;
  return {
    observe(providerID, policy) {
      const at = now(), day = localDay(at);
      const id = otherNoticeId(providerID, day, policy.notice);
      if (owned.has(id))
        return null;
      try {
        if (Object.hasOwn(shown(), id))
          return null;
      } catch {}
      try {
        const root = join12(cacheDir, "provider-notices");
        mkdirSync5(root, { recursive: true });
        writeFileSync4(join12(root, id.slice(OTHER_NOTICE_PREFIX.length) + ".json"), JSON.stringify({ provider: providerID, day, text: policy.notice, queued_at: at }), { mode: 384 });
      } catch {
        try {
          log("Other-provider reminder evidence could not be written");
        } catch {}
      }
      const notice = { id, title: "Using another AI provider", variant: "warning", message: policy.notice };
      owned.set(id, notice);
      return notice;
    },
    queued: () => [...owned.values()]
  };
}

// src/build/policy-bootstrap.ts
import { readFileSync as readFileSync10, statSync as statSync8 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join13 } from "node:path";
var POLICY_BOOTSTRAP_BUDGET_MS = 1500;
var POINTER_MAX2 = 256 * 1024;
var record5 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var directory = (o) => o.cacheDir ?? join13(homedir5(), ".enpal", "gateway", "plugins", baseKey(o.base));
var note = (o, text) => {
  try {
    o.log?.(text);
  } catch {}
};
function rawPointer(dir) {
  try {
    const path = join13(dir, "pointer.json");
    if (statSync8(path).size > POINTER_MAX2)
      return null;
    const raw = JSON.parse(readFileSync10(path, "utf8"));
    return record5(raw) && raw.schema === 1 && record5(raw.release) ? raw.policy : null;
  } catch {
    return null;
  }
}
function prepareModelsPolicy(o, confirmed) {
  const dir = directory(o), state = modelsPolicyState(o.base);
  const candidates = [
    { raw: confirmed, source: "gateway" },
    { raw: o.policy, source: "handed" },
    { raw: readPolicySnapshot(dir, o.base, o.log)?.policy, source: "saved" },
    { raw: rawPointer(dir), source: "pointer" }
  ];
  const sections = candidates.filter((c) => record5(c.raw) && Object.hasOwn(c.raw, "models_policy")).map((c) => ({ source: c.source, raw: c.raw.models_policy }));
  if (sections.length)
    acceptModelsPolicy(state, sections, o.base, o.log);
  for (const c of [...candidates].reverse())
    if (record5(c.raw)) {
      const legacy = readReleasePolicy(c.raw, o.log);
      acceptPolicySnapshot(state, legacy ?? { models_policy: c.raw.models_policy }, o.base, c.source, o.log);
    }
  const snapshot = state.snapshot ?? acceptPolicySnapshot(state, {}, o.base, "handed", o.log);
  const saved = readPolicySnapshot(dir, o.base);
  if (Object.values(snapshot.sections).some((s) => s === "valid" || s === "held") && (!saved || JSON.stringify(saved.policy) !== JSON.stringify(snapshot.policy))) {
    savePolicySnapshot(dir, snapshot, Date.now(), o.log);
  }
  return snapshot;
}
async function bootstrapModelsPolicy(o) {
  let snapshot = prepareModelsPolicy(o);
  const state = modelsPolicyState(o.base);
  if (state.source !== "builtin")
    return snapshot;
  const remaining = Math.min(POLICY_BOOTSTRAP_BUDGET_MS, o.deadlineAt === undefined ? POLICY_BOOTSTRAP_BUDGET_MS : Math.max(0, o.deadlineAt - Date.now()));
  if (!remaining || o.signal?.aborted)
    return snapshot;
  const timeout = AbortSignal.timeout(remaining);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  try {
    assertSecureEndpoint(o.base);
    const base = new URL(o.base);
    if (base.username || base.password || base.search || base.hash)
      throw new Error("base_shape");
    const url2 = `${o.base.replace(/\/+$/, "")}/store/plugin-release.json`;
    const body = await untilAborted((async () => {
      const response = await (o.fetch ?? fetch)(url2, { signal, redirect: "error", credentials: "omit", headers: {
        Accept: "application/json",
        "X-Enpal-Plugin-Line": o.line,
        "X-Enpal-Loader": String(o.loaderVersion)
      } });
      if (!response.ok)
        throw new Error(`pointer_http_${response.status}`);
      return await readBoundedJson(response, POINTER_MAX2);
    })(), signal);
    if (!record5(body) || body.schema !== 1 || !record5(body.release))
      throw new Error("pointer_shape");
    snapshot = prepareModelsPolicy(o, body.policy);
  } catch (e) {
    note(o, `models policy bootstrap held: ${e?.message ?? e}`);
  }
  return snapshot;
}

// src/build/notes.ts
import { mkdirSync as mkdirSync6, readFileSync as readFileSync11, statSync as statSync9, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname3, join as join14 } from "node:path";
var AUTO_NOTE_MAX_SESSIONS = 200;
var AUTO_NOTE_OFF_PREFIX = "— Enpal Auto is off for you: ";
function autoNoteLine(m) {
  if (m.off)
    return `

${AUTO_NOTE_OFF_PREFIX}${m.name}`;
  return `

— Enpal Auto: ${m.name}${m.source === "default" ? " (default)" : ""}`;
}
function noteIdentity(m) {
  return m.off ? `${m.model}|off` : m.model;
}
var SF_KEY = /^[a-z*][a-z0-9_\-.*]*/;
var SF_TOKEN = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/;
var SF_INT = /^-?\d{1,15}/;
function parseEnpalFeatures(value) {
  if (typeof value !== "string" || !value.trim())
    return null;
  let rest = value.trim();
  const out = new Map;
  const bare = () => {
    if (rest.startsWith("?")) {
      const b = rest[1];
      if (b !== "0" && b !== "1")
        return null;
      rest = rest.slice(2);
      return b === "1";
    }
    if (rest.startsWith('"')) {
      let text = "";
      let i = 1;
      for (;i < rest.length; i++) {
        const c = rest[i];
        if (c === "\\") {
          const n = rest[i + 1];
          if (n !== '"' && n !== "\\")
            return null;
          text += n;
          i++;
        } else if (c === '"') {
          break;
        } else {
          const code = rest.charCodeAt(i);
          if (code < 32 || code > 126)
            return null;
          text += c;
        }
      }
      if (i >= rest.length)
        return null;
      rest = rest.slice(i + 1);
      return text;
    }
    const int2 = SF_INT.exec(rest);
    if (int2 && !/^[A-Za-z*]/.test(rest)) {
      rest = rest.slice(int2[0].length);
      return Number(int2[0]);
    }
    const token = SF_TOKEN.exec(rest);
    if (token) {
      rest = rest.slice(token[0].length);
      return token[0];
    }
    return null;
  };
  while (rest.length) {
    const key = SF_KEY.exec(rest);
    if (!key)
      return null;
    rest = rest.slice(key[0].length);
    let value2 = true;
    if (rest.startsWith("=")) {
      rest = rest.slice(1);
      if (rest.startsWith("("))
        return null;
      value2 = bare();
      if (value2 === null)
        return null;
    }
    const params = {};
    while (rest.startsWith(";")) {
      rest = rest.slice(1).replace(/^ +/, "");
      const pk = SF_KEY.exec(rest);
      if (!pk)
        return null;
      rest = rest.slice(pk[0].length);
      let pv = true;
      if (rest.startsWith("=")) {
        rest = rest.slice(1);
        pv = bare();
        if (pv === null)
          return null;
      }
      params[pk[0]] = pv;
    }
    out.set(key[0], { on: value2 === true, params });
    rest = rest.replace(/^[ \t]*/, "");
    if (!rest.length)
      break;
    if (!rest.startsWith(","))
      return null;
    rest = rest.slice(1).replace(/^[ \t]*/, "");
    if (!rest.length)
      return null;
  }
  return out;
}
function autoFromHeaders(headers) {
  const member = parseEnpalFeatures(headers.get("x-enpal-features"))?.get("auto");
  if (member && typeof member.params.model === "string" && member.params.model) {
    const model2 = member.params.model;
    const name15 = typeof member.params.name === "string" && member.params.name ? member.params.name : model2;
    const why = typeof member.params.why === "string" ? member.params.why : undefined;
    if (!member.on) {
      return why === "store_fault" ? { model: model2, name: name15, source: "default", why } : { model: model2, name: name15, source: "off", off: true, why };
    }
    return { model: model2, name: name15, source: typeof member.params.source === "string" ? member.params.source : "" };
  }
  const model = headers.get("x-enpal-auto-model");
  if (!model)
    return null;
  return { model, name: headers.get("x-enpal-auto-model-name") || model, source: headers.get("x-enpal-auto-source") || "" };
}
var AUTO_TITLE_SEP = " · Auto: ";
var AUTO_TITLE_OFF = `${AUTO_TITLE_SEP}off`;
var DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
var AUTO_MODEL_NAMES = [
  "DeepSeek V4.1 Flash",
  "DeepSeek V4 Flash",
  "DeepSeek V4 Pro",
  "GLM-5.3 Flash",
  "GPT-5.6 Luna",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.3-flash",
  "gpt-5.6-luna"
];
function autoTitle(title, m, known = AUTO_MODEL_NAMES) {
  let base = title;
  for (const name15 of known) {
    const tail = [`${AUTO_TITLE_SEP}${name15} (default)`, `${AUTO_TITLE_SEP}${name15}`].find((t) => title.endsWith(t));
    if (tail && title.length - tail.length < base.length)
      base = title.slice(0, -tail.length);
  }
  if (title.endsWith(AUTO_TITLE_OFF) && title.length - AUTO_TITLE_OFF.length < base.length) {
    base = title.slice(0, -AUTO_TITLE_OFF.length);
  }
  if (m.off)
    return `${base}${AUTO_TITLE_OFF}`;
  return `${base}${AUTO_TITLE_SEP}${m.name}${m.source === "default" ? " (default)" : ""}`;
}
function memoryNoteStore() {
  let saved = {};
  return { load: () => ({ ...saved }), save: (noted) => {
    saved = { ...noted };
  } };
}
var AUTO_NOTE_FILE_MAX_BYTES = 64 * 1024;
function capNoted(noted) {
  const entries = Object.entries(noted).filter(([k, m]) => typeof m === "string" && k.length <= 128 && m.length <= 128);
  return Object.fromEntries(entries.slice(-AUTO_NOTE_MAX_SESSIONS));
}
function fileNoteStore(path = join14(homedir6(), ".enpal", "gateway", "auto-notes.json")) {
  return {
    load() {
      try {
        if (statSync9(path).size > AUTO_NOTE_FILE_MAX_BYTES)
          return {};
        const v = JSON.parse(readFileSync11(path, "utf8"));
        if (typeof v !== "object" || v === null || Array.isArray(v))
          return {};
        return capNoted(v);
      } catch {
        return {};
      }
    },
    save(noted) {
      try {
        mkdirSync6(dirname3(path), { recursive: true });
        writeFileSync5(path, JSON.stringify(capNoted(noted)));
      } catch {}
    }
  };
}
function createAutoNotes(store = memoryNoteStore(), retitle) {
  const recorded = new Map;
  const noted = new Map;
  const titles = new Map;
  const failed = new Map;
  const names = new Set(AUTO_MODEL_NAMES);
  const writing = new Map;
  const echoes = new Map;
  const onAuto = new Map;
  const compacting = new Set;
  const remember = (map2, key, value) => {
    map2.delete(key);
    map2.set(key, value);
    if (map2.size > AUTO_NOTE_MAX_SESSIONS)
      map2.delete(map2.keys().next().value);
  };
  const retitleIfNeeded = (sessionID) => {
    const m = recorded.get(sessionID);
    const title = titles.get(sessionID);
    if (!retitle || writing.has(sessionID) || !m || title === undefined || DEFAULT_TITLE.test(title))
      return;
    const want = autoTitle(title, m, names);
    if (want === title || failed.get(sessionID) === want)
      return;
    const w = { base: title, want };
    writing.set(sessionID, w);
    remember(echoes, sessionID, [...echoes.get(sessionID) ?? [], want].slice(-5));
    Promise.resolve().then(() => retitle(sessionID, want)).then(() => {
      failed.delete(sessionID);
      remember(titles, sessionID, w.newer ?? want);
    }, () => {
      remember(failed, sessionID, want);
      const pending = echoes.get(sessionID) ?? [];
      const at = pending.lastIndexOf(want);
      if (at >= 0)
        remember(echoes, sessionID, [...pending.slice(0, at), ...pending.slice(at + 1)]);
      if (w.newer !== undefined)
        remember(titles, sessionID, w.newer);
    }).finally(() => {
      writing.delete(sessionID);
      retitleIfNeeded(sessionID);
    });
  };
  const take = (sessionID) => {
    const m = recorded.get(sessionID);
    if (!m || onAuto.get(sessionID) !== true)
      return null;
    const identity = noteIdentity(m);
    if (noted.get(sessionID) === identity)
      return null;
    const stored = store.load();
    if (stored[sessionID] === identity) {
      remember(noted, sessionID, identity);
      return null;
    }
    remember(noted, sessionID, identity);
    const { [sessionID]: _previous, ...rest } = stored;
    store.save({ ...rest, [sessionID]: identity });
    return autoNoteLine(m);
  };
  return {
    take,
    record(requestHeaders, responseHeaders) {
      const sessionID = requestHeaders.get("x-session-id");
      const m = autoFromHeaders(responseHeaders);
      if (!sessionID || !m)
        return;
      compacting.delete(sessionID);
      remember(recorded, sessionID, m);
      names.add(m.name);
      retitleIfNeeded(sessionID);
    },
    async textComplete(input, output) {
      if (compacting.has(input.sessionID))
        return;
      if (!output.text.trim())
        return;
      const line = take(input.sessionID);
      if (line)
        output.text += line;
    },
    async modelCall(input) {
      const sessionID = input?.sessionID;
      if (!sessionID)
        return;
      if (input.agent === "title" || input.agent === "compaction")
        return;
      const auto = input.model?.providerID === PROVIDER_ID && input.model?.id === "auto";
      remember(onAuto, sessionID, auto);
      if (!auto)
        recorded.delete(sessionID);
    },
    async compactingStarted(input) {
      if (input?.sessionID)
        compacting.add(input.sessionID);
    },
    async onEvent(input) {
      const e = input?.event;
      if (e?.type === "session.compacted" && e.properties?.sessionID)
        compacting.delete(e.properties.sessionID);
      const info = e?.properties?.info;
      if ((e?.type === "session.updated" || e?.type === "session.created") && info?.id && typeof info.title === "string" && !info.parentID) {
        const pending = echoes.get(info.id) ?? [];
        const at = pending.indexOf(info.title);
        if (at >= 0) {
          remember(echoes, info.id, pending.slice(at + 1));
          if (at < pending.length - 1)
            return;
        }
        const w = writing.get(info.id);
        if (w && at < 0 && (w.newer !== undefined || info.title !== w.base))
          w.newer = info.title;
        remember(titles, info.id, info.title);
        retitleIfNeeded(info.id);
      }
    }
  };
}

// src/build/login-command.ts
var LOGIN_COMMAND = "enpal-login";
var LOGIN_DEADLINE_MS = BROWSER_LOGIN_DEADLINE_MS;
var LOGIN_CALL_MS = 30000;
var LOGIN_COMMAND_DEF = {
  description: "Sign in to the Enpal AI Gateway (opens your browser only when needed; --relogin to switch accounts). No `az login` needed.",
  template: 'The Enpal AI Gateway login command ran in the plugin. Reply with exactly one short line: "Enpal AI Gateway login: see the notice."'
};
var isRecord5 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function addLoginCommand(cfg) {
  if (cfg.command !== undefined && !isRecord5(cfg.command))
    return false;
  const commands = isRecord5(cfg.command) ? cfg.command : {};
  if (LOGIN_COMMAND in commands)
    return false;
  cfg.command = { ...commands, [LOGIN_COMMAND]: { description: LOGIN_COMMAND_DEF.description, template: LOGIN_COMMAND_DEF.template } };
  return true;
}
function withTimeout(p, ms, what) {
  return new Promise((resolve4, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}_timeout`)), ms);
    p.then((v) => {
      clearTimeout(timer);
      resolve4(v);
    }, (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
function loginOverrides(env) {
  const out = [];
  if (serviceKeyFromEnv(env))
    out.push("ENPAL_GATEWAY_SERVICE_KEY is set, so requests use that service key, not your login");
  if (env.OPENCODE_AUTH_CONTENT)
    out.push("OPENCODE_AUTH_CONTENT is set, so OpenCode reads its login from there and a new sign-in does not take effect");
  return out;
}
function reason(e) {
  const m = e?.message ?? "";
  if (e instanceof NonInteractiveLoginRequiredError)
    return "browser sign-in is switched off here (ENPAL_GATEWAY_INTERACTIVE=0)";
  if (e instanceof PersistFailedError || m.startsWith("save_") || m.startsWith("auth store"))
    return "you signed in, but OpenCode did not save the login; nothing changed";
  if (m === "login_timeout" || m === "deadline" || e?.name === "AbortError" || e?.name === "TimeoutError")
    return `the browser sign-in did not finish within ${Math.round(LOGIN_DEADLINE_MS / 60000)} minutes`;
  if (m === "login_cancelled")
    return "OpenCode closed before the sign-in finished";
  if (m.startsWith("authorize_error"))
    return "the sign-in was cancelled or refused in the browser";
  if (m === "state_mismatch" || m === "missing_code")
    return "the browser came back with an answer that did not match this sign-in";
  if (m.startsWith("exchange_timeout") || m.startsWith("token_request_failed"))
    return "the gateway did not complete the sign-in";
  return "the gateway could not be reached or did not complete the sign-in";
}
async function runLoginCommand(args, d) {
  const log = (m) => {
    try {
      d.log?.(`login command: ${m}`);
    } catch {}
  };
  const notes = loginOverrides(d.env);
  const say = (ok, text) => {
    const message = ok ? `${text} Quit OpenCode fully and start it again to use the new login.` : text;
    return { ok, message: notes.length ? `${message} Note: ${notes.join("; ")}.` : message };
  };
  const relogin = /(^|\s)--relogin(\s|$)/.test(args ?? "");
  const callMs = d.callMs ?? LOGIN_CALL_MS;
  const deadlineAt = Date.now() + (d.deadlineMs ?? LOGIN_DEADLINE_MS);
  const left = () => Math.max(1, deadlineAt - Date.now());
  const bounded = { ...d.deps, fetch: (input, init) => {
    const timeout = AbortSignal.timeout(callMs);
    return d.deps.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } };
  const observed = (onAck) => (t) => {
    const raw = d.persist(t);
    raw.then(() => {
      try {
        onAck?.();
      } catch {}
    }, () => {});
    return withTimeout(raw, callMs, "save").catch(() => {
      throw new Error("save_failed");
    });
  };
  const before = d.readLogin();
  if (!relogin && before) {
    const skew = d.config.skewSeconds ?? 60;
    if (before.record.access && d.deps.now() < Math.floor(before.record.expires / 1000) - skew) {
      log("already signed in");
      return say(true, "Already signed in to the Enpal AI Gateway.");
    }
    if (before.source === "file") {
      try {
        const heldOther = unsavedSuccessor(d.config, before.record.refresh)?.sameFamily === false;
        const oldRefresh = before.record.refresh;
        const persist = observed(heldOther ? () => d.replaced(oldRefresh) : undefined);
        const t = await withTimeout(sharedRefresh(d.config, bounded, persist, before.record.refresh), Math.min(callMs * 2, left()), "refresh");
        if (!t.sameFamily) {
          log("signed in (a held login was saved)");
          return say(true, "Signed in to the Enpal AI Gateway.");
        }
        if (t.refresh_token !== before.record.refresh) {
          try {
            d.rotated?.(before.record.refresh, t.refresh_token);
          } catch {}
        }
        log("signed in; session renewed");
        return say(true, "Already signed in to the Enpal AI Gateway (session renewed).");
      } catch (e) {
        if (!(e instanceof ReLoginRequiredError)) {
          log(`renewal failed (${reason(e)})`);
          return say(false, `Enpal AI Gateway login failed: ${reason(e)}.`);
        }
        log("the stored login was refused; browser sign-in");
      }
    }
  }
  if (browserSwitchedOff(d.env)) {
    log("browser sign-in switched off");
    return say(false, `Enpal AI Gateway login failed: ${reason(new NonInteractiveLoginRequiredError)}.`);
  }
  const replaced = () => {
    try {
      d.replaced(before?.record.refresh ?? null);
    } catch {}
  };
  const flight = browserFlight(d.config, d.deps, { open: (u) => openBrowser(u, d.sys), persist: d.persist, afterSave: replaced, deadlineMs: left(), callMs });
  const release = flight.join();
  const waiter = new AbortController;
  const untrack = d.track?.(() => {
    release();
    waiter.abort();
  });
  try {
    const t = await untilAborted(flight.done, AbortSignal.any([waiter.signal, AbortSignal.timeout(left())]));
    if (!flight.saved())
      await observed(replaced)(t);
    const after = d.readLogin();
    if (!after || after.record.refresh !== t.refresh_token) {
      log("the saved login is not the new one");
      return say(false, "Enpal AI Gateway login failed: you signed in, but OpenCode does not use the new login.");
    }
    log("signed in");
    return say(true, "Signed in to the Enpal AI Gateway.");
  } catch (e) {
    const why = reason(waiter.signal.aborted ? new Error("login_cancelled") : e);
    log(`failed (${why})`);
    return say(false, `Enpal AI Gateway login failed: ${why}.`);
  } finally {
    release();
    untrack?.();
  }
}
function resultParts(parts, outcome) {
  const text = `Reply with exactly this one line and nothing else: ${outcome.message}`;
  const first = parts.find((p) => isRecord5(p) && p.type === "text");
  return [first ? { ...first, text } : { type: "text", text }];
}

// src/build/watcher.ts
import { join as join15 } from "node:path";

// src/build/policy.ts
import { createHash as createHash9 } from "node:crypto";

// src/build/provider-lock.ts
var DEAD_BASE = "http://127.0.0.1:9";
var AI_SDK_SENTINEL = "https://ai-sdk.local";
var BLOCKED_PACKAGE = "file:///enpal-hosted-models/this-hosted-model-is-blocked.js";
var TESTED_HOSTS = Object.freeze([]);
var hostTested = (v) => typeof v === "string" && TESTED_HOSTS.includes(v);
var KICK_MAX2 = 6;
var KICK_WINDOW_MS2 = 1e4;
var record6 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var ref = (r) => `${String(r.providerID)}/${String(r.id ?? r.modelID)}`;
var address = (r) => record6(r?.settings) ? r.settings.baseURL : undefined;
var usable = (s, id) => !hostedProvider(s.policy, id);
function refusalText(_s, id) {
  return hostedRefusal(id);
}
function modelRequestRefusal(s, r, inherited = {}) {
  return hostedRoute(s.policy, { ...inherited, providerID: r.model.providerID, ...r.baseURL !== undefined ? { baseURL: r.baseURL, effectiveOverride: true } : {} }) ? refusalText(s, r.model.providerID) : null;
}
function destinationAllowed(s, id, url2) {
  return !hostedRoute(s.policy, { providerID: id, baseURL: url2, effectiveOverride: true });
}
function aisdkRefusal(s, e, inherited = {}) {
  const baseURL = e.options?.baseURL;
  return hostedRoute(s.policy, {
    ...inherited,
    providerID: e.model?.providerID,
    package: e.package ?? e.model?.package ?? inherited.package,
    ...baseURL !== undefined ? { baseURL, effectiveOverride: true } : {}
  }) ? refusalText(s, e.model?.providerID) : null;
}
function blockRow(row) {
  row.package = BLOCKED_PACKAGE;
  row.enabled = false;
  row.settings = { ...record6(row.settings) ? row.settings : {}, baseURL: DEAD_BASE };
  if (Array.isArray(row.variants)) {
    for (const v of row.variants)
      if (record6(v))
        v.settings = { ...record6(v.settings) ? v.settings : {}, baseURL: DEAD_BASE };
  }
}
function routeOf(row, provider, variant) {
  const baseURL = address(variant) ?? address(row) ?? address(provider);
  return {
    providerID: row.providerID ?? row.id,
    canonical: row.canonical ?? provider?.canonical,
    package: row.package ?? provider?.package,
    baseURL,
    effectiveOverride: typeof baseURL === "string"
  };
}
function providerHosted(s, p) {
  return hostedRoute(s.policy, routeOf(p));
}
function filterProviders(s, e) {
  const removed = [];
  for (const r of e.list()) {
    const id = String(r.provider.id);
    if (id === PROVIDER_ID)
      continue;
    const p = r.provider;
    if (!providerHosted(s, p))
      continue;
    if (!hostedProvider(s.policy, id) && [...r.models.values()].some((m) => !hostedRoute(s.policy, routeOf(m, p))))
      continue;
    e.remove(id);
    removed.push(id);
  }
  return removed;
}
function filterModels(s, m) {
  const removed = [], variants = [];
  const old = m.default.get(), from = old ? `${String(old.providerID)}/${String(old.modelID)}` : null;
  let refused = !!old && hostedProvider(s.policy, String(old.providerID));
  for (const row of [...m.list()]) {
    const id = String(row.providerID), key = ref(row);
    if (id === PROVIDER_ID)
      continue;
    const p = m.provider?.get(id)?.provider;
    if (hostedRoute(s.policy, routeOf(row, p))) {
      removed.push(key);
      if (from === key)
        refused = true;
      if (m.provider?.get(id))
        blockRow(row);
      else
        m.remove(id, String(row.id ?? row.modelID));
      continue;
    }
    if (Array.isArray(row.variants))
      row.variants = row.variants.filter((v) => {
        if (!record6(v) || !hostedRoute(s.policy, routeOf(row, p, v)))
          return true;
        variants.push(`${key}:${String(v.id)}`);
        return false;
      });
  }
  const listed = m.list(), rows = listed.filter((r) => usable(s, r.providerID) && r.enabled !== false && r.package !== BLOCKED_PACKAGE && !removed.includes(ref(r)));
  if (from && rows.some((r) => ref(r) === from))
    return { removed, variants, defaultReplaced: null, defaultResult: { from, to: from, changed: false } };
  if (from && listed.some((r) => ref(r) === from && r.package === BLOCKED_PACKAGE))
    refused = true;
  const pick2 = rows.find((r) => ref(r) === s.policy.default_model) ?? rows.find((r) => String(r.providerID) === PROVIDER_ID), to = pick2 ? ref(pick2) : null;
  if (pick2)
    m.default.set(String(pick2.providerID), String(pick2.id ?? pick2.modelID));
  return { removed, variants, defaultReplaced: refused && from ? { from, to } : null, defaultResult: { from, to, changed: from !== to } };
}
function createLockRegistrations(ctx, s, opts) {
  const effects = {
    removedProviders: [],
    removedModels: [],
    removedVariants: [],
    removals: 0,
    defaultReplaced: null,
    defaultResult: null,
    refused: 0,
    failures: 0,
    lastFailure: null,
    used: new Set,
    available: new Set,
    missing: new Set
  };
  let providers = new Map, models = new Map;
  let current = [], disposed = false, registering = null, again = false;
  const owned = new Set;
  const releaseOne = async (r) => {
    if (owned.delete(r))
      await r.dispose().catch(() => {});
  };
  const log = (m) => {
    try {
      opts.log(m);
    } catch {}
  };
  const note2 = (what, e) => {
    effects.failures++;
    effects.lastFailure = `${what}: ${e?.message ?? e}`;
    effects.missing.add(what);
    log(`hosted policy: ${effects.lastFailure}`);
  };
  const safe = (what, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      note2(what, e);
      return fallback;
    }
  };
  const guard = (what, id, check2) => {
    let text = null;
    try {
      text = check2();
    } catch (e) {
      note2(what, e);
      if (hostedProvider(s.policy, id))
        text = refusalText(s, id);
    }
    if (!text)
      return;
    effects.refused++;
    log(`hosted policy: refused ${String(id)} (${what})`);
    throw new Error(text);
  };
  const inherited = (id, model) => routeOf(models.get(`${String(id)}/${String(model)}`) ?? { providerID: id }, providers.get(String(id)));
  const kicks = [];
  const kick = () => {
    const now = Date.now();
    while (kicks.length && now - kicks[0] > KICK_WINDOW_MS2)
      kicks.shift();
    if (kicks.length >= KICK_MAX2)
      return;
    kicks.push(now);
    Promise.resolve().then(() => relast()).catch(() => {});
  };
  const registerSet = async () => {
    const set2 = [];
    let complete = true;
    const add = async (what, fn, required2 = false) => {
      if (disposed)
        return;
      try {
        const r = await fn();
        owned.add(r);
        if (disposed) {
          await releaseOne(r);
          return;
        }
        set2.push(r);
        effects.missing.delete(what);
      } catch (e) {
        complete = false;
        note2(what, e);
        if (required2)
          throw e;
      }
    };
    try {
      await add("model.request", () => ctx.session.hook("model.request", (r) => guard("model.request", r.model.providerID, () => modelRequestRefusal(s, r, inherited(r.model.providerID, r.model.id)))), true);
      await add("http.request", () => ctx.session.hook("http.request", (r) => guard("http.request", r.model.providerID, () => destinationAllowed(s, r.model.providerID, r.request.url) ? null : refusalText(s, r.model.providerID))), true);
      await add("ws.handshake", () => ctx.session.hook("experimental.ws.handshake", (r) => guard("ws.handshake", r.model.providerID, () => destinationAllowed(s, r.model.providerID, r.url) ? null : refusalText(s, r.model.providerID))));
      if (ctx.aisdk?.hook)
        for (const name15 of ["sdk", "language"])
          await add(`aisdk.${name15}`, () => ctx.aisdk.hook(name15, (e) => guard(`aisdk.${name15}`, e.model?.providerID, () => aisdkRefusal(s, e, inherited(e.model?.providerID, e.model?.id)))));
      else {
        effects.missing.add("aisdk");
        log("hosted policy: aisdk hooks unavailable; native and cached Generate paths remain uncovered");
      }
      await add("use observer", () => ctx.session.hook("model.request", (r) => safe("use observer", () => {
        if (opts.ownsRequest?.(r, inherited(r.model.providerID, r.model.id)))
          return;
        const id = String(r.model.providerID);
        effects.used.add(id);
        opts.onUse?.(id);
      }, undefined)));
      await add("provider filter", () => ctx.provider.transform((e) => safe("provider filter", () => {
        providers = new Map(e.list().map((r) => [String(r.provider.id), r.provider]));
        effects.removedProviders = filterProviders(s, e);
        effects.removals += effects.removedProviders.length;
        effects.available = new Set(e.list().map((r) => String(r.provider.id)).filter((id) => id !== PROVIDER_ID));
      }, undefined)));
      await add("model filter", () => ctx.model.transform((m) => safe("model filter", () => {
        models = new Map(m.list().map((r2) => [ref(r2), { ...r2 }]));
        const r = filterModels(s, m);
        effects.removedModels = r.removed;
        effects.removedVariants = r.variants;
        effects.removals += r.removed.length + r.variants.length;
        effects.available = new Set(m.list().filter((row) => row.providerID !== PROVIDER_ID && row.enabled !== false && row.package !== BLOCKED_PACKAGE && usable(s, row.providerID)).map((row) => String(row.providerID)));
        effects.defaultResult = r.defaultResult;
        if (r.defaultReplaced) {
          effects.defaultReplaced = r.defaultReplaced;
          safe("default notice", () => opts.onDefaultReplaced?.(r.defaultReplaced), undefined);
        }
        safe("effective model facts", () => opts.onFold?.(m), undefined);
        if ((m.provider.list?.() ?? []).some((p) => String(p.provider.id) !== PROVIDER_ID && providerHosted(s, p.provider)) || r.removed.length)
          kick();
      }, undefined)));
      return { set: set2, complete };
    } catch (e) {
      for (const r of set2.reverse())
        await releaseOne(r);
      throw e;
    }
  };
  const once = async (initial) => {
    try {
      const { set: next, complete } = await registerSet();
      if (disposed || !initial && !complete) {
        for (const r of next.reverse())
          await releaseOne(r);
        return;
      }
      const old = current;
      current = next;
      for (const r of old.reverse())
        await releaseOne(r);
    } catch (e) {
      if (initial)
        throw e;
      note2("register again", e);
    }
  };
  const relast = (initial = false) => {
    if (registering) {
      again = true;
      return registering;
    }
    return registering = (async () => {
      try {
        await once(initial);
        while (again && !disposed) {
          again = false;
          await once(false);
        }
      } finally {
        registering = null;
        again = false;
      }
    })();
  };
  const registration = { dispose: async () => {
    disposed = true;
    current = [];
    for (const r of [...owned].reverse())
      await releaseOne(r);
  } };
  let applied = s.digest;
  const followPolicy = (policy) => {
    const snapshot = acceptPolicySnapshot(s, policy, opts.base, "gateway", log);
    if (opts.cacheDir)
      savePolicySnapshot(opts.cacheDir, snapshot, Date.now(), log);
    if (s.digest === applied)
      return;
    applied = s.digest;
    for (const reload of [ctx.provider?.reload, ctx.model?.reload])
      if (reload)
        Promise.resolve().then(() => reload()).catch((e) => note2("policy refold", e));
  };
  return { relast, registration, effects, live: () => current.length, followPolicy, current: () => s };
}
function lockDefaultNotice(r) {
  return {
    id: `hosted-default:${r.from}:${r.to ?? "none"}`,
    title: "Default model changed",
    variant: "warning",
    message: `Your default model ${r.from} uses an OpenCode-hosted service blocked by company policy` + (r.to ? `; OpenCode uses ${r.to} instead.` : ". No usable model was found; choose an Enpal model or your own provider.")
  };
}
function lockFacts(s, e, version2) {
  return {
    models_policy: {
      source: s.source,
      revision: s.policy.revision,
      digest: s.digest,
      state: s.status === "accepted" ? "accepted" : "held",
      last_candidate: s.status,
      hosted: s.policy.hosted,
      default_model: s.policy.default_model,
      notice: s.policy.notice,
      restore_enpal: s.policy.restore_enpal
    },
    providers: { used: [...e?.used ?? []].sort(), usable: [...e?.available ?? []].sort(), reminder: s.policy.notice },
    host: { opencode: version2 ?? "unknown", tested: hostTested(version2), tested_versions: [...TESTED_HOSTS], mode: "warn" },
    removed_providers: e?.removedProviders ?? [],
    removed_models: e?.removedModels ?? [],
    removed_variants: e?.removedVariants ?? [],
    removals: e?.removals ?? 0,
    refused: e?.refused ?? 0,
    default_result: e?.defaultResult ?? null,
    default_replaced: e?.defaultReplaced ?? null,
    callback_failures: e?.failures ?? 0,
    missing: [...e?.missing ?? []]
  };
}

// src/build/policy.ts
function parsePolicy(raw, log) {
  return readReleasePolicy(raw, log);
}
function policyDigest(policy) {
  return policy ? createHash9("sha256").update(canonicalJson(policy)).digest("hex") : "";
}

// src/build/watcher.ts
var POLL_MS = 30 * 60000;
var JITTER = 0.2;
var CHECK_DEADLINE_MS = 5000;
var BACKOFF_MINUTES = [1, 2, 4, 8, 16, 30];
var HINT_COOLDOWN_MS = 60000;
var WAKE_JITTER_MS = 60000;
var TICK_MAX_MS = 5 * 60000;
var WAKE_GAP_MS = 2 * 60000;
var DOWNLOAD_DEADLINE_MS = 60000;
var RETRY_AFTER_MAX_MS = 6 * 3600000;
var APPROVED_HEADER = "X-Enpal-Plugin-Approved";
var REVISION_HEADER = "X-Enpal-Features-Rev";
var WATCHER_HEADER = "X-Enpal-Watcher";
var APPROVED_RE = /^(?:none|\d{4}-\d{2}-\d{2}\.\d{1,3})$/;
var REVISION_RE2 = /^(?:disabled|[0-9a-f]{16,64})$/;
var ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;
var LEASE_MS = 2 * 60000;
var TRANSITION_PREFIX = "transition:";
function watcherOff(env) {
  return ["0", "off", "false", "no"].includes(String(env.ENPAL_GATEWAY_WATCHER ?? "").trim().toLowerCase());
}
function defaultWatcherDeps() {
  return {
    now: () => Date.now(),
    random: Math.random,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
    clearTimer: (t) => clearTimeout(t)
  };
}
var isRecord6 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function endpoint(kind, nextAt) {
  return {
    kind,
    nextAt,
    lastSuccessAt: null,
    failures: 0,
    blockedUntil: 0,
    lastHintAt: -Infinity,
    inflight: null,
    dirty: false,
    hinted: undefined,
    unresolved: undefined,
    disabled: false
  };
}
function retryAfterMs(res, now) {
  if (res.status !== 429 && res.status !== 503)
    return;
  const raw = (res.headers.get("retry-after") ?? "").trim();
  if (!raw)
    return;
  if (/^\d{1,9}$/.test(raw))
    return Math.min(Number(raw) * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), RETRY_AFTER_MAX_MS) : undefined;
}
function hintValue(headers, name15, re) {
  const v = headers.get(name15);
  return v !== null && v.length <= 80 && re.test(v) ? v : null;
}
function projection(answer, catalogue) {
  const on = new Map;
  const names = new Map;
  for (const f of answer.features) {
    if (!recognised(f, catalogue))
      continue;
    on.set(f.key, f.on);
    names.set(f.key, f.name ?? f.key);
  }
  return { on, names };
}
function createWatcher(deps = defaultWatcherDeps()) {
  const targets = new Map;
  const retained = new Map;
  let timer = null;
  let expectedAt = deps.now();
  const spread = (ms) => ms * (1 + (deps.random() * 2 - 1) * JITTER);
  const interval = (t) => spread(t?.pollMs ?? POLL_MS);
  const backoff = (failures) => spread(BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] * 60000);
  const today = () => new Date(deps.now()).toISOString().slice(0, 10);
  const logOf = (t) => (m) => {
    try {
      t.subs[0]?.log?.(`watcher: ${m}`);
    } catch {}
  };
  const personal = (t) => t.subs.find((s) => s.login);
  const arm = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    let soonest = Infinity;
    for (const t of targets.values()) {
      for (const e of [t.pointer, t.features, t.picker])
        if (!e.inflight && !e.disabled)
          soonest = Math.min(soonest, e.nextAt);
      if (t.pending.size)
        soonest = Math.min(soonest, deps.now() + TICK_MAX_MS);
      for (const c of t.claims.values())
        soonest = Math.min(soonest, c.until);
    }
    if (soonest === Infinity)
      return;
    const now = deps.now();
    const delay = Math.max(0, Math.min(soonest - now, TICK_MAX_MS));
    expectedAt = now + delay;
    timer = deps.setTimer(tick, delay);
  };
  const tick = () => {
    timer = null;
    const now = deps.now();
    const woke = now - expectedAt > WAKE_GAP_MS;
    for (const t of targets.values()) {
      for (const e of [t.pointer, t.features, t.picker]) {
        if (e.inflight || e.disabled || e.nextAt > now)
          continue;
        if (woke) {
          e.nextAt = now + deps.random() * WAKE_JITTER_MS;
          continue;
        }
        runCheck(t, e);
      }
      if (t.pending.size)
        flushTarget(t);
    }
    arm();
  };
  const settle = (t, e, outcome) => {
    const now = deps.now();
    e.unresolved = undefined;
    if (outcome.kind === "ok") {
      outcome.commit();
      e.failures = 0;
      e.lastSuccessAt = now;
      e.blockedUntil = 0;
      e.nextAt = now + interval(t);
    } else if (outcome.kind === "retry") {
      e.blockedUntil = 0;
      e.nextAt = now + HINT_COOLDOWN_MS;
      logOf(t)(`${e.kind} answer dropped (${outcome.reason}); asked again soon`);
    } else if (outcome.kind === "failed") {
      e.failures += 1;
      const delay = Math.max(backoff(e.failures), outcome.retryAfterMs ?? 0);
      e.nextAt = now + delay;
      e.blockedUntil = e.nextAt;
      logOf(t)(`${e.kind} check failed (${outcome.reason}); next in ${Math.round(delay / 1000)} s`);
    } else {
      e.failures = 0;
      e.blockedUntil = 0;
      e.nextAt = now + interval(t);
      if (outcome.kind === "slow")
        e.unresolved = e.hinted;
    }
    if (e === t.features && outcome.kind !== "ok")
      t.features.newest = { ok: false, at: now, why: outcome.kind };
    if (e === t.features)
      pickerGate(t);
  };
  const pickerGate = (t) => {
    const on = !!liveSub(t) && liveKey(t, LIVE_PICKER);
    if (on && t.picker.disabled)
      t.picker.nextAt = Math.min(t.picker.nextAt, deps.now());
    t.picker.disabled = !on;
    arm();
  };
  const runCheck = (t, e) => {
    if (e.inflight)
      return e.inflight;
    const run = (async () => {
      const signal = AbortSignal.any([t.controller.signal, AbortSignal.timeout(CHECK_DEADLINE_MS)]);
      let outcome;
      try {
        outcome = e.kind === "pointer" ? await readPointer(t, signal) : e.kind === "picker" ? await readPicker(t, signal) : await readFeatures(t, signal);
      } catch (err) {
        outcome = { kind: "failed", reason: err?.name === "AbortError" || err?.name === "TimeoutError" ? "deadline" : err?.message ?? String(err) };
      }
      if (t.stopped)
        return;
      settle(t, e, outcome);
    })();
    e.inflight = run.finally(() => {
      e.inflight = null;
      if (t.stopped)
        return;
      const confirmed = e.kind === "pointer" ? t.pointer.approved : e.kind === "picker" ? undefined : t.features.revision;
      if (e.dirty) {
        e.dirty = false;
        if (e.hinted !== undefined && e.hinted !== confirmed)
          requestCheck(t, e);
      }
      arm();
    });
    return e.inflight;
  };
  const requestCheck = (t, e) => {
    if (t.stopped || e.disabled)
      return;
    const now = deps.now();
    if (e.unresolved !== undefined && e.hinted === e.unresolved && now < e.nextAt)
      return;
    if (e.inflight) {
      e.dirty = true;
      return;
    }
    if (now < e.blockedUntil)
      return;
    if (now - e.lastHintAt < HINT_COOLDOWN_MS) {
      e.nextAt = Math.min(e.nextAt, e.lastHintAt + HINT_COOLDOWN_MS);
      arm();
      return;
    }
    e.lastHintAt = now;
    runCheck(t, e);
  };
  const readPointer = async (t, signal) => {
    const sub = t.subs[0];
    const headers = {
      Accept: "application/json",
      [PLUGIN_LINE_HEADER]: sub.line,
      "X-Enpal-Loader": String(sub.loaderVersion),
      [WATCHER_HEADER]: "1"
    };
    if (t.pointer.etag)
      headers["If-None-Match"] = t.pointer.etag;
    const res = await sub.fetch(storeUrlFor(sub.base, POINTER_NAME), { headers, signal, redirect: "error" });
    if (res.status === 304) {
      if (!headers["If-None-Match"])
        return { kind: "failed", reason: "unasked 304" };
      return { kind: "ok", commit: () => commitPolicy(t, t.pointer.policy) };
    }
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {}
      return { kind: "failed", reason: `http ${res.status}`, retryAfterMs: retryAfterMs(res, deps.now()) };
    }
    const body = JSON.parse(new TextDecoder().decode(await readBounded(res, POINTER_MAX)));
    if (!isRecord6(body) || body.schema !== SCHEMA || !isRecord6(body.release))
      return { kind: "failed", reason: "pointer shape" };
    commitPolicy(t, parsePolicy(body.policy, logOf(t)));
    const release = body.release;
    if (release.status !== undefined)
      return { kind: "failed", reason: `release ${String(release.status)}` };
    let approved;
    let descriptor = null;
    if (release.build === null) {
      approved = null;
    } else if (typeof release.build === "string") {
      const v = validateDescriptor(release.descriptor, release.build);
      if (!v.ok)
        return { kind: "failed", reason: "descriptor refused" };
      approved = release.build;
      descriptor = v.descriptor;
    } else {
      return { kind: "failed", reason: "pointer shape" };
    }
    const approvedAt = typeof release.approved_at === "string" ? release.approved_at.slice(0, 64) : null;
    const tag = res.headers.get("etag");
    return { kind: "ok", commit: () => commitPointer(t, approved, descriptor, approvedAt, tag && ETAG_RE.test(tag) ? tag : null) };
  };
  const commitPointer = (t, approved, descriptor, approvedAt, etag) => {
    const p = t.pointer;
    if (p.approvedAt && approvedAt && approvedAt < p.approvedAt)
      return;
    p.approved = approved;
    p.approvedAt = approvedAt;
    p.etag = etag;
    const sub = t.subs[0];
    const current = approved && descriptor ? updateId(approved, approvedAt) : null;
    dropPending(t, (id) => id.startsWith("update:") && id !== current);
    if (p.startupPending) {
      p.startupPending = false;
      if (approved !== null && approved === sub.approvedAtStart) {
        p.handled.add(`${approved}|${approvedAt ?? "-"}`);
        return;
      }
    }
    if (approved === null || !descriptor || approved === sub.build)
      return;
    newApproval(t, sub, descriptor, approvedAt);
  };
  const newApproval = async (t, sub, descriptor, approvedAt) => {
    const occurrence = `${descriptor.build}|${approvedAt ?? "-"}`;
    if (t.pointer.handled.has(occurrence))
      return;
    t.pointer.handled.add(occurrence);
    const log = logOf(t);
    if (sub.loaderVersion < 1)
      return;
    if (descriptor.min_loader > sub.loaderVersion) {
      log(`build ${descriptor.build} needs loader ${descriptor.min_loader}; not announced`);
      return;
    }
    let download = t.pointer.downloads.get(descriptor.build);
    if (!download) {
      const signal = AbortSignal.any([t.controller.signal, AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)]);
      download = ensureBuildFiles({ dir: sub.cacheDir, base: sub.base, fetch: sub.fetch, log }, descriptor, ROLES_FOR_LINE[sub.line], signal).then(() => {
        log(`build ${descriptor.build} is in the cache for the next start`);
        return true;
      }, (e) => {
        log(`build ${descriptor.build} not fetched (${e?.message ?? e}); the next start fetches it`);
        return false;
      });
      t.pointer.downloads.set(descriptor.build, download);
    }
    const ready = await download;
    if (t.stopped || t.pointer.approved !== descriptor.build || t.pointer.approvedAt !== approvedAt)
      return;
    queue(t, {
      id: updateId(descriptor.build, approvedAt),
      variant: "info",
      duration: 60000,
      title: "Enpal AI Gateway plugin update available",
      message: `Build ${descriptor.build} was approved${ready ? " and is downloaded" : ""}; you are on ${sub.build}. ${restartHint(sub.line)} to run it.`
    });
  };
  const liveSub = (t) => t.subs.find((s) => s.live);
  const liveKey = (t, key) => {
    const n = t.features.newest;
    return !!n && n.ok && keyOn(n.answer, key);
  };
  const liveRows = (t, reason2) => {
    for (const s of t.subs) {
      try {
        s.live?.rows(reason2);
      } catch {}
    }
  };
  const commitPolicy = (t, policy) => {
    if (!policy || t.stopped)
      return;
    const base = t.subs[0]?.base ?? t.key;
    let snapshot2 = null;
    try {
      snapshot2 = acceptPolicySnapshot(modelsPolicyState(base), policy, base, "gateway", logOf(t));
    } catch (e) {
      logOf(t)(`policy not saved for an offline start (${e?.message ?? e})`);
    }
    for (const dir of snapshot2 ? new Set(t.subs.map((s) => s.cacheDir)) : []) {
      if (!savePolicySnapshot(dir, snapshot2, deps.now()))
        logOf(t)(`policy not saved for an offline start (${join15(dir, "policy.json")})`);
    }
    const digest2 = policyDigest(policy);
    if (digest2 === t.pointer.policyDigest)
      return;
    t.pointer.policy = policy;
    t.pointer.policyDigest = digest2;
    for (const s of t.subs) {
      try {
        s.live?.policy?.(policy);
      } catch {}
    }
    liveRows(t, "policy");
  };
  const readPicker = async (t, signal) => {
    const sub = liveSub(t) ?? t.subs[0];
    const served = await fetchServedPicker(sub.base, { fetch: sub.fetch, line: sub.line, timeoutMs: CHECK_DEADLINE_MS }, signal);
    if (!served.ok)
      return { kind: "failed", reason: `picker ${served.reason}` };
    const digest2 = servedDigest(served);
    return { kind: "ok", commit: () => {
      const changed = digest2 !== t.picker.digest;
      t.picker.served = served;
      t.picker.digest = digest2;
      if (changed)
        liveRows(t, "picker");
    } };
  };
  const readFeatures = async (t, signal) => {
    const sub = personal(t);
    if (!sub?.login)
      return { kind: "paused" };
    const generation = t.features.generation;
    const stored = await untilAborted(sub.login.current(), signal);
    if (stored)
      t.features.family.add(stored);
    if (!stored)
      return { kind: "paused" };
    if (t.features.paused !== null) {
      if (t.features.paused === stored)
        return { kind: "paused" };
      t.features.paused = null;
    }
    const login = await untilAborted(sub.login.access(signal), signal);
    if (!login)
      return { kind: "paused" };
    t.features.family.add(linkOf(login.refresh));
    const res = await sub.fetch(`${sub.base}${FEATURES_PATH}`, {
      headers: { Authorization: `Bearer ${login.access}`, Accept: "application/json", [PLUGIN_BUILD_HEADER]: PLUGIN_BUILD, [PLUGIN_LINE_HEADER]: sub.line },
      signal,
      redirect: "error"
    });
    if (res.status === 401 || res.status === 403) {
      try {
        await res.body?.cancel();
      } catch {}
      t.features.paused = linkOf(login.refresh);
      logOf(t)(`features refused (${res.status}); paused until the login changes`);
      return { kind: "paused" };
    }
    if (res.status === 404) {
      try {
        await res.body?.cancel();
      } catch {}
      return { kind: "slow" };
    }
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {}
      return { kind: "failed", reason: `http ${res.status}`, retryAfterMs: retryAfterMs(res, deps.now()) };
    }
    const answer = parseFeaturesAnswer(await readBoundedJson(res, FEATURES_BODY_MAX));
    if (!answer)
      return { kind: "failed", reason: "answer malformed" };
    const now = await untilAborted(sub.login.current(), signal).catch(() => null);
    if (t.features.generation !== generation)
      return { kind: "retry", reason: "another account signed in during the read" };
    if (now === null || !t.features.family.has(now)) {
      dropPending(t, (id) => id.startsWith("feature:"));
      return { kind: "retry", reason: "the login changed during the read" };
    }
    return { kind: "ok", commit: () => commitFeatures(t, sub, answer, now) };
  };
  const commitFeatures = (t, sub, answer, link) => {
    const f = t.features;
    const catalogue = sub.startup?.catalogue ?? null;
    const next = projection(answer, catalogue);
    f.newest = { ok: true, at: deps.now(), link, answer };
    const live = !!liveSub(t);
    const inPlace = live && keyOn(answer, LIVE_PICKER);
    const replaced = f.rebaseline || !!(f.subject && answer.subject && answer.subject !== f.subject);
    f.rebaseline = false;
    if (replaced) {
      const previous = f.subject;
      dropPending(t, (id) => id.startsWith(`feature:${previous}:`));
      recordBaseline(sub, answer.subject ?? null, next.on);
    } else {
      for (const key of new Set([...f.baseline.keys(), ...next.on.keys()])) {
        const before = f.baseline.get(key) ?? false;
        const after = next.on.get(key) ?? false;
        if (before === after)
          continue;
        if (LIVE_KEYS.has(key))
          continue;
        transition(t, sub, answer.subject ?? f.subject ?? "-", key, after, next.names.get(key) ?? f.names.get(key) ?? key, inPlace);
      }
    }
    f.baseline = next.on;
    f.names = next.names;
    f.subject = answer.subject ?? f.subject;
    f.revision = answer.revision ?? null;
    if (answer.subject) {
      try {
        sub.featuresStore?.save({ subject: answer.subject, link, answer, at: Math.floor(deps.now() / 1000) });
      } catch {}
    }
    if (!live)
      return;
    liveRows(t, replaced ? "login" : "features");
  };
  const recorded = (sub, subject, key) => {
    const m = /^(\d{1,9}):(on|off)$/.exec(sub.noticeStore.shown()[`${TRANSITION_PREFIX}${subject}:${key}`] ?? "");
    return m ? { seq: Number(m[1]), on: m[2] === "on" } : null;
  };
  const record7 = (sub, subject, key, on) => {
    const last = recorded(sub, subject, key);
    if (last && last.on === on)
      return last.seq;
    const seq = (last?.seq ?? 0) + 1;
    sub.noticeStore.markShown(`${TRANSITION_PREFIX}${subject}:${key}`, `${seq}:${on ? "on" : "off"}`);
    return seq;
  };
  const recordBaseline = (sub, subject, baseline) => {
    if (!subject)
      return;
    for (const [key, on] of baseline) {
      const last = recorded(sub, subject, key);
      if (last && last.on !== on)
        record7(sub, subject, key, on);
    }
  };
  const transition = (t, sub, subject, key, on, name15, inPlace = false) => {
    const seq = record7(sub, subject, key, on);
    queue(t, on ? {
      id: `feature:${subject}:${key}:${seq}`,
      variant: "info",
      title: `${name15} is now on for you`,
      message: inPlace ? "Your picker shows it now." : `${restartHint(sub.line)} to see it in your picker.`
    } : {
      id: `feature:${subject}:${key}:${seq}`,
      variant: "info",
      title: `${name15} was switched off for you`,
      message: inPlace ? "The gateway applies this from your next request, and your picker drops it." : `The gateway applies this from your next request. ${restartHint(sub.line)} so your picker matches.`
    });
  };
  const updateId = (build, approvedAt) => `update:${build}:${approvedAt ?? "-"}`;
  const settled = (t, id) => {
    t.pending.delete(id);
    t.claims.delete(id);
  };
  const dropPending = (t, which) => {
    for (const id of [...t.pending.keys()]) {
      if (!which(id))
        continue;
      t.pending.delete(id);
      const claim = t.claims.get(id);
      t.claims.delete(id);
      if (claim) {
        try {
          claim.sub.sink?.withdraw?.(id);
        } catch {}
      }
    }
  };
  const queue = (t, n) => {
    if (!t.pending.has(n.id))
      t.pending.set(n.id, n);
    flushTarget(t);
  };
  const flushTarget = async (t) => {
    if (t.delivering) {
      t.again = true;
      return;
    }
    t.delivering = true;
    try {
      do {
        t.again = false;
        const sinks = t.subs.filter((s) => s.sink);
        const owner = sinks[0];
        if (!owner)
          return;
        const shown = owner.noticeStore.shown();
        for (const [id, n] of [...t.pending]) {
          if (t.stopped)
            return;
          if (shown[id] || owner.quiet && n.variant !== "warning") {
            settled(t, id);
            continue;
          }
          if (owner.sink.mode === "toast") {
            try {
              await owner.sink.offer(n);
              owner.noticeStore.markShown(id, today());
              settled(t, id);
            } catch {}
          } else {
            const bridges = sinks.filter((s) => s.sink.mode === "bridge");
            const now = deps.now();
            const claim = t.claims.get(id);
            let holder = claim && t.subs.includes(claim.sub) && now < claim.until ? claim.sub : null;
            if (!holder) {
              if (claim && t.subs.includes(claim.sub)) {
                try {
                  claim.sub.sink.withdraw?.(id);
                } catch {}
              }
              holder = bridges[((claim ? bridges.indexOf(claim.sub) : -1) + 1) % bridges.length] ?? null;
              if (!holder)
                continue;
              t.claims.set(id, { sub: holder, until: now + LEASE_MS });
            }
            try {
              await holder.sink.offer(n);
            } catch {
              t.claims.delete(id);
            }
          }
        }
      } while (t.again && !t.stopped);
    } finally {
      t.delivering = false;
    }
  };
  const subscribe = (sub) => {
    const key = normalisedBase(sub.base);
    let t = targets.get(key);
    const now = deps.now();
    if (!t) {
      const kept = retained.get(key);
      retained.delete(key);
      const seed = sub.startup?.features;
      const baseline = seed?.kind === "answer" ? projection(seed.answer, sub.startup?.catalogue) : { on: new Map, names: new Map };
      const pointer = kept?.pointer ?? {
        etag: null,
        policy: null,
        policyDigest: null,
        approved: typeof sub.approvedAtStart === "string" ? sub.approvedAtStart : undefined,
        approvedAt: null,
        handled: new Set,
        startupPending: typeof sub.approvedAtStart === "string"
      };
      const features = kept?.features ?? {
        paused: null,
        baseline: baseline.on,
        names: baseline.names,
        subject: seed?.kind === "answer" ? seed.subject ?? seed.answer.subject ?? null : null,
        revision: seed?.kind === "answer" ? seed.answer.revision ?? null : seed?.kind === "disabled" ? "disabled" : null
      };
      const pollMs = typeof sub.pollMs === "number" && Number.isFinite(sub.pollMs) && sub.pollMs >= 1000 ? sub.pollMs : POLL_MS;
      const next = () => now + spread(pollMs);
      t = {
        key,
        subs: [],
        controller: new AbortController,
        stopped: false,
        pollMs,
        pointer: { ...endpoint("pointer", next()), ...pointer, downloads: new Map },
        picker: { ...endpoint("picker", next()), served: null, digest: null, disabled: true },
        features: { ...endpoint("features", next()), ...features, generation: 0, rebaseline: false, family: new Set, newest: null },
        pending: new Map,
        claims: new Map,
        delivering: false,
        again: false
      };
      targets.set(key, t);
      if (!kept && seed?.kind === "answer" && seed.fresh)
        recordBaseline(sub, t.features.subject, t.features.baseline);
    }
    t.subs.push(sub);
    if (t.pointer.policy) {
      try {
        sub.live?.policy?.(t.pointer.policy);
      } catch {}
    }
    t.features.disabled = !personal(t);
    pickerGate(t);
    const target = t;
    arm();
    flushTarget(target);
    return () => {
      const at = target.subs.indexOf(sub);
      if (at < 0)
        return;
      target.subs.splice(at, 1);
      target.features.disabled = !personal(target);
      pickerGate(target);
      if (target.subs.length) {
        flushTarget(target);
        arm();
        return;
      }
      target.stopped = true;
      target.controller.abort();
      if (targets.get(key) === target)
        targets.delete(key);
      for (const [id, claim] of target.claims) {
        try {
          claim.sub.sink?.withdraw?.(id);
        } catch {}
      }
      target.claims.clear();
      const { pointer: p, features: f } = target;
      retained.set(key, {
        pointer: { etag: p.etag, policy: p.policy, policyDigest: p.policyDigest, approved: p.approved, approvedAt: p.approvedAt, handled: p.handled, startupPending: p.startupPending },
        features: { paused: f.paused, revision: f.revision, subject: f.subject, baseline: f.baseline, names: f.names }
      });
      arm();
    };
  };
  const hint = (base, requestUrl, headers) => {
    const t = targets.get(normalisedBase(base));
    if (!t || t.stopped)
      return;
    let url2;
    try {
      url2 = new URL(requestUrl);
    } catch {
      return;
    }
    if (!underBase(url2, baseOf(t.subs[0].base)))
      return;
    const approved = hintValue(headers, APPROVED_HEADER, APPROVED_RE);
    if (approved !== null) {
      const value = approved === "none" ? null : approved;
      t.pointer.hinted = value;
      if (value !== t.pointer.approved)
        requestCheck(t, t.pointer);
    }
    const revision = hintValue(headers, REVISION_HEADER, REVISION_RE2);
    if (revision !== null && !t.features.disabled) {
      t.features.hinted = revision;
      if (revision !== t.features.revision)
        requestCheck(t, t.features);
    }
  };
  const rotated = (base, fromRefresh, toRefresh) => {
    const t = targets.get(normalisedBase(base));
    if (!t || t.stopped)
      return;
    const fam = t.features.family;
    fam.add(linkOf(fromRefresh));
    fam.add(linkOf(toRefresh));
    while (fam.size > 16)
      fam.delete(fam.values().next().value);
  };
  const replaceAccount = (base) => {
    const key = normalisedBase(base);
    retained.delete(key);
    const t = targets.get(key);
    if (!t || t.stopped)
      return Promise.resolve();
    const f = t.features;
    f.generation += 1;
    f.paused = null;
    f.family.clear();
    f.subject = null;
    f.rebaseline = true;
    f.newest = { ok: false, at: deps.now(), why: "account_replaced" };
    pickerGate(t);
    f.unresolved = undefined;
    f.blockedUntil = 0;
    dropPending(t, (id) => id.startsWith("feature:"));
    return Promise.resolve(f.inflight).catch(() => {}).then(() => t.stopped || f.disabled ? undefined : runCheck(t, f));
  };
  const flush = () => {
    for (const t of targets.values())
      if (t.pending.size)
        flushTarget(t);
  };
  const loginSeen = (base, link) => {
    const t = targets.get(normalisedBase(base));
    if (!t || t.stopped)
      return Promise.resolve();
    if (link === null) {
      t.features.newest = { ok: false, at: deps.now(), why: "signed_out" };
      pickerGate(t);
      return Promise.resolve();
    }
    if (t.features.family.has(link))
      return Promise.resolve();
    return replaceAccount(base);
  };
  const snapshot = (base) => {
    const t = targets.get(normalisedBase(base));
    return t && !t.stopped ? { served: t.picker.served, policy: t.pointer.policy, newest: t.features.newest } : null;
  };
  const policyOf = (base) => {
    const key = normalisedBase(base);
    const t = targets.get(key);
    return (t && !t.stopped ? t.pointer.policy : retained.get(key)?.pointer.policy) ?? null;
  };
  const endpointOf = (t, kind) => kind === "pointer" ? t.pointer : kind === "picker" ? t.picker : t.features;
  return { subscribe, hint, flush, replaceAccount, rotated, loginSeen, snapshot, policyOf, targets, tick, runCheck: (base, kind) => {
    const t = targets.get(normalisedBase(base));
    return t ? runCheck(t, endpointOf(t, kind)) : Promise.resolve();
  } };
}
var WATCHER_KEY = `enpal.gateway.plugin.watcher.v2:${PLUGIN_BUILD}`;
function processWatcher() {
  const g = globalThis;
  return g[Symbol.for(WATCHER_KEY)] ??= createWatcher();
}

// src/build/server.ts
function startupKey(base, build) {
  return JSON.stringify(["startup", normalisedBase(base), build ?? "legacy"]);
}
var CATALOGUE_FILE_MAX = 1024 * 1024;
var isPlainRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function readCatalogueFile(path) {
  if (!path)
    return null;
  try {
    if (statSync10(path).size > CATALOGUE_FILE_MAX)
      return null;
    return asCatalogue(JSON.parse(readFileSync12(path, "utf8")));
  } catch {
    return null;
  }
}
function defaultModelUsable(cfg, ref2 = DEFAULT_MODEL) {
  const [providerId, modelId] = ref2.split("/", 2);
  const block = isPlainRecord(cfg.provider) ? cfg.provider[providerId] : undefined;
  if (!isPlainRecord(block) || !isPlainRecord(block.models) || !isPlainRecord(block.models[modelId]))
    return false;
  const strings3 = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const fields = [
    [cfg.enabled_providers, (l) => l.includes(providerId)],
    [cfg.disabled_providers, (l) => !l.includes(providerId)],
    [block.whitelist, (l) => l.includes(modelId)],
    [block.blacklist, (l) => !l.includes(modelId)]
  ];
  for (const [value, permits] of fields) {
    if (value === undefined)
      continue;
    if (!strings3(value) || !permits(value))
      return false;
  }
  return true;
}
async function runStartup(o) {
  const env = o.env ?? process.env;
  const deps = o.fetch ? { ...defaultDeps(), fetch: o.fetch } : defaultDeps();
  const signal = o.options.signal ?? AbortSignal.timeout(CONFIG_HOOK_TIMEOUT_MS);
  const [features, served] = await Promise.all([
    readFeaturesAtStart({
      base: o.base,
      login: o.login !== undefined ? o.login : readStoredLogin(env),
      serviceKey: serviceKeyFromEnv(env) !== null,
      config: configFor(o.base, o.clientId),
      deps,
      persist: o.persist,
      store: o.store,
      signal,
      silentRefresh: o.silentRefresh,
      log: o.log,
      line: o.options.line
    }),
    fetchServedPicker(o.base, { fetch: deps.fetch, timeoutMs: CONFIG_HOOK_TIMEOUT_MS, log: o.log, line: o.options.line }, signal)
  ]);
  const official = officialFrom(served, { cacheDir: o.cacheDir, options: o.options });
  o.log?.(`startup features=${features.kind} catalogue=${official?.source ?? "none"}${served.ok ? "" : ` served=${served.reason}`}`);
  return { features, official };
}
function officialFrom(served, o) {
  const savedPath = join16(o.cacheDir, "catalog.json");
  const snapshot = readCatalogueFile(o.options.catalogPath) ?? (o.options.catalog ? asCatalogue(o.options.catalog) : null);
  const official = chooseCatalogue(served, readCatalogueFile(savedPath), snapshot);
  if (official?.source === "served") {
    try {
      writeJsonAtomically(savedPath, official.catalogue);
    } catch {}
  }
  return official;
}
function storedLoginSource(o) {
  return {
    current: async () => {
      const l = readStoredLogin(o.env);
      return l ? linkOf(l.record.refresh) : null;
    },
    access: async (signal) => {
      const login = readStoredLogin(o.env);
      if (!login)
        return null;
      const { access, refresh } = login.record;
      if (access && o.deps.now() < Math.floor(login.record.expires / 1000) - (o.config.skewSeconds ?? 60))
        return { access, refresh };
      if (login.source === "env")
        return null;
      try {
        const flight = sharedRefresh(o.config, o.deps, o.persist, refresh);
        flight.then((t2) => followRotation(o.store, refresh, t2)).catch(() => {});
        const t = await untilAborted(flight, signal);
        return { access: t.access_token, refresh: t.refresh_token };
      } catch (e) {
        if (e instanceof ReLoginRequiredError || e instanceof PersistFailedError)
          return null;
        throw e;
      }
    }
  };
}
var OBSERVED_CFG = Symbol.for("enpal.gateway.plugin.observed-config.v1");
var observedCfg = globalThis[OBSERVED_CFG] ??= new WeakMap;
function createServer2(options) {
  const base = options.base.replace(/\/+$/, "");
  const cacheDir = options.cacheDir ?? join16(homedir7(), ".enpal", "gateway", "plugins", baseKey(base));
  const log = (m) => {
    try {
      options.log?.(m);
    } catch {}
  };
  const rules = modelsPolicyState(base);
  if (options.policy?.models_policy)
    acceptModelsPolicy(rules, [{ raw: options.policy.models_policy, source: "handed" }], base, log);
  const store = fileFeaturesStore(cacheDir);
  const env = options.env ?? process.env;
  const deps = () => {
    const d = options.fetch ? { ...defaultDeps(), fetch: options.fetch } : defaultDeps();
    return { ...d, fetch: guardedFetch(d.fetch, baseOf(base)) };
  };
  return async ({ client, directory: directory2, worktree }) => {
    const generatedIn = new WeakMap;
    const generatedCommand = new WeakSet;
    const ourCommands = new WeakSet;
    let lastConfig = null;
    const diag = createDisabledDiagnostics({ line: "v1", base, cacheDir, env, directory: directory2, worktree });
    const registration = (cfg, name15) => cfg && isPlainRecord(cfg.command) ? cfg.command[name15] : undefined;
    const ours = (cfg, name15) => {
      const r = registration(cfg, name15);
      return isPlainRecord(r) && ourCommands.has(r);
    };
    const loginOurs = (cfg) => ours(cfg, LOGIN_COMMAND);
    const loginWaiters = new Set;
    const last = {
      merged: null,
      outcome: null,
      generated: new Set,
      skill: {
        skill_folder: null,
        skill_added: false,
        personal_skill_clash: null,
        personal_command_clash: false,
        command_added: false,
        login_command_added: false,
        news_command_added: false,
        scan_complete: true,
        verify_note: VERIFY_NOTE
      }
    };
    const toast = client.tui ? (title, message, variant = "info", duration3 = TOAST_MS) => client.tui.showToast({ body: { title, message, variant, duration: duration3 } }) : undefined;
    const notes = createAutoNotes(fileNoteStore(), async (id, title) => {
      if (!client.session)
        throw new Error("no session API");
      const r = await client.session.update({ path: { id }, body: { title }, throwOnError: true });
      if (r && typeof r === "object" && r.error)
        throw new Error("title update refused");
    });
    const reminders = createReminders(store, toast ? (t, m) => toast(t, m, "info") : undefined);
    const noticeStore = fileNoticeStore(cacheDir);
    const notices = createNotices(noticeStore, toast, !!env.ENPAL_GATEWAY_QUIET);
    const advisory = otherProviderNotices(cacheDir, Date.now, log);
    const persist = persistVia(client);
    const policyReady = bootstrapModelsPolicy({ ...options, base, cacheDir, log, line: options.line ?? "v1", loaderVersion: options.loaderVersion ?? 0 }).catch((e) => {
      log(`hosted rules bootstrap error=${e?.message ?? e}`);
      return null;
    });
    const startup = oncePerProcess(processState().picks, startupKey(base, options.build), () => runStartup({ base, options, cacheDir, store, persist, clientId: options.clientId, env, fetch: deps().fetch, log }));
    startup.then((s) => reminders.arm(s.features, s.official?.catalogue.features), () => {});
    const watcher = watcherOff(env) ? null : options.watcher ?? processWatcher();
    const replaceAccount = (oldRefresh) => {
      try {
        store.clear();
      } catch {}
      if (oldRefresh)
        processState().unsaved.delete(renewKey(base, configFor(base, options.clientId).clientId, oldRefresh));
      watcher?.replaceAccount(base).catch(() => {});
    };
    let unwatch = null;
    let disposed = false;
    if (watcher) {
      startup.then((s) => {
        if (disposed)
          return;
        const d = deps();
        unwatch = watcher.subscribe({
          base,
          build: options.build ?? "legacy",
          line: "v1",
          loaderVersion: options.loaderVersion ?? 0,
          approvedAtStart: options.approved,
          cacheDir,
          fetch: guardedFetch(options.fetch ?? defaultDeps().fetch, baseOf(base), { allowNotModified: true }),
          startup: { features: s.features, catalogue: s.official?.catalogue.features },
          login: serviceKeyFromEnv(env) ? undefined : storedLoginSource({ env, config: configFor(base, options.clientId), deps: d, persist, store }),
          featuresStore: store,
          noticeStore,
          quiet: !!env.ENPAL_GATEWAY_QUIET,
          log,
          sink: client.tui ? { mode: "toast", offer: async (n) => {
            const r = await client.tui.showToast({ body: { title: n.title, message: n.message, variant: n.variant ?? "info", duration: n.duration ?? TOAST_MS } });
            if (r && typeof r === "object" && r.error)
              throw new Error("toast refused");
          } } : undefined
        });
      }, () => {});
    }
    return {
      auth: buildAuthHook(client, configFor(base, options.clientId), deps(), options.browserSys ?? defaultBrowserSys(), notes, {
        onRotated: (from, to) => {
          store.relink(linkOf(from), linkOf(to));
          watcher?.rotated(base, from, to);
        },
        onLoginReplaced: (from) => replaceAccount(from),
        onResponse: watcher ? (url2, response) => {
          try {
            watcher.hint(base, url2, response.headers);
          } catch {}
        } : undefined
      }, { env, deadlineMs: options.loginDeadlineMs }),
      dispose: async () => {
        disposed = true;
        for (const detach of [...loginWaiters]) {
          try {
            detach();
          } catch {}
        }
        const stop = unwatch;
        unwatch = null;
        stop?.();
      },
      provider: buildProviderHook(base, deps()),
      config: async (cfg) => {
        const managed = readManagedConfig(env);
        let corrected = false;
        const correct = () => {
          if (corrected)
            return;
          corrected = true;
          let token = null;
          try {
            const deny = switchedOff1x(cfg);
            const policy = restoreControlState(base);
            const before = observedCfg.get(cfg) ?? {
              input: deny ? "deny" : "clean",
              ...provenance1x(cfg, { env, directory: directory2, managed, worktree }),
              files: filesSwitchingOff(env, directory2, "v1", undefined, worktree),
              transport_overridden: pinTransport1x(cfg, base, false).length > 0
            };
            observedCfg.set(cfg, before);
            token = diag.observe({ ...before, policy });
            const pinned = pinTransport1x(cfg, base);
            if (pinned.length)
              log(`disabled_providers: Enpal's transport pointed elsewhere (${pinned.join(", ")}); the gateway's is used in memory`);
            const attempted = before.input === "deny" && policy.restore_enpal;
            if (attempted)
              reenableInMemory(cfg);
            diag.report(token, { attempted, restored: attempted && !switchedOff1x(cfg), currently_available: enpalOffered1x(cfg) });
            const said = diag.facts().summary;
            if (said)
              log(`disabled_providers: ${said}`);
            const notice = diag.notice();
            if (notice)
              notices.queue([notice]);
          } catch (e) {
            if (token !== null)
              diag.report(token, { failure: String(e?.message ?? e) });
            log(`disabled_providers: correction failed (${e?.message ?? e})`);
          }
        };
        try {
          const s = await startup;
          const generated = generatedIn.get(cfg) ?? new Set;
          generatedIn.set(cfg, generated);
          const ledger = fileCopyLedger(cacheDir);
          const added = ensureEnpalBlock(cfg, base);
          const outcome = composeGatewayBlock({
            merged: cfg,
            official: s.official,
            managed,
            policy: options.policy ?? null,
            copies: ledger.load(),
            features: s.features,
            generated,
            log
          });
          if (added && !outcome.applied)
            delete cfg.provider[PROVIDER_ID];
          else if (added)
            log("provider block added in memory (no config file has one)");
          correct();
          last.merged = cfg;
          last.outcome = outcome;
          last.generated = generated;
          try {
            await policyReady;
            const hidden = hideHostedV1(cfg, rules.policy, (ref2) => defaultModelUsable(cfg, ref2));
            if (hidden.disabled.length || hidden.blacklisted.length || hidden.moved.length)
              log(`hosted hidden disabled=${hidden.disabled.join(",")} blacklisted=${hidden.blacklisted.join(",")} moved=${hidden.moved.map((m) => `${m.field}:${m.from}>${m.to ?? "none"}`).join(",")}`);
            for (const m of hidden.moved)
              if (m.field === "model")
                notices.queue([hostedDefaultNoticeV1(m)]);
          } catch (e) {
            log(`hosted hide error=${e?.message ?? e}`);
          }
          if (outcome.applied) {
            if ((cfg.model === undefined || cfg.model === null || cfg.model === "") && defaultModelUsable(cfg, rules.policy.default_model)) {
              cfg.model = rules.policy.default_model;
              log(`default model set ${rules.policy.default_model}`);
            }
            notices.queue(outcome.notices);
            for (const id of outcome.featureRows?.added ?? [])
              generated.add(id);
            try {
              writeJsonAtomically(join16(cacheDir, "feature-rows.json"), { generated: [...generated], owned: outcome.featureRows?.owned ?? {} });
            } catch {}
            const update = buildUpdateNotice(options);
            if (update)
              notices.queue([update]);
            const failed = buildLoadFailedNotice(options);
            if (failed)
              notices.queue([failed]);
            ledger.save(outcome.copies ?? {});
          }
          const stored = readStoredLogin(env);
          const refused = s.features.kind === "no_subject" && !!s.features.refused && !!stored && linkOf(stored.record.refresh) === s.features.refused;
          if ((refused || !stored) && !serviceKeyFromEnv(env))
            notices.queue([welcomeNotice("v1")]);
          log(outcome.applied ? `picker composed source=${outcome.source} models=${outcome.models} personal=${outcome.personal?.length ?? 0} copied=${outcome.copied?.length ?? 0} retired=${outcome.retired?.join(",") ?? ""} lock=${outcome.providerLock ?? "none"}` : `picker unchanged ${outcome.reason}`);
        } catch (e) {
          log(`picker unchanged error=${e?.message ?? e}`);
        }
        correct();
        try {
          const folder = ensureSkillFolder(cacheDir, options.build);
          const scan = findPersonalSkill(SKILL_NAME, { env, directory: directory2, configPaths: cfg.skills?.paths, exclude: skillsRoot(cacheDir) });
          const commandClash = isPlainRecord(cfg.command) && SKILL_NAME in cfg.command && !generatedCommand.has(cfg);
          const parent = skillParent(cacheDir, options.build);
          const added = !!folder && !scan.found && scan.complete && addSkillPath(cfg, parent);
          const present = !!folder && !scan.found && scan.complete && !!cfg.skills?.paths?.includes(parent);
          const commandAdded = !commandClash && addDoctorCommand(cfg);
          if (commandAdded)
            generatedCommand.add(cfg);
          if (registration(cfg, LOGIN_COMMAND) === undefined && addLoginCommand(cfg))
            ourCommands.add(registration(cfg, LOGIN_COMMAND));
          if (registration(cfg, NEWS_COMMAND) === undefined && addNewsCommand(cfg))
            ourCommands.add(registration(cfg, NEWS_COMMAND));
          lastConfig = cfg;
          last.skill = {
            skill_folder: folder,
            skill_added: added || present,
            personal_skill_clash: scan.found,
            personal_command_clash: commandClash,
            command_added: commandAdded || generatedCommand.has(cfg),
            login_command_added: loginOurs(cfg),
            news_command_added: ours(cfg, NEWS_COMMAND),
            scan_complete: scan.complete,
            verify_note: VERIFY_NOTE
          };
          log(`doctor skill=${added ? "added" : scan.found ? "clash" : !scan.complete ? "scan_incomplete" : folder ? "present" : "unavailable"}${scan.found ? ` personal=${scan.found}` : ""} command=${commandClash ? "clash" : "added"}`);
        } catch (e) {
          log(`doctor unavailable error=${e?.message ?? e}`);
        }
      },
      tool: {
        enpal_setup: createSetupTool(async () => assembleFacts({
          base,
          options,
          cacheDir,
          env,
          startup: await startup,
          login: readStoredLogin(env),
          last,
          line: "v1",
          opencodeVersion: env.OPENCODE_VERSION ?? null,
          disabled: diag.facts()
        }))
      },
      "experimental.text.complete": (input, output) => notes.textComplete(input, output),
      "experimental.session.compacting": (input) => notes.compactingStarted(input),
      "command.execute.before": async (input, output) => {
        if (input?.command !== LOGIN_COMMAND || !loginOurs(lastConfig))
          return;
        const outcome = await runLoginCommand(input.arguments ?? "", {
          config: configFor(base, options.clientId),
          deps: deps(),
          sys: options.browserSys ?? defaultBrowserSys(),
          env,
          persist,
          readLogin: () => readStoredLogin(env),
          replaced: replaceAccount,
          rotated: (from, to) => {
            store.relink(linkOf(from), linkOf(to));
            watcher?.rotated(base, from, to);
          },
          log,
          deadlineMs: options.loginDeadlineMs,
          callMs: options.loginCallMs,
          track: (detach) => {
            loginWaiters.add(detach);
            return () => {
              loginWaiters.delete(detach);
            };
          }
        });
        output.parts = resultParts(output.parts ?? [], outcome);
        if (toast)
          toast("Enpal AI Gateway login", outcome.message, outcome.ok ? "info" : "warning").catch(() => {});
      },
      "chat.headers": (input) => {
        const providerID = input.model?.providerID, modelID = input.model?.id;
        if (hostedProviderV1(last.merged ?? {}, rules.policy, providerID) || hostedResolvedV1(rules.policy, input) || typeof providerID === "string" && typeof modelID === "string" && hostedModelRef(last.merged ?? {}, rules.policy, `${providerID}/${modelID}`)) {
          log(`hosted refused ${String(providerID)}`);
          throw new Error(hostedRefusalV1(providerID));
        }
        if (typeof providerID === "string" && providerID !== PROVIDER_ID) {
          try {
            const n = advisory.observe(providerID, rules.policy);
            if (n)
              notices.queue([n]);
          } catch {}
        }
        reminders.modelCall(input);
        return notes.modelCall(input);
      },
      event: (input) => {
        notices.flush();
        watcher?.flush();
        return notes.onEvent(input);
      }
    };
  };
}

// src/build/entry-v1.ts
var build = (options) => ({ providerLock: 4, server: createServer2(options) });
var entry_v1_default = build;

// src/build/v2.ts
import { dirname as dirname4, join as join20, resolve as resolve4 } from "node:path";
import { readFileSync as readFileSync15, statSync as statSync13 } from "node:fs";

// src/attempt.ts
async function completeAttempt(config2, deps, loopback, codeVerifier, bounds) {
  const over = new AbortController;
  const timers = [setTimeout(() => over.abort(new Error("login_timeout")), bounds.deadlineMs)];
  const whileOpen = (p) => new Promise((resolve4, reject) => {
    if (over.signal.aborted) {
      reject(over.signal.reason);
      return;
    }
    over.signal.addEventListener("abort", () => reject(over.signal.reason), { once: true });
    p.then(resolve4, reject);
  });
  try {
    const code = await whileOpen(loopback.waitForCode());
    loopback.close();
    timers.push(setTimeout(() => over.abort(new Error("exchange_timeout")), bounds.callMs));
    const bounded = { ...deps, fetch: (input, init) => deps.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, over.signal]) : over.signal }) };
    return await whileOpen(exchangeAuthorizationCode(config2, bounded, { code, codeVerifier, redirectUri: loopback.redirectUri }));
  } finally {
    for (const timer of timers)
      clearTimeout(timer);
    try {
      loopback.close();
    } catch {}
  }
}

// src/build/bridge.ts
import { createHash as createHash10, randomBytes } from "node:crypto";
import { mkdirSync as mkdirSync7, readFileSync as readFileSync13, statSync as statSync11, unlinkSync as unlinkSync3, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join17 } from "node:path";
var BRIDGE_ID = "enpal-gateway-bridge";
var object2 = (properties = {}, required2 = []) => ({ type: "object", properties, required: required2, additionalProperties: true });
var BRIDGE = {
  id: BRIDGE_ID,
  methods: {
    state: { input: object2(), output: object2({ build: { type: "string" }, why: { type: "string" } }, ["build", "why"]) },
    shown: { input: object2({ id: { type: "string" } }, ["id"]), output: object2() },
    loginStatus: { input: object2(), output: object2() },
    loginChanged: { input: object2(), output: object2() }
  },
  events: {}
};
var WITNESS = Symbol.for("enpal.gateway.plugin.local-service.v1");
function registerLocalService(dir) {
  const g = globalThis;
  const entries = g[WITNESS] ??= new Map;
  let entry = entries.get(dir);
  const path = join17(dir, `local-service-${process.pid}`);
  if (!entry) {
    entry = { nonce: randomBytes(32).toString("hex"), refs: 0 };
    try {
      mkdirSync7(dir, { recursive: true });
      writeFileSync6(path, entry.nonce, { mode: 384 });
    } catch {
      return { proof: "", dispose: () => {} };
    }
    entries.set(dir, entry);
  }
  entry.refs++;
  const proof = createHash10("sha256").update(entry.nonce).digest("hex");
  return { proof, dispose: () => {
    if (--entry.refs === 0) {
      entries.delete(dir);
      try {
        unlinkSync3(path);
      } catch {}
    }
  } };
}

// src/build/live-gate.ts
var FRESH_MS = 40 * 60000;
var IDLE_MS = 15000;
var ORPHAN_MS = 2 * 3600000;
function liveKey(key, o) {
  if (!o.link)
    return { on: false, why: "signed_out" };
  const n = o.newest;
  if (!n)
    return { on: false, why: "no_read" };
  if (!n.ok)
    return { on: false, why: n.why };
  if (n.link !== o.link)
    return { on: false, why: "login_changed" };
  if (o.now - n.at >= FRESH_MS || o.now < n.at - 60000)
    return { on: false, why: "stale" };
  if (!keyOn(n.answer, key))
    return { on: false, why: "key_off" };
  return { on: true };
}
var LIVE = Symbol.for("enpal.gateway.plugin.live.v1");
function liveProcess() {
  const g = globalThis;
  const s = g[LIVE] ??= { version: 1, busy: new Map, lastBusyAt: 0, generations: new Map, policies: new Map };
  s.generations ??= new Map;
  s.policies ??= new Map;
  return s;
}
var busyKey = (directory2, sessionID) => JSON.stringify([directory2, sessionID]);
function busyTracker(lp = liveProcess(), now = Date.now) {
  const touch = () => {
    lp.lastBusyAt = now();
  };
  const attach = (directory2, sessionID, wait, alive) => {
    const key = busyKey(directory2, sessionID);
    const entry = lp.busy.get(key);
    if (!entry || !wait)
      return;
    const mine = ++entry.waiter;
    entry.watched = true;
    let p;
    try {
      p = wait();
    } catch {
      p = Promise.reject(new Error("wait threw"));
    }
    p.then(() => {
      const e = lp.busy.get(key);
      if (e && e.waiter === mine) {
        lp.busy.delete(key);
        touch();
      }
    }, () => {
      const e = lp.busy.get(key);
      if (!e || e.waiter !== mine)
        return;
      if (alive()) {
        lp.busy.delete(key);
        touch();
      } else
        e.watched = false;
    });
  };
  return {
    started(directory2, sessionID, wait, alive = () => true) {
      const key = busyKey(directory2, sessionID);
      const entry = lp.busy.get(key);
      if (!entry)
        lp.busy.set(key, { since: now(), waiter: 0, watched: false });
      touch();
      if (!entry || !entry.watched)
        attach(directory2, sessionID, wait, alive);
    },
    ended(directory2, sessionID) {
      lp.busy.delete(busyKey(directory2, sessionID));
      touch();
    },
    reattach(directory2, wait, alive) {
      for (const key of [...lp.busy.keys()]) {
        const [dir, sessionID] = JSON.parse(key);
        if (dir === directory2)
          attach(dir, sessionID, () => wait(sessionID), alive);
      }
    },
    count() {
      const t = now();
      for (const [key, e] of lp.busy)
        if (!e.watched && t - e.since > ORPHAN_MS)
          lp.busy.delete(key);
      return lp.busy.size;
    },
    idleFor(ms) {
      return this.count() === 0 && now() - lp.lastBusyAt >= ms;
    }
  };
}

// src/build/connect-list.ts
import { join as join18 } from "node:path";
var FILE_MAX2 = 2 * 1024 * 1024;
function configuredProviders(env, directory2) {
  const { files, complete } = personFiles2x({ ...env, OPENCODE_CONFIG_CONTENT: undefined }, directory2);
  if (!complete)
    return null;
  const managed = managedConfigDir(env);
  const values = [];
  for (const path of [...files, join18(managed, "opencode.json"), join18(managed, "opencode.jsonc")]) {
    const { present, value } = readJsoncFile(path, FILE_MAX2);
    if (present && !value)
      return null;
    if (value)
      values.push(value);
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    let inline;
    try {
      inline = parseJsonc(env.OPENCODE_CONFIG_CONTENT);
    } catch {
      return null;
    }
    if (typeof inline !== "object" || inline === null || Array.isArray(inline))
      return null;
    values.push(inline);
  }
  const ids = new Set;
  for (const value of values)
    for (const key of ["provider", "providers"]) {
      const block = value[key];
      if (typeof block === "object" && block !== null && !Array.isArray(block))
        for (const id of Object.keys(block))
          ids.add(id);
    }
  return ids;
}
function theirs(i) {
  return i.metadata?.source === "mcp" || i.id.startsWith("mcp_") || i.id.includes("://");
}
function envSet(editor, id, env) {
  const methods = editor.method.list?.(id);
  if (!methods)
    return true;
  return methods.some((m) => m.type === "env" && (m.names ?? []).some((name15) => !!env[name15]));
}
function trimConnectList(editor, policy, facts, env) {
  const removed = [], unknown2 = [], absent = [];
  const list = [...editor.list()];
  const configured = list.some((i) => String(i.id).includes("://")) ? null : facts.configured;
  for (const integration of list) {
    const id = String(integration.id);
    if (id === PROVIDER_ID)
      continue;
    if (hostedProvider(policy, id)) {
      editor.remove(id);
      removed.push(id);
      continue;
    }
    if (!facts.folded || !configured || theirs(integration) || configured.has(id) || facts.activated.has(id) || envSet(editor, id, env))
      continue;
    const stored = facts.stored.get(id);
    if (stored === undefined) {
      unknown2.push(id);
      continue;
    }
    if (stored)
      continue;
    editor.remove(id);
    removed.push(id);
    absent.push(id);
  }
  return { removed, unknown: unknown2, absent };
}

// src/build/restart.ts
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync as readFileSync14, statSync as statSync12 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { basename as basename2, extname, join as join19 } from "node:path";
var RESTART_COMMAND = "enpal-restart";
var RESTART_DESCRIPTION = "Restart the OpenCode background service, to load a new Enpal AI Gateway plugin build.";
var RESTART_DELAY_MS = 400;
var REGISTRATION_MAX = 64 * 1024;
function registrationFile(env, channel, home = homedir8()) {
  const name15 = ["latest", "dev", "beta", "next"].includes(channel) ? "service.json" : `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
  return join19(env.XDG_STATE_HOME || join19(home, ".local", "state"), "opencode", name15);
}
function registeredPidIn(file2) {
  try {
    if (statSync12(file2).size > REGISTRATION_MAX)
      return null;
    const pid = JSON.parse(readFileSync14(file2, "utf8")).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function defaultRestartSys(channel) {
  const known = !!channel && channel !== "unknown";
  return {
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    pid: process.pid,
    registeredPid: () => known ? registeredPidIn(registrationFile(process.env, channel)) : null,
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    }
  };
}
function isManagedService(argv) {
  return argv.includes("serve") && argv.includes("--service");
}
var KEY2 = Symbol.for("enpal.gateway.plugin.restart.v1");
function registeredHere(sys) {
  return sys.registeredPid() === sys.pid;
}
function restartService(sys = defaultRestartSys(), log = () => {}, o = {}) {
  const g = globalThis;
  if (g[KEY2])
    return { ok: false, why: "already" };
  if (!isManagedService(sys.argv))
    return { ok: false, why: "not_service" };
  const runtime = basename2(sys.execPath, extname(sys.execPath)).toLowerCase();
  if (runtime === "bun" || runtime === "node" || runtime === "nodejs")
    return { ok: false, why: "dev_runtime" };
  const registered = sys.registeredPid();
  if (registered !== sys.pid)
    return { ok: false, why: registered === null ? "registration_unknown" : "not_registered" };
  g[KEY2] = true;
  let cancelled = false;
  let reported = false;
  const failed = (reason2) => {
    if (reported)
      return;
    reported = true;
    g[KEY2] = false;
    log(`restart: \`service restart\` failed (${reason2})`);
    if (o.alive && !o.alive())
      return;
    try {
      o.onFailure?.(reason2);
    } catch {}
  };
  let handedOff = false;
  const cancelTimer = sys.setTimer(() => {
    if (cancelled)
      return;
    if (o.alive && !o.alive()) {
      g[KEY2] = false;
      log("restart: dropped, the setup that asked for it is gone");
      return;
    }
    if (!registeredHere(sys)) {
      failed("another OpenCode service took the registration over");
      return;
    }
    handedOff = true;
    try {
      const child = sys.spawn(sys.execPath, ["service", "restart"], { detached: true, stdio: "ignore", env: sys.env, windowsHide: true });
      child.on?.("error", (e) => failed(e.message));
      child.on?.("exit", (code, signal) => {
        if (signal)
          failed(`ended by ${signal}`);
        else if (code !== 0 && code !== null)
          failed(`exit code ${code}`);
      });
      child.unref();
      log("restart: asked OpenCode to restart its background service");
    } catch (e) {
      failed(e?.message ?? String(e));
    }
  }, RESTART_DELAY_MS);
  return { ok: true, cancel: () => {
    if (cancelled || handedOff)
      return;
    cancelled = true;
    cancelTimer();
    g[KEY2] = false;
  } };
}

// src/build/sse.ts
var encoder = new TextEncoder;
function withAnswerNote(response, source) {
  if (!response.ok || !response.body)
    return response;
  const type = response.headers.get("content-type") ?? "";
  let taken = false;
  const once = { take: () => {
    const line = source.take();
    if (line)
      taken = true;
    return line;
  } };
  const end = (delivered) => {
    if (taken) {
      try {
        source.settled?.(delivered);
      } catch {}
    }
  };
  if (type.includes("text/event-stream")) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(readToEnd(noteStream(response.body, once), end), { status: response.status, statusText: response.statusText, headers });
  }
  if (type.includes("application/json")) {
    const out = jsonWithNote(response, once);
    return new Response(readToEnd(out.body, end), { status: out.status, statusText: out.statusText, headers: out.headers });
  }
  return response;
}
function readToEnd(inner, end) {
  const reader = inner.getReader();
  let ended = false;
  const finish = (delivered) => {
    if (!ended) {
      ended = true;
      end(delivered);
    }
  };
  return new ReadableStream({
    async pull(controller) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        finish(false);
        throw e;
      }
      if (r.done) {
        controller.close();
        finish(true);
      } else
        controller.enqueue(r.value);
    },
    cancel(reason2) {
      finish(false);
      return reader.cancel(reason2);
    }
  }, { highWaterMark: 0 });
}
function jsonWithNote(response, source) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const body = response.text().then((text) => {
    try {
      const doc2 = JSON.parse(text);
      const choice = doc2.choices?.[0];
      const message = choice?.message;
      if (choice?.finish_reason === "stop" && message && typeof message.content === "string" && message.content.trim()) {
        const line = source.take();
        if (line) {
          message.content += line;
          return JSON.stringify(doc2);
        }
      }
    } catch {}
    return text;
  });
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(await body));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    }
  }), { status: response.status, statusText: response.statusText, headers });
}
function splitFrame(frame) {
  const data = [];
  const rest = [];
  for (const line of frame.split(`
`)) {
    if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
    else
      rest.push(line);
  }
  return { data: data.join(`
`), rest: rest.join(`
`) };
}
function noteStream(body, source) {
  const decoder = new TextDecoder;
  let buffer = "";
  let sawText = false;
  let done = false;
  const emit = (controller, frame, separator) => {
    controller.enqueue(encoder.encode(rewrite(frame) + separator));
  };
  const rewrite = (frame) => {
    if (done)
      return frame;
    const { data, rest } = splitFrame(frame);
    if (!data || data.trim() === "[DONE]")
      return frame;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return frame;
    }
    const choice = parsed.choices?.[0];
    if (!choice)
      return frame;
    if (typeof choice.delta?.content === "string" && choice.delta.content.trim())
      sawText = true;
    if (choice.finish_reason === undefined || choice.finish_reason === null)
      return frame;
    done = true;
    if (choice.finish_reason !== "stop" || !sawText)
      return frame;
    const line = source.take();
    if (!line)
      return frame;
    const delta = choice.delta ??= {};
    delta.content = (typeof delta.content === "string" ? delta.content : "") + line;
    const out = [`data: ${JSON.stringify(parsed)}`];
    if (rest)
      out.unshift(rest);
    return out.join(`
`);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;; ) {
        const m = /\r?\n\r?\n/.exec(buffer);
        if (!m)
          break;
        const frame = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        emit(controller, frame, m[0]);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer)
        controller.enqueue(encoder.encode(rewrite(buffer)));
    }
  }));
}

// src/build/v2-commands.ts
var LOGIN_STEPS = "App: model picker -> Connect provider -> Enpal AI Gateway. Terminal: opencode auth login.";
function sessionCommands(ctx, options, alive, changed, signedIn) {
  const abort = new AbortController;
  const env = options.env ?? process.env;
  const browser = options.browserSys ?? defaultBrowserSys();
  let flight = null;
  const notice = async (input, text) => {
    if (alive())
      await ctx.session.synthetic({ sessionID: input.sessionID, text, description: text, delivery: input.delivery, resume: false });
  };
  const signIn = async (relogin) => {
    if (!alive())
      return "";
    const oauth = ctx.integration.oauth;
    if (!oauth || browserSwitchedOff(env))
      return LOGIN_STEPS;
    const deadline = AbortSignal.timeout(options.loginDeadlineMs ?? BROWSER_LOGIN_DEADLINE_MS);
    const signal = AbortSignal.any([abort.signal, deadline]);
    let attemptID = null;
    const cancel = async (id) => {
      const signal2 = AbortSignal.timeout(5000);
      await untilAborted(oauth.cancel({ integrationID: PROVIDER_ID, attemptID: id }, { signal: signal2 }), signal2).catch(() => {});
    };
    try {
      if (!relogin && await untilAborted(signedIn(), signal).catch(() => false))
        return "Already signed in. Use /enpal-login --relogin to change accounts.";
      if (!alive())
        return "";
      signal.throwIfAborted();
      const connecting = oauth.connect({ integrationID: PROVIDER_ID, methodID: "oauth", label: "Enpal AI Gateway" }, { signal });
      connecting.then((result) => {
        if (signal.aborted)
          return cancel(result.data.attemptID);
      }).catch(() => {});
      const attempt = (await untilAborted(connecting, signal)).data;
      attemptID = attempt.attemptID;
      const url2 = new URL(attempt.url), base = new URL(options.base);
      if (url2.origin !== base.origin || url2.pathname !== `${base.pathname.replace(/\/$/, "")}/oauth/authorize` || url2.username || url2.password)
        throw new Error("untrusted authorize URL");
      openBrowser(attempt.url, browser);
      for (;; ) {
        const result = (await untilAborted(oauth.status({ integrationID: PROVIDER_ID, attemptID }, { signal }), signal)).data;
        if (result.status === "complete") {
          attemptID = null;
          const refresh = AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]);
          await untilAborted(changed(), refresh).catch(() => {});
          return "Signed in. You can use Enpal AI Gateway in this session.";
        }
        if (result.status !== "pending")
          throw new Error("sign-in did not complete");
        await untilAborted(new Promise((resolve4) => setTimeout(resolve4, 500)), signal);
      }
    } catch {
      return `${deadline.aborted ? "Sign-in timed out." : "Sign-in did not finish."} ${LOGIN_STEPS}`;
    } finally {
      if (attemptID)
        await cancel(attemptID);
    }
  };
  return {
    definitions: [
      { name: SKILL_NAME, description: "Check this laptop's Enpal AI Gateway setup and explain differences.", execute: async (input) => {
        if (!alive())
          return;
        const body = SKILL_MD.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          delivery: input.delivery,
          text: body + (input.prompt.text ? `

The person's question: ${input.prompt.text}` : "")
        });
      } },
      { name: "enpal-login", description: "Sign in to Enpal AI Gateway in your browser.", execute: async (input) => {
        if (!alive())
          return;
        if (!ctx.integration.oauth || browserSwitchedOff(env)) {
          await notice(input, LOGIN_STEPS);
          return;
        }
        await notice(input, `Sign in to Enpal AI Gateway in your browser. If it does not open: ${LOGIN_STEPS}`);
        if (!alive())
          return;
        const relogin = /(^|\s)--relogin(\s|$)/.test(input.prompt.text);
        while (flight && relogin && !flight.relogin) {
          await flight.result;
          if (!alive())
            return;
        }
        if (!flight)
          flight = { relogin, result: signIn(relogin).finally(() => {
            flight = null;
          }) };
        await notice(input, await flight.result);
      } }
    ],
    dispose: async () => {
      abort.abort();
      await flight?.result;
    }
  };
}

// src/build/v2.ts
var V2_LINE = "v2";
var INTEGRATION_LABEL = "Enpal AI Gateway (browser login)";
var PROVIDER_NAME = "Enpal AI Gateway";
var isRecord7 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function toCredential(t) {
  return { type: "oauth", methodID: "oauth", access: t.access_token, refresh: t.refresh_token, expires: Math.max(0, Math.floor(t.expires_at * 1000)) };
}
async function authorizeInBrowser(config2, deps) {
  const verifier = generateVerifier();
  const state = generateState();
  const codeChallenge = await challengeS256(verifier);
  const loopback = await startLoopback(state, 0, BROWSER_LOGIN_DEADLINE_MS);
  const url2 = buildAuthorizeUrl(config2, { redirectUri: loopback.redirectUri, codeChallenge, state });
  const expiresAt = Date.now() + BROWSER_LOGIN_DEADLINE_MS;
  const callback = completeAttempt(config2, deps, loopback, verifier, { deadlineMs: BROWSER_LOGIN_DEADLINE_MS, callMs: BROWSER_LOGIN_CALL_MS }).then(toCredential);
  return { url: url2, instructions: "Sign in to the Enpal AI Gateway in your browser.", expiresAt, mode: "auto", callback };
}
async function refreshCredential(config2, deps, credential, store) {
  const key = renewKey(config2.tokenEndpoint.replace(/\/oauth\/token$/, ""), config2.clientId, credential.refresh);
  const held = processState().successors ??= new Map;
  const previous = held.get(key);
  if (previous && deps.now() < previous.until)
    return toCredential(previous.tokens);
  const t = await sharedRefresh(config2, deps, async () => {}, credential.refresh);
  held.set(key, { tokens: t, until: deps.now() + 60 });
  for (const [k, v] of held)
    if (deps.now() >= v.until)
      held.delete(k);
  if (store)
    followRotation(store, credential.refresh, t);
  return toCredential(t);
}
var PICKER_RECENT_MS = 150 * 86400000;
var DAY_MS = 86400000;
function toModelInfo(id, row, moduleUrl, now = Date.now()) {
  const limit = isRecord7(row.limit) ? row.limit : {};
  const modalities = isRecord7(row.modalities) ? row.modalities : {};
  const strings3 = (v, fallback) => Array.isArray(v) && v.every((x) => typeof x === "string") ? [...v] : fallback;
  const num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const cost = isRecord7(row.cost) ? row.cost : null;
  const cache = cost && isRecord7(cost.cache) ? cost.cache : {};
  const variants = isRecord7(row.variants) ? Object.entries(row.variants).filter(([, v]) => isRecord7(v)).map(([vid, v]) => ({ id: vid, settings: { ...v } })) : [];
  const headers = isRecord7(row.headers) ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === "string")) : undefined;
  const released = typeof row.release_date === "string" ? Date.parse(row.release_date) : NaN;
  const status = row.status === "alpha" || row.status === "beta" || row.status === "deprecated" ? row.status : "active";
  const recent = Number.isFinite(released) && released <= now && now - released < PICKER_RECENT_MS;
  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: typeof row.name === "string" ? row.name : id,
    family: id,
    ...moduleUrl ? { package: `aisdk:${moduleUrl}` } : {},
    ...headers && Object.keys(headers).length ? { headers } : {},
    capabilities: { tools: row.tool_call !== false, input: strings3(modalities.input, ["text"]), output: strings3(modalities.output, ["text"]) },
    variants,
    time: { released: recent ? released : Math.floor((now - PICKER_RECENT_MS) / DAY_MS) * DAY_MS },
    cost: cost ? [{ input: num(cost.input, 0), output: num(cost.output, 0), cache: { read: num(cache.read, 0), write: num(cache.write, 0) } }] : [],
    status,
    enabled: true,
    limit: { context: Math.trunc(num(limit.context, 200000)), ...typeof limit.input === "number" ? { input: Math.trunc(limit.input) } : {}, output: Math.trunc(num(limit.output, 32000)) }
  };
}
var COPY_OWNED_FIELDS = ["headers", "settings", "body", "compatibility", "options", "family", "cost", "variants"];
function rowsFor2x(startup, options) {
  const merged = { provider: { [PROVIDER_ID]: { models: {} } } };
  const outcome = composeGatewayBlock({ merged, official: startup.official, managed: null, policy: options.policy ?? null, features: startup.features, log: options.log });
  const rows = outcome.applied ? merged.provider[PROVIDER_ID].models : {};
  return { rows, notices: outcome.notices, copied: outcome.copied ?? [], last: { merged, outcome } };
}
function connectSwitchOn(cacheDir) {
  try {
    const path = join20(cacheDir, "pointer.json");
    if (statSync13(path).size > 256 * 1024)
      return false;
    const doc2 = JSON.parse(readFileSync15(path, "utf8"));
    return isRecord7(doc2) && isRecord7(doc2.policy) && doc2.policy.v2_connect === true;
  } catch {
    return false;
  }
}
function providerInfo(base, moduleUrl, connect = false) {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    activation: connect ? "auto" : "enabled",
    package: moduleUrl ? `aisdk:${moduleUrl}` : "@ai-sdk/openai-compatible",
    integrationID: PROVIDER_ID,
    settings: { baseURL: `${base}/v1` },
    headers: { "X-Data-Class": "internal", [PLUGIN_BUILD_HEADER]: PLUGIN_BUILD, [PLUGIN_LINE_HEADER]: V2_LINE }
  };
}
var ANSWER_NOTE_AFTER_MS = 60000;
var ANSWER_NOTE_PREFIXES = ["update:", "load-failed:", "restart-failed:"];
var BUILD_NOTES_ENV = "ENPAL_GATEWAY_BUILD_NOTES";
function buildNotesOff(env, file2) {
  if (/^(?:0|off|false|no)$/i.test((env[BUILD_NOTES_ENV] ?? "").trim()))
    return true;
  try {
    statSync13(file2);
    return true;
  } catch {
    return false;
  }
}
var RETRY_MS = 5000;
var RETRY_MAX_MS = 5 * 60000;
function answerNoteLine(n) {
  return `

— Enpal AI Gateway: ${n.message}`;
}
function createPendingNotices(store, quiet, now = Date.now) {
  const pending = [];
  const ephemeral = new Set;
  const since = new Map;
  const claimed = new Set;
  return {
    queue(list) {
      const shown = store.shown();
      for (const n of list) {
        if (shown[n.id] && !n.ephemeral || pending.some((p) => p.id === n.id) || quiet && n.variant !== "warning")
          continue;
        pending.push(n);
        since.set(n.id, now());
        if (n.ephemeral)
          ephemeral.add(n.id);
      }
    },
    upsert(n) {
      if (store.shown()[n.id] || quiet && n.variant !== "warning")
        return;
      const at = pending.findIndex((p) => p.id === n.id);
      if (at >= 0)
        pending[at] = n;
      else {
        pending.push(n);
        since.set(n.id, now());
      }
    },
    overdue(ms = ANSWER_NOTE_AFTER_MS) {
      const shown = store.shown();
      const t = now();
      return pending.filter((n) => !shown[n.id] && !claimed.has(n.id) && ANSWER_NOTE_PREFIXES.some((p) => n.id.startsWith(p)) && t - (since.get(n.id) ?? t) >= ms).sort((a, b) => (since.get(a.id) ?? 0) - (since.get(b.id) ?? 0))[0] ?? null;
    },
    withdraw(id) {
      const at = pending.findIndex((p) => p.id === id);
      if (at >= 0)
        pending.splice(at, 1);
      since.delete(id);
      claimed.delete(id);
    },
    pending: () => {
      const shown = store.shown();
      for (let i = pending.length - 1;i >= 0; i--) {
        const n = pending[i];
        if (shown[n.id] && !n.ephemeral) {
          pending.splice(i, 1);
          since.delete(n.id);
          claimed.delete(n.id);
        }
      }
      return pending.filter((n) => !claimed.has(n.id));
    },
    claim(id) {
      if (pending.some((p) => p.id === id))
        claimed.add(id);
    },
    release(id) {
      claimed.delete(id);
    },
    tracked: () => since.size,
    shown(id, day = new Date().toISOString().slice(0, 10)) {
      const at = pending.findIndex((p) => p.id === id);
      if (!ephemeral.has(id))
        store.markShown(id, day);
      if (at >= 0)
        pending.splice(at, 1);
      since.delete(id);
      claimed.delete(id);
    }
  };
}
function defaultOf(m) {
  const d = m.default.get();
  return d ? `${String(d.providerID)}/${String(d.modelID)}` : null;
}
function pickerShape(row) {
  const out = {};
  if (typeof row.name === "string")
    out.name = row.name;
  if (isRecord7(row.limit))
    out.limit = { ...row.limit };
  return out;
}
var ANCESTOR_MAX = 64;
var UNREAD_CONFIG_ENV = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"];
function configFilesFor2x(env, directory2) {
  const files = GLOBAL_CONFIG_FILES.map((name15) => join20(opencodeConfigDir(env), name15));
  if (!directory2)
    return { files, complete: false };
  const chain = [];
  let dir = resolve4(directory2);
  let reachedRoot = false;
  for (let i = 0;i < ANCESTOR_MAX; i++) {
    chain.unshift(dir);
    const parent = dirname4(dir);
    if (parent === dir) {
      reachedRoot = true;
      break;
    }
    dir = parent;
  }
  for (const d of chain)
    files.push(join20(d, "opencode.json"), join20(d, "opencode.jsonc"));
  for (const d of chain)
    files.push(join20(d, ".opencode", "opencode.json"), join20(d, ".opencode", "opencode.jsonc"));
  return { files, complete: reachedRoot };
}
function personalRowsFromConfig(env, directory2) {
  const { files, complete: walked } = configFilesFor2x(env, directory2);
  let complete = walked && !UNREAD_CONFIG_ENV.some((k) => env[k]);
  const rows = new Map;
  for (const path of files) {
    const { present, value } = readJsoncFile(path, 2 * 1024 * 1024);
    if (present && !value)
      complete = false;
    for (const key of ["provider", "providers"]) {
      const providers = value && isRecord7(value[key]) ? value[key] : null;
      const block = providers && isRecord7(providers[PROVIDER_ID]) ? providers[PROVIDER_ID] : null;
      if (!block || !isRecord7(block.models))
        continue;
      for (const [id, row] of Object.entries(block.models)) {
        if (!isRecord7(row) || id === "__proto__" || id === "constructor" || id === "prototype")
          continue;
        rows.set(id, mergeDeep(rows.get(id) ?? {}, row));
      }
    }
  }
  const guarded = new Set(complete ? [] : rows.keys());
  return { rows, guarded, complete };
}
function hostLoginSource(ctx, now = Date.now) {
  return {
    current: async () => {
      const l = await hostLogin(ctx);
      return l ? linkOf(l.record.refresh) : null;
    },
    access: async () => {
      const l = await hostLogin(ctx);
      return l && l.record.access && now() < l.record.expires - 60000 ? { access: l.record.access, refresh: l.record.refresh } : null;
    }
  };
}
async function hostLogin(ctx) {
  const connection = await ctx.integration.connection.active(PROVIDER_ID);
  const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
  if (credential?.type !== "oauth")
    return null;
  return { source: "file", record: { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires } };
}
function skillBody(md) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length) : md;
}
function composeHolder(startup, policy, o) {
  const composed = rowsFor2x(startup, { policy, log: o.log });
  return {
    startup,
    policy,
    composed,
    models: Object.entries(composed.rows).map(([id, row]) => toModelInfo(id, row, o.moduleUrl)),
    retiredMap: policy?.retired ?? {},
    composedIds: new Set(Object.keys(composed.rows)),
    digest: `${rowsDigest(composed.rows)}:${policyDigest(policy)}`
  };
}
function loopbackBase(base) {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(base).hostname);
  } catch {
    return false;
  }
}
function createSetup(options) {
  const base = options.base.replace(/\/+$/, "");
  const rules = modelsPolicyState(base);
  if (options.policy?.models_policy)
    acceptModelsPolicy(rules, [{ raw: options.policy.models_policy, source: "handed" }], base, options.log);
  const cacheDir = options.cacheDir ?? join20(require_home(), ".enpal", "gateway", "plugins", baseKey(base));
  const log = (m) => {
    try {
      options.log?.(m);
    } catch {}
  };
  const env = options.env ?? process.env;
  const deps = () => {
    const d = options.fetch ? { ...defaultDeps(), fetch: options.fetch } : defaultDeps();
    return { ...d, fetch: guardedFetch(d.fetch, baseOf(base)) };
  };
  const config2 = configFor(base, options.clientId);
  const store = fileFeaturesStore(cacheDir);
  return async (ctx) => {
    const watcher = watcherOff(env) ? null : options.watcher ?? processWatcher();
    const regs = [];
    const extra = [];
    let disposed = false;
    let guardBroken = false;
    let pinBroken = false;
    let minimum = null;
    let doctorReady = false;
    let transportReady = false;
    let packageUnchecked = false;
    const contained = (what, fn, settled) => (editor) => {
      try {
        fn(editor);
        settled?.(true);
      } catch (e) {
        settled?.(false);
        log(`${what} failed and was contained: ${e?.message ?? e}`);
      }
    };
    const track = async (p) => {
      const r = await p;
      regs.push(r);
      return r;
    };
    const dispose = async () => {
      disposed = true;
      for (const stop of extra.splice(0)) {
        try {
          stop();
        } catch {}
      }
      for (const r of regs.splice(0).reverse()) {
        try {
          await r.dispose();
        } catch {}
      }
    };
    try {
      let lockPolicy = null;
      let appliedNotice = rules.policy.notice;
      const held = { lock: null };
      const lockNotices = [];
      let lockNoticeSink = null;
      let lockFoldSink = null;
      const advisory = otherProviderNotices(cacheDir, Date.now, log);
      const offer = (n) => {
        if (lockNoticeSink)
          lockNoticeSink(n);
        else
          lockNotices.push(n);
      };
      const registrations = createLockRegistrations(ctx, rules, {
        base,
        cacheDir,
        log,
        ownsRequest: (r, route) => {
          if (!options.moduleUrl || guardBroken || pinBroken)
            return false;
          const factory = typeof route.package === "string" && route.package.replace(/^aisdk:/, "") === options.moduleUrl;
          const pinned = factory || r.model.providerID === PROVIDER_ID && transportReady;
          const url2 = r.baseURL ?? route.baseURL;
          return pinned && (url2 === undefined || url2 === "https://ai-sdk.local" || typeof url2 === "string" && underBase(new URL(url2), baseOf(base)));
        },
        onUse: (id) => {
          const n = advisory.observe(id, rules.policy);
          if (n)
            offer(n);
        },
        onFold: (m) => lockFoldSink?.(m),
        onDefaultReplaced: (r) => offer(lockDefaultNotice(r))
      });
      held.lock = registrations;
      regs.push(registrations.registration);
      await registrations.relast(true);
      minimum = registrations;
      await bootstrapModelsPolicy({ ...options, base, cacheDir, log, line: options.line ?? "v2", loaderVersion: options.loaderVersion ?? 0 });
      if (watcher?.policyOf(base)) {
        registrations.followPolicy(watcher.policyOf(base));
        lockPolicy = policyDigest(watcher.policyOf(base));
      }
      if (!hostTested(ctx.app?.version)) {
        log(`host_untested: OpenCode ${ctx.app?.version ?? "unknown"}; best-effort hosted guards; tested=${TESTED_HOSTS.join(", ")}`);
      }
      await track(ctx.integration.transform(contained("login transform", (e) => {
        e.update(PROVIDER_ID, (i) => {
          i.name = PROVIDER_NAME;
        });
        e.method.update({
          integrationID: PROVIDER_ID,
          method: { id: "oauth", type: "oauth", label: INTEGRATION_LABEL },
          authorize: async () => authorizeInBrowser(config2, deps()),
          refresh: async (c) => {
            const next = await refreshCredential(config2, deps(), c, store);
            if (next.refresh !== c.refresh)
              watcher?.rotated(base, c.refresh, next.refresh);
            return next;
          }
        });
      })));
      const connectFacts = {
        folded: false,
        activated: new Set,
        configured: null,
        stored: new Map
      };
      const pendingStored = new Set;
      let asking = false, credentialGeneration = 0, foldedPolicy = "", lastRemoved = null;
      const reloadIntegrations = (why) => {
        if (disposed || !ctx.integration.reload)
          return;
        Promise.resolve().then(() => ctx.integration.reload()).catch((e) => log(`connect list: reload after ${why} failed (${e?.message ?? e})`));
      };
      const askStored = async () => {
        if (asking)
          return;
        asking = true;
        let changed = false;
        try {
          while (pendingStored.size && !disposed) {
            const ids = [...pendingStored];
            pendingStored.clear();
            const generation = credentialGeneration;
            const answers = await Promise.all(ids.map(async (id) => {
              try {
                return [id, !!await ctx.integration.connection.active(id)];
              } catch {
                return [id, true];
              }
            }));
            if (generation !== credentialGeneration) {
              for (const id of ids)
                pendingStored.add(id);
              continue;
            }
            for (const [id, stored] of answers) {
              const before = connectFacts.stored.get(id);
              if (before === stored)
                continue;
              if (before !== undefined || !stored)
                changed = true;
              connectFacts.stored.set(id, stored);
            }
          }
        } finally {
          asking = false;
        }
        if (changed)
          reloadIntegrations("the stored-connection check");
      };
      const credentialChanged = (integrationID) => {
        credentialGeneration++;
        for (const [id, stored] of connectFacts.stored)
          if (!stored)
            pendingStored.add(id);
        if (typeof integrationID === "string" && connectFacts.stored.has(integrationID))
          pendingStored.add(integrationID);
        askStored();
      };
      await track(ctx.provider.transform(contained("connect list facts", (p) => {
        const activated = new Set;
        for (const r of p.list())
          if (r.provider.activation === "enabled")
            activated.add(String(r.provider.integrationID ?? r.provider.id));
        const changed = !connectFacts.folded || foldedPolicy !== rules.digest || activated.size !== connectFacts.activated.size || [...activated].some((id) => !connectFacts.activated.has(id));
        connectFacts.folded = true;
        connectFacts.activated = activated;
        foldedPolicy = rules.digest;
        if (changed)
          reloadIntegrations("the provider fold");
      })));
      await track(ctx.integration.transform(contained("connect list", (e) => {
        connectFacts.configured = configuredProviders(env, ctx.location?.directory);
        const { removed, unknown: unknown2, absent } = trimConnectList(e, rules.policy, connectFacts, env);
        for (const id of [...unknown2, ...absent])
          pendingStored.add(id);
        if (pendingStored.size)
          askStored();
        const said = removed.join(",");
        if (said !== lastRemoved && !unknown2.length) {
          lastRemoved = said;
          log(`connect list: removed ${said || "none"}`);
        }
      })));
      const startup = await oncePerProcess(processState().picks, startupKey(base, options.build), async () => {
        const login = options.signal?.aborted ? null : await untilAborted(hostLogin(ctx), options.signal).catch((e) => {
          log(`login: the host could not resolve the connection in time (${e?.message ?? e})`);
          return null;
        });
        return runStartup({ base, options, cacheDir, store, persist: async () => {}, clientId: options.clientId, env, fetch: deps().fetch, login, silentRefresh: false, log });
      });
      const lp = liveProcess();
      let h = composeHolder(startup, watcher?.policyOf(base) ?? lp.policies.get(normalisedBase(base)) ?? options.policy ?? null, { moduleUrl: options.moduleUrl, log });
      const lastOf = (x) => ({ merged: x.composed.last.merged, outcome: x.composed.last.outcome, generated: new Set(x.composed.last.outcome.featureRows?.added ?? []) });
      const last = {
        ...lastOf(h),
        skill: { skill_folder: null, skill_added: false, personal_skill_clash: null, personal_command_clash: false, command_added: false, login_command_added: false, news_command_added: false, scan_complete: true, verify_note: VERIFY_NOTE }
      };
      const connect = connectSwitchOn(cacheDir);
      const info = providerInfo(base, options.moduleUrl, connect);
      await track(ctx.provider.transform(contained("rows transform", (e) => {
        if (e.get(PROVIDER_ID)) {
          e.update(PROVIDER_ID, (p) => {
            Object.assign(p, info);
          });
          e.models.set(PROVIDER_ID, h.models);
        } else {
          e.add({ info, models: h.models });
        }
      })));
      log(`rows: ${h.models.length} models (${startup.official?.source ?? "none"}) features=${startup.features.kind} activation=${info.activation}`);
      const noticeStore = fileNoticeStore(cacheDir);
      const notices = createPendingNotices(noticeStore, !!env.ENPAL_GATEWAY_QUIET);
      const diag = createDisabledDiagnostics({ line: "v2", base, cacheDir, env, directory: ctx.location.directory });
      let read = { input: "unknown", source: null, files: [], unreadable: false, policy: restoreControlState(base) };
      let observed = null;
      const told = new Map;
      const settled = (kind, key) => {
        if (told.get(kind) === key)
          return;
        told.set(kind, key);
        queueMicrotask(() => {
          try {
            const n = diag.notice();
            if (n && !disposed)
              notices.queue([n]);
            const said = diag.facts().summary;
            if (said)
              log(`disabled_providers: ${said}`);
          } catch (e) {
            log(`disabled_providers: notice failed (${e?.message ?? e})`);
          }
        });
      };
      const onRestore = (ev) => {
        if (ev.kind === "missing") {
          if (!observed || observed.input !== "deny")
            observed = { token: diag.observe({ ...read, input: "deny", policy: restoreControlState(base) }), input: "deny" };
          diag.report(observed.token, { attempted: ev.attempted, restored: ev.restored, failure: ev.failure });
          settled("missing", `${observed.token}:${ev.attempted}:${ev.restored}:${ev.failure ?? ""}`);
          return;
        }
        if (ev.kind === "failed") {
          if (!observed)
            observed = { token: diag.observe({ ...read, input: "unknown", policy: restoreControlState(base) }), input: "unknown" };
          diag.report(observed.token, { failure: ev.phase, currently_available: null });
          settled("failed", `${observed.token}:${ev.phase}`);
          return;
        }
        if (ev.present && ev.found === "present" && observed?.input !== "clean") {
          observed = { token: diag.observe({ ...read, input: "clean" }), input: "clean" };
          told.clear();
        }
        if (!observed)
          return;
        diag.report(observed.token, { currently_available: ev.present });
        settled("final", `${observed.token}:${ev.present}`);
      };
      const restore = createRestoreRegistrations(ctx, {
        restoreOn: () => restoreEnpalEnabled(base),
        reread: () => {
          read = { ...provenance2x({ env, directory: ctx.location.directory }), files: filesSwitchingOff(env, ctx.location.directory, "v2"), policy: restoreControlState(base) };
          observed = null;
          told.clear();
        },
        add: (e) => e.add({ info, models: h.models }),
        pin: (e) => {
          const p = e.get(PROVIDER_ID)?.provider;
          if (p && (p.package !== info.package || !trustedAddress(p.settings?.baseURL, base)))
            e.update(PROVIDER_ID, (d) => {
              pinProvider2x(d, info.package, base);
            });
        },
        log,
        outcome: onRestore
      });
      regs.push(restore.registration);
      await restore.relast();
      const notesOffFile = options.buildNotesOffFile ?? join20(require_home(), ".enpal", "gateway", "build-notes-off");
      notices.queue(h.composed.notices);
      const update = buildUpdateNotice(options);
      if (update)
        notices.queue([update]);
      const failed = buildLoadFailedNotice(options);
      if (failed)
        notices.queue([failed]);
      if (!serviceKeyFromEnv(env))
        hostLogin(ctx).then((l) => {
          if (!l && !disposed)
            notices.queue([welcomeNotice("v2")]);
        }, () => {});
      const reminders = createReminders(store, async (title, message, who) => {
        if (disposed)
          return;
        notices.queue([{ id: `reminder:${who.subject}:${who.key}:${who.version}:${who.day}`, title, message, variant: "info" }]);
      });
      reminders.arm(startup.features, startup.official?.catalogue.features);
      lockNoticeSink = (n) => notices.upsert(n);
      for (const n of lockNotices.splice(0))
        notices.upsert(n);
      const loginSource = hostLoginSource(ctx);
      const busy = busyTracker(lp);
      const directory2 = ctx.location.directory;
      let livePicker = { on: false, why: "no_read" };
      let retry = null;
      extra.push(() => {
        if (retry)
          clearTimeout(retry);
        retry = null;
      });
      let rejected = 0;
      const rejectedWait = () => Math.min(RETRY_MS * 2 ** Math.max(0, rejected - 1), RETRY_MAX_MS);
      const later = (reason2, wait) => {
        if (disposed)
          return;
        if (wait !== undefined && retry) {
          clearTimeout(retry);
          retry = null;
        }
        if (!retry) {
          retry = setTimeout(() => {
            retry = null;
            refreshRows(reason2);
          }, wait ?? RETRY_MS);
          retry.unref?.();
        }
      };
      const accept = (next) => {
        if (disposed)
          return;
        processState().picks.set(startupKey(base, options.build), Promise.resolve(next.startup));
        if (next.policy)
          lp.policies.set(normalisedBase(base), next.policy);
        reminders.arm(next.startup.features, next.startup.official?.catalogue.features);
      };
      let forced = false;
      let waitingFor = null;
      let repairNeeded = false;
      const repairRows = async (reason2, own = true) => {
        if (disposed)
          return false;
        let failed2 = false;
        let failure = null;
        for (const reload of [() => ctx.provider.reload(), () => ctx.model.reload()]) {
          try {
            await reload();
          } catch (e) {
            failed2 = true;
            failure = e;
          }
          if (disposed)
            return false;
        }
        if (failed2) {
          if (!own) {
            log(`live: rows reason=${reason2} rollback reload failed (${failure?.message ?? failure})`);
            return false;
          }
          rejected++;
          log(`live: rows reason=${reason2} rollback reload failed, will retry in ${rejectedWait() / 1000} s (${failure?.message ?? failure})`);
          later(reason2, rejectedWait());
          return false;
        }
        repairNeeded = false;
        return true;
      };
      const applyHolder = async (next, reason2, force) => {
        if (disposed)
          return false;
        if (repairNeeded && !await repairRows(reason2)) {
          forced ||= force;
          return false;
        }
        if (disposed)
          return false;
        if (next.digest === h.digest) {
          h = next;
          waitingFor = null;
          accept(next);
          return true;
        }
        const removed = [...h.composedIds].filter((id) => !next.composedIds.has(id));
        const retiring = Object.keys(next.retiredMap).filter((id) => !(id in h.retiredMap));
        if ((removed.length || retiring.length) && !busy.idleFor(IDLE_MS)) {
          if (waitingFor !== next.digest)
            log(`live: rows reason=${reason2} waits for idle (removes ${removed.length}, retires ${retiring.length})`);
          waitingFor = next.digest;
          forced = force;
          later(reason2);
          return false;
        }
        waitingFor = null;
        const previous = { h, last: { merged: last.merged, outcome: last.outcome, generated: last.generated } };
        h = next;
        Object.assign(last, lastOf(h));
        try {
          await ctx.provider.reload();
          if (disposed)
            return false;
          await ctx.model.reload();
          if (disposed)
            return false;
        } catch (e) {
          if (disposed)
            return false;
          h = previous.h;
          Object.assign(last, previous.last);
          repairNeeded = true;
          await repairRows(reason2, false);
          if (disposed)
            return false;
          rejected++;
          log(`live: rows reason=${reason2} reload failed, will retry in ${rejectedWait() / 1000} s (${e?.message ?? e})`);
          forced = force;
          later(reason2, rejectedWait());
          return false;
        }
        rejected = 0;
        notices.queue(h.composed.notices);
        accept(next);
        const generation = (lp.generations.get(normalisedBase(base)) ?? 0) + 1;
        lp.generations.set(normalisedBase(base), generation);
        log(`live: rows reason=${reason2} generation=${generation} models=${h.models.length} removed=${removed.length} retired=${retiring.length}`);
        return true;
      };
      const refreshOnce = async (reason2) => {
        if (disposed)
          return;
        if (repairNeeded && !await repairRows(reason2))
          return;
        if (disposed)
          return;
        const force = forced;
        forced = false;
        const link = await loginSource.current().catch(() => null);
        if (disposed)
          return;
        const snap = watcher?.snapshot(base) ?? null;
        livePicker = liveKey(LIVE_PICKER, { newest: snap?.newest, link, now: Date.now() });
        const allowed = livePicker.on || force && livePicker.why === "key_off";
        if (!allowed || !snap?.newest?.ok || disposed)
          return;
        const answer = snap.newest.answer;
        const features = { kind: "answer", answer, fresh: true, subject: answer.subject ?? null };
        const official = snap.served?.ok ? officialFrom(snap.served, { cacheDir, options }) : h.startup.official;
        await applyHolder(composeHolder({ features, official }, snap.policy ?? h.policy, { moduleUrl: options.moduleUrl, log }), reason2, force);
      };
      let refreshing = null;
      let refreshAgain = null;
      const refreshRows = (reason2, force = false) => {
        if (disposed)
          return Promise.resolve();
        if (force)
          forced = true;
        if (refreshing) {
          refreshAgain = reason2;
          return refreshing;
        }
        return refreshing = (async () => {
          let next = reason2;
          try {
            while (next && !disposed) {
              refreshAgain = null;
              await refreshOnce(next);
              next = refreshAgain;
            }
          } catch (e) {
            if (!disposed)
              log(`live: rows failed (${e?.message ?? e})`);
          } finally {
            refreshing = null;
          }
        })();
      };
      let lastLink;
      loginSource.current().then((l) => {
        lastLink ??= l;
      }, () => {});
      const loginCheck = async () => {
        const link = await loginSource.current().catch(() => {
          return;
        });
        if (link === undefined || link === lastLink || disposed)
          return;
        lastLink = link;
        await watcher?.loginSeen(base, link);
      };
      if (watcher) {
        const unwatch = watcher.subscribe({
          base,
          build: options.build ?? "legacy",
          line: "v2",
          loaderVersion: options.loaderVersion ?? 0,
          approvedAtStart: options.approved,
          cacheDir,
          live: {
            rows: (reason2) => {
              refreshRows(reason2, reason2 === "login");
            },
            policy: (policy) => {
              const digest2 = policyDigest(policy);
              if (!held.lock || digest2 === lockPolicy)
                return;
              lockPolicy = digest2;
              held.lock.followPolicy(policy);
              if (appliedNotice !== rules.policy.notice) {
                appliedNotice = rules.policy.notice;
                for (const n of notices.pending())
                  if (n.id.startsWith(OTHER_NOTICE_PREFIX))
                    notices.withdraw(n.id);
                for (const id of held.lock.effects.used) {
                  const n = advisory.observe(id, rules.policy);
                  if (n)
                    notices.queue([n]);
                }
              }
            }
          },
          ...loopbackBase(base) && Number(env.ENPAL_GATEWAY_WATCHER_POLL_MS) > 0 ? { pollMs: Number(env.ENPAL_GATEWAY_WATCHER_POLL_MS) } : {},
          fetch: guardedFetch(options.fetch ?? defaultDeps().fetch, baseOf(base), { allowNotModified: true }),
          startup: { features: startup.features, catalogue: startup.official?.catalogue.features },
          login: hostLoginSource(ctx),
          featuresStore: store,
          noticeStore,
          quiet: !!env.ENPAL_GATEWAY_QUIET,
          log,
          sink: { mode: "bridge", offer: async (n) => {
            notices.upsert(n);
          }, withdraw: (id) => notices.withdraw(id) }
        });
        extra.push(unwatch);
      }
      const gatewayBase = baseOf(base);
      if (options.moduleUrl) {
        const ourModule = options.moduleUrl;
        const ourPackage = `aisdk:${ourModule}`;
        const refusePackage = (which) => (e) => {
          if (String(e.model?.providerID) !== PROVIDER_ID)
            return;
          if (e.model?.package === ourPackage && (which === "language" || e.package === ourModule))
            return;
          throw new Error("enpal-gateway: this Enpal model is configured with another package; the plugin sends Enpal requests only through its own. " + "Remove the model's or provider's \"package\" from your config or type `/enpal-restart`. No request was sent.");
        };
        const aisdkHook = ctx.aisdk?.hook;
        if (typeof aisdkHook === "function") {
          await track(aisdkHook("sdk", refusePackage("sdk"), { providerID: PROVIDER_ID }));
          await track(aisdkHook("language", refusePackage("language"), { providerID: PROVIDER_ID }));
        } else {
          packageUnchecked = true;
          log("aisdk: this OpenCode offers no aisdk hook; Enpal model requests are refused");
        }
      }
      const notes = createAutoNotes(fileNoteStore(), async (sessionID, title) => {
        await ctx.session.update({ sessionID, title });
      });
      await track(ctx.session.hook("model.request", (r) => {
        if (guardBroken || pinBroken) {
          throw new Error(`enpal-gateway: the plugin could not ${guardBroken ? "re-register" : "apply"} its transport guard after a configuration reload; ` + "type `/enpal-restart` in OpenCode. No request was sent.");
        }
        if (packageUnchecked) {
          throw new Error("enpal-gateway: this OpenCode cannot tell the plugin which package builds an Enpal model, so no Enpal request is sent. " + "Update OpenCode.");
        }
        if (options.moduleUrl && typeof r.baseURL === "string" && r.baseURL !== AI_SDK_SENTINEL) {
          throw new Error("enpal-gateway: this Enpal model is configured with another package; the plugin sends Enpal requests only through its own. " + 'Remove the model\'s "package" from your config or type `/enpal-restart`. No request was sent.');
        }
        r.headers[PLUGIN_BUILD_HEADER] = PLUGIN_BUILD;
        r.headers[PLUGIN_LINE_HEADER] = V2_LINE;
        const agent = r.kind === "title" ? "title" : r.kind === "compaction" ? "compaction" : undefined;
        notes.modelCall({ sessionID: r.sessionID, agent, model: { id: r.model.id, providerID: r.model.providerID } });
        if (r.kind === "primary")
          reminders.modelCall({ model: { id: r.model.id, providerID: r.model.providerID } });
      }, { providerID: PROVIDER_ID }));
      await track(ctx.session.hook("http.request", (r) => {
        let url2 = null;
        try {
          url2 = new URL(r.request.url);
        } catch {}
        if (!url2 || !underBase(url2, gatewayBase)) {
          throw new Error(`enpal-gateway: the plugin sends Enpal requests only to ${gatewayBase.origin}${gatewayBase.path}; ` + `the request to ${url2 ? `${url2.origin}${url2.pathname}` : "an address it cannot read"} was not sent.`);
        }
        if (options.moduleUrl && r.request.headers.get(LANGUAGE_STAMP_HEADER) !== languageStamp()) {
          throw new Error("enpal-gateway: this Enpal model was set up before the plugin's guard or from another package, so the plugin " + "does not send its request. Restart OpenCode: type `/enpal-restart`. No request was sent.");
        }
      }, { providerID: PROVIDER_ID }));
      await track(ctx.session.hook("http.response", (r) => {
        let url2 = null;
        try {
          url2 = new URL(r.request.url);
        } catch {
          return;
        }
        if (!underBase(url2, gatewayBase))
          return;
        if (watcher) {
          try {
            watcher.hint(base, r.request.url, r.response.headers);
          } catch {}
        }
        if (r.kind !== "primary" || !r.response.ok)
          return;
        try {
          notes.record(new Headers({ "x-session-id": r.sessionID }), r.response.headers);
        } catch {}
        const carried = [];
        r.response = withAnswerNote(r.response, { take: () => {
          const auto = notes.take(r.sessionID);
          let due = null;
          try {
            due = buildNotesOff(env, notesOffFile) ? null : notices.overdue(options.answerNoteAfterMs);
            if (due) {
              notices.claim(due.id);
              carried.push(due.id);
            }
          } catch {
            due = null;
          }
          let advisoryNote = null;
          try {
            advisoryNote = notices.pending().find((n) => n.id.startsWith(OTHER_NOTICE_PREFIX)) ?? null;
            if (advisoryNote) {
              notices.claim(advisoryNote.id);
              carried.push(advisoryNote.id);
            }
          } catch {}
          return auto || due || advisoryNote ? `${auto ?? ""}${due ? answerNoteLine(due) : ""}${advisoryNote ? answerNoteLine(advisoryNote) : ""}` : null;
        }, settled: (delivered) => {
          for (const id of carried.splice(0)) {
            try {
              if (delivered)
                notices.shown(id);
              else
                notices.release(id);
            } catch {}
          }
        } });
      }, { providerID: PROVIDER_ID }));
      const pkg = options.moduleUrl ? `aisdk:${options.moduleUrl}` : null;
      const ledger = fileCopyLedger(cacheDir);
      let knownCopies = ledger.load();
      let copiesSeen = [];
      const late2 = (m) => {
        const { retiredMap, startup: startup2, composed } = h;
        for (const id of Object.keys(retiredMap)) {
          if (!m.get(PROVIDER_ID, id))
            continue;
          m.remove(PROVIDER_ID, id);
          notices.upsert(retiredNotice(id, retiredMap[id] ?? null, defaultOf(m) === `${PROVIDER_ID}/${id}`));
        }
        const found = {};
        for (const [id, row] of configured.rows) {
          if (configured.guarded.has(id))
            continue;
          if (retiredMap[id] !== undefined || !isCopy(id, row, { official: startup2.official, features: startup2.features, copies: knownCopies }))
            continue;
          found[id] = rowFingerprint(row);
          if (!m.get(PROVIDER_ID, id))
            continue;
          const ours = composed.rows[id];
          if (ours)
            m.update(PROVIDER_ID, id, (x) => {
              const next = toModelInfo(id, ours, options.moduleUrl);
              const draft = x;
              for (const k of COPY_OWNED_FIELDS)
                if (!(k in next))
                  delete draft[k];
              Object.assign(draft, next);
            });
          else
            m.remove(PROVIDER_ID, id);
        }
        copiesSeen = Object.keys(found);
        ledger.save(found);
        const effective = m.list(PROVIDER_ID);
        for (const row of effective)
          m.update(PROVIDER_ID, String(row.id ?? row.modelID), (x) => {
            pinModel2x(x, pkg, base);
          });
        rememberEffective(m, effective);
      };
      let configured = personalRowsFromConfig(env, ctx.location.directory);
      const rememberEffective = (m, effective) => {
        const rows = {};
        for (const row of effective)
          rows[String(row.id ?? row.modelID)] = pickerShape(row);
        const personal = Object.keys(rows).filter((id) => configured.rows.has(id) && !copiesSeen.includes(id) || !h.composedIds.has(id));
        const copied = [...copiesSeen];
        const provider = m.provider.get(PROVIDER_ID)?.provider;
        last.merged = { model: defaultOf(m) ?? undefined, provider: { [PROVIDER_ID]: { options: { headers: provider?.headers ?? {} }, models: rows } } };
        last.outcome = { ...h.composed.last.outcome, models: Object.keys(rows).length, personal, copied };
      };
      const subscription = new AbortController;
      extra.push(() => {
        subscription.abort();
      });
      lockFoldSink = (m) => rememberEffective(m, m.list(PROVIDER_ID));
      let lateReg = null;
      let registering = null;
      let again = false;
      const registerOnce = async (initial) => {
        try {
          if (!initial) {
            configured = personalRowsFromConfig(env, ctx.location.directory);
            knownCopies = ledger.load();
          }
          const next = await ctx.model.transform(contained("late transform", late2, (ok) => {
            pinBroken = !ok;
          }));
          if (disposed) {
            await next.dispose().catch(() => {});
            return;
          }
          const old = lateReg;
          lateReg = next;
          regs.push(next);
          guardBroken = false;
          if (old) {
            const at = regs.indexOf(old);
            if (at >= 0)
              regs.splice(at, 1);
            await old.dispose().catch(() => {});
          }
        } catch (e) {
          if (initial)
            throw e;
          guardBroken = true;
          log(`late model transform could not be registered again; Enpal requests are refused until it is: ${e?.message ?? e}`);
        }
      };
      const registerLate = (initial = false) => {
        if (registering) {
          again = true;
          return registering;
        }
        return registering = (async () => {
          try {
            await registerOnce(initial);
            while (again && !disposed) {
              again = false;
              await registerOnce(false);
            }
          } finally {
            registering = null;
            again = false;
          }
        })();
      };
      await registerLate(true);
      transportReady = true;
      await held.lock.relast();
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: subscription.signal })) {
            if (disposed)
              break;
            if (ev.type === "plugin.updated") {
              registerLate();
              held.lock?.relast();
              restore.relast();
            }
            if (ev.type === "config.updated")
              restore.relast();
            const data = isRecord7(ev.data) ? ev.data : {};
            const sessionID = typeof data.sessionID === "string" ? data.sessionID : null;
            const here = !ev.location || ev.location.directory === directory2;
            if (sessionID && here && (ev.type === "session.execution.started" || ev.type === "session.step.started")) {
              busy.started(directory2, sessionID, () => ctx.session.wait({ sessionID }), () => !disposed);
            } else if (sessionID && here && (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed" || ev.type === "session.execution.interrupted")) {
              busy.ended(directory2, sessionID);
            }
            if (ev.type === "credential.updated" || ev.type === "credential.switched") {
              loginCheck().catch(() => {});
              credentialChanged(data.integrationID);
            }
            if ((ev.type === "session.renamed" || ev.type === "session.created") && typeof data.sessionID === "string" && typeof data.title === "string") {
              const info2 = { id: data.sessionID, title: data.title };
              if (typeof data.parentID === "string")
                info2.parentID = data.parentID;
              notes.onEvent({ event: { type: ev.type === "session.created" ? "session.created" : "session.updated", properties: { info: info2 } } }).catch(() => {});
            }
          }
        } catch {}
      })();
      const liveFacts = async () => {
        const link = await loginSource.current().catch(() => null);
        const newest = watcher?.snapshot(base)?.newest;
        const key = (k) => watcher ? liveKey(k, { newest, link, now: Date.now() }) : { on: false, why: "watcher_off" };
        return { picker: key(LIVE_PICKER), generation: lp.generations.get(normalisedBase(base)) ?? 0, busy: busy.count() };
      };
      let restartCommand = false;
      let cancelRestart = null;
      extra.push(() => {
        cancelRestart?.();
      });
      const folder = ensureSkillFolder(cacheDir, options.build);
      const scan = findPersonalSkill(SKILL_NAME, { env, directory: ctx.location.directory, exclude: skillsRoot(cacheDir) });
      if (folder && !scan.found && scan.complete) {
        await track(ctx.skill.transform(contained("skill transform", (e) => {
          e.add({
            id: SKILL_NAME,
            name: SKILL_NAME,
            description: "Check this laptop's Enpal AI Gateway setup for OpenCode and explain differences.",
            path: join20(folder, "SKILL.md"),
            content: skillBody(SKILL_MD)
          });
        })));
      }
      last.skill = {
        skill_folder: folder,
        skill_added: !!folder && !scan.found && scan.complete,
        personal_skill_clash: scan.found,
        personal_command_clash: false,
        command_added: false,
        login_command_added: false,
        news_command_added: false,
        scan_complete: scan.complete,
        verify_note: VERIFY_NOTE
      };
      await track(ctx.tool.transform(contained("tool transform", (e) => {
        e.add({
          name: "enpal_setup",
          description: "Enpal AI Gateway setup facts for this laptop, read-only. Never returns a token or another provider's key. Call it with no arguments.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { codemode: false },
          execute: async () => {
            let login = null;
            try {
              const connection = await ctx.integration.connection.active(PROVIDER_ID);
              const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
              if (credential?.type === "oauth")
                login = { source: "file", record: { type: "oauth", access: credential.access, refresh: credential.refresh, expires: credential.expires } };
            } catch {}
            const facts = assembleFacts({
              base,
              options,
              cacheDir,
              env,
              startup: h.startup,
              login,
              last,
              line: V2_LINE,
              opencodeVersion: ctx.app.version,
              disabled: diag.facts()
            });
            return { content: JSON.stringify({ ...facts, ...lockFacts(rules, held.lock?.effects ?? null, ctx.app?.version ?? "unknown"), live: await liveFacts(), restart_command: restartCommand ? `/${RESTART_COMMAND}` : null }, null, 2) };
          }
        });
      })));
      doctorReady = true;
      let restartNotices = 0;
      if (typeof ctx.command?.transform === "function") {
        try {
          await track(ctx.command.transform(contained("restart command transform", (e) => {
            e.add({ name: RESTART_COMMAND, description: RESTART_DESCRIPTION, execute: async () => {
              if (disposed)
                return;
              const failed2 = (message) => notices.queue([{ id: `restart-failed:${Date.now()}:${++restartNotices}`, ephemeral: true, variant: "warning", title: "Enpal AI Gateway", message }]);
              const replaced = "Another OpenCode background service has taken over from this one. Close this window and open it again to load the new build.";
              const verdict = restartService(options.restartSys ?? defaultRestartSys(ctx.app?.channel), log, {
                alive: () => !disposed,
                onFailure: (reason2) => failed2(/took the registration over/.test(reason2) ? replaced : "Couldn't restart the OpenCode background service. Run `opencode service restart` in a terminal, or restart your computer, to load the new build.")
              });
              log(`restart: /${RESTART_COMMAND} ${verdict.ok ? "accepted" : `declined (${verdict.why})`}`);
              if (verdict.ok)
                cancelRestart = verdict.cancel;
              else if (verdict.why === "already")
                failed2("A restart of the OpenCode background service is already under way.");
              else if (verdict.why === "not_registered")
                failed2(replaced);
              else if (verdict.why === "registration_unknown")
                failed2("Couldn't confirm that this is OpenCode's registered background service, so nothing was restarted. Run `opencode service restart` in a terminal, or restart your computer, to load the new build.");
              else if (verdict.why === "dev_runtime")
                failed2("This OpenCode runs from source (bun or node), so `/enpal-restart` leaves it alone. Restart it yourself to load the new build.");
              else
                failed2("This OpenCode runs its own server. Quit it and start it again to load the new build.");
            } });
          })));
          restartCommand = true;
        } catch (e) {
          log(`restart: /${RESTART_COMMAND} not registered (${e?.message ?? e})`);
        }
      }
      const state = () => ({
        build: options.build ?? "legacy",
        why: options.why ?? "builtin",
        line: "v2",
        loader_version: options.loaderVersion ?? 0,
        descriptor: options.descriptor ?? null,
        notes_url: options.notesUrl ?? null,
        notices: batches(notices.pending())
      });
      const local = registerLocalService(cacheDir);
      extra.push(local.dispose);
      const handlers = {
        loginStatus: async () => ({ signedIn: !!await hostLogin(ctx).catch(() => null), pid: process.pid, proof: local.proof, base }),
        loginChanged: async () => {
          const clearForBase = (map2) => {
            if (map2)
              for (const key of [...map2.keys()]) {
                try {
                  if (JSON.parse(key)[0] === normalisedBase(base))
                    map2.delete(key);
                } catch {}
              }
          };
          clearForBase(processState().unsaved);
          clearForBase(processState().successors);
          lastLink = await loginSource.current().catch(() => lastLink);
          if (!watcher) {
            const next = await runStartup({
              base,
              options: { ...options, signal: AbortSignal.timeout(5000) },
              cacheDir,
              store,
              persist: async () => {},
              clientId: options.clientId,
              env,
              fetch: deps().fetch,
              login: await hostLogin(ctx).catch(() => null),
              silentRefresh: false,
              log
            });
            if (next.features.kind === "answer" && next.features.fresh)
              await applyHolder(composeHolder(next, h.policy, { moduleUrl: options.moduleUrl, log }), "login", true);
            return {};
          }
          await watcher.replaceAccount(base);
          await watcher.runCheck(base, "picker");
          await refreshRows("login", true);
          return {};
        },
        state: async () => state(),
        shown: async (input) => {
          const id = isRecord7(input) && typeof input.id === "string" ? input.id : null;
          for (const one of idsOf(id ?? ""))
            notices.shown(one);
          return {};
        }
      };
      await track(ctx.rpc.register(BRIDGE, handlers));
      if (typeof ctx.command?.transform === "function") {
        const commands = sessionCommands(ctx, { ...options, env }, () => !disposed, handlers.loginChanged, async () => !!await hostLogin(ctx));
        extra.push(commands.dispose);
        await track(ctx.command.transform(contained("session commands transform", (editor) => {
          last.skill = { ...last.skill, command_added: false, login_command_added: false };
          for (const definition of commands.definitions) {
            editor.add(definition);
            if (definition.name === SKILL_NAME)
              last.skill.command_added = true;
            if (definition.name === "enpal-login")
              last.skill.login_command_added = true;
          }
        })));
      }
      busy.reattach(directory2, (sessionID) => ctx.session.wait({ sessionID }), () => !disposed);
      if (watcher)
        refreshRows("setup");
      log(`enpal-gateway v2 part ready build=${options.build ?? "legacy"} why=${options.why ?? "builtin"}`);
      return dispose;
    } catch (e) {
      if (minimum) {
        minimum.effects.missing.add("setup remainder");
        minimum.effects.failures++;
        minimum.effects.lastFailure = String(e?.message ?? e);
        log(`enpal-gateway minimum result: hosted guards retained; setup remainder failed (${minimum.effects.lastFailure})`);
        if (!doctorReady) {
          try {
            await track(ctx.tool.transform(contained("minimum doctor transform", (editor) => editor.add({
              name: "enpal_setup",
              description: "Enpal plugin policy and incomplete setup facts, read-only.",
              input: { type: "object", properties: {}, additionalProperties: false },
              options: { codemode: false },
              execute: async () => ({ content: JSON.stringify({
                build: options.build ?? "legacy",
                incomplete: true,
                ...lockFacts(rules, minimum.effects, ctx.app?.version)
              }, null, 2) })
            }))));
          } catch {
            log("minimum doctor unavailable; hosted guards retained");
          }
        }
        return dispose;
      }
      await dispose();
      throw e;
    }
  };
}
function require_home() {
  return process.env.HOME || process.env.USERPROFILE || "/";
}
// ../../cost-routing/proxy/store/opencode.json
var opencode_default = {
  $schema: "https://opencode.ai/config.json",
  model: "enpal-gateway/deepseek-v4-flash",
  enabled_providers: ["enpal-gateway", "anthropic"],
  models_policy: {
    schema: 1,
    revision: 1,
    restore_enpal: true,
    hosted: { providers: ["opencode", "opencode-go"], destinations: [{ host: "opencode.ai", path: "/zen" }] },
    default_model: "enpal-gateway/medium",
    notice: "Only Enpal's EU gateway is approved for company and customer data. Other providers are your own responsibility (AI course)."
  },
  mcp: {
    websearch: { type: "remote", url: "https://mcp.exa.ai/mcp", enabled: true }
  },
  permission: { webfetch: "allow" },
  tools: { webfetch: true },
  provider: {
    "enpal-gateway": {
      npm: "@ai-sdk/openai-compatible",
      name: "Enpal AI Gateway",
      options: {
        baseURL: "https://api.core.enpal.io/ai/aep/gateway/v1",
        headers: { "X-Data-Class": "internal" }
      },
      models: {
        medium: { name: "medium (Qwen3-235B)", limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        low: { name: "low (Qwen3-30B)", limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "claude-opus-5": { release_date: "2026-02-03", name: "Claude Opus 5", reasoning: true, limit: { context: 1e6, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" }, max: { reasoningEffort: "max" } } },
        "claude-haiku-4-5": { release_date: "2026-02-01", name: "Claude Haiku 4.5", reasoning: true, limit: { context: 200000, output: 64000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" }, max: { reasoningEffort: "max" } } },
        "claude-sonnet-5": { release_date: "2026-02-02", name: "Claude Sonnet 5", reasoning: true, limit: { context: 1e6, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" }, max: { reasoningEffort: "max" } } },
        "claude-haiku-5-5": { release_date: "2026-02-04", name: "Claude Haiku 5.5", reasoning: true, limit: { context: 1e6, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" }, max: { reasoningEffort: "max" } } },
        "gpt-5-codex": { name: "Codex (GPT-5.5)", reasoning: true, limit: { context: 400000, output: 128000 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } },
        "gpt-5.6-sol": { release_date: "2026-05-03", name: "GPT-5.6 Sol", reasoning: true, limit: { context: 1050000, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } },
        "gpt-5.6-terra": { release_date: "2026-05-02", name: "GPT-5.6 Terra", reasoning: true, limit: { context: 1050000, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } },
        "gpt-5.6-luna": { release_date: "2026-05-01", name: "GPT-5.6 Luna", reasoning: true, limit: { context: 1050000, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } },
        "gpt-6-luna": { release_date: "2026-05-04", name: "GPT-6 Luna", reasoning: true, limit: { context: 1050000, output: 128000 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } },
        "glm-5.3-flash-lyceum": { name: "GLM-5.3 Flash - Lyceum · Reasoning", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } } },
        "qwen3.8": { release_date: "2026-08-27", name: "Qwen3.8", reasoning: true, limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gemini-3.8-flash": { release_date: "2026-08-23", name: "Gemini 3.8 Flash", reasoning: true, limit: { context: 1048576, output: 65535 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "qwen3-next-80b-thinking": { name: "Qwen3-Next-80B-A3B-Thinking", reasoning: true, limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "nemotron-ultra-253b": { name: "Llama-3.1-Nemotron-Ultra-253B · Reasoning", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "nemotron-nano-30b": { name: "Nemotron-3-Nano-30B · Reasoning", reasoning: true, limit: { context: 131072, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "hermes-4-405b": { name: "Hermes-4-405B · Reasoning", reasoning: true, limit: { context: 131072, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "hermes-4-70b": { name: "Hermes-4-70B", limit: { context: 131072, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "llama-3.3-70b": { name: "Llama-3.3-70B-Instruct", limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gpt-oss-120b": { name: "gpt-oss-120b · Reasoning", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.1": { name: "GLM 5.1 · Reasoning", reasoning: true, limit: { context: 200000, output: 98304 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gemma-3-27b": { name: "Gemma-3-27b-it", limit: { context: 131072, output: 8192 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gpt-oss-120b-foundry": { name: "gpt-oss-120b (Azure Foundry) · Reasoning", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gpt-oss-120b-aep": { name: "gpt-oss-120b · Reasoning", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "phi-4-mini-foundry": { name: "Phi-4-mini (Azure Foundry)", limit: { context: 128000, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "phi-4-foundry": { name: "Phi-4 (Azure Foundry)", limit: { context: 16384, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-flash-foundry": { name: "DeepSeek-V4-Flash (Azure Foundry)", limit: { context: 163840, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "llama-4-maverick-foundry": { name: "Llama-4-Maverick-17B (Azure Foundry)", limit: { context: 131072, output: 32768 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v3.2-foundry": { name: "DeepSeek-V3.2 (Azure Foundry)", limit: { context: 163840, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "llama-3.3-70b-foundry": { name: "Llama-3.3-70B-Instruct (Azure Foundry)", limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k3": { release_date: "2026-08-26", name: "Kimi K3", reasoning: true, limit: { context: 524288, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k2.7-code": { name: "Kimi K2.7 Code · Reasoning", reasoning: true, limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "minimax-m3": { release_date: "2026-08-25", name: "MiniMax M3", reasoning: true, limit: { context: 1e6, output: 32768 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } } },
        "deepseek-v4.1-flash": { release_date: "2026-08-31", name: "DeepSeek V4.1 Flash", reasoning: true, limit: { context: 1048576, output: 393216 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-flash": { release_date: "2026-08-30", name: "DeepSeek V4 Flash", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-pro": { release_date: "2026-08-24", name: "DeepSeek V4 Pro", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-flash-lyceum": { name: "DeepSeek V4 Flash - Lyceum · Reasoning", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } } },
        "deepseek-v4-pro-lyceum": { name: "DeepSeek V4 Pro - legacy id · Reasoning", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "qwen3.5-9b": { name: "Qwen3.5 9B · Reasoning", reasoning: true, limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "cosmos3-super-reasoner": { name: "Cosmos3 Super Reasoner", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "qwen2.5-vl-72b": { name: "Qwen2.5-VL-72B", limit: { context: 32768, output: 8192 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k3-nebius": { name: "Kimi K3 - Nebius EU", reasoning: true, limit: { context: 524288, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gpt-oss-120b-nebius": { name: "gpt-oss-120b - Nebius EU", reasoning: true, limit: { context: 131072, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.1-nebius": { name: "GLM-5.1 - Nebius EU", reasoning: true, limit: { context: 200000, output: 98304 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "qwen2.5-vl-72b-nebius": { name: "Qwen2.5-VL-72B - Nebius EU", limit: { context: 32768, output: 8192 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-flash-nebius": { name: "DeepSeek V4 Flash - Nebius US", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-pro-nebius": { name: "DeepSeek V4 Pro - Nebius UK", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.2-nebius": { name: "GLM-5.2 - Nebius UK", reasoning: true, limit: { context: 1048576, output: 98304 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.3-flash-openrouter": { name: "GLM-5.3 Flash - OpenRouter", reasoning: true, limit: { context: 1048576, output: 32768 }, attachment: true, modalities: { input: ["text", "pdf"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.3-flash": { release_date: "2026-08-29", name: "GLM-5.3 Flash", reasoning: true, limit: { context: 1048576, output: 32768 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.3": { release_date: "2026-08-28", name: "GLM-5.3", reasoning: true, limit: { context: 524288, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } } },
        "glm-5.3-flash-requesty": { name: "GLM-5.3 Flash - Requesty", reasoning: true, limit: { context: 1048576, output: 32768 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.3-requesty": { name: "GLM-5.3 - Requesty", reasoning: true, limit: { context: 1048576, output: 65535 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gemini-3.7-flash-requesty": { name: "Gemini 3.7 Flash - Requesty", reasoning: true, limit: { context: 1048576, output: 65535 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "gemini-3.8-flash-requesty": { name: "Gemini 3.8 Flash - Requesty", reasoning: true, limit: { context: 1048576, output: 65535 }, attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "grok-4.6-requesty": { name: "Grok 4.6 - Requesty", reasoning: true, limit: { context: 500000, output: 32768 }, attachment: true, modalities: { input: ["text", "image"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-pro-requesty": { name: "DeepSeek V4 Pro - Requesty", limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "deepseek-v4-flash-requesty": { name: "DeepSeek V4 Flash - Requesty", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k3-requesty": { name: "Kimi K3 - Requesty", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "glm-5.2-requesty": { name: "GLM-5.2 - Requesty", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "minimax-m3-requesty": { name: "MiniMax M3 - Requesty", reasoning: true, limit: { context: 1048576, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k2.7-code-requesty": { name: "Kimi K2.7 Code - Requesty", reasoning: true, limit: { context: 256000, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "qwen3.8-requesty": { name: "Qwen3.8 - Requesty", reasoning: true, limit: { context: 262144, output: 32768 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "kimi-k3-openrouter": { name: "Kimi K3 - OpenRouter", reasoning: true, limit: { context: 524288, output: 32768 }, attachment: true, modalities: { input: ["text", "pdf"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } },
        "nemotron-3-nano-omni": { name: "Nemotron 3 Nano Omni · Reasoning", reasoning: true, limit: { context: 131072, output: 16384 }, modalities: { input: ["text"], output: ["text"] }, variants: { low: { temperature: 0.2 }, medium: { temperature: 0.5 }, high: { temperature: 0.8 }, max: { temperature: 1 } } }
      }
    }
  }
};
// release/features.json
var features_default = {
  auto: {
    picker_rows: {
      auto: {
        name: "Enpal Auto",
        release_date: "2026-09-01",
        limit: { context: 1048576, output: 32768 },
        modalities: { input: ["text"], output: ["text"] },
        headers: { "X-Enpal-Auto": "1" }
      }
    }
  }
};

// src/build/snapshot.ts
function catalogSnapshot(opencodeJson, features) {
  const cfg = opencodeJson;
  const models = cfg?.provider?.["enpal-gateway"]?.models;
  if (typeof models !== "object" || models === null || Array.isArray(models))
    throw new Error("release: store/opencode.json has no enpal-gateway models");
  const enabled = Array.isArray(cfg?.enabled_providers) && cfg.enabled_providers.every((p) => typeof p === "string" && p) ? [...cfg.enabled_providers] : [];
  if (typeof features !== "object" || features === null || Array.isArray(features))
    throw new Error("release: features.json is not an object");
  for (const [key, f] of Object.entries(features)) {
    const rows = f && typeof f === "object" ? f.picker_rows : undefined;
    if (rows && typeof rows === "object")
      for (const id of Object.keys(rows)) {
        if (Object.prototype.hasOwnProperty.call(models, id))
          throw new Error(`release: ${id} is owned by the feature ${key} and is an official model too`);
      }
  }
  return {
    schema: SCHEMA,
    models,
    enabled_providers: enabled,
    features
  };
}

// src/loader/builtin-catalog.ts
var builtinCatalog = catalogSnapshot(opencode_default, features_default);

// src/loader/loader.ts
import { appendFileSync, existsSync as existsSync4, mkdirSync as mkdirSync9, readFileSync as readFileSync17, statSync as statSync14, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join22 } from "node:path";
import { pathToFileURL } from "node:url";

// src/loader/hosted-floor.ts
function registerHostedFloor(ctx, base, log) {
  const c = ctx;
  if (typeof c?.session?.hook !== "function")
    return null;
  let state = base ? modelsPolicyState(base) : {
    policy: BUILTIN_MODELS_POLICY,
    digest: modelsPolicyDigest(BUILTIN_MODELS_POLICY),
    source: "builtin",
    status: "accepted"
  };
  let disposed = false;
  const owned = new Set;
  const note2 = (message) => {
    try {
      log?.(message);
    } catch {}
  };
  const release = async (r) => {
    if (!owned.delete(r))
      return;
    try {
      await r.dispose();
    } catch {}
  };
  const add = (name15, register) => {
    try {
      return Promise.resolve(register()).then(async (r) => {
        if (!r || typeof r.dispose !== "function")
          throw new Error("no registration handle");
        owned.add(r);
        if (disposed)
          await release(r);
      }).catch((e) => note2(`hosted floor ${name15} registration unavailable: ${e?.message ?? e}`));
    } catch (e) {
      note2(`hosted floor ${name15} registration unavailable: ${e?.message ?? e}`);
      return Promise.resolve();
    }
  };
  const guard = (message) => {
    if (message)
      throw new Error(message);
  };
  const inherited = (model) => model && typeof model === "object" ? model : {};
  const pending = [
    add("model.request", () => c.session.hook("model.request", (r) => guard(modelRequestRefusal(state, r, inherited(r.model))))),
    add("http.request", () => c.session.hook("http.request", (r) => guard(destinationAllowed(state, r.model.providerID, r.request.url) ? null : refusalText(state, r.model.providerID)))),
    add("ws.handshake", () => c.session.hook("experimental.ws.handshake", (r) => guard(destinationAllowed(state, r.model.providerID, r.url) ? null : refusalText(state, r.model.providerID))))
  ];
  if (typeof c.aisdk?.hook === "function")
    for (const name15 of ["sdk", "language"]) {
      pending.push(add(`aisdk.${name15}`, () => c.aisdk.hook(name15, (e) => guard(aisdkRefusal(state, e, inherited(e.model))))));
    }
  else
    note2("hosted floor aisdk hooks unavailable; native/cached Generate remains uncovered");
  return {
    ready: Promise.all(pending).then(() => {}),
    bind: (value) => {
      state = modelsPolicyState(value);
    },
    dispose: async () => {
      disposed = true;
      for (const r of [...owned].reverse())
        await release(r);
    }
  };
}
// src/loader/readiness.ts
import { closeSync, constants, fstatSync, lstatSync, mkdirSync as mkdirSync8, openSync, readFileSync as readFileSync16, readdirSync as readdirSync2, unlinkSync as unlinkSync4 } from "node:fs";
import { join as join21 } from "node:path";
var STATUS_SCHEMA = 1;
var STATUS_MAX = 256 * 1024;
var STATUS_REWRITE_MS = 60000;
var OLD_MS = 86400000;
var KEY3 = Symbol.for("enpal.gateway.loader.readiness.v1");
var versionOf = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
function registry2(root, deps) {
  const now = deps.now ?? Date.now;
  const processStartedAt = deps.processStartedAt ?? Math.round(Date.now() - process.uptime() * 1000);
  const owners = new Map;
  const current = new Map;
  let generation = 0, loader = 0;
  const path = join21(root, `service-${process.pid}.json`);
  const machineFacts = (m) => ({
    policy_file: {
      path: m.path,
      state: m.state,
      ...m.state === "invalid" ? { reason: m.reason } : {}
    },
    machine_max: m.state === "set" ? [...m.providers] : null,
    base: m.state === "set" ? m.base : null
  });
  const snapshot = () => {
    const active = [...owners.values()];
    const loaders = [...new Set(active.map((o) => o.loader))].map((id) => {
      const own = active.filter((o) => o.loader === id), first2 = own[0];
      const tested = own.map((o) => o.location?.host_tested ?? null), modes = own.map((o) => o.location?.mode ?? null);
      return {
        id,
        loader: first2.loaderVersion,
        ...machineFacts(first2.machine),
        host_tested: tested.every((t) => t === tested[0]) ? tested[0] : null,
        mode: modes.every((m) => m === modes[0]) ? modes[0] : null
      };
    });
    const facts = active.map((o) => JSON.stringify({
      loader: o.loaderVersion,
      ...machineFacts(o.machine),
      opencode: o.version,
      tested: o.location?.host_tested ?? null,
      mode: o.location?.mode ?? null
    }));
    const conflict = facts.some((f) => f !== facts[0]), first = active[0];
    const locations = Object.fromEntries([...current].flatMap(([directory2, g]) => {
      const row = owners.get(g)?.location;
      return row ? [[directory2, { ...row }]] : [];
    }));
    return {
      schema: STATUS_SCHEMA,
      pid: process.pid,
      process_started_at: processStartedAt,
      written_at: now(),
      conflict,
      opencode: !conflict && first ? first.version : null,
      loader: !conflict && first ? first.loaderVersion : null,
      policy_file: !conflict && first ? machineFacts(first.machine).policy_file : null,
      machine_max: !conflict && first ? machineFacts(first.machine).machine_max : null,
      base: !conflict && first ? machineFacts(first.machine).base : null,
      host_tested: !conflict && first ? first.location?.host_tested ?? null : null,
      mode: !conflict && first ? first.location?.mode ?? null : null,
      loaders,
      locations
    };
  };
  const clean = () => {
    for (const name15 of readdirSync2(root).slice(0, 128)) {
      const match = /^service-([1-9][0-9]*)\.json$/.exec(name15);
      if (!match || Number(match[1]) === process.pid)
        continue;
      const file2 = join21(root, name15);
      let fd;
      try {
        const st = lstatSync(file2);
        if (!st.isFile() || st.isSymbolicLink() || st.size > STATUS_MAX || now() - st.mtimeMs < OLD_MS)
          continue;
        fd = openSync(file2, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const actual = fstatSync(fd);
        if (!actual.isFile() || actual.size > STATUS_MAX || actual.ino !== st.ino || actual.dev !== st.dev)
          continue;
        const raw = JSON.parse(readFileSync16(fd, "utf8"));
        if (raw.schema !== STATUS_SCHEMA || raw.pid !== Number(match[1]) || typeof raw.written_at !== "number" || !Number.isFinite(raw.written_at) || now() - raw.written_at < OLD_MS || typeof raw.process_started_at !== "number" || !Number.isFinite(raw.process_started_at) || !Array.isArray(raw.loaders) || !raw.locations || typeof raw.locations !== "object" || Array.isArray(raw.locations))
          continue;
        const last = lstatSync(file2);
        if (last.isFile() && !last.isSymbolicLink() && last.ino === st.ino && last.dev === st.dev)
          unlinkSync4(file2);
      } catch {} finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {}
        }
      }
    }
  };
  const publish = () => {
    try {
      if (owners.size > 256 || current.size > 256)
        return;
      if (!Number.isFinite(now()) || !Number.isFinite(processStartedAt) || processStartedAt <= 0)
        return;
      const data = Buffer.from(JSON.stringify(snapshot()));
      if (data.length > STATUS_MAX)
        return;
      mkdirSync8(root, { recursive: true });
      const st = lstatSync(root);
      if (!st.isDirectory() || st.isSymbolicLink())
        return;
      try {
        if (lstatSync(path).isSymbolicLink())
          return;
      } catch {}
      (deps.write ?? writeAtomically)(path, data);
      try {
        clean();
      } catch {}
    } catch {}
  };
  const arm = deps.setTimer ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return timer;
  });
  try {
    arm(publish, STATUS_REWRITE_MS);
  } catch {}
  return { owners, current, now, path, publish, nextGeneration: () => ++generation, nextLoader: () => `loader-${++loader}` };
}
var registries2 = () => {
  const g = globalThis;
  return g[KEY3] ??= new Map;
};
function createReadiness(root, machine, loaderVersion, deps = {}) {
  let r = null, loaderId = null;
  const begin = (directory2, version2) => {
    try {
      if (typeof directory2 !== "string" || !directory2 || directory2.length > 4096 || !Number.isInteger(loaderVersion))
        return null;
      r ??= registries2().get(root) ?? (() => {
        const fresh = registry2(root, deps);
        registries2().set(root, fresh);
        return fresh;
      })();
      loaderId ??= r.nextLoader();
      const owner = { directory: directory2, generation: r.nextGeneration(), loader: loaderId, machine, version: versionOf(version2), loaderVersion, location: null };
      r.owners.set(owner.generation, owner);
      r.current.set(directory2, owner.generation);
      return owner;
    } catch {
      return null;
    }
  };
  const update = (owner, state, detail = {}) => {
    try {
      if (!owner || !r || !r.owners.has(owner.generation) || r.current.get(owner.directory) !== owner.generation)
        return;
      const prior = owner.location;
      owner.location = {
        loader: owner.loader,
        generation: owner.generation,
        state,
        build: detail.build ?? prior?.build ?? null,
        why: detail.why ?? prior?.why ?? null,
        opencode: owner.version,
        host_tested: detail.hostPolicy ? !!owner.version && detail.hostPolicy.testedHosts.includes(owner.version) : prior?.host_tested ?? null,
        mode: detail.hostPolicy?.mode ?? prior?.mode ?? null,
        updated_at: r.now(),
        ...detail.blocked_reason ? { blocked_reason: detail.blocked_reason } : {}
      };
      r.publish();
    } catch {}
  };
  const remove = (owner) => {
    try {
      if (!owner || !r)
        return;
      r.owners.delete(owner.generation);
      if (r.current.get(owner.directory) === owner.generation)
        r.current.delete(owner.directory);
      r.publish();
    } catch {}
  };
  const beginContext = (ctx) => {
    try {
      const host = ctx;
      return begin(host?.location?.directory, host?.app?.version);
    } catch {
      return null;
    }
  };
  return { begin, beginContext, update, remove };
}

// src/loader/loader.ts
var LOADER_VERSION = 3;
var DEFAULT_BUDGET_MS = 2000;
var FIRST_DOWNLOAD_BUDGET_MS = 1e4;
var LINE_HEADER = "X-Enpal-Plugin-Line";
var METADATA_MAX = 256 * 1024;
var LOG_MAX = 256 * 1024;
var LOADER_HEADER = "X-Enpal-Loader";
var SETTLED = Symbol.for("enpal.gateway.loader.resolution.settled");
var isRecord8 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function readMetadata(path) {
  try {
    if (statSync14(path).size > METADATA_MAX)
      return null;
    return JSON.parse(readFileSync17(path, "utf8"));
  } catch {
    return null;
  }
}
function fileLogger(dir, env = process.env) {
  const path = join22(dir, "loader.log");
  return (line) => {
    try {
      mkdirSync9(dir, { recursive: true });
      try {
        if (statSync14(path).size > LOG_MAX)
          writeFileSync7(path, "");
      } catch {}
      appendFileSync(path, `${new Date().toISOString()} ${line}
`);
    } catch {}
    if (env.ENPAL_GATEWAY_LOADER_LOG) {
      try {
        process.stderr.write(`[enpal-gateway] ${line}
`);
      } catch {}
    }
  };
}
var V2_SURFACE = [
  ["integration", "transform"],
  ["provider", "transform"],
  ["model", "transform"],
  ["session", "hook"],
  ["tool", "transform"],
  ["skill", "transform"],
  ["event", "subscribe"],
  ["rpc", "register"]
];
function missingV2Surface(ctx) {
  const c = ctx;
  if (!c || typeof c !== "object")
    return V2_SURFACE.map(([d, n]) => `${d}.${n}`);
  return V2_SURFACE.filter(([d, n]) => typeof c[d]?.[n] !== "function").map(([d, n]) => `${d}.${n}`);
}
function createLoader(config2) {
  const base = config2.base;
  assertSecureEndpoint(base);
  const baseUrl = new URL(base);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    throw new Error("base_shape");
  const { deps } = config2;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const firstBudgetMs = deps.firstDownloadBudgetMs ?? FIRST_DOWNLOAD_BUDGET_MS;
  const dir = join22(deps.cacheRoot, baseKey(base));
  const log = (line) => {
    try {
      deps.log?.(line);
    } catch {}
  };
  const instance = Symbol("enpal-gateway-loader");
  const facts = createReadiness(deps.statusRoot ?? join22(deps.cacheRoot, "..", "status"), { state: "absent", path: "" }, LOADER_VERSION, { now: deps.now, ...deps.readiness });
  const storeUrl = (name15) => storeUrlFor(base, name15);
  const cache = { dir, base, fetch: (input, init) => deps.fetch(input, init), log };
  const ensureDir = () => {
    mkdirSync9(dir, { recursive: true });
  };
  const readPointer = async (line, signal) => {
    const res = await deps.fetch(storeUrl(POINTER_NAME), {
      signal,
      redirect: "error",
      headers: { Accept: "application/json", [LINE_HEADER]: line, [LOADER_HEADER]: String(LOADER_VERSION) }
    });
    if (!res.ok)
      throw new Error(`pointer_http_${res.status}`);
    const raw = await readBounded(res, POINTER_MAX);
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (!isRecord8(body) || body.schema !== SCHEMA || !isRecord8(body.release))
      throw new Error("pointer_shape");
    try {
      ensureDir();
      prepareModelsPolicy({ base, cacheDir: dir, policy: body.policy, log, line, loaderVersion: LOADER_VERSION }, body.policy);
      writeAtomically(join22(dir, "pointer.json"), raw);
    } catch {}
    return body;
  };
  const ensureFiles = (descriptor, roles, signal) => ensureBuildFiles(cache, descriptor, roles, signal);
  const verifiedImport = async (descriptor, role) => {
    const entry = descriptor.files[role];
    const path = join22(dir, "builds", descriptor.build, entry.name);
    if (!fileMatches(entry, readFileSync17(path)))
      throw new Error(`verify_${role}`);
    const mod = await deps.importModule(pathToFileURL(path).href);
    const factory = mod?.default;
    if (typeof factory !== "function")
      throw new Error("build_shape");
    return factory;
  };
  const lastGoodPath = (line) => join22(dir, `last-good-${line}.json`);
  const readLastGood = (line) => {
    const raw = readMetadata(lastGoodPath(line));
    if (!raw)
      return null;
    const v = validateDescriptor(raw.descriptor, typeof raw.build === "string" ? raw.build : undefined);
    if (!v.ok || v.descriptor.min_loader > LOADER_VERSION)
      return null;
    for (const role of ROLES_FOR_LINE[line]) {
      const entry = v.descriptor.files[role];
      try {
        if (!fileMatches(entry, readFileSync17(join22(dir, "builds", v.descriptor.build, entry.name))))
          return null;
      } catch {
        return null;
      }
    }
    return { build: v.descriptor.build, descriptor: v.descriptor };
  };
  const withDeadline = (ms) => {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(new Error("deadline")), ms);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  };
  const backgroundDownloads = new Set;
  const resolve5 = async (line) => {
    const started2 = deps.now();
    const lastGoodCandidate = () => {
      const last2 = readLastGood(line);
      return last2 ? {
        build: last2.build,
        why: "last_good",
        descriptor: last2.descriptor,
        load: () => verifiedImport(last2.descriptor, line === "v1" ? "v1" : "v2")
      } : null;
    };
    const nothing = (firstDeadlineAt2 = null) => ({ approved: null, lastGood: lastGoodCandidate(), policy: savedPolicy(), off: false, unreachable: true, firstDeadlineAt: firstDeadlineAt2 });
    const pointer = withDeadline(budgetMs);
    let body;
    try {
      body = await readPointer(line, pointer.signal);
    } catch (e) {
      log(`pointer: unreachable (${e?.message ?? e})`);
      return nothing();
    } finally {
      pointer.clear();
    }
    const release = body.release;
    const policy = prepareModelsPolicy({ base, cacheDir: dir, policy: body.policy, log, line, loaderVersion: LOADER_VERSION }, body.policy).policy;
    if (release.build === null)
      return { approved: null, lastGood: null, policy, off: true, unreachable: false, firstDeadlineAt: null };
    if (release.status !== undefined || typeof release.build !== "string") {
      log(`pointer: release ${String(release.status ?? "malformed")}`);
      return nothing();
    }
    const v = validateDescriptor(release.descriptor, release.build);
    if (!v.ok) {
      log(`pointer: descriptor refused (${v.errors.join("; ")})`);
      return nothing();
    }
    const descriptor = v.descriptor;
    if (descriptor.min_loader > LOADER_VERSION) {
      log(`build=${descriptor.build} needs loader ${descriptor.min_loader}, this is ${LOADER_VERSION}`);
      return nothing();
    }
    const roles = ROLES_FOR_LINE[line];
    const buildDir = join22(dir, "builds", descriptor.build);
    const cold = roles.some((r) => !existsSync4(join22(buildDir, descriptor.files[r].name)));
    let first = false;
    if (cold) {
      try {
        ensureDir();
        writeFileSync7(join22(dir, `.attempted-${descriptor.build}-${line}`), "", { flag: "wx" });
        first = true;
      } catch {
        first = false;
      }
    }
    const firstDeadlineAt = first ? started2 + firstBudgetMs : null;
    const files = withDeadline(Math.max(0, (first ? firstBudgetMs : budgetMs) - (deps.now() - started2)));
    try {
      await ensureFiles(descriptor, roles, files.signal);
    } catch (e) {
      log(`build=${descriptor.build} files not ready (${e?.message ?? e})`);
      const key = `${descriptor.build}|${line}`;
      if (files.signal.aborted && !first && !backgroundDownloads.has(key)) {
        backgroundDownloads.add(key);
        const background = withDeadline(firstBudgetMs);
        ensureFiles(descriptor, roles, background.signal).catch(() => {}).finally(() => {
          background.clear();
          backgroundDownloads.delete(key);
        });
      }
      return { ...nothing(firstDeadlineAt), policy };
    } finally {
      files.clear();
    }
    const approved = {
      build: descriptor.build,
      why: "approved",
      descriptor,
      load: () => verifiedImport(descriptor, line === "v1" ? "v1" : "v2")
    };
    const last = lastGoodCandidate();
    return { approved, lastGood: last && last.build !== approved.build ? last : null, policy, off: false, unreachable: false, firstDeadlineAt };
  };
  const readPolicy = (raw) => readReleasePolicy(raw, log);
  const savedPolicy = () => {
    const snapshot = prepareModelsPolicy({ base, cacheDir: dir, log, line: "v2", loaderVersion: LOADER_VERSION });
    if (Object.values(snapshot.sections).some((s) => s === "valid" || s === "held"))
      return snapshot.policy;
    for (const name15 of ["policy.json", "pointer.json"]) {
      const saved = readMetadata(join22(dir, name15));
      const policy = saved ? readPolicy(saved.policy) : null;
      if (policy)
        return policy;
    }
    return null;
  };
  const resolution = (line) => {
    const picks = processState().picks;
    const key = JSON.stringify([normalisedBase(base), line, LOADER_VERSION]);
    const existing = picks.get(key);
    if (existing)
      return existing;
    const promise2 = resolve5(line);
    promise2.finally(() => {
      promise2[SETTLED] = true;
    }).catch(() => {});
    picks.set(key, promise2);
    return promise2;
  };
  const builtinCandidate = () => ({ build: config2.builtinBuild, why: "builtin", load: async () => config2.builtin });
  const candidates = async (line) => {
    const r = await resolution(line);
    if (r.chosen)
      return r.chosen.why === "builtin" ? [r.chosen] : [r.chosen, builtinCandidate()];
    const out = [];
    if (r.approved)
      out.push(r.approved);
    if (!r.off && r.lastGood)
      out.push(r.lastGood);
    out.push(builtinCandidate());
    return out;
  };
  const optionsFor = (c, line, deadlineAt, policy, approved) => {
    const remaining = Math.max(0, deadlineAt - deps.now());
    const catalog = c.descriptor ? join22(dir, "builds", c.build, c.descriptor.files.catalog.name) : undefined;
    let notesUrl;
    if (c.descriptor) {
      try {
        notesUrl = storeUrl(c.descriptor.files.notes.name);
      } catch {
        notesUrl = undefined;
      }
    }
    return {
      base,
      build: c.build,
      line,
      loaderVersion: LOADER_VERSION,
      why: c.why,
      approved,
      log: deps.log,
      clientId: config2.clientId,
      signal: AbortSignal.timeout(remaining),
      deadlineAt,
      policy,
      cacheDir: dir,
      catalogPath: catalog,
      catalog: c.why === "builtin" ? config2.builtinCatalog : undefined,
      notesUrl,
      descriptor: c.descriptor
    };
  };
  const started = (c, line) => {
    try {
      ensureDir();
      if (c.why === "approved" && c.descriptor) {
        writeAtomically(lastGoodPath(line), Buffer.from(JSON.stringify({ build: c.build, descriptor: c.descriptor, at: deps.now() })));
      }
      writeAtomically(join22(dir, "last-start.json"), Buffer.from(JSON.stringify({ build: c.build, why: c.why, line, loader: LOADER_VERSION, at: deps.now() })));
    } catch {}
    log(`enpal-gateway build=${c.build} why=${c.why} line=${line}`);
  };
  const start = async (line, init) => {
    const startedAt = deps.now();
    const pending = resolution(line);
    const joined = !pending[SETTLED];
    const r = await pending;
    const deadlineAt = joined ? Math.max(startedAt + budgetMs, r.firstDeadlineAt ?? 0) : startedAt + budgetMs;
    let lastError = new Error("no build");
    for (const c of await candidates(line)) {
      try {
        const factory = await c.load();
        const parts = factory(optionsFor(c, line, deadlineAt, r.policy, r.approved?.build ?? null));
        if (parts.providerLock !== 4)
          throw new Error("build lacks hosted-policy marker 4");
        const result = await init(parts, c);
        r.chosen ??= c;
        started(c, line);
        return result;
      } catch (e) {
        lastError = e;
        log(`enpal-gateway build=${c.build} why=${c.why} failed: ${e?.message ?? e}`);
        if (c.why === "builtin")
          break;
      }
    }
    throw lastError;
  };
  return {
    dir,
    resolution,
    candidates,
    server: async (input, options) => {
      const directory2 = typeof input?.directory === "string" ? input.directory : "";
      const state = processState();
      const claims = state.claims ??= new Map;
      if (directory2) {
        const owner = claims.get(directory2);
        if (owner !== undefined && owner !== instance) {
          log("enpal-gateway inert: another loader already serves this directory");
          return {};
        }
        claims.set(directory2, instance);
      }
      try {
        return await start("v1", async (parts) => {
          if (!parts.server)
            throw new Error("build has no v1 part");
          return parts.server(input, options);
        });
      } catch (e) {
        if (directory2 && claims.get(directory2) === instance)
          claims.delete(directory2);
        throw e;
      }
    },
    setup: async (ctx, suppliedFloor) => {
      const floor = suppliedFloor ?? registerHostedFloor(ctx, base, log);
      if (floor) {
        await floor.ready;
        floor.bind(base);
        prepareModelsPolicy({ base, cacheDir: dir, log, line: "v2", loaderVersion: LOADER_VERSION });
      }
      const missing = missingV2Surface(ctx);
      const owner = facts.beginContext(ctx);
      if (missing.length) {
        facts.remove(owner);
        if (floor) {
          log(`hosted floor retained without a 2.x build: missing ${missing.join(", ")}`);
          return () => floor.dispose();
        }
        log("enpal-gateway 2.x part idle: this host has no 2.x plugin API (the 1.18 part serves it)");
        return;
      }
      try {
        const cleanup = await start("v2", async (parts, c) => {
          if (!parts.setup)
            throw new Error("build has no v2 part");
          const result = await parts.setup(ctx);
          facts.update(owner, "ready", { build: c.build, why: c.why });
          return result;
        });
        return async () => {
          facts.update(owner, "stopping");
          try {
            await cleanup?.();
          } finally {
            await floor?.dispose();
            facts.remove(owner);
          }
        };
      } catch (e) {
        facts.remove(owner);
        if (!floor)
          throw e;
        log(`hosted floor retained without a build: ${e?.message ?? e}`);
        return () => floor.dispose();
      }
    },
    release: (directory2) => {
      const claims = processState().claims;
      if (claims?.get(directory2) === instance)
        claims.delete(directory2);
    }
  };
}

// src/loader/entry.ts
var builtin = (options) => {
  rememberBase(options.base);
  return { ...entry_v1_default(options), providerLock: 4, setup: createSetup({ ...options, moduleUrl: import.meta.url }) };
};
var loader = null;
function get() {
  if (!loader) {
    const cacheRoot = join23(homedir9(), ".enpal", "gateway", "plugins");
    const base = resolveBase();
    loader = createLoader({
      base,
      builtin,
      builtinBuild: PLUGIN_BUILD,
      builtinCatalog,
      clientId: process.env.ENPAL_GATEWAY_CLIENT_ID || undefined,
      deps: {
        fetch: (input, init) => fetch(input, init),
        importModule: (url2) => import(url2),
        now: () => Date.now(),
        cacheRoot,
        log: fileLogger(join23(cacheRoot, baseKey(base)))
      }
    });
  }
  return loader;
}
var entry_default = {
  id: "enpal-gateway",
  version: LOADER_VERSION,
  server: (input, options) => get().server(input, options),
  setup: async (ctx) => {
    const floor = registerHostedFloor(ctx, undefined, (line) => {
      try {
        process.stderr.write(`[enpal-gateway] ${line}
`);
      } catch {}
    });
    if (!floor)
      return;
    await floor.ready;
    try {
      return await get().setup(ctx, floor);
    } catch (e) {
      try {
        process.stderr.write(`[enpal-gateway] hosted floor retained: ${e?.message ?? e}
`);
      } catch {}
      return () => floor.dispose();
    }
  }
};
export {
  entry_default as default,
  createEnpalProvider
};
