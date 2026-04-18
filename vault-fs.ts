import { DataAdapter, normalizePath } from "obsidian";

/**
 * An isomorphic-git compatible filesystem backed by Obsidian's vault adapter.
 * Works on both desktop and mobile because the adapter is uniform.
 *
 * isomorphic-git calls `fs.promises.{readFile,writeFile,...}` with paths like
 * `test-folgit/.git/HEAD`. We pass those through to the adapter after
 * normalizing.
 */

class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly dev = 0;
  readonly ino = 0;
  readonly mode: number;
  readonly uid = 0;
  readonly gid = 0;
  readonly type: "file" | "dir";

  constructor(type: "file" | "dir", size: number, mtimeMs: number) {
    this.type = type;
    this.size = size;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = mtimeMs;
    this.mode = type === "dir" ? 0o040755 : 0o100644;
  }

  isFile(): boolean {
    return this.type === "file";
  }
  isDirectory(): boolean {
    return this.type === "dir";
  }
  isSymbolicLink(): boolean {
    return false;
  }
}

function enoent(path: string): Error {
  const e = new Error(`ENOENT: ${path}`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

function eexist(path: string): Error {
  const e = new Error(`EEXIST: ${path}`) as Error & { code: string };
  e.code = "EEXIST";
  return e;
}

function enosys(): Error {
  const e = new Error("ENOSYS") as Error & { code: string };
  e.code = "ENOSYS";
  return e;
}

export class VaultFs {
  readonly promises: {
    readFile: (p: string, opts?: { encoding?: string } | string) => Promise<Uint8Array | string>;
    writeFile: (p: string, data: Uint8Array | string, opts?: unknown) => Promise<void>;
    unlink: (p: string) => Promise<void>;
    readdir: (p: string) => Promise<string[]>;
    mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
    rmdir: (p: string) => Promise<void>;
    stat: (p: string) => Promise<Stats>;
    lstat: (p: string) => Promise<Stats>;
    readlink: (p: string) => Promise<string>;
    symlink: (t: string, p: string) => Promise<void>;
  };

  constructor(private adapter: DataAdapter) {
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      unlink: this.unlink.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      lstat: this.stat.bind(this),
      readlink: async () => {
        throw enosys();
      },
      symlink: async () => {
        throw enosys();
      },
    };
  }

  private resolve(p: string): string {
    return normalizePath(p.replace(/^\/+/, ""));
  }

  private async readFile(p: string, opts?: { encoding?: string } | string): Promise<Uint8Array | string> {
    const path = this.resolve(p);
    const exists = await this.adapter.exists(path);
    if (!exists) throw enoent(path);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    if (encoding === "utf8" || encoding === "utf-8") {
      return await this.adapter.read(path);
    }
    const buf = await this.adapter.readBinary(path);
    return new Uint8Array(buf);
  }

  private async writeFile(p: string, data: Uint8Array | string, _opts?: unknown): Promise<void> {
    const path = this.resolve(p);
    // Ensure parent dir exists — Obsidian's adapter is picky on some platforms.
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent) await this.mkdirRecursive(parent);
    if (typeof data === "string") {
      await this.adapter.write(path, data);
    } else {
      const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data.buffer
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      await this.adapter.writeBinary(path, ab as ArrayBuffer);
    }
  }

  private async unlink(p: string): Promise<void> {
    const path = this.resolve(p);
    if (!(await this.adapter.exists(path))) throw enoent(path);
    await this.adapter.remove(path);
  }

  private async readdir(p: string): Promise<string[]> {
    const path = this.resolve(p);
    if (!(await this.adapter.exists(path))) throw enoent(path);
    const listing = await this.adapter.list(path);
    const all = [...listing.files, ...listing.folders];
    return all.map((entry) => entry.split("/").pop() ?? entry);
  }

  private async mkdirRecursive(p: string): Promise<void> {
    const path = this.resolve(p);
    if (await this.adapter.exists(path)) return;
    const parts = path.split("/").filter(Boolean);
    let accum = "";
    for (const part of parts) {
      accum = accum ? `${accum}/${part}` : part;
      if (!(await this.adapter.exists(accum))) {
        await this.adapter.mkdir(accum);
      }
    }
  }

  private async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
    const path = this.resolve(p);
    const exists = await this.adapter.exists(path);
    if (exists) {
      if (opts?.recursive) return;
      throw eexist(path);
    }
    if (opts?.recursive) {
      await this.mkdirRecursive(path);
    } else {
      await this.adapter.mkdir(path);
    }
  }

  private async rmdir(p: string): Promise<void> {
    const path = this.resolve(p);
    if (!(await this.adapter.exists(path))) throw enoent(path);
    await this.adapter.rmdir(path, false);
  }

  private async stat(p: string): Promise<Stats> {
    const path = this.resolve(p);
    const s = await this.adapter.stat(path);
    if (!s) throw enoent(path);
    const type = s.type === "folder" ? "dir" : "file";
    return new Stats(type, s.size ?? 0, s.mtime ?? 0);
  }
}
