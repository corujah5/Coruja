'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('  function syncStateEqual(');
const end = html.indexOf('\n  let syncBaseState=', start);
assert.notEqual(start, -1, 'list sync merge helpers should exist');
assert.notEqual(end, -1, 'list sync merge helpers should precede sync state');
const context = { mediaTypeOf: item => item?.media_type || (item?.title ? 'movie' : 'tv') };
vm.createContext(context);
vm.runInContext(`${html.slice(start, end)}\nthis.mergeSameAccountList = mergeSameAccountList;`, context);

test('same-account restore keeps a deliberate list removal over stale account data', () => {
  const title = { id: 84773, media_type: 'tv', name: 'O Senhor dos Anéis: Os Anéis de Poder' };
  const merged = context.mergeSameAccountList([title], [], [title]);
  assert.deepEqual(Array.from(merged), []);
});

test('same-account restore does not resurrect stale local titles when no list baseline exists', () => {
  const title = { id: 84773, media_type: 'tv', name: 'O Senhor dos Anéis: Os Anéis de Poder' };
  const merged = context.mergeSameAccountList([], [title], null);
  assert.deepEqual(Array.from(merged), []);
});

test('same-account restore preserves a local addition made since the saved list baseline', () => {
  const title = { id: 84773, media_type: 'tv', name: 'O Senhor dos Anéis: Os Anéis de Poder' };
  const localAddition = { id: 213375, media_type: 'tv', name: 'VisionQuest' };
  const merged = context.mergeSameAccountList([], [localAddition], [title]);
  assert.deepEqual(Array.from(merged), [localAddition]);
});

test('same-account restore keeps server deletions when the local copy has not changed', () => {
  const title = { id: 84773, media_type: 'tv', name: 'O Senhor dos Anéis: Os Anéis de Poder' };
  const merged = context.mergeSameAccountList([], [title], [title]);
  assert.deepEqual(Array.from(merged), []);
});
