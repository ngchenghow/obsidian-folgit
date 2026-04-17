# Folgit

Per-folder Git for Obsidian. Turn any folder in your vault into a Git repository — clone from GitHub, commit, push, and pull without leaving Obsidian.

Desktop only. Uses your system `git`.

## Features

- **Init folder as Git repo** — run `git init` on any vault folder.
- **Clone GitHub repo into a new folder** — drop a GitHub URL, get a working folder in your vault.
- **Add / update remote** — set `origin` on a folder.
- **Commit** — stages all changes in the folder and commits with a message.
- **Push** — pushes the current branch to `origin`.
- **Pull** — fast-forward pull from `origin`.
- **Status** — porcelain status in a modal.
- **Right-click folders** — the commands show up in the folder context menu.

## Settings

- Git executable path (defaults to `git` on PATH)
- Default branch (for `init`)
- Default commit message
- Author name / email (applied as local `git config` on repos Folgit touches)

## Install (manual)

1. `npm install`
2. `npm run build`
3. Copy `manifest.json` and the built `main.js` into `<your-vault>/.obsidian/plugins/obsidian-folgit/`.
4. Enable **Folgit** in Obsidian's Community plugins settings.

## Authentication

Folgit shells out to your system `git`, so it uses whatever credentials your local `git` is configured with — a credential helper (Git Credential Manager, osxkeychain, `gh auth`), SSH keys, or a cached HTTPS token. Configure those the way you normally would.

## License

MIT
