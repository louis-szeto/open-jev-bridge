import http from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';
export const wrap=c=>`<|im_start|>user\n${c}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
// Explicit fake tokenizer and probabilities. This server is NOT GPU inference.
export async function native(t,{mutate,delay=0,missing=false,token=''}={}){
 const requests=[],errors=[];
 const server=http.createServer(async(r,s)=>{
  try {
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
  }catch(error){errors.push(error.message);s.writeHead(500);s.end('fixture contract failure');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {url:`http://127.0.0.1:${server.address().port}`,requests,errors};
}
