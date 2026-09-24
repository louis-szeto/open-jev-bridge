// Pure JS adapter for Claude's OPTIONAL isolated function-hook API. No Node imports.
import {compact,compactOptions} from './compact.mjs';
import {invariant,utf8Bytes,isRecord} from './pure.mjs';
import {responseRules,validateProviderRequest} from './providers.mjs';
import {validateRequest,RESPONSE_RULES} from './schema.mjs';
import {serviceEndpoints} from './endpoints.mjs';
import {askShisa} from './shisa.mjs';

export function functionEndpoint(value,allowRemote=false,provider='generic'){
 return serviceEndpoints(value,allowRemote,provider).systemOne;
}
export async function compactFunction(messages,options,fetchFn){
 const model=options.model??'kev-latest',provider=options.provider??'generic';
 const urls=serviceEndpoints(options.url??'http://127.0.0.1:8009',options.allowRemote===true,provider),c=compactOptions(options);
 const budget=options.timeoutMs??20000;
 invariant(Number.isFinite(budget)&&budget>=1&&budget<=20000,'Invalid function-hook deadline');
 const deadline=Date.now()+budget;
 const headers={'content-type':'application/json'};
 if(options.apiKey){invariant(!/[\r\n]/.test(options.apiKey),'Invalid API key');headers.authorization=`Bearer ${options.apiKey}`;}
 const send=async(url,method,payload)=>{
  const remaining=deadline-Date.now();invariant(remaining>0,'Function-hook deadline exceeded','timeout');
  const body=JSON.stringify(payload);invariant(utf8Bytes(body)<=1000000,'Request too large');
  // Only the inspected engine HTTP fields are used. The host owns in-flight I/O
  // cancellation; this elapsed deadline prevents subsequent requests and late commits.
  const response=await fetchFn(url,{method,headers,body});
  invariant(Date.now()<=deadline,'Function-hook deadline exceeded','timeout');
  invariant(response.ok&&response.status>=200&&response.status<300,'System One function-hook HTTP failure');
  invariant(typeof response.text==='string'&&utf8Bytes(response.text)<=2000000,'Invalid or oversized System One response');
  return JSON.parse(response.text);
 };
 const ask=async(state,questions)=>{
  const req={state,questions,model};validateRequest(req);validateProviderRequest(req,provider);
  const json=provider==='shisa'?await askShisa(req,{...options,maxConcurrent:1},urls,send):await send(urls.systemOne,'POST',req);
  invariant(isRecord(json)&&isRecord(json.answers)&&typeof json.model==='string'&&json.model.length>0,'Missing answers');
  Object.defineProperty(json,RESPONSE_RULES,{value:responseRules(provider)});return json;
 };
 return compact(messages,ask,c);
}
export const register=(on,options={})=>{
 let compacting=false;
 on('session.compact',async($,event,next)=>{
  try{
   const env=async name=>await $.env.get(name);if(options.autoCompaction===false||['false','0'].includes(await env('SYSTEM_ONE_AUTO_COMPACTION')))return next(event);const resolved={...options,provider:options.provider||await env('SYSTEM_ONE_PROVIDER')||'generic',url:options.url||await env('SYSTEM_ONE_URL')||'http://127.0.0.1:8009',model:options.model||await env('SYSTEM_ONE_MODEL')||'kev-latest',apiKey:options.apiKey||await env('SYSTEM_ONE_API_KEY'),allowRemote:options.allowRemote===true||['true','1'].includes(await env('SYSTEM_ONE_ALLOW_REMOTE'))};
   for(const [key,name] of [['timeoutMs','SYSTEM_ONE_TIMEOUT_MS'],['shisaTopLogprobs','SYSTEM_ONE_SHISA_TOP_LOGPROBS'],['shisaMaxPromptTokens','SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS'],['shisaNoulTemperature','SYSTEM_ONE_SHISA_NOUL_TEMPERATURE'],['shisaChoiceTemperature','SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE'],['shisaScoreTemperature','SYSTEM_ONE_SHISA_SCORE_TEMPERATURE']]){const v=options[key]??await env(name);if(v!==undefined){resolved[key]=Number(v);invariant(Number.isFinite(resolved[key]),`Invalid ${name}`);}}
   const result=await compactFunction(event.messages,resolved,(u,i)=>$.http.fetch(u,i));
   if(result.stats.reductionRatio<(options.minReductionRatio??.25)){ $.ui.log('open-jev-bridge: insufficient reduction; using built-in compaction');return next(event);}
   $.ui.log(`open-jev-bridge: verbatim compaction, ${Math.round(result.stats.reductionRatio*100)}% estimated character reduction`);
   return {messages:result.messages};
  }catch{ $.ui.log('open-jev-bridge: configured compaction unavailable; using built-in compaction');return next(event);}
 });
 on('turn.complete',async($,event,next)=>{
  if(compacting)return next(event);
  compacting=true;
  try{
   const env=async name=>$.env?.get?await $.env.get(name):undefined;
   if(options.autoCompaction===false||['false','0'].includes(await env('SYSTEM_ONE_AUTO_COMPACTION')))return next(event);
   const percent=options.compactAtPercent??Number(await env('SYSTEM_ONE_COMPACT_AT_PERCENT')??60);
   invariant(Number.isFinite(percent)&&percent>=10&&percent<=95,'Invalid auto-compaction threshold');
   const {context}=await $.session.usage();if(Number.isFinite(context.percent)&&context.percent>=percent)await $.session.compact();
  }
  catch{$.ui.log('open-jev-bridge: automatic compaction skipped');}
  finally{compacting=false;}
  return next(event);
 });
};
