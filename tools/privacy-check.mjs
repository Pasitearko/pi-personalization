#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const excluded=new Set(['.git','node_modules','.venv','build-temp']);
const forbiddenNames=new Set(['auth.json','models.json','models-store.json','mcp.json','mcp-cache.json','mcp-adapter.json','mcp-onboarding.json','throughput.json','weather-cache.json','.env']);
export function scan(root) {
 const findings=[];
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name),rel=path.relative(root,file).replaceAll('\\','/');
  if(entry.isSymbolicLink()){findings.push({path:rel,reason:'symlink not allowed in publication'});continue;}
  if(entry.isDirectory()){if(!excluded.has(entry.name)&&rel!=='fonts/fonts')walk(file);continue;}
  if(!entry.isFile())continue;
  if(forbiddenNames.has(entry.name)||/\.(pem|key|p12|pfx|ttf|otf|tgz|tar|gz)$/i.test(entry.name)||/(^|\/)(sessions|snapshots|personalization-undo)(\/|$)/.test(rel))findings.push({path:rel,reason:'private/generated payload filename'});
  if(file.endsWith('.wav')){if(rel!=='extensions/working-timer/assets/completion.wav')findings.push({path:rel,reason:'unapproved audio'});continue;}
  const data=fs.readFileSync(file,'utf8');
  const checks=[['machine-bound Windows path',/C:[\\/]Users[\\/][A-Za-z0-9_-]+/i],['machine-bound Unix home',/\/(?:home|Users)\/[A-Za-z0-9_-]+\//],['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],['GitHub token',/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],['OpenAI token',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],['bearer literal',/Bearer\s+[A-Za-z0-9._-]{30,}/],['signed-in ID literal',/\"(?:deviceId|account_id|user_id)\"\s*:\s*\"[^\"]+\"/]];
  for(const [reason,pattern]of checks)if(pattern.test(data))findings.push({path:rel,reason});
 }}
 walk(path.resolve(root));return findings;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),findings=scan(root);
 console.log(JSON.stringify({passed:findings.length===0,findings},null,2));if(findings.length)process.exitCode=1;
}
