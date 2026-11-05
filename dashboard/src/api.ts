export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-bezzify': '1' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError('Server nicht erreichbar', 0);
  }
  // undefined kann kein gültiges JSON sein und markiert eine Antwort ohne JSON, etwa eine HTML Fehlerseite vom Proxy
  const payload = await response.json().catch(() => undefined);
  if (response.status === 401) window.dispatchEvent(new Event('bezzify:logout'));
  if (!response.ok) {
    const issue = Array.isArray(payload?.issues) && payload.issues[0] ? `: ${payload.issues[0].path?.join('.')} ${payload.issues[0].message}` : '';
    throw new ApiError(`${payload?.error ?? `Anfrage fehlgeschlagen (${response.status})`}${issue}`, response.status);
  }
  if (payload === undefined) throw new ApiError('Antwort des Servers ist kein JSON', response.status);
  return payload as T;
}

export interface Metrics {
  spend: number;
  impressions: number;
  clicks: number;
  sessions: number;
  orders: number;
  revenue: number;
  newOrders: number;
  platformConversions: number;
  platformRevenue: number;
}

export interface Row extends Metrics {
  key: string;
  label: string;
  roas: number | null;
  cpa: number | null;
  cvr: number | null;
  aov: number | null;
  cac: number | null;
  children?: Row[];
}

export interface SiteSettings {
  attributionModel: string;
  windowDays: number | null;
  ignoreDirect: boolean;
  revenueBasis: 'gross' | 'net';
  subtractRefunds: boolean;
  consentRequiredForFeedback: boolean;
  clickIdWithoutParams: 'paid' | 'organic';
  cookieDomain: string | null;
  allowNullOrigin: boolean;
  feedbackDelayMinutes: number;
  awinDedup: 'last_paid_click' | 'always_aw';
  defaultCountryCode: string;
  timeDecayHalfLifeDays: number;
  survey: SurveySettings;
}

export interface SurveyAnswerSetting {
  id: string;
  label: string;
  channels: string[];
}

export interface SurveySettings {
  enabled: boolean;
  question: string;
  answers: SurveyAnswerSetting[];
}

export interface ExtrapolationInfo {
  orders: number;
  revenue: number;
  byCustomer: { new: number; returning: number; unknown: number };
  pooled: ('new' | 'returning' | 'unknown')[];
  survey: {
    applied: boolean;
    tracked: number;
    untracked: number;
    deviation: number | null;
    answers: { id: string; label: string; tracked: number; untracked: number }[];
  };
}

export interface SiteInfo {
  id: string;
  workspaceId: string;
  name: string;
  platform: 'shopify' | 'shopware' | 'woocommerce' | 'custom';
  domains: string[];
  currency: string;
  timezone: string;
  publicKey: string;
  settings: SiteSettings;
}

export interface Me {
  user: { id: string; email: string; name: string | null };
  workspaces: { id: string; name: string }[];
  sites: SiteInfo[];
  models: { id: string; label: string }[];
  channels: Record<string, string>;
  endpoint: string;
}

export interface Overview {
  range: { from: string; to: string };
  currency: string;
  extrapolated: boolean;
  extrapolation: ExtrapolationInfo | null;
  kpis: {
    revenue: number;
    orders: number;
    aov: number | null;
    spend: number;
    mer: number | null;
    paidRevenue: number;
    paidSpend: number;
    paidRoas: number | null;
    newOrders: number;
    newShare: number | null;
    cac: number | null;
    refunded: number;
    trackedOrders: number;
    coverage: number | null;
    unattributedOrders: number;
    unattributedRevenue: number;
    sessions: number;
  };
  timeseries: { date: string; revenue: number; orders: number; spend: number }[];
  channels: Row[];
  platforms: { channel: string; label: string; platformConversions: number; platformRevenue: number; orders: number; revenue: number }[];
}

export interface JourneyTouch {
  ts: string;
  channel: string;
  label: string;
  source: string | null;
  campaign: string | null;
  isPaid: boolean;
  fromShop: boolean;
  device: string | null;
  share: number;
}

export interface JourneyOrder {
  id: string;
  externalId: string;
  orderNumber: string | null;
  createdAt: string;
  revenue: number;
  refunded?: boolean;
  isNew: boolean | null;
  touchCount: number;
  daysToConvert: number | null;
  touches: JourneyTouch[];
}
