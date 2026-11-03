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
