import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
export const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const BIN=path.join(ROOT,'bin/open-jev-bridge.mjs');
export async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'system-one-test-'));}
export function answer(q,id=''){
 if(q.type==='noul')return {type:'noul',noul:id==='injection'?.02:/(?:_call|_result)$/.test(id)?.1:.95};
 const keys=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));
 const selected=q.type==='score'?['test_gap','blast_radius'].includes(id)?'0':keys.at(-1):keys[0];
 const probabilities=Object.fromEntries(keys.map(k=>[k,k===selected?1:0]));
 return q.type==='choice'?{type:'choice',choice:selected,confidence:1,probabilities}:{type:'score',score:Number(selected),confidence:1,legend:Object.fromEntries(q.criteria.map((c,i)=>[String(i),String(c)])),probabilities};
}
export function envelope(questions,overrides={}){return {model:'kev-latest',answers:Object.fromEntries(Object.entries(questions).map(([k,q])=>[k,!Object.hasOwn(overrides,k)?answer(q,k):overrides[k]])),usage:{input_tokens:30,output_tokens:50},latency_ms:0.1};}
export function fakeClient(resolver){return {config:{maxStateTokens:6000,maxRequestTokens:7600,model:'kev-latest'},calls:[],async ask(state,questions,options){this.calls.push({state,questions,options});return resolver?resolver(state,questions,options,this.calls.length):envelope(questions);},async models(){return {models:[{id:'kev-latest',run:'fixture-not-a-model'}]};}};}
// Independent wire contract checker: deliberately does not import production validators.
export function upstreamContract(body){
 assert.equal(typeof body.model,'string');assert.ok(Object.hasOwn(body,'state'));assert.equal(typeof body.questions,'object');assert.ok(Object.keys(body.questions).length);
 assert.deepEqual(Object.keys(body).sort(),['model','questions','state']);
 for(const q of Object.values(body.questions)){
  assert.ok(['noul','choice','score'].includes(q.type));assert.ok(Object.hasOwn(q,'instructions'));
  if(q.type==='choice'){assert.ok(q.criteria&&!Array.isArray(q.criteria));assert.ok(Object.keys(q.criteria).length>=1&&Object.keys(q.criteria).length<=255);}
  if(q.type==='score'){assert.ok(Array.isArray(q.criteria)&&q.criteria.length>=2&&q.criteria.length<=255);}
 }
}
export async function mockSystemOne(handler){
 const requests=[],sockets=new Set();let active=0,maxActive=0;
 const server=http.createServer(async(req,res)=>{
  active++;maxActive=Math.max(maxActive,active);res.on('close',()=>active--);
  let text='';for await(const c of req)text+=c;
  const body=text?JSON.parse(text):undefined;requests.push({method:req.method,url:req.url,headers:req.headers,body});
  const index=requests.length;
  if(handler){const handled=await handler({req,res,body,index});if(handled!==false)return;}
  if(req.method==='GET'&&req.url.endsWith('/v1/models')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[{id:'kev-latest',run:'offline-contract-fixture',device:'none'}]}));return;}
  try{assert.equal(req.method,'POST');assert.ok(req.url.endsWith('/v1/systemone'));upstreamContract(body);}catch{res.writeHead(422,{'content-type':'application/json'});res.end('{"detail":"invalid contract"}');return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(envelope(body.questions)));
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});server.listen(0,'127.0.0.1');await once(server,'listening');
 return {server,requests,get maxActive(){return maxActive;},url:`http://127.0.0.1:${server.address().port}`,async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
export const user=text=>({role:'user',text,toolUses:[]});
export const assistant=(text='',toolUses=[])=>({role:'assistant',text,toolUses});
export const use=(id,tool='Bash',input={command:'ls'})=>({tool_use_id:id,tool,input});
export const result=(id,text='',extra={})=>({role:'user',text:'',toolUses:[],toolResults:[{tool_use_id:id,text,...extra}]});
export function history(n=5,size=1500){const m=[user('Inspect and implement the parser')];for(let i=0;i<n;i++){m.push(assistant(`Step ${i}`,[use(`t${i}`)]));m.push(result(`t${i}`,'x'.repeat(size)));}m.push(user('Keep working on the parser'),assistant('Continuing.'));return m;}
export function unverified(){return [user('Fix the bug'),assistant('',[use('edit','Edit',{file_path:'a.js',old_string:'a',new_string:'b'})]),result('edit','Updated'),assistant('Implemented and verified. All tests passed.')];}
export function verified(){const m=unverified();m.pop();m.push(assistant('',[use('check','Bash',{command:'npm test'})]),result('check','5 passed',{exitCode:0}),assistant('Done, tests pass'));return m;}
export async function command(args,{env={},input,command=process.execPath,timeout=10000,cwd=ROOT}={}){
 const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
 if(input!==undefined)child.stdin.end(typeof input==='string'?input:JSON.stringify(input));else child.stdin.end();
 const [code,signal]=await once(child,'exit');clearTimeout(timer);return {code,signal,stdout,stderr};
}
export async function mcpProcess(url,{env={},timeout=10000}={}){
 const home=await temp(),child=spawn(process.execPath,[BIN,'serve'],{env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),SYSTEM_ONE_URL:url,SYSTEM_ONE_TIMEOUT_MS:'2000',...env},stdio:['pipe','pipe','pipe']});
 let seq=1,buffer='',stderr='';const pending=new Map(),messages=[];
 child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{buffer+=s;let i;while((i=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{throw new Error(`Nonprotocol stdout: ${line}`);}messages.push(m);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m);}}});child.stderr.on('data',s=>stderr+=s);
 const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
 const request=(method,params={},id=seq++)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout: ${method}`));},timeout);pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params});});
 const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'independent-test-client',version:'1'}});assert.equal(init.result.serverInfo.name,'open-jev-bridge');send({jsonrpc:'2.0',method:'notifications/initialized'});
 return {child,request,send,messages,get stderr(){return stderr;},async close(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('client closed'));}pending.clear();child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),1500);await once(child,'exit').catch(()=>{});clearTimeout(timer);await fs.rm(home,{recursive:true,force:true});}};
}
export const TOOL_INPUTS={
 system_one_verify:{claims:['The label is blue'],evidence:'The label is blue.'},
 system_one_screen:{text:'This guide describes blue labels.',purpose:'Find label color'},
 system_one_find:{query:'What is the label?',candidates:[{id:'a',text:'It is blue'},{id:'b',text:'Other information'}]},
 system_one_classify:{items:[{id:'item',text:'Blue label'}],classes:[{id:'color',description:'Colors'},{id:'shape',description:'Shapes'}]},
 system_one_decide:{decision:'Choose label',evidence:'Blue meets the requirement',candidates:[{id:'blue',description:'Blue'},{id:'red',description:'Red'}],requirements:['Blue label']},
 system_one_rerank:{query:'Blue label',candidates:[{id:'a',text:'Blue'},{id:'b',text:'Red'}]},
 system_one_compare:{passage_a:'The label is blue',passage_b:'It is blue',aspects:['color']},
 system_one_extract:{document:'primary code: BLUE-42; secondary: RED-13',fields:[{id:'code',pattern:'[A-Z]+-\\d+',description:'The primary code'}]},
 system_one_review:{request:'Change the label to blue',diff:'-red\n+blue',tests:'1 passed'},
 system_one_gate:{request:'Change the label to blue',diff:'-red\n+blue',tests:'1 passed',claims:['Label is blue'],evidence:'Diff changes label from red to blue. Test passes.'},
 system_one_query:{state:{color:'blue'},questions:{q:{type:'noul',instructions:'Is it blue?'}}},
 system_one_compact:{messages:history(),options:{preserveRecentMessages:2}},
 system_one_belay:{messages:unverified()},system_one_status:{},
};
