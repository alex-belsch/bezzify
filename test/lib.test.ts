import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashPassword, signToken, verifyPassword, verifyToken } from '../src/lib/crypto.js';
import { customerKey, hashEmail, normalizeExternalId, normalizePhone, truncateIp } from '../src/lib/normalize.js';
import { addDays, dayList, googleDateTime, zonedDay, zonedStartOfDay } from '../src/lib/time.js';

describe('Zeitzonen', () => {
  it('berechnet Tagesbeginn in Berlin auch bei Zeitumstellung', () => {
    expect(zonedStartOfDay('2026-07-01', 'Europe/Berlin').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(zonedStartOfDay('2026-01-15', 'Europe/Berlin').toISOString()).toBe('2026-01-14T23:00:00.000Z');
    // Tag der Umstellung auf Winterzeit
    expect(zonedStartOfDay('2026-10-25', 'Europe/Berlin').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(zonedDay(new Date('2026-10-24T22:30:00Z'), 'Europe/Berlin')).toBe('2026-10-25');
  });

  it('rechnet mit Kalendertagen', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(dayList('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('formatiert Datumswerte für Google Ads', () => {
    expect(googleDateTime(new Date('2026-11-04T14:30:00Z'), 'Europe/Berlin')).toBe('2026-11-04 15:30:00+01:00');
    expect(googleDateTime(new Date('2026-07-04T14:30:00Z'), 'Europe/Berlin')).toBe('2026-07-04 16:30:00+02:00');
  });
});

describe('Normalisierung', () => {
  it('hasht Mailadressen nach Vorgabe der Plattformen', () => {
    expect(hashEmail('  Max.Muster@Example.DE ')).toBe(hashEmail('max.muster@example.de'));
    expect(hashEmail('keine-mail')).toBeNull();
    const hashed = hashEmail('a@b.de')!;
    expect(hashEmail(hashed)).toBe(hashed);
  });

  it('bringt Telefonnummern auf das internationale Format', () => {
    expect(normalizePhone('0171 1234567')).toBe('491711234567');
    expect(normalizePhone('+49 (171) 123-4567')).toBe('491711234567');
    expect(normalizePhone('0048 601 234 567')).toBe('48601234567');
    expect(normalizePhone('123')).toBeNull();
  });

  it('entfernt Shopify GID Präfixe und kürzt IPs', () => {
    expect(normalizeExternalId('gid://shopify/OrderIdentity/5123')).toBe('5123');
    expect(normalizeExternalId(5123)).toBe('5123');
    expect(customerKey('s1', 'gid://shopify/Customer/77')).toBe(customerKey('s1', 77));
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3::');
  });
});

describe('Krypto', () => {
  it('verschlüsselt und signiert', async () => {
    const encrypted = encrypt({ token: 'geheim' });
    expect(encrypted).not.toContain('geheim');
    expect(decrypt(encrypted)).toEqual({ token: 'geheim' });
    // ein Zeichen vor dem Ende verändern, im letzten Zeichen können Füllbits liegen, die nichts ändern
    const flip = (text: string, pos = text.length - 6) => text.slice(0, pos) + (text[pos] === 'A' ? 'B' : 'A') + text.slice(pos + 1);
    expect(decrypt(flip(encrypted))).toBeNull();
    const token = signToken({ uid: 'u1' }, 60);
    expect(verifyToken(token)?.uid).toBe('u1');
    expect(verifyToken(flip(token))).toBeNull();
    const stored = await hashPassword('ein langes passwort');
    expect(await verifyPassword('ein langes passwort', stored)).toBe(true);
    expect(await verifyPassword('falsch', stored)).toBe(false);
  });
});
