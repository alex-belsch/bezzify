/**
 * Rate Limit im Speicher je Instanz, in festen Zeitfenstern. Am Fensterende wird die ganze Tabelle verworfen,
 * das kostet nichts, egal wie viele Schlüssel ein Angreifer erzeugt.
 */
export class RateLimiter {
  private counts = new Map<string, number>();
  private windowEnds = 0;

  constructor(
    private limit: number,
    private windowMs: number,
    private maxKeys = 100_000,
  ) {}

  private roll(now: number) {
    if (now >= this.windowEnds) {
      this.counts.clear();
      this.windowEnds = now + this.windowMs;
    }
  }

  allow(key: string, now = Date.now()): boolean {
    this.roll(now);
    const attempts = (this.counts.get(key) ?? 0) + 1;
    // Bei voller Tabelle werden neue Schlüssel nicht mehr gezählt, statt den Speicher zu fluten
    if (attempts === 1 && this.counts.size >= this.maxKeys) return true;
    this.counts.set(key, attempts);
    return attempts <= this.limit;
  }

  /** Prüft, ohne zu zählen */
  blocked(key: string, now = Date.now()): boolean {
    this.roll(now);
    return (this.counts.get(key) ?? 0) >= this.limit;
  }

  get size(): number {
    return this.counts.size;
  }
}
