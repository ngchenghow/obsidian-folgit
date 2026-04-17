# Folgit

Per-folder Git for Obsidian, plus Google Drive sync for a designated media folder. Clone, commit, push, pull — or upload/download binaries to Drive — without leaving Obsidian.

Desktop only. Uses your system `git` and (for Drive) `rclone`.

## Features

### Git (any folder)
- **Init folder as Git repo** — run `git init` on any vault folder.
- **Clone GitHub repo into a new folder** — drop a GitHub URL, get a working folder in your vault.
- **Add / update remote** — set `origin` on a folder.
- **Commit** — stages all changes in the folder and commits with a message.
- **Push** — pushes the current branch to `origin`.
- **Pull** — fast-forward pull from `origin`.
- **Status** — porcelain status in a modal.
- **Right-click folders** — the commands show up in the folder context menu.

### Google Drive (media folder)
- **Upload media folder to Google Drive** — `rclone copy <media> <remote>`.
- **Download media folder from Google Drive** — `rclone copy <remote> <media>`.
- **Right-click the media folder** — upload/download entries appear on the folder matching your configured path.

Drive sync is intended for large binaries (images, audio, video) that you don't want in Git. Designate one folder (e.g. `media/`) as your Drive-backed folder and keep everything else in Git.

## Settings

**Git**
- Git executable path (defaults to `git` on PATH)
- Default branch (for `init`)
- Default commit message
- Author name / email (applied as local `git config` on repos Folgit touches)

**Google Drive**
- Media folder — vault-relative path of the folder to sync (e.g. `media`)
- rclone executable path (defaults to `rclone` on PATH)
- rclone remote — e.g. `gdrive:obsidian-media`. Must match a remote you've set up via `rclone config`.
- rclone extra flags — appended to every call (e.g. `--fast-list --transfers=8`)

## Setting up Drive sync

1. Install [rclone](https://rclone.org/downloads/).
2. Run `rclone config` and follow the prompts to create a Google Drive remote. Name it something short (e.g. `gdrive`).
3. In Folgit settings, set *Media folder* to a vault-relative path and *rclone remote* to `<remote>:<subpath>` (e.g. `gdrive:obsidian-media`).
4. Use the *Upload media folder* / *Download media folder* commands, or right-click the media folder.

## Install (manual)

1. `npm install`
2. `npm run build`
3. Copy `manifest.json` and the built `main.js` into `<your-vault>/.obsidian/plugins/obsidian-folgit/`.
4. Enable **Folgit** in Obsidian's Community plugins settings.

## Authentication

Folgit shells out to your system `git`, so it uses whatever credentials your local `git` is configured with — a credential helper (Git Credential Manager, osxkeychain, `gh auth`), SSH keys, or a cached HTTPS token. Configure those the way you normally would.

## License

MIT
