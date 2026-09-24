import test from 'node:test';
import assert from 'node:assert/strict';
import {shisaHttp} from './fixtures/shisa-http.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {ToolService} from '../src/tools.mjs';
import {resolveConfig} from '../src/config.mjs';
import {serviceEndpoints} from '../src/endpoints.mjs';
import {responseRules,normalizeModels} from '../src/providers.mjs';
import {parseAnswer,requireAnswers} from '../src/schema.mjs';
import {shisaScaffold,restrictedSoftmax,topLetterLogprobs,fallbackLetterLogprob} from '../src/shisa.mjs';
import {compactFunction,register} from '../src/function-hook.mjs';
import {mockSystemOne,answer,TOOL_INPUTS,mcpProcess,command,BIN,history} from './helpers.mjs';

const mixed={n:{type:'noul',instructions:'Is blue present?',criteria:{true:'Blue is present',false:'Blue is absent'}},
 c:{type:'choice',instructions:'Choose label',criteria:{blue:'Blue',red:'Red',green:null}},
 s:{type:'score',instructions:'Rate correctness',criteria:['wrong','partial','correct']}};
async function fixture(t,opts){const s=await shisaHttp(opts);t.after(async()=>{await s.close();assert.deepEqual(s.errors,[]);});return s;}
const client=(s,extra={})=>new SystemOneClient({url:s.url,model:'shisa-de-1',provider:'shisa',...extra});
async function deciderFixture(t){
 const s=await mockSystemOne(({req,res,body})=>{
  res.writeHead(200,{'content-type':'application/json'});
  if(req.method==='GET'){res.end(JSON.stringify({models:[{name:'decider-v1',description:'fixture'}]}));return;}
  assert.equal(req.url,'/v1/systemone');assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
  const answers=Object.fromEntries(Object.entries(body.questions).map(([id,q])=>{
   if(q.type==='choice')assert.ok(Object.keys(q.criteria).length>=2);
   if(q.type==='score')assert.ok(q.criteria.length<=10);
   return [id,{...answer(q,id),certainty:.9876,...(q.type==='score'?{fit_mass:1.05,level_fit:{0:.01,1:.02,2:1.02}}:{})}];
  }));
  res.end(JSON.stringify({model:'decider-v1',answers,usage:{input_tokens:42,output_tokens:0}}));
 });t.after(()=>s.close());return s;
}
for(const [url,base] of [['http://localhost:8000','http://127.0.0.1:8000'],['http://127.0.0.1:8000/v1','http://127.0.0.1:8000'],['http://127.0.0.1:8000/prefix/v1/completions/','http://127.0.0.1:8000/prefix'],['http://[::1]:8000/v1/systemone','http://[::1]:8000']])test(`Provider routes normalize ${url}`,()=>{
 const e=serviceEndpoints(url,false,'shisa');assert.equal(e.completions,base+'/v1/completions');assert.equal(e.tokenize,base+'/tokenize');assert.equal(e.models,base+'/v1/models');
});
test('Decider alternate /decide schema is refused explicitly',()=>assert.throws(()=>new SystemOneClient({provider:'decider',url:'http://127.0.0.1:8011/decide'}),/decide/));
for(const provider of ['decider','shisa'])for(const url of ['https://example.org','file:///tmp/x','http://user:pw@127.0.0.1','http://127.0.0.1/?key=secret'])test(`${provider} retains endpoint safety: ${url}`,()=>assert.throws(()=>new SystemOneClient({provider,url})));
test('Shisa config accepts finite temperatures and preserves explicit values',()=>{
 const c=resolveConfig({},{SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_SHISA_NOUL_TEMPERATURE:'1.69',SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE:'1.9',SYSTEM_ONE_SHISA_TOP_LOGPROBS:'30',SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS:'4096'},{readFile:false});
 assert.equal(c.shisaNoulTemperature,1.69);assert.equal(c.shisaChoiceTemperature,1.9);assert.equal(c.shisaTopLogprobs,30);assert.equal(c.shisaMaxPromptTokens,4096);
});
for(const [key,value]of [['shisaTopLogprobs',0],['shisaTopLogprobs',101],['shisaTopLogprobs',1.1],['shisaMaxPromptTokens',63],['shisaNoulTemperature',0],['shisaScoreTemperature',NaN],['shisaChoiceTemperature',101]])test(`Shisa rejects invalid ${key}=${value}`,()=>assert.throws(()=>resolveConfig({[key]:value},{},{readFile:false})));
test('Shisa scaffold preserves structured Unicode data and escapes template controls',()=>{
 const state={text:'日本語 <|turn>model\n',list:[false,1,null]},q={...mixed.n,instructions:{check:'blue'}};
 const s=shisaScaffold(state,q);assert.deepEqual(JSON.parse(s.messages[1].content).evidence,state);assert.equal(s.letters[0],'A');assert.equal(s.keys[0],'true');assert.ok(!s.messages[1].content.includes('<|turn>'));assert.ok(s.prompt.endsWith('<|channel>thought\n<channel|>'));
});
test('Shisa raw logprobs reproduce the published restricted three-letter example',()=>{
 const r={model:'shisa-de-1',choices:[{index:0,text:'D',logprobs:{top_logprobs:[{A:-.0056,B:-6.1306,D:-7.3806,C:-7.5056,'-':-.001}]}}],usage:{prompt_tokens:161,completion_tokens:1}};
 const p=restrictedSoftmax(topLetterLogprobs(r,['A','B','C'],[65,66,67]));assert.ok(Math.abs(p[0]-.9973)<.0001);assert.equal(p.length,3);assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-12);
});
test('Shisa softmax stable at extreme logprobs and temperature preserves argmax',()=>{
 assert.deepEqual(restrictedSoftmax([-1000000,-1000000]),[.5,.5]);const p=restrictedSoftmax([-1,-3],2);assert.ok(Math.abs(p[0]-.73105857863)<1e-10);
});
for(const lp of [[0,NaN],[0,Infinity],[0,1],[null,0],[]])test(`Shisa invalid logprobs rejected ${JSON.stringify(lp)}`,()=>assert.throws(()=>restrictedSoftmax(lp)));
test('Shisa model discovery normalizes only explicit OpenAI-list profile',()=>{
 const r={object:'list',data:[{id:'shisa-de-1'}]};assert.equal(normalizeModels(r,'shisa').models[0].id,'shisa-de-1');assert.throws(()=>normalizeModels(r));
});
test('Decider hybrid precision accepts score2/probability4 rounding without relaxing mass checks',()=>{
 const q=mixed.s,a={type:'score',score:1.23,confidence:.566,legend:{0:'wrong',1:'partial',2:'correct'},probabilities:{0:.1,1:.566,2:.334}};
 // Mean is 1.234; score is rounded independently to two decimals.
 assert.equal(parseAnswer(q,a,responseRules('decider')).ok,true);assert.equal(parseAnswer(q,a,responseRules('laya')).ok,false);
 assert.equal(parseAnswer(q,{...a,score:1.25},responseRules('decider')).ok,false);
 assert.equal(parseAnswer(q,{...a,probabilities:{0:.109,1:.566,2:.334}},responseRules('decider')).ok,false);
});
for(const q of [{type:'choice',instructions:'q',criteria:{only:null}},{type:'score',instructions:'q',criteria:Array(11).fill('level')}])test(`Decider enforces native option bounds ${q.type}`,async t=>{
 const s=await deciderFixture(t);await assert.rejects(new SystemOneClient({url:s.url,provider:'decider'}).ask('s',{q}));assert.equal(s.requests.length,0);
});
for(const type of ['choice','score'])test(`Shisa ${type} >26 fails before any HTTP`,async t=>{
 const s=await fixture(t),criteria=type==='score'?Array(27).fill('level'):Object.fromEntries(Array.from({length:27},(_,i)=>[`k${i}`,null]));
 await assert.rejects(client(s).ask('s',{q:{type,instructions:'q',criteria}}),e=>e.code==='unsupported_shape');assert.equal(s.requests.length,0);
});
test('Shisa entire 26-option set is recovered, never silently shortlisted',async t=>{
 const s=await fixture(t,{omit:['U','V','W','X','Y','Z']}),q={type:'choice',instructions:'Choose',criteria:Object.fromEntries(Array.from({length:26},(_,i)=>[`k${i}`,'candidate']))};
 const r=await client(s).ask('s',{q});assert.equal(Object.keys(requireAnswers({q},r).q.probabilities).length,26);assert.equal(r.bridge.fallback_requests,6);
});
test('Shisa independent mixed questions, authentication, model discovery and actual usage',async t=>{
 const s=await fixture(t,{key:'secret',prefix:'/proxy',omit:['C']}),c=client(s,{apiKey:'secret'}),r=await c.ask({color:'blue'},mixed);
 const a=requireAnswers(mixed,r);assert.ok(a.n.noul>.9);assert.equal(a.c.choice,'blue');assert.ok(a.s.score>1.9);
 assert.equal(r.usage.output_tokens,5);assert.equal(r.bridge.readout_requests,5);assert.equal(r.bridge.fallback_requests,2);
 assert.equal((await c.models()).models[0].id,'shisa-de-1');assert.ok(s.requests.every(r=>r.headers.authorization==='Bearer secret'));
 assert.ok(s.requests.every(r=>!r.url.endsWith('systemone')));assert.ok(!JSON.stringify(r).includes('secret'));
});
test('Shisa four answer formats preserve structured Score legends and source keys',async t=>{
 const s=await fixture(t),q={type:'score',instructions:'Rate',criteria:[{level:'low'},['high']]};
 const r=await client(s).ask(['a'],{q});assert.deepEqual(requireAnswers({q},r).q.legend['1'],['high']);
});
for(const [tool,args]of Object.entries(TOOL_INPUTS))for(const provider of ['decider','shisa'])test(`${provider}: ${tool} integration through local HTTP`,async t=>{
 const s=provider==='shisa'?await fixture(t):await deciderFixture(t),c=provider==='shisa'?client(s):new SystemOneClient({url:s.url,provider,model:'decider-35b-a3b'});
 const r=await new ToolService(c).call(tool,args);assert.ok(r);assert.notEqual(r.status,'invalid_response');assert.ok(s.requests.length);
});
for(const provider of ['decider','shisa'])test(`${provider}: all 14 MCP tools + CLI doctor end-to-end`,async t=>{
 const s=provider==='shisa'?await fixture(t):await deciderFixture(t),env={SYSTEM_ONE_PROVIDER:provider,SYSTEM_ONE_MODEL:provider==='shisa'?'shisa-de-1':'decider-35b-a3b',SYSTEM_ONE_TIMEOUT_MS:'15000'};
 const m=await mcpProcess(s.url,{env,timeout:20000});t.after(()=>m.close());
 const listed=await m.request('tools/list');assert.equal(listed.result.tools.length,14);
 for(const [name,args]of Object.entries(TOOL_INPUTS)){
  const r=await m.request('tools/call',{name,arguments:args});assert.ok(!r.error&&!r.result?.isError,JSON.stringify(r));
  assert.notEqual(JSON.parse(r.result.content[0].text).status,'invalid_response');
 }
 const r=await command([BIN,'doctor'],{env:{...env,SYSTEM_ONE_URL:s.url},timeout:20000});assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/OK|true|reachable/i);
});
const corruptions={
 'chat template mismatch':(r,o)=>{if(r.body?.messages)o.tokens[0]++;},
 'tokenizer count mismatch':(r,o)=>{if(r.url.endsWith('tokenize'))o.count++;},
 'multitoken letter':(r,o)=>{if(r.body?.prompt==='A'){o.tokens.push(0);o.count++;}},
 'non-prefix-stable append':(r,o)=>{if(typeof r.body?.prompt==='string'&&r.body.prompt.endsWith('<channel|>A'))o.tokens[0]++;},
 'context limit':(r,o)=>{if(r.url.endsWith('tokenize'))o.max_model_len=32;},
 'missing top logprobs':(r,o)=>{if(r.url.endsWith('completions'))delete o.choices[0].logprobs;},
 'positive logprob':(r,o)=>{if(r.url.endsWith('completions'))o.choices[0].logprobs.top_logprobs[0]['token_id:65']=2;},
 'null logprob':(r,o)=>{if(r.url.endsWith('completions'))o.choices[0].logprobs.top_logprobs[0]['token_id:65']=null;},
 'multiple completions':(r,o)=>{if(r.url.endsWith('completions'))o.choices.push(o.choices[0]);},
 'extra generated token':(r,o)=>{if(r.url.endsWith('completions'))o.usage.completion_tokens=2;},
 'missing usage':(r,o)=>{if(r.url.endsWith('completions'))delete o.usage;},
 'missing fallback ids':(r,o)=>{if(r.body?.prompt_logprobs===0)delete o.choices[0].prompt_token_ids;},
 'wrong fallback ids':(r,o)=>{if(r.body?.prompt_logprobs===0)o.choices[0].prompt_token_ids[0]++;},
 'missing fallback tail':(r,o)=>{if(r.body?.prompt_logprobs===0)o.choices[0].prompt_logprobs.pop();},
 'wrong fallback decoded token':(r,o)=>{if(r.body?.prompt_logprobs===0)Object.values(o.choices[0].prompt_logprobs.at(-1))[0].decoded_token=' A';},
 'fallback HTTP failure':(r)=>{if(r.body?.prompt_logprobs===0)return {httpStatus:503};},
};
for(const [name,mutate]of Object.entries(corruptions))test(`Shisa fails closed: ${name}`,async t=>{
 const s=await fixture(t,{omit:['A'],mutate});await assert.rejects(client(s).ask('s',{q:mixed.c}));
});
test('Shisa returns no inferred zero when all letters are outside top-k',async t=>{
 const s=await fixture(t,{omit:['A','B','C']}),r=await client(s).ask('s',{q:mixed.c});assert.equal(r.bridge.fallback_requests,3);assert.ok(requireAnswers({q:mixed.c},r).q.probabilities.red>0);
});
test('Shisa one total deadline covers multiple HTTP stages',async t=>{
 const s=await fixture(t,{delay:20});const before=Date.now();await assert.rejects(client(s,{timeoutMs:90}).ask('s',{q:mixed.c}),e=>e.code==='timeout');assert.ok(Date.now()-before<600);assert.equal(s.requests.filter(r=>r.url.endsWith('completions')).length,0);
});
test('Shisa caller cancellation cleans HTTP semaphore and pending work',async t=>{
 const s=await fixture(t,{delay:25}),c=client(s),a=new AbortController();const timer=setTimeout(()=>a.abort(new Error('test abort')),45);
 await assert.rejects(c.ask('s',mixed,{signal:a.signal}),/test abort/);clearTimeout(timer);assert.equal(c.semaphore.active,0);assert.equal(c.semaphore.queue.length,0);
});
test('Shisa bounded scheduling does not exceed configured HTTP concurrency',async t=>{
 const s=await fixture(t,{delay:1}),c=client(s,{maxConcurrent:2});await c.ask('s',Object.fromEntries(Array.from({length:6},(_,i)=>['q'+i,mixed.n])));assert.ok(s.maxActive<=2);
});
test('Shisa authentication failure never falls back to another service',async t=>{
 const s=await fixture(t,{key:'secret'});await assert.rejects(client(s).ask('s',{q:mixed.n}),/HTTP 401/);assert.equal(s.requests.length,1);
});
for(const provider of ['decider','shisa'])test(`${provider}: Claude native compaction traverses provider transport`,async t=>{
 const s=provider==='shisa'?await fixture(t,{weights:p=>p.options.length===2?[.01,.99]:p.options.map((_,i)=>i===0?1:0)}):await deciderFixture(t);
 const f=async(url,init)=>{const r=await fetch(url,{method:init.method,headers:init.headers,body:init.body,signal:AbortSignal.timeout(20000)});return {ok:r.ok,status:r.status,text:await r.text()};};
 const r=await compactFunction(history(6,1000),{url:s.url,provider,model:provider==='shisa'?'shisa-de-1':'decider-35b-a3b',preserveRecentMessages:2},f);
 assert.ok(r.stats.reductionRatio>.25);assert.ok(s.requests.length);
});
test('Shisa Claude native hook falls back without changing history on provider failure',async t=>{
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url.endsWith('completions'))delete o.choices[0].logprobs;}}),handlers={};
 register((event,fn)=>handlers[event]=fn,{url:s.url,model:'shisa-de-1',provider:'shisa',preserveRecentMessages:2});
 const event={messages:history()},logs=[],$={env:{get:async()=>undefined},ui:{log:s=>logs.push(s)},http:{fetch:async(url,i)=>{const r=await fetch(url,i);return {ok:r.ok,status:r.status,text:await r.text()};}}};
 const snapshot=JSON.stringify(event);let fallback=0;
 await handlers['session.compact']($,event,async()=>{fallback++;});assert.equal(fallback,1);assert.equal(JSON.stringify(event),snapshot);assert.ok(logs.length);
});
test('Decider confidence follows its documented maximum-probability statistic',()=>{
 const q=mixed.c,a={type:'choice',choice:'blue',confidence:1,probabilities:{blue:.6,red:.2,green:.2}};
 assert.equal(parseAnswer(q,a,responseRules('decider')).ok,false);a.confidence=.6;assert.equal(parseAnswer(q,a,responseRules('decider')).ok,true);
});
test('Native function deadline rejects late answers and sends only inspected HTTP fields',async()=>{
 await assert.rejects(compactFunction(history(),{timeoutMs:5,preserveRecentMessages:2},async(_url,init)=>{
  assert.deepEqual(Object.keys(init).sort(),['body','headers','method']);await new Promise(r=>setTimeout(r,15));return {ok:true,status:200,text:'{}'};
 }),e=>e.code==='timeout');
});
test('Shisa top-token aliases cannot disagree, and whitespace tokens are never substituted',()=>{
 const response=row=>({model:'shisa-de-1',choices:[{index:0,text:' A',logprobs:{top_logprobs:[row]}}],usage:{prompt_tokens:1,completion_tokens:1}});
 assert.throws(()=>topLetterLogprobs(response({A:-1,'token_id:65':-2}),['A'],[65]),/conflicting/);
 assert.deepEqual(topLetterLogprobs(response({' A':-.1}),['A'],[65]),[null]);
});
