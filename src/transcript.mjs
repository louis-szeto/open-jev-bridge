import {isRecord,invariant} from './pure.mjs';
const contentText=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(x=>['text','input_text','output_text'].includes(x?.type)).map(x=>x.text??'').join('\n'):'';
const parseJSON=x=>{try{return typeof x==='string'?JSON.parse(x):x;}catch{return null;}};
function resultText(value){if(typeof value==='string')return value;if(Array.isArray(value))return value.filter(x=>x?.type==='text').map(x=>x.text??'').join('\n');return JSON.stringify(value??'');}
function exitCode(value){
 const x=isRecord(value)?value:parseJSON(value);if(isRecord(x)){for(const v of [x.exit_code,x.exitCode,x.metadata?.exit_code])if(Number.isInteger(v))return v;}
 const m=typeof value==='string'?/Process exited with code (-?\d+)/.exec(value):null;return m?Number(m[1]):undefined;
}
/** Convert common Claude JSONL / Codex rollout records to the explicit canonical model.
 * Unknown opaque content is pinned for compaction, never silently rewritten.
 * Host transcript formats are not stable APIs; unsupported formats fail open in hooks.
 */
export function normalizeTranscript(records){
 invariant(Array.isArray(records),'Transcript must be an array');const messages=[];let ignored=0;
 for(const record of records){
  if(!isRecord(record)){ignored++;continue;}
  if(typeof record.role==='string'&&typeof record.text==='string'&&Array.isArray(record.toolUses)){messages.push(record);continue;}
  const p=record.type==='response_item'?record.payload:record;
  if(!isRecord(p)){ignored++;continue;}
  if(p.type==='function_call'||p.type==='custom_tool_call'){
   const input=p.type==='custom_tool_call'?{patch:p.input}:parseJSON(p.arguments);
   messages.push({role:'assistant',text:'',toolUses:[{tool_use_id:p.call_id??p.id,tool:p.name,input:isRecord(input)?input:{raw:p.arguments??p.input??''}}]});continue;
  }
  if(p.type==='function_call_output'||p.type==='custom_tool_call_output'){
   const output=p.output??'',parsed=parseJSON(output),text=isRecord(parsed)&&typeof parsed.output==='string'?parsed.output:resultText(output),code=exitCode(output);
   messages.push({role:'user',text:'',toolUses:[],toolResults:[{tool_use_id:p.call_id??p.id,text,...(code===undefined?{}:{exitCode:code}),isError:code!==undefined&&code!==0||p.is_error===true}]});continue;
  }
  const m=isRecord(p.message)?p.message:p;
  if(['user','assistant','system','developer'].includes(m.role??p.type)&&('content' in m)){
   const role=m.role??p.type,blocks=Array.isArray(m.content)?m.content:[],uses=[],results=[];
   for(const b of blocks){
    if(b?.type==='tool_use')uses.push({tool_use_id:b.id,tool:b.name,input:b.input??{}});
    if(b?.type==='tool_result'){const text=resultText(b.content),code=exitCode(b);results.push({tool_use_id:b.tool_use_id,text,isError:b.is_error===true,...(code===undefined?{}:{exitCode:code})});}
   }
   const opaque=blocks.some(b=>!['text','input_text','output_text','tool_use','tool_result'].includes(b?.type));
   messages.push({role,text:contentText(m.content),toolUses:uses,...(results.length?{toolResults:results}:{}),...(opaque?{opaque:true}:{}),...(typeof m.id==='string'?{id:m.id}:{})});continue;
  }
  ignored++;
 }
 return {messages,ignored};
}
export function parseTranscriptJSONL(text,{truncated=false}={}){
 const lines=text.split(/\r?\n/),records=[];let invalid=0;if(truncated)lines.shift();
 for(const line of lines){if(!line.trim())continue;try{records.push(JSON.parse(line));}catch{invalid++;}}
 const result=normalizeTranscript(records);return {...result,invalid,truncated};
}
