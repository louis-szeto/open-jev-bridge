// Pure JS adapter for Claude's OPTIONAL isolated function-hook API. No Node imports.
import {compact,compactOptions} from './compact.mjs';
import {invariant,utf8Bytes,isRecord} from './pure.mjs';
import {responseRules,validateProviderRequest} from './providers.mjs';
import {validateRequest,RESPONSE_RULES} from './schema.mjs';

export function functionEndpoint(value,allowRemote=false){
 const u=new URL(value);invariant(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash,'Invalid System One endpoint');
 if(u.hostname==='localhost')u.hostname='127.0.0.1';
 invariant(allowRemote||/^127(?:\.\d{1,3}){3}$/.test(u.hostname)||u.hostname==='[::1]','Non-loopback endpoint requires explicit allowRemote');
 let p=u.pathname.replace(/\/+$/,'');if(p.endsWith('/v1/systemone'))p=p.slice(0,-10);else if(!p.endsWith('/v1'))p+='/v1';return `${u.origin}${p}/systemone`;
}
export async function compactFunction(messages,options,fetchFn){
 const model=options.model??'kev-latest',url=functionEndpoint(options.url??'http://127.0.0.1:8009',options.allowRemote===true),c=compactOptions(options);
 const ask=async(state,questions)=>{
  const req={state,questions,model};validateRequest(req);validateProviderRequest(req,options.provider);const body=JSON.stringify(req);invariant(utf8Bytes(body)<=1000000,'Request too large');
  const headers={'content-type':'application/json'};if(options.apiKey){invariant(!/[\r\n]/.test(options.apiKey),'Invalid API key');headers.authorization=`Bearer ${options.apiKey}`;}
  const response=await fetchFn(url,{method:'POST',headers,body});
  invariant(response.ok&&response.status>=200&&response.status<300,'System One function-hook HTTP failure');
  invariant(typeof response.text==='string'&&utf8Bytes(response.text)<=2000000,'Invalid or oversized System One response');
  const json=JSON.parse(response.text);invariant(isRecord(json)&&isRecord(json.answers),'Missing answers');Object.defineProperty(json,RESPONSE_RULES,{value:responseRules(options.provider)});return json;
 };
 const result=await compact(messages,ask,c);return result;
}
export const register=(on,options={})=>{
 let compacting=false;
 on('session.compact',async($,event,next)=>{
  try{
   const env=async name=>await $.env.get(name);if(options.autoCompaction===false||['false','0'].includes(await env('SYSTEM_ONE_AUTO_COMPACTION')))return next(event);const resolved={...options,provider:options.provider||await env('SYSTEM_ONE_PROVIDER')||'generic',url:options.url||await env('SYSTEM_ONE_URL')||'http://127.0.0.1:8009',model:options.model||await env('SYSTEM_ONE_MODEL')||'kev-latest',apiKey:options.apiKey||await env('SYSTEM_ONE_API_KEY'),allowRemote:options.allowRemote===true||['true','1'].includes(await env('SYSTEM_ONE_ALLOW_REMOTE'))};
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
