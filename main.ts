import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import { DriveClient, DriveFile, DriveTokens, FOLDER_MIME, runOAuth } from "./drive";

const execAsync = promisify(exec);

interface FolgitSettings {
  gitPath: string;
  defaultBranch: string;
  defaultCommitMessage: string;
  authorName: string;
  authorEmail: string;
  githubToken: string;
  mediaFolderPath: string;
  driveClientId: string;
  driveClientSecret: string;
  driveFolderName: string;
  driveFolderId: string;
  driveRefreshToken: string;
  driveAccessToken: string;
  driveExpiresAt: number;
}

const DEFAULT_SETTINGS: FolgitSettings = {
  gitPath: "git",
  defaultBranch: "main",
  defaultCommitMessage: "Update from Obsidian",
  authorName: "",
  authorEmail: "",
  githubToken: "",
  mediaFolderPath: "",
  driveClientId: "",
  driveClientSecret: "",
  driveFolderName: "Obsidian Media",
  driveFolderId: "",
  driveRefreshToken: "",
  driveAccessToken: "",
  driveExpiresAt: 0,
};

interface GitResult {
  stdout: string;
  stderr: string;
}

export default class FolgitPlugin extends Plugin {
  settings!: FolgitSettings;

  async onload() {
    await this.loadSettings();

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
          if (!this.settings.mediaFolderPath.trim()) {
            new Notice("Folgit: set the media folder path in settings first.");
            return;
          }
          const added = await this.ensureMediaIgnored(f);
          new Notice(
            added
              ? `Added media folder to '${f.path}/.gitignore'.`
              : `No change — media folder already ignored or not inside '${f.path}'.`
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

  vaultRoot(): string {
    const adapter = this.app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
    if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
    if (typeof adapter.basePath === "string") return adapter.basePath;
    throw new Error("Could not resolve vault base path — desktop only.");
  }

  absPath(folder: TFolder | string): string {
    const rel = typeof folder === "string" ? folder : folder.path;
    return path.join(this.vaultRoot(), rel);
  }

  async git(cwd: string, args: string): Promise<GitResult> {
    const cmd = `${quote(this.settings.gitPath)}${this.githubAuthFlags()} ${args}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      throw new Error(err.stderr?.trim() || err.stdout?.trim() || err.message || "git failed");
    }
  }

  private githubAuthFlags(): string {
    const token = this.settings.githubToken.trim();
    if (!token) return "";
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return ` -c ${quote(`http.https://github.com/.extraheader=Authorization: Basic ${basic}`)}`;
  }

  async isRepo(folder: TFolder | string): Promise<boolean> {
    const dir = this.absPath(folder);
    try {
      const stat = await fs.stat(path.join(dir, ".git"));
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  async ensureIdentity(cwd: string) {
    if (this.settings.authorName) {
      await this.git(cwd, `config user.name ${quote(this.settings.authorName)}`);
    }
    if (this.settings.authorEmail) {
      await this.git(cwd, `config user.email ${quote(this.settings.authorEmail)}`);
    }
  }

  async initRepo(folder: TFolder) {
    const dir = this.absPath(folder);
    if (await this.isRepo(folder)) {
      new Notice(`'${folder.path}' is already a Git repo.`);
      return;
    }
    try {
      await this.git(dir, `init -b ${quote(this.settings.defaultBranch)}`);
      await this.ensureIdentity(dir);
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
    const media = this.settings.mediaFolderPath.trim();
    if (!media) return false;
    const mediaPath = normalizePath(media);
    const repoPath = repo.path;

    let rel: string;
    if (!repoPath) {
      rel = mediaPath;
    } else if (mediaPath === repoPath) {
      return false;
    } else if (mediaPath.startsWith(repoPath + "/")) {
      rel = mediaPath.slice(repoPath.length + 1);
    } else {
      return false;
    }

    const gitignorePath = path.join(this.absPath(repo), ".gitignore");
    let content = "";
    try {
      content = await fs.readFile(gitignorePath, "utf8");
    } catch {
      // no existing file
    }
    const entry = rel.endsWith("/") ? rel : rel + "/";
    const existing = new Set(
      content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    );
    const variants = [rel, rel + "/", "/" + rel, "/" + rel + "/"];
    if (variants.some((v) => existing.has(v))) return false;

    const sep = content && !content.endsWith("\n") ? "\n" : "";
    const block = `${sep}# Folgit: media folder synced via Google Drive\n${entry}\n`;
    await fs.writeFile(gitignorePath, content + block);
    return true;
  }

  async promptRemote(folder: TFolder) {
    const dir = this.absPath(folder);
    new PromptModal(this.app, {
      title: "Remote URL",
      placeholder: "https://github.com/user/repo.git",
      submit: async (url) => {
        if (!url) return;
        try {
          try {
            await this.git(dir, `remote remove origin`);
          } catch {
            // no existing remote, fine
          }
          await this.git(dir, `remote add origin ${quote(url)}`);
          new Notice(`Set origin to ${url}.`);
        } catch (e) {
          errorNotice("set remote failed", e);
        }
      },
    }).open();
  }

  async promptCommit(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
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
    const dir = this.absPath(folder);
    try {
      await this.ensureIdentity(dir);
      await this.git(dir, `add -A`);
      const status = await this.git(dir, `status --porcelain`);
      if (!status.stdout.trim()) {
        new Notice("Nothing to commit.");
        return;
      }
      await this.git(dir, `commit -m ${quote(message)}`);
      new Notice(`Committed '${folder.path}'.`);
    } catch (e) {
      errorNotice("commit failed", e);
    }
  }

  async push(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    const dir = this.absPath(folder);
    try {
      const branch = (await this.git(dir, `rev-parse --abbrev-ref HEAD`)).stdout.trim() || this.settings.defaultBranch;
      new Notice(`Pushing ${branch}…`);
      const out = await this.git(dir, `push -u origin ${quote(branch)}`);
      new Notice(`Pushed: ${summarize(out)}`);
    } catch (e) {
      errorNotice("push failed", e);
    }
  }

  async pull(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    const dir = this.absPath(folder);
    try {
      new Notice(`Pulling…`);
      const out = await this.git(dir, `pull --ff-only`);
      new Notice(`Pulled: ${summarize(out)}`);
    } catch (e) {
      errorNotice("pull failed", e);
    }
  }

  async syncPush(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    const dir = this.absPath(folder);
    try {
      await this.ensureIdentity(dir);
      await this.git(dir, `add -A`);
      const status = await this.git(dir, `status --porcelain`);
      if (status.stdout.trim()) {
        const msg = `Auto-sync ${timestamp()}`;
        await this.git(dir, `commit -m ${quote(msg)}`);
        new Notice(`Committed: ${msg}`);
      } else {
        new Notice("No local changes to commit.");
      }
      const branch =
        (await this.git(dir, `rev-parse --abbrev-ref HEAD`)).stdout.trim() || this.settings.defaultBranch;
      new Notice(`Pushing ${branch}…`);
      const out = await this.git(dir, `push -u origin ${quote(branch)}`);
      new Notice(`Pushed: ${summarize(out)}`);
    } catch (e) {
      errorNotice("sync push (git) failed", e);
    }

    const media = this.resolveMediaFolderSilent();
    if (media && this.settings.driveRefreshToken) {
      await this.uploadFolder(media);
    }
  }

  async syncPull(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    const dir = this.absPath(folder);
    try {
      new Notice("Pulling…");
      const out = await this.git(dir, `pull --ff-only`);
      new Notice(`Pulled: ${summarize(out)}`);
    } catch (e) {
      errorNotice("sync pull (git) failed", e);
    }

    const media = this.resolveMediaFolderSilent();
    if (media && this.settings.driveRefreshToken) {
      await this.downloadFolder(media);
    }
  }

  private resolveMediaFolderSilent(): TFolder | null {
    const p = this.settings.mediaFolderPath.trim();
    if (!p) return null;
    const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
    return f instanceof TFolder ? f : null;
  }

  async showStatus(folder: TFolder) {
    if (!(await this.isRepo(folder))) {
      new Notice(`'${folder.path}' is not a Git repo.`);
      return;
    }
    const dir = this.absPath(folder);
    try {
      const out = await this.git(dir, `status --short --branch`);
      new InfoModal(this.app, `Status: ${folder.path}`, out.stdout || "clean").open();
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
    const targetAbs = path.join(this.vaultRoot(), rel);
    const parentAbs = path.dirname(targetAbs);
    const name = path.basename(targetAbs);

    try {
      await fs.mkdir(parentAbs, { recursive: true });
      try {
        await fs.access(targetAbs);
        new Notice(`Folder '${rel}' already exists. Pick a different target.`);
        return;
      } catch {
        // does not exist, good
      }
      new Notice(`Cloning into '${rel}'…`);
      await this.git(parentAbs, `clone ${quote(url)} ${quote(name)}`);
      await this.ensureIdentity(targetAbs);
      new Notice(`Cloned '${rel}'.`);
      // refresh Obsidian's view of the vault
      // @ts-ignore private but widely used
      if (typeof this.app.vault.adapter?.reconcileDeletion === "function") {
        // no-op; Obsidian auto-detects in most cases
      }
    } catch (e) {
      errorNotice("clone failed", e);
    }
  }

  getMediaFolder(): TFolder | null {
    const p = this.settings.mediaFolderPath.trim();
    if (!p) {
      new Notice("Folgit: set the media folder path in settings.");
      return null;
    }
    const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
    if (!(f instanceof TFolder)) {
      new Notice(`Folgit: media folder '${p}' not found in vault.`);
      return null;
    }
    return f;
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
    const folder = this.getMediaFolder();
    if (!folder) return;
    await this.uploadFolder(folder);
  }

  async downloadMedia() {
    const folder = this.getMediaFolder();
    if (!folder) return;
    await this.downloadFolder(folder);
  }

  async uploadFolder(folder: TFolder) {
    const client = this.driveClient();
    if (!client) return;
    const local = this.absPath(folder);
    try {
      new Notice(`Uploading '${folder.path || "/"}' → Google Drive…`);
      const rootId = await this.ensureDriveFolderId(client);
      const segments = folder.path ? folder.path.split("/").filter(Boolean) : [];
      const targetId = await this.ensureDrivePath(client, rootId, segments);
      const counts = { uploaded: 0, skipped: 0, folders: 0 };
      await this.uploadTree(client, local, targetId, counts);
      new Notice(`Uploaded: ${counts.uploaded} file(s), ${counts.skipped} unchanged.`);
    } catch (e) {
      errorNotice("upload failed", e);
    }
  }

  async downloadFolder(folder: TFolder) {
    const client = this.driveClient();
    if (!client) return;
    const local = this.absPath(folder);
    try {
      await fs.mkdir(local, { recursive: true });
      new Notice(`Downloading from Google Drive → '${folder.path || "/"}'…`);
      const rootId = await this.ensureDriveFolderId(client);
      const segments = folder.path ? folder.path.split("/").filter(Boolean) : [];
      const targetId = await this.findDrivePath(client, rootId, segments);
      if (!targetId) {
        new Notice(`Folgit: '${folder.path}' not found on Google Drive — nothing to download.`);
        return;
      }
      const counts = { downloaded: 0, skipped: 0 };
      await this.downloadTree(client, targetId, local, counts);
      new Notice(`Downloaded: ${counts.downloaded} file(s), ${counts.skipped} unchanged.`);
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
    localDir: string,
    driveParentId: string,
    counts: { uploaded: number; skipped: number; folders: number }
  ): Promise<void> {
    const entries = await fs.readdir(localDir, { withFileTypes: true });
    const remote = await client.listChildren(driveParentId);
    const remoteByName = new Map<string, DriveFile>();
    for (const r of remote) remoteByName.set(r.name, r);

    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") continue;
      const abs = path.join(localDir, entry.name);
      const existing = remoteByName.get(entry.name);
      if (entry.isDirectory()) {
        const subId =
          existing && existing.mimeType === FOLDER_MIME
            ? existing.id
            : (await client.createFolder(entry.name, driveParentId)).id;
        if (!existing) counts.folders++;
        await this.uploadTree(client, abs, subId, counts);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        if (
          existing &&
          existing.mimeType !== FOLDER_MIME &&
          existing.size === String(stat.size)
        ) {
          counts.skipped++;
          continue;
        }
        const bytes = await fs.readFile(abs);
        await client.uploadFile(
          entry.name,
          driveParentId,
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          guessMime(entry.name),
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
    await fs.mkdir(localDir, { recursive: true });
    const remote = await client.listChildren(driveParentId);
    for (const r of remote) {
      const abs = path.join(localDir, r.name);
      if (r.mimeType === FOLDER_MIME) {
        await this.downloadTree(client, r.id, abs, counts);
        continue;
      }
      if (r.mimeType.startsWith("application/vnd.google-apps")) continue;
      const existing = await fs.stat(abs).catch(() => null);
      if (existing && r.size !== undefined && existing.size === Number(r.size)) {
        counts.skipped++;
        continue;
      }
      const buf = await client.downloadFile(r.id);
      await fs.writeFile(abs, new Uint8Array(buf));
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
      if (!(await this.isRepo(f))) {
        new Notice(`'${f.path}' is not a Git repo.`);
        return;
      }
      onPick(f);
    });
  }
}

function quote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function summarize(r: GitResult): string {
  const text = (r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(-2).join(" · ");
  return text || "ok";
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
  const msg = e instanceof Error ? e.message : String(e);
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
      .setName("Git executable")
      .setDesc("Path to the git binary. 'git' uses PATH.")
      .addText((t) =>
        t
          .setPlaceholder("git")
          .setValue(this.plugin.settings.gitPath)
          .onChange(async (v) => {
            this.plugin.settings.gitPath = v || "git";
            await this.plugin.saveSettings();
          })
      );

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
      .setName("Author name")
      .setDesc("Optional. Applied as local git config on repos Folgit touches.")
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
      "Personal access token used for HTTPS operations against github.com. Create one at github.com/settings/tokens (fine-grained: grant 'Contents: read/write' on the target repos). Stored in this vault's plugin data. Leave blank to fall back to your system git credential helper."
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
      "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Drive API, then paste the client ID and secret below and click Authorize. Folgit uses the drive.file scope — it only sees files it creates."
    );

    new Setting(containerEl)
      .setName("Media folder")
      .setDesc("Vault-relative path of the folder to sync with Google Drive (e.g. 'media').")
      .addText((t) =>
        t
          .setPlaceholder("media")
          .setValue(this.plugin.settings.mediaFolderPath)
          .onChange(async (v) => {
            this.plugin.settings.mediaFolderPath = v;
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
