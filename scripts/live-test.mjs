import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {SystemOneClient} from '../src/client.mjs';import {resolveConfig} from '../src/config.mjs';import {ToolService} from '../src/tools.mjs';import {TOOL_INPUTS} from '../tests/helpers.mjs';import {collectCalls} from '../src/compact.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),config=resolveConfig(),service=new ToolService(new SystemOneClient(config),config),results=[];let models;
try{
 models=(await service.call('system_one_status',{})).models;
 for(const [tool,args]of Object.entries(TOOL_INPUTS)){
  const start=Date.now();try{
   const result=await service.call(tool,args);assert.ok(!JSON.stringify(result).includes('"status":"invalid_response"'));
   if(tool==='system_one_verify')assert.equal(result.results[0].verdict,'verified');
   if(tool==='system_one_screen')assert.equal(result.action,'pass');
   if(tool==='system_one_find')assert.equal(result.top[0].id,'a');
   if(tool==='system_one_classify')assert.equal(result.results[0].label,'color');
   if(tool==='system_one_decide')assert.equal(result.recommendation,'blue');
   if(tool==='system_one_rerank')assert.equal(result.ranked[0].id,'a');
   if(tool==='system_one_compare')assert.equal(result.overall.relation,'same_fact');
   if(tool==='system_one_extract')assert.equal(result.results[0].value,'BLUE-42');
   if(tool==='system_one_gate')assert.equal(result.claims[0].verdict,'verified');
   if(tool==='system_one_belay')assert.equal(result.block,true);
   if(tool==='system_one_compact')collectCalls(result.messages,2);
   results.push({tool,status:'passed',elapsed_ms:Date.now()-start});
  }catch(e){results.push({tool,status:'failed',message:e.message,elapsed_ms:Date.now()-start});}
 }
 // Direct mixed-type contract probe. Exact score confidence is not assumed.
 const mixed=await service.call('system_one_query',{state:'The selected label is blue. The level is high.',questions:{yes:{type:'noul',instructions:'Does the text explicitly select blue?'},label:{type:'choice',instructions:'Which label is selected?',criteria:{blue:null,red:null}},level:{type:'score',instructions:'Which level is explicitly stated?',criteria:['low','medium','high']}}});
 assert.ok(mixed.answers.yes.noul>.5);assert.equal(mixed.answers.label.choice,'blue');assert.ok(mixed.answers.level.score>1);
 results.push({tool:'mixed_system_one_semantic_probe',status:'passed'});
}catch(e){results.push({tool:'live_prerequisite_or_contract',status:'failed',message:e.message});}
const report={generated_at:new Date().toISOString(),mode:'LIVE_SYSTEM_ONE',provider:config.provider,requested_model:config.model,models:models??null,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results,notice:'Small semantic smoke fixtures, not a comprehensive quality/accuracy study. No missing prerequisite is counted as a pass or silently skipped.'};
await fs.mkdir(path.join(root,'reports'),{recursive:true});await fs.writeFile(path.join(root,'reports','live-test.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
