import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJiti} from 'jiti';
import {projectRoot} from '../tools/setup.mjs';
import path from 'node:path';
const fast=await createJiti(import.meta.url,{fsCache:false}).import(path.join(projectRoot,'extensions/openai-fast/index.ts'));
test('Fast transforms are immutable and reject non-record payloads',()=>{
 const payload={model:'example-model',nested:{keep:true}},result=fast.applyFastMode(payload,true);assert.equal(result.service_tier,'priority');assert.equal(payload.service_tier,undefined);assert.equal(result.nested,payload.nested);
 for(const value of [null,undefined,[],1,'text'])assert.equal(fast.applyFastMode(value,true),undefined);
 assert.equal(fast.applyFastMode({service_tier:'priority'},false).service_tier,'default');assert.equal(fast.applyFastMode({service_tier:'fast'},false).service_tier,'default');assert.equal(fast.applyFastMode({service_tier:'auto'},false),undefined);
});
test('new session off, request opt-in, provider/model guards and shutdown ownership',async()=>{
 const handlers=new Map(),commands=new Map(),entries=[],statuses=new Map();
 fast.default({on:(name,fn)=>handlers.set(name,fn),registerCommand:(name,command)=>commands.set(name,command),appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})});
 const ctx={hasUI:true,model:{provider:'openai',id:'example-model'},sessionManager:{getBranch:()=>entries},ui:{notify(){},setStatus:(key,value)=>value===undefined?statuses.delete(key):statuses.set(key,value)}};
 handlers.get('session_start')({},ctx);assert.equal(statuses.size,0);
 const request={payload:{model:'example-model'}},send=handlers.get('before_provider_request');assert.equal(send(request,ctx),undefined);
 await commands.get('fast').handler('ok',ctx);assert.equal(send(request,ctx).service_tier,'priority');assert.equal(statuses.get(fast.STATUS_KEY),'⚡');assert.equal(send({payload:{model:'another-model'}},ctx),undefined);assert.equal(send(request,{...ctx,model:{provider:'other',id:'example-model'}}),undefined);
 handlers.get('session_tree')({},ctx);assert.equal(statuses.get(fast.STATUS_KEY),'⚡');await commands.get('fast').handler('no',ctx);assert.equal(statuses.size,0);assert.equal(send({payload:{model:'example-model',service_tier:'fast'}},ctx).service_tier,'default');
 handlers.get('session_shutdown')({},ctx);assert.equal(statuses.size,0);
});
test('actual Pi loader accepts all package entrypoints',async()=>{
 const jiti=createJiti(import.meta.url,{fsCache:false}),pkg=JSON.parse((await import('node:fs')).readFileSync(path.join(projectRoot,'package.json'),'utf8'));
 const loader=await jiti.import(path.join(projectRoot,'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'));
 const loaded=await loader.loadExtensions(pkg.pi.extensions.map(p=>path.join(projectRoot,p)),projectRoot);
 assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,8);
});
