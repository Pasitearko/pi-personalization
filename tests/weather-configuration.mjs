import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJiti} from 'jiti';
import path from 'node:path';
import {projectRoot} from '../tools/setup.mjs';
const weather=await createJiti(import.meta.url,{fsCache:false}).import(path.join(projectRoot,'extensions/weather-row/weather.ts'));
test('explicit cities roundtrip without mutation or automatic home location',()=>{
 const input=[{id:'london',name:'London',latitude:51.5,longitude:-0.1,private:'discard'}],result=weather.configuredCities(JSON.stringify(input));assert.deepEqual(result,[{id:'london',name:'London',latitude:51.5,longitude:-0.1}]);assert.equal(input[0].private,'discard');assert.equal(weather.configuredCities(undefined)[0].id,'shanghai');
});
test('invalid and injected city configuration falls back as a whole',()=>{
 const good={id:'london',name:'London',latitude:51.5,longitude:-0.1},fallback=weather.configuredCities(undefined);
 for(const input of ['{',[],[null],[{...good,latitude:91}],[{...good,longitude:Infinity}],[{...good,id:'../bad'}],[{...good,name:'bad\u001b[31m'}],[good,good],Array.from({length:6},(_,i)=>({...good,id:'city-'+i}))])assert.deepEqual(weather.configuredCities(input),fallback);
});
