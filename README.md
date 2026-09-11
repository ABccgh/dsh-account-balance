# dsh-account-balance

A DeepSeek Harness plugin that shows your DeepSeek **account balance** in the Web GUI,
and serves it over an authenticated host route so the browser never holds the API key.

It renders a small badge at the foot of the sidebar, beside the Settings entry:

```
  ⟳ ¥12.65            wide sidebar
  ⟳                   collapsed to the 56px rail
```

Click it to refresh immediately; hover for the currency, total, granted and topped-up
amounts. It polls on its own every 60 seconds. A failed read never blanks the badge —
the last known amount stays, marked stale, and only after two consecutive failures does
it stop presenting that amount as current.

---

## How it fits together

Two halves, and the split is not arbitrary.

### Host half — `lib/index.js`

Registers **one** exact Fetch route, `GET /api/balance`, in the connection shell's route
registry. It resolves the API key per request through the harness `credentials` seam
(from a *reference name*, never a stored value) and calls the provider's documented
balance endpoint.

It publishes **no Cordis service**. Nothing outside a browser reads a balance, so there
is no name to collide with a host-owned one and no realm to place.

**The route handler does no authentication of its own, deliberately.** A route in this
registry is dispatched *after* the `/api` carrier has applied the Host/Origin fence and
the browser cookie, and that is the contract of the registration API. Repeating the check
here would duplicate the fence, not strengthen it. Measured on the deployment this was
built for: an unauthenticated `GET /api/balance` is answered **401** before this handler
is reached, and the same request **with** the cookie is answered **200**.

### Browser half — `lib/client.js`

A hand-written client-plugin bundle in the harness module-loader format. It registers a
`Pill` into the sidebar's declared `sidebar.footer.action` slot, which is the same
additive seat the built-in Cordis panel occupies.

No bundler is needed: the harness serves a client bundle as plain bytes through
`/plugins/<id>/client.js`, and the only requirements are the format, an `id` equal to the
package name, and `require()` calls limited to the platform's seed modules plus other
graph rows.

---

## Three constraints that are not obvious from the code

Each of these was measured against a real deployment, and each is the kind of thing that
looks like a style choice until it silently breaks.

### 1. The host half imports nothing, on purpose

No static `import` appears in `lib/index.js`. That is because pnpm links this package into
a profile as `node_modules/dsh-account-balance -> <this directory>`, and
`--preserve-symlinks` is off — so a bare specifier resolves from the link's **real** path,
which is outside every `node_modules`. The result is:

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

Two consequences, both handled in place:

- The credential reference is validated by this package's own copy of the seam's name
  grammar instead of importing `credentialRef`. **Do not "fix" this by adding the import**
  — that import cannot resolve.
- `Config` is a hand-written
  [Standard Schema](https://github.com/standard-schema/standard-schema) object rather than
  a schemastery schema. Cordis needs exactly one thing from a plugin's `Config` —
  `runtime.Config["~standard"].validate(config)` — so this satisfies the loader, keeps the
  row self-contained, and still reports a bad field at load time with a `$.<field>` message.

### 2. `inject: ['connection']` is load-bearing

`connection` is a **hard** dependency, matching the shipped `/api` route owners. The
alternative — `ctx.get('connection')` with an absence check — was tried and is wrong: at
the instant a root-tree plugin's `apply` runs, the service is not yet provided, so the
guard always takes its absent path. The row then mounts, reaches the client boot graph,
and quietly serves **no route at all** — a 404 with nothing logged.

### 3. The browser half talks to the host by HTTP, not through `ctx.remote`

`ctx.remote` would be the idiomatic channel, and it cannot be used here: the client's
remote capability set is fixed at build time by an assembly inside the harness, so a
plugin cannot add a namespace at runtime. An exact Fetch route on the already-authenticated
`/api` carrier is the supported way to add an endpoint, and it is what this package uses.
The client calls `fetch('/api/balance')` with `credentials: 'same-origin'`.

---

## Install

This package is **not published to npm**. It installs from a path.

```sh
# 1. Put the package somewhere the profile can link to, then register it:
dsh plugin --profile web add /absolute/path/to/dsh-account-balance

# 2. Mount it with a row in the profile's own patch layer
#    ($DSH_HOME/profiles/<profile>/cordis.patch.yml):
```

```yaml
- insert:
    - id: account-balance
      name: 'dsh-account-balance'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        refreshSeconds: 60
        cacheSeconds: 30
        timeoutMs: 8000
```

Notes that save time:

- **`insert:` is required.** A row without it is an *override* of an existing row by id; for
  an id that does not exist it logs a warning and is skipped, so the plugin never appears.
- **`name` must be the package name, not a directory.** The loader imports the row with
  Node's ESM resolver, and a directory import fails with `ERR_UNSUPPORTED_DIR_IMPORT`.
- **Restart the harness** after adding the row. The host half needs a process restart; a
  client-bundle edit afterwards can hot-reload without one.
- The API key resolves from the harness credential store or the environment. It is never
  written into a composition file and never reaches the browser.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential **reference name** resolved through the credentials seam on each request |
| `baseURL` | `https://api.deepseek.com` | Provider base; the route appends `/user/balance` |
| `refreshSeconds` | `60` | Poll period the badge uses, reported to the browser by the route |
| `cacheSeconds` | `30` | How long one upstream read is reused across requests and tabs |
| `timeoutMs` | `8000` | Per-request budget for the upstream call |

## Response shape

```json
{
  "ok": true,
  "source": "https://api.deepseek.com/user/balance",
  "fetchedAt": 1789128938178,
  "ttlMs": 30000,
  "refreshSeconds": 60,
  "isAvailable": true,
  "balances": [
    { "currency": "CNY", "total": "10.17", "granted": "0.00", "toppedUp": "10.17" }
  ]
}
```

Failures answer with the same envelope and `ok: false`, a stable `code`, and a
correction-oriented `message`; `401` for a missing credential, `504` for a timeout, `502`
otherwise. Responses are `cache-control: no-store`.

## Compatibility

Built and verified against DeepSeek Harness `0.1.5-rc.1`. The interfaces it depends on are
the connection Fetch-route registry, the Cordis `Config` contract, the module-loader client
bundle format, and the sidebar's `sidebar.footer.action` slot. These are product surfaces
and can change between releases; re-verify the mount after an upgrade rather than assuming
it still holds.

## Licence

MIT — see [LICENSE](LICENSE).
