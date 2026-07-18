import { zonedTimeToUtc } from '../refresh/scheduler.js';
import { ProviderError } from './errors.js';
import { fetchWithRetry429 } from './http.js';

/**
 * ForexFactory weekly macro calendar (https://nfs.faireconomy.media/ff_calendar_thisweek.xml) --
 * keyless and free, so like feargreed.ts there is no api key. The .xml path is used deliberately:
 * the sibling .json path 429s, while .xml survives behind an edge cache. The feed is flat,
 * hand-rolled XML (not full RSS/Atom), so it's parsed with regex/string ops below rather than
 * pulling in an XML dependency for one shape.
 */

const PATH = '/ff_calendar_thisweek.xml';
const EASTERN_TIME_ZONE = 'America/New_York';

// The host can 429; bounded (unlike CoinGecko's unlimited retries) since this is a single request,
// not hundreds of sequential ones -- there's no throughput reason to keep retrying past a few tries.
const RETRY_OPTIONS = {
  enabled: true,
  initialDelaySeconds: 5,
  maxDelaySeconds: 60,
  jitterSeconds: 3,
  maxAttempts: 3,
};

export interface MacroEvent {
  title: string;
  country: string;
  impact: string;
  /** ISO string, or null when the feed's time isn't a wall-clock time ('All Day', 'Tentative', blank). */
  time_utc: string | null;
  forecast: string | null;
  previous: string | null;
}

export interface ForexFactoryClient {
  weeklyEvents(): Promise<MacroEvent[]>;
}

export interface ForexFactoryClientOptions {
  baseUrl?: string;
  timeoutSeconds?: number;
  userAgent?: string;
}

const EVENT_RE = /<event>([\s\S]*?)<\/event>/g;
const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(am|pm)$/i;

/**
 * Decodes a decimal (`&#39;`) or hex (`&#x27;`) numeric character reference. Range-guarded rather
 * than left to throw: String.fromCodePoint rejects codepoints outside the valid Unicode range, and
 * a malformed feed value should degrade to "leave it alone", not blow up the whole parse.
 */
function decodeNumericEntity(digits: string, isHex: boolean): string {
  const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return `&#${isHex ? 'x' : ''}${digits};`;
  }
}

/** Unescapes the handful of entities the feed actually uses; &amp; must resolve last. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => decodeNumericEntity(digits, false))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_match, digits: string) =>
      decodeNumericEntity(digits, true),
    )
    .replace(/&amp;/g, '&');
}

/**
 * Reads `<tag>value</tag>`, `<tag><![CDATA[value]]></tag>`, or a self-closing `<tag />` (null) --
 * the live feed CDATA-wraps most fields but not `title`, so both forms are accepted everywhere.
 */
function extractField(block: string, tag: string): string | null {
  const pattern = new RegExp(
    `<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
  );
  const match = block.match(pattern);
  if (!match) {
    return null;
  }
  const raw = match[1] ?? match[2] ?? '';
  const value = decodeEntities(raw).trim();
  return value.length > 0 ? value : null;
}

/** null for non-clock times ('All Day', 'Tentative', blank/missing) or an unparseable date. */
function eventTimeUtc(dateText: string | null, timeText: string | null): string | null {
  if (!dateText || !timeText) {
    return null;
  }
  const dateMatch = dateText.match(DATE_RE);
  const timeMatch = timeText.match(TIME_RE);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const month = Number.parseInt(dateMatch[1] as string, 10);
  const day = Number.parseInt(dateMatch[2] as string, 10);
  const year = Number.parseInt(dateMatch[3] as string, 10);
  let hour = Number.parseInt(timeMatch[1] as string, 10) % 12;
  if ((timeMatch[3] as string).toLowerCase() === 'pm') {
    hour += 12;
  }
  const minute = Number.parseInt(timeMatch[2] as string, 10);
  return zonedTimeToUtc(year, month, day, hour, minute, EASTERN_TIME_ZONE).toISOString();
}

/** Exported for unit testing -- pure string parsing, no fetch involved. */
export function parseWeeklyEvents(xml: string): MacroEvent[] {
  if (!/<weeklyevents>/i.test(xml)) {
    throw new ProviderError(`${PATH} returned an unexpected payload shape`);
  }

  const events: MacroEvent[] = [];
  for (const match of xml.matchAll(EVENT_RE)) {
    const block = match[1] ?? '';
    const title = extractField(block, 'title');
    const country = extractField(block, 'country');
    const impact = extractField(block, 'impact');
    if (!title || !country || !impact) {
      continue;
    }
    events.push({
      title,
      country,
      impact,
      time_utc: eventTimeUtc(extractField(block, 'date'), extractField(block, 'time')),
      forecast: extractField(block, 'forecast'),
      previous: extractField(block, 'previous'),
    });
  }
  return events;
}

export class ForexFactoryHttpClient implements ForexFactoryClient {
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly userAgent: string;

  constructor(options: ForexFactoryClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://nfs.faireconomy.media';
    this.timeoutSeconds = options.timeoutSeconds ?? 10;
    this.userAgent = options.userAgent ?? 'codex-crypto-screener/0.2';
  }

  async weeklyEvents(): Promise<MacroEvent[]> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}${PATH}`;
    const response = await fetchWithRetry429(
      url,
      {
        timeoutSeconds: this.timeoutSeconds,
        headers: { Accept: 'application/xml, text/xml, */*', 'User-Agent': this.userAgent },
      },
      RETRY_OPTIONS,
    );
    if (response.status >= 400) {
      throw new ProviderError(
        `${PATH} returned HTTP ${response.status}: ${response.text.slice(0, 500)}`,
      );
    }
    return parseWeeklyEvents(response.text);
  }
}
