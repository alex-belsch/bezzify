import type { Queryable } from './db/index.js';
import { encrypt, randomId, sha256Hex } from './lib/crypto.js';
import { customerKey, round2 } from './lib/normalize.js';
import { addDays, dayList, zonedDay, zonedStartOfDay } from './lib/time.js';
import { createUser, createWorkspace } from './api/auth.js';
import { createSite, defaultSurvey, type Site } from './sites.js';
import { classify, PAID_CHANNELS, type Touch } from './tracking/classify.js';

const DEMO_DOMAIN = 'demo-elektronik.de';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ad {
  id: string;
  name: string;
}
interface AdSet {
  id: string;
  name: string;
  ads: Ad[];
}
interface Campaign {
  id: string;
  name: string;
  adsets: AdSet[];
  budget: number;
}

const CATALOG: Record<string, Campaign[]> = {
  meta: [
    {
      id: '120210000000001',
      name: 'DE Prospecting Maker Zielgruppe',
      budget: 130,
      adsets: [
        { id: '120210000000101', name: 'Lookalike Käufer 1%', ads: [{ id: '120210000001001', name: 'Video Starterset 15s' }, { id: '120210000001002', name: 'Karussell Sensoren' }] },
        { id: '120210000000102', name: 'Interessen Arduino Raspberry Pi', ads: [{ id: '120210000001003', name: 'UGC Unboxing' }] },
      ],
    },
    {
      id: '120210000000002',
      name: 'DE Retargeting Warenkorb 7 Tage',
      budget: 45,
      adsets: [{ id: '120210000000201', name: 'Warenkorb ohne Kauf', ads: [{ id: '120210000002001', name: 'Dynamische Produktanzeige' }] }],
    },
    {
      id: '120210000000003',
      name: 'DE Advantage+ Shopping',
      budget: 115,
      adsets: [{ id: '120210000000301', name: 'Advantage+ Zielgruppe', ads: [{ id: '120210000003001', name: 'Katalog Bestseller' }, { id: '120210000003002', name: 'Video Roboter Kit' }] }],
    },
  ],
  google_ads: [
    { id: '21234567801', name: 'Search Marke', budget: 30, adsets: [{ id: '1561234500001', name: 'Marke exakt', ads: [{ id: '689012340001', name: 'RSA Marke' }] }] },
    {
      id: '21234567802',
      name: 'Search Arduino Sets',
      budget: 105,
      adsets: [
        { id: '1561234500002', name: 'Starterset', ads: [{ id: '689012340002', name: 'RSA Starterset' }] },
        { id: '1561234500003', name: 'Sensoren', ads: [{ id: '689012340003', name: 'RSA Sensoren' }] },
      ],
    },
    { id: '21234567803', name: 'PMax Shopping Alle Produkte', budget: 120, adsets: [] },
  ],
  tiktok: [
    {
      id: '1790000000001',
      name: 'Maker Hacks Videos',
      budget: 50,
      adsets: [{ id: '1790000000101', name: 'Interessen DIY', ads: [{ id: '1790000001001', name: 'Hack Nachtlicht' }, { id: '1790000001002', name: 'Hack Pflanzensensor' }] }],
    },
  ],
  pinterest: [
    {
      id: '626000000001',
      name: 'Bastelideen Elektronik',
      budget: 25,
      adsets: [{ id: '2680000000001', name: 'Basteln und DIY', ads: [{ id: '6870000000001', name: 'Pin LED Projekt' }, { id: '6870000000002', name: 'Pin Roboter Kit' }] }],
    },
  ],
};
const AWIN_PUBLISHERS = [
  { id: '101001', name: 'Gutscheinportal' },
  { id: '101002', name: 'Cashback Club' },
  { id: '101003', name: 'Maker Blog' },
];

type Random = () => number;

function pick<T>(rnd: Random, items: [T, number][]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rnd() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1][0];
}

function token(rnd: Random, length = 18) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < length; i++) text += chars[Math.floor(rnd() * chars.length)];
  return text;
}

const PAGES = ['/', '/collections/arduino', '/products/starterset-uno', '/products/sensor-kit-37', '/products/esp32-board', '/products/roboter-kit', '/blogs/projekte/nachtlicht'];

interface Entry {
  url: string;
  referrer: string | null;
  adKey?: string;
}

function entryFor(rnd: Random, channel: string, ts: number, week: number): Entry {
  const page = PAGES[Math.floor(rnd() * PAGES.length)];
  const base = `https://${DEMO_DOMAIN}${page}`;
  const enc = encodeURIComponent;
  const pickAd = (campaigns: Campaign[]) => {
    const campaign = pick(rnd, campaigns.map((c) => [c, c.budget] as [Campaign, number]));
    const adset = campaign.adsets.length ? campaign.adsets[Math.floor(rnd() * campaign.adsets.length)] : null;
    const ad = adset ? adset.ads[Math.floor(rnd() * adset.ads.length)] : null;
    return { campaign, adset, ad };
  };
  switch (channel) {
    case 'meta': {
      const { campaign, adset, ad } = pickAd(CATALOG.meta);
      if (rnd() < 0.12) return { url: `${base}?fbclid=IwAR${token(rnd)}`, referrer: 'https://l.facebook.com/' };
      const referrer = rnd() < 0.55 ? 'https://l.instagram.com/' : 'https://l.facebook.com/';
      return {
        url:
          `${base}?utm_source=meta&utm_medium=paid&utm_campaign=${enc(campaign.name)}&utm_content=${enc(ad!.name)}` +
          `&bzf_src=meta&bzf_cid=${campaign.id}&bzf_gid=${adset!.id}&bzf_aid=${ad!.id}&fbclid=IwAR${token(rnd)}`,
        referrer,
        adKey: `meta|${campaign.id}|${adset!.id}|${ad!.id}`,
      };
    }
    case 'google_ads': {
      const { campaign, adset, ad } = pickAd(CATALOG.google_ads);
      const ids = adset ? `&bzf_gid=${adset.id}&bzf_aid=${ad!.id}` : '';
      return {
        url: `${base}?utm_source=google&utm_medium=cpc&bzf_src=google&bzf_cid=${campaign.id}${ids}&gclid=Cj0KCQ${token(rnd, 24)}`,
        referrer: 'https://www.google.com/',
        adKey: `google_ads|${campaign.id}|${adset?.id ?? ''}|${ad?.id ?? ''}`,
      };
    }
    case 'tiktok': {
      const { campaign, adset, ad } = pickAd(CATALOG.tiktok);
      return {
        url:
          `${base}?utm_source=tiktok&utm_medium=paid&utm_campaign=${enc(campaign.name)}` +
          `&bzf_src=tiktok&bzf_cid=${campaign.id}&bzf_gid=${adset!.id}&bzf_aid=${ad!.id}&ttclid=E.C.P.${token(rnd)}`,
        referrer: null,
        adKey: `tiktok|${campaign.id}|${adset!.id}|${ad!.id}`,
      };
    }
    case 'pinterest': {
      const { campaign, adset, ad } = pickAd(CATALOG.pinterest);
      return {
        url:
          `${base}?utm_source=pinterest&utm_medium=paid&utm_campaign=${enc(campaign.name)}` +
          `&bzf_src=pinterest&bzf_cid=${campaign.id}&bzf_gid=${adset!.id}&bzf_aid=${ad!.id}&epik=dj0y${token(rnd)}`,
        referrer: 'https://www.pinterest.de/',
        adKey: `pinterest|${campaign.id}|${adset!.id}|${ad!.id}`,
      };
    }
    case 'awin': {
      const publisher = AWIN_PUBLISHERS[Math.floor(rnd() * AWIN_PUBLISHERS.length)];
      return {
        url:
          `${base}?utm_source=awin&utm_medium=affiliate&utm_campaign=${enc(publisher.name)}&bzf_cid=${publisher.id}` +
          `&awc=14583_${Math.floor(ts / 1000)}_${token(rnd, 12)}`,
        referrer: publisher.id === '101003' ? 'https://www.maker-blog.example/' : null,
        adKey: `awin|${publisher.id}||`,
      };
    }
    case 'klaviyo': {
      const name = rnd() < 0.6 ? `Newsletter KW ${week}` : rnd() < 0.5 ? 'Flow Warenkorbabbruch' : 'Flow Willkommen';
      return {
        url: `${base}?utm_source=klaviyo&utm_medium=email&utm_campaign=${enc(name)}&_kx=${token(rnd, 22)}`,
        referrer: rnd() < 0.4 ? 'https://mail.google.com/' : null,
      };
    }
    case 'organic_search':
      return { url: base, referrer: pick(rnd, [['https://www.google.com/', 80], ['https://www.bing.com/', 8], ['https://www.ecosia.org/', 7], ['https://duckduckgo.com/', 5]]) };
    case 'organic_social':
      return { url: base, referrer: pick(rnd, [['https://www.youtube.com/', 45], ['https://www.instagram.com/', 25], ['https://www.reddit.com/', 20], ['https://www.tiktok.com/', 10]]) };
    case 'referral':
      return { url: base, referrer: pick(rnd, [['https://forum.mikrocontroller.example/thread/42', 60], ['https://www.heise.de/', 25], ['https://www.idealo.de/', 15]]) };
    case 'ai_assistant':
      return { url: base, referrer: pick(rnd, [['https://chatgpt.com/', 70], ['https://www.perplexity.ai/', 30]]) };
    default:
      return { url: base, referrer: null };
  }
}

const ACQUISITION: [string, number][] = [
  ['meta', 24], ['google_ads', 20], ['organic_search', 17], ['direct', 9], ['tiktok', 7], ['pinterest', 3],
  ['awin', 3], ['organic_social', 6], ['referral', 4], ['klaviyo', 4], ['ai_assistant', 3],
];
const RETURNING: [string, number][] = [
  ['direct', 26], ['klaviyo', 15], ['google_ads', 15], ['meta', 13], ['organic_search', 12], ['awin', 9], ['tiktok', 3], ['pinterest', 2], ['organic_social', 3], ['ai_assistant', 2],
];
const CONVERSION_RATE: Record<string, number> = {
  meta: 0.017, google_ads: 0.036, tiktok: 0.008, pinterest: 0.01, awin: 0.07, klaviyo: 0.05, organic_search: 0.024,
  direct: 0.035, organic_social: 0.008, referral: 0.016, ai_assistant: 0.03,
};
// Wer über Social Ads kommt, lehnt das Cookie Banner häufiger ab als Suchende und Stammkunden
const CONSENT_RATE: Record<string, number> = {
  meta: 0.68, tiktok: 0.58, organic_social: 0.64, pinterest: 0.7, awin: 0.74, referral: 0.8, google_ads: 0.86, organic_search: 0.88,
  ai_assistant: 0.86, direct: 0.86, klaviyo: 0.92,
};
// was Käufer auf die Frage nach dem Kauf antworten, je nach erstem Kanal; jede vierte Antwort ist ungenau
const SURVEY_ANSWERS_FOR: Record<string, string[]> = {
  google_ads: ['google'], organic_search: ['google'], meta: ['instagram_facebook'], tiktok: ['tiktok'], pinterest: ['pinterest'],
  klaviyo: ['newsletter'], awin: ['deals'], referral: ['deals', 'other'], ai_assistant: ['ai'], direct: ['friends', 'google'],
  organic_social: ['instagram_facebook', 'tiktok', 'youtube'],
};

interface DemoSession {
  id: string;
  vid: string | null;
  ts: number;
  touch: Touch;
  url: string;
  referrer: string | null;
  device: string;
  adKey?: string;
}

// Tabellen und Spalten sind Konstanten aus diesem Modul, die Werte gehen als Parameter
async function insertMany(q: Queryable, table: string, columns: string[], rows: unknown[][]) {
  const batchSize = Math.max(1, Math.floor(30000 / columns.length));
  for (let start = 0; start < rows.length; start += batchSize) {
    const params: unknown[] = [];
    const tuples = rows.slice(start, start + batchSize).map((row, rowIndex) => {
      params.push(...row);
      return `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(',')})`;
    });
    await q.query(`insert into ${table} (${columns.join(',')}) values ${tuples.join(',')} on conflict do nothing`, params);
  }
}

export interface DemoResult {
  site: Site;
  email: string;
  password: string;
  secretKey: string;
  orders: number;
  sessions: number;
}

/**
 * Demo Shop für Screenshots mit Sessions über verschiedene Kanäle, je nach Kanal 58 bis 92 Prozent Einwilligung, geräteübergreifenden
 * Käufen, Antworten auf die Frage nach dem Kauf und Plattformzahlen, die wie in der Praxis über den echten liegen.
 */
export async function seedDemo(q: Queryable, opts: { days?: number; visitorsPerDay?: number; seed?: number } = {}): Promise<DemoResult> {
  const days = opts.days ?? 45;
  const visitorsPerDay = opts.visitorsPerDay ?? 650;
  const rnd = mulberry32(opts.seed ?? 20261104);
  const email = 'demo@bezzify.local';
  const password = 'bezzify-demo';

  const workspaceId = await createWorkspace(q, 'Demo');
  await createUser(q, { email, password, name: 'Demo', workspaceId });
  const { site, secretKey } = await createSite(q, {
    workspaceId,
    name: 'Demo Elektronik Shop',
    platform: 'shopify',
    domains: [DEMO_DOMAIN],
  });
  const classifyOptions = { siteHosts: site.domains, clickIdWithoutParams: site.settings.clickIdWithoutParams };
  const tz = site.timezone;
  const now = Date.now();
  const today = zonedDay(now, tz);
  const firstDay = addDays(today, -(days - 1));
  const startTs = zonedStartOfDay(firstDay, tz).getTime();

  const sessions: DemoSession[] = [];
  const identities: unknown[][] = [];
  const orders: unknown[][] = [];
  const events: unknown[][] = [];
  const surveyAnswers: unknown[][] = [];
  const orderTouches: { ts: number; total: number; net: number; touches: DemoSession[] }[] = [];
  const knownEmails: string[] = [];
  const customerOrders = new Map<string, number>();
  let sessionNo = 0;
  let orderNo = 10000;

  const newSession = (vid: string | null, ts: number, channel: string, week: number): DemoSession => {
    const entry = entryFor(rnd, channel, ts, week);
    const touch = classify(entry.url, entry.referrer, classifyOptions);
    return {
      id: `s_demo_${++sessionNo}`,
      vid,
      ts,
      touch: vid ? touch : { ...touch, clickId: null },
      url: entry.url,
      referrer: entry.referrer,
      device: rnd() < 0.68 ? 'mobile' : rnd() < 0.9 ? 'desktop' : 'tablet',
      adKey: entry.adKey,
    };
  };

  const dailyFactor = (ts: number) => {
    const weekday = new Date(ts).getUTCDay();
    return weekday === 0 ? 1.15 : weekday === 6 ? 0.85 : 1;
  };

  for (let dayIndex = 0; dayIndex < days; dayIndex++) {
    const dayStart = startTs + dayIndex * 86_400_000;
    const visitors = Math.round(visitorsPerDay * dailyFactor(dayStart) * (0.9 + rnd() * 0.2));
    for (let visitor = 0; visitor < visitors; visitor++) {
      const firstChannel = pick(rnd, ACQUISITION);
      const consent = rnd() < (CONSENT_RATE[firstChannel] ?? 0.8);
      const vid = consent ? randomId('', 16) : null;
      let ts = dayStart + Math.floor(rnd() * 86_400_000);
      if (ts > now) continue;
      const week = Math.ceil((new Date(ts).getUTCDate() + 6) / 7) + 40;
      const journey: DemoSession[] = [newSession(vid, ts, firstChannel, week)];
      const returnVisits = rnd() < 0.42 ? 1 + Math.floor(rnd() * 3) : 0;
      let converted = false;
      let newsletterEmail: string | null = null;
      if (consent && rnd() < 0.12) newsletterEmail = `newsletter${sessionNo}@example.org`;
      for (let i = 0; i <= returnVisits && !converted; i++) {
        if (i > 0) {
          ts += Math.floor((0.2 + rnd() * 4) * 86_400_000);
          if (ts > now - 60_000) break;
          const channel = rnd() < 0.1 ? firstChannel : pick(rnd, RETURNING);
          journey.push(newSession(vid, ts, channel, week));
        }
        const session = journey[journey.length - 1];
        const conversionRate = (CONVERSION_RATE[session.touch.channel] ?? 0.02) * (1 + 0.45 * i);
        if (rnd() < conversionRate) converted = true;
      }
      for (const session of journey) if (vid || session === journey[0]) sessions.push(session);
      if (newsletterEmail && vid) {
        identities.push([site.id, vid, 'email_sha256', sha256Hex(newsletterEmail), new Date(journey[0].ts), new Date(journey[0].ts)]);
      }
      if (!converted) continue;

      const lastSession = journey[journey.length - 1];
      const orderTs = Math.min(now - 30_000, lastSession.ts + Math.floor((3 + rnd() * 25) * 60_000));
      const returning = knownEmails.length > 20 && rnd() < 0.22;
      const buyer = newsletterEmail ?? (returning ? knownEmails[Math.floor(rnd() * knownEmails.length)] : `kunde${sessionNo}@example.org`);
      if (!returning) knownEmails.push(buyer);
      const prior = customerOrders.get(buyer) ?? 0;
      customerOrders.set(buyer, prior + 1);
      let total = Math.min(650, Math.max(9, Math.exp(Math.log(46) + 0.55 * (rnd() + rnd() + rnd() - 1.5) * 1.6)));
      const shipping = total < 60 ? 4.95 : 0;
      total = round2(total + shipping);
      const tax = round2(((total - shipping) * 19) / 119);
      const emailHash = sha256Hex(buyer);
      let orderVid = vid;
      // jeder zehnte Kauf mit Einwilligung passiert auf einem zweiten Gerät
      if (vid && rnd() < 0.1) {
        orderVid = randomId('', 16);
        sessions.push(newSession(orderVid, orderTs - 8 * 60_000, 'direct', week));
        identities.push([site.id, vid, 'email_sha256', emailHash, new Date(journey[0].ts), new Date(journey[0].ts)]);
      }
      if (orderVid) identities.push([site.id, orderVid, 'email_sha256', emailHash, new Date(orderTs), new Date(orderTs)]);
      const orderId = `ord_demo_${++orderNo}`;
      const externalId = String(5_100_000_000 + orderNo);
      const refunded = rnd() < 0.03 ? total : 0;
      const landing = !vid && rnd() < 0.6 ? journey[0] : null;
      orders.push([
        orderId, site.id, externalId, `#${orderNo}`, new Date(orderTs), 'EUR', total, tax, shipping, 0, refunded,
        'paid', false, customerKey(site.id, buyer), emailHash, prior === 0, orderVid, landing?.url ?? null, landing?.referrer ?? null,
        JSON.stringify([{ id: '8001', sku: 'FD-UNO-SET', name: 'Arduino kompatibles Starterset', quantity: 1, price: total - shipping }]),
        vid ? encrypt({ ip: '203.0.113.10', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }) : null,
        vid ? new Date() : null, !!vid, 'webhook',
      ]);
      if (rnd() < 0.4) {
        const truthful = SURVEY_ANSWERS_FOR[firstChannel] ?? ['other'];
        const options = rnd() < 0.75 ? truthful : defaultSurvey.answers.map((answer) => answer.id);
        surveyAnswers.push([site.id, `order:${externalId}`, options[Math.floor(rnd() * options.length)], new Date(orderTs + 90_000)]);
      }
      if (orderVid) {
        const props = JSON.stringify({ order_id: externalId, value: total, currency: 'EUR' });
        const thankYou = `https://${DEMO_DOMAIN}/checkouts/thank-you`;
        const sessionId = sessions[sessions.length - 1].id;
        events.push([site.id, `e_demo_p_${orderNo}`, sessionId, orderVid, 'purchase', new Date(orderTs), thankYou, props]);
      }
      orderTouches.push({ ts: orderTs, total, net: total - tax - shipping, touches: journey.filter((s) => !!vid || s === journey[0]) });
    }
  }

  // ein paar Besuche in den letzten Minuten für die Live Ansicht
  for (let i = 0; i < 25; i++) {
    const vid = randomId('', 16);
    const ts = now - Math.floor(rnd() * 28 * 60_000);
    sessions.push(newSession(vid, ts, pick(rnd, ACQUISITION), 45));
  }

  for (const { id, vid, ts, url } of sessions) {
    if (vid) events.push([site.id, `e_demo_${id}`, id, vid, 'page_view', new Date(ts), url, JSON.stringify({})]);
  }

  await insertMany(
    q,
    'sessions',
    ['id', 'site_id', 'visitor_id', 'started_at', 'last_seen_at', 'channel', 'source', 'medium', 'campaign', 'content', 'term', 'is_paid',
      'click_id_type', 'click_id', 'ext_campaign_id', 'ext_adset_id', 'ext_ad_id', 'landing_url', 'referrer', 'device', 'pageviews', 'event_count', 'consent'],
    sessions.map((session) => {
      const { touch } = session;
      const channel = touch.channel === 'internal' ? 'direct' : touch.channel;
      const pageviews = 1 + Math.floor(rnd() * 6);
      return [session.id, site.id, session.vid, new Date(session.ts), new Date(session.ts + pageviews * 45_000), channel, touch.source,
        touch.medium, touch.campaign, touch.content, touch.term, touch.isPaid, touch.clickIdType, touch.clickId, touch.extCampaignId,
        touch.extAdsetId, touch.extAdId, session.url, session.referrer, session.device, pageviews, pageviews, !!session.vid];
    }),
  );
  await insertMany(q, 'identities', ['site_id', 'visitor_id', 'kind', 'value', 'first_seen', 'last_seen'], identities);
  await insertMany(
    q,
    'orders',
    ['id', 'site_id', 'external_id', 'order_number', 'created_at', 'currency', 'total', 'tax', 'shipping', 'discount', 'refunded', 'status',
      'is_test', 'customer_key', 'email_sha256', 'is_new_customer', 'visitor_id', 'landing_url', 'referrer', 'items', 'match_data',
      'match_data_at', 'consent_marketing', 'source'],
    orders,
  );
  await insertMany(q, 'events', ['site_id', 'id', 'session_id', 'visitor_id', 'name', 'ts', 'url', 'props'], events);
  await insertMany(q, 'survey_answers', ['site_id', 'ref', 'answer', 'created_at'], surveyAnswers);
  await q.query('update sites set settings = settings || $2::jsonb where id = $1', [site.id, JSON.stringify({ survey: { ...defaultSurvey, enabled: true } })]);

  // Klicks je Anzeige und Tag leiten sich aus den Sessions ab
  const sessionsPerAdDay = new Map<string, number>();
  for (const session of sessions) {
    if (!session.adKey) continue;
    const key = `${zonedDay(session.ts, tz)}|${session.adKey}`;
    sessionsPerAdDay.set(key, (sessionsPerAdDay.get(key) ?? 0) + 1);
  }
  // Jede Plattform zählt wie in der Praxis Käufe mit eigenem Klick im Fenster, ohne Deduplizierung
  const platformClaims = new Map<string, { conv: number; rev: number }>();
  const awinCommission = new Map<string, { spend: number; conv: number; rev: number }>();
  for (const order of orderTouches) {
    const day = zonedDay(order.ts, tz);
    const claimed = new Set<string>();
    for (const session of order.touches) {
      if (!session.adKey) continue;
      const windowDays = session.adKey.startsWith('google_ads') ? 30 : 7;
      if (order.ts - session.ts > windowDays * 86_400_000 || claimed.has(session.adKey)) continue;
      claimed.add(session.adKey);
      const key = `${day}|${session.adKey}`;
      const claim = platformClaims.get(key) ?? { conv: 0, rev: 0 };
      claim.conv += 1;
      claim.rev += order.total;
      platformClaims.set(key, claim);
    }
    const lastPaid = [...order.touches].reverse().find((session) => PAID_CHANNELS.has(session.touch.channel));
    if (lastPaid?.touch.channel === 'awin' && lastPaid.adKey) {
      const key = `${day}|${lastPaid.adKey}`;
      const commission = awinCommission.get(key) ?? { spend: 0, conv: 0, rev: 0 };
      commission.spend += order.net * 0.08;
      commission.conv += 1;
      commission.rev += order.total;
      awinCommission.set(key, commission);
    }
  }

  const costRows: unknown[][] = [];
  for (const day of dayList(firstDay, today)) {
    const partial = day === today ? Math.max(0.05, (now - zonedStartOfDay(day, tz).getTime()) / 86_400_000) : 1;
    for (const [platform, campaigns] of Object.entries(CATALOG)) {
      for (const campaign of campaigns) {
        const units = campaign.adsets.length
          ? campaign.adsets.flatMap((adset) => adset.ads.map((ad) => ({ adset, ad })))
          : [{ adset: null, ad: null }];
        for (const { adset, ad } of units) {
          const adKey = `${platform}|${campaign.id}|${adset?.id ?? ''}|${ad?.id ?? ''}`;
          const spend = round2((campaign.budget / units.length) * (0.8 + rnd() * 0.4) * partial);
          const adSessions = sessionsPerAdDay.get(`${day}|${adKey}`) ?? 0;
          const cpm = platform === 'google_ads' ? 28 : platform === 'meta' ? 9 : 6;
          const claim = platformClaims.get(`${day}|${adKey}`);
          costRows.push([site.id, day, platform, platform, campaign.id, campaign.name, adset?.id ?? '', adset?.name ?? null, ad?.id ?? '',
            ad?.name ?? null, spend, Math.round((spend / cpm) * 1000), Math.round(adSessions * (1.15 + rnd() * 0.3)), claim?.conv ?? 0,
            claim ? round2(claim.rev) : 0]);
        }
      }
    }
  }
  for (const [key, commission] of awinCommission) {
    const [day, , publisherId] = key.split('|');
    const publisher = AWIN_PUBLISHERS.find((p) => p.id === publisherId);
    costRows.push([site.id, day, 'awin', 'awin', publisherId, publisher ? `Publisher ${publisher.name}` : publisherId, '', null, '', null,
      round2(commission.spend), 0, 0, commission.conv, round2(commission.rev)]);
  }
  await insertMany(
    q,
    'costs',
    ['site_id', 'date', 'platform', 'channel', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'spend',
      'impressions', 'clicks', 'platform_conversions', 'platform_revenue'],
    costRows,
  );

  for (let month = 0; month < Math.ceil(days / 30) + 1; month++) {
    const dayInMonth = addDays(today, -month * 30);
    const from = dayInMonth.slice(0, 8) + '01';
    const nextMonth = new Date(Date.UTC(Number(dayInMonth.slice(0, 4)), Number(dayInMonth.slice(5, 7)), 1)).toISOString().slice(0, 10);
    await q.query(
      `insert into manual_costs (id, site_id, channel, label, amount, date_from, date_to) values ($1,$2,'klaviyo','Klaviyo Abo',350,$3,$4)
       on conflict do nothing`,
      [`mc_demo_${from}`, site.id, from, addDays(nextMonth, -1)],
    );
  }

  return { site, email, password, secretKey, orders: orders.length, sessions: sessions.length };
}
