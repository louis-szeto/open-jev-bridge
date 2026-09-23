import {runHost,REPO_ROOT} from '../src/install.mjs';import fs from 'node:fs/promises';import path from 'node:path';
const results=[];
for(const [host,args] of [['claude',['--version']],['codex',['--version']],['claude',['plugin','validate',REPO_ROOT]],['claude',['mcp','get','open-jev-bridge']],['codex',['mcp','get','open-jev-bridge']]]){
 try{await runHost(host,args);results.push({host,check:args.join(' '),status:'passed'});}catch(e){results.push({host,check:args.join(' '),status:'failed',error:e.code,message:e.message});}
}
const report={generated_at:new Date().toISOString(),kind:'NATIVE_CLI_READINESS_AND_MANIFEST_CHECKS',results,notice:'This checks installed direct-mode MCP registrations and native Claude manifest validation. It does not claim that an authenticated host session executed hooks or that the experimental function API is enabled.'};
await fs.mkdir(path.join(REPO_ROOT,'reports'),{recursive:true});await fs.writeFile(path.join(REPO_ROOT,'reports','host-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(results.some(r=>r.status==='failed'))process.exitCode=1;
