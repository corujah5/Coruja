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

test('series category progress prefers current metadata over stale saved episode totals', () => {
  const context = {
    mediaTypeOf: item => item.media_type,
    profileMetadataCache: new Map([['tv:7', { number_of_episodes: 10 }]]),
    seriesEpisodeTotals: new Map([['7', 9]]),
    seriesProgressSnapshot: (id, total) => ({ id, total }),
    user: {}
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionProgress', 'profileCollectionWatchLaterIds'), context);

  const current = context.profileCollectionProgress({ id: 7, media_type: 'tv', number_of_episodes: 12 });
  assert.equal(current.total, 10, 'fresh catalog metadata should override the stale saved total');

  context.profileMetadataCache.clear();
  const cachedDetail = context.profileCollectionProgress({ id: 7, media_type: 'tv', number_of_episodes: 12 });
  assert.equal(cachedDetail.total, 9, 'the episode detail cache should precede stale saved data');

  context.seriesEpisodeTotals.clear();
  const savedFallback = context.profileCollectionProgress({ id: 7, media_type: 'tv', number_of_episodes: 12 });
  assert.equal(savedFallback.total, 12, 'saved totals remain a fallback when current metadata is unavailable');
});

test('favorite series manual order persists only favorite ids and preserves hidden search results', () => {
  const context = {
    profileSeriesFavoriteOrderIds: () => ['11', '22', '33', '44']
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionMergeFavoriteOrder', 'profileCollectionType'), context);

  const reordered = context.profileCollectionMergeFavoriteOrder(
    [{ id: 11 }, { id: 22 }, { id: 33 }, { id: 44 }],
    ['33', '11'],
    ['11', '22', '33', '44']
  );

  assert.deepEqual(Array.from(reordered), ['33', '22', '11', '44']);
});

test('favorite series status groups reuse the shared classifier and omit the interrupted category', () => {
  const context = { profileCollectionSeriesMainGroupKey: item => item.classifiedAs };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionFavoriteSeriesGroupKey', 'profileCollectionRenderFavoriteSeriesStatusGroups'), context);
  assert.equal(context.profileCollectionFavoriteSeriesGroupKey({ status: 'Interrompida', classifiedAs: 'toWatch' }), 'toWatch');
  assert.equal(context.profileCollectionFavoriteSeriesGroupKey({ classifiedAs: 'inDay' }), 'inDay');
  assert.equal(context.profileCollectionFavoriteSeriesGroupKey({ classifiedAs: 'finished' }), 'finished');

  const groups = extractFunction('profileCollectionRenderFavoriteSeriesStatusGroups', 'profileCollectionRenderFavoriteSeriesReorder');
  const labels = Array.from(groups.matchAll(/label:'([^']+)'/g), match => match[1]);
  assert.deepEqual(labels, ['PARA VER', 'NÃO INICIADAS', 'EM DIA', 'TERMINADAS', 'CANCELADAS']);
  assert.doesNotMatch(groups, /interrupted|INTERROMPIDAS|Interrompida/);
  assert.doesNotMatch(html, /seriesFavoritesCollectionPage \.profileCollectionStatusTrack\[data-status="interrupted"\]/);
});

test('general series collection hides favorite reorder controls and does not treat inactivity as interruption', () => {
  assert.match(html, /\.seriesProfileCollectionPage:not\(\.seriesFavoritesCollectionPage\) \.catalogHead>\.profileCollectionTool\[hidden\]\{display:none\}/);
  const context = {
    mediaTypeOf: item => item.media_type,
    profileCollectionProgress: () => ({ started: true, completed: false, watched: 3, total: 10, percent: 30 }),
    profileCollectionLastActivity: () => Date.now() - 31 * 24 * 60 * 60 * 1000,
    profileCollectionWatchLaterIds: () => new Set(),
    profileCollectionHasExplicitInterruptedStatus: () => false,
    profileCollectionHasRewatchedEpisodes: () => false,
    profileMetadataCache: new Map([['tv:7', { status: 'Returning Series' }]]),
    user: { favorites: { series: [] } }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionStatus', 'profileCollectionStatusGroupKey'), context);
  const status = context.profileCollectionStatus({ id: 7, media_type: 'tv' });
  assert.equal(status.toWatch, true);
  assert.equal(status.stale, true);
  assert.equal(status.interrupted, false);
});

test('favorite series reorder confirmation saves once and keeps filtered favorites in their original slots', () => {
  const context = {
    user: { profileSeriesFavoritesOrder: ['11', '22', '33', '44'] },
    saves: 0,
    profileCollectionStates: new Map(),
    profileCollectionCurrentKind: 'series-favoritas',
    location: { hash: '#perfil-colecao-series-favoritas' }
  };
  context.save = () => { context.saves++; };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileSeriesFavoriteOrderIds', 'profileCollectionBeginFavoriteReorder'), context);
  vm.runInContext(extractFunction('profileCollectionMergeFavoriteOrder', 'profileCollectionBeginFavoriteReorder'), context);
  vm.runInContext(extractFunction('profileCollectionConfirmFavoriteReorder', 'profileCollectionDiscardFavoriteReorderIfLeaving'), context);
  const state = { kind: 'series-favoritas', items: [{id:11},{id:22},{id:33},{id:44}], reorderMode: true, pendingFavoriteOrder: ['11','22','33','44'] };
  assert.equal(context.profileCollectionConfirmFavoriteReorder(state, ['33','11']), true);
  assert.deepEqual(Array.from(context.user.profileSeriesFavoritesOrder), ['33','22','11','44']);
  assert.equal(context.saves, 1);
  assert.equal(state.reorderMode, false);
  assert.equal(state.pendingFavoriteOrder, null);
});

test('cancel and leaving favorite series reorder discard pending order without saving', () => {
  const original = ['11', '22', '33', '44'];
  const state = { kind: 'series-favoritas', reorderMode: true, pendingFavoriteOrder: ['33','22','11','44'], reorderIds: ['33','22','11','44'] };
  const context = {
    user: { profileSeriesFavoritesOrder: original.slice() },
    profileCollectionStates: new Map([['series-favoritas', state]]),
    profileCollectionCurrentKind: 'series-favoritas',
    location: { hash: '#perfil-colecao-series-favoritas' },
    saves: 0,
    save() { this.saves++; }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionCancelFavoriteReorder', 'profileCollectionConfirmFavoriteReorder'), context);
  vm.runInContext(extractFunction('profileCollectionDiscardFavoriteReorderIfLeaving', 'profileCollectionType'), context);
  assert.equal(context.profileCollectionDiscardFavoriteReorderIfLeaving('#perfil-colecao-series-favoritas'), false);
  assert.equal(state.reorderMode, true);
  assert.equal(context.profileCollectionDiscardFavoriteReorderIfLeaving('#perfil'), true);
  assert.equal(state.reorderMode, false);
  assert.deepEqual(Array.from(context.user.profileSeriesFavoritesOrder), original);
  assert.equal(state.pendingFavoriteOrder, null);
  assert.equal(state.reorderIds.length, 0);
  assert.equal(context.saves, 0);
});

test('favorite series collection exposes scoped search, status grouping, and reorder controls', () => {
  assert.match(html, /id="profileCollectionSortToggle"[^>]*profileCollectionSortToggle[^>]*hidden/);
  assert.match(html, /seriesFavoritesCollectionPage \.catalogHead\{grid-template-columns:40px minmax\(0,1fr\) 36px 36px 36px\}/);
  assert.match(html, /sortToggle\.hidden=kind!=='series-favoritas'\|\|state\.statusView/);
  assert.match(html, /sortToggle\?\.addEventListener\('click'/);
  assert.match(html, /profileCollectionRenderFavoriteSeriesReorder\(state,items\)/);
  assert.match(html, /id="profileCollectionCancelReorderToggle"[^>]*hidden/);
  assert.match(html, /cancelToggle\?\.addEventListener\('click'/);
  assert.match(html, /profileCollectionDiscardFavoriteReorderIfLeaving\(location\.hash\)/);
  assert.match(html, /kind==='series-favoritas'&&favoriteReorderState\?\.reorderMode/);
  assert.match(html, /seriesFavoritesCollectionPage \.catalogHead>\.profileCollectionTool\[hidden\]\{display:none\}/);
  assert.match(html, /seriesFavoritesCollectionPage \.catalogHead>\.profileCollectionCancelReorderToggle\{font-size:26px;line-height:1\}/);
  assert.match(html, /seriesFavoritesCollectionPage \.profileFavoritesReorderList\{grid-column:1\/-1;box-sizing:border-box;width:100%;min-width:0;display:grid;gap:10px\}/);
  assert.match(html, /seriesFavoritesCollectionPage \.profileFavoritesReorderTitle\{min-width:0;overflow-wrap:anywhere;text-align:center;font-size:16px;font-weight:800;text-overflow:clip;white-space:normal\}/);
  assert.match(html, /profileFavoritesReorderHandle/);
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

test('general profile series exposes the 11 remaining filter choices in the requested order', () => {
  const optionsStart = html.indexOf('const profileSeriesFilterOptions=');
  const optionsEnd = html.indexOf(';', optionsStart);
  assert.ok(optionsStart >= 0 && optionsEnd > optionsStart);
  const options = html.slice(optionsStart, optionsEnd);
  const labels = Array.from(options.matchAll(/\['[^']+','([^']+)'\]/g), match => match[1]);
  assert.deepEqual(labels, ['Todas', 'Para ver', 'Brevemente', 'Sem ver há algum tempo', 'Não iniciadas', 'Ver mais tarde', 'Em dia', 'Terminadas', 'Canceladas', 'Interrompidas', 'Favoritas']);
  assert.match(html, /id="profileCollectionFilterToggle"[^>]*hidden/);
  assert.match(html, /id="profileCollectionFilterMenu" class="profileCollectionFilterMenu" role="menu"/);
  assert.match(html, /data-profile-series-filter/);
  assert.match(html, /state\.filterMenuOpen=!state\.filterMenuOpen/);
  assert.match(html, /state\.filter=option\.dataset\.profileSeriesFilter;state\.filterMenuOpen=false/);
  assert.doesNotMatch(html, /if\(kind==='series'\)state\.filter='all'/);
});

test('each general series filter applies its real status predicate and favorites remains transversal', () => {
  const context = {
    profileCollectionStatus: item => item.status,
    profileCollectionSeriesMainGroupKey: item => item.group,
    profileCollectionHasExplicitInterruptedStatus: item => !!item.status.interrupted,
    profileCollectionHasRewatchedEpisodes: item => !!item.status.rewatched,
    mediaTypeOf: item => item.media_type,
    user: { favorites: { series: [] } }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionMatchesFilter', 'profileCollectionSortValue'), context);
  const filters = ['toWatch', 'upcoming', 'stale', 'notStarted', 'later', 'inDay', 'finished', 'canceled', 'interrupted', 'rewatched', 'favorites'];
  const mainGroups = ['toWatch', 'notStarted', 'inDay', 'finished', 'canceled'];
  const items = filters.map((filter, index) => ({ id: index + 1, media_type: 'tv', group: mainGroups.includes(filter) ? filter : null, status: { [filter]: true, favorites: filter === 'favorites' || filter === 'inDay' } }));
  for (const filter of filters) {
    const state = { kind: 'series', filter };
    const matching = items.filter(item => context.profileCollectionMatchesFilter(item, state));
    assert.ok(matching.length > 0, `${filter} returns matching real status records`);
    assert.ok(matching.every(item => item.status[filter]), `${filter} excludes unrelated records`);
  }
  const all = items.filter(item => context.profileCollectionMatchesFilter(item, { kind: 'series', filter: 'all' }));
  assert.equal(all.length, items.length, 'Todas does not exclude a series based on its status');
  const favorites = items.filter(item => context.profileCollectionMatchesFilter(item, { kind: 'series', filter: 'favorites' }));
  assert.deepEqual(Array.from(favorites, item => item.id), [6, 11], 'Favoritas includes favorite series across statuses');
  const canceledProgress = { id: 20, media_type: 'tv', group: 'canceled', status: { canceled: true, toWatch: true } };
  assert.equal(context.profileCollectionMatchesFilter(canceledProgress, { kind: 'series', filter: 'toWatch' }), false, 'canceled series do not leak into PARA VER');
  assert.equal(context.profileCollectionMatchesFilter(canceledProgress, { kind: 'series', filter: 'canceled' }), true);
});

test('series filters combine with the existing search query without clearing it', () => {
  const context = {
    mediaTypeOf: item => item.media_type,
    profileCollectionMatchesFilter: (item, state) => state.filter === 'all' || !!item.status[state.filter],
    profileCollectionSortValue: () => 0
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionVisibleItems', 'profileCollectionCard'), context);
  const items = [
    { id: 1, name: 'The Last Kingdom', status: { stale: true } },
    { id: 2, name: 'The Office', status: { stale: true } },
    { id: 3, name: 'The Last Kingdom: Seven Kings', status: { stale: false } }
  ];
  const state = { kind: 'series', filter: 'stale', query: 'Last Kingdom', sort: 'added', direction: 'desc', items };
  const visible = context.profileCollectionVisibleItems(state);
  assert.deepEqual(Array.from(visible, item => item.id), [1]);
  assert.equal(state.query, 'Last Kingdom', 'rendering the filter does not erase the search query');
});

test('general profile series exposes the five approved sorting options and selected menu state', () => {
  const optionsStart = html.indexOf('const profileSeriesSortOptions=');
  const optionsEnd = html.indexOf(';', optionsStart);
  assert.ok(optionsStart >= 0 && optionsEnd > optionsStart);
  const options = html.slice(optionsStart, optionsEnd);
  const labels = Array.from(options.matchAll(/\['[^']+','([^']+)'\]/g), match => match[1]);
  assert.deepEqual(labels, ['Vistos recentemente', 'Nome (A → Z)', 'Progresso', 'Adicionado recentemente', 'Por estado']);
  assert.match(html, /id="profileSeriesSortMenuToggle"[^>]*hidden/);
  assert.match(html, /id="profileSeriesSortMenu" class="profileCollectionFilterMenu profileSeriesSortMenu" role="menu"/);
  assert.match(html, /data-profile-series-sort/);
  assert.match(html, /option\.setAttribute\('aria-checked',String\(state\.sort===key\)\)/);
  assert.match(html, /state\.sort=option\.dataset\.profileSeriesSort/);
});

test('general profile series sorting uses real activity, stable addition/progress ties, and CORUJA status order', () => {
  const context = {
    profileCollectionType: () => 'tv',
    profileMetadataCache: new Map(),
    profileCollectionStatus: item => ({ progress: item.progress }),
    profileCollectionLastActivity: item => item.activity,
    profileCollectionSeriesMainGroupKey: item => item.group,
    profileCollectionMatchesFilter: (item, state) => state.filter === 'all' || item.filters.includes(state.filter),
    profileSeriesFavoriteOrderIds: () => []
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionSortValue', 'profileCollectionVisibleItems'), context);
  vm.runInContext(extractFunction('profileCollectionVisibleItems', 'profileCollectionCard'), context);
  const items = [
    { id: 1, name: 'Zeta', addedAt: '2026-01-03T00:00:00Z', activity: 100, group: 'toWatch', filters: ['toWatch'], progress: { watched: 2, total: 4 } },
    { id: 2, name: 'Alpha', addedAt: '2026-01-05T00:00:00Z', activity: 300, group: 'notStarted', filters: ['notStarted'], progress: { watched: 3, total: 4 } },
    { id: 3, name: 'Beta', addedAt: '2026-01-04T00:00:00Z', activity: 200, group: 'inDay', filters: ['inDay', 'toWatch'], progress: { watched: 2, total: 10 } },
    { id: 4, name: 'Delta', addedAt: '2026-01-02T00:00:00Z', activity: 0, group: 'finished', filters: ['finished'], progress: { watched: 5, total: 5 } },
    { id: 5, name: 'Gamma', addedAt: '2026-01-01T00:00:00Z', activity: 0, group: 'canceled', filters: ['canceled'], progress: { watched: 0, total: 0 } }
  ];
  const visibleIds = sort => Array.from(context.profileCollectionVisibleItems({ kind: 'series', filter: 'all', query: '', sort, items }), item => item.id);
  assert.deepEqual(visibleIds('seen'), [2, 3, 1, 4, 5], 'Vistos recentemente uses latest activity descending');
  assert.deepEqual(visibleIds('name'), [2, 3, 4, 5, 1], 'Nome sorts alphabetically ascending');
  assert.deepEqual(visibleIds('progress'), [4, 2, 1, 3, 5], 'Progresso compares real watched/total ratios descending');
  assert.deepEqual(visibleIds('added'), [2, 3, 1, 4, 5], 'Adicionado recentemente uses addedAt, not activity');
  assert.deepEqual(visibleIds('status'), [1, 2, 3, 4, 5], 'Por estado follows PARA VER, NÃO INICIADAS, EM DIA, TERMINADAS, CANCELADAS');
  const same = [{ ...items[0], id: 20, activity: 50 }, { ...items[0], id: 21, activity: 50 }, { ...items[0], id: 22, activity: 50 }];
  const stable = context.profileCollectionVisibleItems({ kind: 'series', filter: 'all', query: '', sort: 'seen', items: same });
  assert.deepEqual(Array.from(stable, item => item.id), [20, 21, 22], 'equal sort values preserve source order');
});

test('series sorting combines with filters and search without replacing either state', () => {
  const context = {
    profileCollectionType: () => 'tv', profileMetadataCache: new Map(),
    profileCollectionStatus: item => ({ progress: item.progress }),
    profileCollectionLastActivity: item => item.activity,
    profileCollectionSeriesMainGroupKey: item => item.group,
    profileCollectionMatchesFilter: (item, state) => state.filter === 'all' || item.filters.includes(state.filter),
    profileSeriesFavoriteOrderIds: () => []
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionSortValue', 'profileCollectionVisibleItems'), context);
  vm.runInContext(extractFunction('profileCollectionVisibleItems', 'profileCollectionCard'), context);
  const items = [
    { id: 1, name: 'The Office', filters: ['toWatch'], activity: 10, group: 'toWatch', progress: { watched: 1, total: 2 } },
    { id: 2, name: 'The Last Kingdom', filters: ['toWatch'], activity: 30, group: 'toWatch', progress: { watched: 2, total: 4 } },
    { id: 3, name: 'The Last Kingdom: Seven Kings', filters: ['finished'], activity: 40, group: 'finished', progress: { watched: 1, total: 1 } }
  ];
  const state = { kind: 'series', filter: 'toWatch', query: 'Last Kingdom', sort: 'seen', direction: 'desc', items };
  assert.deepEqual(Array.from(context.profileCollectionVisibleItems(state), item => item.id), [2]);
  assert.equal(state.filter, 'toWatch');
  assert.equal(state.query, 'Last Kingdom');
});

test('rewatched and interrupted filters require explicit real user records', () => {
  const context = {
    mediaTypeOf: item => item.media_type,
    user: {
      watched: { '7-1-1': true, '7-1-2': true, '8-1-1': true },
      episodeWatchCounts: { '7-1-1': 1, '7-1-2': 2, '8-1-1': 1 },
      watchDurations: { episodeRewatches: {} },
      seriesStatuses: { '9': 'interrompida' }
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionHasRewatchedEpisodes', 'profileCollectionHasExplicitInterruptedStatus'), context);
  vm.runInContext(extractFunction('profileCollectionHasExplicitInterruptedStatus', 'profileCollectionStatus'), context);
  assert.equal(context.profileCollectionHasRewatchedEpisodes({ id: 7, media_type: 'tv' }), true);
  assert.equal(context.profileCollectionHasRewatchedEpisodes({ id: 8, media_type: 'tv' }), false);
  assert.equal(context.profileCollectionHasRewatchedEpisodes({ id: 10, media_type: 'tv' }), false);
  assert.equal(context.profileCollectionHasExplicitInterruptedStatus({ id: 9, media_type: 'tv' }), true);
  assert.equal(context.profileCollectionHasExplicitInterruptedStatus({ id: 10, media_type: 'tv', status: 'Returning Series' }), false, 'catalog lifecycle is not an interruption marker');
  assert.equal(context.profileCollectionHasExplicitInterruptedStatus({ id: 11, media_type: 'tv', userStatus: 'interrupted' }), true);
});

test('series with no watched episodes remain unstarted despite a partial playback position', () => {
  const context = {
    mediaTypeOf: item => item.media_type,
    profileMetadataCache: new Map([['tv:1', { status: 'Returning Series' }]]),
    profileCollectionProgress: () => ({ started: true, completed: false, watched: 0, total: 10, percent: 0 }),
    profileCollectionLastActivity: () => 0,
    profileCollectionToday: () => '2026-11-07',
    profileCollectionWatchLaterIds: () => new Set(),
    profileCollectionHasExplicitInterruptedStatus: () => false,
    user: { favorites: { series: [] } }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionStatus', 'profileCollectionStatusGroupKey'), context);
  vm.runInContext(extractFunction('profileCollectionStatusGroupKey', 'profileCollectionSeriesStatusGroupKey'), context);
  vm.runInContext(extractFunction('profileCollectionSeriesStatusGroupKey', 'profileCollectionMetadata'), context);
  vm.runInContext(extractFunction('profileCollectionSeriesMainGroupKey', 'profileCollectionRenderSeriesMainGroups'), context);
  vm.runInContext(extractFunction('profileCollectionMatchesFilter', 'profileCollectionSortValue'), context);
  const item = { id: 1, media_type: 'tv' };
  const status = context.profileCollectionStatus(item);
  assert.equal(status.notStarted, true);
  assert.equal(status.toWatch, false);
  assert.equal(context.profileCollectionSeriesMainGroupKey(item), 'notStarted');
  assert.equal(context.profileCollectionMatchesFilter(item, { kind: 'series', filter: 'notStarted' }), true);
});

test('upcoming and stale filters require actual future air dates and recorded activity', () => {
  const now = Date.now();
  const context = {
    mediaTypeOf: item => item.media_type,
    profileMetadataCache: new Map([
      ['tv:1', { status: 'Returning Series', first_air_date: '2026-11-10' }],
      ['tv:2', { status: 'Returning Series', first_air_date: '2020-01-01', next_episode_to_air: { air_date: '2026-11-10' } }],
      ['tv:3', { status: 'Returning Series' }]
    ]),
    profileCollectionProgress: item => item.id === 1 || item.id === 3
      ? { started: false, completed: false, watched: 0, total: 10, percent: 0 }
      : { started: true, completed: false, watched: 2, total: 10, percent: 20 },
    profileCollectionLastActivity: item => item.id === 2 ? now - 2 * 24 * 60 * 60 * 1000 : item.id === 4 ? now - 31 * 24 * 60 * 60 * 1000 : 0,
    profileCollectionToday: () => '2026-11-07',
    profileCollectionWatchLaterIds: () => new Set(),
    profileCollectionHasExplicitInterruptedStatus: () => false,
    profileCollectionHasRewatchedEpisodes: () => false,
    user: { favorites: { series: [] } }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionStatus', 'profileCollectionStatusGroupKey'), context);
  const futurePremiere = context.profileCollectionStatus({ id: 1, media_type: 'tv' });
  const existingSeriesWithFutureEpisode = context.profileCollectionStatus({ id: 2, media_type: 'tv' });
  const noActivity = context.profileCollectionStatus({ id: 3, media_type: 'tv' });
  const staleStarted = context.profileCollectionStatus({ id: 4, media_type: 'tv' });
  assert.equal(futurePremiere.upcoming, true, 'a series with a future premiere date is Brevemente');
  assert.equal(futurePremiere.toWatch, false, 'an unreleased series is not classified as Para ver');
  assert.equal(existingSeriesWithFutureEpisode.upcoming, false, 'a future episode does not make an already released series a future premiere');
  assert.equal(existingSeriesWithFutureEpisode.stale, false, 'recent real activity does not count as stale');
  assert.equal(noActivity.notStarted, true);
  assert.equal(noActivity.stale, false, 'missing activity timestamps are not invented as inactivity');
  assert.equal(staleStarted.stale, true, 'recorded activity older than 30 days counts as stale');
  assert.equal(staleStarted.toWatch, true, 'an inactive series with pending episodes remains Para ver');
});

test('movie favorites use their own persisted order and preserve search-hidden titles when reordering', () => {
  const context = { user: { profileMovieFavoritesOrder: ['2', '1', '3'] } };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionMovieFavoriteOrderIds', 'profileCollectionMovieFavoritePreferences'), context);
  vm.runInContext(extractFunction('profileCollectionMovieFavoriteVisibleItems', 'profileCollectionBeginMovieFavoriteReorder'), context);
  vm.runInContext(extractFunction('profileCollectionMergeFavoriteOrder', 'profileCollectionBeginFavoriteReorder'), context);
  const state = { kind: 'filmes-favoritos', query: '', items: [{ id: 1, title: 'Árvore' }, { id: 2, title: 'Mar' }, { id: 3, title: 'Sol' }] };
  assert.deepEqual(Array.from(context.profileCollectionMovieFavoriteVisibleItems(state), item => item.id), [2, 1, 3]);
  assert.deepEqual(Array.from(context.profileCollectionMovieFavoriteVisibleItems({ ...state, query: 'mar' }), item => item.id), [2]);
  assert.deepEqual(Array.from(context.profileCollectionMergeFavoriteOrder(state.items, ['3', '2'], ['2', '1', '3'])), ['3', '1', '2']);
});

test('movie favorite reorder confirmation persists only its own order', () => {
  const context = {
    user: { profileSeriesFavoritesOrder: ['tv-1'], profileMovieFavoritesOrder: ['10', '20', '30'] },
    saves: 0,
    save() { context.saves++; }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionMergeFavoriteOrder', 'profileCollectionBeginFavoriteReorder'), context);
  vm.runInContext(extractFunction('profileCollectionMovieFavoritePreferences', 'profileCollectionMovieFavoriteVisibleItems'), context);
  vm.runInContext(extractFunction('profileCollectionConfirmFavoriteReorder', 'profileCollectionDiscardFavoriteReorderIfLeaving'), context);
  const state = { kind: 'filmes-favoritos', statusView: true, items: [{ id: 10 }, { id: 20 }, { id: 30 }], reorderMode: true, pendingFavoriteOrder: ['10', '20', '30'] };
  assert.equal(context.profileCollectionConfirmFavoriteReorder(state, ['30', '10']), true);
  assert.deepEqual(Array.from(context.user.profileMovieFavoritesOrder), ['30', '20', '10']);
  assert.deepEqual(Array.from(context.user.profileSeriesFavoritesOrder), ['tv-1']);
  assert.equal(JSON.stringify(context.user.profileMovieFavoritesView), '{"statusView":true}');
  assert.equal(context.saves, 1);
  assert.equal(state.reorderMode, false);
});

test('movie favorites have route-scoped controls, three-column grid, two-column status groups and saved view preference', () => {
  assert.match(html, /isMovieFavoritesCollection=kind==='filmes-favoritos'/);
  assert.match(html, /page\?\.classList\.toggle\('movieFavoritesCollectionPage',isMovieFavoritesCollection\)/);
  assert.match(html, /profileCollectionRender\(kind,options=\{\}\)[\s\S]*?kind==='filmes-favoritos'\)\{profileCollectionRenderMovieFavorites/);
  assert.match(html, /profileMovieFavoritesView\?\.statusView/);
  assert.match(html, /movieFavoritesCollectionPage #profileCollectionGrid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /movieFavoritesCollectionPage \.profileCollectionStatusGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,155px\)\);gap:16px 14px;justify-content:start/);
  assert.match(html, /movieFavoritesCollectionPage \.profileCollectionStatusGrid\{grid-template-columns:repeat\(2,minmax\(0,calc\(\(100% - 16px\)\/3\)\)\);gap:15px 8px;justify-content:start\}/);
  assert.match(html, /movieFavoritesCollectionPage #profileCollectionGrid \.poster,.movieFavoritesCollectionPage \.profileCollectionStatusGrid \.poster\{[^}]*aspect-ratio:2\/3/);
  assert.match(html, /movieFavoritesCollectionPage \.profileMovieProgressTrack\{[^}]*width:100%/);
  assert.match(html, /movieFavoritesCollectionPage \.catalogHead>\[hidden\].*display:none!important/);
  assert.match(html, /profileCollectionRenderFavoriteMovieStatusGroups\(items\)/);
  assert.match(html, /profileCollectionBeginMovieFavoriteReorder\(state\)/);
  assert.match(html, /Reorganizar filmes favoritos/);
  assert.match(html, /Pesquisar filmes favoritos/);
});

test('movie favorite collection state is reloaded when the active account changes', () => {
  const context = {
    user: { userId: 'account-a', profileMovieFavoritesView: { statusView: true } },
    profileCollectionStates: new Map(),
    profileMovieFavoritesStateOwner: '',
    profileCollectionBaseState(kind) { return { kind, statusView: !!context.user.profileMovieFavoritesView?.statusView }; }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('profileCollectionState', 'profileSeriesFavoriteOrderIds'), context);
  const first = context.profileCollectionState('filmes-favoritos');
  assert.equal(first.statusView, true);
  context.user = { userId: 'account-b', profileMovieFavoritesView: { statusView: false } };
  const second = context.profileCollectionState('filmes-favoritos');
  assert.notEqual(second, first);
  assert.equal(second.statusView, false);
});
