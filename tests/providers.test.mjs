import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SystemOneClient,retryDelay} from '../src/client.mjs';
import {ToolService} from '../src/tools.mjs';
import {resolveConfig,readSecret,paths} from '../src/config.mjs';
import {parseAnswer,requireAnswers,RESPONSE_RULES} from '../src/schema.mjs';
import {normalizeModels,responseRules} from '../src/providers.mjs';
import {compactFunction,register} from '../src/function-hook.mjs';
import {mockSystemOne,answer,TOOL_INPUTS,temp,BIN,command,mcpProcess,history} from './helpers.mjs';

const versions={jev:'jev-1.13.0',kev:'kev-latest',laya:'laya'};
const mixed={n:{type:'noul',instructions:'Is the label blue?'},c:{type:'choice',instructions:{question:'Choose color'},criteria:{blue:{description:'Blue'},red:null}},s:{type:'score',instructions:'How many?',criteria:['none','one','two']}};
// Independent fixtures based on the published contract, NOT recorded inference.
function providerEnvelope(provider,questions){
 const answers=Object.fromEntries(Object.entries(questions).map(([id,q])=>{
  const a=answer(q,id);
  if(provider==='laya'){
   a.action={act_probability:.8123};
   if(q.type==='noul'){a.noul=.9876;a.confidence=.9876;}
   if(q.type==='score')a.legend=Object.fromEntries(q.criteria.map((v,i)=>[String(i),v]));
  }
  return [id,a];
 }));
 return {model:versions[provider],answers,usage:{input_tokens:33,output_tokens:provider==='laya'?0:10},...(provider==='kev'?{latency_ms:1.2}:{}),...(provider==='laya'?{routing:{model:'english'}}:{})};
}
async function providerFixture(t,provider,{key}={}){
 const s=await mockSystemOne(({req,res,body})=>{
  if(key&&req.headers.authorization!==`Bearer ${key}`){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":"unauthorized"}');return;}
  res.writeHead(200,{'content-type':'application/json'});
  if(req.method==='GET'){res.end(JSON.stringify({models:[provider==='jev'?{name:'jev-latest',description:'fixture',release_date:'2026-01-01'}:{id:versions[provider]}]}));return;}
  assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
  assert.ok(!('response_format' in body));
  for(const q of Object.values(body.questions))if(provider==='jev'&&q.type==='score')assert.ok(q.criteria.length<=10);
  res.end(JSON.stringify(providerEnvelope(provider,body.questions)));
 });
 t.after(()=>s.close());return s;
}
for(const provider of Object.keys(versions)){
 test(`${provider}: mixed System One typed answers, extra metadata and model discovery`,async t=>{
  const s=await providerFixture(t,provider,{key:provider==='jev'?'fixture-secret':undefined});
  const c=new SystemOneClient({url:s.url,provider,model:versions[provider],...(provider==='jev'?{apiKey:'fixture-secret'}:{})});
  const result=await c.ask({color:'blue'},mixed);const parsed=requireAnswers(mixed,result);
  assert.equal(parsed.c.choice,'blue');assert.equal(parsed.s.score,2);assert.equal(result.model,versions[provider]);
  assert.equal((await c.models()).models[0].id,provider==='jev'?'jev-latest':versions[provider]);
  assert.ok(!JSON.stringify(result).includes('system-one-response-rules'));
 });
 for(const [tool,args] of Object.entries(TOOL_INPUTS))test(`${provider}: ${tool} through actual HTTP contract fixture`,async t=>{
  const s=await providerFixture(t,provider,{key:'only-fixture-key'}),c=new SystemOneClient({url:s.url,provider,model:versions[provider],apiKey:'only-fixture-key'});
  const result=await new ToolService(c).call(tool,args);assert.ok(result&&typeof result==='object');
  assert.ok(!JSON.stringify(result).includes('only-fixture-key'));assert.ok(s.requests.length>0);
  for(const req of s.requests){assert.equal(req.headers.authorization,'Bearer only-fixture-key');if(req.body)assert.equal(req.body.model,versions[provider]);}
 });
 test(`${provider}: MCP subprocess mixed request + status through HTTP fixture`,async t=>{
  const s=await providerFixture(t,provider,{key:'process-secret'});const m=await mcpProcess(s.url,{env:{SYSTEM_ONE_PROVIDER:provider,SYSTEM_ONE_MODEL:versions[provider],SYSTEM_ONE_API_KEY:'process-secret'}});t.after(()=>m.close());
  const r=await m.request('tools/call',{name:'system_one_query',arguments:{state:'The label is blue',questions:mixed}});
  assert.ok(r.result&&!r.result.isError);assert.ok(!JSON.stringify(r).includes('process-secret'));
  const status=await m.request('tools/call',{name:'system_one_status',arguments:{}});assert.ok(status.result&&!status.result.isError);
 });
}
for(const envelope of [{models:[{name:'jev-latest'}]},{models:[{id:'kev-latest'}]},{models:[{id:'laya',name:'laya'}]}])test(`Model name normalization: ${JSON.stringify(envelope)}`,()=>assert.equal(typeof normalizeModels(envelope).models[0].id,'string'));
for(const value of [{models:[]},{models:[{}]},{models:[{id:''}]},{models:[{name:3}]},{models:[{id:'a',name:'b'}]},{models:[{id:'a'},{name:'a'}]},{data:[{id:'not-system-one'}]}])test(`Reject malformed model listing ${JSON.stringify(value)}`,()=>assert.throws(()=>normalizeModels(value)));

test('Jev score maximum 10 validated before any HTTP request; Kev 11 accepted',async t=>{
 const s=await providerFixture(t,'kev');const q={s:{type:'score',instructions:'rate',criteria:Array.from({length:11},(_,i)=>`level ${i}`)}};
 await assert.rejects(new SystemOneClient({url:s.url,provider:'jev'}).ask('state',q),/at most 10/);assert.equal(s.requests.length,0);
 requireAnswers(q,await new SystemOneClient({url:s.url,provider:'kev'}).ask('state',q));
});
for(const value of [null,5,true])test(`Jev rejects undocumented scalar state ${value}`,async()=>{
 await assert.rejects(new SystemOneClient({provider:'jev'}).ask(value,mixed),/state must/);
});
for(const q of [{type:'noul',instructions:3},{type:'score',instructions:'q',criteria:[0,1]},{type:'choice',instructions:'q',criteria:{a:false,b:null}}])test(`Jev rejects undocumented question ${JSON.stringify(q)}`,async()=>await assert.rejects(new SystemOneClient({provider:'jev'}).ask('s',{q}),/jev:/));

test('Laya structured score legends accepted only when matching supplied criteria',()=>{
 const q={type:'score',instructions:'rate',criteria:[{description:'low',n:0},['high']]};
 const a={type:'score',score:1,confidence:1,probabilities:{0:0,1:1},legend:{0:{n:0,description:'low'},1:['high']}};
 assert.ok(parseAnswer(q,a,responseRules('laya')).ok);
 a.legend[1]=['invented'];assert.equal(parseAnswer(q,a,responseRules('laya')).ok,false);
});
test('Provider precision: four-decimal Laya rejects a mass error that fits two-decimal envelope',()=>{
 const q=mixed.c,a={type:'choice',choice:'blue',confidence:.9,probabilities:{blue:.9000,red:.1090}};
 assert.ok(parseAnswer(q,a,responseRules('kev')).ok);assert.equal(parseAnswer(q,a,responseRules('laya')).ok,false);
});
test('Laya precision reaches raw and purpose-built tools via symbol metadata',async t=>{
 const s=await mockSystemOne(({res,body})=>{const r=providerEnvelope('laya',body.questions);for(const [id,q] of Object.entries(body.questions))if(q.type==='choice'){const keys=Object.keys(q.criteria);r.answers[id]={type:'choice',choice:keys[0],confidence:.9,probabilities:Object.fromEntries(keys.map((k,i)=>[k,i===0?.9:i===1?.109:0]))};}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(r));});t.after(()=>s.close());
 const c=new SystemOneClient({url:s.url,provider:'laya'}),service=new ToolService(c);
 await assert.rejects(service.call('system_one_query',{state:'s',questions:{c:mixed.c}}),/infeasible/);
 const r=await service.call('system_one_find',TOOL_INPUTS.system_one_find);assert.equal(r.status,'invalid_response');
 const direct=await c.ask('s',{c:mixed.c});assert.deepEqual(direct[RESPONSE_RULES],responseRules('laya'));
});
test('Named providers do not invent missing Choice confidence',()=>{
 const a={type:'choice',choice:'blue',probabilities:{blue:1,red:0}};assert.ok(parseAnswer(mixed.c,a).ok);
 for(const p of ['jev','kev','laya'])assert.equal(parseAnswer(mixed.c,a,responseRules(p)).ok,false);
});
test('529 overload is retried only inside an explicit retry budget',async t=>{
 const s=await mockSystemOne(({res,index})=>{if(index===1){res.writeHead(529,{'retry-after':'0'});res.end();}else return false;});t.after(()=>s.close());
 const c=new SystemOneClient({url:s.url,provider:'jev',retries:1});await c.ask('s',{n:mixed.n});assert.equal(s.requests.length,2);
});
for(const [header,expected] of [[null,100],['',100],['0',0],['1.5',1500],['-1',100],['garbage',100],['99999',300000],['Thu, 01 Jan 1970 00:00:02 GMT',1000]])test(`Retry-After parser ${header}`,()=>assert.equal(retryDelay(header,100,1000),expected));
test('Retry-After cannot extend total request deadline',async t=>{
 const s=await mockSystemOne(({res})=>{res.writeHead(429,{'retry-after':'10'});res.end();});t.after(()=>s.close());
 const c=new SystemOneClient({url:s.url,retries:2,timeoutMs:40});await assert.rejects(c.ask('s',{n:mixed.n}),e=>e.code==='timeout');assert.equal(s.requests.length,1);
});
test('Generic config names, explicit precedence and no legacy implicit fallback',()=>{
 const env={HOME:'/tmp/test',SYSTEM_ONE_URL:'http://127.0.0.1:8010',SYSTEM_ONE_MODEL:'laya',SYSTEM_ONE_PROVIDER:'laya',SYSTEM_ONE_API_KEY:'key'};
 const c=resolveConfig({},env,{readFile:false});assert.equal(c.model,'laya');assert.equal(c.provider,'laya');assert.equal(c.apiKey,'key');
 assert.equal(resolveConfig({model:'override'},env,{readFile:false}).model,'override');
 assert.ok(paths(env).config.endsWith('/open-jev-bridge/config.json'));
 assert.equal(resolveConfig({},{['KE'+'V_API_KEY']:'ignored'},{readFile:false}).apiKey,undefined);
 assert.throws(()=>resolveConfig({provider:'typo'},{},{readFile:false}),/provider/);
});
test('Secret file read, env precedence, exact Bearer forwarding without key persistence',async t=>{
 const home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));const filename=path.join(home,'secret');await fs.writeFile(filename,'key-from-private-file\n',{mode:0o600});
 const c=resolveConfig({apiKeyFile:filename},{},{readFile:false});assert.equal(c.apiKey,'key-from-private-file');
 assert.equal(resolveConfig({apiKeyFile:filename},{SYSTEM_ONE_API_KEY:'env-key'},{readFile:false}).apiKey,'env-key');
 const s=await providerFixture(t,'jev',{key:'key-from-private-file'});
 const result=await command([BIN,'doctor','--provider','jev','--model','jev-latest','--url',s.url,'--api-key-file',filename],{env:{HOME:home}});
 assert.equal(result.code,0,result.stderr);assert.ok(!result.stdout.includes('key-from-private-file'));
});
for(const [name,contents,mode] of [['empty','',0o600],['large','x'.repeat(16385),0o600],['multiline','a\nb',0o600],['world-readable','secret',0o644]])test(`Reject unsafe secret file ${name}`,async t=>{
 const home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));const file=path.join(home,'key');await fs.writeFile(file,contents,{mode});await fs.chmod(file,mode);assert.throws(()=>readSecret(file));
});
test('Reject symlinked and relative key paths',async t=>{
 const home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.writeFile(path.join(home,'key'),'secret',{mode:0o600});await fs.symlink(path.join(home,'key'),path.join(home,'link'));assert.throws(()=>readSecret(path.join(home,'link')));assert.throws(()=>resolveConfig({apiKeyFile:'relative'},{},{readFile:false}));
});
test('Jev remote access is explicit and API credentials are not URL components',()=>{
 assert.throws(()=>resolveConfig({url:'https://api.typesafe.ai',provider:'jev'},{},{readFile:false}),/Non-loopback/);
 assert.doesNotThrow(()=>resolveConfig({url:'https://api.typesafe.ai',provider:'jev',allowRemote:true},{},{readFile:false}));
 assert.throws(()=>resolveConfig({url:'https://secret@api.typesafe.ai',allowRemote:true},{},{readFile:false}));
});
test('Claude function adapter forwards generic endpoint, provider, model and auth',async()=>{
 let called=0;const r=await compactFunction(history(),{url:'https://api.typesafe.ai',allowRemote:true,provider:'jev',model:'jev-latest',apiKey:'secret',preserveRecentMessages:2},async(url,init)=>{
  called++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.headers.authorization,'Bearer secret');const req=JSON.parse(init.body);assert.equal(req.model,'jev-latest');return {ok:true,status:200,text:JSON.stringify(providerEnvelope('jev',req.questions))};
 });assert.ok(called>0);assert.ok(r.stats);
});

test('Current four-decimal Kev probabilities and older two-decimal probabilities both validate',async t=>{
 const q={c:{type:'choice',instructions:'choose',criteria:{a:null,b:null,c:null}},s:{type:'score',instructions:'rate',criteria:['low','medium','high']}};
 for(const decimals of [2,4]){
  const round=v=>Number(v.toFixed(decimals));const p=[.12344,.23455,.64201];
  const r={model:'kev-latest',answers:{c:{type:'choice',choice:'c',confidence:round((p[2]-1/3)/(1-1/3)),probabilities:Object.fromEntries(['a','b','c'].map((k,i)=>[k,round(p[i])]))},s:{type:'score',score:round(p[1]+2*p[2]),confidence:.7599,legend:{0:'low',1:'medium',2:'high'},probabilities:Object.fromEntries(p.map((v,i)=>[String(i),round(v)]))}}};
  const s=await mockSystemOne(({res})=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(r));});t.after(()=>s.close());
  const parsed=requireAnswers(q,await new SystemOneClient({url:s.url,provider:'kev'}).ask('state',q));assert.equal(parsed.c.choice,'c');
 }
});
test('Laya 64-question adapter batch limit rejects oversized raw calls before HTTP',async t=>{
 const s=await providerFixture(t,'laya');const questions=Object.fromEntries(Array.from({length:65},(_,i)=>[String(i),mixed.n]));
 await assert.rejects(new SystemOneClient({url:s.url,provider:'laya'}).ask('s',questions),/question count/);assert.equal(s.requests.length,0);
});
test('Laya general tool batching splits 65 questions into 64 and 1 with complete shared state',async t=>{
 const s=await providerFixture(t,'laya'),c=new SystemOneClient({url:s.url,provider:'laya',maxStateTokens:6000,maxRequestTokens:64000}),service=new ToolService(c);
 const questions=Object.fromEntries(Array.from({length:65},(_,i)=>[String(i),mixed.n]));const r=await service.ask({complete:'evidence'},questions);
 assert.equal(r.requests,2);assert.deepEqual(s.requests.map(x=>Object.keys(x.body.questions).length),[64,1]);for(const req of s.requests)assert.deepEqual(req.body.state,{complete:'evidence'});
});
