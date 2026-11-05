export interface FieldDef {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  type?: 'text' | 'checkbox' | 'select';
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface PlatformDef {
  id: string;
  label: string;
  channel: string;
  costs: boolean;
  feedback: boolean;
  description: string;
  fields: FieldDef[];
}

const feedbackField: FieldDef = {
  key: 'feedback',
  label: 'Käufe an die Plattform zurückspielen',
  type: 'checkbox',
  help: 'Nur aktivieren, wenn keine andere Anbindung (z.B. die offizielle Shop App) bereits Käufe serverseitig sendet, sonst werden Käufe doppelt gezählt.',
};
const testField: FieldDef = { key: 'test_mode', label: 'Testmodus (Rückspielung nur prüfen, nicht zählen)', type: 'checkbox' };

export const PLATFORMS: PlatformDef[] = [
  {
    id: 'meta',
    label: 'Meta (Facebook, Instagram)',
    channel: 'meta',
    costs: true,
    feedback: true,
    description: 'Kosten je Anzeige über die Marketing API, Rückspielung über die Conversions API.',
    fields: [
      { key: 'ad_account_id', label: 'Werbekonto ID', required: true, placeholder: '1234567890 (ohne act_)' },
      { key: 'access_token', label: 'Access Token (System User)', secret: true, required: true, help: 'Berechtigungen ads_read, für die Rückspielung zusätzlich ads_management' },
      { key: 'pixel_id', label: 'Pixel bzw. Dataset ID', placeholder: 'für die Conversions API' },
      { key: 'test_event_code', label: 'Test Event Code', placeholder: 'TEST12345' },
      { key: 'api_version', label: 'API Version', placeholder: 'v26.0' },
      feedbackField,
    ],
  },
  {
    id: 'google_ads',
    label: 'Google Ads',
    channel: 'google_ads',
    costs: true,
    feedback: true,
    description: 'Kosten je Anzeige über die Google Ads API, Upload der Käufe als Klick Conversions (gclid, gbraid, wbraid).',
    fields: [
      { key: 'customer_id', label: 'Kunden ID', required: true, placeholder: '123-456-7890' },
      { key: 'login_customer_id', label: 'Verwaltungskonto ID (MCC)', placeholder: '987-654-3210' },
      { key: 'developer_token', label: 'Developer Token', secret: true, required: true },
      { key: 'client_id', label: 'OAuth Client ID', required: true },
      { key: 'client_secret', label: 'OAuth Client Secret', secret: true, required: true },
      { key: 'refresh_token', label: 'Refresh Token', secret: true, required: true },
      { key: 'conversion_action_id', label: 'Conversion Aktion ID', placeholder: 'Typ: Import von Klicks', help: 'Nur für die Rückspielung nötig' },
      { key: 'api_version', label: 'API Version', placeholder: 'v26' },
      feedbackField,
      testField,
    ],
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    channel: 'tiktok',
    costs: true,
    feedback: true,
    description: 'Kosten je Anzeige über die Business API, Rückspielung über die Events API.',
    fields: [
      { key: 'advertiser_id', label: 'Advertiser ID', required: true },
      { key: 'access_token', label: 'Access Token (Business API)', secret: true, required: true },
      { key: 'pixel_code', label: 'Pixel Code', placeholder: 'für die Events API' },
      { key: 'events_access_token', label: 'Events API Access Token', secret: true, help: 'Wird im Events Manager je Pixel erzeugt' },
      { key: 'test_event_code', label: 'Test Event Code' },
      feedbackField,
    ],
  },
  {
    id: 'pinterest',
    label: 'Pinterest',
    channel: 'pinterest',
    costs: true,
    feedback: true,
    description: 'Kosten je Anzeige über die API v5, Rückspielung über die Conversions API.',
    fields: [
      { key: 'ad_account_id', label: 'Werbekonto ID', required: true },
      { key: 'access_token', label: 'Access Token (ads:read)', secret: true, required: true },
      { key: 'conversion_token', label: 'Conversion Token', secret: true, help: 'Wird im Ads Manager unter Conversions erzeugt' },
      feedbackField,
      testField,
    ],
  },
  {
    id: 'awin',
    label: 'Awin',
    channel: 'awin',
    costs: true,
    feedback: true,
    description: 'Provisionen je Publisher als Kosten, Rückspielung über die Conversion API mit Kanal Deduplizierung.',
    fields: [
      { key: 'advertiser_id', label: 'Advertiser ID', required: true },
      { key: 'api_token', label: 'API Token (Transaktionen)', secret: true, required: true },
      { key: 'conversion_api_key', label: 'Conversion API Key', secret: true, help: 'Für die Rückspielung (x-api-key)' },
      { key: 'commission_group', label: 'Provisionsgruppe', placeholder: 'DEFAULT' },
      { key: 'cookie_days', label: 'Cookie Laufzeit in Tagen', placeholder: '30' },
      feedbackField,
      testField,
    ],
  },
  {
    id: 'shopify',
    label: 'Shopify Webhooks',
    channel: 'shop',
    costs: false,
    feedback: false,
    description: 'Bestellungen und Erstattungen direkt aus Shopify. Das Webhook Secret findest du unter Einstellungen, Benachrichtigungen, Webhooks.',
    fields: [{ key: 'webhook_secret', label: 'Webhook Secret', secret: true, required: true }],
  },
];

export function platformDef(id: string): PlatformDef | undefined {
  return PLATFORMS.find((platform) => platform.id === id);
}
