import { hostOf, parseUrl } from '../lib/urls.js';

export type Channel =
  | 'meta'
  | 'google_ads'
  | 'tiktok'
  | 'pinterest'
  | 'microsoft_ads'
  | 'awin'
  | 'klaviyo'
  | 'other_paid'
  | 'affiliate'
  | 'email'
  | 'organic_search'
  | 'organic_social'
  | 'ai_assistant'
  | 'referral'
  | 'direct'
  | 'internal';

export interface Touch {
  channel: Channel;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  isPaid: boolean;
  clickIdType: string | null;
  clickId: string | null;
  extCampaignId: string | null;
  extAdsetId: string | null;
  extAdId: string | null;
}

export interface ClassifyOptions {
  siteHosts: string[];
  clickIdWithoutParams?: 'paid' | 'organic';
}

export const CHANNEL_LABELS: Record<string, string> = {
  meta: 'Meta',
  google_ads: 'Google Ads',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  microsoft_ads: 'Microsoft Ads',
  awin: 'Awin',
  klaviyo: 'Klaviyo',
  other_paid: 'Sonstige Werbung',
  affiliate: 'Affiliate',
  email: 'Mail',
  organic_search: 'Organische Suche',
  organic_social: 'Organisch Social',
  ai_assistant: 'KI Assistenten',
  referral: 'Verweise',
  direct: 'Direkt',
  internal: 'Intern',
  unattributed: 'Nicht zuordenbar',
};

export const PAID_CHANNELS = new Set<string>(['meta', 'google_ads', 'tiktok', 'pinterest', 'microsoft_ads', 'awin', 'other_paid', 'affiliate']);

const PAID_MEDIA = new Set([
  'cpc', 'ppc', 'paid', 'paidsocial', 'paid_social', 'paid-social', 'social_paid', 'social-paid', 'paidsearch',
  'paid_search', 'paid-search', 'cpm', 'cpv', 'cpa', 'display', 'ads', 'ad', 'sponsored', 'retargeting', 'banner',
  'video', 'shopping', 'pmax',
]);
const EMAIL_MEDIA = new Set(['email', 'e-mail', 'e_mail', 'mail', 'newsletter', 'crm', 'flow', 'campaign_email']);
const AFFILIATE_MEDIA = new Set(['affiliate', 'affiliates', 'partner', 'cps', 'aff']);
const SOCIAL_MEDIA = new Set(['social', 'social_media', 'social-media', 'social_network', 'social-network', 'sm', 'organic_social', 'organic-social', 'post', 'story', 'bio', 'link_in_bio', 'linkinbio', 'reel']);

const SOURCE_ALIASES: Record<string, Channel> = {
  meta: 'meta', facebook: 'meta', fb: 'meta', instagram: 'meta', ig: 'meta', facebook_ads: 'meta', fb_ads: 'meta',
  instagram_ads: 'meta', audience_network: 'meta', an: 'meta', messenger: 'meta', threads: 'meta',
  google: 'google_ads', adwords: 'google_ads', google_ads: 'google_ads', googleads: 'google_ads', gads: 'google_ads',
  youtube: 'google_ads',
  tiktok: 'tiktok', tiktok_ads: 'tiktok', tt: 'tiktok',
  pinterest: 'pinterest', pin: 'pinterest', pinterest_ads: 'pinterest',
  bing: 'microsoft_ads', microsoft: 'microsoft_ads', microsoft_ads: 'microsoft_ads', msn: 'microsoft_ads',
  awin: 'awin', awin1: 'awin', zanox: 'awin', affiliate_window: 'awin',
  klaviyo: 'klaviyo',
};

const BZF_SOURCES: Record<string, Channel> = { ...SOURCE_ALIASES, email: 'klaviyo', other: 'other_paid' };

const CLICK_IDS: { param: string; channel: Channel; source: string; alwaysPaid: boolean }[] = [
  { param: 'gclid', channel: 'google_ads', source: 'google', alwaysPaid: true },
  { param: 'gbraid', channel: 'google_ads', source: 'google', alwaysPaid: true },
  { param: 'wbraid', channel: 'google_ads', source: 'google', alwaysPaid: true },
  { param: 'dclid', channel: 'google_ads', source: 'google', alwaysPaid: true },
  { param: 'ttclid', channel: 'tiktok', source: 'tiktok', alwaysPaid: true },
  { param: 'msclkid', channel: 'microsoft_ads', source: 'bing', alwaysPaid: true },
  { param: 'awc', channel: 'awin', source: 'awin', alwaysPaid: true },
  { param: 'fbclid', channel: 'meta', source: 'facebook', alwaysPaid: false },
  { param: 'epik', channel: 'pinterest', source: 'pinterest', alwaysPaid: false },
  { param: 'twclid', channel: 'other_paid', source: 'x', alwaysPaid: true },
  { param: 'li_fat_id', channel: 'other_paid', source: 'linkedin', alwaysPaid: true },
  { param: 'sccid', channel: 'other_paid', source: 'snapchat', alwaysPaid: true },
  { param: '_kx', channel: 'klaviyo', source: 'klaviyo', alwaysPaid: false },
];

const SEARCH_HOSTS = [
  'google.', 'bing.com', 'duckduckgo.com', 'yahoo.', 'ecosia.org', 'startpage.com', 'qwant.com', 'yandex.', 'baidu.com',
  'search.brave.com', 'ask.com', 'aol.', 'search.t-online.de', 'metager.',
];
/** Suchseiten von Mailanbietern liegen unter deren Domain und werden deshalb vor MAIL_HOSTS geprüft */
const MAIL_PORTAL_SEARCH_HOSTS = ['suche.web.de', 'web.de/suche', 'suche.gmx.'];
const AI_HOSTS = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'gemini.google.com', 'copilot.microsoft.com', 'claude.ai', 'you.com', 'phind.com', 'chat.mistral.ai', 'deepseek.com'];
const MAIL_HOSTS = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.', 'web.de', 'gmx.net', 'gmx.de', 'email.t-online.de', 'mail.t-online.de', 'mail.ionos.de', 'posteo.de', 'mail.proton.me', 'icloud.com'];
const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 't.co', 'x.com', 'twitter.com', 'linkedin.com', 'lnkd.in',
  'pinterest.', 'pin.it', 'tiktok.com', 'youtube.com', 'youtu.be', 'reddit.com', 'snapchat.com', 'threads.net',
  'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'discord.com', 'xing.com', 'tumblr.com', 'bsky.app', 'mastodon.',
];
/** Rücksprünge von Zahlungsanbietern oder Logins sind kein neuer Touchpoint */
const IGNORE_HOSTS = [
  'paypal.', 'klarna.', 'stripe.', 'mollie.', 'adyen.', 'sofort.', 'giropay', 'unzer.', 'payone.', 'computop', 'pay.amazon.', 'payments.amazon.',
  'amazonpay', 'shop.app', 'shopify.com', 'shopifycs', 'cardinalcommerce', 'arcot.com', '3dsecure', 'paydirekt',
  'ratepay', 'afterpay', 'clearpay', 'braintree', 'checkout.com', 'wero', 'accounts.google.com', 'appleid.apple.com',
  'vr-pay', 'secure.', 'acs.', 'idcheck', 'netcetera', 'mastercard.', 'visa.com', 'sparkasse.de', 'dkb.de',
];

/** Muster mit / prüfen Host und Pfad, mit Punkt am Ende jede Endung (google.de), ohne Punkt den Anfang eines Namensteils */
function hostMatches(host: string, patterns: string[], hostPath = host): boolean {
  return patterns.some((pattern) => {
    if (pattern.includes('/')) return hostPath.startsWith(pattern);
    if (pattern.endsWith('.')) return host.startsWith(pattern) || host.includes('.' + pattern);
    if (!pattern.includes('.')) return host.split('.').some((label) => label.startsWith(pattern));
    return host === pattern || host.endsWith('.' + pattern);
  });
}

export function isOwnHost(host: string, siteHosts: string[]): boolean {
  return siteHosts.some((domain) => host === domain || host.endsWith('.' + domain));
}

function cleanParam(value: string | undefined, max = 200): string | null {
  const trimmed = value?.trim();
  // nicht ersetzte Makros wie {{ad.id}}, {campaignid} oder __CID__
  if (!trimmed || trimmed.startsWith('{') || (trimmed.startsWith('__') && trimmed.endsWith('__'))) return null;
  return trimmed.slice(0, max);
}

function lower(value: string | null): string | null {
  return value ? value.toLowerCase() : null;
}

function emptyTouch(channel: Channel): Touch {
  return {
    channel,
    source: null,
    medium: null,
    campaign: null,
    content: null,
    term: null,
    isPaid: false,
    clickIdType: null,
    clickId: null,
    extCampaignId: null,
    extAdsetId: null,
    extAdId: null,
  };
}

/** Vorrang haben eigene Parameter (bzf_*), dann Klick IDs, dann UTM und zuletzt der Referrer */
export function classify(url: string | null | undefined, referrer: string | null | undefined, opts: ClassifyOptions): Touch {
  const query = new Map<string, string>();
  parseUrl(url)?.searchParams.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!query.has(name)) query.set(name, value);
  });
  const param = (name: string, max?: number) => cleanParam(query.get(name), max);

  const utm = {
    source: param('utm_source'),
    medium: param('utm_medium'),
    campaign: param('utm_campaign'),
    content: param('utm_content'),
    term: param('utm_term'),
    id: param('utm_id', 64),
  };
  const bzf = {
    src: lower(param('bzf_src', 40)),
    cid: param('bzf_cid', 64),
    gid: param('bzf_gid', 64),
    aid: param('bzf_aid', 64),
    kw: param('bzf_kw'),
  };
  const gadCampaign = param('gad_campaignid', 64);

  const touch = emptyTouch('direct');
  touch.source = utm.source;
  touch.medium = utm.medium;
  touch.campaign = utm.campaign;
  touch.content = utm.content;
  touch.term = utm.term ?? bzf.kw;
  touch.extCampaignId = bzf.cid ?? utm.id ?? gadCampaign;
  touch.extAdsetId = bzf.gid;
  touch.extAdId = bzf.aid;

  const medium = lower(utm.medium);
  const source = lower(utm.source);
  const paidMarker = !!(bzf.cid || bzf.aid || bzf.gid || (medium && PAID_MEDIA.has(medium)));

  const click = CLICK_IDS.find((c) => param(c.param, 512));
  if (click) {
    touch.clickIdType = click.param;
    touch.clickId = param(click.param, 512);
  }

  if (bzf.src && BZF_SOURCES[bzf.src]) {
    touch.channel = BZF_SOURCES[bzf.src];
    touch.source = touch.source ?? bzf.src;
    touch.isPaid = touch.channel !== 'klaviyo';
    return touch;
  }

  if (click) {
    if (click.channel === 'klaviyo') {
      touch.channel = 'klaviyo';
      touch.source = touch.source ?? 'klaviyo';
      touch.medium = touch.medium ?? 'email';
      return touch;
    }
    if (click.alwaysPaid || paidMarker || opts.clickIdWithoutParams !== 'organic') {
      touch.channel = click.channel;
      touch.source = touch.source ?? click.source;
      touch.isPaid = true;
      return touch;
    }
    touch.channel = 'organic_social';
    touch.source = touch.source ?? hostOf(referrer) ?? click.source;
    return touch;
  }

  if (source || medium) {
    const aliased = source ? SOURCE_ALIASES[source] : undefined;
    if (aliased === 'klaviyo' || (medium && EMAIL_MEDIA.has(medium))) {
      touch.channel = aliased === 'klaviyo' ? 'klaviyo' : 'email';
      return touch;
    }
    if (aliased === 'awin') {
      touch.channel = 'awin';
      touch.isPaid = true;
      return touch;
    }
    if (medium && AFFILIATE_MEDIA.has(medium)) {
      touch.channel = 'affiliate';
      touch.isPaid = true;
      return touch;
    }
    if (paidMarker) {
      touch.channel = aliased ?? 'other_paid';
      touch.isPaid = true;
      return touch;
    }
    if (medium === 'organic') {
      touch.channel = 'organic_search';
      return touch;
    }
    if ((medium && SOCIAL_MEDIA.has(medium)) || (aliased && aliased !== 'google_ads' && aliased !== 'microsoft_ads')) {
      touch.channel = 'organic_social';
      return touch;
    }
    if (aliased === 'google_ads' || aliased === 'microsoft_ads') {
      // utm_source=google ohne bezahltes Medium
      touch.channel = source === 'youtube' ? 'organic_social' : 'organic_search';
      return touch;
    }
    touch.channel = 'referral';
    return touch;
  }

  const refHost = hostOf(referrer);
  if (!refHost) return touch;
  // gleicher Host wie die aufgerufene Seite ist immer intern, auch wenn die Domain in den Einstellungen fehlt
  if (refHost === hostOf(url) || isOwnHost(refHost, opts.siteHosts) || hostMatches(refHost, IGNORE_HOSTS)) {
    return { ...touch, channel: 'internal' };
  }
  touch.source = refHost;
  const refHostPath = refHost + (parseUrl(referrer)?.pathname ?? '');
  if (hostMatches(refHost, AI_HOSTS)) touch.channel = 'ai_assistant';
  else if (hostMatches(refHost, MAIL_PORTAL_SEARCH_HOSTS, refHostPath)) touch.channel = 'organic_search';
  else if (hostMatches(refHost, MAIL_HOSTS)) touch.channel = 'email';
  else if (hostMatches(refHost, SEARCH_HOSTS)) touch.channel = 'organic_search';
  else if (hostMatches(refHost, SOCIAL_HOSTS)) touch.channel = 'organic_social';
  else touch.channel = 'referral';
  touch.medium = touch.channel === 'organic_search' ? 'organic' : touch.channel === 'referral' ? 'referral' : touch.medium;
  return touch;
}

/** Schlüssel, um zu entscheiden, ob ein neuer Touchpoint eine neue Session beginnt */
export function touchKey(t: Pick<Touch, 'channel' | 'source' | 'campaign' | 'clickId' | 'extCampaignId' | 'extAdId'>): string {
  return [t.channel, t.source ?? '', t.campaign ?? '', t.extCampaignId ?? '', t.extAdId ?? '', t.clickId ?? ''].join('|');
}
