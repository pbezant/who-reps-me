import { classifySocial, toStateRepCards, mergeStateLegislators } from './stateLegislators';
import liveResponse from './__fixtures__/openstates-people-geo.json';

// `people.geo` returns federal members alongside state ones, so a state jurisdiction is part
// of the minimum shape a renderable state legislator has — see the federal/state separation
// tests at the bottom for the cases where it is absent or "country".
const person = (overrides = {}) => ({
  id: 'ocd-person/abc',
  name: 'Erin Zwiener',
  party: 'Democratic',
  current_role: { org_classification: 'lower', district: 45 },
  jurisdiction: { classification: 'state' },
  ...overrides,
});

describe('classifySocial', () => {
  test('classifies each platform by hostname', () => {
    expect(
      classifySocial([
        { url: 'https://twitter.com/rep' },
        { url: 'https://www.facebook.com/rep' },
        { url: 'https://instagram.com/rep' },
        { url: 'https://www.linkedin.com/in/rep' },
        { url: 'https://youtu.be/abc' },
      ])
    ).toEqual({
      twitter: 'https://twitter.com/rep',
      facebook: 'https://www.facebook.com/rep',
      instagram: 'https://instagram.com/rep',
      linkedin: 'https://www.linkedin.com/in/rep',
      youtube: 'https://youtu.be/abc',
    });
  });

  test('treats x.com as twitter and keeps the first account per platform', () => {
    const social = classifySocial([
      { url: 'https://x.com/official' },
      { url: 'https://twitter.com/campaign' },
    ]);
    expect(social.twitter).toBe('https://x.com/official');
  });

  test('ignores non-social and unparseable links', () => {
    const social = classifySocial([
      { url: 'https://zwienerfortexas.com' },
      { url: 'not-a-url' },
      null,
    ]);
    expect(Object.values(social).every((v) => v === null)).toBe(true);
  });

  test('does not match a lookalike host', () => {
    expect(classifySocial([{ url: 'https://nottwitter.com/x' }]).twitter).toBeNull();
  });
});

describe('toStateRepCards', () => {
  test('maps chamber classification onto the areas Results renders', () => {
    const [lower] = toStateRepCards([person()], 'TX');
    const [upper] = toStateRepCards(
      [person({ current_role: { org_classification: 'upper', district: 21 } })],
      'TX'
    );
    expect(lower.area).toBe('StateLower');
    expect(upper.area).toBe('StateUpper');
    expect(lower.district).toBe('District 45');
    expect(lower.state).toBe('TX');
  });

  test("maps Nebraska's unicameral legislature onto the upper chamber", () => {
    const [card] = toStateRepCards(
      [person({ current_role: { org_classification: 'legislature', district: 12 } })],
      'NE'
    );
    expect(card.area).toBe('StateUpper');
  });

  test('drops people with no placeable current role', () => {
    expect(toStateRepCards([person({ current_role: null })], 'TX')).toEqual([]);
    expect(toStateRepCards([person({ current_role: { org_classification: 'executive' } })], 'TX'))
      .toEqual([]);
  });

  test('prefers the capitol office phone over a district one', () => {
    const [card] = toStateRepCards(
      [
        person({
          offices: [
            { classification: 'district', voice: '512-555-0000' },
            { classification: 'capitol', voice: '512-463-0647' },
          ],
        }),
      ],
      'TX'
    );
    expect(card.phone).toBe('512-463-0647');
  });

  test('falls back to any office with a number, then to the legacy contact_details shape', () => {
    const [anyOffice] = toStateRepCards(
      [person({ offices: [{ classification: 'district', voice: '512-555-0000' }] })],
      'TX'
    );
    expect(anyOffice.phone).toBe('512-555-0000');

    const [legacy] = toStateRepCards(
      [
        person({
          contact_details: [
            { type: 'email', value: 'rep@capitol.gov' },
            { type: 'voice', value: '512-555-1111' },
          ],
        }),
      ],
      'TX'
    );
    expect(legacy.phone).toBe('512-555-1111');
    expect(legacy.email).toBe('rep@capitol.gov');
  });

  test('keeps district 0 rather than treating it as absent', () => {
    const [card] = toStateRepCards(
      [person({ current_role: { org_classification: 'lower', district: 0 } })],
      'TX'
    );
    expect(card.district).toBe('District 0');
  });

  test('uses openstates_url, else the first non-social link', () => {
    const [withOs] = toStateRepCards([person({ openstates_url: 'https://openstates.org/p/1' })], 'TX');
    expect(withOs.url).toBe('https://openstates.org/p/1');

    const [withoutOs] = toStateRepCards(
      [person({ links: [{ url: 'https://twitter.com/rep' }, { url: 'https://zwiener.house.gov' }] })],
      'TX'
    );
    expect(withoutOs.url).toBe('https://zwiener.house.gov');
  });

  test('tolerates an empty or missing payload', () => {
    expect(toStateRepCards(undefined, 'TX')).toEqual([]);
    expect(toStateRepCards([], 'TX')).toEqual([]);
  });
});

describe('mergeStateLegislators', () => {
  const federal = [
    { id: 'C001131', name: 'Gregorio Casar', area: 'US House' },
    { id: 'C001056', name: 'John Cornyn', area: 'US Senate' },
  ];
  const fiveCallsState = [
    { id: 'uuid-lower', name: 'Erin Zwiener', area: 'StateLower' },
    { id: 'uuid-upper', name: 'Judith Zaffirini', area: 'StateUpper' },
  ];

  test('replaces 5calls state entries with the Open States ones', () => {
    const openStates = [{ id: 'ocd-person/1', name: 'Erin Zwiener', area: 'StateLower' }];
    const merged = mergeStateLegislators([...federal, ...fiveCallsState], openStates);

    expect(merged.map((r) => r.id)).toEqual(['C001131', 'C001056', 'ocd-person/1']);
    expect(merged.filter((r) => r.area.startsWith('State'))).toHaveLength(1);
  });

  test('keeps 5calls state reps when Open States returned nothing', () => {
    // The important fail-soft: no key, an upstream error, or an uncovered state must never
    // leave the user with fewer reps than before this feature existed.
    expect(mergeStateLegislators([...federal, ...fiveCallsState], [])).toHaveLength(4);
    expect(mergeStateLegislators([...federal, ...fiveCallsState], null)).toHaveLength(4);
  });

  test('never drops federal reps', () => {
    const merged = mergeStateLegislators([...federal, ...fiveCallsState], [
      { id: 'ocd-person/1', area: 'StateLower' },
    ]);
    expect(merged.filter((r) => r.area.startsWith('US'))).toHaveLength(2);
  });

  test('adds state reps even when 5calls returned none — the bug this fixes', () => {
    const merged = mergeStateLegislators(federal, [
      { id: 'ocd-person/1', area: 'StateLower' },
      { id: 'ocd-person/2', area: 'StateUpper' },
    ]);
    expect(merged).toHaveLength(4);
  });

  test('tolerates a missing representatives list', () => {
    expect(mergeStateLegislators(undefined, [])).toEqual([]);
  });
});

// A verbatim capture of a real `people.geo` response for Austin, TX (30.2672, -97.7431). It is
// here because the first version of this module was built on a wrong assumption — that Open
// States returns only state legislators — and this payload is what disproved it: three of the
// five people in it are members of Congress.
describe('against a real people.geo response', () => {
  test('the payload really does mix federal members in with state ones', () => {
    const classifications = liveResponse.results.map((p) => p.jurisdiction.classification);
    expect(classifications).toContain('country');
    expect(classifications).toContain('state');
  });

  test('keeps only the state legislators', () => {
    const cards = toStateRepCards(liveResponse.results, 'TX');
    expect(cards.map((c) => c.name)).toEqual(['Gina Hinojosa', 'Sarah Eckhardt']);
  });

  test('excludes every member of Congress', () => {
    const names = toStateRepCards(liveResponse.results, 'TX').map((c) => c.name);
    for (const federal of ['John Cornyn', 'Ted Cruz', 'Lloyd Doggett']) {
      expect(names).not.toContain(federal);
    }
  });

  test('a US Senator is not promoted into the state upper chamber', () => {
    // org_classification is "upper" for a US Senator exactly as it is for a state senator, so
    // chamber alone can never separate them — jurisdiction.classification is the only signal.
    const senator = liveResponse.results.find((p) => p.name === 'John Cornyn');
    expect(senator.current_role.org_classification).toBe('upper');
    expect(toStateRepCards([senator], 'TX')).toEqual([]);
  });

  test('maps the surviving state legislators correctly', () => {
    const [house, senate] = toStateRepCards(liveResponse.results, 'TX');
    expect(house).toMatchObject({
      area: 'StateLower',
      district: 'District 49',
      phone: '512-463-0668',
      email: 'gina.hinojosa@house.texas.gov',
      state: 'TX',
    });
    expect(senate).toMatchObject({
      area: 'StateUpper',
      district: 'District 14',
      phone: '512-463-0114', // capitol office, not the district-mail one with an empty voice
      email: 'sarah.eckhardt@senate.texas.gov',
    });
  });

  test('end to end, federal reps come from 5calls and are not duplicated', () => {
    const fiveCalls = [
      { id: 'C001131', name: 'Gregorio Casar', area: 'US House' },
      { id: 'C001056', name: 'John Cornyn', area: 'US Senate' },
      { id: 'C001098', name: 'Ted Cruz', area: 'US Senate' },
    ];
    const merged = mergeStateLegislators(fiveCalls, toStateRepCards(liveResponse.results, 'TX'));

    expect(merged.map((r) => r.name)).toEqual([
      'Gregorio Casar', 'John Cornyn', 'Ted Cruz', 'Gina Hinojosa', 'Sarah Eckhardt',
    ]);
    const counts = merged.reduce((acc, r) => ({ ...acc, [r.name]: (acc[r.name] || 0) + 1 }), {});
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  });
});

describe('federal/state separation', () => {
  const statePerson = {
    id: 'ocd-person/x',
    name: 'State Rep',
    current_role: { org_classification: 'lower', district: '5' },
    jurisdiction: { classification: 'state' },
  };

  test('drops a person with no jurisdiction rather than guessing', () => {
    // Safe direction: losing a state rep falls back to 5calls, whereas guessing "state" would
    // render a US Senator as a state senator.
    const { jurisdiction, ...noJurisdiction } = statePerson;
    expect(toStateRepCards([noJurisdiction], 'TX')).toEqual([]);
  });

  test('keeps a legitimate state legislator', () => {
    expect(toStateRepCards([statePerson], 'TX')).toHaveLength(1);
  });
});
