const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function isLocalSettingsRequest(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  return process.env.PLAYGROUND_LOCAL_SETTINGS === "1" &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

export function isSameOrigin(request: Request): boolean {
  const origin = URL.parse(request.headers.get("origin") ?? "");
  const site = request.headers.get("sec-fetch-site");
  return origin !== null && origin.protocol === new URL(request.url).protocol &&
    origin.host === request.headers.get("host") && (site === null || site === "same-origin");
}

export async function readLocalJson(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return { status: 415 } as const;
  if (Number(request.headers.get("content-length")) > MAX_JSON_BYTES) return { status: 413 } as const;
  if (!request.body) return { status: 400 } as const;

  const reader = request.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => {});
        return { status: 413 } as const;
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    return { status: 200, text } as const;
  } catch {
    return { status: 400 } as const;
  } finally {
    reader.releaseLock();
  }
}
