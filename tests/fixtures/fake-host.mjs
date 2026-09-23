#!/usr/bin/env node
// Integration-test host CLI double, not a real Claude or Codex process.
import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),host=path.basename(process.argv[1]),file=process.env.FAKE_HOST_STATE;
let state={};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
state.calls??=[];state.calls.push({host,args});state.servers??={};
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
if(args[0]==='--version'){save();console.log(`${host} offline-double 1`);process.exit(0);}
if(args[0]!=='mcp'){save();process.exit(2);}
if(args[1]==='get'){save();if(!state.servers[host]){console.error('No MCP server named open-jev-bridge found');process.exit(1);}console.log(JSON.stringify(state.servers[host]));}
else if(args[1]==='add'){const i=args.indexOf('--');state.servers[host]={command:args[i+1],args:args.slice(i+2)};save();}
else if(args[1]==='remove'){delete state.servers[host];save();}else{save();process.exit(2);}
