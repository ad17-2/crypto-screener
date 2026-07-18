import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/providers/errors.js';
import type { ForexFactoryClientOptions } from '../../src/providers/forexfactory.js';
import { ForexFactoryHttpClient, parseWeeklyEvents } from '../../src/providers/forexfactory.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/forexfactory-sample.xml',
);

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf-8');
}

function fakeResponse(status: number, text: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => text,
  };
}

describe('parseWeeklyEvents against the saved fixture (a trimmed, real 2026-07-18 capture)', () => {
  const events = parseWeeklyEvents(loadFixture());

  it('parses every event in the fixture', () => {
    expect(events).toHaveLength(11);
  });

  it('filters down to the USD + High impact events, matching the live CPI print set', () => {
    const highUsd = events.filter((event) => event.country === 'USD' && event.impact === 'High');
    expect(highUsd.map((event) => event.title)).toEqual([
      'Core CPI m/m',
      'Core CPI y/y',
      'CPI m/m',
      'CPI y/y',
      'Fed Chairman Warsh Testifies',
    ]);
  });

  it('reads CDATA-wrapped forecast/previous values', () => {
    const cpiMm = events.find((event) => event.title === 'CPI m/m');
    expect(cpiMm).toMatchObject({ forecast: '-0.1%', previous: '0.5%' });
  });

  it('resolves a self-closing empty tag (no forecast, no previous) to null, not an empty string', () => {
    const warsh = events.find((event) => event.title === 'Fed Chairman Warsh Testifies');
    expect(warsh?.forecast).toBeNull();
    expect(warsh?.previous).toBeNull();
  });

  it('hand-verified: 07-15-2026 10:30pm US-Eastern (EDT, UTC-4 in July) crosses into the next UTC day', () => {
    const musalem = events.find((event) => event.title === 'FOMC Member Musalem Speaks');
    expect(musalem?.time_utc).toBe('2026-07-16T02:30:00.000Z');
  });
});

describe("parseWeeklyEvents against hand-built snippets (cases absent from this week's live capture)", () => {
  it('unwraps a CDATA-wrapped title -- the live feed never wraps title, but the format is CDATA elsewhere', () => {
    const xml = `<weeklyevents>
      <event>
        <title><![CDATA[FOMC Press Conference]]></title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-29-2026]]></date>
        <time><![CDATA[2:30pm]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.title).toBe('FOMC Press Conference');
  });

  it("maps a non-clock time ('All Day') to time_utc: null -- absent from this week's calendar", () => {
    const xml = `<weeklyevents>
      <event>
        <title>Independence Day</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-04-2026]]></date>
        <time><![CDATA[All Day]]></time>
        <impact><![CDATA[Holiday]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.time_utc).toBeNull();
  });

  it("maps a non-clock time ('Tentative') to time_utc: null", () => {
    const xml = `<weeklyevents>
      <event>
        <title>Trade Balance</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-21-2026]]></date>
        <time><![CDATA[Tentative]]></time>
        <impact><![CDATA[Medium]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.time_utc).toBeNull();
  });

  it('decodes basic entities (&amp;) in a field value', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Retail Sales m/m &amp; y/y</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.title).toBe('Retail Sales m/m & y/y');
  });

  it('decodes a zero-padded decimal numeric character reference (&#039;)', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Bailey&#039;s Speech</title>
        <country><![CDATA[GBP]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.title).toBe("Bailey's Speech");
  });

  it('decodes a decimal numeric character reference (&#8217;)', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Governor&#8217;s Address</title>
        <country><![CDATA[GBP]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.title).toBe('Governor’s Address');
  });

  it('decodes a hex numeric character reference (&#x2019;)', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Governor&#x2019;s Address</title>
        <country><![CDATA[GBP]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.title).toBe('Governor’s Address');
  });

  it('leaves a malformed numeric character reference untouched instead of throwing', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Broken Ref &#99999999999; Event</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(() => parseWeeklyEvents(xml)).not.toThrow();
    expect(parseWeeklyEvents(xml)[0]?.title).toBe('Broken Ref &#99999999999; Event');
  });

  it('hand-verified: winter EST (UTC-5) -- 12-15-2026 8:30am US-Eastern', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Winter Print</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[12-15-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.time_utc).toBe('2026-12-15T13:30:00.000Z');
  });

  it('hand-verified: noon (EDT, UTC-4) -- 07-15-2026 12:00pm US-Eastern is hour 12, not hour 0', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Noon Print</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-15-2026]]></date>
        <time><![CDATA[12:00pm]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.time_utc).toBe('2026-07-15T16:00:00.000Z');
  });

  it('hand-verified: midnight (EDT, UTC-4) -- 07-15-2026 12:00am US-Eastern is hour 0, not hour 12', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Midnight Print</title>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-15-2026]]></date>
        <time><![CDATA[12:00am]]></time>
        <impact><![CDATA[High]]></impact>
        <forecast />
        <previous />
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)[0]?.time_utc).toBe('2026-07-15T04:00:00.000Z');
  });

  it('skips an event missing a required field (title) rather than throwing', () => {
    const xml = `<weeklyevents>
      <event>
        <country><![CDATA[USD]]></country>
        <date><![CDATA[07-14-2026]]></date>
        <time><![CDATA[8:30am]]></time>
        <impact><![CDATA[High]]></impact>
      </event>
    </weeklyevents>`;

    expect(parseWeeklyEvents(xml)).toEqual([]);
  });

  it('throws ProviderError when the payload is not the expected weeklyevents XML shape', () => {
    expect(() => parseWeeklyEvents('<html>not the calendar feed</html>')).toThrow(ProviderError);
  });
});

describe('ForexFactoryHttpClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<ForexFactoryClientOptions> = {}): ForexFactoryHttpClient {
    return new ForexFactoryHttpClient(overrides);
  }

  it('requests the .xml path, not .json -- .json 429s, .xml survives via edge cache', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, loadFixture()));

    await buildClient({ baseUrl: 'https://nfs.faireconomy.media' }).weeklyEvents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(requestedUrl).toBe('https://nfs.faireconomy.media/ff_calendar_thisweek.xml');
  });

  it('parses the fetched body end to end', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, loadFixture()));

    const events = await buildClient().weeklyEvents();

    expect(events).toHaveLength(11);
  });

  it('throws ProviderError on a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(500, 'internal error'));

    await expect(buildClient().weeklyEvents()).rejects.toBeInstanceOf(ProviderError);
  });

  it('retries a 429 and succeeds once the host stops rate-limiting', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, ''))
      .mockResolvedValueOnce(fakeResponse(200, loadFixture()));

    const promise = buildClient().weeklyEvents();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toHaveLength(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the bounded 429 retries and throws ProviderError', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(fakeResponse(429, ''));

    const promise = buildClient().weeklyEvents();
    const assertion = expect(promise).rejects.toBeInstanceOf(ProviderError);

    // 3 bounded attempts, each delay capped well under 60s -- 200s of virtual time clears all of them.
    await vi.advanceTimersByTimeAsync(200_000);
    await assertion;
  });
});
