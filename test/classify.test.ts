import { describe, expect, it } from 'vitest';
import { classify, touchKey } from '../src/tracking/classify.js';

const opts = { siteHosts: ['myshop.de'] };
const url = (q: string) => `https://myshop.de/products/x${q}`;

describe('classify', () => {
  it('erkennt Meta mit eigenen Parametern bis auf Anzeigenebene', () => {
    const touch = classify(url('?utm_source=meta&utm_medium=paid&utm_campaign=Sale&bzf_src=meta&bzf_cid=111&bzf_gid=222&bzf_aid=333&fbclid=IwAR1'), 'https://l.instagram.com/', opts);
    expect(touch).toMatchObject({ channel: 'meta', isPaid: true, extCampaignId: '111', extAdsetId: '222', extAdId: '333', clickIdType: 'fbclid', campaign: 'Sale' });
  });

  it('wertet fbclid ohne Parameter je nach Einstellung', () => {
    expect(classify(url('?fbclid=abc'), 'https://l.facebook.com/', opts).channel).toBe('meta');
    const organic = classify(url('?fbclid=abc'), 'https://l.facebook.com/', { ...opts, clickIdWithoutParams: 'organic' });
    expect(organic.channel).toBe('organic_social');
    expect(organic.isPaid).toBe(false);
  });

  it('erkennt Google Klick IDs und gad_campaignid', () => {
    expect(classify(url('?gclid=Cj0'), null, opts)).toMatchObject({ channel: 'google_ads', clickIdType: 'gclid', isPaid: true });
    expect(classify(url('?gbraid=0AA'), null, opts).clickIdType).toBe('gbraid');
    expect(classify(url('?gclid=x&gad_campaignid=987'), null, opts).extCampaignId).toBe('987');
  });

  it('erkennt TikTok, Pinterest, Awin und Klaviyo', () => {
    expect(classify(url('?ttclid=E.C.P'), null, opts).channel).toBe('tiktok');
    expect(classify(url('?epik=dj0'), null, opts).channel).toBe('pinterest');
    expect(classify(url('?awc=1234_567_abc'), null, opts)).toMatchObject({ channel: 'awin', clickIdType: 'awc' });
    expect(classify(url('?utm_source=klaviyo&utm_medium=email&utm_campaign=KW44'), null, opts)).toMatchObject({ channel: 'klaviyo', campaign: 'KW44' });
    expect(classify(url('?_kx=abc'), null, opts).channel).toBe('klaviyo');
  });

  it('ordnet UTM ohne Klick ID richtig ein', () => {
    expect(classify(url('?utm_source=google&utm_medium=cpc'), null, opts).channel).toBe('google_ads');
    expect(classify(url('?utm_source=facebook&utm_medium=social'), null, opts).channel).toBe('organic_social');
    expect(classify(url('?utm_source=newsletter&utm_medium=email'), null, opts).channel).toBe('email');
    expect(classify(url('?utm_source=partnerx&utm_medium=affiliate'), null, opts).channel).toBe('affiliate');
    expect(classify(url('?utm_source=ecosia&utm_medium=organic'), null, opts).channel).toBe('organic_search');
  });

  it('ignoriert nicht ersetzte Makros', () => {
    const touch = classify(url('?bzf_src=meta&bzf_cid={{campaign.id}}&bzf_aid=__CID__'), null, opts);
    expect(touch.extCampaignId).toBeNull();
    expect(touch.extAdId).toBeNull();
  });

  it('nutzt den Referrer, wenn keine Parameter da sind', () => {
    expect(classify(url(''), 'https://www.google.de/', opts).channel).toBe('organic_search');
    expect(classify(url(''), 'https://mail.google.com/mail/u/0', opts).channel).toBe('email');
    expect(classify(url(''), 'https://chatgpt.com/', opts).channel).toBe('ai_assistant');
    expect(classify(url(''), 'https://www.youtube.com/watch', opts).channel).toBe('organic_social');
    expect(classify(url(''), 'https://forum.example.org/t/1', opts)).toMatchObject({ channel: 'referral', source: 'forum.example.org' });
    expect(classify(url(''), null, opts).channel).toBe('direct');
  });

  it('wertet eigene Seiten und Zahlungsanbieter nicht als neue Quelle', () => {
    expect(classify(url(''), 'https://myshop.de/cart', opts).channel).toBe('internal');
    expect(classify(url(''), 'https://shop.myshop.de/', opts).channel).toBe('internal');
    expect(classify(url(''), 'https://www.paypal.com/checkoutnow', opts).channel).toBe('internal');
    expect(classify(url(''), 'https://checkout.stripe.com/pay', opts).channel).toBe('internal');
    // Domain fehlt in den Einstellungen, Navigation auf derselben Seite bleibt trotzdem intern
    expect(classify('https://neu-shop.de/produkt', 'https://neu-shop.de/', opts).channel).toBe('internal');
  });

  it('unterscheidet Touchpoints über den Schlüssel', () => {
    const first = classify(url('?gclid=1'), null, opts);
    const second = classify(url('?gclid=2'), null, opts);
    expect(touchKey(first)).not.toBe(touchKey(second));
    expect(touchKey(first)).toBe(touchKey(classify(url('?gclid=1'), null, opts)));
  });
});
