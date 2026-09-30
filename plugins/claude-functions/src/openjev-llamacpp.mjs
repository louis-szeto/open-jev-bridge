/** OpenJev GGUF restricted-letter readout. Adapted from the Apache-2.0
 * OpenJev reference helper; modified for llama.cpp, bounded HTTP and typed validation.
 * See licenses/OPENJEV_LICENSE.txt and licenses/OPENJEV_NOTICE.txt. */
import {invariant,isRecord,BridgeError} from './pure.mjs';
import {validateRequest,requireAnswers,RESPONSE_RULES} from './schema.mjs';
import {llamaTokens,llamaContextLimit,llamaLetterLogprobs,LLAMA_OPTION_BIAS} from './shisa-llamacpp.mjs';
import {restrictedSoftmax} from './shisa.mjs';

export const LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const same=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);
const fail=(ok,message,code='invalid_response')=>invariant(ok,`openjev/llamacpp: ${message}`,code);
const r4=n=>Math.round(n*10000)/10000;
const desc=v=>v==null?'':typeof v==='string'?v:JSON.stringify(v);
const CONTROL=/<\|[^>\r\n]+\|>|<\/?think>/;

export function choiceConfidence(p){
 return p.length===1?1:Math.max(0,(Math.max(...p)-1/p.length)/(1-1/p.length));
}
export function scoreConfidence(p){
 if(p.length===1)return 1;
 const mode=p.indexOf(Math.max(...p)),mid=(p.length-1)/2;
 const distance=p.reduce((n,v,i)=>n+v*Math.abs(i-mode),0);
 const uniformDeviation=p.reduce((n,_,i)=>n+Math.abs(i-mid),0)/p.length;
 return Math.max(0,1-distance/uniformDeviation);
}
export function questionParts(q){
 // String instructions match the released helper. Structured instructions are
 // rendered as JSON, not Python repr: an explicit compatibility difference.
 let instructions=desc(q.instructions),options;
 if(q.type==='noul')options=[['yes',desc(q.criteria?.true)||'The statement is true.'],['no',desc(q.criteria?.false)||'The statement is false.']];
 else if(q.type==='choice')options=Object.entries(q.criteria).map(([k,v])=>[k,desc(v)]);
 else {instructions+=' Rate along the ordered levels below (lowest first).'; options=q.criteria.map((v,i)=>[String(i),desc(v)]);}
 return {instructions,options};
}
export function promptContent(state,instructions,options){
 const content=`State:\n${typeof state==='string'?state:JSON.stringify(state)}\n\nQuestion: ${instructions}\nOptions:\n`+
  options.map(([k,d],i)=>`[${LETTERS[i]}] ${k}: ${d}`).join('\n')+'\n\nAnswer with the letter of the best option only.';
 // Evidence must not inject tokenizer control markers into raw completion ids.
 fail(!CONTROL.test(content),'literal chat control markers are not accepted in input; escape or remove them','invalid_arguments');
 return content;
}
export function checkRenderedPrompt(response,content){
 fail(isRecord(response)&&typeof response.prompt==='string','/apply-template did not return a prompt');
 const prefix=`<|im_start|>user\n${content}<|im_end|>\n<|im_start|>assistant\n`;
 // Use the supplied Qwen template, not the Shisa/Gemma scaffold. Do not strip
 // arbitrary reasoning output or append an invented closing token to a bad prompt.
 fail(response.prompt===prefix+'<think>\n\n</think>\n\n'||response.prompt===prefix,
  'expected a single Qwen user turn followed by a non-thinking assistant boundary; use the OpenJev GGUF template and --jinja');
 return response.prompt;
}
export function typedAnswer(q,p,{noulTemperature=1.829074,noulBias=0}={}){
 if(q.type==='noul'){
  const yes=Math.max(1e-4,Math.min(1-1e-4,p[0]));
  const z=Math.log(yes/(1-yes))/noulTemperature+noulBias;
  return {type:'noul',noul:r4(1/(1+Math.exp(-z)))};
 }
 const keys=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));
 const probabilities=Object.fromEntries(keys.map((k,i)=>[k,r4(p[i])]));
 if(q.type==='choice')return {type:'choice',choice:keys[p.indexOf(Math.max(...p))],probabilities,confidence:r4(choiceConfidence(p))};
 return {type:'score',score:r4(p.reduce((s,v,i)=>s+i*v,0)),probabilities,
  legend:Object.fromEntries(keys.map((k,i)=>[k,q.criteria[i]])),confidence:r4(scoreConfidence(p))};
}

export function validateOpenJevRequest(body, maxQuestions=512) {
 validateRequest(body,maxQuestions);
 fail(!isRecord(body.state)||!['image','screenshot'].some(k=>typeof body.state[k]==='string'&&body.state[k].startsWith('data:image')),
  'this GGUF is text-only; screenshots are not supported','invalid_arguments');
 for(const q of Object.values(body.questions)){
  const {instructions,options}=questionParts(q);
  promptContent(body.state,instructions,options.slice(0,52));
  fail(!CONTROL.test(JSON.stringify(options)),'control markers in criteria','invalid_arguments');
 }
}

/** One logical request. The caller supplies bounded, authenticated HTTP I/O and
 * one deadline covering every tokenizer call and every decision readout.
 * No Node imports: this also runs in Claude's isolated function-hook runtime. */
export async function askOpenJevLlamaCpp(body,config,urls,send){
 validateOpenJevRequest(body);
 const maxPromptTokens=config.openjevMaxPromptTokens??8192;
 const maxReadouts=config.openjevMaxReadouts??1024;
 const temperature=config.openjevTemperature??.85;
 const noulTemperature=config.openjevNoulTemperature??1.829074;
 const noulBias=config.openjevNoulBias??0;
 for(const [key,value,min,max] of [['openjevMaxPromptTokens',maxPromptTokens,64,262144],['openjevMaxReadouts',maxReadouts,1,4096]])
  fail(Number.isSafeInteger(value)&&value>=min&&value<=max,`invalid ${key}`,'invalid_arguments');
 fail(Number.isFinite(temperature)&&temperature>=.01&&temperature<=100&&Number.isFinite(noulTemperature)&&noulTemperature>=.01&&noulTemperature<=100&&
  Number.isFinite(noulBias)&&Math.abs(noulBias)<=50,'invalid calibration parameters','invalid_arguments');
 let httpRequests=0;
 const originalSend=send;
 send=(...args)=>{httpRequests++;return originalSend(...args);};
 try{
   const models=await send(urls.models,'GET');
   fail(isRecord(models)&&Array.isArray(models.data)&&models.data.some(m=>m?.id===body.model),
    `llama-server does not advertise alias ${body.model}; start it with --alias ${body.model}`);
   const limit=Math.min(maxPromptTokens,llamaContextLimit(await send(urls.props,'GET')));
   const tokenize=async(text)=>llamaTokens(await send(urls.tokenize,'POST',{content:text,add_special:false,parse_special:true,with_pieces:false}));
   const letterCache=new Map();let readouts=0,recoveries=0,chunksUsed=false;
   const usage={input_tokens:0,output_tokens:0};
   const once=async(instructions,options)=>{
    const content=promptContent(body.state,instructions,options);
    const rendered=checkRenderedPrompt(await send(urls.applyTemplate,'POST',{
     model:body.model,messages:[{role:'user',content}],add_generation_prompt:true,
     chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'
    }),content);
    const tokens=await tokenize(rendered);
    fail(tokens.length+1<=limit,'prompt exceeds per-slot context; no input was truncated','context_budget');
    const letters=[],ids=[];
    // Check the actual prompt+label boundary, not just tokenizing A in isolation.
    for(let i=0;i<options.length;i++){
     let found=false;
     for(const prefix of ['', ' ']){
      const letter=prefix+LETTERS[i];
      if(!letterCache.has(letter))letterCache.set(letter,await tokenize(letter));
      const one=letterCache.get(letter);
      if(one.length!==1)continue;
      if(!same(await tokenize(rendered+letter),[...tokens,one[0]]))continue;
      letters.push(letter);ids.push(one[0]);found=true;break;
     }
     fail(found,'option letter is not a prefix-stable single token');
    }
    fail(new Set(ids).size===ids.length,'option token IDs are not unique');
    const params={prompt:tokens,n_predict:1,stream:false,temperature:1,samplers:['temperature'],
     top_k:0,top_p:1,min_p:0,typical_p:1,dynatemp_range:0,mirostat:0,
     repeat_penalty:1,repeat_last_n:0,presence_penalty:0,frequency_penalty:0,dry_multiplier:0,
     grammar:'',grammar_lazy:false,ignore_eos:false,stop:[],backend_sampling:false,
     cache_prompt:true,return_tokens:true,seed:0,post_sampling_probs:false,logit_bias:[],n_probs:64};
    const read=async(p)=>{
     fail(++readouts<=maxReadouts,'request exceeds readout budget','context_budget');
     const result=await send(urls.nativeCompletion,'POST',p);
     if(result.model!==undefined)fail(result.model===body.model,'completion model alias changed');
     const probs=llamaLetterLogprobs(result,tokens,letters,ids,p.post_sampling_probs);
     usage.input_tokens+=result.tokens_evaluated;usage.output_tokens+=result.tokens_predicted;
     return probs;
    };
    let logprobs=await read(params);
    if(logprobs.some(x=>x===null)){
     // A common bias cancels when probabilities are restricted to candidate IDs.
     // Receipt checks reject servers that silently ignore the neutral sampler.
     const recovered=await read({...params,post_sampling_probs:true,logit_bias:ids.map(id=>[id,LLAMA_OPTION_BIAS])});
     fail(recovered.every(x=>x!==null),'an option is still missing after equal-bias recovery');
     const anchor=logprobs.findIndex(x=>x!==null);
     if(anchor>=0)for(let i=0;i<logprobs.length;i++)if(logprobs[i]!==null)
      fail(Math.abs((logprobs[i]-logprobs[anchor])-(recovered[i]-recovered[anchor]))<=.001,'recovery changed known option logit differences');
     logprobs=recovered;recoveries++;
    }
    return restrictedSoftmax(logprobs,temperature);
   };
   const distribution=async(instructions,options)=>{
    if(options.length<=52)return once(instructions,options);
    chunksUsed=true;
    // Same hierarchical composition as the released helper, NOT a claim that
    // two stages equal a single 255-option model forward.
    const count=Math.ceil(options.length/52),size=Math.ceil(options.length/count),chunks=[],parts=[];
    for(let i=0;i<options.length;i+=size){
     const chunk=options.slice(i,i+size),p=await once(instructions,chunk);
     chunks.push(chunk);parts.push({p,w:p.indexOf(Math.max(...p))});
    }
    const final=await once(instructions,chunks.map((c,i)=>c[parts[i].w]));
    const raw=parts.flatMap(({p,w},i)=>p.map(v=>final[i]*v/p[w]));
    const sum=raw.reduce((a,b)=>a+b,0);fail(Number.isFinite(sum)&&sum>0,'invalid hierarchical probability mass');
    return raw.map(v=>v/sum);
   };
   const answers={};
   // Sequential questions give one bounded GPU load; a long suite cannot create
   // an unbounded pile of independent llama-server requests.
   for(const [id,q] of Object.entries(body.questions)){
    const {instructions,options}=questionParts(q),p=await distribution(instructions,options);
    Object.defineProperty(answers,id,{value:typedAnswer(q,p,{noulTemperature,noulBias}),enumerable:true});
   }
   const result={model:body.model,answers,usage,bridge:{transport:'openjev-llamacpp',prompt_source:'openjev-model-chat-template',http_requests:httpRequests,
    text_only:true,readout_requests:readouts,recovery_requests:recoveries,hierarchical_choices:chunksUsed,
    confidence_method:'openjev-reference-formulas',calibration:{temperature:temperature,noul_temperature:noulTemperature,noul_bias:noulBias},
    gguf_calibration_validated:false,context_limit:limit}};
   Object.defineProperty(result,RESPONSE_RULES,{value:{decimals:4,requireConfidence:true},configurable:true});requireAnswers(body.questions,result);return result;
 }catch(error){
  if(error?.message?.startsWith('shisa/llamacpp:'))throw new BridgeError(error.code,error.message.replace('shisa/llamacpp:','openjev/llamacpp:'));
  throw error;
 }
}
