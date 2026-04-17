# Folgit

Per-folder Git for Obsidian, plus native Google Drive sync for a designated media folder. Clone, commit, push, pull — or upload/download binaries to Drive — without leaving Obsidian.

Desktop only. Uses your system `git`. Google Drive is spoken directly via the Drive REST API with OAuth 2.0.

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
- **Upload media folder to Google Drive** — recursively mirrors the local media folder into a folder on your Drive (creates subfolders as needed, skips files whose size already matches remotely).
- **Download media folder from Google Drive** — the reverse: pulls every file from the Drive folder into the local media folder, skipping unchanged files.
- **Right-click the media folder** — upload/download entries appear on the folder matching your configured path.

Drive sync is intended for large binaries (images, audio, video) that you don't want in Git. Designate one folder (e.g. `media/`) as your Drive-backed folder and keep everything else in Git. Folgit uses the `drive.file` OAuth scope — it can only see files it creates, never the rest of your Drive.

## Settings

**Git**
- Git executable path (defaults to `git` on PATH)
- Default branch (for `init`)
- Default commit message
- Author name / email (applied as local `git config` on repos Folgit touches)

**Google Drive**
- Media folder — vault-relative path of the folder to sync (e.g. `media`)
- Google OAuth client ID & client secret — from a "Desktop app" OAuth 2.0 client in Google Cloud Console
- Drive folder name — the folder Folgit creates in the root of your Drive on first upload (defaults to `Obsidian Media`)
- Authorize / Sign out buttons

## Setting up Drive sync

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the **Google Drive API** under APIs & Services.
3. Under *APIs & Services → Credentials*, create an **OAuth 2.0 Client ID** of type **Desktop app**. Copy the client ID and client secret.
4. In Folgit settings, paste the client ID and secret, set *Media folder*, and click **Authorize**. A browser window opens for Google consent; the plugin captures the code on a loopback port.
5. Use *Upload media folder to Google Drive* / *Download media folder from Google Drive*, or right-click the media folder.

Tokens are stored in `<vault>/.obsidian/plugins/obsidian-folgit/data.json`. Click **Sign out** to revoke locally and clear them.

## Install (manual)

1. `npm install`
2. `npm run build`
3. Copy `manifest.json` and the built `main.js` into `<your-vault>/.obsidian/plugins/obsidian-folgit/`.
4. Enable **Folgit** in Obsidian's Community plugins settings.

## Authentication

Folgit shells out to your system `git`, so it uses whatever credentials your local `git` is configured with — a credential helper (Git Credential Manager, osxkeychain, `gh auth`), SSH keys, or a cached HTTPS token. Configure those the way you normally would.

## License

MIT
