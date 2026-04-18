import { requestUrl } from "obsidian";

/**
 * An isomorphic-git http plugin implemented with Obsidian's `requestUrl`.
 * Works on desktop and mobile and bypasses CORS.
 */

interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
  // isomorphic-git types signal as `object | undefined`, not AbortSignal.
  signal?: object;
}

interface HttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  body: AsyncIterableIterator<Uint8Array>;
  headers: Record<string, string>;
}

async function collectBody(body: HttpRequest["body"]): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return new ArrayBuffer(0);
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function* iterOnce(chunk: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield chunk;
}

export const http = {
  async request({ url, method = "GET", headers = {}, body }: HttpRequest): Promise<HttpResponse> {
    const bodyBuf = await collectBody(body);
    const resp = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuf,
      throw: false,
    });
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(resp.headers ?? {})) {
      respHeaders[k.toLowerCase()] = String(v);
    }
    const bytes = new Uint8Array(resp.arrayBuffer);
    return {
      url,
      method,
      statusCode: resp.status,
      statusMessage: "",
      headers: respHeaders,
      body: iterOnce(bytes),
    };
  },
};
