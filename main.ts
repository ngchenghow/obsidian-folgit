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

const execAsync = promisify(exec);

interface FolgitSettings {
  gitPath: string;
  defaultBranch: string;
  defaultCommitMessage: string;
  authorName: string;
  authorEmail: string;
}

const DEFAULT_SETTINGS: FolgitSettings = {
  gitPath: "git",
  defaultBranch: "main",
  defaultCommitMessage: "Update from Obsidian",
  authorName: "",
  authorEmail: "",
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
    const cmd = `${quote(this.settings.gitPath)} ${args}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      throw new Error(err.stderr?.trim() || err.stdout?.trim() || err.message || "git failed");
    }
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
      new Notice(`Initialized repo in '${folder.path}'.`);
    } catch (e) {
      errorNotice("init failed", e);
    }
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

function guessFolderName(url: string): string {
  const m = url.match(/\/([^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : "repo";
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
  }
}
