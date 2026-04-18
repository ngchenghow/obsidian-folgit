import { Platform, requestUrl } from "obsidian";

type NodeHttp = typeof import("http");

function loadHttp(): NodeHttp | null {
  if (!Platform.isDesktop) return null;
  try {
    const req = (globalThis as unknown as { require?: (s: string) => unknown }).require;
    if (typeof req !== "function") return null;
    return req("http") as NodeHttp;
  } catch {
    return null;
  }
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveTokens {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
}

export async function runOAuth(clientId: string, clientSecret: string): Promise<DriveTokens> {
  if (!Platform.isDesktop) {
    throw new Error(
      "Google Drive authorization requires desktop (uses a loopback HTTP server). Authorize on desktop; the token syncs via the vault."
    );
  }
  const { port, codePromise, close } = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}/`;
  const state = Math.random().toString(36).slice(2);
  const authUrl =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
  window.open(authUrl);

  let code: string;
  try {
    const result = await codePromise;
    if (result.state !== state) throw new Error("OAuth state mismatch — aborting.");
    code = result.code;
  } finally {
    close();
  }

  const resp = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const data = resp.json as { access_token: string; refresh_token?: string; expires_in: number };
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke Folgit at myaccount.google.com/permissions and authorize again."
    );
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

function startLoopbackServer(): Promise<{
  port: number;
  codePromise: Promise<{ code: string; state: string }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const http = loadHttp();
    if (!http) {
      reject(new Error("Node http module unavailable — loopback OAuth requires desktop."));
      return;
    }
    const server = http.createServer();
    let resolveCode!: (v: { code: string; state: string }) => void;
    let rejectCode!: (e: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const timeout = setTimeout(() => {
      rejectCode(new Error("OAuth timed out after 5 minutes."));
      server.close();
    }, 5 * 60 * 1000);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      if (err) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Google auth error</h1><p>${escapeHtml(err)}</p>`);
        clearTimeout(timeout);
        rejectCode(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!code) {
        res.writeHead(400);
        res.end("Missing code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Folgit is authorized.</h1><p>You can close this tab.</p>");
      clearTimeout(timeout);
      resolveCode({ code, state });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ port: addr.port, codePromise, close: () => server.close() });
      } else {
        reject(new Error("Failed to bind loopback server"));
      }
    });
  });
}

export class DriveClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokens: DriveTokens,
    private onTokensUpdated: (t: DriveTokens) => Promise<void>
  ) {}

  private async accessToken(): Promise<string> {
    if (this.tokens.accessToken && this.tokens.expiresAt && Date.now() < this.tokens.expiresAt) {
      return this.tokens.accessToken;
    }
    const resp = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.tokens.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const data = resp.json as { access_token: string; expires_in: number };
    this.tokens.accessToken = data.access_token;
    this.tokens.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    await this.onTokensUpdated(this.tokens);
    return this.tokens.accessToken;
  }

  private async apiGet<T>(urlPath: string, params?: Record<string, string>): Promise<T> {
    const token = await this.accessToken();
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    const resp = await requestUrl({
      url: `${DRIVE_API}${urlPath}${qs}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.json as T;
  }

  async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        q: `'${parentId}' in parents and trashed=false`,
        fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)",
        pageSize: "1000",
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this.apiGet<{ files: DriveFile[]; nextPageToken?: string }>("/files", params);
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async createFolder(name: string, parentId: string | null): Promise<DriveFile> {
    const token = await this.accessToken();
    const resp = await requestUrl({
      url: `${DRIVE_API}/files?fields=id,name,mimeType`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: parentId ? [parentId] : undefined,
      }),
    });
    return resp.json as DriveFile;
  }

  async ensureRootFolder(name: string): Promise<string> {
    const data = await this.apiGet<{ files: DriveFile[] }>("/files", {
      q: `name='${escapeQ(name)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`,
      fields: "files(id, name)",
      pageSize: "1",
    });
    if (data.files?.[0]) return data.files[0].id;
    const created = await this.createFolder(name, null);
    return created.id;
  }

  async uploadFile(
    name: string,
    parentId: string,
    bytes: Uint8Array,
    mimeType: string,
    existingId?: string
  ): Promise<DriveFile> {
    const token = await this.accessToken();
    const metadata: Record<string, unknown> = existingId ? { name } : { name, parents: [parentId] };
    const boundary = `-------folgit${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const fields = "fields=id,name,mimeType,size,md5Checksum,modifiedTime";
    const url = existingId
      ? `${DRIVE_UPLOAD}/${existingId}?uploadType=multipart&${fields}`
      : `${DRIVE_UPLOAD}?uploadType=multipart&${fields}`;
    const resp = await requestUrl({
      url,
      method: existingId ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: body.buffer.slice(0) as ArrayBuffer,
    });
    return resp.json as DriveFile;
  }

  async downloadFile(id: string): Promise<ArrayBuffer> {
    const token = await this.accessToken();
    const resp = await requestUrl({
      url: `${DRIVE_API}/files/${id}?alt=media`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.arrayBuffer;
  }
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}
