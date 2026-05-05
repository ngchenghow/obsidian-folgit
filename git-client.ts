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

  async push(dir: string, ref?: string, opts: { force?: boolean } = {}): Promise<void> {
    const branch = ref ?? (await this.currentBranch(dir));
    if (!branch) {
      throw new Error("Cannot push with a detached HEAD — check out a branch first.");
    }
    const force = !!opts.force;
    console.log(`[folgit] push dir=${dir} branch=${branch} force=${force}`);

    // Force push: skip fetch+merge entirely and overwrite the remote ref.
    // Caller is responsible for understanding this can erase commits from
    // other devices that haven't been pulled.
    if (force) {
      await git.push({
        fs: this.fs,
        http,
        dir,
        remote: "origin",
        ref: branch,
        force: true,
        onAuth: this.auth,
      });
      return;
    }

    // Safe path: fetch + auto-merge + plain push.
    // Step 1: fetch the remote branch so we can merge any new commits in
    // before pushing. If the remote doesn't have this branch yet (first
    // push), we skip the merge entirely.
    let remoteHasBranch = true;
    try {
      await git.fetch({
        fs: this.fs,
        http,
        dir,
        remote: "origin",
        ref: branch,
        remoteRef: branch,
        singleBranch: true,
        tags: false,
        onAuth: this.auth,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/NotFound|Could not find|not.*found.*remote|Reference.*does not exist/i.test(msg)) {
        console.log(`[folgit] push: remote has no '${branch}' yet — first push`);
        remoteHasBranch = false;
      } else {
        throw e;
      }
    }

    // Step 2: merge origin/<branch> into local <branch>. isomorphic-git's
    // merge fast-forwards when possible and creates a merge commit otherwise;
    // it throws MergeConflictError when both sides edited the same lines.
    if (remoteHasBranch) {
      try {
        await git.merge({
          fs: this.fs,
          dir,
          ours: branch,
          theirs: `refs/remotes/origin/${branch}`,
          author: this.author(),
        });
        await git.checkout({ fs: this.fs, dir, ref: branch, force: false });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/MergeConflict|conflict/i.test(msg)) {
          throw new Error(
            `Push aborted: merge conflict between local '${branch}' and origin/${branch}. ` +
              `Resolve the conflicts manually, commit, then push again. ` +
              `Or enable 'Force push' in Folgit settings to overwrite the remote (loses other devices' commits).`
          );
        }
        throw e;
      }
    }

    // Step 3: regular (non-force) push. Should always be a fast-forward now
    // because we just merged origin/<branch> into local.
    await git.push({
      fs: this.fs,
      http,
      dir,
      remote: "origin",
      ref: branch,
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
