import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {native} from './fixtures/openjev-http.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {ToolService} from '../src/tools.mjs';
import {resolveConfig} from '../src/config.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {TOOL_INPUTS,command,BIN,ROOT,mcpProcess,temp,history,waitFor} from './helpers.mjs';
const settings=url=>({url,provider:'openjev',model:'openjev',openjevMaxPromptTokens:100000,timeoutMs:15000});
const envFor=url=>({SYSTEM_ONE_PROVIDER:'openjev',SYSTEM_ONE_MODEL:'openjev',SYSTEM_ONE_URL:url,SYSTEM_ONE_OPENJEV_MAX_PROMPT_TOKENS:'100000'});
const questions={n:{type:'noul',instructions:'Is it blue?'},c:{type:'choice',instructions:'Choose',criteria:{blue:'Blue',red:'Red'}},s:{type:'score',instructions:'Rate',criteria:['low','medium','high']}};

for(const [name,args] of Object.entries(TOOL_INPUTS))test('Built-in OpenJev directly to llama.cpp: '+name,async t=>{
 const s=await native(t),config=settings(s.url),service=new ToolService(new SystemOneClient(config),config);
 const result=await service.call(name,args);assert.ok(result);assert.ok(!JSON.stringify(result).includes('"status":"invalid_response"'),JSON.stringify(result));
 assert.ok(s.requests.every(r=>!['/v1/systemone','/v1/completions'].includes(r.url)));assert.deepEqual(s.errors,[]);
});
test('Built-in OpenJev CLI doctor and mixed decision require no sidecar',async t=>{
 const s=await native(t),env=envFor(s.url);
 const doctor=await command([BIN,'doctor'],{env});assert.equal(doctor.code,0,doctor.stderr);assert.match(doctor.stdout,/all three response types validated/);
 const decision=await command([BIN,'call','--name','system_one_query'],{env,input:{state:'Blue label',questions}});
 assert.equal(decision.code,0,decision.stderr);const result=JSON.parse(decision.stdout);requireAnswers(questions,result);
 assert.equal(result.bridge.transport,'openjev-llamacpp');assert.equal(result.bridge.gguf_calibration_validated,false);
});
test('Built-in OpenJev stdio MCP runs all fourteen tools with a single server URL',async t=>{
 const s=await native(t),m=await mcpProcess(s.url,{env:envFor(s.url),timeout:30000});t.after(()=>m.close());
 for(const [name,args] of Object.entries(TOOL_INPUTS)){
  const r=await m.request('tools/call',{name,arguments:args});assert.ok(!r.error,JSON.stringify(r));assert.equal(r.result.isError,false,JSON.stringify(r));
 }
 assert.deepEqual(s.errors,[]);
});
for(const host of ['claude','codex'])test('Built-in OpenJev installed '+host+' hooks persist config without shell exports',async t=>{
 const s=await native(t),home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const fakebin=path.join(home,"host's bin");await fs.mkdir(fakebin);
 for(const h of ['claude','codex']){await fs.copyFile(path.join(ROOT,'tests/fixtures/fake-host.mjs'),path.join(fakebin,h));await fs.chmod(path.join(fakebin,h),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:fakebin+path.delimiter+process.env.PATH,FAKE_HOST_STATE:path.join(home,'hosts.json'),...envFor(s.url)};
 const install=await command([BIN,'install','--host',host],{env});assert.equal(install.code,0,install.stderr);
 const config=JSON.parse(await fs.readFile(path.join(home,'.config/open-jev-bridge/config.json')));assert.equal(config.provider,'openjev');assert.equal(config.openjevMaxPromptTokens,100000);
 for(const k of Object.keys(env))if(k.startsWith('SYSTEM_ONE_'))delete env[k];
 const hooks=JSON.parse(await fs.readFile(path.join(home,host==='claude'?'.claude/settings.json':'.codex/hooks.json'))).hooks;
 const fire=(event,extra={})=>command(['-c',hooks[event][0].hooks[0].command],{command:'/bin/sh',env,input:{session_id:'openjev-direct',cwd:home,hook_event_name:event,...extra},timeout:25000});
 assert.match((await fire('SessionStart',{source:'startup'})).stdout,/proactively/);
 await fire('UserPromptSubmit',{prompt:'Fix a return value',turn_id:'first'});
 const edit={tool_name:'Edit',tool_use_id:'edit',tool_input:{file_path:'a.js',old_string:'return 1',new_string:'return 2'}};
 await fire('PreToolUse',edit);await fire('PostToolUse',{...edit,tool_response:'Updated'});
 const before=s.requests.filter(r=>r.url==='/completion').length;
 const stop=await fire('Stop',{last_assistant_message:'Implemented. All tests passed.'});assert.equal(stop.code,0,stop.stderr);
 assert.ok(s.requests.filter(r=>r.url==='/completion').length>before);
 // Model fixtures exercise protocol paths, not reliable semantic decisions.
 const check={tool_name:'Bash',tool_use_id:'test',tool_input:{command:'npm test'}};
 await fire('PreToolUse',check);await fire('PostToolUse',{...check,tool_response:{stdout:'5 passed',exit_code:0}});
 const afterCheck=s.requests.length;assert.equal((await fire('Stop',{last_assistant_message:'Done. 5 tests passed.'})).code,0);assert.ok(s.requests.length>afterCheck);
 const transcript=path.join(home,'history.jsonl'),original=history(8,1000).map(JSON.stringify).join('\n');await fs.writeFile(transcript,original);
 assert.equal((await fire('PreCompact',{transcript_path:transcript,trigger:'auto'})).code,0);assert.equal(await fs.readFile(transcript,'utf8'),original);
 assert.match((await fire('SessionStart',{source:'compact'})).stdout,/No history was replaced/);
 assert.equal((await command([BIN,'uninstall','--host',host],{env})).code,0);
 assert.deepEqual(s.errors,[]);
});
test('Bundled Claude function plugin uses built-in OpenJev with unchanged HTTP endpoint',async t=>{
 const {register}=await import('../plugins/claude-functions/src/function-hook.mjs');
 const s=await native(t),env=envFor(s.url),callbacks={},messages=history();let result,compactions=0;
 register((event,fn)=>callbacks[event]=fn,{preserveRecentMessages:2,keepThreshold:.99});
 const $={env:{get:async k=>env[k]},ui:{log(){}},http:{fetch:async(u,i)=>{const r=await fetch(u,i);return {status:r.status,ok:r.ok,text:await r.text()};}},
  session:{usage:async()=>({context:{percent:70}}),compact:async()=>{compactions++;result=await callbacks['session.compact']($,{messages},()=>({messages}));}}};
 await callbacks['turn.complete']($,{},()=>{});assert.equal(compactions,1);assert.ok(JSON.stringify(result.messages).length<JSON.stringify(messages).length);
 assert.equal(result.messages[0].text,messages[0].text);assert.ok(s.requests.some(r=>r.url==='/completion'));assert.ok(s.requests.every(r=>r.url!=='/v1/systemone'));
});
test('OpenJev one logical deadline covers discovery, tokenization and recovery',async t=>{
 const s=await native(t,{delay:20}),c=new SystemOneClient({...settings(s.url),timeoutMs:50});
 await assert.rejects(c.ask('state',questions),e=>e.code==='timeout');assert.ok(s.requests.every(r=>r.url!=='/completion'));
});
test('OpenJev cancellation reaches HTTP and does not kill MCP process',async t=>{
 const s=await native(t,{delay:30}),m=await mcpProcess(s.url,{env:envFor(s.url)});t.after(()=>m.close());
 m.send({jsonrpc:'2.0',id:951,method:'tools/call',params:{name:'system_one_query',arguments:{state:'s',questions}}});
 await waitFor(()=>s.requests.length>0);m.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:951}});
 assert.deepEqual((await m.request('ping')).result,{});assert.ok(!m.messages.some(r=>r.id===951));
});
test('OpenJev API key forwarded to each native route',async t=>{
 const s=await native(t,{token:'only-upstream'}),c=new SystemOneClient({...settings(s.url),apiKey:'only-upstream'});
 requireAnswers(questions,await c.ask('s',questions));assert.ok(s.requests.every(r=>r.headers.authorization==='Bearer only-upstream'));
});
for(const key of ['openjevTemperature','openjevNoulTemperature'])for(const value of [0,-1,Infinity,NaN])test('OpenJev rejects invalid '+key+'='+value,()=>assert.throws(()=>resolveConfig({[key]:value},{},{readFile:false})));
test('OpenJev precision profile rejects missing confidence and corrupt mass',async t=>{
 const s=await native(t,{mutate:(r,o)=>{if(r.url==='/completion')o.completion_probabilities[0].top_logprobs[0].logprob=NaN;}});
 await assert.rejects(new SystemOneClient(settings(s.url)).ask('s',questions));
});
test('Generic System One endpoints still use their native typed endpoint',async()=>{
 let called;const c=new SystemOneClient({provider:'generic'},{fetchImpl:async(url,init)=>{called={url,body:JSON.parse(init.body)};return Response.json({model:'other',answers:{n:{type:'noul',noul:.5}}});}});
 await c.ask('s',{n:questions.n});assert.ok(called.url.endsWith('/v1/systemone'));assert.deepEqual(Object.keys(called.body).sort(),['model','questions','state']);
});
