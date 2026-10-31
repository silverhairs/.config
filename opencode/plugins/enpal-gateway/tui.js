// src/loader/entry-ui-tui.ts
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";

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
var PLUGIN_BUILD = "2026-10-20.1";
var DEFAULT_MODEL = `${PROVIDER_ID}/medium`;

// src/build/state.ts
import { createHash } from "node:crypto";
var KEY = Symbol.for("enpal.gateway.plugin.state.v1");
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
function baseKey(base) {
  const n = normalisedBase(base);
  const slug = n.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${slug || "gateway"}-${createHash("sha256").update(n).digest("hex").slice(0, 8)}`;
}

// src/build/http.ts
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

// src/base.ts
var DEFAULT_BASE = "https://api.core.enpal.io/ai/aep/gateway";
function resolveBase(env = process.env) {
  const raw = env.ENPAL_GATEWAY_BASE ?? DEFAULT_BASE;
  if (raw.startsWith("__ENPAL_")) {
    throw new Error("unsubstituted_gateway_base: this bundle was not served by the gateway store, so it carries no " + "default host. Set ENPAL_GATEWAY_BASE, or fetch the bundle from <gateway>/store/.");
  }
  return raw.replace(/\/+$/, "");
}

// src/build/bridge.ts
import { createHash as createHash2, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var BRIDGE_ID = "enpal-gateway-bridge";
var object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: true });
var BRIDGE = {
  id: BRIDGE_ID,
  methods: {
    state: { input: object(), output: object({ build: { type: "string" }, why: { type: "string" } }, ["build", "why"]) },
    shown: { input: object({ id: { type: "string" } }, ["id"]), output: object() },
    loginStatus: { input: object(), output: object() },
    loginChanged: { input: object(), output: object() }
  },
  events: {}
};
var WITNESS = Symbol.for("enpal.gateway.plugin.local-service.v1");
function isLocalService(dir, pid, proof) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9a-f]{64}$/.test(proof))
    return false;
  try {
    const path = join(dir, `local-service-${pid}`);
    return statSync(path).size === 64 && createHash2("sha256").update(readFileSync(path)).digest("hex") === proof;
  } catch {
    return false;
  }
}

// src/build/v2-ui.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/build/picker.ts
var MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);
var MODEL_STATUSES = new Set(["alpha", "beta", "deprecated", "active"]);
var RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
var PICKER_FILE_MAX = 512 * 1024;

// src/build/features.ts
var FEATURES_BODY_MAX = 256 * 1024;
var FEATURES_FILE_MAX = 256 * 1024;
var RESERVED_IDS2 = new Set(["__proto__", "constructor", "prototype"]);
var LIVE_PICKER = "live-picker";
var LIVE_BUILDS = "live-builds";
var LIVE_KEYS = new Set([LIVE_PICKER, LIVE_BUILDS]);
var BUILD_EFFECT_KEYS = new Set(["auto", ...LIVE_KEYS]);

// src/build/notices.ts
var TOAST_MS = 20000;

// src/build/v2-ui.ts
var LOGIN_COMMAND_ID = "enpal.login";
var LOGIN_DEADLINE_MS = 10 * 60000;
function createUi(options) {
  const log = (m) => {
    try {
      options.log?.(m);
    } catch {}
  };
  return async (ctx) => {
    const bridge = ctx.client.rpc(BRIDGE);
    const location = ctx.location ?? ctx.data.location.default();
    const seen = new Set;
    let disposed = false;
    const uiAbort = new AbortController;
    let loginFlight = null;
    let commandOwned = false;
    const browser = options.browserSys ?? defaultBrowserSys();
    const toast = (message, variant = "info") => {
      if (!disposed)
        ctx.ui.toast.show({ title: "Enpal sign-in", message, variant });
    };
    const login = (input) => {
      if (disposed || !commandOwned)
        return Promise.resolve();
      return loginFlight ??= (async () => {
        let attemptID = null;
        const oauth = ctx.client.integration?.oauth;
        const deadline = AbortSignal.timeout(options.loginDeadlineMs ?? LOGIN_DEADLINE_MS);
        const signal = AbortSignal.any([deadline, uiAbort.signal]);
        try {
          const status = await untilAborted(bridge.loginStatus({}, { location }), signal);
          if (status.signedIn && !String(input ?? "").split(/\s+/).includes("--relogin")) {
            toast("Already signed in. Use /enpal-login --relogin to change accounts.");
            return;
          }
          const base = new URL(status.base ?? options.base);
          if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
            throw new Error("untrusted gateway base");
          if (!isLocalService(options.localCacheDir ?? join2(homedir(), ".enpal", "gateway", "plugins", baseKey(base.href)), status.pid, status.proof)) {
            toast("Sign in from OpenCode on the machine running its service.", "warning");
            return;
          }
          if (!oauth || browser.canOpenBrowser?.() === false) {
            toast("This session cannot open a browser for sign-in.", "warning");
            return;
          }
          const attempt = (await untilAborted(oauth.connect({ integrationID: "enpal-gateway", methodID: "oauth", label: "Enpal AI Gateway", location }, { signal }), signal)).data;
          attemptID = attempt.attemptID;
          const url = new URL(attempt.url);
          if (url.origin !== base.origin || url.pathname !== `${base.pathname.replace(/\/$/, "")}/oauth/authorize`)
            throw new Error("untrusted authorize URL");
          openBrowser(attempt.url, browser);
          const until = Date.now() + (options.loginDeadlineMs ?? LOGIN_DEADLINE_MS);
          while (!disposed && Date.now() < until) {
            const result = (await untilAborted(oauth.status({ integrationID: "enpal-gateway", attemptID, location }, { signal }), signal)).data;
            if (result.status === "complete") {
              attemptID = null;
              const refreshSignal = AbortSignal.any([AbortSignal.timeout(Math.min(options.loginDeadlineMs ?? 5000, 5000)), uiAbort.signal]);
              try {
                await untilAborted(bridge.loginChanged({}, { location }), refreshSignal);
                toast("Signed in.", "success");
              } catch {
                toast("Signed in. Your picker refresh is still pending.", "warning");
              }
              return;
            }
            if (result.status !== "pending")
              throw new Error("sign-in did not complete");
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          toast("Sign-in timed out. Run /enpal-login to try again.", "warning");
        } catch {
          if (!disposed)
            toast(deadline.aborted ? "Sign-in timed out. Run /enpal-login to try again." : "Sign-in did not finish. Run /enpal-login to try again.", "warning");
        } finally {
          if (attemptID && oauth) {
            const cancelSignal = AbortSignal.timeout(5000);
            await untilAborted(oauth.cancel({ integrationID: "enpal-gateway", attemptID, location }, { signal: cancelSignal }), cancelSignal).catch(() => {});
          }
          loginFlight = null;
        }
      })();
    };
    const serverRuns = () => {
      try {
        const at = ctx.location;
        return ctx.data.location.command?.list(at)?.some((c) => c.name === "enpal-login") === true && ctx.data.location.model?.list(at)?.some((m) => m.providerID === "enpal-gateway") === true;
      } catch {
        return false;
      }
    };
    let unmount;
    let aside;
    const stepAside = () => {
      if (disposed)
        return;
      let taken = false;
      let why = "a command of the person's own has that name";
      try {
        taken = !!ctx.keymap?.commands().some((c) => c.id !== LOGIN_COMMAND_ID && (c.slash?.name === "enpal-login" || c.slash?.aliases?.includes("enpal-login") === true));
      } catch (e) {
        taken = true;
        why = `the command list could not be read (${e?.message ?? e})`;
      }
      commandOwned = !taken;
      if (!taken || !unmount)
        return;
      log(`ui: /enpal-login left alone: ${why}`);
      const drop = unmount;
      unmount = undefined;
      drop();
    };
    unmount = ctx.ui.slot?.({ append: "app", render: () => {
      ctx.keymap?.layer(() => ({ mode: "global", commands: [{
        id: LOGIN_COMMAND_ID,
        title: "Sign in to Enpal AI Gateway",
        palette: true,
        run: login,
        ...serverRuns() ? {} : { slash: { name: "enpal-login", arguments: true } }
      }] }));
      clearTimeout(aside);
      aside = setTimeout(stepAside, 0);
      return null;
    } });
    let pulling = null;
    const pull = () => pulling ??= (async () => {
      try {
        let state;
        try {
          state = await bridge.state({}, { location });
        } catch (e) {
          log(`ui: no server part to ask (${e?.message ?? e})`);
          return null;
        }
        for (const n of state.notices) {
          if (disposed)
            break;
          if (seen.has(n.id))
            continue;
          try {
            ctx.ui.toast.show({ title: n.title, message: n.message, variant: n.variant ?? "info", duration: n.duration ?? TOAST_MS });
          } catch {
            continue;
          }
          seen.add(n.id);
          try {
            await bridge.shown({ id: n.id }, { location });
          } catch {}
        }
        return state;
      } finally {
        pulling = null;
      }
    })();
    const first = await pull();
    if (first)
      log(`ui: server runs build=${first.build} why=${first.why}`);
    const settle = setTimeout(() => {
      if (!disposed)
        pull();
    }, options.settleMs ?? 5000);
    const poll = setInterval(() => {
      if (!disposed)
        pull();
    }, options.pollMs ?? 30000);
    return () => {
      disposed = true;
      uiAbort.abort();
      clearTimeout(aside);
      unmount?.();
      clearTimeout(settle);
      clearInterval(poll);
    };
  };
}

// src/build/entry-v2-ui.ts
var build = (options) => ({ setup: createUi(options) });
var entry_v2_ui_default = build;

// src/loader/loader.ts
import { appendFileSync, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";

// src/loader/descriptor.ts
import { createHash as createHash3 } from "node:crypto";
var SCHEMA = 1;
var BUILD_RE = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;
var FILE_RE = /^enpal-plugin-(\d{4}-\d{2}-\d{2}\.\d{1,3})-(v1|v2|v2-ui|skill|catalog|notes)\.(js|md|json)$/;
var CAPABILITY_RE = /^[a-z][a-z0-9-]{0,31}$/;
var DESCRIPTOR_MAX = 64 * 1024;
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
  return createHash3("sha256").update(data).digest("hex");
}
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isInt = (v) => typeof v === "number" && Number.isInteger(v);
function validateDescriptor(obj, expectedBuild) {
  const errors = [];
  if (!isRecord(obj))
    return { ok: false, errors: ["descriptor is not an object"] };
  if (obj.schema !== SCHEMA)
    errors.push(`schema is not ${SCHEMA}`);
  const build2 = typeof obj.build === "string" && BUILD_RE.test(obj.build) ? obj.build : "";
  if (!build2)
    errors.push("build id is malformed");
  else if (expectedBuild !== undefined && build2 !== expectedBuild)
    errors.push(`build ${build2} is not ${expectedBuild}`);
  if (!isInt(obj.min_loader) || obj.min_loader < 1)
    errors.push("min_loader must be a positive integer");
  const caps = obj.capabilities;
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string" && CAPABILITY_RE.test(c))) {
    errors.push("capabilities must be a list of names");
  } else if (new Set(caps).size !== caps.length) {
    errors.push("a capability repeats");
  }
  const files = obj.files;
  if (!isRecord(files))
    return { ok: false, errors: [...errors, "files must be an object"] };
  for (const role of Object.keys(files))
    if (!(role in ROLES))
      errors.push(`unknown file role ${role}`);
  for (const role of ROLE_NAMES)
    if (!(role in files))
      errors.push(`missing file role ${role}`);
  const seen = new Set;
  for (const role of ROLE_NAMES) {
    const entry = files[role];
    if (!isRecord(entry)) {
      if (role in files)
        errors.push(`${role}: not an object`);
      continue;
    }
    const { name, sha256, size } = entry;
    const m = typeof name === "string" ? FILE_RE.exec(name) : null;
    if (!m || m[1] !== build2 || m[2] !== role || m[3] !== ROLES[role].ext) {
      errors.push(`${role}: name is not enpal-plugin-${build2}-${role}.${ROLES[role].ext}`);
    } else if (seen.has(name)) {
      errors.push(`${role}: name repeats`);
    } else {
      seen.add(name);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
      errors.push(`${role}: sha256 is not 64 hex characters`);
    if (!isInt(size) || size < 1 || size > ROLES[role].max)
      errors.push(`${role}: size must be 1..${ROLES[role].max}`);
  }
  for (const key of Object.keys(obj)) {
    if (!["schema", "build", "min_loader", "capabilities", "files"].includes(key))
      errors.push(`unknown key ${key}`);
  }
  if (errors.length)
    return { ok: false, errors };
  return { ok: true, descriptor: obj };
}
function fileMatches(entry, data) {
  return data.byteLength === entry.size && sha256Hex(data) === entry.sha256;
}

// src/loader/cache.ts
var POINTER_MAX = DESCRIPTOR_MAX + 64 * 1024;

// src/build/models-policy.ts
function freezePolicy(p) {
  return Object.freeze({ ...p, hosted: Object.freeze({
    providers: Object.freeze([...p.hosted.providers]),
    destinations: Object.freeze(p.hosted.destinations.map((d) => Object.freeze({ ...d })))
  }) });
}
var BUILTIN_MODELS_POLICY = freezePolicy({
  schema: 1,
  revision: 0,
  restore_enpal: true,
  hosted: { providers: ["opencode", "opencode-go"], destinations: [{ host: "opencode.ai", path: "/zen" }] },
  default_model: DEFAULT_MODEL,
  notice: "Only Enpal's EU gateway is approved for company and customer data. Other providers are your own responsibility (AI course)."
});
var POLICY_SNAPSHOT_MAX = 64 * 1024;
var RULES = Symbol.for("enpal.gateway.models-policy.v1");

// src/build/policy-bootstrap.ts
var POINTER_MAX2 = 256 * 1024;
// src/build/provider-lock.ts
var TESTED_HOSTS = Object.freeze([]);
// src/loader/readiness.ts
var STATUS_MAX = 256 * 1024;
var KEY2 = Symbol.for("enpal.gateway.loader.readiness.v1");

// src/loader/loader.ts
var LOADER_VERSION = 3;
var METADATA_MAX = 256 * 1024;
var LOG_MAX = 256 * 1024;
var SETTLED = Symbol.for("enpal.gateway.loader.resolution.settled");
function fileLogger(dir, env = process.env) {
  const path = join3(dir, "loader.log");
  return (line) => {
    try {
      mkdirSync2(dir, { recursive: true });
      try {
        if (statSync2(path).size > LOG_MAX)
          writeFileSync2(path, "");
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

// src/loader/ui.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { pathToFileURL } from "node:url";
function createUiLoader(config) {
  const base = config.base.replace(/\/+$/, "");
  const log = (line) => {
    try {
      config.log?.(line);
    } catch {}
  };
  const optionsFor = (build2, why, state) => ({
    base,
    build: build2,
    line: "v2",
    loaderVersion: LOADER_VERSION,
    why,
    log: config.log,
    cacheDir: config.dir,
    notesUrl: state?.notes_url ?? undefined,
    descriptor: state?.descriptor ?? undefined
  });
  const runBuiltin = async (ctx, state, reason) => {
    log(`ui: built-in part (${reason})`);
    const parts = config.builtin(optionsFor(config.builtinBuild, "builtin", state));
    if (!parts.setup)
      throw new Error("built-in build has no ui part");
    return parts.setup(ctx);
  };
  return {
    setup: async (ctx) => {
      let state;
      try {
        state = await ctx.client.rpc(BRIDGE).state({}, { location: ctx.location ?? ctx.data.location.default() });
      } catch (e) {
        return runBuiltin(ctx, null, `no server part: ${e?.message ?? e}`);
      }
      if (state.why === "builtin" || !state.descriptor)
        return runBuiltin(ctx, state, `server runs ${state.build} (${state.why})`);
      const v = validateDescriptor(state.descriptor, state.build);
      if (!v.ok)
        return runBuiltin(ctx, state, `descriptor refused: ${v.errors.join("; ")}`);
      if (v.descriptor.min_loader > LOADER_VERSION)
        return runBuiltin(ctx, state, `build needs loader ${v.descriptor.min_loader}, this is ${LOADER_VERSION}`);
      const entry = v.descriptor.files["v2-ui"];
      const path = join4(config.dir, "builds", state.build, entry.name);
      try {
        if (!fileMatches(entry, readFileSync3(path)))
          throw new Error("verify_v2-ui");
        const mod = await config.importModule(pathToFileURL(path).href);
        if (typeof mod?.default !== "function")
          throw new Error("build_shape");
        const parts = mod.default(optionsFor(state.build, state.why, state));
        if (!parts.setup)
          throw new Error("build has no ui part");
        log(`ui: build=${state.build} why=${state.why}`);
        return await parts.setup(ctx);
      } catch (e) {
        return runBuiltin(ctx, state, `${state.build} failed: ${e?.message ?? e}`);
      }
    }
  };
}

// src/loader/entry-ui-tui.ts
var loader = null;
function get() {
  if (!loader) {
    const base = resolveBase();
    const dir = join5(homedir2(), ".enpal", "gateway", "plugins", baseKey(base));
    loader = createUiLoader({ base, builtin: entry_v2_ui_default, builtinBuild: PLUGIN_BUILD, dir, importModule: (url) => import(url), log: fileLogger(dir) });
  }
  return loader;
}
var entry_ui_tui_default = {
  id: "enpal-gateway-ui",
  setup: (ctx) => get().setup(ctx)
};
export {
  entry_ui_tui_default as default
};
