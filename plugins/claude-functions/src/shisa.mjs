/** Shisa DE-1's restricted-letter readout, NOT a generated-text/JSON adapter.
 * Pure JavaScript; shared verbatim by MCP and Claude isolated function hooks.
 * Sources and contract scope: docs/LOCAL_MODELS.md. No remote tokenizer/model downloads.
 */
import {invariant,isRecord,own} from './pure.mjs';

export const SHISA_SYSTEM = 'Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning.';
export const SHISA_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const text = v => typeof v==='string'?v:JSON.stringify(v);
const failure = (ok,message) => invariant(ok,`shisa: ${message}`,'invalid_response');
const same = (a,b) => a.length===b.length&&a.every((v,i)=>v===b[i]);

/** The text-only, one-system/one-user subset of the checkpoint's published chat template.
 * Its output is checked against the SERVED tokenizer's actual chat template on every question.
 * JSON escaping of < and > prevents evidence from spelling control tokens, without changing
 * the decoded JSON values. Question ids remain outside the prompt, as in System One.
 */
export function shisaScaffold(state, question) {
  let keys, descriptions;
  if(question.type==='noul') {
    keys=['true','false'];
    descriptions=keys.map((k,i)=>{
      const v=question.criteria?.[k], label=i===0?'Yes':'No';
      return v===undefined||v===null||v===''?label:`${label}: ${text(v)}`;
    });
  } else if(question.type==='choice') {
    keys=Object.keys(question.criteria);
    descriptions=keys.map(k=>{
      const v=question.criteria[k];return v===null||v===''?k:`${k}: ${text(v)}`;
    });
  } else {
    keys=question.criteria.map((_,i)=>String(i));
    descriptions=question.criteria.map((v,i)=>`${i}: ${text(v)}`);
  }
  invariant(keys.length>=1&&keys.length<=26,'shisa: the documented readout supports at most 26 options; split/shortlist explicitly','unsupported_shape');
  const letters=keys.map((_,i)=>SHISA_LETTERS[i]);
  const payload={evidence:state,criterion:question.instructions,
    options:descriptions.map((description,i)=>({letter:letters[i],description}))};
  const content=JSON.stringify(payload).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
  const messages=[{role:'system',content:SHISA_SYSTEM},{role:'user',content}];
  const prompt=`<bos><|turn>system\n${SHISA_SYSTEM}<turn|>\n<|turn>user\n${content}<turn|>\n<|turn>model\n<|channel>thought\n<channel|>`;
  return {keys,letters,messages,prompt};
}

export function tokenization(response) {
  failure(isRecord(response)&&Array.isArray(response.tokens)&&response.tokens.length>0,'missing tokenizer tokens (vLLM mode). For llama-server set SYSTEM_ONE_SHISA_BACKEND=llamacpp; it requires content, not prompt/messages');
  failure(response.tokens.every(x=>Number.isSafeInteger(x)&&x>=0),'invalid token ids');
  failure(response.count===response.tokens.length,'tokenizer count mismatch');
  failure(Number.isSafeInteger(response.max_model_len)&&response.max_model_len>0,'missing tokenizer context limit');
  return response;
}
function completion(response) {
  failure(isRecord(response)&&typeof response.model==='string'&&response.model.length>0,'missing completion model');
  failure(Array.isArray(response.choices)&&response.choices.length===1&&isRecord(response.choices[0]),'expected exactly one completion choice');
  failure(response.choices[0].index===0,'unexpected completion index');
  const usage=response.usage;
  failure(isRecord(usage)&&['prompt_tokens','completion_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0),'missing/invalid completion usage');
  failure(usage.completion_tokens<=1,'server generated more than the requested one token');
  return response.choices[0];
}
const validLogprob = x=>typeof x==='number'&&Number.isFinite(x)&&x<=1e-8;
export function topLetterLogprobs(response, letters, tokenIds) {
  const c=completion(response), rows=c.logprobs?.top_logprobs;
  failure(Array.isArray(rows)&&rows.length===1&&isRecord(rows[0]),'missing first-token top_logprobs');
  const row=rows[0];
  failure(Object.values(row).every(validLogprob),'invalid top-token logprob');
  return letters.map((letter,i)=>{
    const id=`token_id:${tokenIds[i]}`;
    if(own(row,letter)&&own(row,id)) failure(Math.abs(row[letter]-row[id])<=1e-9,'conflicting text/token-id logprobs');
    return own(row,id)?row[id]:own(row,letter)?row[letter]:null;
  });
}
export function fallbackLetterLogprob(response, expectedTokens, letter) {
  const c=completion(response), rows=c.prompt_logprobs, ids=c.prompt_token_ids;
  failure(Array.isArray(ids)&&same(ids,expectedTokens),'fallback prompt token ids changed');
  failure(Array.isArray(rows)&&rows.length===expectedTokens.length,'missing or truncated prompt_logprobs');
  const row=rows.at(-1), id=String(expectedTokens.at(-1));
  failure(isRecord(row)&&own(row,id)&&isRecord(row[id]),'missing appended-letter logprob');
  const answer=row[id];
  failure(validLogprob(answer.logprob),'invalid appended-letter logprob');
  if(answer.decoded_token!=null) failure(answer.decoded_token===letter,'appended token is not the requested letter');
  return answer.logprob;
}
export function restrictedSoftmax(logprobs, temperature=1) {
  failure(logprobs.length>0&&logprobs.every(validLogprob),'missing/invalid option logprobs');
  invariant(Number.isFinite(temperature)&&temperature>=.01&&temperature<=100,'Invalid Shisa readout temperature');
  const max=Math.max(...logprobs), weights=logprobs.map(v=>Math.exp((v-max)/temperature)), sum=weights.reduce((a,b)=>a+b,0);
  failure(Number.isFinite(sum)&&sum>0,'invalid restricted probability normalization');
  return weights.map(v=>v/sum);
}
export function shisaAnswer(question, keys, probabilities) {
  const best=probabilities.indexOf(Math.max(...probabilities));
  if(question.type==='noul') return {type:'noul',noul:probabilities[0]}; // A=Yes; never the No row.
  const dist=Object.fromEntries(keys.map((k,i)=>[k,probabilities[i]]));
  const common={type:question.type,probabilities:dist,confidence:probabilities[best]};
  if(question.type==='choice') return {...common,choice:keys[best]};
  return {...common,score:probabilities.reduce((n,p,i)=>n+i*p,0),
    legend:Object.fromEntries(question.criteria.map((v,i)=>[String(i),v]))};
}

/** Bounded scheduling. Stop admitting work after the first failure; return no partial result. */
export async function mapBounded(items, limit, fn) {
  const result=new Array(items.length);let next=0,failed=false;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failed&&next<items.length){const i=next++;try{result[i]=await fn(items[i]);}catch(e){failed=true;throw e;}}
  }));
  return result;
}

/** send(url, method, body) must enforce a SHARED deadline, cancellation and byte limits.
 * Never consult choices[0].text. A missing option is recovered by a forced prompt read,
 * not assigned zero probability and not inferred from the sampled token.
 */
export async function askShisa(request, config, urls, send) {
  const lettersCache=new Map();
  const usage={input_tokens:0,output_tokens:0};let httpRequests=0,readouts=0,fallbacks=0;
  let failed=false;
  const post=async(url,body)=>{invariant(!failed,'Shisa request already failed','cancelled');httpRequests++;return send(url,'POST',body);};
  const token=async body=>tokenization(await post(urls.tokenize,{model:request.model,...body}));
  const letterToken=letter=>{
    if(!lettersCache.has(letter)) lettersCache.set(letter,token({prompt:letter,add_special_tokens:false}).then(r=>{
      failure(r.tokens.length===1,'option letter must be exactly one token');return r.tokens[0];
    }));
    return lettersCache.get(letter);
  };
  const count=r=>{completion(r);usage.input_tokens+=r.usage.prompt_tokens;usage.output_tokens+=r.usage.completion_tokens;};
  const params={model:request.model,max_tokens:1,temperature:0,stream:false,n:1,
    add_special_tokens:false,return_tokens_as_token_ids:true};
  try {
    const entries=await mapBounded(Object.entries(request.questions),config.maxConcurrent??2,async([qid,q])=>{
      const s=shisaScaffold(request.state,q);
      const actual=await token({messages:s.messages,add_generation_prompt:true,add_special_tokens:false,
        chat_template_kwargs:{enable_thinking:false}});
      const rendered=await token({prompt:s.prompt,add_special_tokens:false});
      failure(same(actual.tokens,rendered.tokens),'served chat template differs from the documented Shisa scaffold');
      const limit=Math.min(actual.max_model_len,rendered.max_model_len,config.shisaMaxPromptTokens??32768);
      invariant(actual.tokens.length+2<=limit,'shisa: prompt exceeds context budget (including fallback reserve); nothing was truncated','context_budget');
      const ids=[];
      for(const letter of s.letters){
        const id=await letterToken(letter), appended=await token({prompt:s.prompt+letter,add_special_tokens:false});
        failure(same(appended.tokens,[...actual.tokens,id]),'prompt + letter is not prefix-stable single-token encoding');
        ids.push(id);
      }
      failure(new Set(ids).size===ids.length,'option letters have duplicate token ids');
      const response=await post(urls.completions,{...params,prompt:actual.tokens,logprobs:config.shisaTopLogprobs??20});
      count(response);readouts++;
      const lp=topLetterLogprobs(response,s.letters,ids);
      for(let i=0;i<lp.length;i++) if(lp[i]===null){
        const expected=[...actual.tokens,ids[i]];
        const r=await post(urls.completions,{...params,prompt:expected,logprobs:0,prompt_logprobs:0,return_token_ids:true});
        count(r);readouts++;fallbacks++;
        lp[i]=fallbackLetterLogprob(r,expected,s.letters[i]);
      }
      const t=q.type==='noul'?(config.shisaNoulTemperature??1):q.type==='choice'?(config.shisaChoiceTemperature??1):(config.shisaScoreTemperature??1);
      return [qid,shisaAnswer(q,s.keys,restrictedSoftmax(lp,t))];
    });
    return {model:request.model,answers:Object.fromEntries(entries),usage,
      bridge:{transport:'shisa-vllm-restricted-letters',http_requests:httpRequests,readout_requests:readouts,
        fallback_requests:fallbacks,confidence_method:'maximum_restricted_probability',
        score_method:'expected_zero_based_level',temperatures:{noul:config.shisaNoulTemperature??1,
          choice:config.shisaChoiceTemperature??1,score:config.shisaScoreTemperature??1}}};
  } catch(e){failed=true;throw e;}
}
