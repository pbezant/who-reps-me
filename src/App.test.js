import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import App, { officesFromFieldOffices, mergeOffices, mergeFederalSocial, getLocalOfficials, localScrapeNote, toRepCard } from './App';

// App now renders <Routes>/<Route> internally (see App.js), so every render needs a Router
// context around it — MemoryRouter rather than BrowserRouter since these tests don't touch the
// real URL/history.
function renderApp() {
  return render(<MemoryRouter><App /></MemoryRouter>);
}

test('renders the search page', () => {
  renderApp();
  expect(screen.getByText(/who reps me/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/address or zip code/i)).toBeInTheDocument();
});

test('shows the "help us grow this map" button even before any search has run', () => {
  renderApp();
  expect(screen.getByRole('button', { name: /help us grow this map/i })).toBeInTheDocument();
});

// Drives the router from outside App, so the round trip can be exercised without a real search
// (which would need the network) just to produce a card to click.
function Go({ to, label }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>{label}</button>;
}

test('keeps the typed address across a trip to a profile page and back', async () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Go to="/rep/anything" label="to profile" />
      <Go to="/" label="to results" />
      <App />
    </MemoryRouter>
  );

  // user-event v13 API (no .setup(), calls are synchronous) — see package.json.
  userEvent.type(screen.getByPlaceholderText(/address or zip code/i), '78640');
  expect(screen.getByPlaceholderText(/address or zip code/i)).toHaveValue('78640');

  // Opening a profile unmounts HomePage — and with it SearchBar. That's exactly why the address
  // has to live in App: held inside SearchBar it came back blank, which read as "my search was
  // lost" even though the results themselves had survived the whole time.
  // waitFor because React 18 does not flush the navigate() state update synchronously.
  userEvent.click(screen.getByRole('button', { name: 'to profile' }));
  await waitFor(() => expect(screen.queryByPlaceholderText(/address or zip code/i)).not.toBeInTheDocument());

  userEvent.click(screen.getByRole('button', { name: 'to results' }));
  await waitFor(() => expect(screen.getByPlaceholderText(/address or zip code/i)).toHaveValue('78640'));
});

describe('officesFromFieldOffices', () => {
  test('maps 5calls field_offices (phone + city, no address) onto the shared office shape', () => {
    const offices = officesFromFieldOffices([
      { phone: '210-580-7000', city: 'San Antonio' },
      { phone: '512-691-1200', city: 'Austin' },
    ]);
    expect(offices).toEqual([
      { classification: 'district', name: null, city: 'San Antonio', address: null, phone: '210-580-7000', fax: null, hours: null },
      { classification: 'district', name: null, city: 'Austin', address: null, phone: '512-691-1200', fax: null, hours: null },
    ]);
  });

  test('tolerates a missing/empty field_offices list', () => {
    expect(officesFromFieldOffices(undefined)).toEqual([]);
    expect(officesFromFieldOffices([])).toEqual([]);
  });
});

describe('toRepCard', () => {
  const base = { id: 'tx:austin:mayor:kirk-watson', name: 'Kirk Watson', office: 'Mayor' };

  test('carries body through only when office is also present', () => {
    expect(toRepCard({ ...base, body: 'Austin City Council' }, 'TX').body).toBe('Austin City Council');
    // area already falls back to body when office is absent — repeating it as a separate
    // field would just show the same text twice.
    expect(toRepCard({ name: 'Kirk Watson', body: 'Austin City Council' }, 'TX').body).toBe('');
  });

  test('carries hours/bio through from the bio-page enrichment pass', () => {
    const card = toRepCard({ ...base, hours: 'Mon-Fri 8am-5pm', bio: 'Longtime Austin official.' }, 'TX');
    expect(card.hours).toBe('Mon-Fri 8am-5pm');
    expect(card.bio).toBe('Longtime Austin official.');
  });

  test('maps extracted_at/source_url to verifiedAt/sourceUrl for provenance display', () => {
    const card = toRepCard({ ...base, extracted_at: '2026-08-18T18:11:02.875Z', source_url: 'https://austintexas.gov/council' }, 'TX');
    expect(card.verifiedAt).toBe('2026-08-18T18:11:02.875Z');
    expect(card.sourceUrl).toBe('https://austintexas.gov/council');
  });

  test('passes confidence through as a number, or null when absent/non-numeric', () => {
    expect(toRepCard({ ...base, confidence: 0.5 }, 'TX').confidence).toBe(0.5);
    expect(toRepCard(base, 'TX').confidence).toBeNull();
  });

  test('defaults body/hours/bio/sourceUrl to empty string and verifiedAt/confidence to null', () => {
    const card = toRepCard(base, 'TX');
    expect(card.body).toBe('');
    expect(card.hours).toBe('');
    expect(card.bio).toBe('');
    expect(card.sourceUrl).toBe('');
    expect(card.verifiedAt).toBeNull();
    expect(card.confidence).toBeNull();
  });
});

describe('mergeOffices', () => {
  test('dedupes an office reported by two sources (same city+phone), keeping the fuller entry', () => {
    const fromFieldOffices = [{ classification: 'district', city: 'Austin', address: null, phone: '512-691-1200' }];
    const fromDetails = [{ classification: 'district', city: 'Austin', address: '300 E 8th St', phone: '512-691-1200' }];
    const merged = mergeOffices(fromFieldOffices, fromDetails);
    expect(merged).toHaveLength(1);
    expect(merged[0].address).toBe('300 E 8th St');
  });

  test('keeps offices from different sources that are not the same physical office', () => {
    const merged = mergeOffices(
      [{ city: 'San Antonio', phone: '210-580-7000' }],
      [{ city: 'Austin', phone: '512-691-1200' }]
    );
    expect(merged).toHaveLength(2);
  });

  test('tolerates missing/empty lists', () => {
    expect(mergeOffices()).toEqual([]);
    expect(mergeOffices(undefined, [], null)).toEqual([]);
  });
});

describe('mergeFederalSocial', () => {
  test('surfaces field_offices as offices[] on a federal rep, even with no social match', () => {
    const reps = [
      {
        id: 'C001131',
        area: 'US House',
        field_offices: [{ phone: '210-580-7000', city: 'San Antonio' }],
      },
    ];
    const [rep] = mergeFederalSocial(reps, { federalSocial: {}, federalDetails: {} });
    expect(rep.offices).toEqual([
      { classification: 'district', name: null, city: 'San Antonio', address: null, phone: '210-580-7000', fax: null, hours: null },
    ]);
  });

  test('still merges social links onto a federal rep alongside offices', () => {
    const reps = [{ id: 'C001131', area: 'US Senate', field_offices: [] }];
    const federalSocial = { C001131: { twitter: 'https://twitter.com/rep' } };
    const [rep] = mergeFederalSocial(reps, { federalSocial, federalDetails: {} });
    expect(rep.social).toEqual({ twitter: 'https://twitter.com/rep' });
    expect(rep.offices).toEqual([]);
  });

  test('merges term_end/committees/bio and folds dc_office/district_offices into offices[]', () => {
    const reps = [{ id: 'C000127', area: 'US Senate', field_offices: [] }];
    const federalDetails = {
      C000127: {
        term_end: '2031-01-03',
        committees: [{ id: 'SSCM', name: 'Senate Committee on Commerce', role: 'Ranking Member' }],
        bio: 'A US Senator from Washington.',
        dc_office: { classification: 'dc', address: '511 Hart SOB', phone: '202-224-3441', city: null, name: null, fax: null, hours: null },
        district_offices: [{ classification: 'district', city: 'Seattle', address: '915 Second Ave.', phone: '206-220-6400', name: null, fax: null, hours: null }],
      },
    };
    const [rep] = mergeFederalSocial(reps, { federalSocial: {}, federalDetails });
    expect(rep.term_end).toBe('2031-01-03');
    expect(rep.committees).toEqual(federalDetails.C000127.committees);
    expect(rep.bio).toBe('A US Senator from Washington.');
    expect(rep.offices).toHaveLength(2);
    expect(rep.offices.map((o) => o.classification)).toEqual(['district', 'dc']);
  });

  test('defaults term_end/committees/bio when federalDetails has nothing for this bioguide', () => {
    const reps = [{ id: 'C999999', area: 'US House', field_offices: [] }];
    const [rep] = mergeFederalSocial(reps, { federalSocial: {}, federalDetails: {} });
    expect(rep.term_end).toBeNull();
    expect(rep.committees).toEqual([]);
    expect(rep.bio).toBeNull();
  });

  test('leaves a non-federal rep untouched', () => {
    const reps = [{ id: 'local-1', area: 'Mayor', offices: [{ classification: 'main' }] }];
    const [rep] = mergeFederalSocial(reps, { federalSocial: {}, federalDetails: {} });
    expect(rep.offices).toEqual([{ classification: 'main' }]);
  });
});

describe('getLocalOfficials on-demand slow-scrape indicator', () => {
  const geo = { state: 'TX', place: 'Nowhere', county: null };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
  });

  test('returns shard matches immediately without ever calling onSlowScrape', async () => {
    global.fetch = jest.fn();
    const shard = { officials: [{ id: 'x', level: 'local', jurisdiction: { city: 'Nowhere' }, name: 'Pat' }] };
    const onSlowScrape = jest.fn();

    const officials = await getLocalOfficials(geo, shard, { onSlowScrape });
    expect(officials).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onSlowScrape).not.toHaveBeenCalled();
  });

  test('on a shard miss, does not call onSlowScrape before the threshold elapses', async () => {
    const onSlowScrape = jest.fn();
    global.fetch = jest.fn(() => new Promise(() => {})); // never resolves within this test

    getLocalOfficials(geo, null, { onSlowScrape });
    // Let the microtask queue (the fetch call itself) flush before checking timers.
    await Promise.resolve();

    jest.advanceTimersByTime(1499);
    expect(onSlowScrape).not.toHaveBeenCalled();
  });

  test('on a shard miss, calls onSlowScrape once the request is still in flight past the threshold', async () => {
    const onSlowScrape = jest.fn();
    global.fetch = jest.fn(() => new Promise(() => {}));

    getLocalOfficials(geo, null, { onSlowScrape });
    await Promise.resolve();

    jest.advanceTimersByTime(1500);
    expect(onSlowScrape).toHaveBeenCalledTimes(1);
  });

  test('does not call onSlowScrape when the on-demand fetch resolves before the threshold', async () => {
    const onSlowScrape = jest.fn();
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ officials: [] }) }));

    await getLocalOfficials(geo, null, { onSlowScrape });
    jest.advanceTimersByTime(5000);
    expect(onSlowScrape).not.toHaveBeenCalled();
  });

  test('does not call onScrapeResult on a shard hit', async () => {
    global.fetch = jest.fn();
    const shard = { officials: [{ id: 'x', level: 'local', jurisdiction: { city: 'Nowhere' }, name: 'Pat' }] };
    const onScrapeResult = jest.fn();

    await getLocalOfficials(geo, shard, { onScrapeResult });
    expect(onScrapeResult).not.toHaveBeenCalled();
  });

  test('calls onScrapeResult with found:true and no error when the on-demand scrape finds officials', async () => {
    const onScrapeResult = jest.fn();
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ officials: [{ id: 'x', name: 'Pat' }], source: 'scraped-now' }) })
    );

    await getLocalOfficials(geo, null, { onScrapeResult });
    expect(onScrapeResult).toHaveBeenCalledWith({ city: 'Nowhere', found: true, error: null, source: 'scraped-now' });
  });

  test('calls onScrapeResult with the backend-reported error when discovery fails, instead of discarding it', async () => {
    const onScrapeResult = jest.fn();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ officials: [], source: 'scraped-now', error: 'LLM_PRESET misconfigured' }),
      })
    );

    await getLocalOfficials(geo, null, { onScrapeResult });
    expect(onScrapeResult).toHaveBeenCalledWith({
      city: 'Nowhere', found: false, error: 'LLM_PRESET misconfigured', source: 'scraped-now',
    });
  });

  test('calls onScrapeResult with a server-error message on a non-ok response', async () => {
    const onScrapeResult = jest.fn();
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502 }));

    await getLocalOfficials(geo, null, { onScrapeResult });
    expect(onScrapeResult).toHaveBeenCalledWith({ city: 'Nowhere', found: false, error: 'Server error (HTTP 502)' });
  });

  test('calls onScrapeResult when the fetch itself throws', async () => {
    const onScrapeResult = jest.fn();
    global.fetch = jest.fn(() => Promise.reject(new Error('network down')));

    await getLocalOfficials(geo, null, { onScrapeResult });
    expect(onScrapeResult).toHaveBeenCalledWith({ city: 'Nowhere', found: false, error: 'network down' });
  });
});

describe('localScrapeNote', () => {
  test('returns null when officials were found — the rendered cards already say so', () => {
    expect(localScrapeNote({ city: 'Durango', found: true })).toBeNull();
  });

  test('leads with the error when the backend reported one', () => {
    const note = localScrapeNote({ city: 'Durango', found: false, error: 'LLM_PRESET misconfigured' });
    expect(note).toMatch(/Durango/);
    expect(note).toMatch(/LLM_PRESET misconfigured/);
  });

  test('explains the auto-retry window for a cached prior miss', () => {
    const note = localScrapeNote({ city: 'Pagosa Springs', found: false, source: 'cache-miss' });
    expect(note).toMatch(/Pagosa Springs/);
    expect(note).toMatch(/week/i);
  });

  test('falls back to a plain not-found message for a fresh empty result with no error', () => {
    const note = localScrapeNote({ city: 'Durango', found: false, source: 'scraped-now' });
    expect(note).toBe('No local officials found for Durango yet.');
  });
});
