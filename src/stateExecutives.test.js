import { toStateExecutiveCards, mergeStateExecutives } from './stateExecutives';

// A minimal but representative shape of what `/people?org_classification=executive` returns —
// see this module's header comment for how each field maps onto to_database.py's behavior in
// github.com/openstates/openstates-core.
const person = (overrides = {}) => ({
  id: 'ocd-person/abbott',
  name: 'Greg Abbott',
  party: 'Republican',
  current_role: { org_classification: 'executive', title: 'Governor' },
  jurisdiction: { classification: 'state' },
  ...overrides,
});

describe('toStateExecutiveCards', () => {
  test('maps a governor onto a card with the title as area and no district', () => {
    const [card] = toStateExecutiveCards([person()], 'TX');
    expect(card.area).toBe('Governor');
    expect(card.district).toBe('');
    expect(card.state).toBe('TX');
    expect(card.isStateExecutive).toBe(true);
  });

  // The one RoleType whose value has an underscore ("lt_governor") instead of a space, so
  // Python's title-casing upstream leaves "Lt_Governor" rather than splitting into two words —
  // confirmed directly (`'lt_governor'.title()` => 'Lt_Governor'). This is the one place that
  // needs fixing up; every other executive title already reads fine as-is.
  test('cleans up "Lt_Governor" into "Lieutenant Governor"', () => {
    const [card] = toStateExecutiveCards(
      [person({ current_role: { org_classification: 'executive', title: 'Lt_Governor' } })],
      'TX'
    );
    expect(card.area).toBe('Lieutenant Governor');
  });

  test('passes through titles that need no cleanup, e.g. Attorney General', () => {
    const [card] = toStateExecutiveCards(
      [person({ current_role: { org_classification: 'executive', title: 'Attorney General' } })],
      'TX'
    );
    expect(card.area).toBe('Attorney General');
  });

  test('drops a non-executive current_role (defensive — the API query already filters this)', () => {
    expect(
      toStateExecutiveCards(
        [person({ current_role: { org_classification: 'upper', title: 'Senator' } })],
        'TX'
      )
    ).toEqual([]);
  });

  test('drops a person with no jurisdiction rather than guessing', () => {
    const { jurisdiction, ...noJurisdiction } = person();
    expect(toStateExecutiveCards([noJurisdiction], 'TX')).toEqual([]);
  });

  test('drops a person with no title to render', () => {
    expect(
      toStateExecutiveCards([person({ current_role: { org_classification: 'executive' } })], 'TX')
    ).toEqual([]);
  });

  test('tolerates an empty or missing payload', () => {
    expect(toStateExecutiveCards(undefined, 'TX')).toEqual([]);
    expect(toStateExecutiveCards([], 'TX')).toEqual([]);
  });

  test('maps phone, offices, and social the same way state legislators do', () => {
    const [card] = toStateExecutiveCards(
      [
        person({
          offices: [{ classification: 'capitol', voice: '512-463-2000', address: 'P.O. Box 12428; Austin, TX' }],
          links: [{ url: 'https://twitter.com/GovAbbott' }, { url: 'https://gov.texas.gov/' }],
          openstates_url: 'https://openstates.org/person/abbott',
        }),
      ],
      'TX'
    );
    expect(card.phone).toBe('512-463-2000');
    expect(card.offices).toEqual([
      { classification: 'capitol', name: null, city: null, address: 'P.O. Box 12428; Austin, TX', phone: '512-463-2000', fax: null, hours: null },
    ]);
    expect(card.social.twitter).toBe('https://twitter.com/GovAbbott');
    expect(card.url).toBe('https://openstates.org/person/abbott');
  });
});

describe('mergeStateExecutives', () => {
  test('appends executive cards after the existing representatives, never replacing anything', () => {
    const representatives = [
      { id: 'C001131', area: 'US House' },
      { id: 'ocd-person/rep', area: 'StateLower' },
    ];
    const executiveCards = [{ id: 'ocd-person/abbott', area: 'Governor' }];
    const merged = mergeStateExecutives(representatives, executiveCards);
    expect(merged).toEqual([...representatives, ...executiveCards]);
  });

  test('tolerates missing lists on either side', () => {
    expect(mergeStateExecutives(undefined, undefined)).toEqual([]);
    expect(mergeStateExecutives([{ id: '1' }], null)).toEqual([{ id: '1' }]);
    expect(mergeStateExecutives(null, [{ id: '1' }])).toEqual([{ id: '1' }]);
  });
});
