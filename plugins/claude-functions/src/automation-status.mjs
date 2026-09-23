/** Offline configuration inspection plus last hook observations; not a claim of
 * native-client trust, model availability, or end-to-end host certification. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {paths} from './config.mjs';
import {readJSON} from './storage.mjs';
import {HOST_EVENTS} from './hooks.mjs';
import {invariant} from './pure.mjs';
export async function automationStatus(config,{host='both',env=process.env}={}) {
 invariant(['both','claude','codex'].includes(host),'Invalid host');
 const receipt=await readJSON(path.join(config.dataDir,'installation.json'),{hosts:{}}),results=[];
 for(const name of host==='both'?['claude','codex']:[host]) {
  const registered=receipt.hosts?.[name];
  const hookFile=name==='claude'?path.join(paths(env).home,'.claude','settings.json'):path.join(paths(env).home,'.codex','hooks.json');
  const source=await readJSON(hookFile,{});
  const events=Object.fromEntries(HOST_EVENTS[name].map(event=>{
   const expected=registered?.entries?.[event];
   const matched=expected?(source.hooks?.[event]??[]).filter(group=>group.matcher===expected.matcher&&group.hooks?.some(h=>h.type==='command'&&h.command===expected.hooks[0].command)):[];
   return [event,matched.length===1?'configured':matched.length>1?'duplicate':'missing'];
  }));
  results.push({host:name,mode:registered?'direct':'native-plugin-or-not-installed',events,
   configured:!!registered&&Object.values(events).every(x=>x==='configured'),trust:'not_verified; inspect /hooks in the native client'});
 }
 const dir=path.join(config.dataDir,'sessions'),names=(await fs.readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).filter(x=>x.endsWith('.automation.json')).slice(-200);
 const recent=[];for(const name of names){try{const data=await readJSON(path.join(dir,name),null,8192);if(data&&['claude','codex'].includes(data.host)&&(host==='both'||data.host===host))recent.push({host:data.host,event:data.event,status:data.status,at:data.at,session:data.session});}catch{/* Corrupt diagnostics never imply success. */}}
 recent.sort((a,b)=>b.at-a.at);
 return {kind:'OFFLINE_AUTOMATION_READINESS',configured:results.every(x=>x.configured),hosts:results,
  settings:{completion:config.autoVerify,task_review:config.autoReview,external_screen:config.autoScreen,checkpoint_compaction:config.autoCompaction},
  recent:recent.slice(0,20),limitations:'Configured does not mean trusted, loaded in a running host, or connected to a working provider. A missing observation is not a passing check. Run doctor and the native acceptance procedure. No secret values are included.'};
}
