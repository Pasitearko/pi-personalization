import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {projectRoot,patchPlan,applyPatchPlan} from './setup.mjs';
const modules=path.join(projectRoot,'node_modules');
// macOS /var aliases /private/var. Canonicalize the OS temp root without
// relaxing the patch tool's rejection of symlinked user-supplied paths.
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'pi-personalization-test-'));
const tests=['tests/setup.mjs','tests/privacy.mjs','tests/openai-fast.mjs','tests/weather-configuration.mjs','extensions/conversation-timeline/tests/run.mjs','extensions/jinshanwei-weather/tests/run.mjs','extensions/working-timer/tests/run.mjs','tests/message-timestamps.mjs','tests/frame-click-toggle.mjs','tests/clean-frame-copy.mjs','tests/subscription-usage-row.mjs','tests/integration.mjs'];
let failed=false;
try {
 // Only this project's disposable development dependencies, never installed Pi.
 applyPatchPlan(patchPlan(modules),modules,path.join(temp,'undo'));
 for(const file of tests){
  if(!fs.existsSync(path.join(projectRoot,file)))throw Error('Missing test: '+file);
  console.log('\n--- '+file+' ---');
  const result=spawnSync(process.execPath,['--test',path.join(projectRoot,file)],{cwd:projectRoot,stdio:'inherit',env:{...process.env,PI_TEST_MODULES:modules,PI_WEATHER_LOCATIONS:'',TMPDIR:temp,TEMP:temp,TMP:temp,PI_CODING_AGENT_DIR:path.join(temp,'agent'),ALPS_PI_SETTINGS_PATH:path.join(temp,'agent/settings.json')}});
  if(result.status!==0){failed=true;break;}
 }
} finally {fs.rmSync(temp,{recursive:true,force:true});}
if(failed)process.exitCode=1;
