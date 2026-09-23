/** A host-event driver executes the exact installed shell commands. The host
 * executables are explicit doubles; HTTP and every hook subprocess are real.
 * No test here invokes a manual MCP judgment to manufacture automatic behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {temp,ROOT,BIN,mockSystemOne,command,history,unverified,envelope} from './helpers.mjs';
import {register} from '../src/function-hook.mjs';
import {automationPaths} from '../src/automation.mjs';
import {resolveConfig} from '../src/config.mjs';
import {buildPlugins} from '../scripts/build-plugins.mjs';

async function installed(t,host) {
 const home=await temp(),server=await mockSystemOne();
 t.after(async()=>{await server.close();await fs.rm(home,{recursive:true,force:true});});
 const fakebin=path.join(home,"fake host's bin");await fs.mkdir(fakebin);
 for(const name of ['claude','codex']) {await fs.copyFile(path.join(ROOT,'tests/fixtures/fake-host.mjs'),path.join(fakebin,name));await fs.chmod(path.join(fakebin,name),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:fakebin+path.delimiter+process.env.PATH,
  FAKE_HOST_STATE:path.join(home,'host-state.json')};
 const result=await command([BIN,'install','--host',host,'--url',server.url],{env});assert.equal(result.code,0,result.stderr);
 const hooks=JSON.parse(await fs.readFile(path.join(home,host==='claude'?'.claude/settings.json':'.codex/hooks.json'))).hooks;
 const payload={session_id:'event-only-e2e',cwd:home};
 const fire=(event,extra={})=>command(['-c',hooks[event][0].hooks[0].command],{command:'/bin/sh',env,input:{...payload,...extra,hook_event_name:event}});
 return {home,env,server,hooks,payload,fire};
}
const edit={tool_name:'apply_patch',tool_use_id:'write-1',tool_input:{command:'*** Begin Patch\n*** Update File: parser.js\n@@\n-return a;\n+return b;\n*** End Patch'}};
const check={tool_name:'Bash',tool_use_id:'test-1',tool_input:{command:'npm test'}};
for(const host of ['claude','codex'])test(`${host} installed lifecycle: automatic verification, repair, gate, screen, compact and recover`,async t=>{
 const x=await installed(t,host);
 const first=await x.fire('SessionStart',{source:'startup'});assert.equal(first.code,0);assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext,/proactively/);
 await x.fire('UserPromptSubmit',{prompt:'Fix the parser return value from a to b',turn_id:'turn1'});
 await x.fire('PreToolUse',edit);await x.fire('PostToolUse',{...edit,tool_response:'Patch applied'});
 assert.equal(x.server.requests.length,0);
 const completion=await x.fire('Stop',{last_assistant_message:'Implemented and verified. All tests passed.'});assert.equal(completion.code,0);
 const blocked=JSON.parse(completion.stdout);assert.equal(blocked.decision,'block');assert.equal(x.server.requests.length,1);
 assert.equal(x.server.requests[0].url,'/v1/systemone');assert.ok(x.server.requests[0].body.questions.claims_done);
 await x.fire('UserPromptSubmit',{prompt:blocked.reason,turn_id:'continuation'});
 await x.fire('PreToolUse',check);await x.fire('PostToolUse',{...check,tool_response:{stdout:'5 passed',exit_code:0}});
 const checked=await x.fire('Stop',{stop_hook_active:true,last_assistant_message:'Done. Changed the return value to b. npm test: 5 passed.'});
 assert.equal(checked.code,0);assert.deepEqual(JSON.parse(checked.stdout),{});assert.equal(x.server.requests.length,2);
 const gate=x.server.requests[1].body;assert.ok(gate.questions.correctness);assert.ok(gate.questions.claim0);assert.match(JSON.stringify(gate.state.evidence),/5 passed/);
 const fetch={tool_name:'mcp__web__fetch',tool_use_id:'fetch1',tool_input:{url:'https://fixture.invalid'}};
 await x.fire('PreToolUse',fetch);const screened=await x.fire('PostToolUse',{...fetch,tool_response:{content:[{type:'text',text:'The parser returns b.'}]}});
 assert.match(JSON.parse(screened.stdout).hookSpecificOutput.additionalContext,/screen: pass/);assert.equal(x.server.requests.length,3);
 const transcript=path.join(x.home,'full-host-transcript.jsonl');const original=history(10,2000).map(JSON.stringify).join('\n');await fs.writeFile(transcript,original);
 const compact=await x.fire('PreCompact',{transcript_path:transcript,trigger:'auto'});assert.equal(compact.code,0);assert.deepEqual(JSON.parse(compact.stdout),{});
 assert.equal(await fs.readFile(transcript,'utf8'),original);assert.ok(x.server.requests.length>3);
 const recovered=await x.fire('SessionStart',{source:'compact'});assert.equal(recovered.code,0);
 assert.match(JSON.parse(recovered.stdout).hookSpecificOutput.additionalContext,/No history was replaced/);
 const status=await command([BIN,'automation-status','--host',host],{env:x.env});assert.equal(status.code,0,status.stderr);
 const report=JSON.parse(status.stdout);assert.equal(report.configured,true);assert.equal(report.recent[0].status,'checkpoint_restored');assert.match(report.hosts[0].trust,/not_verified/);
});

test('Claude installed TaskCompleted emits exit 2 and stderr, not an unsupported JSON decision',async t=>{
 const x=await installed(t,'claude');await x.fire('UserPromptSubmit',{prompt:'Fix the parser'});await x.fire('PreToolUse',edit);await x.fire('PostToolUse',{...edit,tool_response:'Updated'});
 const r=await x.fire('TaskCompleted',{task_id:'one',task_subject:'Fix parser'});
 assert.equal(r.code,2);assert.equal(r.stdout,'');assert.match(r.stderr,/No passing check/);assert.equal(x.server.requests.length,1);
});

for(const host of ['claude','codex'])test(`${host} installed SubagentStop checks child evidence rather than certified parent`,async t=>{
 const x=await installed(t,host);const child=path.join(x.home,'child-transcript.jsonl');await fs.writeFile(child,unverified().map(JSON.stringify).join('\n'));
 const r=await x.fire('SubagentStop',{agent_id:'worker-a',agent_type:'worker',agent_transcript_path:child,last_assistant_message:'Done. It is implemented.'});
 assert.equal(r.code,0);assert.equal(JSON.parse(r.stdout).decision,'block');assert.equal(x.server.requests.length,1);
});

test('Claude function turn-complete callback -> real HTTP -> replacement, without a manual compact request',async t=>{
 const server=await mockSystemOne();t.after(()=>server.close());const callbacks={};
 register((event,callback)=>callbacks[event]=callback,{url:server.url,preserveRecentMessages:2,compactAtPercent:60});
 let replacement=null,compactions=0,natives=0;
 const messages=history(8,2000),$={env:{get:async()=>undefined},ui:{log(){}},http:{fetch:async(url,init)=>{const r=await fetch(url,init);return {ok:r.ok,status:r.status,text:await r.text()};}},
  session:{usage:async()=>({context:{percent:70}}),compact:async()=>{compactions++;replacement=await callbacks['session.compact']($,{messages},()=>{natives++;return {messages};});}}};
 await callbacks['turn.complete']($,{},()=>{});
 assert.equal(compactions,1);assert.equal(natives,0);assert.ok(server.requests.length>0);
 assert.ok(JSON.stringify(replacement.messages).length<JSON.stringify(messages).length);
 assert.equal(replacement.messages[0].text,messages[0].text);
});

test('Reinstall refreshes old owned hooks and skills without adding duplicate MCP servers',async t=>{
 const x=await installed(t,'codex'),hookFile=path.join(x.home,'.codex/hooks.json'),receiptFile=path.join(x.home,'.state/open-jev-bridge/installation.json');
 const old=JSON.parse(await fs.readFile(hookFile));old.hooks={Stop:old.hooks.Stop,PreCompact:old.hooks.PreCompact,SessionStart:old.hooks.SessionStart};old.hooks.SessionStart[0].matcher='compact';
 old.hooks.Stop.push({hooks:[{type:'command',command:'echo unrelated'}]});await fs.writeFile(hookFile,JSON.stringify(old));
 const receipt=JSON.parse(await fs.readFile(receiptFile));const entry=receipt.hosts.codex;entry.version='0.2.0';entry.entries={Stop:old.hooks.Stop[0],PreCompact:old.hooks.PreCompact[0],SessionStart:old.hooks.SessionStart[0]};await fs.writeFile(receiptFile,JSON.stringify(receipt));
 const before=await fs.readFile(x.env.FAKE_HOST_STATE,'utf8');const result=await command([BIN,'install','--host','codex'],{env:x.env});assert.equal(result.code,0,result.stderr);
 assert.equal(await fs.readFile(x.env.FAKE_HOST_STATE,'utf8'),before);
 const upgraded=JSON.parse(await fs.readFile(hookFile));assert.ok(upgraded.hooks.PreToolUse);assert.ok(upgraded.hooks.SubagentStop);
 assert.equal(upgraded.hooks.SessionStart.length,1);assert.equal(upgraded.hooks.SessionStart[0].matcher,undefined);
 assert.equal(upgraded.hooks.Stop.length,2);assert.equal(upgraded.hooks.Stop[0].hooks[0].command,'echo unrelated');
 const status=await command([BIN,'automation-status','--host','codex'],{env:x.env});assert.equal(status.code,0);
});

test('Upgrade refuses to overwrite user-edited installed skills',async t=>{
 const x=await installed(t,'claude'),skill=path.join(x.home,'.claude/skills/system-one-judgments/SKILL.md'),before=await fs.readFile(path.join(x.home,'.claude/settings.json'),'utf8');
 await fs.appendFile(skill,'\nUser-authored content.\n');const result=await command([BIN,'install','--host','claude'],{env:x.env});
 assert.equal(result.code,1);assert.match(result.stderr,/user edits/);assert.equal(await fs.readFile(path.join(x.home,'.claude/settings.json'),'utf8'),before);
 assert.match(await fs.readFile(skill,'utf8'),/User-authored content/);
});

test('Environment-selected nonsecret endpoint persists for filtered host environments',async t=>{
 const x=await installed(t,'codex');const cfg=JSON.parse(await fs.readFile(path.join(x.home,'.config/open-jev-bridge/config.json')));
 assert.equal(cfg.url,x.server.url);assert.equal(cfg.apiKey,undefined);assert.equal(cfg.autoReview,true);
});

test('Generated optional Claude plugin includes the same automatic workflow without duplicate checkpoint compaction',async t=>{
 await buildPlugins();t.after(async()=>{await fs.rm(path.join(ROOT,'plugins','claude-functions'),{recursive:true,force:true});const file=path.join(ROOT,'.claude-plugin','marketplace.json');const marketplace=JSON.parse(await fs.readFile(file,'utf8'));marketplace.plugins=(marketplace.plugins??[]).filter(p=>p.name!=='open-jev-bridge-functions');await fs.writeFile(file,JSON.stringify(marketplace,null,2)+'\n');});
 const config=JSON.parse(await fs.readFile(path.join(ROOT,'plugins/claude-functions/hooks/commands.json')));
 for(const key of ['Stop','TaskCompleted','SubagentStop','PreToolUse','PostToolUse','UserPromptSubmit','SessionStart'])assert.ok(config.hooks[key]);
 assert.equal(config.hooks.PreCompact,undefined);
});
