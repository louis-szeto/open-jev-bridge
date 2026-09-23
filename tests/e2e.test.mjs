import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {temp,ROOT,BIN,mockSystemOne,command,unverified,verified} from './helpers.mjs';
test('CLI install -> installed Stop command -> local HTTP -> block/verified allow -> uninstall',async t=>{
 const home=await temp(),s=await mockSystemOne();t.after(async()=>{await s.close();await fs.rm(home,{recursive:true,force:true});});
 const bin=path.join(home,'fake bin');await fs.mkdir(bin);for(const host of ['claude','codex']){await fs.copyFile(path.join(ROOT,'tests','fixtures','fake-host.mjs'),path.join(bin,host));await fs.chmod(path.join(bin,host),0o755);}
 const env={HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_STATE_HOME:path.join(home,'.state'),PATH:bin+path.delimiter+process.env.PATH,FAKE_HOST_STATE:path.join(home,'fake-state.json'),SYSTEM_ONE_URL:s.url};
 const installed=await command([BIN,'install','--host','both','--url',s.url],{env});assert.equal(installed.code,0,installed.stderr);
 const hooks=JSON.parse(await fs.readFile(path.join(home,'.codex','hooks.json'))),hook=hooks.hooks.Stop[0].hooks[0].command,transcript=path.join(home,'actual-session.jsonl');await fs.writeFile(transcript,unverified().map(x=>JSON.stringify(x)).join('\n'));
 let r=await command(['-c',hook],{command:'/bin/sh',env,input:{session_id:'e2e-1',transcript_path:transcript,cwd:home,hook_event_name:'Stop'}});assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).decision,'block');assert.equal(s.requests.length,1);
 await fs.writeFile(transcript,verified().map(x=>JSON.stringify(x)).join('\n'));r=await command(['-c',hook],{command:'/bin/sh',env,input:{session_id:'e2e-2',transcript_path:transcript,cwd:home,hook_event_name:'Stop'}});assert.deepEqual(JSON.parse(r.stdout),{});assert.equal(s.requests.length,2);
 // Execute precisely the MCP launch command registered by the installer.
 const registered=JSON.parse(await fs.readFile(env.FAKE_HOST_STATE)).servers.codex;
 const wire=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'e2e',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'}].map(x=>JSON.stringify(x)).join('\n')+'\n';
 r=await command(registered.args,{command:registered.command,env,input:wire});assert.equal(r.code,0,r.stderr);assert.equal(r.stdout.trim().split('\n').map(JSON.parse).find(x=>x.id===2).result.tools.length,14);
 const removed=await command([BIN,'uninstall','--host','both'],{env});assert.equal(removed.code,0,removed.stderr);assert.deepEqual(JSON.parse(await fs.readFile(env.FAKE_HOST_STATE)).servers,{});
});
test('Public CLI doctor exercises all three answer types on loopback contract fixture',async t=>{const s=await mockSystemOne();t.after(()=>s.close());const r=await command([BIN,'doctor','--url',s.url]);assert.equal(r.code,0,r.stderr);assert.equal(JSON.parse(r.stdout).status,'ok');assert.equal(s.requests.length,2);});
