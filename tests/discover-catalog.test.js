'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { localDateKey, normalizeDiscoverQuery, buildDiscoverRequest, filterUpcomingPayload } = require('../lib/discover-catalog');

const today = '2026-11-06';

test('catalog source maps to real TMDB trending, popular, and top-rated endpoints', () => {
  for (const [mediaType, source, endpoint] of [
    ['movie', 'trending', '/trending/movie/week'],
    ['tv', 'trending', '/trending/tv/week'],
    ['movie', 'popular', '/movie/popular'],
    ['tv', 'popular', '/tv/popular'],
    ['movie', 'top_rated', '/movie/top_rated'],
    ['tv', 'top_rated', '/tv/top_rated']
  ]) {
    const filters = normalizeDiscoverQuery({ type: mediaType, source, page: '2' }, today);
    const request = buildDiscoverRequest(filters);
    assert.equal(request.endpoint, endpoint);
    assert.equal(request.params.page, 2);
  }
  assert.equal(buildDiscoverRequest(normalizeDiscoverQuery({ type: 'movie', source: 'upcoming' }, today)).endpoint, '/movie/upcoming');
});

test('genre, year, status, and upcoming filters become TMDB discover query parameters', () => {
  const movie = buildDiscoverRequest(normalizeDiscoverQuery({ type: 'movie', source: 'popular', genres: '28,12,28', year: '2025' }, today));
  assert.equal(movie.endpoint, '/discover/movie');
  assert.equal(movie.params.with_genres, '28,12');
  assert.equal(movie.params.primary_release_year, '2025');

  const tv = buildDiscoverRequest(normalizeDiscoverQuery({ type: 'tv', source: 'top_rated', genres: '18', year: '2024', status: 'ongoing' }, today));
  assert.equal(tv.endpoint, '/discover/tv');
  assert.equal(tv.params.with_genres, '18');
  assert.equal(tv.params.first_air_date_year, '2024');
  assert.equal(tv.params.with_status, '0|2');
  assert.equal(tv.params.sort_by, 'vote_average.desc');

  const upcoming = buildDiscoverRequest(normalizeDiscoverQuery({ type: 'movie', source: 'upcoming', genres: '878' }, today));
  assert.equal(upcoming.endpoint, '/discover/movie');
  assert.equal(upcoming.params['primary_release_date.gte'], today);
  assert.equal(upcoming.params.with_genres, '878');
});

test('invalid catalog type and source are rejected; page and genre inputs are bounded', () => {
  assert.throws(() => normalizeDiscoverQuery({ type: 'person' }, today), /Tipo/);
  assert.throws(() => normalizeDiscoverQuery({ type: 'tv', source: 'upcoming' }, today), /Categoria/);
  const filters = normalizeDiscoverQuery({ type: 'movie', page: '900', genres: '0,abc,28,12,28' }, today);
  assert.equal(filters.page, 500);
  assert.deepEqual(filters.genres, ['28', '12']);
});

test('future release dates are compared as calendar strings without timezone shifts', () => {
  const filtered = filterUpcomingPayload({ results: [
    { id: 1, release_date: '2026-11-05' },
    { id: 2, release_date: '2026-11-06' },
    { id: 3, release_date: '2026-11-07' },
    { id: 4, release_date: '' },
    { id: 5, release_date: '2026-11-06T00:30:00Z' }
  ] }, today);
  assert.deepEqual(filtered.results.map(item => item.id), [2, 3]);
  assert.equal(localDateKey(new Date('2026-11-07T02:00:00Z')), '2026-11-06');
});

test('Discover more client uses São Paulo calendar dates and schedules refresh while visible', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const helper = html.match(/function discoverMoreLocalDateKey\(date=new Date\(\)\)\{[\s\S]*?\n  \}/)?.[0];
  assert.ok(helper, 'client date helper exists');
  const dateKey = new vm.Script(`(${helper})`).runInThisContext();
  assert.equal(dateKey(new Date('2026-11-07T02:00:00Z')), '2026-11-06');
  assert.match(html, /setInterval\(\(\)=>\{if\(location\.hash==='#descobrir-mais'&&document\.visibilityState==='visible'\)refreshDiscoverMoreAll\('interval'\)\},10\*60\*1000\)/);
  assert.match(html, /document\.addEventListener\('visibilitychange',[\s\S]*?refreshDiscoverMoreAll\('tab-visible'\)/);
  assert.match(html, /setInterval\(\(\)=>\{if\(location\.hash==='#descobrir-mais'&&document\.visibilityState==='visible'\)checkDiscoverMoreLocalDay\(\)\},30\*1000\)/);
});

test('authenticated discovery APIs use TMDB data, return upcoming dates, genres, and item metadata', async t => {
  const mockToday = localDateKey();
  const before = new Date(`${mockToday}T12:00:00Z`);before.setUTCDate(before.getUTCDate()-1);
  const after = new Date(`${mockToday}T12:00:00Z`);after.setUTCDate(after.getUTCDate()+1);
  const previousDate = before.toISOString().slice(0,10),nextDate=after.toISOString().slice(0,10);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coruja-discover-test-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const mockPath = path.join(root, 'mock-tmdb.cjs');
  fs.writeFileSync(mockPath, `
    const realFetch = global.fetch;
    global.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.themoviedb.org') return realFetch(input, init);
      const pathname = url.pathname.replace(/^\\/3/, '');
      const callKey = pathname + '?' + url.searchParams.toString();
      global.__discoverTestCalls ||= {};
      global.__discoverTestCalls[callKey] = (global.__discoverTestCalls[callKey] || 0) + 1;
      await new Promise(resolve => setTimeout(resolve, 40));
      const page = Number(url.searchParams.get('page') || 1);
      let body = { page, total_pages: 1, total_results: 0, results: [], mock_call_count: global.__discoverTestCalls[callKey] };
      if (pathname === '/movie/upcoming') body = { page, total_pages: 1, total_results: 3, results: [
        { id: 1, title: 'Past', release_date: '${previousDate}' },
        { id: 2, title: 'Release Today', release_date: '${mockToday}' },
        { id: 3, title: 'Future', release_date: '${nextDate}' }
      ] };
      if (pathname === '/genre/tv/list') body = { genres: [{ id: 18, name: 'Drama' }], mock_call_count: global.__discoverTestCalls[callKey] };
      if (pathname === '/discover/tv') body = { page, total_pages: 1, total_results: 1, query: Object.fromEntries(url.searchParams), results: [{ id: 30, name: 'Synthetic Series', first_air_date: '2025-01-01', genre_ids: [18] }] };
      if (pathname === '/movie/123') body = { id: 123, title: 'Synthetic Film', runtime: 121 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `, 'utf8');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const adminKey = 'synthetic-discovery-admin-key';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port), DATA_DIR: dataDir, UPLOAD_DIR: uploadDir,
      ADMIN_KEY: adminKey, ADMIN_USERNAME: '', ADMIN_BOOTSTRAP_SECRET: '',
      TMDB_READ_ACCESS_TOKEN: 'synthetic-tmdb-test-token', NODE_ENV: 'test',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require', mockPath].filter(Boolean).join(' ')
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('isolated discovery test server did not become ready');
  }
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const unauthenticated = await fetch(`${base}/api/discover?type=movie&source=popular`);
  assert.equal(unauthenticated.status, 401);
  const created = await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ name: 'Synthetic Discovery', username: 'synthetic_discovery', password: 'Synthetic-discovery-password-123!' })
  });
  assert.equal(created.status, 201);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic_discovery', password: 'Synthetic-discovery-password-123!' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const headers = { cookie };

  const upcoming = await fetch(`${base}/api/discover?type=movie&source=upcoming&page=1`, { headers });
  assert.equal(upcoming.status, 200);
  assert.deepEqual((await upcoming.json()).results.map(item => [item.id, item.release_date]), [[2, mockToday], [3, nextDate]]);

  const filteredTv = await fetch(`${base}/api/discover?type=tv&source=top_rated&genres=18&year=2025&status=ended`, { headers });
  const tvData = await filteredTv.json();
  assert.equal(filteredTv.status, 200);
  assert.equal(tvData.query.with_genres, '18');
  assert.equal(tvData.query.first_air_date_year, '2025');
  assert.equal(tvData.query.with_status, '3|4');

  const [popularA, popularB] = await Promise.all([
    fetch(`${base}/api/discover?type=movie&source=popular&page=1`, { headers }),
    fetch(`${base}/api/discover?type=movie&source=popular&page=1`, { headers })
  ]);
  assert.equal(popularA.status, 200);
  const [popularDataA, popularDataB] = await Promise.all([popularA.json(), popularB.json()]);
  assert.equal(popularDataA.mock_call_count, 1, 'matching catalog requests share a single TMDB call');
  assert.equal(popularDataB.mock_call_count, 1);
  assert.ok(popularDataA._cacheExpiresAt > Date.now());
  const popularCached = await (await fetch(`${base}/api/discover?type=movie&source=popular&page=1`, { headers })).json();
  assert.equal(popularCached.mock_call_count, 1, 'fresh cache responses do not call TMDB again');
  assert.equal(popularCached._cacheExpiresAt, popularDataA._cacheExpiresAt);

  const [genresA, genresB] = await Promise.all([
    fetch(`${base}/api/discover/genres?type=tv`, { headers }),
    fetch(`${base}/api/discover/genres?type=tv`, { headers })
  ]);
  const [genresDataA, genresDataB] = await Promise.all([genresA.json(), genresB.json()]);
  assert.deepEqual(genresDataA.genres, [{ id: 18, name: 'Drama' }]);
  assert.equal(genresDataA.mock_call_count, 1, 'matching genre requests share a single TMDB call');
  assert.equal(genresDataB.mock_call_count, 1);
  assert.ok(genresDataA._cacheExpiresAt > Date.now() + 23 * 60 * 60 * 1000);
  const genresCached = await (await fetch(`${base}/api/discover/genres?type=tv`, { headers })).json();
  assert.equal(genresCached.mock_call_count, 1, 'fresh genre cache responses do not call TMDB again');
  assert.equal(genresCached._cacheExpiresAt, genresDataA._cacheExpiresAt);
  const item = await fetch(`${base}/api/discover/item/movie/123`, { headers });
  assert.equal((await item.json()).runtime, 121);
});
