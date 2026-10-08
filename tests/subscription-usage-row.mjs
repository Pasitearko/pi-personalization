import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJiti} from 'jiti';
import path from 'node:path';
import {projectRoot} from '../tools/setup.mjs';
const row=await createJiti(import.meta.url,{fsCache:false}).import(path.join(projectRoot,'extensions/subscription-usage-row/index.ts'));
const theme={fg:(_key,text)=>text};
test('quota display preserves upstream percent mode and spaces countdown units',()=>{
 const status={v:1,status:'ready',windows:[{label:'5h',displayPercent:17.25,resetCountdown:'2d3h4m'},{label:'7d',displayPercent:97}]};
 assert.equal(row.renderUsage(status,theme),'5h  17.3%  ↻ 2d 3h 4m  │  7d  97%');assert.equal(row.renderUsage({v:1,status:'unavailable'},theme,'unavailable'),'unavailable');assert.equal(row.renderUsage(undefined,theme),undefined);
});
test('quota invalid percentages and terminal control characters are rejected/sanitized',()=>{
 assert.equal(row.renderUsage({v:1,status:'ready',windows:[{label:'bad',displayPercent:NaN},{label:'bad',displayPercent:101}]},theme),undefined);
 const text=row.renderUsage({v:1,status:'ready',windows:[{label:'safe\u001b\nlabel',displayPercent:5,resetCountdown:'3h\r4m'}]},theme);assert.equal(/[\u0000-\u001f]/.test(text),false);
});
