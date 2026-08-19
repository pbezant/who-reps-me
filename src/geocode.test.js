import { geocode, normalizePlace } from './geocode';

// geocode.js's jsonp() helper injects a real <script> tag and waits for it to invoke a
// window-scoped callback — jsdom doesn't execute injected <script> src attributes, so nothing
// would ever call that callback on its own. This spies on document.createElement('script'),
// lets the real element get created (so jsonp()'s `.src =` and `appendChild` calls work
// normally), then — once jsonp() has actually set `.src` — pulls the callback name out of the
// URL's `callback=` param and invokes it directly with the given fake response, exactly like a
// real JSONP response executing would. One call here satisfies exactly one jsonp() call; tests
// that need two (e.g. a coords lookup after a ZIP lookup) call this twice, in order.
function mockNextJsonpResponse(response) {
  const realCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementationOnce((tag) => {
    const el = realCreateElement(tag);
    if (tag === 'script') {
      Promise.resolve().then(() => {
        const cb = el.src.match(/callback=([^&]+)/)?.[1];
        if (cb && window[cb]) window[cb](response);
      });
    }
    return el;
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('normalizePlace', () => {
  test('strips government suffixes and normalizes case/punctuation', () => {
    expect(normalizePlace('Bastrop County')).toBe('bastrop');
    expect(normalizePlace('Elgin city')).toBe('elgin');
  });

  test('tolerates a missing/empty input', () => {
    expect(normalizePlace(null)).toBe('');
    expect(normalizePlace('')).toBe('');
  });
});

describe('geocode() — bare ZIP path (unchanged by the place-name fallback)', () => {
  test('resolves a bare ZIP via zippopotam + the Census coordinates endpoint', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ places: [{ latitude: '30.17', longitude: '-97.63', 'state abbreviation': 'TX', 'place name': 'Buda' }] }),
      })
    );
    mockNextJsonpResponse({
      result: { geographies: { Counties: [{ BASENAME: 'Hays' }] } },
    });

    const geo = await geocode('78610');
    expect(geo).toMatchObject({ state: 'TX', place: 'Buda', county: 'Hays' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('78610'));
  });
});

describe('geocode() — primary street-address match', () => {
  test('returns geo straight from a successful address match, no fallback involved', async () => {
    mockNextJsonpResponse({
      result: {
        addressMatches: [
          {
            coordinates: { x: -97.7, y: 30.3 },
            addressComponents: { state: 'TX' },
            geographies: {
              'Incorporated Places': [{ BASENAME: 'Austin' }],
              Counties: [{ BASENAME: 'Travis' }],
            },
          },
        ],
      },
    });

    const geo = await geocode('301 W 2nd St, Austin, TX');
    expect(geo).toMatchObject({ state: 'TX', place: 'Austin', county: 'Travis' });
  });
});

describe('geocode() — bare "City, State" fallback (the Durango/Pagosa Springs bug)', () => {
  test('falls back to place-name resolution when the primary geocoder finds zero address matches', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => [{ lat: '37.2753', lon: '-107.8801' }],
      })
    );
    // 1st jsonp call: the primary onelineaddress attempt, which comes up empty for a bare city.
    mockNextJsonpResponse({ result: { addressMatches: [] } });
    // 2nd jsonp call: the coordinates lookup geocodeByPlaceName() makes with Nominatim's lat/lon.
    mockNextJsonpResponse({
      result: {
        geographies: {
          'Incorporated Places': [{ BASENAME: 'Durango' }],
          Counties: [{ BASENAME: 'La Plata' }],
          States: [{ STUSAB: 'CO' }],
        },
      },
    });

    const geo = await geocode('Durango, CO');
    expect(geo).toMatchObject({ state: 'CO', place: 'Durango', county: 'La Plata' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('nominatim.openstreetmap.org'),
      expect.anything()
    );
  });

  test('also falls back to place-name resolution when the primary geocoder request itself fails', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => [{ lat: '37.2696', lon: '-107.0089' }] })
    );
    const realCreateElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementationOnce((tag) => {
      const el = realCreateElement(tag);
      if (tag === 'script') {
        Promise.resolve().then(() => el.onerror?.()); // simulate the primary jsonp call failing outright
      }
      return el;
    });
    mockNextJsonpResponse({
      result: { geographies: { Counties: [{ BASENAME: 'Archuleta' }], States: [{ STUSAB: 'CO' }] } },
    });

    const geo = await geocode('Pagosa Springs, CO');
    expect(geo).toMatchObject({ state: 'CO', county: 'Archuleta' });
  });

  test('returns null when the place-name lookup itself finds nothing', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [] }));
    mockNextJsonpResponse({ result: { addressMatches: [] } });

    const geo = await geocode('Nowhereville, ZZ');
    expect(geo).toBeNull();
  });

  test('returns null when the resolved point matches neither a place nor a county', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [{ lat: '0', lon: '0' }] }));
    mockNextJsonpResponse({ result: { addressMatches: [] } });
    mockNextJsonpResponse({ result: { geographies: {} } });

    const geo = await geocode('Somewhere In The Ocean');
    expect(geo).toBeNull();
  });
});

test('geocode() returns null for empty/whitespace-only input without making any request', async () => {
  global.fetch = jest.fn();
  expect(await geocode('')).toBeNull();
  expect(await geocode('   ')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});
