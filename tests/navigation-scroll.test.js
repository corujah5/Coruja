const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name, nextFunctionName) {
  const start = html.indexOf(`  function ${name}(`);
  const end = html.indexOf(`\n  function ${nextFunctionName}(`, start);
  assert.notEqual(start, -1, `${name} should exist in public/index.html`);
  assert.notEqual(end, -1, `${nextFunctionName} should follow ${name}`);
  return html.slice(start, end);
}

function createGridBox(id) {
  return {
    id,
    children: [],
    replaceCount: 0,
    replaceChildren() {
      this.children = [];
      this.replaceCount++;
    }
  };
}

function createCard(item) {
  return {
    dataset: { mediaType: item.media_type, mediaId: String(item.id) },
    matches(selector) { return selector === '.card[data-media-id]'; }
  };
}

function renderGridFunctionHarness() {
  const states = new Map();
  const controls = new Map();
  const context = {
    progressiveGridStates: states,
    mediaTypeOf: item => item.media_type || 'movie',
    ensureProgressiveLoadControl(box) {
      if (!controls.has(box)) controls.set(box, { hidden: false });
      return controls.get(box);
    },
    appendProgressiveGridBatch(id) {
      const state = states.get(id);
      const next = state.items.slice(state.shown, state.shown + 18);
      state.container.children.push(...next.map(createCard));
      state.shown += next.length;
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('renderProgressiveGrid', 'appendProgressiveGridBatch'), context);
  return { context, states };
}

test('progressive grid keeps state only when its rendered DOM still matches', () => {
  const { context, states } = renderGridFunctionHarness();
  const original = createGridBox('profileCollectionGrid');
  const items = [{ id: 11, media_type: 'tv' }, { id: 12, media_type: 'tv' }, { id: 11, media_type: 'tv' }];

  context.renderProgressiveGrid(original, items, item => item);
  assert.equal(original.children.length, 2);
  assert.equal(original.replaceCount, 1);
  assert.equal(states.get(original.id).container, original);

  context.renderProgressiveGrid(original, items, item => item);
  assert.equal(original.children.length, 2, 'unchanged rendered grid should not be rebuilt');
  assert.equal(original.replaceCount, 1);

  original.children = [];
  context.renderProgressiveGrid(original, items, item => item);
  assert.equal(original.children.length, 2, 'a cleared persistent grid must render again');
  assert.equal(original.replaceCount, 2);

  const replacement = createGridBox(original.id);
  context.renderProgressiveGrid(replacement, items, item => item);
  assert.equal(replacement.children.length, 2, 'a new grid with the same id must render its first batch');
  assert.equal(replacement.replaceCount, 1);
  assert.equal(states.get(replacement.id).container, replacement);
});

test('route scroll restoration does not override a newer user interaction', () => {
  let route = '#series';
  let intentVersion = 3;
  const frames = [];
  const scrollCalls = [];
  const context = {
    routeHash: value => value,
    location: { get hash() { return route; } },
    scrollIntentVersion: intentVersion,
    requestAnimationFrame(callback) { frames.push(callback); },
    scrollToWithoutAnimation(top) { scrollCalls.push(top); }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('restoreRouteScroll', 'showView'), context);

  context.restoreRouteScroll({ route: '#series', scrollY: 520 });
  context.scrollIntentVersion++;
  while (frames.length) frames.shift()();
  assert.deepEqual(scrollCalls, [], 'new user intent should cancel stale restoration');

  context.scrollIntentVersion = intentVersion;
  context.restoreRouteScroll({ route: '#series', scrollY: 520 });
  while (frames.length) frames.shift()();
  assert.deepEqual(scrollCalls, [520]);

  route = '#movies';
  context.restoreRouteScroll({ route: '#series', scrollY: 520 });
  while (frames.length) frames.shift()();
  assert.deepEqual(scrollCalls, [520], 'restoration must not cross route boundaries');
});

test('detail return keeps the originating category and its saved scroll position', () => {
  const context = {
    currentRouteHash: '#series-populares',
    previousRouteHash: null,
    detailReturnPoint: null,
    pendingRouteScrollRestore: null,
    detailBackInProgress: false,
    location: { hash: '#series-populares' },
    routeScrollPositions: new Map([['#series-populares', 1360]]),
    routeHash: value => `#${String(value || '').replace(/^#/, '')}`,
    isDetailRouteHash: value => /^#(?:movie|tv)-\d+$/.test(value),
    isReturnableRouteHash: value => new Set(['series-populares', 'descobrir']).has(String(value || '').replace(/^#/, ''))
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('trackDetailRouteTransition', 'restoreRouteScroll'), context);

  context.location.hash = '#tv-42';
  context.trackDetailRouteTransition();
  assert.equal(context.detailReturnPoint.route, '#series-populares');
  assert.equal(context.detailReturnPoint.scrollY, 1360);

  context.location.hash = '#series-populares';
  context.trackDetailRouteTransition();
  assert.equal(context.pendingRouteScrollRestore.route, '#series-populares');
  assert.equal(context.pendingRouteScrollRestore.scrollY, 1360);
  assert.equal(context.detailReturnPoint, null);
});

test('episode resume waits for the detail route instead of relying on a fixed timer', () => {
  const resumeStart = html.indexOf('  function resumeContinuePosition(');
  const resumeEnd = html.indexOf('\n  async function waitForShowDetails(', resumeStart);
  assert.notEqual(resumeStart, -1);
  assert.notEqual(resumeEnd, -1);
  const resume = html.slice(resumeStart, resumeEnd);
  assert.match(resume, /await waitForShowDetails\(tvId,showRoute\)/);
  assert.match(resume, /await loadTemporada\(season\)/);
  assert.doesNotMatch(resume, /setTimeout\(/);
});

test('profile carousel permits vertical page scrolling on touch devices', () => {
  const carouselRules = [...html.matchAll(/(?:#perfil\s+)?\.profileCarousel\s*\{[^}]*\}/g)].map(match => match[0]);
  assert.ok(carouselRules.length > 0);
  assert.ok(carouselRules.every(rule => !/touch-action\s*:\s*pan-x\s*;/.test(rule)));
});

test('profile metadata hydration updates rendered cards without rebuilding the page', () => {
  const request = extractFunction('requestProfileMetadata', 'profileCard');
  assert.match(request, /updateRenderedProfileMetadata\(type,item\.id,metadata\)/);
  assert.doesNotMatch(request, /renderProfile\(\)/);
});

test('profile favorite shelves use the connected account collections and open the full matching category', () => {
  const profileStart = html.indexOf('  function renderProfile(){');
  const profileEnd = html.indexOf('  }  function positionKey', profileStart);
  const renderProfile = html.slice(profileStart, profileEnd);
  assert.ok(renderProfile.includes("profileFavoritesFor('tv')"));
  assert.match(renderProfile, /profileSeriesCollection/);
  assert.ok(renderProfile.includes("more.onclick=()=>{location.hash='perfil-colecao-'+section.kind}"));
  assert.ok(renderProfile.includes("more.textContent='›'"));
  assert.match(renderProfile, /title:'Séries',kind:'series'/);
  assert.match(html, /#perfil \.profileSeriesCollection\{margin:0 0 30px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none\}/);
  assert.ok(renderProfile.includes("profileCard(item,{profileShelf:true,seriesStatusShelf:true})"));
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.profilePosterRule\{display:block;width:100%;height:4px/);
  assert.match(html, /flex-basis:clamp\(92px,24vw,110px\);width:clamp\(92px,24vw,110px\)/);
  assert.match(html, /profileSeriesCollection \.profileCarousel \.card h3/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card\{[^}]*border:0[^}]*background:transparent/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel\{[^}]*scroll-behavior:smooth;scrollbar-width:none/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card\{flex:0 0 176px;width:176px/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card h3\{[^}]*-webkit-line-clamp:2/);
});

test('profile section arrows are unboxed, visible, and retain the existing collection routes', () => {
  assert.match(html, /#perfil \.profileSeriesCollection \.profileSeeMore\{[^}]*border:0;border-radius:0;background:transparent;color:#b8f34a;font-size:40px/);
  assert.doesNotMatch(html, /#perfil \.profileSeriesCollection \.profileSeeMore::after/);
  assert.match(html, /#perfil \.profileSeriesCollection\{margin:0 0 30px/);
  assert.match(html, /#perfil \.profileSeriesCollection\{margin-bottom:24px\}/);
  const start = html.indexOf('  function renderProfile(){');
  const end = html.indexOf('  }  function positionKey', start);
  const renderProfile = html.slice(start, end);
  assert.ok(renderProfile.includes("more.onclick=()=>{location.hash='perfil-colecao-'+section.kind}"));
  assert.ok(renderProfile.includes("more.setAttribute('aria-label',isFavoriteSection?`Ver todos: ${section.title}`:`Ver mais: ${section.title}`)"));
});

test('profile shelf poster underline is decorative and has no progress semantics', () => {
  const start = html.indexOf('  function profileCard(');
  const end = html.indexOf('  function updateProfileProgressCard', start);
  const profileCard = html.slice(start, end);
  const ruleStart = profileCard.indexOf('if(profileShelf)');
  const ruleEnd = profileCard.indexOf('el.classList.add(', ruleStart);
  const ruleInsertion = profileCard.slice(ruleStart, ruleEnd);
  assert.match(ruleInsertion, /profilePosterRule/);
  assert.match(ruleInsertion, /rule\.setAttribute\('aria-hidden','true'\)/);
  assert.doesNotMatch(ruleInsertion, /watched|positions|progress/i);
  assert.ok(html.includes("profileCard(item,{profileShelf:true,seriesStatusShelf:true})"));
});

test('favorite profile cards show only the title below their poster and preserve overlays', () => {
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card small,\s*#perfil \.profileSeriesCollection \.profileCarousel \.card \.stars\{display:none!important\}/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card h3\{[^}]*-webkit-line-clamp:2/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.poster\{border-radius:14px\}/);
  const cardStart = html.indexOf('  function card(');
  const cardEnd = html.indexOf('\n', cardStart);
  const cardSource = html.slice(cardStart, cardEnd);
  assert.match(cardSource, /class="score"/);
  assert.match(cardSource, /class="add /);
  assert.match(cardSource, /class="favorite /);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card \.score,[\s\S]*?#perfil \.profileSeriesCollection \.profileCarousel \.card \.profileProgressPercent\{display:none!important\}/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card \.add/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card \.favorite/);
  assert.match(html, /#perfil \.profileSeriesCollection \.profileCarousel \.card \.seriesProgressTrack/);
});

test('profile favorite toggle adds and removes series favorites and rerenders', () => {
  const start = html.indexOf('  function toggleFavorite(');
  const end = html.indexOf('\n', start);
  assert.notEqual(start, -1);
  const source = html.slice(start, end).trim();
  const calls = { saves: 0, refreshes: 0, profileRenders: 0 };
  const context = {
    user: { favorites: { series: [], movies: [] } },
    mediaTypeOf: item => item.media_type || 'movie',
    save() { calls.saves++; },
    refreshPersonalMarkers() { calls.refreshes++; },
    location: { hash: '#perfil' },
    renderProfile() { calls.profileRenders++; }
  };
  vm.createContext(context);
  context.toggleFavorite = vm.runInContext('(' + source + ')', context);
  context.toggleFavorite({ id: 41, media_type: 'tv', name: 'Série favorita' });
  assert.deepEqual(Array.from(context.user.favorites.series, item => item.id), [41]);
  context.toggleFavorite({ id: 41, media_type: 'tv', name: 'Série favorita' });
  assert.equal(context.user.favorites.series.length, 0);
  assert.equal(calls.saves, 2);
  assert.equal(calls.refreshes, 2);
  assert.equal(calls.profileRenders, 2);
});

test('series tracker visual polish keeps episode thumbnails, codes, titles, progress, and completion controls', () => {
  const start = html.indexOf('  function seriesTrackerRowMarkup(');
  const end = html.indexOf('\n  function seriesTrackerGroupMarkup(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const markup = html.slice(start, end);
  assert.match(markup, /class="seriesTrackerThumb"/);
  assert.match(markup, /class="seriesTrackerMeta"/);
  assert.match(markup, /const code=`S\$\{String\(season\)\.padStart\(2,'0'\)\} \| E\$\{String\(number\)\.padStart\(2,'0'\)\}`/);
  assert.match(markup, /class="seriesTrackerTitle"/);
  assert.match(markup, /class="seriesTrackerCheck/);
  assert.match(markup, /data-tracker-season=/);
  assert.match(markup, /data-tracker-episode=/);
  assert.match(markup, /aria-pressed="\$\{done\}"/);
  assert.match(html, /#episodeFeed \.seriesTrackerItem\{box-sizing:border-box;border-color:#273128;border-radius:10px;background:linear-gradient\(135deg,#151a16,#111512\)/);
  assert.match(html, /#episodeFeed \.seriesTrackerThumb\{border-color:#2b352c;border-radius:8px\}/);
  const trackerCssStart = html.indexOf('/* Acabamento do rastreador:');
  const trackerCssEnd = html.indexOf('/* Listagem agrupada das coleções de Séries do Perfil. */', trackerCssStart);
  assert.ok(trackerCssStart >= 0 && trackerCssEnd > trackerCssStart);
  assert.doesNotMatch(html.slice(trackerCssStart, trackerCssEnd), /#perfil|#filmes/);
});
