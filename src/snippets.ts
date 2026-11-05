import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Site } from './sites.js';

export interface UrlTemplate {
  platform: string;
  label: string;
  where: string;
  value: string;
}

/** Vorlagen, damit Klicks bis auf Anzeigenebene den Kosten zugeordnet werden können */
export const URL_TEMPLATES: UrlTemplate[] = [
  {
    platform: 'meta',
    label: 'Meta',
    where: 'Anzeigenebene, Feld URL Parameter (gilt für Facebook und Instagram)',
    value:
      'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&bzf_src=meta&bzf_cid={{campaign.id}}&bzf_gid={{adset.id}}&bzf_aid={{ad.id}}',
  },
  {
    platform: 'google_ads',
    label: 'Google Ads',
    where: 'Kontoeinstellungen, Suffix für finale URL (Auto Tagging für gclid bleibt an)',
    value: 'utm_source=google&utm_medium=cpc&bzf_src=google&bzf_cid={campaignid}&bzf_gid={adgroupid}&bzf_aid={creative}&bzf_kw={keyword}',
  },
  {
    platform: 'tiktok',
    label: 'TikTok',
    where: 'Anzeigenebene, URL Parameter (bei Smart+ __ADID_V2__ statt __CID__)',
    value:
      'utm_source=tiktok&utm_medium=paid&utm_campaign=__CAMPAIGN_NAME__&bzf_src=tiktok&bzf_cid=__CAMPAIGN_ID__&bzf_gid=__AID__&bzf_aid=__CID__',
  },
  {
    platform: 'pinterest',
    label: 'Pinterest',
    where: 'Ziel URL der Anzeige oder Tracking Vorlage der Kampagne',
    value:
      'utm_source=pinterest&utm_medium=paid&utm_campaign={campaign_name}&bzf_src=pinterest&bzf_cid={campaignid}&bzf_gid={adgroupid}&bzf_aid={adid}',
  },
  {
    platform: 'klaviyo',
    label: 'Klaviyo',
    where: 'Einstellungen, UTM Tracking: für Kampagnen und Flows aktivieren, Quelle "klaviyo", Medium "email"',
    value: 'utm_source=klaviyo&utm_medium=email&utm_campaign=<Kampagnenname>',
  },
  {
    platform: 'awin',
    label: 'Awin',
    where: 'Der Parameter awc wird von Awin automatisch angehängt, zusätzliche UTM sind optional',
    value: 'utm_source=awin&utm_medium=affiliate',
  },
];

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function htmlSnippet(site: Site, endpoint: string, consent: string): string {
  const attrs = [`data-site="${escapeAttr(site.publicKey)}"`];
  if (consent && consent !== 'required') attrs.push(`data-consent="${escapeAttr(consent)}"`);
  if (site.settings.cookieDomain) attrs.push(`data-cookie-domain="${escapeAttr(site.settings.cookieDomain)}"`);
  return [
    '<script>window.bezzify=window.bezzify||function(){(bezzify.q=bezzify.q||[]).push(arguments)};</script>',
    `<script async src="${escapeAttr(endpoint)}/t.js" ${attrs.join(' ')}></script>`,
  ].join('\n');
}

function readTemplate(relativePath: string): string | null {
  const file = join(process.cwd(), relativePath);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function shopifyPixel(site: Site, endpoint: string): string | null {
  const template = readTemplate('integrations/shopify/custom-pixel.js');
  return template ? template.replaceAll('__ENDPOINT__', endpoint).replaceAll('__SITE_KEY__', site.publicKey) : null;
}

export function consentSnippet(): string {
  return [
    '// Im Callback deines Cookie Banners aufrufen, sobald die Auswahl feststeht:',
    "bezzify('consent', 'granted');   // Marketing erlaubt: Messung und Rückspielung an Werbeplattformen",
    "bezzify('consent', 'analytics'); // nur Statistik erlaubt: Messung ohne Rückspielung",
    "bezzify('consent', 'denied');    // abgelehnt",
  ].join('\n');
}
