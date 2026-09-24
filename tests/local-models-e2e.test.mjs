import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {shisaHttp} from './fixtures/shisa-http.mjs';
import {ROOT,BIN,command,temp,mcpProcess,TOOL_INPUTS,history} from './helpers.mjs';
import {buildPlugins} from '../scripts/build-plugins.mjs';
async function deciderSidecar(t){
 const child=spawn(process.env.PYTHON??'python3',['-u','tests/fixtures/decider_adapter.py'],{cwd:ROOT,env:{...process.env,SYSTEM_ONE_API_KEY:'local-model-secret'},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'close');let err='';child.stderr.on('data',b=>err+=b);
 t.after(async()=>{child.kill('SIGTERM');await exited;});
 return await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Decider fixture startup timeout '+err)),5000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',()=>{clearTimeout(timer);reject(new Error('Fixture exited '+err));});
  child.stdout.on('data',b=>{out+=b;const i=out.indexOf('\n');if(i>=0){clearTimeout(timer);const result=JSON.parse(out.slice(0,i));assert.equal(result.fixture,true);resolve(result);}});
 });
}
async function backend(t,provider){
 if(provider==='decider')return deciderSidecar(t);
 const s=await shisaHttp({key:'local-model-secret'});t.after(async()=>{await s.close();assert.deepEqual(s.errors,[]);});return s;
}
for(const provider of ['decider','shisa'])for(const host of ['claude','codex'])test(`${host}/${provider}: installed automatic lifecycle end-to-end without manual judgment calls`,async t=>{
 const s=await backend(t,provider),home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const fakebin=path.join(home,"host's bin");await fs.mkdir(fakebin);
 for(const name of ['claude','codex']){await fs.copyFile(path.join(ROOT,'tests/fixtures/fake-host.mjs'),path.join(fakebin,name));await fs.chmod(path.join(fakebin,name),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:fakebin+path.delimiter+process.env.PATH,
  FAKE_HOST_STATE:path.join(home,'host-state.json'),SYSTEM_ONE_URL:s.url,SYSTEM_ONE_MODEL:provider==='decider'?'decider-35b-a3b':'shisa-de-1',SYSTEM_ONE_PROVIDER:provider,
  SYSTEM_ONE_API_KEY:'local-model-secret',SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE:'1.9'};
 let r=await command([BIN,'install','--host',host],{env});assert.equal(r.code,0,r.stderr);
 const config=JSON.parse(await fs.readFile(path.join(home,'.config/open-jev-bridge/config.json')));assert.equal(config.provider,provider);assert.equal(config.shisaChoiceTemperature,1.9);assert.equal(config.apiKey,undefined);
 // The spawned hooks obtain nonsecret connection settings from the installer's saved config,
 // not from the test shell. Only the secret is forwarded (as an actual host must do).
 delete env.SYSTEM_ONE_URL;delete env.SYSTEM_ONE_MODEL;delete env.SYSTEM_ONE_PROVIDER;delete env.SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE;
 const hooks=JSON.parse(await fs.readFile(path.join(home,host==='claude'?'.claude/settings.json':'.codex/hooks.json'))).hooks;
 const fire=(event,extra={})=>command(['-c',hooks[event][0].hooks[0].command],{command:'/bin/sh',env,input:{session_id:'local-model-lifecycle',cwd:home,hook_event_name:event,...extra},timeout:25000});
 r=await fire('SessionStart',{source:'startup'});assert.match(r.stdout,/proactively/);
 await fire('UserPromptSubmit',{prompt:'Fix parser return value',turn_id:'first'});
 const edit={tool_name:'Edit',tool_use_id:'edit1',tool_input:{file_path:'parser.js',old_string:'return a',new_string:'return b'}};
 await fire('PreToolUse',edit);await fire('PostToolUse',{...edit,tool_response:'Updated'});
 r=await fire('Stop',{last_assistant_message:'Implemented. All tests passed.'});assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision,'block',r.stdout);
 const check={tool_name:'Bash',tool_use_id:'test1',tool_input:{command:'npm test'}};
 await fire('PreToolUse',check);await fire('PostToolUse',{...check,tool_response:{stdout:'5 passed',exit_code:0}});
 r=await fire('Stop',{stop_hook_active:true,last_assistant_message:'Done. npm test ran: 5 passed.'});assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});
 const external={tool_name:'mcp__web__fetch',tool_use_id:'fetch1',tool_input:{url:'https://fixture.invalid'}};
 await fire('PreToolUse',external);r=await fire('PostToolUse',{...external,tool_response:{content:[{type:'text',text:'Parser reference documentation.'}]}});
 assert.match(r.stdout,/screen/i);assert.ok(!r.stdout.includes('local-model-secret'));
 const transcript=path.join(home,'history.jsonl'),original=history(8,1000).map(JSON.stringify).join('\n');await fs.writeFile(transcript,original);
 r=await fire('PreCompact',{transcript_path:transcript,trigger:'auto'});assert.equal(r.code,0,r.stderr);assert.equal(await fs.readFile(transcript,'utf8'),original);
 r=await fire('SessionStart',{source:'compact'});assert.match(r.stdout,/No history was replaced/);
 r=await command([BIN,'automation-status','--host',host],{env});assert.equal(r.code,0);assert.equal(JSON.parse(r.stdout).recent[0].status,'checkpoint_restored');
 r=await command([BIN,'uninstall','--host',host],{env});assert.equal(r.code,0,r.stderr);
});
test('Decider actual Python server -> all fourteen tools through real MCP subprocess',async t=>{
 const s=await deciderSidecar(t),m=await mcpProcess(s.url,{env:{SYSTEM_ONE_PROVIDER:'decider',SYSTEM_ONE_MODEL:'decider-35b-a3b',SYSTEM_ONE_API_KEY:'local-model-secret'}});t.after(()=>m.close());
 for(const [name,args]of Object.entries(TOOL_INPUTS)){
  const r=await m.request('tools/call',{name,arguments:args});assert.ok(!r.result?.isError,JSON.stringify(r));assert.ok(!JSON.stringify(r).includes('local-model-secret'));
 }
});
test('Shisa MCP cancellation stops the logical readout and keeps server responsive',async t=>{
 const s=await shisaHttp({delay:50});t.after(()=>s.close());const m=await mcpProcess(s.url,{env:{SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_MODEL:'shisa-de-1'}});t.after(()=>m.close());
 m.send({jsonrpc:'2.0',id:777,method:'tools/call',params:{name:'system_one_query',arguments:TOOL_INPUTS.system_one_query}});
 await new Promise(r=>setTimeout(r,30));m.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:777}});
 await new Promise(r=>setTimeout(r,70));assert.deepEqual((await m.request('ping')).result,{});assert.ok(!m.messages.some(x=>x.id===777));
});
test('Bundled Claude function plugin has byte-identical provider modules and triggers native compaction for both backends',async t=>{
 const bundle=await buildPlugins();
 for(const f of ['client.mjs','providers.mjs','endpoints.mjs','shisa.mjs','schema.mjs','function-hook.mjs'])assert.equal(await fs.readFile(path.join(bundle,'src',f),'utf8'),await fs.readFile(path.join(ROOT,'src',f),'utf8'));
 const {register}=await import(pathToFileURL(path.join(bundle,'src/function-hook.mjs')));
 for(const provider of ['decider','shisa']){
  const s=await backend(t,provider),callbacks={},messages=history(5,1500);let result,replacements=0;
  const env={SYSTEM_ONE_URL:s.url,SYSTEM_ONE_PROVIDER:provider,SYSTEM_ONE_MODEL:provider==='shisa'?'shisa-de-1':'decider-35b-a3b',SYSTEM_ONE_API_KEY:'local-model-secret',SYSTEM_ONE_SHISA_NOUL_TEMPERATURE:'1.69'};
  register((event,fn)=>callbacks[event]=fn,{preserveRecentMessages:2});
  const $={env:{get:async name=>env[name]},ui:{log(){}},http:{fetch:async(url,init)=>{const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000)});return {ok:r.ok,status:r.status,text:await r.text()};}},
   session:{usage:async()=>({context:{percent:70}}),compact:async()=>{replacements++;result=await callbacks['session.compact']($,{messages},()=>({messages}));}}};
  await callbacks['turn.complete']($,{},()=>{});assert.equal(replacements,1);assert.ok(JSON.stringify(result.messages).length<JSON.stringify(messages).length,provider);assert.equal(result.messages[0].text,messages[0].text);
 }
});
