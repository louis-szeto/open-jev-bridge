/** llama.cpp transport for Shisa's restricted-letter readout.
 * No Node dependencies: the same module runs in the Claude function-hook bundle.
 * Native protocol and equal-bias recovery derivation: docs/LLAMACPP.md.
 */
import {invariant,isRecord,own} from './pure.mjs';
import {shisaScaffold,restrictedSoftmax,shisaAnswer,mapBounded} from './shisa.mjs';

const fail=(ok,message)=>invariant(ok,`shisa/llamacpp: ${message}`,'invalid_response');
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
export const LLAMA_OPTION_BIAS=80;

// These are the literal control markers in Shisa's published text-only scaffold,
// not token IDs assumed from a particular GGUF. Resolve them on the served tokenizer.
export const SHISA_CONTROL_MARKERS=Object.freeze([
 '<bos>','<|turn>','<turn|>','<|channel>','<channel|>',
]);

/** Refuse a GGUF tokenizer which renders the scaffold controls as ordinary text,
 * inserts extra BOS/EOS, or changes their order/answer boundary. The JSON evidence
 * escapes angle brackets, so none of these control IDs may originate in user data.
 */
export function validateLlamaScaffold(tokens,controlIds){
 fail(Array.isArray(controlIds)&&controlIds.length===SHISA_CONTROL_MARKERS.length&&
  controlIds.every(id=>Number.isSafeInteger(id)&&id>=0)&&new Set(controlIds).size===controlIds.length,
  'scaffold control markers must have distinct single-token encodings');
 fail(Array.isArray(tokens)&&tokens.length>0&&tokens.every(id=>Number.isSafeInteger(id)&&id>=0),
  'invalid scaffold token ids');
 const [bos,turn,endTurn,channel,endChannel]=controlIds,controls=new Set(controlIds);
 const expected=[bos,turn,endTurn,turn,endTurn,turn,channel,endChannel];
 fail(tokens[0]===bos&&tokens.at(-1)===endChannel&&same(tokens.filter(id=>controls.has(id)),expected),
  'GGUF tokenizer changed Shisa control-token order or answer boundary; use a compatible Shisa/Gemma 4 tokenizer');
 return tokens;
}

/** llama.cpp intentionally does NOT return vLLM's count/max_model_len fields. */
export function llamaTokens(response){
 fail(isRecord(response)&&Array.isArray(response.tokens)&&response.tokens.length>0,
  'missing native tokenizer tokens; /tokenize must accept content, add_special and parse_special');
 fail(response.tokens.every(x=>Number.isSafeInteger(x)&&x>=0),'invalid native tokenizer token ids');
 if(own(response,'count'))fail(response.count===response.tokens.length,'tokenizer count mismatch');
 return response.tokens;
}
export function llamaContextLimit(response){
 fail(isRecord(response),'missing /props response');
 const n=response.default_generation_settings?.n_ctx;
 fail(Number.isSafeInteger(n)&&n>0,'missing per-slot context limit at /props default_generation_settings.n_ctx');
 return n;
}

/** Validate the native response before treating it as evidence. Never read content. */
export function llamaCompletion(response,promptTokens,postSampling=false,optionIds=[]){
 fail(isRecord(response),'missing completion object');
 fail(response.truncated===false,'server truncated the prompt; increase context or reduce the request');
 fail(response.tokens_evaluated===promptTokens.length,'server changed the prompt token count');
 fail(response.tokens_predicted===1,'expected exactly one predicted token');
 fail(response.stop===true,'expected a finished, non-streaming completion');
 const g=response.generation_settings;
 fail(isRecord(g)&&g.post_sampling_probs===postSampling,'server did not confirm requested probability mode');
 if(postSampling){
  // These receipts guard against ignored/overridden request parameters. A normalized
  // distribution alone cannot show that top-p or a penalty did not alter the logits.
  fail(g.temperature===1&&g.dynatemp_range===0&&g.mirostat===0&&g.grammar===''&&
   g.backend_sampling===false&&Array.isArray(g.samplers)&&same(g.samplers,['temperature']),
   'server did not honor neutral recovery sampling settings');
  const bias=g.logit_bias;
  fail(Array.isArray(bias)&&bias.length===optionIds.length&&
   bias.every(x=>isRecord(x)&&optionIds.includes(x.token)&&x.bias===LLAMA_OPTION_BIAS)&&
   new Set(bias.map(x=>x.token)).size===optionIds.length,
   'server did not honor equal option-token biases');
 }
 // The native response key is completion_probabilities. Some documented examples
 // spell it probs; accept either, but never disagreeing parallel envelopes.
 const rows=response.completion_probabilities??response.probs;
 if(own(response,'completion_probabilities')&&own(response,'probs'))
  fail(JSON.stringify(response.completion_probabilities)===JSON.stringify(response.probs),'conflicting probability envelopes');
 fail(Array.isArray(rows)&&rows.length===1&&isRecord(rows[0]),'missing native first-token probabilities; use a current llama-server');
 return rows[0];
}

export function llamaLetterLogprobs(response,promptTokens,letters,ids,postSampling=false){
 const row=llamaCompletion(response,promptTokens,postSampling,ids);
 const field=postSampling?'top_probs':'top_logprobs';
 const entries=row[field];
 fail(Array.isArray(entries)&&entries.length>0,`missing ${field}; vLLM and llama.cpp response formats are not interchangeable`);
 const values=new Map();
 for(const e of entries){
  fail(isRecord(e)&&Number.isSafeInteger(e.id)&&e.id>=0,'invalid top-probability token id');
  fail(!values.has(e.id),'duplicate top-probability token id');
  const v=postSampling?e.prob:e.logprob;
  fail(typeof v==='number'&&Number.isFinite(v)&&
   (postSampling?v>=0&&v<=1:v<=1e-8),'invalid option probability/logprob');
  values.set(e.id,e);
 }
 return ids.map((id,i)=>{
  const e=values.get(id);if(!e)return null;
  if(e.token!==undefined)fail(e.token===letters[i],'token id and option-letter text disagree');
  if(postSampling){
   // A float-underflow zero is not an observed finite option logit. Fail explicitly.
   fail(e.prob>0,'option probability underflowed to zero during recovery');
   return Math.log(e.prob);
  }
  // llama.cpp serializes log(0) as lowest_float, rather than JSON null. Retry with
  // the common option boost instead of silently inventing an exact zero probability.
  return e.logprob < -1e30?null:e.logprob;
 });
}

/** send enforces the logical request's shared deadline/cancellation and byte bounds. */
export async function askShisaLlamaCpp(request,config,urls,send){
 let httpRequests=0,readouts=0,recoveries=0,failed=false;
 const usage={input_tokens:0,output_tokens:0};
 const call=async(url,method,payload)=>{invariant(!failed,'Shisa request already failed','cancelled');httpRequests++;return send(url,method,payload);};
 const post=(url,body)=>call(url,'POST',body);
 const tokenize=async content=>llamaTokens(await post(urls.tokenize,
  {content,add_special:false,parse_special:true,with_pieces:false}));
 const cache=new Map();
 const letterToken=letter=>{
  if(!cache.has(letter))cache.set(letter,tokenize(letter).then(ids=>{
   fail(ids.length===1,'option letter must be exactly one token');return ids[0];
  }));return cache.get(letter);
 };
 try{
  const contextLimit=llamaContextLimit(await call(urls.props,'GET'));
  const controlIds=[];
  // Once per logical request, not per question. Sequential discovery also respects
  // maxConcurrent=1 and the shared HTTP/cancellation budget in isolated hooks.
  for(const marker of SHISA_CONTROL_MARKERS){
   const ids=await tokenize(marker);
   fail(ids.length===1,`GGUF tokenizer does not encode ${marker} as one control token; use a compatible Shisa/Gemma 4 tokenizer`);
   controlIds.push(ids[0]);
  }
  fail(new Set(controlIds).size===controlIds.length,'scaffold control markers share token ids');
  const entries=await mapBounded(Object.entries(request.questions),config.maxConcurrent??2,async([qid,q])=>{
   const s=shisaScaffold(request.state,q);
   // /completion accepts numeric token IDs and does not run a chat renderer.
   // Supply the published Shisa scaffold ourselves instead of comparing it with
   // /apply-template (whose Gemma/thinking defaults can legitimately differ).
   // This never adopts the server's alternate prompt and is not a skip-validation
   // switch: control markers, boundary, letters and inference receipts stay checked.
   const actual=validateLlamaScaffold(await tokenize(s.prompt),controlIds);
   const limit=Math.min(contextLimit,config.shisaMaxPromptTokens??32768);
   invariant(actual.length+1<=limit,'shisa/llamacpp: prompt exceeds per-slot context budget; nothing was truncated','context_budget');
   const ids=[];
   for(const letter of s.letters){
    const id=await letterToken(letter),appended=await tokenize(s.prompt+letter);
    fail(same(appended,[...actual,id]),'prompt + letter is not prefix-stable single-token encoding');ids.push(id);
   }
   fail(new Set(ids).size===ids.length,'option letters have duplicate token ids');
   fail(ids.every(id=>!controlIds.includes(id)),'option letter collides with a scaffold control token');
   const params={prompt:actual,n_predict:1,stream:false,temperature:1,samplers:['temperature'],
    top_k:0,top_p:1,min_p:0,typical_p:1,dynatemp_range:0,mirostat:0,
    repeat_penalty:1,repeat_last_n:0,presence_penalty:0,frequency_penalty:0,dry_multiplier:0,
    grammar:'',grammar_lazy:false,ignore_eos:false,stop:[],backend_sampling:false,
    cache_prompt:false,return_tokens:true,seed:0,post_sampling_probs:false,logit_bias:[],
    n_probs:Math.max(s.letters.length,config.shisaTopLogprobs??20)};
   const read=async p=>{const r=await post(urls.nativeCompletion,p);readouts++;
    llamaCompletion(r,actual,p.post_sampling_probs,ids);
    usage.input_tokens+=r.tokens_evaluated;usage.output_tokens+=r.tokens_predicted;return r;};
   const response=await read(params);
   let lp=llamaLetterLogprobs(response,actual,s.letters,ids);
   if(lp.some(v=>v===null)){
    // llama.cpp has no vLLM forced-prompt-logprobs contract. Add the SAME bias to
    // every option, disable all truncating/penalty samplers, and read post-sampling
    // probabilities. Normalizing over options cancels both that bias and Z.
    // No sampled token is used; no missing option is ever assigned probability zero.
    const r=await read({...params,post_sampling_probs:true,logit_bias:ids.map(id=>[id,LLAMA_OPTION_BIAS])});recoveries++;
    const recovered=llamaLetterLogprobs(r,actual,s.letters,ids,true);
    fail(recovered.every(v=>v!==null),'server still omitted an option after equal-bias recovery; no judgment returned');
    const anchor=lp.findIndex(v=>v!==null);
    if(anchor>=0)for(let i=0;i<lp.length;i++)if(lp[i]!==null)
     fail(Math.abs((lp[i]-lp[anchor])-(recovered[i]-recovered[anchor]))<=.001,
      'recovery changed observed option logit differences');
    lp=recovered; // Never mix logprobs with different normalizing constants.
   }
   const temperature=q.type==='noul'?(config.shisaNoulTemperature??1):q.type==='choice'?
    (config.shisaChoiceTemperature??1):(config.shisaScoreTemperature??1);
   return [qid,shisaAnswer(q,s.keys,restrictedSoftmax(lp,temperature))];
  });
  return {model:request.model,answers:Object.fromEntries(entries),usage,bridge:{
   transport:'shisa-llamacpp-restricted-letters',prompt_source:'documented-shisa-scaffold',
   control_tokens_validated:true,http_requests:httpRequests,readout_requests:readouts,
   fallback_requests:recoveries,recovery_method:'equal-option-bias-cancelled-by-restriction',
   confidence_method:'maximum_restricted_probability',score_method:'expected_zero_based_level',
   context_limit:contextLimit,temperatures:{noul:config.shisaNoulTemperature??1,
    choice:config.shisaChoiceTemperature??1,score:config.shisaScoreTemperature??1}}};
 }catch(e){failed=true;throw e;}
}
