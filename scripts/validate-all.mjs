/** Reproducible offline gate, with persistent diagnostics and bounded subprocesses. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {durationSetting,parseTap,failureExcerpt} from './ci-support.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),reports=path.join(root,'reports');
const childBudget=durationSetting(process.env.BRIDGE_CI_STAGE_TIMEOUT_MS,600000,'BRIDGE_CI_STAGE_TIMEOUT_MS');
// Node's timeout applies to an entire test file as well as individual tests. The HTTP
// timeout/cancellation tests keep their own small budgets; slower runners get file headroom.
const testBudget=durationSetting(process.env.BRIDGE_CI_TEST_TIMEOUT_MS,120000,'BRIDGE_CI_TEST_TIMEOUT_MS');
await fs.mkdir(reports,{recursive:true});
const tests=(await fs.readdir(path.join(root,'tests'))).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'tests/'+n);
const args=['--test','--test-concurrency=1',`--test-timeout=${testBudget}`,'--test-reporter=tap'];
const commands=[
 ['check',[process.execPath,'scripts/check.mjs']],
 ['tests',[process.execPath,...args,...tests]],
 ['adapter',[process.env.PYTHON??'python3','scripts/test-adapter.py']],
 ['coverage',[process.execPath,...args,'--experimental-test-coverage',...tests]],
 ['benchmark',[process.execPath,'benchmarks/run.mjs']],
 ['provider-benchmark',[process.execPath,'benchmarks/providers.mjs']],
];
// Do not accidentally report successful outputs from an earlier invocation after a failure.
for(const n of ['validation.json','adapter-validation.json',...commands.map(([name])=>name+'.log')])await fs.rm(path.join(reports,n),{force:true});
const runs=[];
for(const [name,[exe,...argv]] of commands) {
 const start=Date.now(),log=await fs.open(path.join(reports,name+'.log'),'w');
 const child=spawn(exe,argv,{cwd:root,env:process.env,stdio:['ignore',log.fd,log.fd]});
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},childBudget);
 const outcome=await new Promise(resolve=>{
  child.once('error',error=>resolve({code:null,signal:null,error:error.message}));
  child.once('close',(code,signal)=>resolve({code,signal}));
 });
 clearTimeout(timer);await log.close();
 const run={name,exit_code:outcome.code,signal:outcome.signal,timed_out:timedOut,elapsed_ms:Date.now()-start,log:`reports/${name}.log`,...(outcome.error?{error:outcome.error}:{})};
 runs.push(run);console.log(`${name}: ${outcome.code===0?'PASS':'FAIL'} (${run.elapsed_ms}ms)`);
 if(outcome.code!==0) {
  const text=await fs.readFile(path.join(reports,name+'.log'),'utf8');
  console.error('FIRST FAILURE DETAILS (full output is in '+run.log+')\n'+failureExcerpt(text));break;
 }
}
const testsRun=parseTap(await fs.readFile(path.join(reports,'tests.log'),'utf8').catch(()=>''));
let adapter=null;try{adapter=JSON.parse(await fs.readFile(path.join(reports,'adapter-validation.json'),'utf8'));}catch{/* Not executed/invalid output is not success. */}
const allGreen=runs.length===commands.length&&runs.every(r=>r.exit_code===0&&!r.timed_out)&&adapter?.all_green===true&&testsRun.total>0&&testsRun.total===testsRun.passed&&!testsRun.failed&&!testsRun.cancelled&&!testsRun.skipped;
const summary={
 generated_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},
 timeout_budgets_ms:{stage:childBudget,test_file:testBudget},runs,tests:testsRun,adapter_tests:adapter,total_offline_tests:testsRun.total+(adapter?.tests??0),
 live_models:{status:'NOT_EXECUTED',providers:['jev','kev','laya','decider','shisa','openjev'],reason:'Offline model/tokenizer fixtures only. Run test:live against each actual deployment.'},
 native_hosts:{status:'NOT_EXECUTED',reason:'Native host CLI doubles only; authenticated client sessions require local acceptance checks.'},
 all_executed_checks_green:allGreen,
};
await fs.writeFile(path.join(reports,'validation.json'),JSON.stringify(summary,null,2)+'\n');
if(process.env.GITHUB_STEP_SUMMARY){await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`## Offline validation — ${process.platform} / ${process.version}\n\n${runs.map(r=>`- ${r.name}: ${r.exit_code===0?'PASS':'FAIL'} (${r.elapsed_ms} ms)`).join('\n')}\n\nNode: ${testsRun.passed}/${testsRun.total}; Python: ${adapter?.tests??'not executed'}. Full logs are uploaded even on failure.\n`);}
if(!allGreen)process.exitCode=1;
