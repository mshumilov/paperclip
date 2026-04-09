# plugin-razum-scheduler

Paperclip plugin: run **any shell command** on a repeating schedule inside a **project workspace** directory.

## Behaviour

- Declares a scheduled job with cron `* * * * *` (host checks roughly every 30s; your command is throttled by **Minimum interval (minutes)** in settings for `schedule` triggers only).
- **Manual** job runs from the Paperclip plugin jobs UI always execute (no interval skip).
- **Command** is passed to the system shell (`shell: true`), so pipes and `&&` work. Trusted-plugin model: only install from sources you trust.
- Optional **Subdirectory** restricts `cwd` to a path under the workspace root (path traversal is rejected).

## Settings

Configuration and a local **execution log** (command stdout/stderr tails, expandable per run) live on the plugin’s **Settings** screen in the board: **Instance → Settings → Plugins → Razum scheduler → gear**. That UI replaces the default JSON-schema form via a `settingsPage` slot.

| Field | Meaning |
|-------|--------|
| Company ID / Project ID | Scope the workspace list. |
| Workspace name | Exact Paperclip workspace display name; leave empty for primary. |
| Subdirectory | Optional relative cwd under workspace. |
| Command | Any shell command for the workspace directory. |
| Minimum interval | Scheduled runs only: skip if last **successful** scheduled run was sooner than this many minutes. |

## Develop

```bash
pnpm install
pnpm --filter plugin-razum-scheduler build
pnpm --filter plugin-razum-scheduler test
```

## Install (local path)

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/plugin-razum-scheduler","isLocalPath":true}'
```

After install, enable the plugin, fill **instance config**, and ensure the job is **active** under plugin jobs.
