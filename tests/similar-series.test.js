'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MIN_SIMILAR_SERIES_SCORE, mergeCandidateSources, rankSimilarSeries, scoreSimilarSeries } = require('../lib/similar-series');

function series(id, name, genreIds, overview, originalLanguage = 'en') {
  return { id, name, genre_ids: genreIds, overview, original_language: originalLanguage };
}

test('ranks real TMDB candidates using shared genre and thematic keywords', () => {
  const current = series(10, 'Dark', [18, 9648, 10765], 'A family discovers a time mystery connecting generations in a small town.');
  const candidates = [
    series(11, 'Mystery Family', [18, 9648, 10765], 'A family uncovers a time mystery across generations.', 'de'),
    series(12, 'Police Case', [18, 80], 'A police detective investigates a murder in the city.'),
    series(13, 'Another Time Story', [18, 9648, 10765], 'A family faces a mystery involving time and generations.')
  ];
  const keywordsById = new Map([
    [11, [{ id: 101, name: 'time travel' }, { id: 102, name: 'small town' }]],
    [12, [{ id: 201, name: 'police detective' }]],
    [13, [{ id: 101, name: 'time travel' }]]
  ]);
  const result = rankSimilarSeries({
    current,
    candidates,
    currentKeywords: [{ id: 101, name: 'time travel' }, { id: 102, name: 'small town' }],
    keywordsById
  });

  assert.deepEqual(result.map(item => item.id), [11, 13]);
  assert.ok(result.every(item => item.media_type === 'tv'));
});

test('does not use a shared genre alone as evidence of a reliable match', () => {
  const current = series(20, 'Anime Adventure', [16, 10759], 'A young pilot discovers a distant world and battles for freedom.');
  const candidates = [
    series(21, 'Unrelated Cartoon', [16], 'A family of animals runs a restaurant in the city.'),
    series(22, 'Unrelated Crime Drama', [18, 80], 'A detective investigates organized crime.'),
    series(23, 'Live Action Anime', [10759, 18], 'A ninja searches for a lost friend.')
  ];
  const result = rankSimilarSeries({
    current,
    candidates,
    currentKeywords: [{ id: 301, name: 'space adventure' }],
    keywordsById: new Map([
      [21, [{ id: 302, name: 'family comedy' }]],
      [22, [{ id: 303, name: 'crime' }]],
      [23, [{ id: 301, name: 'anime' }, { id: 304, name: 'ninja' }]]
    ])
  });

  assert.deepEqual(result, []);
});

test('does not treat generic tags such as criminal or thriller as thematic matches', () => {
  const current = series(25, 'Crime Drama', [18, 80], 'A teacher enters a drug empire after a diagnosis.');
  const candidate = series(26, 'Unrelated Detective', [18, 80], 'A detective investigates a new murder every week.');
  const result = rankSimilarSeries({
    current,
    candidates: [candidate],
    currentKeywords: [{ id: 501, name: 'criminal' }, { id: 502, name: 'thriller' }, { id: 503, name: 'future' }],
    keywordsById: new Map([[26, [{ id: 501, name: 'criminal' }, { id: 502, name: 'thriller' }, { id: 503, name: 'future' }]]])
  });

  assert.deepEqual(result, []);
});

test('does not qualify broad overlap such as cancer, sitcom, friendship, or investigation', () => {
  const current = series(33, 'Crime Drama', [18, 80], 'A chemistry teacher joins the criminal world after a diagnosis.');
  const candidates = [
    series(34, 'Cancer Story', [18, 80], 'A journalist with cancer balances family and work.'),
    series(35, 'Police Procedural', [18, 80], 'A detective investigates a different case each week.'),
    series(36, 'Friends Style Sitcom', [18, 80], 'A group of friends share an apartment and cafe.')
  ];
  const broadTags = [{ id: 801, name: 'cancer' }, { id: 802, name: 'investigation' }, { id: 803, name: 'sitcom' }, { id: 804, name: 'friendship' }];
  const result = rankSimilarSeries({
    current,
    candidates,
    currentKeywords: broadTags,
    keywordsById: new Map(candidates.map(candidate => [candidate.id, broadTags]))
  });

  assert.deepEqual(result, []);
});

test('accepts a shared concrete subject when the TMDB genres corroborate the match', () => {
  const current = series(38, 'Crime Drama', [18, 80], 'A teacher enters the world of drugs and crime.');
  const candidate = series(39, 'Drug Network', [18, 80], 'Two police officers pursue an international drug trafficker.');
  const result = rankSimilarSeries({
    current,
    candidates: [candidate],
    currentKeywords: [{ id: 811, name: 'drug dealer' }, { id: 812, name: 'crime' }],
    keywordsById: new Map([[39, [{ id: 811, name: 'drug dealer' }, { id: 812, name: 'crime' }]]])
  });

  assert.deepEqual(result.map(item => item.id), [39]);
});

test('merges TMDB similar and recommendation sources without duplicates, alternating source priority', () => {
  const primary = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const secondary = [{ id: 2 }, { id: 4 }, { id: 5 }];

  assert.deepEqual(mergeCandidateSources(primary, secondary, 5).map(item => item.id), [1, 2, 4, 3, 5]);
});

test('rejects a single shared plot detail when the broader genre and style do not match', () => {
  const current = series(24, 'Crime Thriller', [18, 80, 9648], 'A teacher with cancer enters an illegal drug business to protect his family.');
  const candidate = series(29, 'Cancer Story', [18, 10751], 'A young journalist with cancer balances work, romance and family.');
  const result = rankSimilarSeries({
    current,
    candidates: [candidate],
    currentKeywords: [{ id: 491, name: 'cancer' }, { id: 492, name: 'drug dealer' }],
    keywordsById: new Map([[29, [{ id: 491, name: 'cancer' }]]])
  });

  assert.deepEqual(result, []);
});

test('accepts matched anime and shounen style only when genres also align', () => {
  const current = series(27, 'Ninja Journey', [16, 10759, 10765], 'Young ninjas train, battle and protect their village.');
  const related = series(28, 'Shounen Battle', [16, 10759, 35, 18, 10751, 10762, 10765], 'Young ninjas battle in a shounen tournament to protect their village.');
  const result = rankSimilarSeries({
    current,
    candidates: [related],
    currentKeywords: [{ id: 701, name: 'anime' }, { id: 702, name: 'shounen' }, { id: 703, name: 'ninja' }],
    keywordsById: new Map([[28, [{ id: 704, name: 'anime' }, { id: 702, name: 'shounen' }, { id: 703, name: 'ninja' }]]])
  });

  assert.deepEqual(result.map(item => item.id), [28]);
});

test('requires thematic evidence when keyword metadata is unavailable', () => {
  const current = series(30, 'The Shared Mystery', [18, 9648, 10765], 'A family follows a mystery about time travel across generations and secrets. A missing child returns home.');
  const candidates = [
    series(31, 'Related Time Mystery', [18, 9648, 10765], 'A family follows a mystery about time travel across generations and secrets while a missing child returns home.'),
    series(32, 'Unrelated Drama', [18, 9648, 10765], 'A chef opens a restaurant and rebuilds a career after a divorce.')
  ];
  const result = rankSimilarSeries({ current, candidates, currentKeywords: [], keywordsById: new Map() });

  assert.deepEqual(result.map(item => item.id), [31]);
});

test('applies the minimum relevance score and returns strongest matches first', () => {
  const current = series(35, 'Space Colony', [18, 10765, 9648], 'A crew protects a space colony from political conspiracies and alien threats.');
  const strong = series(36, 'Deep Space Colony', [18, 10765, 9648], 'A crew protects a space colony from political conspiracies and alien threats.');
  const moderate = series(37, 'Alien Conspiracy', [18, 10765], 'A crew uncovers alien conspiracies during a mission.');
  const currentKeywords = [
    { id: 601, name: 'space colony' }, { id: 602, name: 'alien threat' }, { id: 603, name: 'political conspiracy' }
  ];
  const keywordsById = new Map([
    [36, [...currentKeywords]],
    [37, [{ id: 602, name: 'alien threat' }, { id: 603, name: 'political conspiracy' }]]
  ]);
  const strongScore = scoreSimilarSeries({ current, candidate: strong, currentKeywords, candidateKeywords: keywordsById.get(36) });
  const moderateScore = scoreSimilarSeries({ current, candidate: moderate, currentKeywords, candidateKeywords: keywordsById.get(37) });
  const results = rankSimilarSeries({ current, candidates: [moderate, strong], currentKeywords, keywordsById });

  assert.equal(MIN_SIMILAR_SERIES_SCORE, 50);
  assert.ok(strongScore.score >= MIN_SIMILAR_SERIES_SCORE);
  assert.ok(moderateScore.score >= MIN_SIMILAR_SERIES_SCORE);
  assert.deepEqual(results.map(item => item.id), [36, 37]);
  assert.deepEqual(rankSimilarSeries({
    current, candidates: [moderate], currentKeywords, keywordsById, minimumScore: strongScore.score + 0.01
  }), []);
});

test('excludes the current series, invalid entries and duplicate TMDB IDs', () => {
  const current = series(40, 'Current Show', [18, 9648], 'A detective searches for a missing family member.');
  const related = series(41, 'Related Show', [18, 9648], 'A detective searches for a missing family member.');
  const result = rankSimilarSeries({
    current,
    candidates: [current, related, { ...related }, { id: 0, name: 'Invalid' }, { id: 42, name: '', original_name: '' }],
    currentKeywords: [{ id: 401 }],
    keywordsById: new Map([[41, [{ id: 401 }]]])
  });

  assert.deepEqual(result.map(item => item.id), [41]);
});

test('similar-series add buttons toggle the correct list item and persist the marker state', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const extract = (name, nextName) => {
    const start = html.indexOf(`function ${name}(`);
    const end = html.indexOf(`\n  function ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `Could not find ${name}`);
    return html.slice(start, end).trim();
  };

  const user = { sessionToken: 'test-session', list: [] };
  let saved = 0;
  let synced = 0;
  let cleared = 0;
  const button = {
    dataset: { similarAdd: '887766', similarTitle: 'Test Series', similarPoster: '/poster.jpg', similarDate: '2020-01-01' },
    attributes: {}, listeners: {}, classes: new Set(), innerHTML: '', title: '',
    classList: {
      toggle(name, enabled) { enabled ? button.classes.add(name) : button.classes.delete(name); },
      contains(name) { return button.classes.has(name); }
    },
    setAttribute(name, value) { button.attributes[name] = String(value); },
    addEventListener(name, listener) { button.listeners[name] = listener; }
  };
  const context = {
    user,
    $: () => null,
    $$: selector => selector === '[data-similar-add]' ? [button] : [],
    mediaTypeOf: item => item?.media_type === 'tv' || item?.media_type === 'movie' ? item.media_type : (item?.name && !item?.title ? 'tv' : 'movie'),
    collectionMarkerState: (id, type) => ({ listed: user.list.some(item => Number(item.id) === Number(id) && item.media_type === type) }),
    cardActionIcon: name => `icon:${name}`,
    save: () => { saved += 1; },
    renderList: () => {},
    renderProfile: () => {},
    syncTimer: 123,
    syncStateToServer: async () => { synced += 1; return true; },
    setTimeout: () => 456,
    clearTimeout: () => { cleared += 1; }
  };
  context.refreshPersonalMarkers = vm.runInNewContext(`(${extract('refreshPersonalMarkers', 'toggleList')})`, context);
  context.toggleList = vm.runInNewContext(`(${extract('toggleList', 'toggleFavorite')})`, context);
  const bind = vm.runInNewContext(`(${extract('bindSimilarSeriesActions', 'similarMovieItems')})`, context);
  bind({ querySelectorAll: selector => selector === '[data-similar-add]' ? [button] : [] });

  const click = () => ({ preventDefault() {}, stopPropagation() {} });
  await button.listeners.click(click());
  assert.deepEqual(user.list.map(item => [item.id, item.media_type]), [[887766, 'tv']]);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.title, 'Remover da minha lista');
  assert.equal(button.innerHTML, 'icon:i-check');
  assert.equal(saved, 1);
  assert.equal(synced, 1);
  assert.equal(cleared, 1);

  await button.listeners.click(click());
  assert.equal(user.list.length, 0);
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.title, 'Adicionar à minha lista');
  assert.equal(button.innerHTML, 'icon:i-plus');
  assert.equal(saved, 2);
  assert.equal(synced, 2);
  assert.equal(cleared, 2);
});
