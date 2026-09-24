/** Provider contract profiles; pure JavaScript so Claude's isolated hook can reuse them.
 * Profiles select validation; shisa also selects its native completion transport. They never change a URL, load a model, or enable remote access.
 */
import {invariant,isRecord} from './pure.mjs';
export const PROVIDERS=Object.freeze(['generic','jev','kev','laya','decider','shisa']);
export function responseRules(provider='generic'){
 invariant(PROVIDERS.includes(provider),'Unknown System One provider');
 // Jev examples use two decimal places, but do not guarantee a fixed precision.
 // Current Kev emits four decimals; legacy Kev used two. The Kev profile accepts
 // both via the conservative two-decimal rounding envelope. Laya uses four.
 if(provider==='decider')return {decimals:4,scoreDecimals:2,requireConfidence:true,confidenceIsMaxProbability:true};
 if(provider==='shisa')return {rounded:false,requireConfidence:true};
 return {decimals:provider==='laya'?4:2,requireConfidence:provider!=='generic'};
}
const content=v=>typeof v==='string'||Array.isArray(v)||isRecord(v);
export function validateProviderRequest(request,provider='generic'){
 responseRules(provider);
 if(['jev','laya','decider','shisa'].includes(provider))invariant(content(request.state),`${provider}: state must be a string, object or array`);
 if(provider==='decider'||provider==='shisa'){
  for(const q of Object.values(request.questions)){
   invariant(typeof q.instructions!=='string'||q.instructions.length>0,`${provider}: instructions must not be empty`);
   if(provider==='decider'){
    if(q.type==='choice')invariant(Object.keys(q.criteria).length>=2,'decider: Choice requires at least 2 options');
    if(q.type==='score')invariant(q.criteria.length<=10,'decider: Score supports at most 10 levels');
   }
   if(provider==='shisa'&&q.type!=='noul')invariant((q.type==='choice'?Object.keys(q.criteria).length:q.criteria.length)<=26,'shisa: at most 26 options; split/shortlist explicitly','unsupported_shape');
  }
 }
 if(provider!=='jev')return;
 for(const q of Object.values(request.questions)){
  invariant(content(q.instructions),'jev: instructions must be a string, object or array');
  if(q.type==='score'){
   invariant(q.criteria.length<=10,'jev: Score supports at most 10 levels');
   invariant(q.criteria.every(content),'jev: Score criteria must be strings, objects or arrays');
  }else if(q.criteria!=null){
   invariant(Object.values(q.criteria).every(v=>content(v)||(q.type==='choice'&&v===null)),`jev: invalid ${q.type} criterion`);
  }
 }
}
export function normalizeModels(response,provider='generic'){
 if(provider==='shisa'){
  invariant(isRecord(response)&&response.object==='list'&&Array.isArray(response.data),'Invalid vLLM /v1/models response','invalid_response');
  response={...response,models:response.data};
 }
 invariant(isRecord(response)&&Array.isArray(response.models)&&response.models.length>0,'Invalid /v1/models response','invalid_response');
 const models=response.models.map(entry=>{
  invariant(isRecord(entry),'Invalid model entry','invalid_response');
  const id=entry.id??entry.name;
  invariant(typeof id==='string'&&id.trim().length>0,'Missing model id/name','invalid_response');
  if(entry.id!==undefined&&entry.name!==undefined)invariant(entry.id===entry.name,'Conflicting model id/name','invalid_response');
  return {...entry,id};
 });
 invariant(new Set(models.map(x=>x.id)).size===models.length,'Duplicate model identifiers','invalid_response');
 return {...response,models};
}
