const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|bingpreview|facebookexternalhit|meta-externalagent|headless|lighthouse|pingdom|gtmetrix|uptime|monitor|python-requests|python-urllib|aiohttp|curl\/|wget|httpclient|okhttp|axios|node-fetch|undici|go-http|java\/|phantomjs|selenium|puppeteer|playwright|prerender|chrome-lighthouse|adsbot|mediapartners|apis-google|feedfetcher|google-inspectiontool|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexitybot|amazonbot|applebot/i;

export function isBot(ua: string | null | undefined): boolean {
  if (!ua || ua.length < 10) return true;
  return BOT_UA.test(ua);
}
