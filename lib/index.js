//#region lib/index.js
/**
 * DeepSeek account balance, host half.
 *
 * One job: answer `GET /api/balance` with the account's balance snapshot, so the
 * browser never holds the API key. It registers one exact Fetch route in the
 * connection shell's registry and publishes no Service — nothing outside a
 * browser reads a balance, so there is no name to collide with a host-owned one.
 *
 * The route handler performs NO authentication of its own, deliberately.
 * `ConnectionFetchRoute.fetch` is defined as handling "one request after the
 * physical carrier has applied its trust and authentication policy"
 * (`@deepseek-ai/dsh-client-connection/lib/types/rpc.d.ts:91`); the shell's
 * `/api` prefix route applies the Host/Origin fence and the browser cookie
 * before it dispatches any exact route (`lib/index.js:767-781`). Repeating that
 * check here would duplicate the fence, not strengthen it. Measured: an
 * unauthenticated `GET /api/balance` is answered 401 by the shell, before this
 * handler is reached.
 *
 * The credential resolves through the `credentials` seam per request, from a
 * reference NAME, so a rotated key reaches the next request without a restart
 * and no secret value enters the composition file, the served bundle, or the
 * response body.
 *
 * ## Why this module imports nothing
 *
 * It has no static `import` on purpose, and the reason is a deployment fact
 * rather than a style choice. pnpm links this package into a profile as
 * `node_modules/dsh-account-balance -> …\.agent-presets\dsh-smith\plugins\dsh-account-balance`,
 * and `--preserve-symlinks` is OFF, so any bare specifier inside this file
 * resolves from the link's REAL path — a directory outside every `node_modules`.
 * Measured: `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`.
 * Two consequences, both handled here:
 *
 *   * The credential reference is validated by this module's own copy of the
 *     seam's name grammar, instead of importing `credentialRef`. Avoid the
 *     temptation to "fix" this by importing it: that import cannot resolve.
 *   * {@link Config} is a hand-written
 *     [Standard Schema](https://github.com/standard-schema/standard-schema)
 *     object rather than a `@deepseek-ai/schemastery` schema. Cordis needs
 *     exactly one thing from a plugin's `Config` —
 *     `runtime.Config["~standard"].validate(config)`
 *     (`@deepseek-ai/cordis/lib/index.js:955-961`) — so this satisfies the
 *     loader, keeps the row self-contained, and still reports a bad field as
 *     `$.<field> …` at load time, the same class of message a schema would.
 *
 * @module dsh-account-balance
 */

/** Upstream path appended to `baseURL`; the documented balance endpoint. */
const BALANCE_PATH = '/user/balance';
/** Marks a response that must never be reused: balance freshness is the point. */
const NO_STORE = 'no-store';
/** Inclusive bounds the config is validated against. */
const MAX_SECONDS = 86400;
const MAX_TIMEOUT_MS = 120000;
/** Maximum upstream body text echoed into a diagnostic. */
const EXCERPT_LIMIT = 200;
/** Longest a failed upstream read may be remembered, however the config is set. */
const MIN_FAILURE_TTL_MS = 2000;
/** The seam's reference-name grammar, copied from `credentialRef`'s implementation. */
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The seam's exported `credentialRef` inlined; see the module header. */
const credentialRef = (value) => value;

/** Cordis plugin name; keeps the loader row legible in diagnostics. */
export const name = 'dsh-account-balance';

/**
 * Required services: the connection shell, whose Fetch-route registry this
 * plugin registers into.
 *
 * `connection` is a HARD dependency, matching the shipped `/api` route owners
 * (`@deepseek-ai/dsh-client-ui-deliverables/lib/index.js` and
 * `@deepseek-ai/dsh-session-log-export/lib/index.js` both declare it). The
 * alternative — `ctx.get('connection')` with an absence check — was tried and
 * MEASURED WRONG: at the instant a root-tree plugin's `apply` runs, the
 * service is not yet provided, so the guard always took the absent path. The
 * row would mount, reach the client boot graph, and quietly serve no route.
 */
export const inject = ['connection'];

/**
 * Read one config field with a default, into a target object.
 * @param target - object being assembled.
 * @param raw - raw config object, when the row supplied one.
 * @param field - field name.
 * @param fallback - value used when the row omits the field.
 * @returns nothing; mutates `target`.
 */
function take(target, raw, field, fallback) {
  const value = raw === undefined || raw === null ? undefined : raw[field];
  target[field] = value === undefined ? fallback : value;
}

/**
 * Validate one non-negative integer field.
 * @param issues - issue list to append to.
 * @param value - candidate value.
 * @param field - field name.
 * @param max - inclusive upper bound.
 */
function checkInteger(issues, value, field, max) {
  if (issues.some((issue) => issue.path[0] === field)) return;
  if (!Number.isInteger(value)) issues.push({ message: `$.${field} expected an integer but got ${typeof value}`, path: [field] });
  else if (value < 0 || value > max) issues.push({ message: `$.${field} expected an integer from 0 through ${String(max)} but got ${String(value)}`, path: [field] });
}

/**
 * Validate one non-empty string field.
 * @param issues - issue list to append to.
 * @param value - candidate value.
 * @param field - field name.
 * @param pattern - optional grammar the value must also satisfy.
 */
function checkString(issues, value, field, pattern) {
  if (issues.some((issue) => issue.path[0] === field)) return;
  if (typeof value !== 'string' || value.trim() === '') issues.push({ message: `$.${field} expected a non-empty string but got ${typeof value}`, path: [field] });
  else if (pattern !== undefined && !pattern.test(value)) issues.push({ message: `$.${field} expected a credential reference name (letters, digits and underscore, not leading with a digit) but got ${JSON.stringify(value)}`, path: [field] });
}

/**
 * Config, validated by Cordis before `apply` runs.
 *
 * Field names and defaults are the peer adapter's, not invented:
 * `@deepseek-ai/dsh-llm-deepseek/lib/index.js:1885` declares
 * `apiKeyEnv: z.string().role("credential-ref").default(DEEPSEEK_API_KEY)` and
 * `baseURL: z.string()` defaulting to `https://api.deepseek.com`.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-account-balance',
    /**
     * @param raw - raw row config.
     * @returns the defaults-filled config, or the issues that rejected it.
     */
    validate(raw) {
      const source = raw === undefined || raw === null ? {} : raw;
      const value = {};
      take(value, source, 'apiKeyEnv', 'DEEPSEEK_API_KEY');
      take(value, source, 'baseURL', 'https://api.deepseek.com');
      take(value, source, 'refreshSeconds', 60);
      take(value, source, 'cacheSeconds', 30);
      take(value, source, 'timeoutMs', 8000);
      const issues = [];
      checkString(issues, value.apiKeyEnv, 'apiKeyEnv', REFERENCE_NAME);
      checkString(issues, value.baseURL, 'baseURL');
      checkInteger(issues, value.refreshSeconds, 'refreshSeconds', MAX_SECONDS);
      checkInteger(issues, value.cacheSeconds, 'cacheSeconds', MAX_SECONDS);
      checkInteger(issues, value.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
      return issues.length === 0 ? { value } : { issues };
    },
  },
};

/**
 * Normalize the validated config into the frozen shape `apply` uses.
 *
 * {@link Config} already ran the loader's validation pass; this is the same
 * contract for a composition that mounts the plugin without it (a dynamic
 * package, a test), and it is what strips the `baseURL` trailing slash.
 * @param raw - config as supplied by the loader.
 * @returns the frozen options.
 * @throws {Error} when a field is malformed.
 */
export function normalize(raw = {}) {
  const config = raw === null || raw === undefined ? {} : raw;
  const apiKeyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const baseURL = config.baseURL ?? 'https://api.deepseek.com';
  const refreshSeconds = config.refreshSeconds ?? 60;
  const cacheSeconds = config.cacheSeconds ?? 30;
  const timeoutMs = config.timeoutMs ?? 8000;
  const issues = [];
  checkString(issues, apiKeyEnv, 'apiKeyEnv', REFERENCE_NAME);
  checkString(issues, baseURL, 'baseURL');
  checkInteger(issues, refreshSeconds, 'refreshSeconds', MAX_SECONDS);
  checkInteger(issues, cacheSeconds, 'cacheSeconds', MAX_SECONDS);
  checkInteger(issues, timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
  if (issues.length > 0) throw new Error(`dsh-account-balance: ${issues.map((issue) => issue.message).join('; ')}`);
  return Object.freeze({
    apiKeyEnv,
    baseURL: baseURL.replace(/\/+$/, ''),
    refreshSeconds,
    cacheSeconds,
    timeoutMs,
  });
}

/**
 * Read the balance payload DeepSeek returns, keeping only the scalar fields the
 * badge renders. The upstream shape is `is_available` plus `balance_infos[]` of
 * `{currency, total_balance, granted_balance, topped_up_balance}`, every amount
 * a string.
 * @param body - parsed JSON response body.
 * @returns whether the account may call the API, and one entry per currency.
 */
function readBalanceBody(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  return {
    isAvailable: body?.is_available === true,
    balances: infos.map((info) => ({
      currency: typeof info?.currency === 'string' ? info.currency : '',
      total: typeof info?.total_balance === 'string' ? info.total_balance : '',
      granted: typeof info?.granted_balance === 'string' ? info.granted_balance : '',
      toppedUp: typeof info?.topped_up_balance === 'string' ? info.topped_up_balance : '',
    })),
  };
}

/**
 * Build one fetch that gives up after `ms`, without depending on
 * `AbortSignal.any`/`AbortSignal.timeout` being present in this Node.
 * @param ms - budget in milliseconds.
 * @returns a signal and the function releasing its timer.
 */
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, ms);
  return { signal: controller.signal, done: () => { clearTimeout(timer); } };
}

/**
 * Render one JSON response that is never cached.
 * @param payload - JSON-serializable response body.
 * @param status - HTTP status code.
 * @returns the response the Fetch route returns.
 */
function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  });
}

/** Read a diagnostic string from an unknown rejection. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Trim an upstream body to a bounded, single-line diagnostic. */
function excerpt(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT)}…` : flat;
}

/**
 * One route failure with the status code and stable code the handler reports.
 * Classification happens at the throw site so the handler stays a two-branch
 * ledger.
 */
class BalanceRouteError extends Error {
  /**
   * @param code - stable machine-readable reason.
   * @param message - operator-facing correction hint; never carries the secret.
   */
  constructor(code, message) {
    super(message);
    this.name = 'BalanceRouteError';
    this.code = code;
  }

  /** HTTP status the route answers for this failure class. */
  get status() {
    switch (this.code) {
      case 'missing-credential':
        return 401;
      case 'upstream-timeout':
        return 504;
      default:
        return 502;
    }
  }
}

/**
 * TTL cache with single-flight healing.
 *
 * The route is polled every `refreshSeconds` and the browser may hold several
 * tabs, so this bounds the upstream request rate without making a page wait on a
 * request another page already issued. A resolved FAILURE is cached only
 * briefly: it must start working the moment someone stores a credential, and it
 * must never be remembered indefinitely.
 *
 * `current()` resolves to the SNAPSHOT, never to the cache entry that holds it.
 * That distinction is the whole reason this function exists in one place: an
 * earlier version returned the entry, and the route still answered 200 with the
 * amount missing instead of failing — a wrong answer is worse than an error.
 * @param load - produces the fresh snapshot.
 * @param ttlMs - how long one resolved snapshot stays fresh.
 * @param failureTtlMs - how long one rejected snapshot stays cached.
 * @returns an async `current()` resolving to the live snapshot, or rejecting with the cached failure.
 */
function createCachedSnapshot(load, ttlMs, failureTtlMs) {
  let snapshot;
  let pending;
  return async function current() {
    if (snapshot !== undefined && Date.now() - snapshot.at < snapshot.ttl) return unwrap(snapshot);
    if (pending === undefined) {
      pending = load().then(
        (value) => {
          snapshot = { ttl: ttlMs, at: Date.now(), ok: true, value };
          return snapshot;
        },
        (error) => {
          snapshot = { ttl: failureTtlMs, at: Date.now(), ok: false, error };
          return snapshot;
        },
      ).finally(() => { pending = undefined; });
    }
    return unwrap(await pending);
  };
}

/**
 * @param entry - one settled cache entry.
 * @returns its value, or rethrows its failure.
 * @throws the cached rejection, unchanged.
 */
function unwrap(entry) {
  if (entry.ok) return entry.value;
  throw entry;
}

/**
 * Host plugin body: normalize the config, resolve the two services it uses
 * optionally, and register the exact Fetch route.
 *
 * Neither `credentials` nor `connection` is a hard dependency. A host without
 * them cannot serve this route at all, and failing the whole boot over a missing
 * badge would be a strictly worse trade.
 * @param ctx - host root context.
 * @param rawConfig - row config from the loader.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalize(rawConfig);
  const credentials = ctx.get('credentials');
  // Declared as a hard dependency (`inject` below), so this is provided here.
  // It is NOT optional: measured, a root-tree row applies BEFORE `connection`
  // exists, and the same is true of every other plugin module. Without the
  // declaration this row would mount, scan into the client graph, serve its
  // badge, and never register a route — the exact silent failure the inject
  // exists to prevent.
  const fetchRegistry = ctx.connection.fetch;

  /**
   * Resolve the API key for one request.
   * @returns the secret value.
   * @throws {BalanceRouteError} when no seam is mounted or no value is stored.
   */
  async function resolveApiKey() {
    if (credentials === undefined) {
      throw new BalanceRouteError('no-credentials-service', 'credential seam unavailable: this host composition mounts no credentials service');
    }
    let resolved;
    try {
      resolved = await credentials.resolve(credentialRef(config.apiKeyEnv));
    } catch (error) {
      throw new BalanceRouteError('invalid-credential', `credential "${config.apiKeyEnv}" could not be resolved: ${messageOf(error)}`);
    }
    if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
      throw new BalanceRouteError('missing-credential', `credential "${config.apiKeyEnv}" is not set; store it or export it before starting this profile`);
    }
    return resolved.value;
  }

  /** One upstream read, key resolution included, under the configured budget. */
  async function fetchBalance() {
    const apiKey = await resolveApiKey();
    const budget = withTimeout(config.timeoutMs);
    try {
      const response = await fetch(`${config.baseURL}${BALANCE_PATH}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: budget.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new BalanceRouteError('upstream-status', `balance endpoint answered HTTP ${String(response.status)}: ${excerpt(text)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BalanceRouteError('malformed-response', `balance endpoint did not answer JSON: ${excerpt(text)}`);
      }
      return { ...readBalanceBody(parsed), fetchedAt: Date.now() };
    } catch (error) {
      if (error instanceof BalanceRouteError) throw error;
      if (budget.signal.aborted) throw new BalanceRouteError('upstream-timeout', `balance endpoint did not answer within ${String(config.timeoutMs)}ms`);
      throw new BalanceRouteError('upstream-unreachable', `balance endpoint unreachable: ${messageOf(error)}`);
    } finally {
      budget.done();
    }
  }

  const current = createCachedSnapshot(
    fetchBalance,
    config.cacheSeconds * 1000,
    Math.max(MIN_FAILURE_TTL_MS, Math.min(config.cacheSeconds * 1000, config.refreshSeconds * 500)),
  );

  fetchRegistry.register({
    path: '/api/balance',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        const value = await current();
        return jsonResponse({
          ok: true,
          source: `${config.baseURL}${BALANCE_PATH}`,
          fetchedAt: value.fetchedAt,
          ttlMs: config.cacheSeconds * 1000,
          refreshSeconds: config.refreshSeconds,
          isAvailable: value.isAvailable,
          balances: value.balances,
        }, 200);
      } catch (error) {
        if (error instanceof BalanceRouteError) {
          ctx.logger.warn(`dsh-account-balance: ${error.code}: ${error.message}`);
          return jsonResponse({ ok: false, code: error.code, message: error.message }, error.status);
        }
        ctx.logger.error(error);
        return jsonResponse({ ok: false, code: 'internal', message: messageOf(error) }, 500);
      }
    },
  });
  ctx.logger.info(`dsh-account-balance: serving GET /api/balance from ${config.baseURL}${BALANCE_PATH} using credential ${config.apiKeyEnv}`);
}
//#endregion
