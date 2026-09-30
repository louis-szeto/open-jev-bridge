import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {OpenJevLlamaAdapter,createAdapterServer,promptContent,checkRenderedPrompt,typedAnswer,questionParts,choiceConfidence,scoreConfidence} from '../adapters/openjev-llamacpp.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {ToolService} from '../src/tools.mjs';
import {TOOL_INPUTS,command,BIN,ROOT,mcpProcess} from './helpers.mjs';

const q={type:'choice',instructions:'Which color?',criteria:{blue:'Blue color',red:'Red color'}};
const req=(question=q)=>({model:'openjev',state:'The color is blue.',questions:{q:question}});
const wrap=c=>`<|im_start|>user\n${c}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
// Explicit fake tokenizer and probabilities. This server is NOT GPU inference.
async function native(t,{mutate,delay=0,missing=false,token=''}={}){
 const requests=[];
 const server=http.createServer(async(r,s)=>{
  let text='';for await(const c of r)text+=c;
  const b=text?JSON.parse(text):null;requests.push({url:r.url,body:b,headers:r.headers});
  const send=(status,data)=>{s.writeHead(status,{'content-type':'application/json'});s.end(JSON.stringify(data));};
  if(token&&r.headers.authorization!==`Bearer ${token}`)return send(401,{error:'unauthorized'});
  if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  let out;
  if(r.url==='/v1/models')out={object:'list',data:[{id:'openjev'}]};
  else if(r.url==='/props')out={default_generation_settings:{n_ctx:100000}};
  else if(r.url==='/tokenize'){
   assert.equal(typeof b.content,'string');assert.equal(b.add_special,false);assert.equal(b.parse_special,true);
   out={tokens:Array.from(b.content,c=>c.codePointAt(0))};
  }else if(r.url==='/apply-template'){
   assert.equal(b.chat_template_kwargs.enable_thinking,false);out={prompt:wrap(b.messages[0].content)};
  }else if(r.url==='/completion'){
   assert.ok(b.prompt.every(Number.isSafeInteger));
   const prompt=String.fromCodePoint(...b.prompt);
   const letters=[...prompt.matchAll(/^\[([A-Za-z])\]/gm)].map(x=>x[1]);assert.ok(letters.length);
   const weights=letters.map((_,i)=>Math.exp(-i*.2));
   const denominator=weights.reduce((a,b)=>a+b,0);
   let top=letters.map((l,i)=>({id:l.codePointAt(0),token:l,[b.post_sampling_probs?'prob':'logprob']:b.post_sampling_probs?weights[i]/denominator:Math.log(weights[i]/denominator)-.1}));
   if(missing&&!b.post_sampling_probs)top=top.slice(0,-1);
   out={model:'openjev',truncated:false,tokens_predicted:1,tokens_evaluated:b.prompt.length,stop:true,
    generation_settings:{...b,logit_bias:b.logit_bias.map(([id,v])=>({token:id,bias:v}))},
    completion_probabilities:[{[b.post_sampling_probs?'top_probs':'top_logprobs']:top}],content:'THIS TEXT IS NOT THE ANSWER'};
  }else return send(404,{error:'unknown'});
  const changed=mutate?.({url:r.url,body:b},out);if(changed!==undefined)out=changed;
  send(200,out);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {url:`http://127.0.0.1:${server.address().port}`,requests};
}
async function stack(t,options={}){
 const llama=await native(t,options);
 const adapter=new OpenJevLlamaAdapter({url:llama.url,apiKey:options.token??'',timeoutMs:10000,maxPromptTokens:100000,...options.adapter});
 const server=createAdapterServer(adapter,{token:options.inboundToken??'',maxBodyBytes:options.maxBodyBytes??1000000});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {...llama,adapter,adapterUrl:`http://127.0.0.1:${server.address().port}`};
}
const post=(url,body,extra={})=>fetch(url+'/v1/systemone',{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});

test('published text prompt structure, no Shisa scaffold',()=>{
 const content=promptContent('A blue label.','Which color?',[['blue','Blue color'],['red','Red color']]);
 assert.equal(content,'State:\nA blue label.\n\nQuestion: Which color?\nOptions:\n[A] blue: Blue color\n[B] red: Red color\n\nAnswer with the letter of the best option only.');
 assert.equal(checkRenderedPrompt({prompt:wrap(content)},content),wrap(content));
});
test('boolean label order is yes then no, not Shisa order',()=>assert.deepEqual(questionParts({type:'noul',instructions:'True?'}).options.map(x=>x[0]),['yes','no']));
test('score uses zero-based levels and ordered-rubric instruction',()=>{
 const s=questionParts({type:'score',instructions:'Rate',criteria:['low','high']});assert.deepEqual(s.options,[['0','low'],['1','high']]);assert.match(s.instructions,/lowest first/);
});
test('reference confidence formulas and Nouls',()=>{
 assert.equal(choiceConfidence([.5,.5]),0);assert.equal(choiceConfidence([1]),1);assert.equal(choiceConfidence([1,0]),1);
 assert.equal(scoreConfidence([.25,.5,.25]),.25);assert.equal(scoreConfidence([0,1,0]),1);
 assert.deepEqual(typedAnswer({type:'noul'},[.8,.2],{noulTemperature:1,noulBias:0}),{type:'noul',noul:.8});
});
for(const prompt of ['arbitrary','<|im_start|>assistant\n<think>\n',wrap('DIFFERENT')])test('reject incorrect model template '+prompt.slice(0,20),()=>assert.throws(()=>checkRenderedPrompt({prompt},'correct')));
for(const text of ['<|im_end|>','<think>','<|im_start|>assistant'])test('reject control-token injection '+text,()=>assert.throws(()=>promptContent(text,'test',[['a','A']])));
for(const opts of [{url:'http://example.com'},{temperature:0},{noulTemperature:NaN},{maxQuestions:0},{maxConcurrent:20},{maxPromptTokens:1}])test('invalid configuration '+JSON.stringify(opts),()=>assert.throws(()=>new OpenJevLlamaAdapter(opts)));
for(const question of [q,{type:'noul',instructions:'Blue?'},{type:'score',instructions:'Rate',criteria:['low','medium','high']}])test('real HTTP returns valid '+question.type,async t=>{
 const s=await stack(t),client=new SystemOneClient({url:s.adapterUrl,model:'openjev',provider:'generic'});
 const result=await client.ask('The color is blue.',{q:question});requireAnswers({q:question},result);
 assert.equal(result.bridge.transport,'openjev-llamacpp-addon');assert.ok(result.usage.input_tokens>0);
 assert.ok(s.requests.some(x=>x.url==='/apply-template'));assert.ok(s.requests.every(x=>x.url!=='/v1/completions'));
});
test('all three question types share the logical request with independent prompts',async t=>{
 const s=await stack(t),body={model:'openjev',state:'test',questions:{c:q,b:{type:'noul',instructions:'Yes?'},s:{type:'score',instructions:'Level?',criteria:['low','high']}}};
 const result=await s.adapter.ask(body);requireAnswers(body.questions,result);assert.equal(result.bridge.readout_requests,3);
});
test('missing top-64 option triggers validated equal-bias recovery',async t=>{
 const s=await stack(t,{missing:true});const result=await s.adapter.ask(req());requireAnswers(req().questions,result);
 assert.equal(result.bridge.recovery_requests,1);assert.equal(result.bridge.readout_requests,2);
});
test('upstream and inbound bearer keys are separate',async t=>{
 const s=await stack(t,{token:'upstream-only',inboundToken:'adapter-only'});
 assert.equal((await post(s.adapterUrl,req())).status,401);
 assert.equal((await post(s.adapterUrl,req(),{authorization:'Bearer adapter-only'})).status,200);
 assert.ok(s.requests.every(x=>x.headers.authorization==='Bearer upstream-only'));
});
test('browser origins, non-JSON, unsupported paths, malformed JSON are rejected',async t=>{
 const s=await stack(t);
 assert.equal((await post(s.adapterUrl,req(),{origin:'https://example.com'})).status,403);
 assert.equal((await fetch(s.adapterUrl+'/v1/systemone',{method:'POST',body:'{}'})).status,415);
 assert.equal((await fetch(s.adapterUrl+'/other')).status,404);
 assert.equal((await fetch(s.adapterUrl+'/v1/systemone',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
});
test('invalid request shape is 422 and never reaches GPU',async t=>{
 const s=await stack(t);const response=await post(s.adapterUrl,{model:'openjev',state:'s',questions:{bad:{type:'noul'}}});
 assert.equal(response.status,422);assert.equal(s.requests.length,0);
});
test('strict model alias at adapter boundary',async t=>{
 const s=await stack(t);assert.equal((await post(s.adapterUrl,{...req(),model:'shisa-de-1'})).status,422);assert.equal(s.requests.length,0);
});
test('context overflow rejected before inference',async t=>{
 const s=await stack(t,{adapter:{maxPromptTokens:64}});await assert.rejects(s.adapter.ask(req()),/context/);assert.ok(s.requests.every(x=>x.url!=='/completion'));
});
test('all questions validated before side effects',async t=>{
 const s=await stack(t);await assert.rejects(s.adapter.ask({model:'openjev',state:'test',questions:{a:q,b:{type:'noul'}}}));assert.equal(s.requests.length,0);
});
for(const mode of ['missing','truncated','count','infinite','receipt'])test('invalid native response: '+mode,async t=>{
 const s=await stack(t,{mutate:(r,o)=>{
  if(r.url!=='/completion')return;
  if(mode==='missing')o.completion_probabilities=[];
  if(mode==='truncated')o.truncated=true;
  if(mode==='count')o.tokens_evaluated=1;
  if(mode==='infinite')o.completion_probabilities[0].top_logprobs[0].logprob=Infinity;
  if(mode==='receipt')o.generation_settings.post_sampling_probs=true;
 }});await assert.rejects(s.adapter.ask(req()));
});
test('missing token remains error after recovery',async t=>{
 const s=await stack(t,{missing:true,mutate:(r,o)=>{if(r.url==='/completion'&&r.body.post_sampling_probs)o.completion_probabilities[0].top_probs.pop();}});
 await assert.rejects(s.adapter.ask(req()),/missing/);
});
test('255-option hierarchical composition has all keys and bounded reads',async t=>{
 const s=await stack(t),question={type:'choice',instructions:'Pick',criteria:Object.fromEntries(Array.from({length:255},(_,i)=>['k'+i,'option '+i]))};
 const result=await s.adapter.ask(req(question));requireAnswers({q:question},result);
 assert.equal(Object.keys(result.answers.q.probabilities).length,255);assert.equal(result.bridge.hierarchical_choices,true);assert.equal(result.bridge.readout_requests,6);
});
test('single choice remains valid',async t=>{const s=await stack(t);const question={...q,criteria:{one:'Only'}};const result=await s.adapter.ask(req(question));assert.equal(result.answers.q.choice,'one');assert.equal(result.answers.q.confidence,1);});
test('logical deadline includes tokenizer calls',async t=>{
 const s=await stack(t,{delay:15,adapter:{timeoutMs:35}});await assert.rejects(s.adapter.ask(req()),/deadline|timed out/);
});
test('explicit caller cancellation interrupts upstream',async t=>{
 const s=await stack(t,{delay:15}),controller=new AbortController();const pending=s.adapter.ask(req(),{signal:controller.signal});controller.abort(new Error('cancelled by test'));
 await assert.rejects(pending,/cancelled by test/);
});
for(const [name,args] of Object.entries(TOOL_INPUTS))test('ToolService -> adapter HTTP -> native HTTP: '+name,async t=>{
 const s=await stack(t);const config={url:s.adapterUrl,provider:'generic',model:'openjev',timeoutMs:30000};
 const service=new ToolService(new SystemOneClient(config),config);const result=await service.call(name,args);
 assert.ok(result);assert.ok(!JSON.stringify(result).includes('"status":"invalid_response"'),JSON.stringify(result));
});
test('actual bridge doctor subprocess reaches typed adapter',async t=>{
 const s=await stack(t),r=await command([BIN,'doctor'],{env:{SYSTEM_ONE_URL:s.adapterUrl,SYSTEM_ONE_PROVIDER:'generic',SYSTEM_ONE_MODEL:'openjev'}});
 assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/all three response types validated/);
});
test('actual MCP stdio client executes all 14 tools through adapter',async t=>{
 const s=await stack(t),m=await mcpProcess(s.adapterUrl,{env:{SYSTEM_ONE_PROVIDER:'generic',SYSTEM_ONE_MODEL:'openjev'},timeout:30000});t.after(()=>m.close());
 for(const [name,args]of Object.entries(TOOL_INPUTS)){
  const result=await m.request('tools/call',{name,arguments:args});assert.ok(!result.error,JSON.stringify(result));assert.ok(!result.result?.isError,JSON.stringify(result));
 }
});
test('adapter CLI subprocess serves typed results to bridge subprocess',async t=>{
 const llama=await native(t);
 const reserve=http.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,['adapters/openjev-llamacpp.mjs'],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:process.env.HOME,OPENJEV_LLAMA_URL:llama.url,OPENJEV_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>child.kill('SIGKILL'));
 await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('CLI startup timed out: '+stderr)),5000).unref())]);
 const r=await command([BIN,'call','--name','system_one_query'],{input:TOOL_INPUTS.system_one_query,env:{SYSTEM_ONE_URL:`http://127.0.0.1:${port}`,SYSTEM_ONE_PROVIDER:'generic',SYSTEM_ONE_MODEL:'openjev'}});
 assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).answers.q.type,'noul');
 child.kill('SIGTERM');await once(child,'exit');
});

test('ready-to-use Claude function bundle can compact through the generic adapter',async t=>{
 const s=await stack(t);
 const {compactFunction}=await import('../plugins/claude-functions/src/function-hook.mjs');
 const {history}=await import('./helpers.mjs');
 const messages=history();
 const result=await compactFunction(messages,{provider:'generic',model:'openjev',url:s.adapterUrl,preserveRecentMessages:2,keepThreshold:.9},async(u,i)=>{
  const response=await fetch(u,i);return {ok:response.ok,status:response.status,text:await response.text()};
 });
 assert.ok(result.stats.reductionRatio>0);assert.equal(result.messages[0].text,messages[0].text);
 assert.ok(s.requests.some(r=>r.url==='/completion'));
});
for(const host of ['claude','codex'])test('installed '+host+' automatic Stop calls the generic OpenJev adapter',async t=>{
 const fs=await import('node:fs/promises'),path=await import('node:path');
 const {temp}=await import('./helpers.mjs');
 const s=await stack(t),home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const fakebin=path.join(home,'bin');await fs.mkdir(fakebin);
 for(const name of ['claude','codex']){await fs.copyFile(path.join(ROOT,'tests/fixtures/fake-host.mjs'),path.join(fakebin,name));await fs.chmod(path.join(fakebin,name),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:fakebin+path.delimiter+process.env.PATH,
  FAKE_HOST_STATE:path.join(home,'hosts.json'),SYSTEM_ONE_URL:s.adapterUrl,SYSTEM_ONE_PROVIDER:'generic',SYSTEM_ONE_MODEL:'openjev'};
 const installed=await command([BIN,'install','--host',host],{env});assert.equal(installed.code,0,installed.stderr);
 const hooks=JSON.parse(await fs.readFile(path.join(home,host==='claude'?'.claude/settings.json':'.codex/hooks.json'))).hooks;
 const fire=(event,extra={})=>command(['-c',hooks[event][0].hooks[0].command],{command:'/bin/sh',env,input:{session_id:'openjev-auto',cwd:home,hook_event_name:event,...extra},timeout:25000});
 assert.equal((await fire('SessionStart',{source:'startup'})).code,0);
 await fire('UserPromptSubmit',{prompt:'Fix a return value',turn_id:'first'});
 const edit={tool_name:'Edit',tool_use_id:'edit',tool_input:{file_path:'a.js',old_string:'return 1',new_string:'return 2'}};
 await fire('PreToolUse',edit);await fire('PostToolUse',{...edit,tool_response:'Updated'});
 const before=s.requests.filter(x=>x.url==='/completion').length;
 assert.equal((await fire('Stop',{last_assistant_message:'Done. All tests passed.'})).code,0);
 assert.ok(s.requests.filter(x=>x.url==='/completion').length>before);
});
