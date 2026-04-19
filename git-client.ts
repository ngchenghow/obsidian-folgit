import git from "isomorphic-git";
import { VaultFs } from "./vault-fs";
import { http } from "./iso-http";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitAuth {
  username?: string;
  password?: string;
}

export class GitClient {
  constructor(
    private fs: VaultFs,
    private getToken: () => string,
    private getIdentity: () => GitIdentity
  ) {}

  private auth = () => {
    const token = this.getToken();
    if (!token) return { cancel: true } as const;
    return { username: "x-access-token", password: token } as const;
  };

  private author(): { name: string; email: string } {
    const id = this.getIdentity();
    return {
      name: id.name || "Folgit",
      email: id.email || "folgit@obsidian.local",
    };
  }

  async isRepo(dir: string): Promise<boolean> {
    try {
      const s = await this.fs.promises.stat(`${dir}/.git`);
      return s.isDirectory() || s.isFile();
    } catch {
      return false;
    }
  }

  async init(dir: string, defaultBranch: string): Promise<void> {
    await git.init({ fs: this.fs, dir, defaultBranch });
  }

  async clone(
    dir: string,
    url: string,
    opts: { depth?: number; onMessage?: (m: string) => void } = {}
  ): Promise<void> {
    const { depth, onMessage } = opts;
    console.log(`[folgit] clone start dir=${dir} url=${url} depth=${depth ?? "full"}`);
    await git.clone({
      fs: this.fs,
      http,
      dir,
      url,
      singleBranch: true,
      // depth > 0 means shallow clone (only last N commits). Drastically
      // reduces memory + bandwidth for mobile. Omit for full history.
      ...(depth && depth > 0 ? { depth } : {}),
      onAuth: this.auth,
      onMessage: (m: string) => {
        console.log(`[folgit] clone msg:`, m);
        onMessage?.(m);
      },
      onProgress: (p) => {
        if (p.phase) console.log(`[folgit] clone progress:`, p.phase, p.loaded, "/", p.total);
      },
    });
    console.log(`[folgit] clone done dir=${dir}`);
  }

  async addRemote(dir: string, remote: string, url: string): Promise<void> {
    try {
      await git.deleteRemote({ fs: this.fs, dir, remote });
    } catch {
      // no existing
    }
    await git.addRemote({ fs: this.fs, dir, remote, url });
  }

  async currentBranch(dir: string): Promise<string | undefined> {
    const b = await git.currentBranch({ fs: this.fs, dir, fullname: false });
    return b ?? undefined;
  }

  /**
   * Stage every change in the workdir (add new/modified, remove deleted).
   * Returns number of entries staged.
   */
  async addAll(dir: string): Promise<number> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    let changed = 0;
    for (const [filepath, head, workdir, stage] of matrix) {
      if (workdir === stage) continue;
      if (workdir === 0) {
        await git.remove({ fs: this.fs, dir, filepath });
      } else {
        await git.add({ fs: this.fs, dir, filepath });
      }
      changed++;
    }
    return changed;
  }

  async hasStagedOrUnstagedChanges(dir: string): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    return matrix.some(([, head, workdir, stage]) => head !== stage || workdir !== stage);
  }

  async commit(dir: string, message: string): Promise<string> {
    return await git.commit({
      fs: this.fs,
      dir,
      message,
      author: this.author(),
    });
  }

  async push(dir: string, ref?: string): Promise<void> {
    await git.push({
      fs: this.fs,
      http,
      dir,
      remote: "origin",
      ref,
      onAuth: this.auth,
    });
  }

  async pullFastForward(dir: string): Promise<void> {
    const branch = await this.currentBranch(dir);
    if (!branch) {
      throw new Error("Cannot pull with a detached HEAD — check out a branch first.");
    }
    console.log(`[folgit] fastForward dir=${dir} branch=${branch}`);
    // git.fastForward is purpose-built for `git pull --ff-only` and internally
    // handles the fetch + ref resolution without the "master" fallback quirk
    // that git.pull has.
    try {
      await git.fastForward({
        fs: this.fs,
        http,
        dir,
        ref: branch,
        remoteRef: branch,
        remote: "origin",
        singleBranch: true,
        onAuth: this.auth,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not.*fast.*forward|NotFastForward/i.test(msg)) {
        throw new Error(
          `Local '${branch}' has diverged from origin/${branch}. Commit or reset, then retry.`
        );
      }
      throw e;
    }
  }

  async status(dir: string): Promise<string> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    const lines: string[] = [];
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      const code = statusCode(head, workdir, stage);
      lines.push(`${code} ${filepath}`);
    }
    const branch = (await this.currentBranch(dir)) ?? "(detached)";
    return `## ${branch}\n${lines.join("\n")}`.trim();
  }
}

function statusCode(head: number, workdir: number, stage: number): string {
  // See https://isomorphic-git.org/docs/en/statusMatrix for matrix semantics.
  const s = `${head}${workdir}${stage}`;
  switch (s) {
    case "020":
      return "??"; // new, untracked
    case "022":
      return "A "; // added to index, identical to workdir
    case "023":
      return "AM"; // added, modified in workdir
    case "100":
      return " D"; // deleted in workdir and index
    case "101":
      return "D "; // deleted from index only
    case "103":
      return "DM";
    case "111":
      return "  ";
    case "120":
      return " D"; // missing
    case "121":
      return " M"; // modified in workdir
    case "122":
      return "M ";
    case "123":
      return "MM";
    default:
      return "??";
  }
}
