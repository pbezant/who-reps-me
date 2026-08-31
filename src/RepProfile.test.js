import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import RepProfile from './RepProfile';

const rep = {
  id: 'C001131',
  name: 'Jordan Ellis',
  area: 'US House',
  state: 'TX',
  district: '',
  party: 'Republican',
  body: '',
  phone: '202-555-0100',
  email: 'jordan.ellis@example.gov',
  address: '123 Capitol St',
  hours: 'Mon-Fri 9am-5pm',
  url: 'https://ellis.house.gov',
  social: { twitter: 'https://twitter.com/repellis' },
  term_end: '2027-01-03',
  bio: 'A representative from Texas.',
  committees: [{ id: 'c1', name: 'Ways and Means', role: 'Member' }],
  offices: [{ classification: 'district', city: 'Houston', address: '456 Main St', phone: null, fax: null, hours: null }],
  confidence: null,
  verifiedAt: '2026-08-01T00:00:00.000Z',
  sourceUrl: 'https://ellis.house.gov/about',
};

function renderAt(initialEntries) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/rep/*" element={<RepProfile />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>
  );
}

beforeEach(() => {
  // RepNews/RepVotingRecord both fetch on mount when a rep renders — a never-resolving promise
  // (same convention App.test.js uses for its slow-scrape tests) keeps them in their loading
  // state for the duration of the test without triggering an unawaited state update after
  // teardown.
  global.fetch = jest.fn(() => new Promise(() => {}));
});

afterEach(() => {
  delete global.fetch;
});

test('renders full detail (everything the short card leaves out) when router state carries the rep', () => {
  renderAt([{ pathname: '/rep/C001131', state: { rep } }]);

  expect(screen.getByRole('heading', { name: 'Jordan Ellis' })).toBeInTheDocument();
  expect(screen.getByText(rep.email)).toBeInTheDocument();
  expect(screen.getByText(rep.address)).toBeInTheDocument();
  expect(screen.getByText(rep.hours)).toBeInTheDocument();
  expect(screen.getByText(rep.bio)).toBeInTheDocument();
  expect(screen.getByText(/Ways and Means/)).toBeInTheDocument();
  expect(screen.getByText('Other offices')).toBeInTheDocument();
  expect(screen.getByText(/Term ends/)).toBeInTheDocument();
  expect(screen.getByText(/Verified/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'source' })).toHaveAttribute('href', rep.sourceUrl);

  // The two new sections are always rendered (their own components decide what to show inside).
  expect(screen.getByRole('heading', { name: /recent news/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /voting/i })).toBeInTheDocument();
});

test('shows the website by hostname under a label, never the raw href', () => {
  renderAt([{ pathname: '/rep/C001131', state: { rep: { ...rep, url: 'https://openstates.org/person/gina-hinojosa-xfLWJ5Zor5hbGpZ6gzLVx/' } } }]);

  // A 62-character database URL rendered in full was the most visually dominant element on the
  // page, out-shouting the phone number nobody could otherwise identify as a phone number.
  expect(screen.getByText('openstates.org')).toBeInTheDocument();
  expect(screen.queryByText(/gina-hinojosa-xfLWJ5Zor5hbGpZ6gzLVx/)).not.toBeInTheDocument();
  expect(screen.getByText('Official website')).toBeInTheDocument();
});

test('labels the contact actions, so a bare number is not left to speak for itself', () => {
  renderAt([{ pathname: '/rep/C001131', state: { rep } }]);
  expect(screen.getByText('Call this office')).toBeInTheDocument();
  expect(screen.getByText('Email')).toBeInTheDocument();
});

test('renders social links as named pills rather than bare icons', () => {
  renderAt([{ pathname: '/rep/C001131', state: { rep } }]);
  expect(screen.getByRole('heading', { name: /find them online/i })).toBeInTheDocument();
  // The visible platform name is the point: unlabelled icons were the reason these went unseen.
  expect(screen.getByRole('link', { name: 'X' })).toHaveAttribute('href', 'https://twitter.com/repellis');
});

test('omits the socials panel entirely when there are none, rather than leaving a labelled hole', () => {
  renderAt([{ pathname: '/rep/C001131', state: { rep: { ...rep, social: {} } } }]);
  expect(screen.queryByRole('heading', { name: /find them online/i })).not.toBeInTheDocument();
});

test('says so plainly when no contact details are on file, instead of rendering an empty panel', () => {
  const bare = { ...rep, phone: '', email: '', url: '', address: '', hours: '', social: {} };
  renderAt([{ pathname: '/rep/C001131', state: { rep: bare } }]);

  expect(screen.getByText(/don't have contact details/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /check the official page/i })).toHaveAttribute('href', bare.sourceUrl);
});

// A cold visit (no router state) resolves the slug against the state shard. This is the path that
// makes local-official pages indexable and shareable.
test('resolves a local official from its slug on a cold load, no router state', async () => {
  const shard = {
    state: 'TX',
    officials: [
      {
        id: 'tx:austin:mayor:kirk-watson',
        name: 'Kirk Watson',
        office: 'Mayor',
        body: 'Austin City Council',
        phone: '512-555-0100',
        email: 'mayor@austintexas.gov',
        extracted_at: '2026-08-01T00:00:00.000Z',
        source_url: 'https://www.austintexas.gov/mayor',
        confidence: 1,
      },
    ],
  };
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(shard) }));

  renderAt([{ pathname: '/rep/tx/austin/mayor/kirk-watson' }]);

  expect(await screen.findByRole('heading', { name: 'Kirk Watson' })).toBeInTheDocument();
  expect(screen.getByText('mayor@austintexas.gov')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/officials/TX.json'));
});

test('shows the noindex fallback when a cold-loaded slug is not in the shard', async () => {
  const shard = { state: 'TX', officials: [] };
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(shard) }));

  renderAt([{ pathname: '/rep/tx/austin/mayor/nobody-here' }]);

  expect(await screen.findByText(/don't have this representative's info/i)).toBeInTheDocument();
});

test('reads a prerendered rep from window.__REP__ without fetching', () => {
  window.__REP__ = {
    id: 'tx:austin:mayor:kirk-watson',
    name: 'Kirk Watson',
    area: 'Mayor',
    social: {},
  };
  global.fetch = jest.fn(() => new Promise(() => {}));

  renderAt([{ pathname: '/rep/tx/austin/mayor/kirk-watson' }]);

  expect(screen.getByRole('heading', { name: 'Kirk Watson' })).toBeInTheDocument();
  // RepNews/RepVotingRecord still fetch on mount — the point is we never fetched a shard to
  // resolve the rep, because window.__REP__ already had it.
  expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('/officials/'));
  delete window.__REP__;
});

test('drops an office phone that only repeats the number already shown as the Call action', () => {
  const withDupe = {
    ...rep,
    phone: '202-555-0100',
    offices: [{ classification: 'capitol', name: 'Capitol Office', city: null, address: 'Room 4S.2', phone: '202-555-0100', fax: null, hours: null }],
  };
  renderAt([{ pathname: '/rep/C001131', state: { rep: withDupe } }]);

  // The address is genuinely new, so the office still renders — but its phone is the same number
  // sitting in the Call button above it, so exactly one copy should be on the page.
  expect(screen.getByText('Room 4S.2')).toBeInTheDocument();
  expect(screen.getAllByText('202-555-0100')).toHaveLength(1);
});

test('shows the fallback on a cold visit to a federal rep (no shard to resolve from)', async () => {
  // A bioguide id doesn't slugify and isn't in any shard, so it resolves to nothing.
  global.fetch = jest.fn(() => Promise.resolve({ ok: false }));
  renderAt(['/rep/C001131']);

  expect(await screen.findByText(/don't have this representative's info/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /go back and search/i })).toHaveAttribute('href', '/');
  expect(screen.queryByRole('heading', { name: 'Jordan Ellis' })).not.toBeInTheDocument();
});
