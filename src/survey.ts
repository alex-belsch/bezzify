import { z } from 'zod';
import type { Queryable } from './db/index.js';
import type { Site } from './sites.js';
import { CHANNEL_LABELS } from './tracking/classify.js';

const DAY = 86_400_000;
// Antworten aus mindestens 90 Tagen, sonst hinge die Korrektur bei kurzen Zeiträumen an einer Handvoll Antworten
const TALLY_DAYS = 90;

export const SURVEY_CHANNELS = Object.keys(CHANNEL_LABELS).filter((channel) => channel !== 'internal' && channel !== 'unattributed');

export const SurveySchema = z.object({
  enabled: z.boolean(),
  question: z.string().trim().min(3).max(140),
  answers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]{1,32}$/, 'Kennung nur aus Kleinbuchstaben, Ziffern und Unterstrich'),
        label: z.string().trim().min(1).max(60),
        channels: z.array(z.enum(SURVEY_CHANNELS as [string, ...string[]])).max(SURVEY_CHANNELS.length),
      }),
    )
    .min(2)
    .max(12)
    .refine((answers) => new Set(answers.map((answer) => answer.id)).size === answers.length, 'Jede Antwort braucht eine eigene Kennung'),
});

const CHECKOUT_TOKEN_RE = /^[A-Za-z0-9_.:=-]{8,200}$/;

export const PublicAnswerSchema = z.object({
  k: z.string().min(1).max(64),
  checkout_token: z.string().regex(CHECKOUT_TOKEN_RE),
  answer: z.string().min(1).max(32),
});

export const ServerAnswerSchema = z.object({ answer: z.string().min(1).max(32) });

/** Was Shop Plugins und die Shopify Erweiterung zum Anzeigen brauchen, ohne Kanalzuordnung */
export function publicSurvey(site: Site) {
  const { enabled, question, answers } = site.settings.survey;
  if (!enabled) return { enabled: false as const };
  return { enabled: true as const, question, answers: answers.map(({ id, label }) => ({ id, label })) };
}

export type SaveResult = 'saved' | 'duplicate' | 'unknown_answer';

/** Die erste Antwort je Bestellung gilt, spätere Versuche ändern nichts mehr */
export async function saveSurveyAnswer(q: Queryable, site: Site, ref: string, answer: string): Promise<SaveResult> {
  if (!site.settings.survey.answers.some((known) => known.id === answer)) return 'unknown_answer';
  const inserted = await q.query(
    'insert into survey_answers (site_id, ref, answer) values ($1, $2, $3) on conflict (site_id, ref) do nothing returning ref',
    [site.id, ref, answer],
  );
  return inserted.length ? 'saved' : 'duplicate';
}

export interface SurveyTally {
  answer: string;
  /** Bestellung mit Besucher ID, also mit Einwilligung gemessen */
  tracked: boolean;
  n: number;
}

export async function loadSurveyTallies(q: Queryable, site: Site, fromTs: number, toTs: number): Promise<SurveyTally[]> {
  const since = Math.min(fromTs, toTs - TALLY_DAYS * DAY);
  return q.query<SurveyTally>(
    `select answer, tracked, count(*)::int as n from (
       select distinct on (o.id) a.answer, o.visitor_id is not null as tracked
       from orders o
       join survey_answers a on a.site_id = o.site_id
         and a.ref = any(array['order:' || o.external_id, 'checkout:' || o.checkout_token])
       where o.site_id = $1 and o.created_at >= $2 and o.created_at < $3 and o.status <> 'cancelled' and not o.is_test
         and (o.source <> 'pixel' or not exists (select 1 from orders s where s.site_id = $1 and s.source <> 'pixel'))
       order by o.id, a.created_at
     ) answered
     group by answer, tracked`,
    [site.id, new Date(since), new Date(toTs)],
  );
}

export interface SurveyStats {
  answers: number;
  tracked: number;
  untracked: number;
  /** Antworten, zu denen (noch) keine Bestellung passt */
  unmatched: number;
}

export async function surveyStats(q: Queryable, site: Site, days = 30): Promise<SurveyStats> {
  const since = new Date(Date.now() - days * DAY);
  const [row] = await q.query<SurveyStats>(
    `select count(*)::int as answers,
       count(o.id) filter (where o.visitor_id is not null)::int as tracked,
       count(o.id) filter (where o.visitor_id is null)::int as untracked,
       count(*) filter (where o.id is null)::int as unmatched
     from survey_answers a
     left join lateral (
       select id, visitor_id from orders
       where site_id = a.site_id
         and ((a.ref like 'order:%' and external_id = substr(a.ref, 7))
           or (a.ref like 'checkout:%' and checkout_token = substr(a.ref, 10)))
       limit 1
     ) o on true
     where a.site_id = $1 and a.created_at >= $2`,
    [site.id, since],
  );
  return row ?? { answers: 0, tracked: 0, untracked: 0, unmatched: 0 };
}
