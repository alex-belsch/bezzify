export interface MarkovPath {
  channels: string[];
  converted: boolean;
  count?: number;
}

export interface MarkovResult {
  conversionProbability: number;
  removalEffects: Map<string, number>;
  shares: Map<string, number>;
  paths: number;
}

type Transitions = Map<string, [string, number][]>;

const START = '\u0000start';
const CONVERSION = '\u0000conv';
const NO_CONVERSION = '\u0000null';

function collapseRepeats(channels: string[]): string[] {
  const collapsed: string[] = [];
  for (const channel of channels) if (collapsed.at(-1) !== channel) collapsed.push(channel);
  return collapsed;
}

// Gauß Jordan statt Iteration, die bei langen Pfaden mit Wechseln zwischen zwei Kanälen kaum konvergiert
function conversionProbability(states: string[], transitions: Transitions, removed: string | null): number {
  const active = states.filter((state) => state !== removed);
  const index = new Map(active.map((state, i) => [state, i]));
  const size = active.length;
  // je Zustand s gilt p(s) = P(s, Conversion) + Σ P(s, t) p(t), der entfernte Kanal zählt wie ein Abbruch
  const rows = active.map((state, i) => {
    const row = new Array<number>(size + 1).fill(0);
    row[i] = 1;
    for (const [target, probability] of transitions.get(state) ?? []) {
      if (target === CONVERSION) row[size] += probability;
      else if (index.has(target)) row[index.get(target)!] -= probability;
    }
    return row;
  });
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let i = col + 1; i < size; i++) if (Math.abs(rows[i][col]) > Math.abs(rows[pivot][col])) pivot = i;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const lead = rows[col][col];
    if (lead === 0) continue;
    for (let i = 0; i < size; i++) {
      const factor = rows[i][col] / lead;
      if (i === col || factor === 0) continue;
      for (let k = col; k <= size; k++) rows[i][k] -= factor * rows[col][k];
    }
  }
  const start = index.get(START)!;
  return rows[start][size] / rows[start][start];
}

/** Removal Effect je Kanal, also wie stark die Conversion Wahrscheinlichkeit fällt, wenn der Kanal aus allen Pfaden fehlt. */
export function markov(paths: MarkovPath[]): MarkovResult {
  const counts = new Map<string, Map<string, number>>();
  const channels = new Set<string>();
  const count = (from: string, to: string, weight: number) => {
    let targets = counts.get(from);
    if (!targets) counts.set(from, (targets = new Map()));
    targets.set(to, (targets.get(to) ?? 0) + weight);
  };
  let pathCount = 0;
  for (const path of paths) {
    const sequence = collapseRepeats(path.channels);
    if (!sequence.length) continue;
    const weight = path.count ?? 1;
    pathCount += weight;
    let previous = START;
    for (const channel of sequence) {
      channels.add(channel);
      count(previous, channel, weight);
      previous = channel;
    }
    count(previous, path.converted ? CONVERSION : NO_CONVERSION, weight);
  }

  const transitions: Transitions = new Map();
  for (const [from, targets] of counts) {
    let total = 0;
    for (const n of targets.values()) total += n;
    transitions.set(
      from,
      [...targets].map(([to, n]) => [to, n / total]),
    );
  }
  const states = [START, ...channels];

  const base = conversionProbability(states, transitions, null);
  const removalEffects = new Map<string, number>();
  const shares = new Map<string, number>();
  if (base <= 0) return { conversionProbability: 0, removalEffects, shares, paths: pathCount };
  let total = 0;
  for (const channel of channels) {
    const effect = Math.max(0, (base - conversionProbability(states, transitions, channel)) / base);
    removalEffects.set(channel, effect);
    total += effect;
  }
  for (const channel of channels) shares.set(channel, total > 0 ? removalEffects.get(channel)! / total : 0);
  return { conversionProbability: base, removalEffects, shares, paths: pathCount };
}
