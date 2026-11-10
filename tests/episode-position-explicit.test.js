'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectDir, 'public', 'index.html'), 'utf8');

test('tapping an episode card does not create a playback position', () => {
  assert.doesNotMatch(html, /recordEpisodeStart\s*\(/);
  assert.doesNotMatch(html, /\.episode\[data-episode-open\][\s\S]{0,400}\.addEventListener\(['"]click['"]/);
});

test('the episode pencil still opens an editor that saves only through its explicit save button', () => {
  assert.match(html, /\.episodePositionEdit[\s\S]*?openPositionEditor\(Number\(state\.current\.id\),n,ep,runtime/);

  const start = html.indexOf('  function openPositionEditor(');
  const end = html.indexOf('\n  function canonicalContinuePositionKey(', start);
  assert.notEqual(start, -1, 'position editor should exist');
  assert.notEqual(end, -1, 'position editor should end before continue-position helpers');
  const editor = html.slice(start, end);
  assert.match(editor, /\.btn\.yellow[\s\S]*?await setPosition\(tvId,season,episode,seconds,runtimeMinutes\)/);
});