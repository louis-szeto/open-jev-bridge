#!/usr/bin/env node
/** Optional local System One HTTP sidecar. The main bridge can also connect to
 * llama-server directly with SYSTEM_ONE_PROVIDER=openjev; no sidecar is required.
 * Readout implementation is shared with the MCP client and Claude function bundle. */
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {SystemOneClient,Semaphore} from '../src/client.mjs';
import {invariant,BridgeError} from '../src/pure.mjs';
import {validateOpenJevRequest} from '../src/openjev-llamacpp.mjs';
export {LETTERS,promptContent,questionParts,checkRenderedPrompt,typedAnswer,choiceConfidence,scoreConfidence} from '../src/openjev-llamacpp.mjs';
const fail=(ok,message,code='invalid_response')=>invariant(ok,`openjev/llamacpp: ${message}`,code);

export class OpenJevLlamaAdapter{
 constructor({url='http://127.0.0.1:8014',model='openjev',apiKey='',maxPromptTokens=8192,
  timeoutMs=120000,temperature=.85,noulTemperature=1.829074,noulBias=0,maxQuestions=512,
  maxConcurrent=1,maxQueue=8,maxReadouts=1024}={}){
  for(const [key,value,min,max] of [['maxQuestions',maxQuestions,1,512],['maxConcurrent',maxConcurrent,1,4],['maxQueue',maxQueue,0,64]])
   fail(Number.isSafeInteger(value)&&value>=min&&value<=max,`invalid ${key}`,'invalid_arguments');
  this.client=new SystemOneClient({url,model,provider:'openjev',apiKey,timeoutMs,retries:0,maxConcurrent:1,
   openjevMaxPromptTokens:maxPromptTokens,openjevMaxReadouts:maxReadouts,
   openjevTemperature:temperature,openjevNoulTemperature:noulTemperature,openjevNoulBias:noulBias});
  this.model=model;this.timeoutMs=timeoutMs;this.maxQuestions=maxQuestions;
  this.semaphore=new Semaphore(maxConcurrent,maxQueue);
 }
 async ask(request,{signal}={}){
  const body={...request,model:request?.model??this.model};
  validateOpenJevRequest(body,this.maxQuestions);
  fail(body.model===this.model,'unknown model alias','invalid_arguments');
  const control=new AbortController();
  const abort=()=>control.abort(signal?.reason??new BridgeError('cancelled','OpenJev request cancelled'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>control.abort(new BridgeError('timeout','OpenJev logical request deadline exceeded')),this.timeoutMs);
  let release;
  try{
   release=await this.semaphore.acquire(control.signal);
   return await this.client.ask(body.state,body.questions,{model:body.model,signal:control.signal});
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);release?.();}
 }
}

function secretMatches(actual,expected){
 const a=Buffer.from(actual??''),b=Buffer.from(expected);
 return a.length===b.length&&timingSafeEqual(a,b);
}
export function createAdapterServer(adapter,{token='',maxBodyBytes=1000000}={}){
 fail(Number.isSafeInteger(maxBodyBytes)&&maxBodyBytes>=128&&maxBodyBytes<=16000000,'invalid maxBodyBytes','invalid_arguments');
 fail(typeof token==='string'&&token.length<=16384&&!/[\r\n]/.test(token),'invalid inbound API key','invalid_arguments');
 const server=http.createServer(async(req,res)=>{
  const reply=(status,body)=>{
   if(res.destroyed||res.writableEnded)return;
   res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
   res.end(JSON.stringify(body));
  };
  // No CORS and no browser-origin requests; bind() below is hard-coded loopback.
  if(req.headers.origin)return reply(403,{error:'Browser-origin requests are not accepted'});
  if(token&&!secretMatches(req.headers.authorization,`Bearer ${token}`))return reply(401,{error:'Unauthorized'});
  if(req.method==='GET'&&req.url==='/healthz')return reply(200,{status:'alive',model:adapter.model,note:'Liveness only. Use bridge doctor for a model probe.'});
  if(req.method==='GET'&&req.url==='/v1/models')return reply(200,{models:[{id:adapter.model,transport:'openjev-llamacpp'}]});
  if(req.method!=='POST'||req.url!=='/v1/systemone')return reply(404,{error:'Not found'});
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return reply(415,{error:'Content-Type must be application/json'});
  const controller=new AbortController();let total=0;
  const aborted=()=>controller.abort(new BridgeError('cancelled','Client disconnected'));
  req.on('aborted',aborted);res.on('close',()=>{if(!res.writableEnded)aborted();});
  const timer=setTimeout(()=>{controller.abort(new BridgeError('timeout','Request deadline exceeded'));reply(504,{error:'Request deadline exceeded'});if(!req.complete)req.destroy();},adapter.timeoutMs);
  try{
   const chunks=[];
   for await(const chunk of req){total+=chunk.length;if(total>maxBodyBytes){reply(413,{error:'Request exceeds byte limit'});return;}chunks.push(chunk);}
   let body;
   try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{reply(400,{error:'Invalid JSON or UTF-8'});return;}
   const result=await adapter.ask(body,{signal:controller.signal});reply(200,result);
  }catch(e){
   const status=e.code==='timeout'?504:['busy','circuit_open','unavailable'].includes(e.code)?503:
    ['invalid_arguments','invalid_input','validation_error','context_budget','unsupported_shape'].includes(e.code)?422:502;
   // Exceptions originate locally or are sanitized by SystemOneClient; upstream
   // response bodies and credentials are never forwarded.
   reply(status,{error:e.code??'adapter_error',message:e instanceof BridgeError?e.message:'OpenJev adapter request failed'});
  }finally{clearTimeout(timer);req.off('aborted',aborted);}
 });
 server.maxConnections=64;server.requestTimeout=300000;server.headersTimeout=10000;server.maxHeadersCount=50;
 return server;
}
function settings(env){
 const num=(key,def)=>env[key]===undefined?def:Number(env[key]);
 return {url:env.OPENJEV_LLAMA_URL??'http://127.0.0.1:8014',model:env.OPENJEV_MODEL??'openjev',apiKey:env.OPENJEV_LLAMA_API_KEY??'',
  maxPromptTokens:num('OPENJEV_MAX_PROMPT_TOKENS',8192),timeoutMs:num('OPENJEV_TIMEOUT_MS',120000),
  temperature:num('OPENJEV_TEMPERATURE',.85),noulTemperature:num('OPENJEV_NOUL_TEMPERATURE',1.829074),noulBias:num('OPENJEV_NOUL_BIAS',0)};
}
let entry=false;try{entry=import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{}
if(entry){
 try{
  const adapter=new OpenJevLlamaAdapter(settings(process.env));
  const port=Number(process.env.OPENJEV_PORT??8013);fail(Number.isSafeInteger(port)&&port>=1&&port<=65535,'invalid OPENJEV_PORT','invalid_arguments');
  const server=createAdapterServer(adapter,{token:process.env.OPENJEV_API_KEY??''});
  server.on('error',e=>{console.error(`openjev adapter: ${e.code??'startup error'}`);process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`OpenJev System One adapter listening on http://127.0.0.1:${port}; model=${adapter.model}. Run bridge doctor to test inference.`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();});
 }catch(e){console.error(e.message);process.exitCode=1;}
}
