# dsh-desktop-archive-manager

English | [中文](README.zh.md)

[![dshbase verified](https://dshbase.com/badges/dsh-desktop-archive-manager.svg)](https://dshbase.com/plugins/dsh-desktop-archive-manager/)

Manage the archived Sessions of **DeepSeek Harness**: browse them, restore them, and delete them permanently — the surface the harness itself does not ship. Written for the **desktop app**, and it works in any web-capable profile.

> The harness archives Sessions but never deletes them. The shipped `ui-workspace` package states the limit outright:
> *"No Session deletion — sessions can be archived but never deleted."*
> This plugin fills that gap **without patching the harness core** — it works on a stock install.

**Requirements:** the DeepSeek Harness Desktop app (developed against 0.2.0-rc.2), or any Harness profile with a web UI. The bundle row carries
**no `disabled` gate** — it activates in every profile, and the web surface (host route plus browser half) simply stays quiet where no webserver runs.

**How it differs from the existing [`session-archive-manager`](https://github.com/my-dsh-plugin/session-archive-manager):**
that plugin adds `workspace.deleteSession` by patching the harness core and therefore needs a source checkout or a forked build.
This one adds no core API: its host half removes the stored artifacts itself, so it installs into the shipped desktop app as-is.

---

## 1. Install and uninstall

### From the app: Settings → Plugins → Local plugins

Install the companion [`dsh-local-plugin-source`](https://www.npmjs.com/package/dsh-local-plugin-source) once and the local plugin
folder (`%USERPROFILE%\.dsh\local-plugins`) becomes an in-app source:

| Button | What it does |
|---|---|
| **Install / Reinstall** | installs and enables the bundle (reinstall after editing local source) |
| **Enable / Disable** | toggles the bundle layer, keeping dependencies and files |
| **Remove** | runs `pnpm remove` through the profile's own Plugin Manager |

### From a package spec

The sidebar **Plugins → Add plugin** dialog accepts a package name, a git URL, a tarball, or a local absolute path:

```text
dsh plugin add dsh-desktop-archive-manager                 # after publishing to npm
dsh plugin add github:<you>/dsh-desktop-archive-manager    # straight from GitHub
dsh plugin add C:\path\to\dsh-desktop-archive-manager      # local folder
```

Any of these goes through the profile's own installer: `pnpm add <spec>` → validate `dsh.bundle.patch` → append the package name to
`dsh.profile.bundles` in the profile's `package.json` → recompose and activate (no restart).

### Uninstall

Remove the bundle from the Plugins page (or `dsh plugin remove dsh-desktop-archive-manager`): the bundle selection is dropped,
the Loader row is unloaded, and pnpm removes the package. The plugin keeps no global state, so nothing is left behind — except the
Sessions it deleted.

## 2. What you get in the UI

| Seat | Content |
|---|---|
| Sidebar panel icon (`sidebar.panellist`, order 30) | an **Archives** icon that opens the manager |
| Main panel (`main`, key `archive-manager`) | the archive list: filter, select all, batch restore / batch delete, per-row restore / delete, total size on disk |
| Session row "…" menu (`sidebar.workspaces.session.menu.item`, order 900) | **Delete permanently** on an archived Session |
| Frame overlay (`shell.overlay`) | deletion confirmation (must tick the acknowledgement) plus the result toast |

Localized in English and Simplified Chinese (locale namespace `archive-manager`).

## 3. What a deletion actually removes

Per Session, the host half touches exactly three things:

1. **The Session log directory** — `<root>/<project directory>/<sessionId>/`, including every stored format generation
   (`session.v4.jsonl.zstd`, `.v3`, `.v2`, …). The path comes from the persistence backend's own `locate()`; when a backend
   cannot answer, the plugin falls back to scanning `<root>/*/<sessionId>/`.
2. **The projection-cache record** — that Session's row in the `session_projcache` domain, deleted through the domain API
   (`ctx.storageDomain`), never by writing the JSON file behind its back.
3. **The archive mark** — removed from `archivedSessionIds` in `workspace.json`, which also refreshes the sidebar.

Nothing else is touched: project directories, other Sessions, attachments and workspace records stay as they are.

### Safety gates

- only Session ids that are **currently archived** are accepted — anything else is refused with `archive-manager/not-archived`;
- a Session id must be one safe path segment (regex-checked, `..` refused), so path traversal is impossible;
- a Session with running work is refused (`workspace/session-activity` plus a live-Agent status check);
- the API is one exact route with a same-origin check (Origin header + a custom request header); it never touches the `/api` trust boundary.

## 4. Sessions that are still live in memory

A Session may have been created or opened during the current run, so the process still holds it (Agent/Session in memory, write
handle claimed). Removing the files works, but the row cannot disappear yet — and unarchiving it could wake a Session with no log.

| Session state | Behaviour |
|---|---|
| **Cold** (untouched in this run) | files removed → cache removed → archive mark dropped → **the row leaves the sidebar immediately** |
| **Live** (still held in memory) | files removed → cache removed → **archive mark kept** (the archived gate keeps blocking new turns) → the row stays in the archive view marked "Deleted · cleans up after restart" |

At every startup the plugin runs one `prune`: archive marks whose Session is neither stored on disk nor live in the process are dropped,
so whatever a live Session left behind disappears by itself on the **next start**.

## 5. Package layout

```text
dsh-desktop-archive-manager/
├── package.json          # dsh.bundle.patch + dsh.client (both halves in one package)
├── cordis.patch.yml      # bundle patch: inserts the desktop-archive-manager row (no disabled gate)
├── lib/host.js           # host half: the Cordis plugin and POST /archive-manager/api
├── lib/client.js         # browser half: a prebuilt __ModuleLoader__ bundle
├── lib/core.js           # dependency-free deletion core (unit-tested)
├── test/*.test.mjs       # node --test suite (38 tests)
├── LICENSE
└── README.md / README.zh.md
```

The two declarations that make it a plugin:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [], "external": [] }
}
```

- `dsh.bundle.patch` makes the package a bundle: the installer lists it in `dsh.profile.bundles` and inserts its rows.
- `dsh.client` (with `exports["./client"]`) gives **the same row** a browser half: client-modules scans enabled Loader entries, finds
  the declaration on this package, and serves `lib/client.js`. Host and browser halves therefore come from one package and one version.

## 6. Host endpoint

One exact route: `POST /archive-manager/api`, JSON body, responses shaped `{ ok: true, value }` or
`{ ok: false, error: { code, message, details } }`.

| `op` | Request | Returns |
|---|---|---|
| `list` | — | every archived Session: id, creation time, working directory, owning workspace, log directory, file count, bytes, whether it is live, whether it needs a restart |
| `plan` | `sessionId` | checks and measures only, **deletes nothing** (the dialog uses it to show the paths that would go) |
| `delete` | `sessionId` | the deletion result (`removed/bytes/files/projectionCache/live/pendingRestart/remaining`) |
| `deleteMany` | `sessionIds[]` | per-item results plus the remaining archive set (one failure never stops the others) |
| `prune` | — | drops archive marks with no storage behind them |
| `status` | — | route, storage root, current archive set (self-check) |

## 7. Notes for contributors

- **An inject face's `hooks` object is flattened by the renderer.** `inject: () => ({ hooks: { archives } })` reaches the component as
  the selector hook **`useArchives`** (see `bindInjectSources` in `ui-renderer`); the `hooks` key itself is dropped. Reading
  `props.hooks.archives` throws during render and the slot error boundary marks the entry *abdicated* — the seat then silently disappears.
  Name custom sources so they cannot shadow the owner's standard hooks (this plugin uses `archiveWorkspaces` / `archiveSessions`
  because seats like `shell.overlay` and `main` already carry `useWorkspaces` / `useSessions`).
- **The browser half is a prebuilt bundle** with no bundler step at install time. It may only require modules from the platform seed table
  (`react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`).
- The host half injects the web surface **optionally** (`export const inject = []` plus `ctx.inject([...], cb)`), so the row still activates
  where there is no webserver instead of waiting forever.

## 8. Tests

```powershell
node --test "test/*.test.mjs"
```

38 tests cover the deletion core (path traversal, only the target Session removed, sibling directories kept), the host half
(cold delete, live policy, the three `prune` judgements, request gates, partial batch failures) and the browser half
(slot registrations, host-call plumbing, failure and "pending restart" notices, restore) — including **render tests** that project
each registration through the renderer's real hook flattening before rendering the component, which is what caught the inject-face
contract bug described above.

## 9. Known limitations

- **A live Session's row waits for a restart.** The harness exposes no public "release Agent/Session by id", and this plugin does not
  reach into another plugin's fibers; after a restart the process no longer holds it, the row goes away, and `prune` clears the mark.
- **Only the Session itself is deleted** — subagent Sessions it spawned are separate Sessions and are left alone.
- **Content indexes are out of scope.** This profile's Session search index is `:memory:` (`openAt: never`); a deployment with an
  on-disk index rebuilds it after a restart, and the plugin never touches it directly.
- **Deletion is irreversible.** The UI therefore requires an explicit acknowledgement and lists every log directory in the dialog.
