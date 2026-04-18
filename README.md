# Folgit

Per-folder Git for Obsidian, plus native Google Drive sync for a designated media folder. Clone, commit, push, pull — or upload/download binaries to Drive — without leaving Obsidian.

Works on desktop **and mobile**. Git is spoken directly via [isomorphic-git](https://isomorphic-git.org/) over Obsidian's `requestUrl` (no system `git` needed). Google Drive uses the Drive REST API with OAuth 2.0 — authorization runs on desktop once, then the token syncs via the vault to mobile.

## Features

### Git (any folder)
- **Init folder as Git repo** — turn any vault folder into a repo.
- **Clone GitHub repo into a new folder** — drop a GitHub URL, get a working folder in your vault.
- **Add / update remote** — set `origin` on a folder.
- **Commit** — stages all changes in the folder and commits with a message.
- **Push** — pushes the current branch to `origin`.
- **Pull** — fast-forward pull from `origin`.
- **Status** — porcelain-style status in a modal.
- **Right-click folders** — the commands show up in the folder context menu.

### Google Drive (media folders only)
Drive sync is scoped to folders named *media* (configurable via *Media folder name* — default `media`). Files elsewhere are never touched.

- **Right-click any folder → Upload / Download to Google Drive** — walks the folder, finds every `media/` inside it (at any depth, not just direct child), and mirrors each to `<Drive root>/<vault-relative path>/`. Skips files whose size already matches.
- **Upload media folder to Google Drive** / **Download media folder from Google Drive** (command palette) — same thing but walks the entire vault.
- **Sync push / Sync pull** — include these uploads/downloads after their git step.

Drive sync is intended for large binaries (images, audio, video) that you don't want in Git. Designate one folder (e.g. `media/`) as your Drive-backed folder and keep everything else in Git. Folgit uses the `drive.file` OAuth scope — it can only see files it creates, never the rest of your Drive.

## Settings

**Git**
- Default branch (for `init`)
- Default commit message
- Commit name (prepended to Sync push auto-commit messages — e.g. `laptop: Auto-sync …`)
- Author name / email (used as the committer for commits Folgit creates)
- GitHub token (personal access token for HTTPS auth against github.com)

**Google Drive**
- Media folder name — folder basename to sync (default `media`); every folder with this name gets synced, regardless of depth
- Google OAuth client ID & client secret — from a "Desktop app" OAuth 2.0 client in Google Cloud Console
- Drive folder name — the folder Folgit creates in the root of your Drive on first upload (defaults to `Obsidian Media`)
- Authorize / Sign out buttons

## Setting up Drive sync

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the **Google Drive API** under APIs & Services.
3. Under *APIs & Services → Credentials*, create an **OAuth 2.0 Client ID** of type **Desktop app**. Copy the client ID and client secret.
4. In Folgit settings **on desktop**, paste the client ID and secret, set *Media folder*, and click **Authorize**. A browser window opens for Google consent; the plugin captures the code on a loopback port.
5. Tokens are stored in `<vault>/.obsidian/plugins/obsidian-folgit/data.json`. If your vault syncs across devices, mobile will pick the token up automatically.
6. Use *Upload media folder to Google Drive* / *Download media folder from Google Drive*, or right-click the media folder — on either desktop or mobile.

Click **Sign out** to revoke locally and clear the stored tokens.

## Authentication

**GitHub:** set a personal access token in Folgit's settings (fine-grained tokens with *Contents: read/write* on the target repos work great). The token is applied to clones, pushes, and pulls automatically. Folgit does not shell out to `git` and has no access to system credential helpers.

**Google Drive:** OAuth 2.0 (desktop loopback flow). Authorize once on desktop; the refresh token is stored in the vault's plugin data and reused everywhere the vault syncs.

## Install (manual)

1. `npm install`
2. `npm run build`
3. Copy `manifest.json` and the built `main.js` into `<your-vault>/.obsidian/plugins/obsidian-folgit/`.
4. Enable **Folgit** in Obsidian's Community plugins settings.

## License

MIT
