import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {llamaHttp} from './fixtures/llamacpp-http.mjs';
import {ROOT,BIN,command,temp,history,mcpProcess,TOOL_INPUTS} from './helpers.mjs';
import {buildPlugins} from '../scripts/build-plugins.mjs';
async function fixture(t,options){const s=await llamaHttp(options);t.after(async()=>{await s.close();assert.deepEqual(s.errors,[]);});return s;}
for(const host of ['claude','codex'])test(`${host}/llamacpp: install persists backend and automatically checks edits, tests and compaction`,async t=>{
 const s=await fixture(t,{mutate:(r)=>r.url.endsWith('/apply-template')?{httpStatus:404}:undefined}),home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const fakebin=path.join(home,"host's bin");await fs.mkdir(fakebin);
 for(const h of ['claude','codex']){await fs.copyFile(path.join(ROOT,'tests/fixtures/fake-host.mjs'),path.join(fakebin,h));await fs.chmod(path.join(fakebin,h),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:fakebin+path.delimiter+process.env.PATH,
  FAKE_HOST_STATE:path.join(home,'hosts.json'),SYSTEM_ONE_URL:s.url,SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_MODEL:'shisa-de-1',SYSTEM_ONE_SHISA_BACKEND:'llamacpp'};
 let r=await command([BIN,'install','--host',host],{env});assert.equal(r.code,0,r.stderr);
 const configFile=path.join(home,'.config/open-jev-bridge/config.json');const config=JSON.parse(await fs.readFile(configFile));assert.equal(config.shisaBackend,'llamacpp');
 for(const k of Object.keys(env))if(k.startsWith('SYSTEM_ONE_'))delete env[k];
 const hooks=JSON.parse(await fs.readFile(path.join(home,host==='claude'?'.claude/settings.json':'.codex/hooks.json'))).hooks;
 const fire=(event,extra={})=>command(['-c',hooks[event][0].hooks[0].command],{command:'/bin/sh',env,input:{session_id:'llama-lifecycle',cwd:home,hook_event_name:event,...extra},timeout:25000});
 r=await fire('SessionStart',{source:'startup'});assert.match(r.stdout,/proactively/);
 await fire('UserPromptSubmit',{prompt:'Fix parser return value',turn_id:'first'});
 const edit={tool_name:'Edit',tool_use_id:'edit1',tool_input:{file_path:'parser.js',old_string:'return a',new_string:'return b'}};
 await fire('PreToolUse',edit);await fire('PostToolUse',{...edit,tool_response:'Updated'});
 r=await fire('Stop',{last_assistant_message:'Implemented. All tests passed.'});assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision,'block',r.stdout);
 const check={tool_name:'Bash',tool_use_id:'test1',tool_input:{command:'npm test'}};
 await fire('PreToolUse',check);await fire('PostToolUse',{...check,tool_response:{stdout:'5 passed',exit_code:0}});
 r=await fire('Stop',{stop_hook_active:true,last_assistant_message:'Done. npm test ran: 5 passed.'});assert.deepEqual(JSON.parse(r.stdout),{});
 const external={tool_name:'mcp__web__fetch',tool_use_id:'fetch1',tool_input:{url:'https://fixture.invalid'}};
 await fire('PreToolUse',external);r=await fire('PostToolUse',{...external,tool_response:{content:[{type:'text',text:'Parser reference documentation.'}]}});assert.match(r.stdout,/screen/i);
 const transcript=path.join(home,'history.jsonl'),original=history(8,1000).map(JSON.stringify).join('\n');await fs.writeFile(transcript,original);
 r=await fire('PreCompact',{transcript_path:transcript,trigger:'auto'});assert.equal(r.code,0,r.stderr);assert.equal(await fs.readFile(transcript,'utf8'),original);
 r=await fire('SessionStart',{source:'compact'});assert.match(r.stdout,/No history was replaced/);
 assert.ok(s.requests.some(r=>r.url==='/completion'));assert.ok(s.requests.every(r=>r.url!=='/v1/completions'&&r.url!=='/apply-template'));
 r=await command([BIN,'uninstall','--host',host],{env});assert.equal(r.code,0,r.stderr);
});
test('Ready-to-use Claude function bundle selects llama.cpp from environment and replaces history',async t=>{
 const bundle=await buildPlugins();
 for(const f of ['client.mjs','config.mjs','install.mjs','endpoints.mjs','shisa.mjs','shisa-llamacpp.mjs','function-hook.mjs'])
  assert.equal(await fs.readFile(path.join(bundle,'src',f),'utf8'),await fs.readFile(path.join(ROOT,'src',f),'utf8'));
 const {register}=await import(pathToFileURL(path.join(bundle,'src/function-hook.mjs')));
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url==='/apply-template')o.prompt='wrong Gemma template';}}),callbacks={},messages=history();let result,replacements=0;
 const env={SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_MODEL:'shisa-de-1',SYSTEM_ONE_URL:s.url,SYSTEM_ONE_SHISA_BACKEND:'llamacpp'};
 register((e,fn)=>callbacks[e]=fn,{preserveRecentMessages:2});
 const $={env:{get:async k=>env[k]},ui:{log(){}},http:{fetch:async(u,i)=>{const r=await fetch(u,i);return {ok:r.ok,status:r.status,text:await r.text()};}},
  session:{usage:async()=>({context:{percent:70}}),compact:async()=>{replacements++;result=await callbacks['session.compact']($,{messages},()=>({messages}));}}};
 await callbacks['turn.complete']($,{},()=>{});assert.equal(replacements,1);assert.ok(JSON.stringify(result.messages).length<JSON.stringify(messages).length);assert.equal(result.messages[0].text,messages[0].text);assert.ok(s.requests.every(r=>r.url!=='/apply-template'));
});
test('MCP cancellation does not hang the process during native tokenizer work',async t=>{
 const s=await fixture(t,{delay:30}),m=await mcpProcess(s.url,{env:{SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_SHISA_BACKEND:'llamacpp'}});t.after(()=>m.close());
 m.send({jsonrpc:'2.0',id:711,method:'tools/call',params:{name:'system_one_query',arguments:TOOL_INPUTS.system_one_query}});
 await new Promise(r=>setTimeout(r,15));m.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:711}});
 await new Promise(r=>setTimeout(r,60));assert.deepEqual((await m.request('ping')).result,{});assert.ok(!m.messages.some(x=>x.id===711));
});
