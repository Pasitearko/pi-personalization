#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const allowedPackages=new Set(['alps-pi','@specode/pi-subscription-usage']);
export function assertSafePath(target,root) {
 const absolute=path.resolve(target),boundary=path.resolve(root),relative=path.relative(boundary,absolute);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Path escapes allowed root');
 let cursor=absolute;
 while(true){
  try{if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Symlink/reparse path rejected: '+cursor);}catch(e){if(e.code!=='ENOENT')throw e;}
  const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
 }
 return absolute;
}
export function patchPlan(modules,root=projectRoot) {
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'patches/manifest.json'),'utf8'));
 const actions=[];
 for(const pkg of manifest.packages){
  if(!allowedPackages.has(pkg.name))throw Error('Package not allowlisted');
  const packageRoot=assertSafePath(path.join(modules,...pkg.name.split('/')),modules);
  const actual=JSON.parse(fs.readFileSync(assertSafePath(path.join(packageRoot,'package.json'),modules),'utf8'));
  if(actual.name!==pkg.name||actual.version!==pkg.version)throw Error(`Version mismatch: ${pkg.name} requires ${pkg.version}, found ${actual.version}`);
  for(const file of pkg.files){
   if(!/^src\/[a-zA-Z0-9_/.-]+\.ts$/.test(file.path))throw Error('Invalid patch path');
   const target=assertSafePath(path.join(packageRoot,file.path),packageRoot);
   const payload=assertSafePath(path.join(root,file.payload),path.join(root,'patches'));
   const data=fs.readFileSync(payload);if(digest(data)!==file.after)throw Error('Patch payload checksum mismatch');
   const current=fs.existsSync(target)?fs.readFileSync(target):null,oldHash=current?digest(current):null;
   if(oldHash===file.after)continue;
   if(oldHash!==file.before)throw Error('Existing file differs from pristine/our patch; refusing overwrite: '+file.path);
   actions.push({target,payload,data,before:oldHash,after:file.after,original:current});
  }
 }
 return actions;
}
function atomicWrite(target,data) {
 fs.mkdirSync(path.dirname(target),{recursive:true});
 const temporary=target+'.pi-personalization-'+crypto.randomUUID()+'.tmp';
 try{fs.writeFileSync(temporary,data,{flag:'wx',mode:0o600});fs.renameSync(temporary,target);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
export function applyPatchPlan(actions,modules,undoRoot) {
 assertSafePath(undoRoot,path.dirname(undoRoot));
 const undo=[];
 for(const action of actions){
  assertSafePath(action.target,modules);
  const current=fs.existsSync(action.target)?fs.readFileSync(action.target):null;
  if((current?digest(current):null)!==action.before)throw Error('File changed since preflight');
  undo.push({path:path.relative(modules,action.target).replaceAll('\\','/'),before:action.before,after:action.after,original:current?.toString('base64')??null});
 }
 if(!actions.length)return;
 const receipt=path.join(undoRoot,'patch-undo.json');
 if(fs.existsSync(receipt))throw Error('Undo receipt already exists; use a fresh undo directory');
 atomicWrite(receipt,JSON.stringify({schema:1,files:undo},null,2)+'\n');
 const written=[];
 try{
  for(const action of actions){
   assertSafePath(action.target,modules);
   const current=fs.existsSync(action.target)?fs.readFileSync(action.target):null;
   if((current?digest(current):null)!==action.before)throw Error('File changed during apply');
   atomicWrite(action.target,action.data);written.push(action);
   if(digest(fs.readFileSync(action.target))!==action.after)throw Error('Post-write verification failed');
  }
 }catch(error){
  for(const action of written.reverse()){assertSafePath(action.target,modules);if(digest(fs.readFileSync(action.target))!==action.after)throw Error('Rollback stopped: another writer changed a target');if(action.original===null)fs.unlinkSync(action.target);else atomicWrite(action.target,action.original);}
  throw error;
 }
}
export function undoPatches(modules,receipt) {
 const data=JSON.parse(fs.readFileSync(receipt,'utf8'));
 if(data.schema!==1||!Array.isArray(data.files))throw Error('Invalid undo receipt');
 const rows=data.files.map(row=>{
  if(!/^(alps-pi|@specode\/pi-subscription-usage)\/src\/[a-zA-Z0-9_/.-]+\.ts$/.test(row.path)||row.path.split('/').some(part=>part==='..'||part==='.'))throw Error('Invalid undo path');
  const target=assertSafePath(path.join(modules,row.path),modules),original=row.original===null?null:Buffer.from(row.original,'base64');
  if((original?digest(original):null)!==row.before)throw Error('Undo original checksum mismatch');
  if(digest(fs.readFileSync(target))!==row.after)throw Error('Patched file was changed; refusing undo overwrite');
  return {target,original};
 });
 for(const row of rows){assertSafePath(row.target,modules);if(row.original===null)fs.unlinkSync(row.target);else atomicWrite(row.target,row.original);}
}
export function mergeSettings(current,defaults,replace=false) {
 if(!isObject(current)||!isObject(defaults))throw Error('Settings must be JSON objects');
 const result=structuredClone(current);
 for(const [key,value]of Object.entries(defaults)){
  if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe settings key');
  if(isObject(value)){if(result[key]===undefined)result[key]={};if(isObject(result[key]))result[key]=mergeSettings(result[key],value,replace);}
  else if(replace||result[key]===undefined)result[key]=structuredClone(value);
 }
 return result;
}
export async function main(args=process.argv.slice(2)) {
 const flag=name=>args.includes(name),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const known=new Set(['--apply','--settings','--replace-settings','--modules','--agent-dir','--undo']);
 for(let i=0;i<args.length;i++){if(!known.has(args[i]))throw Error('Unknown argument: '+args[i]);if(['--modules','--agent-dir','--undo'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing argument value');i++;}}
 const agent=path.resolve(arg('--agent-dir')||process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),'.pi/agent'));
 const modules=path.resolve(arg('--modules')||path.join(agent,'npm/node_modules'));
 if(flag('--undo')){if(!flag('--apply'))throw Error('--undo requires --apply');undoPatches(modules,arg('--undo'));console.log('Patches restored; settings are deliberately not replaced.');return;}
 // Settings have their own explicit opt-in; no credentials/models/packages are changed.
 if(flag('--settings')){
  const target=assertSafePath(path.join(agent,'settings.json'),agent),exists=fs.existsSync(target),original=exists?fs.readFileSync(target):null;
  const current=exists?JSON.parse(original):{},defaults=JSON.parse(fs.readFileSync(path.join(projectRoot,'examples/settings.json'),'utf8'));
  const updated=JSON.stringify(mergeSettings(current,defaults,flag('--replace-settings')),null,2)+'\n';
  console.log('Settings mode:',flag('--replace-settings')?'replace appearance leaves only':'fill missing appearance leaves');
  if(flag('--apply')){const backup=path.join(agent,'personalization-undo','settings-'+Date.now()+'.json');if(original)atomicWrite(backup,original);const now=fs.existsSync(target)?fs.readFileSync(target):null;if((now?digest(now):null)!==(original?digest(original):null))throw Error('Settings changed during preflight');atomicWrite(target,updated);console.log('Appearance settings updated; restart Pi.');}
  else console.log('Dry run; add --apply to write.');
  return;
 }
 const actions=patchPlan(modules);
 console.log(JSON.stringify({mode:flag('--apply')?'apply':'dry-run',changedFiles:actions.length,files:actions.map(a=>path.relative(modules,a.target))},null,2));
 if(flag('--apply')){const undo=path.join(agent,'personalization-undo','patch-'+Date.now());applyPatchPlan(actions,modules,undo);if(actions.length)console.log('Undo receipt:',path.join(undo,'patch-undo.json'));console.log('Patch checks passed. Restart Pi; updates require a fresh version/hash check.');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
