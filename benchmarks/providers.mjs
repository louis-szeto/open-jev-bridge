/** Measures adapter/transport overhead ONLY, with named synthetic loopback servers. */
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {SystemOneClient} from '../src/client.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {shisaHttp} from '../tests/fixtures/shisa-http.mjs';
import {mockSystemOne,mcpProcess} from '../tests/helpers.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const questions={n:{type:'noul',instructions:'Is blue present?'},c:{type:'choice',instructions:'Choose',criteria:{a:'Blue',b:'Red',c:'Green'}},s:{type:'score',instructions:'Rate',criteria:['low','medium','high']}};
const results=[];
for(const provider of ['decider','shisa']){
 const server=provider==='shisa'?await shisaHttp({omit:['C']}):await mockSystemOne();let m;
 const c=new SystemOneClient({url:server.url,provider,model:provider==='shisa'?'shisa-de-1':'decider-35b-a3b'});
 try{
  m=await mcpProcess(server.url,{env:{SYSTEM_ONE_PROVIDER:provider,SYSTEM_ONE_MODEL:c.config.model}});
  for(const transport of ['http','mcp']){
   const run=async()=>{
    if(transport==='http')requireAnswers(questions,await c.ask('The label is blue.',questions));
    else{const r=await m.request('tools/call',{name:'system_one_query',arguments:{state:'The label is blue.',questions}});assert.equal(r.result.isError,false);}
   };
   for(let i=0;i<3;i++)await run();const samples=[],before=server.requests.length;
   for(let i=0;i<20;i++){const t=performance.now();await run();samples.push(performance.now()-t);}
   const sorted=[...samples].sort((a,b)=>a-b),r={provider,transport,samples_ms:samples,p50_ms:sorted[9],p95_ms:sorted[18],iterations:20,warmup:3,http_requests_per_logical_call:(server.requests.length-before)/20};
   results.push(r);console.log(`${provider}/${transport}: p50 ${r.p50_ms.toFixed(3)}ms, p95 ${r.p95_ms.toFixed(3)}ms, HTTP calls ${r.http_requests_per_logical_call}`);
  }
 }finally{if(m)await m.close();await server.close();}
}
const report={mode:'OFFLINE_ADAPTER_OVERHEAD_NOT_GPU_INFERENCE',generated_at:new Date().toISOString(),node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,
 description:'Three typed questions per logical request. Synthetic model/tokenizer outputs. Shisa misses C from top-k to exercise two forced-letter fallback readouts. No real model weights, inference accuracy or vendor latency claims.',results};
await fs.mkdir(root+'reports',{recursive:true});await fs.writeFile(root+'reports/provider-benchmark.json',JSON.stringify(report,null,2)+'\n');
