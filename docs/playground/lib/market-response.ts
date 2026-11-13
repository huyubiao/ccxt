export async function readMarketResponse<T>(response: Response, fallback: string): Promise<T> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const isJson = contentType === "application/json" || contentType.endsWith("+json");
  if (!isJson) throw new Error(fallback);

  const body: unknown = await response.json().catch(() => { throw new Error(fallback); });
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
    throw new Error(message);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(fallback);
  return body as T;
}
