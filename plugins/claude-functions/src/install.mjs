import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {resolveConfig,paths} from './config.mjs';
import {atomicJSON,readJSON,readRegular,withLock,privateDirectory} from './storage.mjs';
import {invariant,BridgeError,isRecord} from './pure.mjs';
import {HOST_EVENTS} from './hooks.mjs';
import {TOOL_MATCHER} from './automation.mjs';
const runFile=promisify(execFile);
export const REPO_ROOT=fileURLToPath(new URL('../',import.meta.url));
export const quoteShell=s=>`'${String(s).replaceAll("'","'\\''")}'`;
export async function runHost(command,args,env=process.env){
 try{return await runFile(command,args,{env,timeout:30000,maxBuffer:1000000,windowsHide:true});}
 catch(e){if(e.code==='ENOENT')throw new BridgeError('missing_host',`${command} CLI is not available on PATH`);if(args[0]==='mcp'&&args[1]==='get'&&e.code===1&&/no mcp server|mcp server[^\n]*not found/i.test(`${e.stdout??''} ${e.stderr??''}`))throw new BridgeError('not_found','MCP server is absent');throw new BridgeError('host_command_failed',`${command} ${args.slice(0,2).join(' ')} failed; no host output was logged`);}
}
function owned(entry,command){return Array.isArray(entry?.hooks)&&entry.hooks.some(h=>h?.type==='command'&&h.command===command);}
export function hookEntries(host,root=REPO_ROOT,node=process.execPath){
 const command=`${quoteShell(node)} ${quoteShell(path.join(root,'bin','open-jev-bridge.mjs'))} hook --host ${host}`;
 return Object.fromEntries(HOST_EVENTS[host].map(event=>[event,{...(['PreToolUse','PostToolUse','PostToolUseFailure'].includes(event)?{matcher:TOOL_MATCHER}:{}),hooks:[{type:'command',command:`${command} --event ${event}`,timeout:25}]}]));
}
function locations(host,p){return {hooks:host==='claude'?path.join(p.home,'.claude','settings.json'):path.join(p.home,'.codex','hooks.json'),skills:host==='claude'?path.join(p.home,'.claude','skills'):path.join(p.home,'.agents','skills')};}
async function snapshot(file){try{return (await readRegular(file,4000000)).text;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function restore(file,original){if(original===null)await fs.rm(file,{force:true});else{await privateDirectory(path.dirname(file));await fs.writeFile(file,original,{mode:0o600});}}
const hashText=text=>createHash('sha256').update(text).digest('hex');
const legacyHashes=JSON.parse(await fs.readFile(new URL('./legacy-skills.json',import.meta.url),'utf8'));
function stripOwned(json,entries){
 const next={...json,hooks:{...json.hooks}};
 for(const [event,entry] of Object.entries(entries??{})){const command=entry.hooks[0].command;
  if(Array.isArray(next.hooks[event]))next.hooks[event]=next.hooks[event].flatMap(group=>{
   if(!owned(group,command))return [group];const keep=group.hooks.filter(h=>h.command!==command);return keep.length?[{...group,hooks:keep}]:[];
  });
 }return next;
}
const skillNames=['system-one-judgments','system-one-compaction','system-one-belay'];
/** Direct user-scope installation, without editing TOML or bypassing host hook trust.
 * Host's own MCP CLI owns its registry. Other hooks and user settings are preserved.
 */
export async function install({host='both',root=REPO_ROOT,overrides={},env=process.env,run=runHost}={}){
 invariant(process.platform!=='win32','Automatic hook installation currently supports POSIX hosts; use WSL on Windows');
 invariant(['claude','codex','both'].includes(host),'host must be claude, codex, or both');
 const p=paths(env),config=resolveConfig(overrides,env),targets=host==='both'?['claude','codex']:[host],receiptFile=path.join(config.dataDir,'installation.json');root=await fs.realpath(root);
 invariant(config.timeoutMs<=20000,'Installed hooks require timeoutMs <= 20000 (host timeout is 25 seconds)');
 return withLock(path.join(config.dataDir,'install.lock'),async()=>{
  const receipt=await readJSON(receiptFile,{version:1,hosts:{}});invariant(isRecord(receipt.hosts),'Invalid installation receipt');
  const plans=[];
  for(const target of targets){
   const current=receipt.hosts[target];if(current){
    invariant(current.root===root,'Existing installation uses a different path; uninstall before moving it');
    const loc=locations(target,p),original=await snapshot(loc.hooks),json=original===null?{}:JSON.parse(original),entries=hookEntries(target,root),skillOriginal={};
    invariant(isRecord(json)&&(!json.hooks||isRecord(json.hooks)),'Invalid host hook configuration');
    for(const event of Object.keys(entries))invariant(!json.hooks?.[event]||Array.isArray(json.hooks[event]),'Invalid host hook event array');
    for(const name of skillNames){
      const filename=path.join(loc.skills,name,'SKILL.md'),text=await snapshot(filename),source=await fs.readFile(path.join(root,'skills',name,'SKILL.md'),'utf8');
      if(text!==null)invariant([current.skillHashes?.[name],legacyHashes[name],hashText(source)].includes(hashText(text)),`Installed skill ${name} has user edits; preserve or merge it before upgrading`);
      skillOriginal[name]=text;
    }
    plans.push({target,current,loc,original,json,entries,skillOriginal});continue;
   }
   await run(target,['--version'],env);
   // Existing unowned MCP registration is never removed or silently overwritten.
   let existing=false;try{await run(target,['mcp','get','open-jev-bridge'],env);existing=true;}catch(e){if(e.code!=='not_found')throw e;}
   invariant(!existing,`${target} already has an unowned open-jev-bridge MCP server; rename or remove it explicitly`);
   const loc=locations(target,p),original=await snapshot(loc.hooks),json=original===null?{}:JSON.parse(original);invariant(isRecord(json)&&(!json.hooks||isRecord(json.hooks)),'Invalid host hook configuration');
   const entries=hookEntries(target,root);
   for(const event of Object.keys(entries))invariant(!json.hooks?.[event]||Array.isArray(json.hooks[event]),'Invalid host hook event array');
   for(const name of skillNames){try{await fs.lstat(path.join(loc.skills,name));throw new BridgeError('conflict',`Skill ${name} already exists; refusing to overwrite`);}catch(e){if(e.code!=='ENOENT')throw e;}}
   plans.push({target,loc,original,json,entries});
  }
  const configOriginal=await snapshot(p.config),completed=[];let configWritten=false;
  try{
   // Never persist a bearer token inherited from the environment.
   const prior=configOriginal===null?{}:JSON.parse(configOriginal),safeOverrides={...overrides};delete safeOverrides.apiKey;
   const connection={url:config.url,model:config.model,provider:config.provider,allowRemote:config.allowRemote,
    shisaTopLogprobs:config.shisaTopLogprobs,shisaMaxPromptTokens:config.shisaMaxPromptTokens,
    shisaNoulTemperature:config.shisaNoulTemperature,shisaChoiceTemperature:config.shisaChoiceTemperature,shisaScoreTemperature:config.shisaScoreTemperature,
    autoVerify:config.autoVerify,autoReview:config.autoReview,autoScreen:config.autoScreen,autoCompaction:config.autoCompaction,
    ...(config.apiKeyFile?{apiKeyFile:config.apiKeyFile}:{})};
   await atomicJSON(p.config,{...prior,...connection,...safeOverrides});configWritten=true;
   for(const plan of plans){
    const {target,loc,json,entries}=plan;
    const undo={...plan,mcp:false,hooks:false,skills:[],skillRestores:{}};completed.push(undo);
    const args=target==='claude'?['mcp','add','--scope','user','open-jev-bridge','--',process.execPath,path.join(root,'bin','open-jev-bridge.mjs'),'serve']:['mcp','add','open-jev-bridge','--',process.execPath,path.join(root,'bin','open-jev-bridge.mjs'),'serve'];
    if(!plan.current){await run(target,args,env);undo.mcp=true;}
    const next=stripOwned(json,plan.current?.entries);for(const [event,entry]of Object.entries(entries))next.hooks[event]=[...(next.hooks[event]??[]),entry];
    await atomicJSON(loc.hooks,next);undo.hooks=true;
    for(const name of skillNames){
     await privateDirectory(loc.skills);
     if(plan.current){
      undo.skillRestores[name]=plan.skillOriginal[name];await privateDirectory(path.join(loc.skills,name));
      await fs.copyFile(path.join(root,'skills',name,'SKILL.md'),path.join(loc.skills,name,'SKILL.md'));
     }else{await fs.cp(path.join(root,'skills',name),path.join(loc.skills,name),{recursive:true,errorOnExist:true,force:false});undo.skills.push(name);}
    }
    receipt.hosts[target]={root,version:'0.4.0',hookFile:loc.hooks,entries,skills:skillNames.map(n=>path.join(loc.skills,n)),skillHashes:Object.fromEntries(await Promise.all(skillNames.map(async n=>[n,hashText(await fs.readFile(path.join(root,'skills',n,'SKILL.md'),'utf8'))]))),installedAt:new Date().toISOString()};
   }
   await atomicJSON(receiptFile,receipt);
  }catch(e){
   let rollbackFailed=false;
   for(const undo of completed.reverse()){
    for(const [name,text] of Object.entries(undo.skillRestores))await restore(path.join(undo.loc.skills,name,'SKILL.md'),text).catch(()=>{rollbackFailed=true;});
    for(const name of undo.skills)await fs.rm(path.join(undo.loc.skills,name),{recursive:true,force:true}).catch(()=>{rollbackFailed=true;});
    if(undo.hooks)await restore(undo.loc.hooks,undo.original).catch(()=>{rollbackFailed=true;});
    if(undo.mcp)await run(undo.target,undo.target==='claude'?['mcp','remove','--scope','user','open-jev-bridge']:['mcp','remove','open-jev-bridge'],env).catch(()=>{rollbackFailed=true;});
   }
   if(configWritten)await restore(p.config,configOriginal).catch(()=>{rollbackFailed=true;});
   if(rollbackFailed)throw new BridgeError('rollback_incomplete','Installation failed and rollback was incomplete; inspect host MCP registrations before retrying');throw e;
  }
  return {installed:targets,mode:'direct-user-hooks-and-mcp',config:p.config,root,already_installed:plans.filter(p=>p.current).map(p=>p.target),automation:{completion:config.autoVerify,patch_review:config.autoReview,external_screening:config.autoScreen,compaction:config.autoCompaction},hooks_refreshed:targets,next:'Restart the hosts. In Codex run /hooks and review/trust these hooks; installation does not bypass trust. Do not additionally enable the native plugin for the same host.'};
 });
}
export async function uninstall({host='both',env=process.env,run=runHost}={}){
 invariant(['claude','codex','both'].includes(host),'Invalid host');const config=resolveConfig({},env),file=path.join(config.dataDir,'installation.json');
 return withLock(path.join(config.dataDir,'install.lock'),async()=>{
  const receipt=await readJSON(file,{hosts:{}}),targets=host==='both'?['claude','codex']:[host],removed=[];
  for(const target of targets){const r=receipt.hosts[target];if(!r)continue;
   // Only remove our exact hook commands, preserving user edits and other tools.
   const current=await readJSON(r.hookFile,{});invariant(isRecord(current),'Invalid host configuration');
   if(current.hooks)for(const [event,entry]of Object.entries(r.entries)){const command=entry.hooks[0].command;if(Array.isArray(current.hooks[event]))current.hooks[event]=current.hooks[event].flatMap(group=>{
    if(!owned(group,command))return [group];const keep=group.hooks.filter(h=>h.command!==command);return keep.length?[{...group,hooks:keep}]:[];
   });}
   await run(target,target==='claude'?['mcp','remove','--scope','user','open-jev-bridge']:['mcp','remove','open-jev-bridge'],env);
   await atomicJSON(r.hookFile,current);
   for(const skill of r.skills){
    // Preserve user modifications to installed skills rather than deleting work.
    try{const currentText=await fs.readFile(path.join(skill,'SKILL.md'),'utf8'),source=await fs.readFile(path.join(r.root,'skills',path.basename(skill),'SKILL.md'),'utf8');const entries=await fs.readdir(skill);if((currentText===source||r.skillHashes?.[path.basename(skill)]===hashText(currentText)||legacyHashes[path.basename(skill)]===hashText(currentText))&&entries.length===1&&entries[0]==='SKILL.md')await fs.rm(skill,{recursive:true,force:true});}catch(e){if(e.code!=='ENOENT')throw e;}
   }
   delete receipt.hosts[target];removed.push(target);
  }
  await atomicJSON(file,receipt);return {removed,config_preserved:true,checkpoints_preserved:true};
 });
}
