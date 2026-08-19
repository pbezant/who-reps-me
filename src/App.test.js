import { render, screen } from '@testing-library/react';
import App, { officesFromFieldOffices, mergeOffices, mergeFederalSocial } from './App';

test('renders the search page', () => {
  render(<App />);
  expect(screen.getByText(/who reps me/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/address or zip code/i)).toBeInTheDocument();
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
