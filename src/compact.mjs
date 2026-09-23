import {invariant,clip,estimateTokens,isRecord,dict} from './pure.mjs';
import {requireAnswers} from './schema.mjs';

export const COMPACT_DEFAULTS={keepThreshold:.5,preserveRecentMessages:6,maxStateTokens:6000,maxRequestTokens:7600,truncateHeadChars:300,minReductionRatio:.25,concurrency:2};
export function compactOptions(options={}) {
  const o={...COMPACT_DEFAULTS,...options};
  for(const k of ['keepThreshold','minReductionRatio']) invariant(Number.isFinite(o[k])&&o[k]>=0&&o[k]<=1,`Invalid ${k}`);
  for(const k of ['preserveRecentMessages','maxStateTokens','maxRequestTokens','truncateHeadChars','concurrency']) invariant(Number.isSafeInteger(o[k])&&o[k]>=0,`Invalid ${k}`);
  invariant(o.concurrency>=1&&o.concurrency<=16&&o.maxStateTokens>=256&&o.maxRequestTokens>=o.maxStateTokens+256,'Invalid compaction budget/concurrency');
  return o;
}
export function collectCalls(messages,preserve=6) {
  invariant(Array.isArray(messages)&&messages.length<=10000,'Expected at most 10000 messages');
  const calls=new Map(),results=new Map();
  messages.forEach((m,index)=>{
    invariant(isRecord(m)&&typeof m.role==='string'&&typeof m.text==='string'&&Array.isArray(m.toolUses),'Invalid canonical message');
    for(const u of m.toolUses) {
      invariant(isRecord(u)&&typeof u.tool_use_id==='string'&&u.tool_use_id.length>0&&typeof u.tool==='string'&&!calls.has(u.tool_use_id),'Invalid or duplicate tool call id');
      calls.set(u.tool_use_id,{id:u.tool_use_id,use:u,callIndex:index});
    }
    invariant(m.toolResults===undefined||Array.isArray(m.toolResults),'Invalid tool results');
    for(const r of m.toolResults??[]) {
      invariant(isRecord(r)&&typeof r.tool_use_id==='string'&&typeof r.text==='string'&&!results.has(r.tool_use_id),'Invalid or duplicate tool result id');
      results.set(r.tool_use_id,{result:r,resultIndex:index});
    }
  });
  for(const [id,r] of results) {
    invariant(calls.has(id),'Orphan tool result: refusing to compact');
    const c=calls.get(id);invariant(c.callIndex<=r.resultIndex,'Tool result precedes its call');Object.assign(c,r);
  }
  return [...calls.values()].map((c,i)=>({...c,key:`t${i}`,pinned:!c.result||[c.callIndex,c.resultIndex].some(j=>j===0||j>=messages.length-preserve||['system','developer'].includes(messages[j].role)||messages[j].opaque===true)}));
}
export function fitState(messages,calls,options) {
  const o=compactOptions(options), byIndex=new Map();
  for(const c of calls) {const a=byIndex.get(c.callIndex)??[];a.push(c);byIndex.set(c.callIndex,a);}
  const goal=typeof o.goal==='string'?o.goal:messages.filter(m=>m.role==='user'&&m.text).slice(-3).map(m=>m.text).join('\n');
  const stages=[{input:1000,text:Infinity},{input:200,text:2000},{input:60,text:500},{input:0,text:120},{input:0,text:0}];
  for(let stage=0;stage<stages.length;stage++) {
    const cap=stages[stage];
    const rows=messages.map((m,i)=>{
      const pinned=i===0||i>=messages.length-o.preserveRecentMessages||['system','developer'].includes(m.role);
      const text=pinned?m.text:clip(m.text,cap.text);
      const uses=(byIndex.get(i)??[]).map(c=>({id:c.key,tool:c.use.tool,input:clip(JSON.stringify(c.use.input??{}),cap.input),result:c.result?`${c.result.isError?'error':'completed'}, ${c.result.text.length} chars; contents omitted`:'pending'}));
      return {index:i,role:m.role,text,...(uses.length?{calls:uses}:{})};
    });
    const state={goal:clip(goal,1500),conversation:rows};
    const tokens=estimateTokens(state)+128;
    if(tokens<=o.maxStateTokens) return {state,tokens,stage};
  }
  // Never silently remove the current request or the evidence needed to identify a call.
  throw new Error('Conversation state does not fit the configured System One budget');
}
function serializedChars(messages) {
  return JSON.stringify(messages.map(m=>({role:m.role,text:m.text,toolUses:m.toolUses.map(u=>({tool_use_id:u.tool_use_id,tool:u.tool,input:u.input})),toolResults:m.toolResults?.map(r=>({tool_use_id:r.tool_use_id,text:r.text,isError:r.isError??false}))}))).length;
}
export async function compact(messages,asker,options={}) {
  const o=compactOptions(options), calls=collectCalls(messages,o.preserveRecentMessages), candidates=calls.filter(c=>!c.pinned);
  const before=serializedChars(messages);
  if(!candidates.length)return {messages,decisions:[],stats:{beforeChars:before,afterChars:before,reductionRatio:0,requests:0,pinned:calls.length,kept:0,truncated:0,dropped:0,stateTokens:0,stateStage:0}};
  const fitted=fitState(messages,calls,o);
  const batches=[];let entries=[];
  for(const c of candidates) {
    const pair=[
      [`${c.key}_call`,{type:'noul',instructions:`For the ongoing task, must the fact and input of tool call ${c.key} (${c.use.tool}) remain in context? Err toward keeping uncertain dependencies.`}],
      [`${c.key}_result`,{type:'noul',instructions:`For the ongoing task, must the original result of ${c.key} remain verbatim because its contents are still needed and re-running the tool is not enough? Err toward keeping when uncertain.`}]
    ];
    const size=arr=>fitted.tokens+estimateTokens(dict(arr))+128;
    if(entries.length&&(size([...entries,...pair])>o.maxRequestTokens||entries.length>=64)){batches.push(dict(entries));entries=[];}
    invariant(size(pair)<=o.maxRequestTokens,'A compaction question pair does not fit');entries.push(...pair);
  }
  if(entries.length)batches.push(dict(entries));
  const answers={};let index=0, failure;
  async function worker(){while(!failure&&index<batches.length){const q=batches[index++];try{Object.assign(answers,requireAnswers(q,await (typeof asker==='function'?asker(fitted.state,q):asker.ask(fitted.state,q))));}catch(e){failure=e;}}}
  await Promise.all(Array.from({length:Math.min(o.concurrency,batches.length)},worker));
  if(failure)throw failure;
  const decisions=calls.map(c=>{
    const keepCall=c.pinned?1:answers[`${c.key}_call`].noul,keepResult=c.pinned?1:answers[`${c.key}_result`].noul;
    return {...c,keepCall,keepResult,action:c.pinned||keepResult>=o.keepThreshold?'keep':keepCall>=o.keepThreshold?'truncate':'drop'};
  });
  const decisionsById=new Map(decisions.map(d=>[d.id,d]));
  const output=[];
  for(const m of messages) {
    let changed=false;
    const uses=m.toolUses.filter(u=>{const keep=decisionsById.get(u.tool_use_id).action!=='drop';if(!keep)changed=true;return keep;});
    const results=[];
    for(const r of m.toolResults??[]) {
      const d=decisionsById.get(r.tool_use_id);
      if(d.action==='drop'){changed=true;continue;}
      if(d.action==='truncate') {
        const t=r.text.slice(0,o.truncateHeadChars)+`\n[System One bridge omitted the remaining tool output; original length ${r.text.length} characters.]`;
        if(t.length<r.text.length){results.push({tool_use_id:r.tool_use_id,text:t,isError:r.isError??false});changed=true;}else results.push(r);
      } else results.push(r);
    }
    if(!changed){output.push(m);continue;}
    // Rebuilt messages intentionally omit opaque engine handles; preserved objects
    // retain their original identity, including handles, just as the host requires.
    if(m.text||uses.length||results.length||['system','developer'].includes(m.role))output.push({role:m.role,text:m.text,toolUses:uses,...(m.toolResults?{toolResults:results}:{})});
  }
  const after=serializedChars(output);
  const stats={beforeChars:before,afterChars:after,reductionRatio:before?Math.max(0,1-after/before):0,requests:batches.length,pinned:calls.filter(c=>c.pinned).length,kept:decisions.filter(d=>!d.pinned&&d.action==='keep').length,truncated:decisions.filter(d=>d.action==='truncate').length,dropped:decisions.filter(d=>d.action==='drop').length,stateTokens:fitted.tokens,stateStage:fitted.stage};
  return {messages:output,decisions:decisions.map(({id,keepCall,keepResult,action,pinned})=>({id,keepCall,keepResult,action,pinned})),stats};
}
