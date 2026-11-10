'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const start = html.indexOf('  function renderMoviePositionProgress(');
const end = html.indexOf(String.fromCharCode(10) + '  function renderMovieCompletion(', start);
assert.ok(start >= 0 && end > start, 'helper de progresso deve existir no script');
const helper = html.slice(start, end);
function buildContext(saved, runtime) {
  const element = { hidden: true, innerHTML: '', replaceChildren() { this.innerHTML = ''; } };
  const context = { user: { positions: saved ? { 'movie-42': saved } : {} }, moviePositionKey: id => 'movie-' + id, formatPosition(seconds) { const n=Math.floor(Number(seconds)||0),h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=n%60;return h?h+':' + String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0'); }, $: selector => selector === '#moviePositionProgress' ? element : null };
  vm.createContext(context); vm.runInContext(helper + String.fromCharCode(10) + 'this.run = renderMoviePositionProgress;', context); context.run(42, runtime); return element;
}
test('exibe minutos e barra proporcional ao tempo salvo', () => { const el=buildContext({seconds:1935},90);assert.equal(el.hidden,false);assert.match(el.innerHTML,/Você parou em <strong>32:15<\/strong> de 1:30:00/);assert.match(el.innerHTML,/aria-valuenow="35"/);assert.match(el.innerHTML,/width:35%/); });
test('oculta a barra quando não existe posição salva', () => { const el=buildContext(null,90);assert.equal(el.hidden,true);assert.equal(el.innerHTML,''); });
test('mantém o tempo salvo sem inventar percentual quando a duração falta', () => { const el=buildContext({seconds:1935},0);assert.equal(el.hidden,false);assert.match(el.innerHTML,/Você parou em <strong>32:15<\/strong>/);assert.doesNotMatch(el.innerHTML,/progressbar|%|width:/); });