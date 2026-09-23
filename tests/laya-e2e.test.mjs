import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SystemOneClient} from '../src/client.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {ToolService} from '../src/tools.mjs';
import {ROOT,BIN,command,temp,mcpProcess} from './helpers.mjs';

async function sidecar(t){
 const home=await temp();t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const child=spawn(process.env.PYTHON??'python3',['-u','tests/fixtures/laya_adapter.py'],{cwd:ROOT,env:{...process.env,SYSTEM_ONE_API_KEY:'adapter-fixture-key'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);const exited=once(child,'close');
 t.after(async()=>{child.kill('SIGTERM');await exited;});
 const ready=await new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(new Error('Laya adapter fixture startup timeout')),5000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.stdout.on('data',b=>{buffer+=b;const end=buffer.indexOf('\n');if(end>=0){clearTimeout(timer);try{resolve(JSON.parse(buffer.slice(0,end)));}catch(e){reject(e);}}});
  child.on('close',()=>{clearTimeout(timer);reject(new Error('Laya adapter fixture exited: '+stderr));});
 });
 assert.equal(ready.fixture,true);return {...ready,home,get stderr(){return stderr;}};
}
const questions={yes:{type:'noul',instructions:'Blue label?'},choice:{type:'choice',instructions:'Color?',criteria:{blue:null,red:null}},score:{type:'score',instructions:'Intensity?',criteria:[{level:'low'},['high']]}};
test('Actual Python HTTP adapter -> Node client: mixed typed contract, model listing, structured legend, bearer auth',async t=>{
 const s=await sidecar(t),c=new SystemOneClient({url:s.url,model:'laya',provider:'laya',apiKey:'adapter-fixture-key'});
 const r=await c.ask({label:'blue'},questions);const parsed=requireAnswers(questions,r);assert.ok(parsed.score);assert.equal(r.usage.output_tokens,0);assert.equal(r.answers.yes.noul,.9876);assert.equal((await c.models()).models[0].id,'laya');
});
test('Actual Python HTTP adapter -> CLI doctor across process boundary',async t=>{
 const s=await sidecar(t);const r=await command([BIN,'doctor','--url',s.url,'--model','laya','--provider','laya'],{env:{HOME:s.home,SYSTEM_ONE_API_KEY:'adapter-fixture-key'}});
 assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'ok');assert.ok(!r.stdout.includes('adapter-fixture-key'));
});
test('Actual Python adapter -> MCP -> System One raw tool',async t=>{
 const s=await sidecar(t);const m=await mcpProcess(s.url,{env:{SYSTEM_ONE_MODEL:'laya',SYSTEM_ONE_PROVIDER:'laya',SYSTEM_ONE_API_KEY:'adapter-fixture-key'}});t.after(()=>m.close());
 const r=await m.request('tools/call',{name:'system_one_query',arguments:{state:'blue',questions}});assert.ok(r.result&&!r.result.isError);assert.ok(!JSON.stringify(r).includes('adapter-fixture-key'));
});
test('Actual Python adapter rejects missing credentials, model mismatch and truncated context',async t=>{
 const s=await sidecar(t);await assert.rejects(new SystemOneClient({url:s.url,model:'laya',provider:'laya'}).ask('s',questions),/HTTP 401/);
 const c=new SystemOneClient({url:s.url,model:'laya',provider:'laya',apiKey:'adapter-fixture-key'});
 await assert.rejects(c.ask('s',questions,{model:'wrong'}),/HTTP 422/);
 await assert.rejects(c.ask('x '.repeat(1500),questions),/HTTP 422/);
});
test('Actual Python adapter -> purpose-built verification with complete short evidence',async t=>{
 const s=await sidecar(t),service=new ToolService(new SystemOneClient({url:s.url,model:'laya',provider:'laya',apiKey:'adapter-fixture-key'}));
 const r=await service.call('system_one_verify',{claims:['Label is blue'],evidence:'Label is blue.'});assert.equal(r.results[0].status,'ok');
});
