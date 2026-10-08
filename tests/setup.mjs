import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {patchPlan,applyPatchPlan,undoPatches,mergeSettings,assertSafePath,projectRoot} from '../tools/setup.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi public fixture '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const modules=path.join(root,'modules'),repo=path.join(root,'repo');fs.mkdirSync(path.join(modules,'alps-pi/src'),{recursive:true});fs.mkdirSync(path.join(repo,'patches'),{recursive:true});
 const before=Buffer.from('export const value=1;\n'),after=Buffer.from('export const value=2;\n');
 fs.writeFileSync(path.join(modules,'alps-pi/package.json'),JSON.stringify({name:'alps-pi',version:'0.3.4'}));fs.writeFileSync(path.join(modules,'alps-pi/src/a.ts'),before);fs.writeFileSync(path.join(repo,'patches/a.ts'),after);
 const manifest={packages:[{name:'alps-pi',version:'0.3.4',files:[{path:'src/a.ts',before:digest(before),after:digest(after),payload:'patches/a.ts'}]}]};
 const save=()=>fs.writeFileSync(path.join(repo,'patches/manifest.json'),JSON.stringify(manifest));save();return {root,modules,repo,before,after,manifest,save,target:path.join(modules,'alps-pi/src/a.ts')};
}
test('preflight is read-only; apply, idempotency and undo preserve bytes',t=>{
 const f=fixture(t),actions=patchPlan(f.modules,f.repo);assert.deepEqual(fs.readFileSync(f.target),f.before);assert.equal(actions.length,1);
 const undo=path.join(f.root,'undo');applyPatchPlan(actions,f.modules,undo);assert.deepEqual(fs.readFileSync(f.target),f.after);assert.equal(patchPlan(f.modules,f.repo).length,0);
 undoPatches(f.modules,path.join(undo,'patch-undo.json'));assert.deepEqual(fs.readFileSync(f.target),f.before);
});
test('unknown package version fails before writes',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.modules,'alps-pi/package.json'),JSON.stringify({name:'alps-pi',version:'99.0.0'}));assert.throws(()=>patchPlan(f.modules,f.repo),/Version mismatch/);assert.deepEqual(fs.readFileSync(f.target),f.before);});
test('existing local modification and new unexpected file are refused',t=>{const f=fixture(t);fs.writeFileSync(f.target,'local edit');assert.throws(()=>patchPlan(f.modules,f.repo),/refusing overwrite/);f.manifest.packages[0].files[0].before=null;f.save();assert.throws(()=>patchPlan(f.modules,f.repo),/refusing overwrite/);});
test('new files are created and deleted safely by undo',t=>{const f=fixture(t);fs.unlinkSync(f.target);f.manifest.packages[0].files[0].before=null;f.save();const undo=path.join(f.root,'undo');applyPatchPlan(patchPlan(f.modules,f.repo),f.modules,undo);undoPatches(f.modules,path.join(undo,'patch-undo.json'));assert.equal(fs.existsSync(f.target),false);});
test('path escape, payload mutation and package allowlist fail closed',t=>{
 const f=fixture(t);f.manifest.packages[0].files[0].path='src/../../elsewhere/a.ts';f.save();assert.throws(()=>patchPlan(f.modules,f.repo),/escapes/);
 f.manifest.packages[0].files[0].path='src/a.ts';f.save();fs.writeFileSync(path.join(f.repo,'patches/a.ts'),'changed');assert.throws(()=>patchPlan(f.modules,f.repo),/checksum/);
 f.manifest.packages[0].name='untrusted';f.save();assert.throws(()=>patchPlan(f.modules,f.repo),/allowlisted/);
});
test('file changed after preflight prevents any writes',t=>{const f=fixture(t),plan=patchPlan(f.modules,f.repo);fs.writeFileSync(f.target,'new writer');assert.throws(()=>applyPatchPlan(plan,f.modules,path.join(f.root,'undo')),/changed since/);assert.equal(fs.existsSync(path.join(f.root,'undo')),false);});
test('undo never overwrites third-party update and verifies receipt originals',t=>{const f=fixture(t),undo=path.join(f.root,'undo'),receipt=path.join(undo,'patch-undo.json');applyPatchPlan(patchPlan(f.modules,f.repo),f.modules,undo);fs.writeFileSync(f.target,'updated');assert.throws(()=>undoPatches(f.modules,receipt),/refusing undo/);fs.writeFileSync(f.target,f.after);const data=JSON.parse(fs.readFileSync(receipt));data.files[0].original=Buffer.from('forged').toString('base64');fs.writeFileSync(receipt,JSON.stringify(data));assert.throws(()=>undoPatches(f.modules,receipt),/original checksum/);});
test('symlink ancestors and dangling links are rejected when platform permits',t=>{
 const f=fixture(t),link=path.join(f.root,'link');try{fs.symlinkSync(f.modules,link,process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'){t.skip('symlink privilege unavailable');return;}throw e;}
 assert.throws(()=>assertSafePath(path.join(link,'missing/file.ts'),f.root),/Symlink/);
 fs.rmSync(link);fs.symlinkSync(path.join(f.root,'missing'),link,process.platform==='win32'?'junction':'dir');assert.throws(()=>assertSafePath(path.join(link,'a.ts'),f.root),/Symlink/);
});
test('settings default fills only absent leaves; explicit replacement preserves unrelated data',()=>{
 const current={theme:'custom',models:{private:'keep'},terminal:{hyperlinks:false,other:true},'alps-pi':{shortcuts:{custom:'keep'}}},preset=JSON.parse(fs.readFileSync(path.join(projectRoot,'examples/settings.json'),'utf8'));
 const merged=mergeSettings(current,preset);assert.equal(merged.theme,'custom');assert.equal(merged.terminal.hyperlinks,false);assert.equal(merged.models.private,'keep');assert.equal(merged['alps-pi'].shortcuts.custom,'keep');assert.equal(merged.tuiMode,'fullscreen');assert.deepEqual(current.theme,'custom');
 const replaced=mergeSettings(current,preset,true);assert.equal(replaced.theme,'no-tool-bg');assert.equal(replaced.terminal.hyperlinks,true);assert.equal(replaced.terminal.other,true);assert.equal(replaced.models.private,'keep');assert.equal(replaced['alps-pi'].shortcuts.custom,'keep');
});
test('settings reject nonobjects and prototype keys',()=>{assert.throws(()=>mergeSettings([],{}),/objects/);assert.throws(()=>mergeSettings({},JSON.parse('{"__proto__":{"polluted":true}}')),/Unsafe/);assert.equal({}.polluted,undefined);});
test('failed second write rolls back only our first verified write',t=>{
 const f=fixture(t),second=path.join(f.modules,'alps-pi/src/b.ts');fs.writeFileSync(second,f.before);
 f.manifest.packages[0].files.push({...f.manifest.packages[0].files[0],path:'src/b.ts'});f.save();const actions=patchPlan(f.modules,f.repo);
 const original=fs.renameSync;let rejected=false;
 fs.renameSync=(from,to)=>{if(to===second&&!rejected){rejected=true;throw Error('simulated second-write failure');}return original(from,to);};
 try{assert.throws(()=>applyPatchPlan(actions,f.modules,path.join(f.root,'undo')),/simulated/);}finally{fs.renameSync=original;}
 assert.deepEqual(fs.readFileSync(f.target),f.before);assert.deepEqual(fs.readFileSync(second),f.before);assert.equal(fs.existsSync(path.join(f.root,'undo/patch-undo.json')),true);
});
