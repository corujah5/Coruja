'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const start=html.indexOf('  function episodePositionProgressMarkup(');
const end=html.indexOf(String.fromCharCode(10)+'  async function loadTemporada(',start);
assert.ok(start>=0&&end>start,'episode progress helper exists');
const helper=html.slice(start,end);
function render(seconds,runtime){const context={formatPosition(n){n=Math.floor(Number(n)||0);const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;return h?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0')}};vm.createContext(context);vm.runInContext(helper+String.fromCharCode(10)+'this.render=episodePositionProgressMarkup;',context);return context.render(seconds,runtime)}
test('renders saved minutes and episode percent from TMDB runtime',()=>{const html=render(600,40);assert.match(html,/Você parou em <strong>10:00<\/strong> de 40:00/);assert.match(html,/>25%<\/span>/);assert.match(html,/aria-valuenow="25"/);assert.match(html,/width:25%/)});
test('does not render progress for episodes without saved position',()=>{assert.equal(render(0,40),'');assert.equal(render(null,40),'')});
test('shows saved time but no invented bar when runtime is missing',()=>{const html=render(600,0);assert.match(html,/Você parou em <strong>10:00<\/strong>/);assert.doesNotMatch(html,/progressbar|%|width:/)});
test('clamps displayed percentage when saved time exceeds episode runtime',()=>{const html=render(6000,40);assert.match(html,/aria-valuenow="100"/);assert.match(html,/width:100%/) });

test('top continue cards reuse the saved episode progress markup',()=>{assert.match(html,/episodePositionProgressMarkup\(entry\.pos\?\.seconds,entry\.runtime\)/)});
