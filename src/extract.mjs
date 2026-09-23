import {Worker} from 'node:worker_threads';
import {BridgeError} from './pure.mjs';
export function regexCandidates(document,field,{timeoutMs=1000,signal}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason??new BridgeError('cancelled','Cancelled'));return;}
    const worker=new Worker(new URL('./regex-worker.mjs',import.meta.url),{workerData:{document,pattern:field.pattern,flags:field.flags??''},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result);};
    const abort=()=>finish(signal.reason??new BridgeError('cancelled','Cancelled'));
    const timer=setTimeout(()=>finish(null,{error:'regex_timeout',candidates:[],partial:true}),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    worker.on('message',r=>finish(null,r));
    worker.on('error',()=>finish(null,{error:'regex_worker_failed',candidates:[],partial:true}));
    worker.on('exit',code=>{if(!settled)finish(null,{error:`regex_worker_exit_${code}`,candidates:[],partial:true});});
  });
}
