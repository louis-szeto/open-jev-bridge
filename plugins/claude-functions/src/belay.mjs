import {isRecord,redact,clip} from './pure.mjs';
import {requireAnswers} from './schema.mjs';
// Intentionally conservative: command-like text inside echo/printf/cat is not execution.
const CHECK_START=/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build|verify|ci)\b|(?:npx|pnpm exec|bunx)\s+(?:tsc|jest|vitest|mocha|eslint|biome)\b|(?:python\d?(?:\.\d+)?\s+-m\s+)?(?:pytest|unittest|ruff|mypy)\b|(?:jest|vitest|mocha|tsc|eslint|flake8|pylint|phpunit|ctest)\b|black\s+--check\b|biome\s+check\b|cargo\s+(?:test|check|build|clippy|nextest)\b|go\s+(?:test|vet|build)\b|make\s+(?:test|check|lint|build)\b|mvn\s+(?:test|verify)\b|gradle\w*\s+(?:test|check|build)\b|dotnet\s+(?:test|build)\b|node\s+--test\b|deno\s+(?:test|check|lint)\b|rspec\b|rake\s+test\b|mix\s+test\b|swift\s+(?:test|build)\b|xcodebuild\s+test\b|zig\s+(?:test|build)\b)/;
function commandSegments(command){
 if(typeof command!=='string'||/[`]|\$\(/.test(command))return [];
 // Analyze only unquoted control operators; quoted text must not forge a runner.
 let quote=null,escape=false,part='',parts=[];
 for(let i=0;i<command.length;i++){const ch=command[i];if(escape){part+=ch;escape=false;continue;}if(ch==='\\'&&quote!=="'"){escape=true;part+=ch;continue;}if(quote){part+=ch;if(ch===quote)quote=null;continue;}if(ch==='"'||ch==="'"){quote=ch;part+=ch;continue;}if(ch===';'||ch==='\n'||(ch==='&'&&command[i+1]==='&')||(ch==='|'&&command[i+1]==='|')){parts.push(part.trim());part='';if(ch==='&'||ch==='|')i++;continue;}part+=ch;}
 parts.push(part.trim());return parts.map(p=>p.replace(/^(?:[A-Za-z_]\w*=(?:[^\s]+)\s+)+/,''));
}
export function isCheckCommand(command){return commandSegments(command).some(p=>CHECK_START.test(p));}
function canExecuteCheckScript(command){return commandSegments(command).some(p=>/^(?:(?:python\d?(?:\.\d+)?|node|bun|bash|sh)\s+(?!-c\b)|(?:npm|pnpm|yarn)\s+(?:run|exec)\b|\.\.?\/[\w./-]+(?:\s|$))/.test(p));}
export function checkSummary(output){
 const s=String(output??'').slice(-10000).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
 // Any explicit failure takes priority, even if another sub-suite passed.
 if(/(?:^|\n)\s*(?:#\s*)?(?:fail|failed)\s+[1-9]\d*\b/im.test(s)||/\b[1-9]\d* (?:failed|failures?|errors?)\b/i.test(s)||/test result: FAILED|BUILD (?:FAILED|FAILURE)|^FAIL\s+|^Failed!|^error\[E\d+\]|^error: could not compile|^.*error TS\d{4}:/m.test(s))return 'fail';
 if(/(?:^|\n)\s*(?:#\s*)?fail\s+0\b/im.test(s)&&/(?:^|\n)\s*(?:#\s*)?pass\s+[1-9]/im.test(s))return 'pass';
 if(/\b[1-9]\d* passed\b|test result: ok\.|^ok\s+\S+\s+[\d.]+s|BUILD (?:SUCCESS|SUCCESSFUL)|All checks passed!|Success: no issues found|^Passed!|\b[1-9]\d* (?:tests?|examples?), 0 failures?\b|^\s*[1-9]\d* passing\b/m.test(s))return 'pass';
 return undefined;
}
const mutationTools=/^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|functions\.apply_patch)$/;
const shellTools=/^(?:Bash|PowerShell|bash|shell|shell_command|exec_command|functions\.exec_command|functions\.shell_command|functions\.shell)$/;
export function classifyResult(tool,input,result){
 const command=typeof input?.command==='string'?input.command:typeof input?.cmd==='string'?input.cmd:Array.isArray(input?.command)?input.command.join(' '):'';
 if(mutationTools.test(tool))return result?.isError?'none':'mutation';
 if(!shellTools.test(tool))return 'none';
 const summary=checkSummary(result?.text),named=isCheckCommand(command),code=result?.exitCode;
 if(named||summary&&canExecuteCheckScript(command)){
  if(result?.isError||code!==undefined&&code!==0||summary==='fail')return 'check-fail';
  if(summary==='pass')return 'check-pass';
  if(named&&code===0&&!/\|\||\|\s*(?:tee|cat)|;\s*(?:true|echo|printf)\b/.test(command))return 'check-pass';
  return 'check-unknown';
 }
 // Best-effort detection of common shell writes, not a claim to understand arbitrary scripts.
 if(result?.isError||code!==undefined&&code!==0)return 'none';
 if(/\b(?:apply_patch|touch|mkdir|rm|mv|cp|git\s+(?:apply|checkout|restore|reset))\b|\bsed\s+-i\b|(?:^|[^>])>{1,2}\s*[^&]/.test(command))return 'mutation';
 return 'none';
}
export function collectEvidence(messages){
 let start=0;for(let i=0;i<messages.length;i++){const m=messages[i];if(m.role==='user'&&(m.text?.trim()||m.opaque)&&!(m.toolResults?.length)){start=i;}}
 const calls=new Map(),checks=[],finished=new Set();let mutations=0,lastMutation=-1,task=messages[start]?.role==='user'?messages[start].text??'':'',lastAssistant='';
 for(let i=start;i<messages.length;i++){
  const m=messages[i];if(m.role==='assistant'&&m.text)lastAssistant=m.text;
  for(const t of m.toolUses??[])calls.set(t.tool_use_id,{...t,index:i});
  for(const r of m.toolResults??[]){const t=calls.get(r.tool_use_id);if(!t)continue;finished.add(r.tool_use_id);const kind=classifyResult(t.tool,t.input,r);
   if(kind==='mutation'){mutations++;lastMutation=i;}
   if(kind.startsWith('check-'))checks.push({call:t.tool_use_id,command:JSON.stringify(t.input??{}),start:t.index,end:i,passed:kind==='check-pass',failed:kind==='check-fail',known:kind!=='check-unknown'});
  }
 }
 return {start,mutations,lastMutation,checks,freshChecks:checks.filter(c=>c.start>lastMutation),pending:[...calls.values()].filter(t=>!finished.has(t.tool_use_id)&&isCheckCommand(t.input?.command??t.input?.cmd??'')),task,lastAssistant};
}
/** A different passing command must not erase a failing suite. Only a later,
 * successfully completed rerun of the same command supersedes that failure. */
export function verificationState(evidence) {
 const latest=new Map();
 for(const check of evidence.freshChecks)latest.set(check.command??check.call,check);
 const checks=[...latest.values()],failed=checks.filter(c=>c.failed),pending=evidence.pending??[];
 return {passed:checks.some(c=>c.passed)&&!failed.length&&!pending.length,failed,pending};
}
export const BELAY_QUESTIONS={
 claims_done:{type:'noul',instructions:'Does the final assistant message claim the requested work is completed, implemented or fixed? A plan or explicit inability is not completion.'},
 claims_verified:{type:'noul',instructions:'Does the final assistant message claim actual tests, checks, builds or verification passed? Planned tests do not count.'},
 verification_applies:{type:'noul',instructions:'Given the task and observed file changes, would running a test, build, lint or another executable check be relevant before claiming completion?'},
 outcome:{type:'choice',instructions:'What is the outcome actually claimed by the final message?',criteria:{completed:'Claims completed work',blocked:'Explicitly blocked or unable to complete/verify',partial:'Explicitly incomplete or partial work',other:'A question, explanation or non-completion message'}},
};
export async function evaluateBelay(messages,finalMessage,ask,options={}){
 const ev=collectEvidence(messages),final=finalMessage??ev.lastAssistant;
 if(!ev.mutations)return {status:'not_needed',block:false,reason:'no_observed_mutations'};
 const verification=verificationState(ev);
 if(verification.passed)return {status:'not_needed',block:false,reason:'fresh_passing_check'};
 if(!final.trim())return {status:'not_needed',block:false,reason:'no_completion_message'};
 const state={task:clip(redact(ev.task),1500),final_message:redact(final).slice(-2000),run:{file_changes:ev.mutations,checks_run:ev.freshChecks.map(c=>`${c.call} -> ${c.passed?'passed':c.failed?'failed':'unknown'}`)}};
 const answers=requireAnswers(BELAY_QUESTIONS,await ask(state,BELAY_QUESTIONS));
 const outcome=answers.outcome.confidence!==null&&answers.outcome.confidence>=.4?answers.outcome.choice:'other';
 const block=answers.claims_done.noul>=(options.belayThreshold??.7)&&answers.verification_applies.noul>=.5&&outcome!=='blocked'&&outcome!=='partial';
 const falseClaim=block&&answers.claims_verified.noul>=.7&&!ev.freshChecks.some(c=>c.known);
 const detail=verification.failed.length?'A relevant fresh check is still failing; another passing command does not clear that failure. Fix it and rerun the relevant checks.':verification.pending.length?'A verification command is still running; wait for its actual exit status before reporting completion.':'No passing check was observed after the latest change. Run the relevant tests, build, or lint.';
 return {status:'ok',block,false_claim:falseClaim,outcome,reason:block?`system-one-belay: ${detail} Report the actual results. If verification cannot run, state that limitation explicitly instead of claiming verified completion.`:'no_unsupported_completion',signals:{claims_done:answers.claims_done.noul,claims_verified:answers.claims_verified.noul,verification_applies:answers.verification_applies.noul},evidence:{mutations:ev.mutations,fresh_checks:ev.freshChecks.length}};
}
