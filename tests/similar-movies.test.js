'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { MIN_SIMILAR_MOVIE_SCORE, mergeCandidateSources, rankSimilarMovies, scoreSimilarMovie } = require('../lib/similar-movies');

function movie(id, title, genres, overview, extra = {}) {
  return { id, title, genre_ids: genres, overview, original_language: 'en', ...extra };
}

test('ranks thematically supported movie recommendations and labels them as movies', () => {
  const current = movie(100, 'Drug Empire', [18, 80, 53], 'A chemistry teacher enters the drug trade and builds a criminal empire to protect his family.');
  const drugCrime = movie(101, 'Cartel Route', [18, 80, 53], 'A police agent tracks a drug trafficking network and its criminal empire across the border.');
  const unrelatedCrime = movie(102, 'City Detective', [18, 80], 'A detective investigates a murder in a quiet town.');
  const keywordsById = new Map([
    [101, [{ id: 7001, name: 'drug trafficking' }, { id: 7002, name: 'organized crime' }]],
    [102, [{ id: 7003, name: 'murder investigation' }]]
  ]);
  const results = rankSimilarMovies({
    current,
    candidates: [unrelatedCrime, drugCrime],
    currentKeywords: [{ id: 7001, name: 'drug trafficking' }, { id: 7002, name: 'organized crime' }],
    keywordsById
  });

  assert.deepEqual(results.map(item => item.id), [101]);
  assert.equal(results[0].media_type, 'movie');
  assert.ok(MIN_SIMILAR_MOVIE_SCORE > 0);
});

test('rejects candidates supported only by broad genre and generic keywords', () => {
  const current = movie(110, 'Crime Story', [18, 80], 'A teacher becomes involved in a criminal drug business to support a family.');
  const candidates = [
    movie(111, 'Unrelated Case', [18, 80], 'A detective investigates a murder in the city.'),
    movie(112, 'Comedy', [35, 18], 'Friends open a restaurant and rebuild their lives.')
  ];
  const generic = [{ id: 7100, name: 'crime' }, { id: 7101, name: 'drama' }, { id: 7102, name: 'based on a true story' }];
  const results = rankSimilarMovies({
    current,
    candidates,
    currentKeywords: generic,
    keywordsById: new Map(candidates.map(candidate => [candidate.id, generic]))
  });
  assert.deepEqual(results, []);
});

test('does not treat biography, prison, or source-material tags as thematic matches', () => {
  const goodfellas = movie(769, 'Os Bons Companheiros', [18, 80], 'A gangster rises through the mafia and organized crime in New York.');
  const tedBundy = movie(457799, 'Ted Bundy', [18, 80], 'A prison biography based on a book about a serial killer.');
  const genericTags = [
    { id: 7401, name: 'prison' },
    { id: 7402, name: 'based on novel or book' },
    { id: 7403, name: 'biography' },
    { id: 7404, name: 'based on true story' }
  ];

  const relevance = scoreSimilarMovie({
    current: goodfellas,
    candidate: tedBundy,
    currentKeywords: genericTags,
    candidateKeywords: genericTags
  });
  assert.equal(relevance.hasThematicEvidence, false);
  assert.deepEqual(rankSimilarMovies({
    current: goodfellas,
    candidates: [tedBundy],
    currentKeywords: genericTags,
    keywordsById: new Map([[tedBundy.id, genericTags]])
  }), []);
});

test('does not treat family relationship or animation-format tags as strong themes', () => {
  const scarface = movie(111, 'Scarface', [28, 80, 18], 'A Cuban immigrant builds a cocaine empire in Miami.');
  const unrelated = movie(22460, 'Unrelated Crime Drama', [28, 80, 18], 'A family story centered on a sibling relationship.');
  const genericTags = [{ id: 7451, name: 'sibling relationship' }, { id: 7452, name: '3d animation' }];
  assert.deepEqual(rankSimilarMovies({
    current: scarface,
    candidates: [unrelated],
    currentKeywords: genericTags,
    keywordsById: new Map([[unrelated.id, genericTags]])
  }), []);
});

test('does not treat common music tags plus animation as enough evidence', () => {
  const coco = movie(354912, 'Viva', [10751, 16, 10402, 12], 'A boy visits the land of the dead and discovers his family history.');
  const musicAnimation = movie(333667, 'Music Dog', [10751, 16, 10402], 'A dog plays guitar and follows a dream of becoming a musician.');
  const broadTags = [{ id: 7461, name: 'musician' }, { id: 7462, name: 'guitar' }, { id: 7463, name: '3d animation' }];
  assert.deepEqual(rankSimilarMovies({
    current: coco,
    candidates: [musicAnimation],
    currentKeywords: broadTags,
    keywordsById: new Map([[musicAnimation.id, broadTags]])
  }), []);
});

test('does not treat shared villain or tone tags as story similarity', () => {
  const coco = movie(354912, 'Viva', [10751, 16, 10402, 12], 'A boy visits the land of the dead and discovers his family history.');
  const unrelated = movie(22582, 'Tom and Jerry', [10751, 16, 35], 'A cat and mouse encounter a villain in a comic chase.');
  const broadTags = [{ id: 7471, name: 'villain' }, { id: 7472, name: 'hilarious' }];
  assert.deepEqual(rankSimilarMovies({
    current: coco,
    candidates: [unrelated],
    currentKeywords: broadTags,
    keywordsById: new Map([[unrelated.id, broadTags]])
  }), []);
});

test('accepts a crime-film connection supported by distinct specific TMDB tags', () => {
  const goodfellas = movie(769, 'Os Bons Companheiros', [18, 80], 'A gangster joins the mafia and rises through organized crime.');
  const donnieBrasco = movie(9366, 'Donnie Brasco', [18, 80], 'An undercover agent infiltrates a mafia family and befriends a gangster.');
  const thematicTags = [{ id: 7501, name: 'mafia' }, { id: 7502, name: 'gangster' }];

  const results = rankSimilarMovies({
    current: goodfellas,
    candidates: [donnieBrasco],
    currentKeywords: thematicTags,
    keywordsById: new Map([[donnieBrasco.id, thematicTags]])
  });
  assert.deepEqual(results.map(item => item.id), [donnieBrasco.id]);
});

test('accepts one strong thematic phrase corroborated by close genre alignment', () => {
  const coco = movie(354912, 'Viva', [10751, 16, 10402, 12], 'A family discovers a world after death through music.');
  const soul = movie(508442, 'Soul', [16, 12, 10751], 'A musician explores life after death and the meaning of purpose.');
  const tags = [{ id: 7551, name: 'life after death' }, { id: 7552, name: '3d animation' }];
  const results = rankSimilarMovies({
    current: coco,
    candidates: [soul],
    currentKeywords: tags,
    keywordsById: new Map([[soul.id, tags]])
  });
  assert.deepEqual(results.map(item => item.id), [soul.id]);
});

test('requires a specific shared theme rather than a large generic synopsis overlap', () => {
  const inception = movie(27205, 'A Origem', [28, 878, 80], 'A team enters shared dreams to plant an idea inside a target’s mind.');
  const genericAction = movie(9001, 'Generic Mission', [28, 878], 'A team enters a dangerous mission to plant a new idea and save the world.');
  const dreamFilm = movie(9002, 'Dream Heist', [28, 878, 80], 'A team enters shared dreams to steal a memory from a target’s mind.');
  const sharedKeywords = [
    { id: 7601, name: 'mission' },
    { id: 7602, name: 'dreams' },
    { id: 7603, name: 'shared dreams' }
  ];
  const broad = sharedKeywords.slice(0, 2);
  const specific = [sharedKeywords[2], { id: 7604, name: 'heist' }];
  const results = rankSimilarMovies({
    current: inception,
    candidates: [genericAction, dreamFilm],
    currentKeywords: sharedKeywords,
    keywordsById: new Map([[genericAction.id, broad], [dreamFilm.id, specific]])
  });
  assert.deepEqual(results.map(item => item.id), [dreamFilm.id]);
});

test('excludes the current movie, duplicate IDs, and non-movie media', () => {
  const current = movie(120, 'Current', [18, 80], 'A criminal group runs an illegal drug network in a border town.');
  const candidate = movie(121, 'Related', [18, 80], 'A criminal group runs a drug trafficking network in a border town.');
  const keywords = [{ id: 7201, name: 'drug trafficking' }, { id: 7202, name: 'organized crime' }];
  const results = rankSimilarMovies({
    current,
    candidates: [current, { ...candidate, media_type: 'tv' }, candidate, { ...candidate }],
    currentKeywords: keywords,
    keywordsById: new Map([[121, keywords]])
  });
  assert.deepEqual(results.map(item => item.id), [121]);
});

test('does not mix animated films with live action based on other shared metadata', () => {
  const current = movie(130, 'Animated Adventure', [16, 12], 'A hero travels through space to save a distant world.');
  const candidate = movie(131, 'Live Action Adventure', [12, 28], 'A hero travels through space to save a distant world.');
  const keywords = [{ id: 7301, name: 'space travel' }, { id: 7302, name: 'saving the world' }];
  assert.deepEqual(rankSimilarMovies({
    current,
    candidates: [candidate],
    currentKeywords: keywords,
    keywordsById: new Map([[131, keywords]])
  }), []);
});

test('combines similar and recommended TMDB sources without duplicates', () => {
  const similar = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const recommended = [{ id: 2 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(mergeCandidateSources(similar, recommended, 5).map(item => item.id), [1, 2, 4, 3, 5]);
});

test('similar-movie add buttons toggle the movie ID, refresh immediately, and persist add/remove', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const extract = (name, nextName) => {
    const start = html.indexOf(`function ${name}(`);
    let end = html.indexOf(String.fromCharCode(10) + '  function ' + nextName, start);
    if (end < 0) end = html.indexOf(String.fromCharCode(10) + '  const ' + nextName, start);
    assert.ok(start >= 0 && end > start, `Could not find ${name}`);
    return html.slice(start, end).trim();
  };

  const user = { sessionToken: 'test-session', list: [] };
  const syncSnapshots = [];
  let saved = 0;
  let cleared = 0;
  const button = {
    dataset: { similarMovieAdd: '445566', similarTitle: 'Test Movie', similarPoster: '/poster.jpg', similarDate: '2024-01-01' },
    attributes: {}, listeners: {}, classes: new Set(), innerHTML: '', title: '',
    classList: { toggle(name, enabled) { enabled ? button.classes.add(name) : button.classes.delete(name); } },
    setAttribute(name, value) { button.attributes[name] = String(value); },
    addEventListener(name, listener) { button.listeners[name] = listener; }
  };
  const context = {
    user,
    $: () => null,
    $$: selector => selector === '[data-similar-movie-add]' ? [button] : [],
    mediaTypeOf: item => item?.media_type === 'tv' || item?.media_type === 'movie' ? item.media_type : (item?.name && !item?.title ? 'tv' : 'movie'),
    collectionMarkerState: (id, type) => ({ listed: user.list.some(item => Number(item.id) === Number(id) && item.media_type === type) }),
    cardActionIcon: name => `icon:${name}`,
    save: () => { saved += 1; },
    renderList: () => {},
    renderProfile: () => {},
    syncTimer: 123,
    syncStateToServer: async () => { syncSnapshots.push(user.list.map(item => ({ ...item }))); return true; },
    setTimeout: () => 456,
    clearTimeout: () => { cleared += 1; },
    location: { hash: '' }
  };
  context.refreshPersonalMarkers = vm.runInNewContext(`(${extract('refreshPersonalMarkers', 'toggleList')})`, context);
  context.toggleList = vm.runInNewContext(`(${extract('toggleList', 'toggleFavorite')})`, context);
  const bind = vm.runInNewContext(`(${extract('bindSimilarMovieActions', 'safeBackdropUrl')})`, context);
  bind({ querySelectorAll: selector => selector === '[data-similar-movie-add]' ? [button] : [] });

  const click = () => ({ preventDefault() {}, stopPropagation() {} });
  await button.listeners.click(click());
  assert.deepEqual(user.list.map(item => [item.id, item.media_type]), [[445566, 'movie']]);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.title, 'Remover da minha lista');
  assert.equal(button.innerHTML, 'icon:i-check');
  assert.equal(syncSnapshots[0][0].id, 445566);
  assert.equal(syncSnapshots[0][0].media_type, 'movie');
  assert.equal(saved, 1);
  assert.equal(cleared, 1);

  // Simulate a page reload from the state accepted by the server.
  user.list = syncSnapshots[0].map(item => ({ ...item }));
  context.refreshPersonalMarkers();
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.innerHTML, 'icon:i-check');

  await button.listeners.click(click());
  assert.equal(user.list.length, 0);
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.title, 'Adicionar à minha lista');
  assert.equal(button.innerHTML, 'icon:i-plus');
  assert.deepEqual(syncSnapshots[1], []);
  assert.equal(saved, 2);
  assert.equal(cleared, 2);
});

test('movie list state survives a reload through the authenticated API in an isolated data directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-movie-list-test-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const adminKey = 'synthetic-movie-test-key';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, UPLOAD_DIR: uploadDir, ADMIN_KEY: adminKey, ADMIN_USERNAME: '', ADMIN_BOOTSTRAP_SECRET: '', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('isolated test server did not become ready');
  }
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const create = await fetch(`${base}/api/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ name: 'Synthetic Movie List', username: 'synthetic_movie_list', password: 'Synthetic-password-123!' })
  });
  assert.equal(create.status, 201);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic_movie_list', password: 'Synthetic-password-123!' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const headers = { 'content-type': 'application/json', cookie };
  const item = { id: 445566, media_type: 'movie', title: 'Synthetic Movie', name: 'Synthetic Movie', poster_path: '/poster.jpg', release_date: '2024-01-01' };

  const added = await fetch(`${base}/api/me/state`, { method: 'POST', headers, body: JSON.stringify({ state: { list: [item] } }) });
  assert.equal(added.status, 200);
  const afterReload = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(afterReload.status, 200);
  assert.deepEqual((await afterReload.json()).state.list.map(entry => [entry.id, entry.media_type]), [[445566, 'movie']]);

  const removed = await fetch(`${base}/api/me/state`, { method: 'POST', headers, body: JSON.stringify({ state: { list: [] } }) });
  assert.equal(removed.status, 200);
  const afterRemoval = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(afterRemoval.status, 200);
  assert.deepEqual((await afterRemoval.json()).state.list, []);
});
