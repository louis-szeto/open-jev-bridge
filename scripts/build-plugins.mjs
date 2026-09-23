import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../',import.meta.url));
export async function buildPlugins(){
 const target=path.join(root,'plugins','claude-functions');await fs.rm(target,{recursive:true,force:true});await fs.mkdir(path.join(target,'.claude-plugin'),{recursive:true});await fs.mkdir(path.join(target,'hooks'),{recursive:true});
 // Self-contained variant: no references may escape a plugin cache root.
 for(const name of ['src','bin','skills','agents'])await fs.cp(path.join(root,name),path.join(target,name),{recursive:true});
 await fs.copyFile(path.join(root,'.mcp.json'),path.join(target,'.mcp.json'));
 await fs.writeFile(path.join(target,'package.json'),JSON.stringify({name:'open-jev-bridge-functions',version:'0.3.0',private:true,type:'module',engines:{node:'>=22.16.0'}},null,2)+'\n');
 await fs.writeFile(path.join(target,'.claude-plugin','plugin.json'),JSON.stringify({name:'open-jev-bridge-functions',version:'0.3.0',description:'Opt-in configured System One verbatim compaction via Claude function hooks, completion Stop hook, and MCP tools',license:'MIT',hooks:['./hooks/commands.json','./hooks/functions.json']},null,2)+'\n');
 const standard=JSON.parse(await fs.readFile(path.join(root,'hooks','claude.json'),'utf8'));
 await fs.writeFile(path.join(target,'hooks','commands.json'),JSON.stringify({hooks:Object.fromEntries(Object.entries(standard.hooks).filter(([name])=>name!=='PreCompact'))},null,2)+'\n');
 await fs.writeFile(path.join(target,'hooks','functions.json'),'{"modules":["./system-one-functions.ts"]}\n');
 await fs.writeFile(path.join(target,'hooks','system-one-functions.ts'),"export {register} from '../src/function-hook.mjs';\n");
 const marketplaceFile=path.join(root,'.claude-plugin','marketplace.json');
 const marketplace=JSON.parse(await fs.readFile(marketplaceFile,'utf8'));
 marketplace.plugins=(marketplace.plugins??[]).filter(p=>p.name!=='open-jev-bridge-functions');
 marketplace.plugins.push({name:'open-jev-bridge-functions',source:'./plugins/claude-functions',description:'Opt-in Claude function-hook compaction plus Stop and MCP tools; requires supporting runtime'});
 await fs.writeFile(marketplaceFile,JSON.stringify(marketplace,null,2)+'\n');
 for(const name of ['LICENSE','NOTICE'])try{await fs.copyFile(path.join(root,name),path.join(target,name));}catch(e){if(e.code!=='ENOENT')throw e;}
 return target;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){console.log(await buildPlugins());}
