/*
 * Bezzify Tracking Skript
 * Einbindung:
 *   <script>window.bezzify=window.bezzify||function(){(bezzify.q=bezzify.q||[]).push(arguments)};</script>
 *   <script async src="https://t.example.de/t.js" data-site="pk_..."></script>
 *
 * Attribute am Script Tag:
 *   data-site           öffentlicher Site Key (Pflicht)
 *   data-consent        required (Standard) | granted | analytics | shopify | shopware | cookiebot
 *                       granted: Skript lädt erst nach Marketing Einwilligung, analytics: nach Statistik Einwilligung
 *   data-cookieless     "true": ohne Einwilligung anonyme Einstiege zählen (ohne Kennung). Nach Ansicht der deutschen
 *                       Datenschutzbehörden braucht auch das eine Einwilligung (§ 25 TDDDG), nur nach rechtlicher Prüfung
 *   data-endpoint       abweichende Serveradresse
 *   data-cookie-domain  z.B. ".myshop.de"
 *   data-spa            "false" schaltet die Erkennung von Seitenwechseln in Single Page Apps ab
 *
 * Einwilligung in zwei Stufen:
 *   Statistik  Messung und Attribution mit Besucher ID, keine Rückspielung an Werbeplattformen
 *   Marketing  zusätzlich Rückspielung der Käufe an Meta, Google, TikTok, Pinterest und Awin
 *
 * API:
 *   bezzify('consent', 'granted')    Marketing (und damit auch Messung) erlaubt
 *   bezzify('consent', 'analytics')  nur Statistik erlaubt
 *   bezzify('consent', 'denied')     abgelehnt
 *   bezzify('consent', { analytics: true, marketing: false })   oder als Zahl 0, 1, 2 wie im Cookie _bzf_c
 *   bezzify('track', 'add_to_cart', { value: 19.9, currency: 'EUR' })   Namen in snake_case
 *   bezzify('identify', { email: 'kunde@example.de' })
 *   bezzify('purchase', { order_id: '1001', value: 59.9, currency: 'EUR', email: '...' })
 *   bezzify('getVisitorId', function (id) { ... })
 */
(function () {
  'use strict';
  var w = window;
  var d = document;
  if (w.__bezzify) return;
  w.__bezzify = true;

  var script =
    d.currentScript ||
    (function () {
      var list = d.querySelectorAll('script[data-site]');
      return list[list.length - 1];
    })();

  function attr(name) {
    return script ? script.getAttribute(name) : null;
  }

  var cfg = {
    site: attr('data-site'),
    endpoint: attr('data-endpoint') || (script && script.src ? new URL(script.src).origin : ''),
    consent: attr('data-consent') || 'required',
    cookieless: attr('data-cookieless') === 'true',
    cookieDomain: attr('data-cookie-domain') || '',
    spa: attr('data-spa') !== 'false',
  };
  if (!cfg.site || !cfg.endpoint) return;

  var ID_COOKIE = '_bzf_id';
  var CONSENT_COOKIE = '_bzf_c';
  var PROBE_COOKIE = '_bzf_t';
  var MAX_AGE = 400 * 24 * 3600;
  var MAX_PENDING = 30;
  // Längere Adressen weist der Server ab, und mit ihnen den ganzen Stapel
  var MAX_URL = 4096;
  var VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;

  var consent = null; // null offen, true Messung erlaubt, false abgelehnt
  var marketing = false;
  var visitorId = null;
  var pending = [];
  var lastUrl = null;
  var rootDomain = null;

  function readCookie(name) {
    var match = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1]; // fremde Cookies wie _fbc können ungültig kodiert sein
    }
  }

  function writeCookie(name, value, maxAge, domain) {
    var cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; SameSite=Lax';
    if (location.protocol === 'https:') cookie += '; Secure';
    d.cookie = domain ? cookie + '; domain=' + domain : cookie;
  }

  function parentDomains() {
    var labels = location.hostname.split('.');
    var domains = [];
    for (var i = labels.length - 2; i >= 0; i--) domains.push(labels.slice(i).join('.'));
    return domains;
  }

  // Breiteste Domain, die der Browser annimmt, damit www und Shop Subdomains dieselbe ID sehen. Geprüft mit Testcookie,
  // weil ein vorhandenes Cookie gleichen Werts sonst auch eine abgelehnte Domain wie co.uk zu bestätigen scheint.
  function cookieDomain() {
    if (cfg.cookieDomain) return cfg.cookieDomain;
    if (rootDomain === null) {
      rootDomain = '';
      var token = randomId();
      var domains = parentDomains();
      for (var i = 0; i < domains.length; i++) {
        d.cookie = PROBE_COOKIE + '=' + token + '; path=/; domain=' + domains[i];
        if (readCookie(PROBE_COOKIE) === token) {
          d.cookie = PROBE_COOKIE + '=; path=/; max-age=0; domain=' + domains[i];
          rootDomain = domains[i];
          break;
        }
      }
    }
    return rootDomain;
  }

  function setCookie(name, value) {
    writeCookie(name, value, MAX_AGE, cookieDomain());
  }

  function deleteCookie(name) {
    var domains = cfg.cookieDomain ? [cfg.cookieDomain] : parentDomains();
    for (var i = 0; i < domains.length; i++) writeCookie(name, '', 0, domains[i]);
    writeCookie(name, '', 0, '');
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    w.crypto.getRandomValues(bytes);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function eventId() {
    return w.crypto.randomUUID ? w.crypto.randomUUID() : randomId();
  }

  function ensureVisitor() {
    var stored = readCookie(ID_COOKIE);
    visitorId = stored && VISITOR_ID.test(stored) ? stored : randomId();
    setCookie(ID_COOKIE, visitorId);
    setCookie(CONSENT_COOKIE, marketing ? '2' : '1');
  }

  function matchCookies() {
    return {
      fbp: readCookie('_fbp'),
      fbc: readCookie('_fbc'),
      ttp: readCookie('_ttp'),
      epik: readCookie('_epik'),
    };
  }

  function viaFetch(url, body) {
    try {
      w.fetch(url, {
        method: 'POST',
        body: body,
        // keepalive überlebt das Verlassen der Seite, erlaubt aber nur 64 KiB
        keepalive: body.length < 60000,
        // nur mit gemeinsamer Cookie Domain setzt der Server die Cookies per Antwort nach
        credentials: cfg.cookieDomain ? 'include' : 'omit',
        headers: { 'Content-Type': 'text/plain' },
      }).catch(function () {}); // Netzfehler beim Tracking gehören nicht in die Konsole des Shops
      return true;
    } catch (e) {
      return false; // fetch, von einem anderen Skript ersetzt, wirft synchron
    }
  }

  function send(events, anonymous) {
    if (!events.length) return;
    var withMarketing = !anonymous && marketing;
    var body = JSON.stringify({
      k: cfg.site,
      v: anonymous ? null : visitorId,
      c: anonymous ? 0 : 1,
      mk: withMarketing ? 1 : 0,
      s: 'web',
      // Werbecookies dienen nur der Rückspielung und gehen nur mit Marketing Einwilligung raus
      m: withMarketing ? matchCookies() : null,
      e: events,
    });
    var url = cfg.endpoint + '/v1/collect';
    if (w.fetch && viaFetch(url, body)) return;
    if (navigator.sendBeacon) navigator.sendBeacon(url, body);
  }

  function clipUrl(url) {
    return url ? url.slice(0, MAX_URL) : null;
  }

  function makeEvent(name, props, url, referrer) {
    return {
      n: name,
      id: eventId(),
      t: Date.now(),
      u: clipUrl(url || location.href),
      r: clipUrl(referrer === undefined ? d.referrer : referrer),
      p: props,
    };
  }

  function anonymize(event) {
    return { n: event.n, t: event.t, u: event.u, r: event.r };
  }

  function emit(event) {
    if (consent === true) send([event], false);
    else if (consent === null) {
      if (pending.length < MAX_PENDING) pending.push(event);
    } else if (cfg.cookieless && event.n === 'page_view') {
      send([anonymize(event)], true);
    }
  }

  /** level 0 abgelehnt, 1 nur Messung, 2 auch Marketing, so steht es auch in _bzf_c für Server und Shop Plugins */
  function setConsent(level) {
    var granted = level > 0;
    var withMarketing = level > 1;
    if (granted === consent && withMarketing === marketing) return;
    var undecided = consent === null;
    var queued = pending;
    consent = granted;
    marketing = withMarketing;
    pending = [];
    if (granted) {
      ensureVisitor();
      send(queued, false);
      return;
    }
    visitorId = null;
    deleteCookie(ID_COOKIE);
    deleteCookie(CONSENT_COOKIE);
    if (undecided && cfg.cookieless) {
      send(queued.filter(function (event) { return event.n === 'page_view'; }).map(anonymize), true);
    }
  }

  function pageView(referrer) {
    var url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    emit(makeEvent('page_view', { title: d.title ? d.title.slice(0, 200) : undefined }, url, referrer));
  }

  // Zahlen entsprechen den Stufen im Cookie _bzf_c: 0 abgelehnt, 1 Statistik, 2 Marketing
  function levelOf(value) {
    if (value && typeof value === 'object') return value.marketing ? 2 : value.analytics || value.statistics ? 1 : 0;
    if (value === 'analytics' || value === 'statistics' || value === 1 || value === '1') return 1;
    return value === true || value === 'granted' || value === 'marketing' || value === 2 || value === '2' ? 2 : 0;
  }

  // Kopie als reines Objekt, damit ein nicht serialisierbarer Wert beim Aufruf auffällt statt später den Stapel zu kippen
  function snapshot(props) {
    var copy = props && typeof props === 'object' ? JSON.parse(JSON.stringify(props)) : null;
    return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : {};
  }

  var api = {
    consent: function (value) {
      setConsent(levelOf(value));
    },
    track: function (name, props) {
      if (typeof name === 'string') emit(makeEvent(name.slice(0, 64), snapshot(props)));
    },
    identify: function (props) {
      emit(makeEvent('identify', snapshot(props)));
    },
    purchase: function (props) {
      emit(makeEvent('purchase', snapshot(props)));
    },
    page: function () {
      pageView();
    },
    getVisitorId: function (callback) {
      if (typeof callback === 'function') callback(consent ? visitorId : null);
    },
  };

  function call(args) {
    var method = api[args[0]];
    if (!method) return;
    try {
      method.apply(null, Array.prototype.slice.call(args, 1));
    } catch (error) {
      // Ein Fehler im Tracking darf den Code des Shops nicht abbrechen
      console.warn('Bezzify: ' + args[0] + ' fehlgeschlagen', error);
    }
  }

  function watchShopify() {
    var check = function () {
      var privacy = w.Shopify && w.Shopify.customerPrivacy;
      if (!privacy) return;
      var withMarketing = privacy.marketingAllowed();
      var choice = privacy.currentVisitorConsent ? privacy.currentVisitorConsent() : {};
      if (withMarketing || privacy.analyticsProcessingAllowed()) setConsent(withMarketing ? 2 : 1);
      else if (consent || choice.analytics === 'no') setConsent(0);
    };
    d.addEventListener('visitorConsentCollected', function (event) {
      var detail = event.detail || {};
      setConsent(detail.marketingAllowed ? 2 : detail.analyticsAllowed ? 1 : 0);
    });
    if (w.Shopify && w.Shopify.loadFeatures) w.Shopify.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], check);
    else check();
  }

  function watchShopware() {
    var levelFrom = function (changed) {
      var allowed = function (name) {
        return changed && name in changed ? !!changed[name] : readCookie(name) === '1';
      };
      return allowed('bezzify-marketing') ? 2 : allowed('bezzify-enabled') ? 1 : 0;
    };
    var initial = levelFrom(null);
    // cookie-preference setzt Shopware, sobald der Besucher entschieden hat, auch beim Ablehnen
    if (initial || consent || readCookie('cookie-preference')) setConsent(initial);
    var subscribed = false;
    var subscribe = function () {
      if (subscribed || !d.$emitter) return;
      subscribed = true;
      // Shopware meldet nur geänderte Einträge, der Rest steht dann schon in den Cookies
      d.$emitter.subscribe('CookieConfiguration_Update', function (event) {
        var changed = event.detail || {};
        if ('bezzify-enabled' in changed || 'bezzify-marketing' in changed) setConsent(levelFrom(changed));
      });
    };
    subscribe();
    d.addEventListener('DOMContentLoaded', subscribe);
    w.addEventListener('load', subscribe);
  }

  function watchCookiebot() {
    var apply = function () {
      var choice = w.Cookiebot && w.Cookiebot.consent;
      if (choice) setConsent(choice.marketing ? 2 : choice.statistics ? 1 : 0);
    };
    w.addEventListener('CookiebotOnConsentReady', apply);
    w.addEventListener('CookiebotOnAccept', apply);
    w.addEventListener('CookiebotOnDecline', apply);
    var state = w.Cookiebot && w.Cookiebot.consent;
    if (!state) return;
    // Vor der Antwort meldet Cookiebot alle Kategorien als abgelehnt, entschieden ist erst mit hasResponse oder method
    if (w.Cookiebot.hasResponse || state.method) apply();
    else if (consent) setConsent(0);
  }

  function detectConsent() {
    var stored = readCookie(CONSENT_COOKIE);
    if (stored === '1' || stored === '2') {
      consent = true;
      marketing = stored === '2';
      ensureVisitor();
    }
    if (cfg.consent === 'granted') setConsent(2);
    else if (cfg.consent === 'analytics') setConsent(marketing ? 2 : 1);
    else if (cfg.consent === 'shopify') watchShopify();
    else if (cfg.consent === 'shopware') watchShopware();
    else if (cfg.consent === 'cookiebot') watchCookiebot();
  }

  var earlyCalls = w.bezzify && w.bezzify.q ? w.bezzify.q : [];
  w.bezzify = function () {
    call(arguments);
  };
  w.bezzify.q = [];

  detectConsent();
  pageView();
  for (var i = 0; i < earlyCalls.length; i++) call(earlyCalls[i]);

  if (cfg.spa) {
    var wrap = function (method) {
      var original = w.history[method];
      w.history[method] = function () {
        var previous = location.href;
        var ret = original.apply(this, arguments);
        // erst nach dem Router, damit der neue Seitentitel schon gesetzt ist
        if (location.href !== previous) setTimeout(function () { pageView(previous); }, 0);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    w.addEventListener('popstate', function () {
      pageView(lastUrl);
    });
  }
})();
