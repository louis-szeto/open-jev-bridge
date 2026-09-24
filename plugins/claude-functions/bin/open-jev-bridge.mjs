#!/usr/bin/env node
import fs from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveConfig} from '../src/config.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {ToolService} from '../src/tools.mjs';
import {serveMcp} from '../src/mcp.mjs';
import {handleHook} from '../src/hooks.mjs';
import {automationStatus} from '../src/automation-status.mjs';
import {install,uninstall,runHost,REPO_ROOT} from '../src/install.mjs';
import {invariant,BridgeError} from '../src/pure.mjs';

export function parseArgs(argv){
 const [command='help',...rest]=argv,options={};
 const values=new Set(['host','url','model','provider','shisa-backend','api-key-file','event','name','file']),booleans=new Set(['allow-remote','aliases','shadow']);
 for(let i=0;i<rest.length;i++){const key=rest[i].replace(/^--/,'');invariant(rest[i].startsWith('--')&&(values.has(key)||booleans.has(key)),`Unknown option ${rest[i]}`);invariant(!(key in options),`Duplicate option ${key}`);if(booleans.has(key))options[key]=true;else{invariant(rest[i+1]!==undefined&&!rest[i+1].startsWith('--'),`Missing value for ${key}`);options[key]=rest[++i];}}
 return {command,options};
}
async function inputJSON(options,max=4000000){
 let text='';const decoder=new StringDecoder('utf8');if(options.file){const {readRegular}=await import('../src/storage.mjs');text=(await readRegular(options.file,max)).text;}else for await(const chunk of process.stdin){text+=decoder.write(chunk);invariant(Buffer.byteLength(text)<=max,'Input exceeds byte limit');}
 if(!options.file)text+=decoder.end();
 try{return JSON.parse(text);}catch{throw new BridgeError('invalid_input','Expected JSON on stdin or --file');}
}
export async function main(argv=process.argv.slice(2)){
 const {command,options}=parseArgs(argv),overrides={};
 for(const [flag,key] of [['shisa-backend','shisaBackend'],['provider','provider'],['api-key-file','apiKeyFile'],['url','url'],['model','model'],['allow-remote','allowRemote'],['aliases','aliases'],['shadow','shadow']])if(options[flag]!==undefined)overrides[key]=options[flag];
 const print=x=>process.stdout.write(JSON.stringify(x,null,2)+'\n');
 if(command==='help'||command==='--help'){
  process.stdout.write(`open-jev-bridge 0.4.1 — provider-neutral System One MCP and hooks\n\nCommands:\n  serve                         Start stdio MCP\n  install --host both           Install MCP, skills and stable hooks via host CLIs\n  uninstall --host both         Remove only this installation's integrations\n  doctor                        Check /v1/models and all three API answer types\n  automation-status --host both Inspect installed hooks and recent automatic observations\n  call --name system_one_verify        Tool arguments as JSON on stdin or --file\n  compact                       {messages,options?} as JSON on stdin or --file\n  hook --host codex --event Stop Hook JSON on stdin (normally host-managed)\n  native-claude                  Install default Claude plugin via local marketplace\n  native-claude-functions        Install opt-in true-compaction Claude function plugin\n\nConnection flags: --url http://127.0.0.1:8009 --model kev-latest --allow-remote\nProvider: --provider generic|jev|kev|laya|decider|shisa; secret file: --api-key-file /absolute/private/key\nShisa server: --shisa-backend vllm|llamacpp (or SYSTEM_ONE_SHISA_BACKEND)\nOther flags: --aliases --shadow\nNode >=22.16; no runtime dependencies. Read README before native installation.\n`);return;
 }
 if(command==='install'){print(await install({host:options.host??'both',overrides}));return;}
 if(command==='uninstall'){print(await uninstall({host:options.host??'both'}));return;}
 if(command==='native-claude'||command==='native-claude-functions'){
  // Native installation is an alternative to direct install, never combined with it.
  if(command==='native-claude-functions'){const {buildPlugins}=await import('../scripts/build-plugins.mjs');await buildPlugins();}
  const config=resolveConfig(),{readJSON}=await import('../src/storage.mjs'),receipt=await readJSON(path.join(config.dataDir,'installation.json'),{hosts:{}});invariant(!receipt.hosts?.claude,'Uninstall the direct Claude integration before native plugin installation');
  invariant(Object.keys(overrides).length===0,'Use SYSTEM_ONE_URL / SYSTEM_ONE_MODEL / SYSTEM_ONE_ALLOW_REMOTE environment variables for native plugins');
  await runHost('claude',['plugin','marketplace','add',REPO_ROOT]);
  const name=command.endsWith('-functions')?'open-jev-bridge-functions':'open-jev-bridge';
  await runHost('claude',['plugin','install',`${name}@open-jev-bridge-local`,'--scope','user']);
  print({installed:name,next:command.endsWith('-functions')?'Launch supported Claude with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. Enable only this variant; see README compatibility limits.':'Restart Claude. Do not also enable the function variant or direct hooks.'});return;
 }
 const config=resolveConfig(overrides);
 if(command==='hook'){
  // A hook must never accidentally block the host on any setup/JSON error.
  try{const output=await handleHook(options.event,await inputJSON(options),config,{host:options.host??'claude',log:s=>process.stderr.write(s+'\n')});if(options.event==='TaskCompleted'&&output.decision==='block'){process.stderr.write(output.reason+'\n');process.exitCode=2;}else print(output);}catch{print({});}return;
 }
 if(command==='automation-status'){const report=await automationStatus(config,{host:options.host??'both'});print(report);if(!report.configured)process.exitCode=1;return;}
 const client=new SystemOneClient(config),service=new ToolService(client,config);
 if(command==='serve'){await serveMcp(service);return;}
 if(command==='call'){invariant(options.name,'--name is required');print(await service.call(options.name,await inputJSON(options)));return;}
 if(command==='compact'){print(await service.call('system_one_compact',await inputJSON(options)));return;}
 if(command==='doctor'){
  const status=await service.call('system_one_status',{}),probe=await service.call('system_one_query',{state:'The label is blue. There are two items.',questions:{yes:{type:'noul',instructions:'Is the label blue?'},color:{type:'choice',instructions:'What is the label?',criteria:{blue:null,red:null}},count:{type:'score',instructions:'How many items?',criteria:['zero','one','two']}}});
  print({status:'ok',provider:config.provider,...(config.provider==='shisa'?{shisa_backend:config.shisaBackend}:{}),models:status.models,contract_probe:'all three response types validated',answers:probe.answers,notice:'A successful API probe is not a model-quality or native-host certification.'});return;
 }
 throw new BridgeError('invalid_input',`Unknown command ${command}`);
}
// realpath handles invocation through npm's symlinked bin shims.
if(process.argv[1]&&await fs.realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
 main().catch(error=>{if(process.argv[2]==='hook'){process.stdout.write('{}\n');process.stderr.write('open-jev-bridge: invalid hook configuration; bypassed\n');return;}process.stderr.write(`open-jev-bridge: ${error instanceof BridgeError?error.message:'Operation failed; check configuration and input'}\n`);process.exitCode=1;});
}
