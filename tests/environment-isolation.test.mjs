import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {command,isolatedEnv} from './helpers.mjs';

test('offline fixture children remove inherited provider credentials and host overrides, not explicit settings',()=>{
 const env=isolatedEnv({SYSTEM_ONE_PROVIDER:'decider',SYSTEM_ONE_API_KEY:'explicit-fixture'},
  {PATH:'/bin',HOME:'/real-home',SYSTEM_ONE_URL:'https://real-provider.invalid',SYSTEM_ONE_PROVIDER:'shisa',
   SYSTEM_ONE_API_KEY:'real-secret',SYSTEM_ONE_API_KEY_FILE:'/secret',OPEN_JEV_BRIDGE_ROOT:'/real',
   CLAUDE_CONFIG_DIR:'/real-claude',CODEX_HOME:'/real-codex',XDG_CONFIG_HOME:'/real-config',XDG_STATE_HOME:'/real-state'});
 assert.deepEqual(env,{PATH:'/bin',HOME:'/real-home',SYSTEM_ONE_PROVIDER:'decider',SYSTEM_ONE_API_KEY:'explicit-fixture'});
});

test('subprocess helper provides a disposable home and restores no persistent user configuration',async()=>{
 const out=await command(['-e','console.log(JSON.stringify({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,state:process.env.XDG_STATE_HOME}))']);
 assert.equal(out.code,0,out.stderr);const paths=JSON.parse(out.stdout);
 assert.notEqual(paths.home,process.env.HOME);assert.ok(paths.config.startsWith(paths.home));assert.ok(paths.state.startsWith(paths.home));
 await assert.rejects(fs.stat(paths.home),{code:'ENOENT'});
});
