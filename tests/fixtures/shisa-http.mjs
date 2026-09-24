// Explicit synthetic HTTP/tokenizer fixture. No real model is loaded. It independently
// checks the vLLM wire schema and chat scaffold; it NEVER calls production adapter code.
import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
export const encode=s=>Array.from(s,c=>c.codePointAt(0));
export const decode=ids=>ids.map(x=>String.fromCodePoint(x)).join('');
const system='Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning.';
function render(messages){
 assert.deepEqual(messages.map(x=>x.role),['system','user']);assert.equal(messages[0].content,system);
 return '<bos><|turn>system\n'+messages[0].content.trim()+'<turn|>\n<|turn>user\n'+messages[1].content.trim()+'<turn|>\n<|turn>model\n<|channel>thought\n<channel|>';
}
function payload(prompt){const start=prompt.indexOf('<|turn>user\n')+'<|turn>user\n'.length,end=prompt.lastIndexOf('<turn|>\n<|turn>model');return JSON.parse(prompt.slice(start,end));}
export function fixtureWeights(p){
 const n=p.options.length, q=typeof p.criterion==='string'?p.criterion:JSON.stringify(p.criterion);
 if(p.options.map(x=>x.description.split(':')[0]).join(',')==='Yes,No'){
  // Deliberate finite fixture labels, not an accuracy test.
  const no=/injection|aimed at|attempting to redirect|still need|still required|keep.*verbatim|worth keeping|remain in context|remain verbatim/i.test(q);
  return no?[.01,.99]:[.99,.01];
 }
 const score=p.options.every((x,i)=>x.description.startsWith(`${i}: `));
 const best=score&& !/test.*gap|gap.*tests|blast|risk of regression|risk of unintended/i.test(q)?n-1:0;
 return p.options.map((_,i)=>i===best?.999999: .000001/(n-1||1));
}
export async function shisaHttp({key,mutate,weights=fixtureWeights,omit=[],prefix='',delay=0}={}){
 const requests=[],errors=[],sockets=new Set();let active=0,maxActive=0;
 const server=http.createServer(async(req,res)=>{
  active++;maxActive=Math.max(active,maxActive);res.on('close',()=>active--);
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try{
   let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):null;
   const r={method:req.method,url:req.url,body,headers:req.headers};requests.push(r);
   if(key&&req.headers.authorization!==`Bearer ${key}`)return reply(401,{error:'unauthorized'});
   if(delay)await new Promise(r=>setTimeout(r,delay));
   let out;
   if(req.url===prefix+'/v1/models'){
    assert.equal(req.method,'GET');out={object:'list',data:[{id:'shisa-de-1',object:'model',created:1,owned_by:'fixture'}]};
   }else if(req.url===prefix+'/tokenize'){
    assert.equal(req.method,'POST');assert.equal(body.model,'shisa-de-1');assert.equal(body.add_special_tokens,false);
    let prompt=body.prompt;
    if(body.messages){assert.equal(body.add_generation_prompt,true);assert.deepEqual(body.chat_template_kwargs,{enable_thinking:false});prompt=render(body.messages);}
    assert.equal(typeof prompt,'string');const tokens=encode(prompt);out={tokens,count:tokens.length,max_model_len:262144};
   }else if(req.url===prefix+'/v1/completions'){
    assert.equal(req.method,'POST');assert.equal(body.model,'shisa-de-1');assert.equal(body.max_tokens,1);assert.equal(body.temperature,0);
    assert.equal(body.n,1);assert.equal(body.stream,false);assert.equal(body.add_special_tokens,false);
    assert.equal(body.return_tokens_as_token_ids,true);assert.ok(Array.isArray(body.prompt)&&body.prompt.every(Number.isInteger));
    assert.ok(!('logit_bias' in body));assert.ok(!('truncate_prompt_tokens' in body));
    const prompt=decode(body.prompt),p=payload(prompt),probs=weights(p);
    assert.deepEqual(Object.keys(p),['evidence','criterion','options']);assert.equal(probs.length,p.options.length);
    const choice={index:0,text:'-',finish_reason:'length'}; // Intentionally NOT the right option.
    const top=Object.fromEntries(p.options.filter(x=>!omit.includes(x.letter)).map(x=>[`token_id:${x.letter.codePointAt(0)}`,Math.log(probs[p.options.indexOf(x)])-1]));
    top['token_id:45']=-.01; // Out-of-option token outranks all options.
    choice.logprobs={tokens:['-'],token_logprobs:[-.01],text_offset:[0],top_logprobs:[top]};
    if('prompt_logprobs' in body){
     assert.equal(body.prompt_logprobs,0);assert.equal(body.logprobs,0);assert.equal(body.return_token_ids,true);
     const letter=prompt.at(-1),idx=p.options.findIndex(x=>x.letter===letter);assert.ok(idx>=0);
     assert.ok(prompt.endsWith('<channel|>'+letter));
     choice.prompt_token_ids=body.prompt;choice.prompt_logprobs=body.prompt.map((id,i)=>i===0?null:{[id]:{logprob:i===body.prompt.length-1?Math.log(probs[idx])-1:-.5,rank:1,decoded_token:String.fromCodePoint(id)}});
    }else{assert.ok(Number.isInteger(body.logprobs)&&body.logprobs>0);assert.ok(prompt.endsWith('<channel|>'));}
    out={id:'cmpl-fixture',object:'text_completion',created:1,model:'shisa-de-1',choices:[choice],usage:{prompt_tokens:body.prompt.length,completion_tokens:1,total_tokens:body.prompt.length+1}};
   }else{return reply(404,{error:'wrong_route'});}
   if(mutate){const value=await mutate(r,out,requests.length);if(value?.httpStatus)return reply(value.httpStatus,{error:'fixture_failure'});if(value!==undefined)out=value;}
   reply(200,out);
  }catch(e){errors.push(e);reply(422,{error:'fixture_contract_failure'});}
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});server.listen(0,'127.0.0.1');await once(server,'listening');
 return {requests,errors,get maxActive(){return maxActive;},url:`http://127.0.0.1:${server.address().port}${prefix}`,
 async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
