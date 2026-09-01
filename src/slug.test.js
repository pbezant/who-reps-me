import { slugSegment, slugFromId, stateFromSlug, repProfilePath, buildSlugMap } from './officials';

describe('slugSegment', () => {
  it('lowercases and hyphenates', () => {
    expect(slugSegment('Council Member')).toBe('council-member');
  });
  it('folds punctuation runs to a single hyphen and trims edges', () => {
    expect(slugSegment("Ronald (Nub) Hunter")).toBe('ronald-nub-hunter');
    expect(slugSegment('St. Clair County')).toBe('st-clair-county');
    expect(slugSegment("O'Brien & Sons, Jr.?")).toBe('o-brien-sons-jr');
  });
  it('handles empty / nullish input', () => {
    expect(slugSegment('')).toBe('');
    expect(slugSegment(null)).toBe('');
    expect(slugSegment(undefined)).toBe('');
  });
});

describe('slugFromId', () => {
  it('maps a 4-segment id to a url-safe path', () => {
    expect(slugFromId('tx:austin:council-member:jane-doe')).toBe('tx/austin/council-member/jane-doe');
  });
  it('strips unsafe characters that real ids carry', () => {
    expect(slugFromId('ak:kenai-peninsula-borough:mayor:peter-a.-micciche')).toBe(
      'ak/kenai-peninsula-borough/mayor/peter-a-micciche'
    );
    expect(slugFromId('ar:garland-county:justice-of-the-peace:ronald-(nub)-hunter')).toBe(
      'ar/garland-county/justice-of-the-peace/ronald-nub-hunter'
    );
  });
  it('returns empty string for a non-conforming id', () => {
    expect(slugFromId('C001131')).toBe('');
    expect(slugFromId('')).toBe('');
  });
});

describe('stateFromSlug', () => {
  it('uppercases the first segment', () => {
    expect(stateFromSlug('tx/austin/council-member/jane-doe')).toBe('TX');
  });
  it('is empty for empty input', () => {
    expect(stateFromSlug('')).toBe('');
  });
});

describe('repProfilePath', () => {
  it('builds the canonical /rep path from a rep id', () => {
    expect(repProfilePath({ id: 'tx:austin:mayor:kirk-watson' })).toBe('/rep/tx/austin/mayor/kirk-watson');
  });
});

describe('buildSlugMap', () => {
  it('disambiguates a genuine collision deterministically', () => {
    // Two distinct ids that slugify identically (punctuation-only difference).
    const officials = [
      { id: 'tx:x:mayor:jose-perez' },
      { id: 'tx:x:mayor:josé-pérez' },
    ];
    const { entries, collisions } = buildSlugMap(officials);
    expect(collisions).toBe(1);
    const slugs = entries.map((e) => e.slug).sort();
    expect(slugs).toEqual(['tx/x/mayor/jose-perez', 'tx/x/mayor/jose-perez-2']);
  });
  it('leaves unique ids untouched', () => {
    const officials = [
      { id: 'tx:austin:mayor:kirk-watson' },
      { id: 'tx:austin:council-member:jane-doe' },
    ];
    const { collisions } = buildSlugMap(officials);
    expect(collisions).toBe(0);
  });
});
