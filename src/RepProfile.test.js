import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/rep/:id" element={<RepProfile />} />
      </Routes>
    </MemoryRouter>
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

test('shows a "go back and search again" fallback on a cold visit (no router state)', () => {
  renderAt(['/rep/C001131']);

  expect(screen.getByText(/click through from a search result/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /go back and search again/i })).toHaveAttribute('href', '/');
  expect(screen.queryByRole('heading', { name: 'Jordan Ellis' })).not.toBeInTheDocument();
});
