import {StringDecoder} from 'node:string_decoder';
import {isRecord,BridgeError} from './pure.mjs';
export const MCP_VERSIONS=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
/** NDJSON stdio MCP. Only JSON-RPC goes to stdout; stderr is diagnostics. */
export async function serveMcp(service,{input=process.stdin,output=process.stdout,maxLineBytes=4000000,maxPending=16}={}){
 let initialized=false,ready=false,buffer='',oversized=false,ended=false;const decoder=new StringDecoder('utf8'),pending=new Map(),tasks=new Set();
 let outputChain=Promise.resolve();
 const send=value=>{if(ended)return Promise.resolve();const wire=JSON.stringify(value)+'\n';outputChain=outputChain.then(()=>new Promise((resolve,reject)=>output.write(wire,error=>error?reject(error):resolve())));outputChain.catch(()=>{});return outputChain;};
 const dispatch=async message=>{
  const validId=x=>typeof x==='string'||typeof x==='number'&&Number.isFinite(x);
  const id=isRecord(message)&&Object.hasOwn(message,'id')?message.id:undefined;
  if(!isRecord(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||id!==undefined&&!validId(id)||message.params!==undefined&&!isRecord(message.params)){await send(rpcError(validId(id)?id:null,-32600,'Invalid Request'));return;}
  const {method,params={}}=message;
  if(id===undefined){
   if(method==='notifications/initialized'&&initialized)ready=true;
   if(method==='notifications/cancelled'&&validId(params.requestId))pending.get(params.requestId)?.abort(new BridgeError('cancelled','Request cancelled'));
   return;
  }
  if(method==='initialize'){
   if(initialized){await send(rpcError(id,-32600,'Already initialized'));return;}
   if(typeof params.protocolVersion!=='string'||!isRecord(params.capabilities)||!isRecord(params.clientInfo)){await send(rpcError(id,-32602,'Invalid initialization parameters'));return;}
   initialized=true;await send({jsonrpc:'2.0',id,result:{protocolVersion:MCP_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:MCP_VERSIONS[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'open-jev-bridge',version:'0.2.0'},instructions:'Provider-backed probabilistic judgments, not proof. Tools never execute commands. Use actual tests to establish completion.'}});return;
  }
  if(method==='ping'){await send({jsonrpc:'2.0',id,result:{}});return;}
  if(!ready){await send(rpcError(id,-32002,'MCP initialization is not complete'));return;}
  if(method==='tools/list'){
   if(params.cursor!==undefined){await send(rpcError(id,-32602,'No pagination cursor is supported'));return;}
   await send({jsonrpc:'2.0',id,result:{tools:service.list()}});return;
  }
  if(method!=='tools/call'){await send(rpcError(id,-32601,'Method not found'));return;}
  if(typeof params.name!=='string'||params.arguments!==undefined&&!isRecord(params.arguments)){await send(rpcError(id,-32602,'Invalid tool call parameters'));return;}
  if(pending.has(id)){await send(rpcError(id,-32600,'Duplicate in-flight request id'));return;}
  if(pending.size>=maxPending){await send(rpcError(id,-32000,'Too many in-flight tool requests'));return;}
  const controller=new AbortController();pending.set(id,controller);
  try{
   const result=await service.call(params.name,params.arguments??{},controller.signal);
   if(!controller.signal.aborted)await send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:isRecord(result)?result:{result},isError:false}});
  }catch(error){
   if(!controller.signal.aborted){const known=error instanceof BridgeError;const value={error:known?error.code:'internal_error',message:known?error.message:'The local operation failed; inspect local diagnostics',action:'review'};await send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value)}],isError:true}});}
  }finally{pending.delete(id);}
 };
 const line=text=>{if(!text.trim())return;let msg;try{msg=JSON.parse(text);}catch{void send(rpcError(null,-32700,'Parse error'));return;}const task=dispatch(msg).catch(()=>{});tasks.add(task);task.finally(()=>tasks.delete(task));};
 try{
  for await(const chunk of input){
   buffer+=typeof chunk==='string'?chunk:decoder.write(chunk);
   let at;
   while((at=buffer.indexOf('\n'))!==-1){const text=buffer.slice(0,at);buffer=buffer.slice(at+1);if(oversized||Buffer.byteLength(text)>maxLineBytes){oversized=false;void send(rpcError(null,-32600,'Message exceeds size limit'));}else line(text);}
   if(Buffer.byteLength(buffer)>maxLineBytes){oversized=true;buffer='';}
  }
  buffer+=decoder.end();if(buffer.trim()){if(oversized||Buffer.byteLength(buffer)>maxLineBytes)void send(rpcError(null,-32600,'Message exceeds size limit'));else line(buffer);}
  // A client that closes stdin terminates the session; cancel work, don't hang on inference.
  for(const c of pending.values())c.abort(new BridgeError('cancelled','MCP client disconnected'));
  await Promise.allSettled([...tasks]);await outputChain;
 }finally{ended=true;for(const c of pending.values())c.abort();}
}
