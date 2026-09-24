import {BridgeError,invariant,isRecord,utf8Bytes} from './pure.mjs';
import {validateRequest,RESPONSE_RULES} from './schema.mjs';
import {validateProviderRequest,responseRules,normalizeModels} from './providers.mjs';
import {askShisa} from './shisa.mjs';
import {askShisaLlamaCpp} from './shisa-llamacpp.mjs';
import {endpoint,resolveConfig} from './config.mjs';

export class Semaphore {
  constructor(limit, maxQueue) { this.limit=limit; this.maxQueue=maxQueue; this.active=0; this.queue=[]; }
  acquire(signal) {
    if(signal?.aborted) return Promise.reject(signal.reason);
    if(this.active<this.limit) { this.active++; return Promise.resolve(()=>this.release()); }
    if(this.queue.length>=this.maxQueue) return Promise.reject(new BridgeError('busy','System One request queue is full'));
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,signal};
      item.abort=()=>{const i=this.queue.indexOf(item);if(i>=0)this.queue.splice(i,1);reject(signal.reason);};
      signal?.addEventListener('abort',item.abort,{once:true}); this.queue.push(item);
    });
  }
  release() {
    const item=this.queue.shift();
    if(item){item.signal?.removeEventListener('abort',item.abort);item.resolve(()=>this.release());}
    else this.active--;
  }
}
export class SystemOneClient {
  constructor(config={}, {fetchImpl=globalThis.fetch, now=Date.now}={}) {
    this.config=resolveConfig(config,{}, {readFile:false}); this.urls=endpoint(this.config.url,this.config.allowRemote,this.config.provider);
    this.fetch=fetchImpl; this.now=now; this.semaphore=new Semaphore(this.config.maxConcurrent,this.config.maxQueue);
    this.failures=0; this.openUntil=0; this.probing=false;
    this.metrics={requests:0,failures:0,retries:0,bytesSent:0,bytesReceived:0};
  }
  async ask(state,questions,{signal,model}={}) {
    const body={state,questions,model:model??this.config.model}; validateRequest(body,this.config.provider==='laya'?64:512);validateProviderRequest(body,this.config.provider);
    let response;
    if(this.config.provider==='shisa'){
      // One deadline covers tokenization, all question readouts, missing-letter fallbacks,
      // and time waiting for the shared HTTP semaphore. No per-question budget reset.
      const control=new AbortController();
      const timer=setTimeout(()=>control.abort(new BridgeError('timeout','Shisa logical request timed out')),this.config.timeoutMs);
      const abort=()=>control.abort(signal.reason??new BridgeError('cancelled','Request cancelled'));
      if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
      try{response=await (this.config.shisaBackend==='llamacpp'?askShisaLlamaCpp:askShisa)(body,this.config,this.urls,(url,method,payload)=>this.request(url,method,payload,control.signal));}
      catch(e){control.abort(e);throw e;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    }else response=await this.request(this.urls.systemOne,'POST',body,signal);
    invariant(isRecord(response)&&isRecord(response.answers)&&typeof response.model==='string'&&response.model.length>0,'Missing System One model/answers envelope','invalid_response');
    Object.defineProperty(response,RESPONSE_RULES,{value:responseRules(this.config.provider)});return response;
  }
  async models({signal}={}) {
    const r=await this.request(this.urls.models,'GET',undefined,signal);
    return normalizeModels(r,this.config.provider);
  }
  async request(url,method,payload,callerSignal) {
    const c=this.config; const serialized=payload===undefined?undefined:JSON.stringify(payload);
    invariant(!serialized||utf8Bytes(serialized)<=c.maxRequestBytes,'System One request exceeds byte limit','request_too_large');
    if(this.openUntil>this.now() || this.probing) throw new BridgeError('circuit_open','System One circuit breaker is open');
    const control=new AbortController(); const timer=setTimeout(()=>control.abort(new BridgeError('timeout','System One request timed out')),c.timeoutMs);
    const onAbort=()=>control.abort(callerSignal.reason ?? new BridgeError('cancelled','Request cancelled'));
    if(callerSignal?.aborted) onAbort(); else callerSignal?.addEventListener('abort',onAbort,{once:true});
    let release; let counted=false;
    try {
      release=await this.semaphore.acquire(control.signal);
      if(this.openUntil>this.now() || this.probing) throw new BridgeError('circuit_open','System One circuit breaker is open');
      if(this.openUntil) this.probing=true;
      for(let attempt=0;;attempt++) {
        this.metrics.requests++; this.metrics.bytesSent+=serialized?utf8Bytes(serialized):0; counted=true;
        const headers={accept:'application/json'};
        if(serialized) headers['content-type']='application/json';
        if(c.apiKey) headers.authorization=`Bearer ${c.apiKey}`;
        const r=await this.fetch(url,{method,headers,body:serialized,signal:control.signal,redirect:'manual'});
        const retry=[429,502,503,504,529].includes(r.status) && attempt<c.retries;
        if(!r.ok) {
          await r.body?.cancel().catch(()=>{});
          if(retry) { this.metrics.retries++; await delay(retryDelay(r.headers.get('retry-after'),100*2**attempt,this.now()),control.signal); continue; }
          // Never echo an upstream body: it can contain credentials or malicious text.
          throw new BridgeError('http_error',`System One HTTP ${r.status}`);
        }
        if(!/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(r.headers.get('content-type')||'')) { await r.body?.cancel().catch(()=>{}); throw new BridgeError('invalid_response','System One response is not JSON'); }
        const size=Number(r.headers.get('content-length'));
        if(Number.isFinite(size)&&size>c.maxResponseBytes) { await r.body?.cancel().catch(()=>{}); throw new BridgeError('response_too_large','System One response exceeds byte limit'); }
        const chunks=[]; let bytes=0;
        invariant(r.body,'System One response has no body','invalid_response');
        const reader=r.body.getReader();
        try {
          for(;;) {
            const {done,value}=await reader.read(); if(done)break;
            bytes+=value.byteLength;
            if(bytes>c.maxResponseBytes) { await reader.cancel(); throw new BridgeError('response_too_large','System One response exceeds byte limit'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        this.metrics.bytesReceived+=bytes;
        const b=new Uint8Array(bytes);let pos=0;for(const chunk of chunks){b.set(chunk,pos);pos+=chunk.length;}
        let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{throw new BridgeError('invalid_response','System One returned invalid JSON or UTF-8');}
        this.failures=0;this.openUntil=0; return result;
      }
    } catch(error) {
      if(counted && !callerSignal?.aborted) {this.metrics.failures++; if(++this.failures>=c.breakerFailures)this.openUntil=this.now()+c.breakerCooldownMs;}
      if(control.signal.aborted) throw control.signal.reason;
      if(error instanceof BridgeError)throw error;
      throw new BridgeError('unavailable','Cannot reach configured System One endpoint');
    } finally { clearTimeout(timer);callerSignal?.removeEventListener('abort',onAbort);if(release)release();this.probing=false; }
  }
}
function delay(ms,signal) {
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(t);reject(signal.reason);};
    const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}

export function retryDelay(header,fallback,now=Date.now()){
 if(header===null||header.trim()==='')return fallback;
 const seconds=Number(header);if(Number.isFinite(seconds))return seconds>=0?Math.min(300000,seconds*1000):fallback;
 const date=Date.parse(header);return Number.isFinite(date)?Math.min(300000,Math.max(0,date-now)):fallback;
}
