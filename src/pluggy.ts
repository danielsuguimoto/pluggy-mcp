const PLUGGY_API_BASE = "https://api.pluggy.ai";
const API_KEY_TTL_MS = 2 * 60 * 60 * 1000;
const API_KEY_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class PluggyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "PluggyError";
  }
}

export type Query = Record<string, string | number | boolean | undefined | string[]>;

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class PluggyClient {
  private apiKey: string | null = null;
  private apiKeyExpiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async ensureApiKey(): Promise<string> {
    const now = Date.now();
    if (this.apiKey && now < this.apiKeyExpiresAt - API_KEY_REFRESH_MARGIN_MS) {
      return this.apiKey;
    }
    const res = await fetch(`${PLUGGY_API_BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) {
      throw new PluggyError(`Pluggy auth failed (${res.status})`, res.status, await res.text());
    }
    const data = (await res.json()) as { apiKey: string };
    this.apiKey = data.apiKey;
    this.apiKeyExpiresAt = now + API_KEY_TTL_MS;
    return this.apiKey;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const apiKey = await this.ensureApiKey();
    const url = path.startsWith("http") ? path : `${PLUGGY_API_BASE}${path}`;
    const headers = new Headers(init.headers);
    headers.set("X-API-KEY", apiKey);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      throw new PluggyError(`Pluggy API ${res.status} for ${path}`, res.status, await res.text());
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>(`${path}${buildQuery(query)}`);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export function decodeCredentials(bearer: string): { clientId: string; clientSecret: string } {
  const trimmed = bearer.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    throw new Error("Authorization header must be a Bearer token");
  }
  const encoded = trimmed.slice(7).trim();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error("Bearer token is not valid base64");
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    throw new Error("Bearer token must decode to clientId:clientSecret");
  }
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  if (!clientId || !clientSecret) {
    throw new Error("clientId and clientSecret must both be non-empty");
  }
  return { clientId, clientSecret };
}
