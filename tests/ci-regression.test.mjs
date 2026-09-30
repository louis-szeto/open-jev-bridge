import test from 'node:test';
import assert from 'node:assert/strict';
import {mcpProcess,mockSystemOne,waitFor,isolatedEnv} from './helpers.mjs';
import {parseTap,failureExcerpt,durationSetting} from '../scripts/ci-support.mjs';

test('CI regression: already-exited MCP children have idempotent cleanup',async t=>{
 const s=await mockSystemOne();t.after(()=>s.close());const m=await mcpProcess(s.url);t.after(()=>m.close());
 m.child.kill('SIGTERM');await m.closed;await m.close();await m.close();
 await assert.rejects(m.request('ping'),/exited/);
});
test('CI regression: termination rejects outstanding protocol requests promptly',async t=>{
 const s=await mockSystemOne(()=>{});t.after(()=>s.close());const m=await mcpProcess(s.url);t.after(()=>m.close());
 const p=m.request('tools/call',{name:'system_one_query',arguments:{state:'s',questions:{q:{type:'noul',instructions:'Q?'}}}});
 const rejected=assert.rejects(p,/exited|closed/);await waitFor(()=>s.requests.length===1);m.child.kill('SIGTERM');await rejected;
});
test('CI event waits tolerate delayed scheduling without an arbitrary 30ms assumption',async()=>{
 let ready=false;const timer=setTimeout(()=>{ready=true;},75);
 try{await waitFor(()=>ready,{timeout:1000});assert.equal(ready,true);}finally{clearTimeout(timer);}
});
test('CI failed waits fail explicitly instead of becoming silent skips',async()=>{
 await assert.rejects(waitFor(()=>false,{timeout:15,interval:2,message:'missing event'}),/missing event/);
});
test('CI parsing selects summary counts, not nested TAP or stale defaults',()=>{
 assert.deepEqual(parseTap('  # tests 7\n# tests 100\n# pass 99\n# fail 1\n# cancelled 0\n# skipped 0\n'),{total:100,passed:99,failed:1,cancelled:0,skipped:0});
 assert.equal(parseTap('').total,0);
});
test('CI first failure is surfaced even when the successful tail is long',()=>{
 const log='not ok 2 - early failure\n  error: Bad format\n'+('ok - pass\n'.repeat(10000));
 assert.match(failureExcerpt(log),/early failure/);assert.ok(failureExcerpt(log).length<=24000);
});
test('CI duration limits cannot disable timeouts or accept nonnumeric values',()=>{
 assert.equal(durationSetting(undefined,1000,'test'),1000);
 for(const x of ['Infinity','0','-1','no','1000.5','1800001'])assert.throws(()=>durationSetting(x,1000,'test'));
 assert.equal(durationSetting('120000',1,'test'),120000);
});
test('CI child environment never inherits local OpenJev server secrets',()=>{
 const env=isolatedEnv({SYSTEM_ONE_PROVIDER:'openjev'},{OPENJEV_TOKEN:'secret',OPENJEV_UPSTREAM_TOKEN:'secret',SYSTEM_ONE_API_KEY:'secret',PATH:'/bin'});
 assert.deepEqual(env,{PATH:'/bin',SYSTEM_ONE_PROVIDER:'openjev'});
});

// Source integrity checking must not fix the thing it is supposed to validate.
test('CI bundled provider modules are checked without regenerating source',async()=>{
 const {verifyBundle}=await import('../scripts/bundle-integrity.mjs');
 const {ROOT}=await import('./helpers.mjs');
 assert.equal((await verifyBundle(ROOT)).verified,true);
});
