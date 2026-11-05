import { parseUrl } from './urls.js';

export type FetchFn = typeof fetch;

export class HttpError extends Error {
  public url: string;

  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`HTTP ${status} von ${shortUrl(url)}: ${platformMessage(body)}`);
    // Meta erwartet den Token in der URL, so landet er nirgends, wo der Fehler weitergereicht wird
    this.url = redact(url);
  }
}

// Nur Host und Pfad, in den Parametern stecken oft Tokens
function shortUrl(url: string): string {
  const parsed = parseUrl(url);
  return parsed ? parsed.host + parsed.pathname : redact(url);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function platformMessage(body: string): string {
  const parsed = parseJson(body);
  // Google liefert bei searchStream ein Array mit einem Fehlerobjekt
  const error = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any> | null | undefined;
  const message =
    error?.error?.message ??
    error?.message ??
    error?.error_description ??
    error?.description ??
    (typeof error?.error === 'string' ? error.error : null);
  return (message ? String(message) : body).slice(0, 400);
}

/** Zugangsdaten aus URLs entfernen, bevor sie in Logs oder Fehlermeldungen landen */
export function redact(url: string): string {
  return url.replace(/(access_token|token|key|secret)=[^&]+/gi, '$1=***');
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

export async function fetchJson<T = any>(url: string, req: JsonRequest = {}): Promise<T> {
  const fetchFn = req.fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const response = await fetchFn(url, {
    method: req.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, text, url);
  if (!text) return undefined as T;
  const parsed = parseJson(text);
  return (parsed === undefined ? text : parsed) as T;
}

/** Wie JSON.parse, entfernt aber Nullzeichen aus Strings, PostgreSQL lehnt sie in text und jsonb ab */
export function parseJsonBody(text: string): unknown {
  return JSON.parse(text, (_key, value) => {
    if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some((key) => key.includes('\u0000'))) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replaceAll('\u0000', ''), entry]));
    }
    return value;
  });
}
