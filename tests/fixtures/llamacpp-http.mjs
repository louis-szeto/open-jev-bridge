// Independent llama.cpp HTTP contract fixture, not a model or actual tokenizer.
// Uses codepoints as deterministic token ids. Production readout code is not imported.
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {fixtureWeights} from './shisa-http.mjs';
const encode=s=>Array.from(s,c=>c.codePointAt(0));
const decode=ids=>ids.map(x=>String.fromCodePoint(x)).join('');
function render(messages){
 assert.deepEqual(messages.map(m=>m.role),['system','user']);
 return `<bos><|turn>system\n${messages[0].content}<turn|>\n<|turn>user\n${messages[1].content}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>`;
}
function payload(prompt){
 const start=prompt.indexOf('<|turn>user\n')+'<|turn>user\n'.length;
 return JSON.parse(prompt.slice(start,prompt.lastIndexOf('<turn|>\n<|turn>model')));
}
export async function llamaHttp({key,mutate,weights=fixtureWeights,omit=[],prefix='',delay=0,context=32768}={}){
 const requests=[],errors=[],sockets=new Set();let active=0,maxActive=0;
 const server=http.createServer(async(req,res)=>{
  active++;maxActive=Math.max(maxActive,active);res.on('close',()=>active--);
  const reply=(status,obj)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
  try{
   let raw='';for await(const c of req)raw+=c;
   const body=raw?JSON.parse(raw):null,r={method:req.method,url:req.url,body,headers:req.headers};requests.push(r);
   if(key&&req.headers.authorization!==`Bearer ${key}`)return reply(401,{error:'unauthorized'});
   if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
   let out;
   if(req.url===prefix+'/v1/models'){
    assert.equal(req.method,'GET');out={object:'list',data:[{id:'shisa-de-1',object:'model',owned_by:'llamacpp',created:1}]};
   }else if(req.url===prefix+'/props'){
    assert.equal(req.method,'GET');assert.equal(body,null);
    out={default_generation_settings:{n_ctx:context,params:{}},total_slots:4,model_path:'/fixture/shisa.IQ4_XS.gguf'};
   }else if(req.url===prefix+'/apply-template'){
    assert.equal(req.method,'POST');assert.equal(body.add_generation_prompt,true);
    assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false});out={prompt:render(body.messages)};
   }else if(req.url===prefix+'/tokenize'){
    assert.equal(req.method,'POST');
    // This intentionally reproduces the user's response for a vLLM-shaped request.
    if(typeof body.content!=='string')return reply(200,{tokens:[]});
    assert.equal(body.add_special,false);assert.equal(body.parse_special,true);assert.equal(body.with_pieces,false);
    assert.ok(!('prompt' in body));assert.ok(!('messages' in body));assert.ok(!('add_special_tokens' in body));
    out={tokens:encode(body.content)};
   }else if(req.url===prefix+'/completion'){
    assert.equal(req.method,'POST');assert.equal(body.n_predict,1);assert.equal(body.stream,false);
    assert.equal(body.temperature,1);assert.deepEqual(body.samplers,['temperature']);assert.equal(body.backend_sampling,false);
    for(const [k,v]of Object.entries({top_k:0,top_p:1,min_p:0,typical_p:1,dynatemp_range:0,mirostat:0,repeat_penalty:1,repeat_last_n:0,presence_penalty:0,frequency_penalty:0,dry_multiplier:0,grammar:'',ignore_eos:false,cache_prompt:false}))assert.equal(body[k],v);
    assert.ok(!('prompt_logprobs' in body));assert.ok(!('allowed_token_ids' in body));
    assert.ok(Array.isArray(body.prompt)&&body.prompt.every(Number.isSafeInteger));
    const prompt=decode(body.prompt);assert.ok(prompt.endsWith('<channel|>'));
    const p=payload(prompt),w=weights(p);assert.equal(w.length,p.options.length);
    // Independent numerical oracle: unrestricted logits -> optional bias -> full
    // softmax -> sorted top-N, including non-option vocabulary rows.
    const rows=p.options.map((o,i)=>({id:o.letter.codePointAt(0),token:o.letter,logit:Math.log(w[i])-2}));
    rows.push({id:45,token:'-',logit:-.01});
    if(body.post_sampling_probs){
     assert.deepEqual(body.logit_bias,p.options.map(o=>[o.letter.codePointAt(0),80]));
     for(const row of rows)row.logit+=body.logit_bias.find(([id])=>id===row.id)?.[1]??0;
    }else assert.deepEqual(body.logit_bias,[]);
    const max=Math.max(...rows.map(r=>r.logit)),sum=rows.reduce((n,r)=>n+Math.exp(r.logit-max),0);
    let top=rows.map(r=>({id:r.id,token:r.token,bytes:[r.id],...(body.post_sampling_probs?
     {prob:Math.exp(r.logit-max)/sum}:{logprob:r.logit-max-Math.log(sum)})}));
    top.sort((a,b)=>(b.prob??b.logprob)-(a.prob??a.logprob));
    if(!body.post_sampling_probs)top=top.filter(r=>!omit.includes(r.token));
    top=top.slice(0,body.n_probs);
    const g={...body,logit_bias:body.logit_bias.map(([token,bias])=>({token,bias}))};delete g.prompt;
    // The generated text is deliberately unrelated to the judgment.
    out={index:0,content:'-',tokens:[45],stop:true,model:'shisa-de-1',tokens_predicted:1,
     tokens_evaluated:body.prompt.length,generation_settings:g,truncated:false,stop_type:'limit',
     completion_probabilities:[{id:45,token:'-',...(body.post_sampling_probs?{top_probs:top}:{top_logprobs:top})}]};
   }else return reply(404,{error:'wrong-route'});
   if(mutate){const next=await mutate(r,out,requests.length);if(next?.httpStatus)return reply(next.httpStatus,{error:'fixture-failure'});if(next!==undefined)out=next;}
   reply(200,out);
  }catch(e){errors.push(e);reply(422,{error:'fixture-contract-failure'});}
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});server.listen(0,'127.0.0.1');await once(server,'listening');
 return {requests,errors,get maxActive(){return maxActive;},url:`http://127.0.0.1:${server.address().port}${prefix}`,
 async close(){for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
