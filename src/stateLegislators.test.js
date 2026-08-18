import { classifySocial, toStateRepCards, mergeStateLegislators } from './stateLegislators';

const person = (overrides = {}) => ({
  id: 'ocd-person/abc',
  name: 'Erin Zwiener',
  party: 'Democratic',
  current_role: { org_classification: 'lower', district: 45 },
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
