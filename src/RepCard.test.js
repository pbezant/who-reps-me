import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RepCard from './RepCard';

// A state-legislator-shaped fixture: Open States ids contain a literal "/" (e.g.
// "ocd-person/1f9ed42e-..."), which is exactly the case that would break naive route-building —
// see the "View full profile" assertion below.
const rep = {
  id: 'ocd-person/1f9ed42e-27de-4cd1-b2bf-f890ee33cb49',
  name: 'Pat Rivera',
  area: 'StateUpper',
  state: 'TX',
  district: 'District 14',
  party: 'Democratic',
  body: '',
  phone: '512-555-0100',
  email: 'pat.rivera@example.gov',
  address: '1100 Congress Ave, Austin, TX',
  bio: 'A longtime advocate for public education.',
  committees: [{ id: 'c1', name: 'Education Committee', role: 'Chair' }],
  offices: [{ classification: 'district', city: 'Austin', address: '123 Main St', phone: null, fax: null, hours: null }],
  confidence: null,
};

function renderCard(overrides = {}) {
  return render(
    <MemoryRouter>
      <RepCard rep={{ ...rep, ...overrides }} />
    </MemoryRouter>
  );
}

test('renders the short card\'s core fields: name, area/district, party, phone', () => {
  renderCard();
  expect(screen.getByText('Pat Rivera')).toBeInTheDocument();
  expect(screen.getByText(/TX Senate/)).toBeInTheDocument();
  expect(screen.getByText(/District 14/)).toBeInTheDocument();
  expect(screen.getByText('Democratic')).toBeInTheDocument();
  expect(screen.getByText('512-555-0100')).toBeInTheDocument();
});

test('links to the profile route with the id percent-encoded, so an id containing "/" stays one path segment', () => {
  renderCard();
  const link = screen.getByRole('link', { name: /view full profile/i });
  expect(link).toHaveAttribute('href', '/rep/ocd-person%2F1f9ed42e-27de-4cd1-b2bf-f890ee33cb49');
});

test('does not render the fields that moved to the full profile page', () => {
  renderCard();
  expect(screen.queryByText(rep.email)).not.toBeInTheDocument();
  expect(screen.queryByText(rep.address)).not.toBeInTheDocument();
  expect(screen.queryByText(rep.bio)).not.toBeInTheDocument();
  expect(screen.queryByText('Education Committee', { exact: false })).not.toBeInTheDocument();
  expect(screen.queryByText('Other offices')).not.toBeInTheDocument();
});

test('shows the low-confidence warning on the short card (a trust signal worth seeing before clicking through)', () => {
  renderCard({ confidence: 0.4, isLocal: true });
  expect(screen.getByText(/lower confidence/i)).toBeInTheDocument();
});
