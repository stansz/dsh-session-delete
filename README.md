# dsh-session-delete

Delete a DSH session **completely**, without taking the Host down with it.

## Why it needs a plugin

A DSH session is not one file:

| Piece | Path |
|---|---|
| Log directory (log + `session.lock`) | `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/` |
| Projection checkpoint | `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json` |
| Workspace row (this is the sidebar) | `$DSH_HOME/storages/workspace.json` |

Deleting the directory in Finder removes the first row and leaves the other two, which is
why the session stays listed and then fails to open. Deleting a session whose Agent is
still live is the other failure mode: the Agent keeps appending to a log directory that no
longer exists.

## What it registers

Global contributions into existing services; nothing shipped is overridden.

- **Tool `session_admin`** (`action: list | inspect | delete`)
- **Command `/session-list`** — every stored session with the flags that decide deletability.
- **Command `/session-delete <session-id> [force]`** — the same operation from the composer.

All three call one implementation (`deleteSession` in `index.js`).

## Usage

```
/session-list
/session-delete session-1a2b3c4d-...          # refuses if live/locked
/session-delete session-1a2b3c4d-... force    # cancels the turn, then deletes
```

Or ask the agent, or use the tool:

```
session_admin action="list"
session_admin action="inspect"  sessionId="session-..."
session_admin action="delete"   sessionId="session-..." dryRun=true
session_admin action="delete"   sessionId="session-..." force=true
```

`dryRun: true` reports exactly which paths and rows would go, and whether the delete would
be blocked, without touching anything.

## The guards

1. **Self** — deleting the session the call is running in is always refused. That is the
   case that would otherwise crash the Host, and it is checked before anything else.
2. **Live or lock-held** — refused unless `force: true`. "Live" comes from
   `sessionController.list()`; "lock-held" is decoded from `session.lock` and tested with
   `process.kill(pid, 0)`, so an Agent in another Host or terminal counts too.
3. **Deletion order** — cancel the turn, flush the live log, forget the workspace row,
   remove the projection cache, then unlink the log directory. Ownership is released
   before the bytes go.
4. **Containment** — every removed path is verified to sit inside `$DSH_HOME/sessions`
   before `rmSync`, so a bad store value can never delete something else. Buckets are
   discovered by scanning for a directory named exactly the session id, never by
   reconstructing the cwd encoding.
5. **Lossless results** — every field is materialized, because the Host rejects a tool
   result that is not lossless JSON. This is also why a stream of `undefined` values is
   omitted rather than sent.

`delete` is registered as not concurrency-safe: two deletes must not interleave between
inspect and unlink.

## Config

None. The store root comes from `DSH_HOME`, then `$DSH_PROFILE_DIR/../..`, then `~/.dsh`.

## Restart note

This package installs as a `link:`. The Desktop Host loads a bundled plugin's JavaScript
once and does **not** re-import a linked package's module generation on `set_plugin`
enable/disable — so an edit to `index.js` needs a DSH restart to take effect, even though
`install_bundle` reports `application: applied`.
