import type { ModelId } from '../sites.js';

export interface Touchpoint {
  ts: number;
  channel: string;
}

export const MODELS: ModelId[] = [
  'last_non_direct',
  'last_click',
  'first_click',
  'linear',
  'position_based',
  'time_decay',
  'data_driven',
];

export const MODEL_LABELS: Record<ModelId, string> = {
  first_click: 'First Click',
  last_click: 'Last Click',
  last_non_direct: 'Last Non Direct',
  linear: 'Linear',
  position_based: 'Positionsbasiert 40/20/40',
  time_decay: 'Zeitverfall',
  data_driven: 'Datengetrieben (Markov)',
};

export function isModel(id: unknown): id is ModelId {
  return typeof id === 'string' && (MODELS as string[]).includes(id);
}

const DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 7;

/** Touchpoints im Fenster vor der Conversion, chronologisch, mit ignoreDirect ohne Direktzugriffe, sofern es andere gibt. */
export function prepareTouches<T extends Touchpoint>(touches: T[], convTs: number, windowDays: number | null, ignoreDirect: boolean): T[] {
  let inWindow = touches
    .filter((t) => t.ts <= convTs && (windowDays === null || convTs - t.ts <= windowDays * DAY))
    .sort((a, b) => a.ts - b.ts);
  if (ignoreDirect && inWindow.some((t) => t.channel !== 'direct')) inWindow = inWindow.filter((t) => t.channel !== 'direct');
  return inWindow;
}

export interface AllocateOptions {
  halfLifeDays?: number;
  /** Removal Effects je Kanal für das datengetriebene Modell */
  channelWeights?: Map<string, number>;
}

/** Anteile je Touchpoint mit Summe 1, die Touchpoints müssen chronologisch sortiert sein. */
export function allocate(model: ModelId, touches: Touchpoint[], opts: AllocateOptions = {}): number[] {
  const n = touches.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  switch (model) {
    case 'first_click':
      return touches.map((_, i) => (i === 0 ? 1 : 0));
    case 'last_click':
    case 'last_non_direct':
      return touches.map((_, i) => (i === n - 1 ? 1 : 0));
    case 'linear':
      return touches.map(() => 1 / n);
    case 'position_based': {
      if (n === 2) return [0.5, 0.5];
      const middle = 0.2 / (n - 2);
      return touches.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : middle));
    }
    case 'time_decay': {
      const halfLifeDays = opts.halfLifeDays !== undefined && opts.halfLifeDays > 0 ? opts.halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
      // Abstand zum letzten Touchpoint statt zur Conversion, gleiche Anteile, aber kein Unterlauf auf 0 bei alten Journeys
      const newest = touches.reduce((max, t) => Math.max(max, t.ts), -Infinity);
      const weights = touches.map((t) => Math.pow(0.5, (newest - t.ts) / (halfLifeDays * DAY)));
      const sum = weights.reduce((a, b) => a + b, 0);
      return weights.map((weight) => weight / sum);
    }
    case 'data_driven': {
      const weights = opts.channelWeights;
      if (!weights || weights.size === 0) return touches.map(() => 1 / n);
      const touchesPerChannel = new Map<string, number>();
      for (const t of touches) touchesPerChannel.set(t.channel, (touchesPerChannel.get(t.channel) ?? 0) + 1);
      let total = 0;
      for (const channel of touchesPerChannel.keys()) total += weights.get(channel) ?? 0;
      if (total <= 0) return touches.map(() => 1 / n);
      return touches.map((t) => (weights.get(t.channel) ?? 0) / total / touchesPerChannel.get(t.channel)!);
    }
  }
}
