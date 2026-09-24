import test from 'node:test';
import assert from 'node:assert/strict';
import {llamaHttp} from './fixtures/llamacpp-http.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {ToolService} from '../src/tools.mjs';
import {resolveConfig} from '../src/config.mjs';
import {serviceEndpoints} from '../src/endpoints.mjs';
import {llamaTokens,llamaContextLimit} from '../src/shisa-llamacpp.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {compactFunction} from '../src/function-hook.mjs';
import {TOOL_INPUTS,history,BIN,command,mcpProcess} from './helpers.mjs';
const questions={n:{type:'noul',instructions:'Is blue present?'},c:{type:'choice',instructions:'Choose',criteria:{blue:'Blue',red:'Red',green:null}},s:{type:'score',instructions:'Rate',criteria:['poor','fair','good']}};
async function fixture(t,options){const s=await llamaHttp(options);t.after(async()=>{await s.close();assert.deepEqual(s.errors,[]);});return s;}
const client=(s,c={})=>new SystemOneClient({provider:'shisa',shisaBackend:'llamacpp',model:'shisa-de-1',url:s.url,...c});
const env=s=>({SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_SHISA_BACKEND:'llamacpp',SYSTEM_ONE_URL:s.url,SYSTEM_ONE_MODEL:'shisa-de-1'});

test('Reported empty-token failure reproduced exactly, now with a backend-specific hint',async t=>{
 const s=await fixture(t);
 const r=await fetch(s.url+'/tokenize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'A'})});assert.deepEqual(await r.json(),{tokens:[]});
 await assert.rejects(new SystemOneClient({provider:'shisa',url:s.url}).ask('s',{n:questions.n}),/SYSTEM_ONE_SHISA_BACKEND=llamacpp/);
 const ok=await client(s).ask('s',{n:questions.n});assert.equal(ok.answers.n.type,'noul');
});
for(const backend of ['vllm','llamacpp','llama.cpp'])test(`Backend configuration ${backend}`,()=>{
 const c=resolveConfig({},{SYSTEM_ONE_SHISA_BACKEND:backend},{readFile:false});assert.equal(c.shisaBackend,backend==='llama.cpp'?'llamacpp':backend);
});
for(const value of ['auto','llama-server','',null,42])test(`Reject ambiguous/invalid backend ${JSON.stringify(value)}`,()=>assert.throws(()=>resolveConfig({shisaBackend:value},{},{readFile:false})));
test('Native tokenizer accepts ids-only responses without vLLM fields',()=>assert.deepEqual(llamaTokens({tokens:[65,66]}),[65,66]));
for(const r of [{},{tokens:[]},{tokens:[1.2]},{tokens:[-1]},{tokens:[null]},{tokens:[{id:65,piece:'A'}]},{tokens:[65],count:2}])test(`Reject invalid native tokenizer ${JSON.stringify(r)}`,()=>assert.throws(()=>llamaTokens(r)));
for(const n of [undefined,null,0,-1,1.5,'8192'])test(`Invalid per-slot context ${n}`,()=>assert.throws(()=>llamaContextLimit({default_generation_settings:{n_ctx:n},total_slots:4})));
test('Context limit is per-slot, never multiplied by parallel slots',()=>assert.equal(llamaContextLimit({default_generation_settings:{n_ctx:8192},total_slots:4}),8192));
for(const suffix of ['','/v1','/v1/completions/','/completion/'])test(`Native routes preserve reverse-proxy prefix ${suffix}`,()=>{
 const e=serviceEndpoints('http://127.0.0.1:8012/proxy'+suffix,false,'shisa');assert.equal(e.applyTemplate,'http://127.0.0.1:8012/proxy/apply-template');assert.equal(e.nativeCompletion,'http://127.0.0.1:8012/proxy/completion');assert.equal(e.props,'http://127.0.0.1:8012/proxy/props');
});
test('All three answer types use native endpoints and ignore sampled text',async t=>{
 const s=await fixture(t),r=await client(s).ask({text:'日本語 <bos>',n:3},questions);requireAnswers(questions,r);
 assert.equal(r.bridge.transport,'shisa-llamacpp-restricted-letters');assert.equal(r.bridge.fallback_requests,0);assert.equal(r.bridge.readout_requests,3);
 assert.equal(r.answers.c.choice,'blue');assert.ok(r.answers.n.noul>.9);assert.ok(r.answers.s.score>1.9);
 assert.ok(s.requests.every(r=>!r.url.endsWith('/v1/completions')));
 assert.ok(s.requests.filter(r=>r.url.endsWith('/tokenize')).every(r=>typeof r.body.content==='string'));
});
for(const [name,args]of Object.entries(TOOL_INPUTS))test(`llama.cpp all-tools HTTP integration: ${name}`,async t=>{
 const s=await fixture(t),c=client(s),result=await new ToolService(c,c.config).call(name,args);
 assert.ok(result);assert.ok(!JSON.stringify(result).includes('invalid_response'));
});
test('Missing option uses native equal-bias recovery, not vLLM prompt_logprobs',async t=>{
 const s=await fixture(t,{omit:['C'],weights:p=>p.options.length===3?[.6,.3,.1]:[.8,.2]}),r=await client(s).ask('x',{c:questions.c});
 assert.equal(r.bridge.fallback_requests,1);assert.equal(r.bridge.readout_requests,2);
 for(const [i,k]of ['blue','red','green'].entries())assert.ok(Math.abs(r.answers.c.probabilities[k]-[.6,.3,.1][i])<1e-12);
 assert.equal(r.usage.output_tokens,2);assert.ok(s.requests.every(r=>!r.body||!('prompt_logprobs' in r.body)));
});
test('All 26 letters including omitted low-probability options are retained',async t=>{
 const s=await fixture(t,{omit:['U','V','W','X','Y','Z']}),criteria=Object.fromEntries(Array.from({length:26},(_,i)=>['k'+i,null]));
 const r=await client(s).ask('s',{q:{type:'choice',instructions:'Choose',criteria}});
 assert.equal(Object.keys(r.answers.q.probabilities).length,26);assert.ok(Object.values(r.answers.q.probabilities).every(v=>v>0));assert.equal(r.bridge.fallback_requests,1);
});
test('Equal-bias recovery agrees with unrestricted oracle across seeded random distributions',async t=>{
 let seed=20260924;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
 let weights=[.2,.3,.5];const s=await fixture(t,{omit:['C'],weights:()=>weights}),c=client(s);
 for(let k=0;k<30;k++){const logits=Array.from({length:3},()=>random()*40-20),max=Math.max(...logits),w=logits.map(x=>Math.exp(x-max)),sum=w.reduce((a,b)=>a+b,0);weights=w.map(x=>x/sum);
  const r=await c.ask('random',{c:questions.c});for(const [i,key]of ['blue','red','green'].entries())assert.ok(Math.abs(r.answers.c.probabilities[key]-weights[i])<1e-12);
 }
});
const mutations=[
 ['missing props limit',(r,o)=>{if(r.url.endsWith('/props'))delete o.default_generation_settings.n_ctx;}],
 ['missing control token',(r,o)=>{if(r.url.endsWith('/tokenize')&&r.body.content==='<bos>')o.tokens=[];}],
 ['split control token',(r,o)=>{if(r.url.endsWith('/tokenize')&&r.body.content==='<|turn>')o.tokens=[60,124];}],
 ['empty native token array',(r,o)=>{if(r.url.endsWith('/tokenize'))o.tokens=[];}],
 ['unstable appended letter',(r,o)=>{if(r.url.endsWith('/tokenize')&&r.body.content.endsWith('<channel|>A'))o.tokens[0]=999;}],
 ['multi-token letter',(r,o)=>{if(r.url.endsWith('/tokenize')&&r.body.content==='A')o.tokens=[65,65];}],
 ['server-side truncation',(r,o)=>{if(r.url.endsWith('/completion'))o.truncated=true;}],
 ['missing truncation status',(r,o)=>{if(r.url.endsWith('/completion'))delete o.truncated;}],
 ['changed prompt token count',(r,o)=>{if(r.url.endsWith('/completion'))o.tokens_evaluated++;}],
 ['too many generated tokens',(r,o)=>{if(r.url.endsWith('/completion'))o.tokens_predicted=2;}],
 ['missing probabilities',(r,o)=>{if(r.url.endsWith('/completion'))delete o.completion_probabilities;}],
 ['wrong probability phase',(r,o)=>{if(r.url.endsWith('/completion'))o.generation_settings.post_sampling_probs=!r.body.post_sampling_probs;}],
 ['duplicate probability ids',(r,o)=>{if(r.url.endsWith('/completion')&&!r.body.post_sampling_probs)o.completion_probabilities[0].top_logprobs.push(o.completion_probabilities[0].top_logprobs[0]);}],
 ['positive logprob',(r,o)=>{if(r.url.endsWith('/completion')&&!r.body.post_sampling_probs)o.completion_probabilities[0].top_logprobs[0].logprob=1;}],
 ['wrong letter for token id',(r,o)=>{if(r.url.endsWith('/completion')&&!r.body.post_sampling_probs)o.completion_probabilities[0].top_logprobs.find(x=>x.id===65).token=' B';}],
 ['missing recovery option',(r,o)=>{if(r.body?.post_sampling_probs)o.completion_probabilities[0].top_probs=o.completion_probabilities[0].top_probs.filter(x=>x.id!==67);}],
 ['zero recovery probability',(r,o)=>{if(r.body?.post_sampling_probs)o.completion_probabilities[0].top_probs.find(x=>x.id===67).prob=0;}],
 ['ignored recovery biases',(r,o)=>{if(r.body?.post_sampling_probs)o.generation_settings.logit_bias=[];}],
 ['unequal recovery biases',(r,o)=>{if(r.body?.post_sampling_probs)o.generation_settings.logit_bias[0].bias=79;}],
 ['extra recovery sampler',(r,o)=>{if(r.body?.post_sampling_probs)o.generation_settings.samplers.push('top_p');}],
 ['wrong recovery temperature',(r,o)=>{if(r.body?.post_sampling_probs)o.generation_settings.temperature=.8;}],
 ['inconsistent recovered logit gap',(r,o)=>{if(r.body?.post_sampling_probs)o.completion_probabilities[0].top_probs.find(x=>x.id===66).prob/=2;}],
];
for(const [name,mutate]of mutations)test(`Native validation fails closed: ${name}`,async t=>{
 const s=await fixture(t,{mutate,omit:['C'],weights:()=>[.6,.3,.1]});await assert.rejects(client(s).ask('s',{c:questions.c}),e=>e.code==='invalid_response');
});
test('Long prompt rejected before inference; slot count does not hide overflow',async t=>{
 const s=await fixture(t,{context:512});await assert.rejects(client(s).ask('x'.repeat(600),{n:questions.n}),e=>e.code==='context_budget');assert.ok(s.requests.every(r=>!r.url.endsWith('/completion')));
});
test('All native endpoints retain bearer authentication and proxy prefix',async t=>{
 const s=await fixture(t,{prefix:'/local',key:'fixture-secret'});const c=client(s,{apiKey:'fixture-secret'});await c.models();await c.ask('s',{n:questions.n});assert.ok(s.requests.every(r=>r.headers.authorization==='Bearer fixture-secret'));
});
test('Authentication failures cannot become a judgment',async t=>{
 const s=await fixture(t,{key:'secret'});await assert.rejects(client(s).ask('s',{n:questions.n}),/401/);
});
test('One deadline covers props, tokenization and completion',async t=>{
 const s=await fixture(t,{delay:20});await assert.rejects(client(s,{timeoutMs:45}).ask('s',{n:questions.n}),e=>e.code==='timeout');
});
test('Caller cancellation aborts the llama.cpp request',async t=>{
 const s=await fixture(t,{delay:30}),c=client(s),abort=new AbortController(),p=c.ask('s',questions,{signal:abort.signal});setTimeout(()=>abort.abort(new Error('cancelled-by-test')),10);await assert.rejects(p,/cancelled-by-test/);
});
test('Native request concurrency is bounded',async t=>{
 const s=await fixture(t,{delay:1});await client(s,{maxConcurrent:2}).ask('s',Object.fromEntries(Array.from({length:8},(_,i)=>['q'+i,questions.n])));assert.ok(s.maxActive<=2);
});
test('Claude isolated adapter allows GET /props with no undefined JSON body',async t=>{
 const s=await fixture(t),fetchFn=async(url,i)=>{if(i.method==='GET')assert.ok(!('body' in i));const r=await fetch(url,i);return {ok:r.ok,status:r.status,text:await r.text()};};
 const result=await compactFunction(history(),{provider:'shisa',shisaBackend:'llamacpp',url:s.url,model:'shisa-de-1',preserveRecentMessages:2},fetchFn);assert.ok(result.stats.reductionRatio>.25);
});
test('CLI doctor performs actual native tokenization and all three typed readouts',async t=>{
 const s=await fixture(t),r=await command([BIN,'doctor','--shisa-backend','llamacpp'],{env:env(s)});assert.equal(r.code,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.shisa_backend,'llamacpp');assert.equal(Object.keys(out.answers).length,3);
});
test('All fourteen tools work through the real MCP subprocess with native fixture',async t=>{
 const s=await fixture(t),m=await mcpProcess(s.url,{env:env(s)});t.after(()=>m.close());
 for(const [name,args]of Object.entries(TOOL_INPUTS)){const r=await m.request('tools/call',{name,arguments:args});assert.ok(!r.result?.isError,JSON.stringify(r));assert.ok(r.result);}
});
