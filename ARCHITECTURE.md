# MyClaw Architecture

This document captures the layered model MyClaw is evolving toward and
the decisions already locked in so future contributors don't have to
re-derive them.  It is NOT a description of current file-by-file layout
— the codebase is the source of truth for that.  This is the **why**
and the **direction**.

> Status marker convention:
> - ✅ shipped in current MyClaw
> - 🚧 partially in place, gaps remain
> - 📋 planned, not started

---

## 1. Product model

MyClaw is a **graphical dashboard / launcher** for AI agent runtimes.
The agent runtime itself (today: OpenClaw) is a separate Node.js
package that MyClaw spawns as a child process.  MyClaw is intentionally
a thin UX layer — it does **not** own agent logic, plugin loading, or
channel protocols.  Those belong to the runtime.

## 2. The three-layer architecture

```
┌────────────────────────────────────────────────────┐
│  UI                     (Electron renderer + main)  │  product concepts:
│  "Add channel" / "Edit provider" / "Send message"   │  backend-agnostic
└─────────────────────┬──────────────────────────────┘
                      │
┌─────────────────────▼──────────────────────────────┐
│  Claw adapter layer     (per backend implementation)│  translates product
│    OpenClawAdapter / HermesAdapter / ...            │  ops to backend-native
└─────────────────────┬──────────────────────────────┘
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
  openclaw         hermes           other
  runtime          runtime           runtime
```

- **UI layer** (✅): Electron main + React renderer.  Knows nothing
  about which backend is running under the hood.  Uses adapter-
  abstracted operations like `addChannel(type, config)`.
- **Adapter layer** (🚧): today a single implicit "OpenClaw" adapter
  exists but is not isolated behind an interface — openclaw-specific
  code (`openclaw-auth.ts`, `openclaw-proxy.ts`, `config-sync.ts`) is
  scattered across `electron/utils/` and `electron/gateway/`.  The
  refactor to an explicit `ClawAdapter` interface is planned but not
  started.
- **Runtime layer** (✅): OpenClaw runs as a child process.  Fetched
  via npm at first launch (see §5).

## 3. The MyClaw / backend boundary

Directive from product lead: **MyClaw 不改 backend 自己的安装过程和路
径；但当然要修改它的所有配置，就是一个 dashboard 替代品**.

| Category | Who owns it | Notes |
|---|---|---|
| Backend binary + `node_modules/` | Backend install logic (npm) | MyClaw invokes `npm install` but doesn't place / patch files |
| Backend plugin discovery | Backend | MyClaw doesn't copy files into the backend's extension dir |
| Backend runtime config (e.g. openclaw.json) | MyClaw (via adapter) | ✅ legitimate: dashboard writes channels / providers / proxy / etc. |
| User credentials / OAuth tokens | MyClaw | ✅ dashboard responsibility |
| User skills | MyClaw (preinstall) + backend (runtime) | ✅ MyClaw preinstalls, backend loads |
| MyClaw window state / theme / autostart | MyClaw only | Never goes into backend-native files |

**Writes INTO openclaw's "install" territory are forbidden**:
- ❌ copying plugin files to `~/.openclaw/extensions/`
- ❌ hand-editing `node_modules/openclaw/dist/...`
- ❌ passing flags to npm that change openclaw's postinstall behaviour

**Writes INTO openclaw's "configuration" territory are explicitly OK**:
- ✅ `~/.openclaw/openclaw.json` — channels, providers, proxy, port, agents
- ✅ `~/.openclaw/credentials/` — OAuth tokens
- ✅ `~/.openclaw/skills/` — user-visible installed skills (dashboard feature)

## 4. Config storage strategy

Two files, strictly disjoint responsibilities:

- **`~/.myclaw/config.json`** (or Electron userData electron-store):
  UI-only + orchestration state that the backend does not need to see.
  - window position / size / theme
  - `launch_at_startup`, `has_shown_auto_login_hint`, update preferences
  - (future) `active_instance`, `instances` list

- **Backend-native config** (e.g. `~/.openclaw/openclaw.json`):
  every field the backend actually reads at runtime.
  - channels, providers, plugins.allow, proxy, mdns, gateway.port,
    gateway.token, session.idleMinutes, etc.

**No duplication** of the same logical value in both stores.  (Current
code still duplicates some — `gatewayPort`, `proxyEnabled` — that's
a known regression to clean up; see §10.)

## 5. Fetch-at-first-launch runtime install  (✅ v1.5.0+)

The installer ships Electron + bundled Node/npm only — no openclaw
code.  On first launch the main process runs

```
<bundled-node> <bundled-npm-cli> install \
    openclaw@<pinned-version> \
    <...preinstalled-plugins> \
    --prefix ~/.myclaw/runtime \
    --no-save --package-lock=false --legacy-peer-deps --omit=dev
```

- Pinned version lives in `package.json → available_backends.openclaw.version`
- Channel plugins live in `package.json → available_backends.openclaw.preinstalled_plugins`
- A splash progress window ("Initializing your MyClaw runtime…")
  surfaces npm output while it runs (30–60s typical)
- Failure shows a dialog + quits; there is no bundled fallback

Rationale: see `feedback_runtime_naming` and the session history that
produced v1.5.0 — core motivation was eliminating the "46 missing
bundled plugin deps" bug and shrinking the installer from ~320MB to
~150MB.

## 6. Backend version pinning  (✅)

Backends use calendar versioning (`2026.4.22`) not SemVer.  MyClaw
must pin the **exact** version per release — runtime install does
string-equal version check, no range logic.  Upgrading the openclaw
version is a deliberate act: bump `available_backends.openclaw.version`
→ cut a new MyClaw release → runtime re-fetches on next launch.

## 7. Multi-backend support  (📋)

The codebase already anticipates this shape:

```json
{
  "default_backend": "openclaw",
  "available_backends": {
    "openclaw": { "version": "2026.4.22", "preinstalled_plugins": {...} },
    "hermes":   { "version": "1.2.3",    "preinstalled_plugins": {...} }
  }
}
```

Today only `openclaw` is declared.  The adapter interface does not
exist yet; all openclaw-specific code lives in named-after-openclaw
files.  Adopting a second backend requires:

1. Formalizing a `ClawAdapter` interface with at minimum:
   `fetch_runtime()`, `start_gateway(port)`, `get_native_config()`,
   `set_native_config()`, `list_supported_channels()`.
2. Extracting the existing openclaw logic behind that interface.
3. Writing the second backend's adapter.

No target date.

## 8. Multi-instance support  (📋)

Users wanting multiple isolated workspaces (work / personal, or running
multiple backends concurrently) need per-instance isolation.  **The
feasibility check has been done** — openclaw supports the necessary env
vars (researched 2026-04):

- `OPENCLAW_STATE_DIR` — overrides `~/.openclaw/` data dir
- `OPENCLAW_CONFIG_PATH` — overrides openclaw.json location
- `OPENCLAW_GATEWAY_PORT` — overrides default 18789
- `--profile <name>` — convenience wrapper for the above
- All path resolution goes through a single `resolveStateDir()` resolver
  (`dist/paths-HZHKO_Jn.js`), so env-based isolation is reliable.

Proposed layout:

```
~/.myclaw/
├─ config.json                   MyClaw-level (instance list, active, UI)
├─ runtime/
│  ├─ openclaw-2026.4.22/        dedup: one runtime per (backend × version)
│  ├─ openclaw-2026.5.0/
│  └─ hermes-1.2.3/
└─ instances/
   ├─ work/
   │  ├─ meta.json               { backend, version, name, port }
   │  ├─ data/                   <-- OPENCLAW_STATE_DIR points here
   │  │  ├─ openclaw.json
   │  │  ├─ agents/ skills/ credentials/ ...
   │  └─ logs/
   ├─ personal/
   └─ research/
```

Key design choices locked in:
- **Runtime deduplication**: two instances on the same backend×version
  share one `node_modules` tree — instances only own their data.
- **Port allocation**: `InstanceManager` assigns from a pool (starting
  18789), each instance carries its assigned port in `meta.json`.
- **Provider keys shared across instances**: one of the shared-across-
  instances concessions, stored in `~/.myclaw/shared/providers.json`.
  Channels / agents / sessions remain strictly per-instance.
- **No simultaneous backend choice inside a single instance**: one
  instance = one backend.  Multiple instances can use different
  backends.

Hermes (or any other candidate backend) is expected to expose
equivalent state-dir + port env vars.  Adopting a backend that does
not support isolation env vars is a non-starter — upstream PR first.

## 9. Directory & file layout summary

| Path | Writer | Contents |
|---|---|---|
| `<app>/package.json → available_backends.openclaw.*` | MyClaw release | pinned backend version + preinstalled plugins |
| `%APPDATA%/myclaw-desktop/config.json` | MyClaw UI | MyClaw-only state (window, theme, autostart flags) |
| `~/.myclaw/runtime/node_modules/openclaw/` | first-launch npm install | single-instance runtime (✅) |
| `~/.myclaw/runtime/<backend>-<version>/` | future multi-instance | shared runtime pool (📋) |
| `~/.myclaw/instances/<id>/data/` | future multi-instance | per-instance backend data (📋) |
| `~/.openclaw/openclaw.json` | MyClaw adapter | backend config — OK to write (it's dashboard work) |
| `~/.openclaw/credentials/` | MyClaw adapter | OAuth tokens |
| `~/.openclaw/skills/` | MyClaw adapter + backend | user-visible skill library |
| `~/.openclaw/extensions/<plugin>/` | backend only | channel plugin source — MyClaw stays out (✅ v1.5.0) |

## 10. Known tech debt

- **Dup of config fields between Electron store and openclaw.json**
  (e.g. `gatewayPort`, `proxyEnabled`).  Should collapse to single
  ownership: any field the backend reads lives in openclaw.json only;
  MyClaw UI reads/writes through the adapter.
- **Openclaw-specific file names scattered across `electron/utils/` and
  `electron/gateway/`** (`openclaw-auth.ts`, `openclaw-proxy.ts`,
  `openclaw-cli.ts`, `openclaw-workspace.ts`, `openclaw_install.ts`,
  `openclaw-doctor.ts`, `openclaw-sdk.ts`).  New code should not add
  to this list — keep future runtime-related utilities backend-neutral
  (`runtime-*.ts`) or put them behind the adapter.
- **`syncXxxToOpenClaw` functions run unconditionally every Gateway
  start.**  No schema-version awareness — an openclaw schema change
  would silently write dead fields.  Consider adding a schema probe
  on runtime update.
- **User-action `ensureXxxPluginInstalled` still copies plugin files
  into `~/.openclaw/extensions/`** even though startup path was
  removed in v1.5.0.  Under the §3 boundary this should also be
  deleted — needs confirmation from install-smoke that openclaw finds
  plugins via `node_modules` resolution without the copy.

## 11. Coupling principle: MyClaw is a dashboard, not a fork

Directive from product lead (2026-04-23): *"MyClaw 的定位就成了操纵
配置管理 openclaw，而不是在 openclaw 的代码库上做一个 openclaw
增强版"*.

MyClaw interacts with the backend through **exactly three contract
surfaces**.  Anything outside these is a coupling violation:

1. **CLI command surface** — `openclaw gateway run`, `openclaw plugins
   install <name>`, `openclaw doctor`, etc.  If we need the runtime
   to do something, we invoke its CLI.
2. **HTTP / RPC API** — gateway endpoints (`/v1/*`) for chat, plugin
   metadata, channel status, runtime health.
3. **`openclaw.json` config schema** — the openclaw-documented JSON
   format at the openclaw state dir root.  MyClaw reads it, writes it,
   and sanitises it.  This is the "dashboard" side of the job.

Everything else is the backend's internal state that MyClaw must not
touch.

### Banned practices (block in review)

- ❌ Reading backend `dist/` / `node_modules/` internal files to
  extract metadata.  Ask the backend API for that metadata.
- ❌ Hand-editing / patching backend-installed files to "fix" bugs in
  the backend's own output.  File an issue upstream and skip the
  patch — MyClaw is not the place to accumulate vendor-specific
  workarounds for vendor bugs.
- ❌ Hardcoding the backend's plugin IDs, npm package names, manifest
  schemas, or channel → plugin relationships.  Derive these at runtime
  from the backend's API or config.
- ❌ Duplicating `openclaw plugins install X` by doing our own
  `cpSync` / `npm install` / file layout logic.  If the backend has a
  CLI command for it, shell out; don't reinvent it.
- ❌ Writing into the backend's extension or plugin directories
  (see §3 for the broader install-boundary rule).
- ❌ Maintaining a compile-time list of "which plugins exist" in MyClaw
  source.  The backend knows; ask it.

### Allowed (dashboard operations)

- ✅ Reading / writing `openclaw.json` to change channels, providers,
  proxy, mdns, session settings, gateway port, gateway token, etc.
- ✅ Managing `~/.openclaw/credentials/` (user OAuth tokens).
- ✅ Pre-depositing user-facing skills into `~/.openclaw/skills/` as a
  dashboard convenience feature.
- ✅ Spawning backend CLI commands and parsing their output.
- ✅ Calling the backend's HTTP API.
- ✅ Cleaning up our own historical pollution of the backend's
  directories (e.g. `cleanupStaleBuiltInExtensions`).  Negative
  cleanup does not violate the boundary.

### Why this matters

OpenClaw ships weekly (CalVer `2026.4.x`).  If MyClaw's behaviour
depends on openclaw's internal file layout or bug-specific workarounds,
every upstream release risks breaking MyClaw silently.  By reducing
the coupling to three documented contract surfaces we decouple the
release cadences:

- MyClaw can go months between releases
- Users can upgrade openclaw independently (see §12)
- A broken openclaw release is a "warn user, pin to previous" problem,
  not a "fork openclaw and patch it" problem.

## 12. Version-range strategy

MyClaw declares **two** openclaw version facts in
`package.json → available_backends.openclaw`:

- `version` — what the runtime-install step fetches on a fresh install.
  Must be exact (openclaw is CalVer, no semver).
- `tested_compatible` — `{ min, max }` range MyClaw has been exercised
  against.  Not used by the installer; used by the startup
  compatibility check.

On every launch MyClaw reads the actually-installed openclaw version
and compares:

- **Inside range** → silent.
- **Outside range** → non-blocking warning dialog: "This version has
  not been tested with MyClaw X.Y.  You may encounter issues."  User
  can dismiss or choose to pin to a tested version.

Users can upgrade openclaw independently of MyClaw releases via a
"Check for OpenClaw update" action (Help menu or Settings → Runtime).
That action spawns `npm install openclaw@latest --prefix ~/.myclaw/runtime`
and restarts the gateway.  If the new version is outside
`tested_compatible.max`, the user is warned.

Consequence: MyClaw's release cadence is decoupled from openclaw's.
A new MyClaw release bumps `tested_compatible.max` after we have
actually tested against that range.  Users are never *forced* to wait
for MyClaw to update in order to use a newer openclaw — they opt in,
with a clear warning.

## 13. Decisions checklist for new code

Before adding code that touches openclaw, ask:

1. Is this **configuration** or **install**?
   - Configuration → OK to write backend-native config via the adapter.
   - Install → NO.  Leave it to the runtime.
2. Am I naming this file / function after a specific backend?
   - If it's backend-specific logic → keep the name, but put it under
     `electron/adapters/openclaw/` (once that dir exists).
   - If it's generic runtime management → use `runtime-*` or adapter-
     abstracted names.
3. Am I hard-coding `~/.openclaw` or port `18789`?
   - NO.  Go through the adapter / env var contract.  Tomorrow you
     might have three instances with three different state dirs.
4. Does this field appear in both `electron-store` and openclaw.json?
   - It shouldn't.  Pick one owner (§4).
