import type { SurveySettings } from '../sites.js';
import type { SurveyTally } from '../survey.js';
import { CHANNEL_LABELS } from '../tracking/classify.js';
import { CUSTOMER_GROUPS, type AttributionResult, type CustomerGroup } from './engine.js';

/**
 * So viele gedachte Antworten nach der Gesamtverteilung kommen zu jeder Gruppe hinzu. Zehn echte Antworten zählen damit
 * zu einem Viertel, hundert zu drei Vierteln, so kippen wenige Antworten die Verteilung nicht.
 */
const PRIOR_ANSWERS = 30;

export interface AnswerCounts {
  id: string;
  label: string;
  tracked: number;
  untracked: number;
}

export interface SurveyCorrection {
  /** je Kanal: wie viel häufiger Käufer ohne Einwilligung eine Antwort geben, die ihn als Einstieg nennt, geglättet */
  factors: Map<string, number>;
  tracked: number;
  untracked: number;
  /** Anteil der Antworten, der sich zwischen beiden Gruppen unterscheidet, 0 bis 1 */
  deviation: number | null;
  answers: AnswerCounts[];
}

export function surveyCorrection(survey: SurveySettings, tallies: SurveyTally[]): SurveyCorrection {
  const answers: AnswerCounts[] = survey.answers.map(({ id, label }) => ({ id, label, tracked: 0, untracked: 0 }));
  const byId = new Map(answers.map((counts) => [counts.id, counts]));
  for (const tally of tallies) {
    // Antworten, die es in der Umfrage nicht mehr gibt, lassen sich keinem Kanal zuordnen
    const counts = byId.get(tally.answer);
    if (counts) counts[tally.tracked ? 'tracked' : 'untracked'] += tally.n;
  }
  let tracked = 0;
  let untracked = 0;
  for (const counts of answers) {
    tracked += counts.tracked;
    untracked += counts.untracked;
  }
  const factors = new Map<string, number>();
  if (!tracked || !untracked) return { factors, tracked, untracked, deviation: null, answers };

  const smoothed = new Map<string, { tracked: number; untracked: number }>();
  let deviation = 0;
  for (const counts of answers) {
    const pooled = (counts.tracked + counts.untracked + 1) / (tracked + untracked + answers.length);
    smoothed.set(counts.id, {
      tracked: (counts.tracked + PRIOR_ANSWERS * pooled) / (tracked + PRIOR_ANSWERS),
      untracked: (counts.untracked + PRIOR_ANSWERS * pooled) / (untracked + PRIOR_ANSWERS),
    });
    deviation += Math.abs(counts.untracked / untracked - counts.tracked / tracked) / 2;
  }

  const rest = survey.answers.filter((answer) => !answer.channels.length);
  for (const channel of Object.keys(CHANNEL_LABELS)) {
    const naming = survey.answers.filter((answer) => answer.channels.includes(channel));
    const group = naming.length ? naming : rest;
    if (!group.length) continue;
    let trackedShare = 0;
    let untrackedShare = 0;
    for (const answer of group) {
      const shares = smoothed.get(answer.id)!;
      trackedShare += shares.tracked;
      untrackedShare += shares.untracked;
    }
    factors.set(channel, untrackedShare / trackedShare);
  }
  return { factors, tracked, untracked, deviation, answers };
}

export interface CreditExtra {
  orders: number;
  revenue: number;
  newOrders: number;
}

export interface Distribution {
  /** je Credit in derselben Reihenfolge wie attribution.credits */
  extras: CreditExtra[];
  /** Gruppen ohne eigene zugeordnete Käufe, für sie gilt die Verteilung aller Käufe */
  pooled: CustomerGroup[];
}

/**
 * Verteilt die Käufe ohne Journey auf die zugeordneten Käufe derselben Kundengruppe. Jeder Kauf zählt dabei so viel mehr, wie
 * sein erster Kanal unter Käufern ohne Einwilligung häufiger genannt wird. Gewichtet wird der ganze Kauf und nicht der einzelne
 * Kanal, denn die Umfrage fragt nach dem Einstieg, den Kauf schließt oft ein anderer Kanal ab.
 * Die Summe bleibt exakt der Umsatz und die Zahl der Käufe ohne Journey.
 */
export function distributeUnattributed(attribution: AttributionResult, factors: Map<string, number>): Distribution {
  const { credits } = attribution;
  const extras: CreditExtra[] = credits.map(() => ({ orders: 0, revenue: 0, newOrders: 0 }));
  const pooled: CustomerGroup[] = [];
  const everyCredit = credits.map((_, i) => i);
  const weight = (i: number) => credits[i].share * (factors.get(credits[i].firstChannel) ?? 1);

  for (const group of CUSTOMER_GROUPS) {
    const missing = attribution.unattributed.byCustomer[group];
    if (!missing.orders) continue;
    const sameGroup = group === 'unknown' ? [] : everyCredit.filter((i) => credits[i].customer === group);
    const pool = sameGroup.length ? sameGroup : everyCredit;
    if (group !== 'unknown' && !sameGroup.length) pooled.push(group);
    const orderWeights = pool.map(weight);
    const revenueWeights = pool.map((i, j) => orderWeights[j] * credits[i].revenue);
    const orderSum = orderWeights.reduce((a, b) => a + b, 0);
    const revenueSum = revenueWeights.reduce((a, b) => a + b, 0);
    if (orderSum <= 0) continue;
    pool.forEach((i, j) => {
      const orderShare = orderWeights[j] / orderSum;
      const revenueShare = revenueSum > 0 ? revenueWeights[j] / revenueSum : orderShare;
      extras[i].orders += missing.orders * orderShare;
      extras[i].revenue += missing.revenue * revenueShare;
      extras[i].newOrders += missing.newOrders * orderShare;
    });
  }
  return { extras, pooled };
}
