import {
  App,
  DataAdapter,
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { DriveClient, DriveFile, DriveTokens, FOLDER_MIME, runOAuth } from "./drive";
import { GitClient } from "./git-client";
import { VaultFs } from "./vault-fs";

interface FolgitSettings {
  defaultBranch: string;
  defaultCommitMessage: string;
  authorName: string;
  authorEmail: string;
  commitName: string;
  githubToken: string;
  mediaFolderName: string;
  driveClientId: string;
  driveClientSecret: string;
  driveFolderName: string;
  driveFolderId: string;
  driveRefreshToken: string;
  driveAccessToken: string;
  driveExpiresAt: number;
}

const DEFAULT_SETTINGS: FolgitSettings = {
  defaultBranch: "main",
  defaultCommitMessage: "Update from Obsidian",
  authorName: "",
  authorEmail: "",
  commitName: "",
  githubToken: "",
  mediaFolderName: "media",
  driveClientId: "",
  driveClientSecret: "",
  driveFolderName: "Obsidian Media",
  driveFolderId: "",
  driveRefreshToken: "",
  driveAccessToken: "",
  driveExpiresAt: 0,
};

export default class FolgitPlugin extends Plugin {
  settings!: FolgitSettings;
  private vfs!: VaultFs;
  private git!: GitClient;

  async onload() {
    await this.loadSettings();

    this.vfs = new VaultFs(this.app.vault.adapter);
    this.git = new GitClient(
      this.vfs,
      () => this.settings.githubToken.trim(),
      () => ({
        name: this.settings.authorName.trim(),
        email: this.settings.authorEmail.trim(),
      })
    );

    this.addSettingTab(new FolgitSettingTab(this.app, this));

    this.addCommand({
      id: "init-folder-repo",
      name: "Init folder as Git repo",
      callback: () => this.pickFolder("Select a folder to init as a Git repo", (f) => this.initRepo(f)),
    });

    this.addCommand({
      id: "clone-into-folder",
      name: "Clone GitHub repo into a new folder",
      callback: () => this.promptClone(),
    });

    this.addCommand({
      id: "add-remote",
      name: "Add or update remote 'origin'",
      callback: () => this.pickRepoFolder("Select repo folder", (f) => this.promptRemote(f)),
    });

    this.addCommand({
      id: "commit-folder",
      name: "Commit folder changes",
      callback: () => this.pickRepoFolder("Select repo folder to commit", (f) => this.promptCommit(f)),
    });

    this.addCommand({
      id: "push-folder",
      name: "Push folder repo",
      callback: () => this.pickRepoFolder("Select repo folder to push", (f) => this.push(f)),
    });

    this.addCommand({
      id: "pull-folder",
      name: "Pull folder repo",
      callback: () => this.pickRepoFolder("Select repo folder to pull", (f) => this.pull(f)),
    });

    this.addCommand({
      id: "status-folder",
      name: "Show folder repo status",
      callback: () => this.pickRepoFolder("Select repo folder", (f) => this.showStatus(f)),
    });

    this.addCommand({
      id: "sync-push",
      name: "Sync push (commit, push, upload media to Drive)",
      callback: () => this.pickRepoFolder("Select repo folder to sync push", (f) => this.syncPush(f)),
    });

    this.addCommand({
      id: "sync-pull",
      name: "Sync pull (pull, download media from Drive)",
      callback: () => this.pickRepoFolder("Select repo folder to sync pull", (f) => this.syncPull(f)),
    });

    this.addCommand({
      id: "ignore-media-in-repo",
      name: "Ignore media folder in a repo's .gitignore",
      callback: () =>
        this.pickRepoFolder("Select repo folder to update .gitignore", async (f) => {
          if (!this.settings.mediaFolderName.trim()) {
            new Notice("Folgit: set the media folder name in settings first.");
            return;
          }
          const added = await this.ensureMediaIgnored(f);
          new Notice(
            added
              ? `Added '${this.settings.mediaFolderName}/' to '${f.path}/.gitignore'.`
              : `No change — '${this.settings.mediaFolderName}/' already ignored.`
          );
        }),
    });

    this.addCommand({
      id: "upload-media",
      name: "Upload media folder to Google Drive",
      callback: () => this.uploadMedia(),
    });

    this.addCommand({
      id: "download-media",
      name: "Download media folder from Google Drive",
      callback: () => this.downloadMedia(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Init as repo")
            .setIcon("git-branch")
            .onClick(() => this.initRepo(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Clone GitHub repo here")
            .setIcon("git-branch-plus")
            .onClick(() => this.promptCloneInto(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Commit changes")
            .setIcon("check")
            .onClick(() => this.promptCommit(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Push")
            .setIcon("upload")
            .onClick(() => this.push(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Pull")
            .setIcon("download")
            .onClick(() => this.pull(file))
        );
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Sync push")
            .setIcon("arrow-up-circle")
            .onClick(() => this.syncPush(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Sync pull")
            .setIcon("arrow-down-circle")
            .onClick(() => this.syncPull(file))
        );
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Upload to Google Drive")
            .setIcon("upload-cloud")
            .onClick(() => this.uploadFolder(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Folgit: Download from Google Drive")
            .setIcon("download-cloud")
            .onClick(() => this.downloadFolder(file))
        );
      })
    );
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private adapter(): DataAdapter {
    return this.app.vault.adapter;
  }

  async initRepo(folder: TFolder) {
    if (await this.git.isRepo(folder.path)) {
      new Notice(`'${folder.path}' is already a Git repo.`);
      return;
    }
    try {
      await this.git.init(folder.path, this.settings.defaultBranch);
      const added = await this.ensureMediaIgnored(folder);
      new Notice(
        added
          ? `Initialized repo in '${folder.path}'; added media folder to .gitignore.`
          : `Initialized repo in '${folder.path}'.`
      );
    } catch (e) {
      errorNotice("init failed", e);
    }
  }

  async ensureMediaIgnored(repo: TFolder): Promise<boolean> {
    const name = this.settings.mediaFolderName.trim();
    if (!name) return false;

    const gitignorePath = repo.path ? `${repo.path}/.gitignore` : ".gitignore";
    const adapter = this.adapter();
    let content = "";
    if (await adapter.exists(gitignorePath)) {
      content = await adapter.read(gitignorePath);
    }
    const entry = `${name}/`;
    const existing = new Set(
      content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    );
    const variants = [name, entry, `/${name}`, `/${entry}`];
    if (variants.some((v) => existing.has(v))) return false;

    const sep = content && !content.endsWith("\n") ? "\n" : "";
    const block = `${sep}# Folgit: '${name}' folders are synced via Google Drive\n${entry}\n`;
    await adapter.write(gitignorePath, content + block);
    return true;
  }

  async promptRemote(folder: TFolder) {
    new PromptModal(this.app, {
      title: "Remote URL",
      placeholder: "https://github.com/user/repo.git",
      submit: async (url) => {
        if (!url) return;
        try {
          await this.git.addRemote(folder.path, "origin", url);
          new Notice(`Set origin to ${url}.`);
        } catch (e) {
          errorNotice("set remote failed", e);
        }
      },
    }).open();
  }

  async promptCommit(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo. Init it first.`);
      return;
    }
    new PromptModal(this.app, {
      title: "Commit message",
      placeholder: this.settings.defaultCommitMessage,
      submit: async (msg) => this.commit(folder, msg || this.settings.defaultCommitMessage),
    }).open();
  }

  async commit(folder: TFolder, message: string) {
    try {
      const staged = await this.git.addAll(folder.path);
      if (staged === 0) {
        new Notice("Nothing to commit.");
        return;
      }
      const sha = await this.git.commit(folder.path, message);
      new Notice(`Committed '${folder.path}' (${sha.slice(0, 7)}).`);
    } catch (e) {
      errorNotice("commit failed", e);
    }
  }

  async push(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    try {
      const branch = (await this.git.currentBranch(folder.path)) ?? this.settings.defaultBranch;
      new Notice(`Pushing ${branch}…`);
      await this.git.push(folder.path, branch);
      new Notice(`Pushed ${branch}.`);
    } catch (e) {
      errorNotice("push failed", e);
    }
  }

  async pull(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    try {
      new Notice("Pulling…");
      await this.git.pullFastForward(folder.path);
      new Notice("Pulled.");
    } catch (e) {
      errorNotice("pull failed", e);
    }
  }

  async syncPush(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    try {
      const staged = await this.git.addAll(folder.path);
      if (staged > 0) {
        const name = this.settings.commitName.trim();
        const msg = name ? `${name}: Auto-sync ${timestamp()}` : `Auto-sync ${timestamp()}`;
        await this.git.commit(folder.path, msg);
        new Notice(`Committed: ${msg}`);
      } else {
        new Notice("No local changes to commit.");
      }
      const branch = (await this.git.currentBranch(folder.path)) ?? this.settings.defaultBranch;
      new Notice(`Pushing ${branch}…`);
      await this.git.push(folder.path, branch);
      new Notice(`Pushed ${branch}.`);
    } catch (e) {
      errorNotice("sync push (git) failed", e);
    }

    if (this.settings.driveRefreshToken) {
      await this.uploadFolder(folder);
    }
  }

  async syncPull(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    try {
      new Notice("Pulling…");
      await this.git.pullFastForward(folder.path);
      new Notice("Pulled.");
    } catch (e) {
      errorNotice("sync pull (git) failed", e);
    }

    if (this.settings.driveRefreshToken) {
      await this.downloadFolder(folder);
    }
  }

  async showStatus(folder: TFolder) {
    if (!(await this.git.isRepo(folder.path))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    try {
      const out = await this.git.status(folder.path);
      new InfoModal(this.app, `Status: ${folder.path}`, out || "clean").open();
    } catch (e) {
      errorNotice("status failed", e);
    }
  }

  promptClone() {
    new PromptModal(this.app, {
      title: "Clone GitHub repo",
      placeholder: "https://github.com/user/repo.git",
      submit: async (url) => {
        if (!url) return;
        new PromptModal(this.app, {
          title: "Target folder (relative to vault)",
          placeholder: guessFolderName(url),
          submit: async (rel) => this.clone(url, rel || guessFolderName(url)),
        }).open();
      },
    }).open();
  }

  promptCloneInto(parent: TFolder) {
    new PromptModal(this.app, {
      title: `Clone GitHub repo into '${parent.path || "/"}'`,
      placeholder: "https://github.com/user/repo.git",
      submit: async (url) => {
        if (!url) return;
        const name = guessFolderName(url);
        const rel = parent.path ? `${parent.path}/${name}` : name;
        await this.clone(url, rel);
      },
    }).open();
  }

  async clone(url: string, relFolder: string) {
    const rel = normalizePath(relFolder);
    const parts = rel.split("/").filter(Boolean);
    if (parts.length === 0) {
      new Notice("Folgit: invalid target folder.");
      return;
    }
    const parent = parts.slice(0, -1).join("/");
    const adapter = this.adapter();

    try {
      if (await adapter.exists(rel)) {
        new Notice(`Folder '${rel}' already exists. Pick a different target.`);
        return;
      }
      if (parent) await mkdirVault(adapter, parent);
      await adapter.mkdir(rel);
      new Notice(`Cloning into '${rel}'…`);
      await this.git.clone(rel, url, (m) => console.log("[folgit clone]", m));
      new Notice(`Cloned '${rel}'.`);
    } catch (e) {
      errorNotice("clone failed", e);
    }
  }

  findMediaFoldersLocal(root: TFolder): TFolder[] {
    const name = this.settings.mediaFolderName.trim();
    if (!name) return [];
    const out: TFolder[] = [];
    const walk = (f: TFolder) => {
      if (f.name === name) {
        out.push(f);
        return;
      }
      for (const child of f.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(root);
    return out;
  }

  private async findDriveMediaFolders(
    client: DriveClient,
    parentId: string,
    name: string,
    prefix: string[]
  ): Promise<Array<{ driveId: string; segments: string[] }>> {
    const result: Array<{ driveId: string; segments: string[] }> = [];
    const children = await client.listChildren(parentId);
    for (const c of children) {
      if (c.mimeType !== FOLDER_MIME) continue;
      const segments = [...prefix, c.name];
      if (c.name === name) {
        result.push({ driveId: c.id, segments });
      } else {
        const nested = await this.findDriveMediaFolders(client, c.id, name, segments);
        result.push(...nested);
      }
    }
    return result;
  }

  driveClient(): DriveClient | null {
    if (!this.settings.driveClientId || !this.settings.driveClientSecret) {
      new Notice("Folgit: set Google OAuth client ID and secret in settings.");
      return null;
    }
    if (!this.settings.driveRefreshToken) {
      new Notice("Folgit: authorize with Google first (settings → Authorize).");
      return null;
    }
    const tokens: DriveTokens = {
      refreshToken: this.settings.driveRefreshToken,
      accessToken: this.settings.driveAccessToken || undefined,
      expiresAt: this.settings.driveExpiresAt || undefined,
    };
    return new DriveClient(
      this.settings.driveClientId,
      this.settings.driveClientSecret,
      tokens,
      async (t) => {
        this.settings.driveAccessToken = t.accessToken ?? "";
        this.settings.driveExpiresAt = t.expiresAt ?? 0;
        this.settings.driveRefreshToken = t.refreshToken;
        await this.saveSettings();
      }
    );
  }

  async authorizeDrive(): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice(
        "Folgit: Google Drive authorization only works on desktop for now. Authorize on desktop; the token syncs via your vault."
      );
      return;
    }
    const { driveClientId, driveClientSecret } = this.settings;
    if (!driveClientId || !driveClientSecret) {
      new Notice("Folgit: enter your OAuth client ID and secret first.");
      return;
    }
    try {
      new Notice("Opening Google in your browser…");
      const tokens = await runOAuth(driveClientId, driveClientSecret);
      this.settings.driveRefreshToken = tokens.refreshToken;
      this.settings.driveAccessToken = tokens.accessToken ?? "";
      this.settings.driveExpiresAt = tokens.expiresAt ?? 0;
      await this.saveSettings();
      new Notice("Folgit: authorized with Google Drive.");
    } catch (e) {
      errorNotice("authorize failed", e);
    }
  }

  async signOutDrive(): Promise<void> {
    this.settings.driveRefreshToken = "";
    this.settings.driveAccessToken = "";
    this.settings.driveExpiresAt = 0;
    this.settings.driveFolderId = "";
    await this.saveSettings();
    new Notice("Folgit: signed out of Google Drive.");
  }

  async ensureDriveFolderId(client: DriveClient): Promise<string> {
    if (this.settings.driveFolderId) return this.settings.driveFolderId;
    const id = await client.ensureRootFolder(this.settings.driveFolderName || "Obsidian Media");
    this.settings.driveFolderId = id;
    await this.saveSettings();
    return id;
  }

  async uploadMedia() {
    await this.uploadFolder(this.app.vault.getRoot());
  }

  async downloadMedia() {
    await this.downloadFolder(this.app.vault.getRoot());
  }

  async uploadFolder(root: TFolder) {
    const name = this.settings.mediaFolderName.trim();
    if (!name) {
      new Notice("Folgit: set 'Media folder name' in settings.");
      return;
    }
    const client = this.driveClient();
    if (!client) return;
    const medias = this.findMediaFoldersLocal(root);
    if (medias.length === 0) {
      new Notice(`Folgit: no '${name}' folder found under '${root.path || "/"}'.`);
      return;
    }
    try {
      const driveRootId = await this.ensureDriveFolderId(client);
      const totals = { uploaded: 0, skipped: 0, folders: 0 };
      for (const m of medias) {
        new Notice(`Uploading '${m.path}' → Google Drive…`);
        const segments = m.path.split("/").filter(Boolean);
        const targetId = await this.ensureDrivePath(client, driveRootId, segments);
        await this.uploadTree(client, m, targetId, totals);
      }
      new Notice(
        `Uploaded ${totals.uploaded} file(s), ${totals.skipped} unchanged, across ${medias.length} '${name}' folder(s).`
      );
    } catch (e) {
      errorNotice("upload failed", e);
    }
  }

  async downloadFolder(root: TFolder) {
    const name = this.settings.mediaFolderName.trim();
    if (!name) {
      new Notice("Folgit: set 'Media folder name' in settings.");
      return;
    }
    const client = this.driveClient();
    if (!client) return;
    try {
      const driveRootId = await this.ensureDriveFolderId(client);
      const rootSegments = root.path ? root.path.split("/").filter(Boolean) : [];
      const startId = await this.findDrivePath(client, driveRootId, rootSegments);
      if (!startId) {
        new Notice(`Folgit: '${root.path || "/"}' not found on Google Drive — nothing to download.`);
        return;
      }
      const found = await this.findDriveMediaFolders(client, startId, name, []);
      if (found.length === 0) {
        new Notice(`Folgit: no '${name}' folder on Drive under '${root.path || "/"}'.`);
        return;
      }
      const totals = { downloaded: 0, skipped: 0 };
      const base = root.path;
      for (const m of found) {
        const localPath = [base, ...m.segments].filter(Boolean).join("/");
        await mkdirVault(this.adapter(), localPath);
        const displayPath = localPath || "/";
        new Notice(`Downloading Drive → '${displayPath}'…`);
        await this.downloadTree(client, m.driveId, localPath, totals);
      }
      new Notice(
        `Downloaded ${totals.downloaded} file(s), ${totals.skipped} unchanged, across ${found.length} '${name}' folder(s).`
      );
    } catch (e) {
      errorNotice("download failed", e);
    }
  }

  private async ensureDrivePath(client: DriveClient, rootId: string, segments: string[]): Promise<string> {
    let parentId = rootId;
    for (const seg of segments) {
      const children = await client.listChildren(parentId);
      const existing = children.find((c) => c.name === seg && c.mimeType === FOLDER_MIME);
      if (existing) {
        parentId = existing.id;
      } else {
        const created = await client.createFolder(seg, parentId);
        parentId = created.id;
      }
    }
    return parentId;
  }

  private async findDrivePath(
    client: DriveClient,
    rootId: string,
    segments: string[]
  ): Promise<string | null> {
    let parentId = rootId;
    for (const seg of segments) {
      const children = await client.listChildren(parentId);
      const existing = children.find((c) => c.name === seg && c.mimeType === FOLDER_MIME);
      if (!existing) return null;
      parentId = existing.id;
    }
    return parentId;
  }

  private async uploadTree(
    client: DriveClient,
    localFolder: TFolder,
    driveParentId: string,
    counts: { uploaded: number; skipped: number; folders: number }
  ): Promise<void> {
    const remote = await client.listChildren(driveParentId);
    const remoteByName = new Map<string, DriveFile>();
    for (const r of remote) remoteByName.set(r.name, r);

    for (const child of localFolder.children) {
      if (child.name === ".DS_Store" || child.name === "Thumbs.db") continue;
      const existing = remoteByName.get(child.name);
      if (child instanceof TFolder) {
        const subId =
          existing && existing.mimeType === FOLDER_MIME
            ? existing.id
            : (await client.createFolder(child.name, driveParentId)).id;
        if (!existing) counts.folders++;
        await this.uploadTree(client, child, subId, counts);
      } else if (child instanceof TFile) {
        const size = child.stat.size;
        if (
          existing &&
          existing.mimeType !== FOLDER_MIME &&
          existing.size === String(size)
        ) {
          counts.skipped++;
          continue;
        }
        const bytes = await this.adapter().readBinary(child.path);
        await client.uploadFile(
          child.name,
          driveParentId,
          new Uint8Array(bytes),
          guessMime(child.name),
          existing && existing.mimeType !== FOLDER_MIME ? existing.id : undefined
        );
        counts.uploaded++;
      }
    }
  }

  private async downloadTree(
    client: DriveClient,
    driveParentId: string,
    localDir: string,
    counts: { downloaded: number; skipped: number }
  ): Promise<void> {
    const adapter = this.adapter();
    await mkdirVault(adapter, localDir);
    const remote = await client.listChildren(driveParentId);
    for (const r of remote) {
      const childPath = localDir ? `${localDir}/${r.name}` : r.name;
      if (r.mimeType === FOLDER_MIME) {
        await this.downloadTree(client, r.id, childPath, counts);
        continue;
      }
      if (r.mimeType.startsWith("application/vnd.google-apps")) continue;
      if (await adapter.exists(childPath)) {
        const st = await adapter.stat(childPath);
        if (st && r.size !== undefined && st.size === Number(r.size)) {
          counts.skipped++;
          continue;
        }
      }
      const buf = await client.downloadFile(r.id);
      await adapter.writeBinary(childPath, buf);
      counts.downloaded++;
    }
  }

  pickFolder(title: string, onPick: (folder: TFolder) => void) {
    const folders: TFolder[] = [];
    const walk = (f: TAbstractFile) => {
      if (f instanceof TFolder) {
        folders.push(f);
        f.children.forEach(walk);
      }
    };
    walk(this.app.vault.getRoot());
    new FolderSuggestModal(this.app, folders, title, onPick).open();
  }

  pickRepoFolder(title: string, onPick: (folder: TFolder) => void) {
    this.pickFolder(title, async (f) => {
      if (!(await this.git.isRepo(f.path))) {
        new Notice(`'${f.path}' is not a Git repo.`);
        return;
      }
      onPick(f);
    });
  }
}

async function mkdirVault(adapter: DataAdapter, path: string): Promise<void> {
  if (!path) return;
  if (await adapter.exists(path)) return;
  const parts = path.split("/").filter(Boolean);
  let accum = "";
  for (const p of parts) {
    accum = accum ? `${accum}/${p}` : p;
    if (!(await adapter.exists(accum))) {
      await adapter.mkdir(accum);
    }
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function guessFolderName(url: string): string {
  const m = url.match(/\/([^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : "repo";
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

function errorNotice(prefix: string, e: unknown) {
  const raw = e instanceof Error ? e.message : String(e);
  // isomorphic-git can surface very large error payloads (pack dumps, object
  // bodies); clipping keeps Obsidian Mobile's WebView happy and the Notice
  // readable. Full error still goes to the console for debugging.
  const msg = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
  console.error(`[folgit] ${prefix}`, e);
  new Notice(`Folgit: ${prefix} — ${msg}`, 8000);
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private folders: TFolder[],
    title: string,
    private onPick: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder(title);
  }
  getItems(): TFolder[] {
    return this.folders;
  }
  getItemText(item: TFolder): string {
    return item.path || "/";
  }
  onChooseItem(item: TFolder) {
    this.onPick(item);
  }
}

interface PromptOptions {
  title: string;
  placeholder?: string;
  submit: (value: string) => void | Promise<void>;
}

class PromptModal extends Modal {
  private value = "";
  constructor(app: App, private opts: PromptOptions) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl("input", { type: "text" });
    input.placeholder = this.opts.placeholder ?? "";
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.close();
        void this.opts.submit(this.value.trim());
      }
    });
    const buttons = this.contentEl.createDiv();
    buttons.style.marginTop = "1em";
    buttons.style.display = "flex";
    buttons.style.justifyContent = "flex-end";
    buttons.style.gap = "0.5em";
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = buttons.createEl("button", { text: "OK", cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.close();
      void this.opts.submit(this.value.trim());
    });
    setTimeout(() => input.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}

class InfoModal extends Modal {
  constructor(app: App, private title: string, private body: string) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(this.title);
    const pre = this.contentEl.createEl("pre");
    pre.setText(this.body);
    pre.style.whiteSpace = "pre-wrap";
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";
  }
  onClose() {
    this.contentEl.empty();
  }
}

class FolgitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FolgitPlugin) {
    super(app, plugin);
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default branch")
      .setDesc("Used when initializing a new repo.")
      .addText((t) =>
        t
          .setPlaceholder("main")
          .setValue(this.plugin.settings.defaultBranch)
          .onChange(async (v) => {
            this.plugin.settings.defaultBranch = v || "main";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default commit message")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultCommitMessage)
          .onChange(async (v) => {
            this.plugin.settings.defaultCommitMessage = v || DEFAULT_SETTINGS.defaultCommitMessage;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Commit name")
      .setDesc("Prepended to Sync push auto-commit messages (e.g. device or vault name). Leave blank to omit.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. laptop, desktop, phone")
          .setValue(this.plugin.settings.commitName)
          .onChange(async (v) => {
            this.plugin.settings.commitName = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author name")
      .setDesc("Used as the committer name for commits Folgit creates.")
      .addText((t) =>
        t.setValue(this.plugin.settings.authorName).onChange(async (v) => {
          this.plugin.settings.authorName = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Author email")
      .addText((t) =>
        t.setValue(this.plugin.settings.authorEmail).onChange(async (v) => {
          this.plugin.settings.authorEmail = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "GitHub" });
    const ghHint = containerEl.createEl("p", { cls: "setting-item-description" });
    ghHint.appendText(
      "Personal access token used for HTTPS operations against github.com. Create one at github.com/settings/tokens (fine-grained: grant 'Contents: read/write' on the target repos). Stored in this vault's plugin data."
    );

    new Setting(containerEl)
      .setName("GitHub token")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("ghp_… or github_pat_…")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => {
            this.plugin.settings.githubToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Google Drive (media folder)" });
    const howto = containerEl.createEl("p", { cls: "setting-item-description" });
    howto.appendText(
      "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Drive API, then paste the client ID and secret below and click Authorize. Folgit uses the drive.file scope — it only sees files it creates. Authorization runs on desktop only; once authorized the token is stored in the vault and reused on mobile."
    );

    new Setting(containerEl)
      .setName("Media folder name")
      .setDesc("Folder basename to sync with Drive. Any folder with this name (direct or nested) gets uploaded/downloaded; everything else is left alone.")
      .addText((t) =>
        t
          .setPlaceholder("media")
          .setValue(this.plugin.settings.mediaFolderName)
          .onChange(async (v) => {
            this.plugin.settings.mediaFolderName = v.trim() || "media";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Google OAuth client ID")
      .addText((t) =>
        t
          .setPlaceholder("xxxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.driveClientId)
          .onChange(async (v) => {
            this.plugin.settings.driveClientId = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Google OAuth client secret")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.driveClientSecret).onChange(async (v) => {
          this.plugin.settings.driveClientSecret = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Drive folder name")
      .setDesc("Folder created in the root of your Drive on first upload.")
      .addText((t) =>
        t
          .setPlaceholder("Obsidian Media")
          .setValue(this.plugin.settings.driveFolderName)
          .onChange(async (v) => {
            this.plugin.settings.driveFolderName = v || "Obsidian Media";
            await this.plugin.saveSettings();
          })
      );

    const authSetting = new Setting(containerEl).setName("Authorization");
    const status = this.plugin.settings.driveRefreshToken
      ? `Signed in${this.plugin.settings.driveFolderId ? ` · folder ${this.plugin.settings.driveFolderId.slice(0, 8)}…` : ""}`
      : "Not signed in";
    authSetting.setDesc(status);
    authSetting.addButton((b) =>
      b
        .setButtonText("Authorize")
        .setCta()
        .onClick(async () => {
          await this.plugin.authorizeDrive();
          this.display();
        })
    );
    if (this.plugin.settings.driveRefreshToken) {
      authSetting.addButton((b) =>
        b
          .setButtonText("Sign out")
          .setWarning()
          .onClick(async () => {
            await this.plugin.signOutDrive();
            this.display();
          })
      );
    }
  }
}
