/** Verify the ready-to-use bundle without rebuilding it and hiding stale release files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directories=['src','bin','skills','agents','licenses'];
async function entries(dir,prefix='') {
 const out=[];
 for(const e of await fs.readdir(dir,{withFileTypes:true})) {
  const rel=path.join(prefix,e.name);
  assert.ok(!e.isSymbolicLink(),`Bundle/source tree contains symlink: ${rel}`);
  if(e.isDirectory())out.push(...await entries(path.join(dir,e.name),rel));else out.push(rel);
 }
 return out.sort();
}
export async function verifyBundle(root) {
 const target=path.join(root,'plugins/claude-functions');
 const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 for(const name of directories) {
  const source=path.join(root,name),bundle=path.join(target,name);
  assert.deepEqual(await entries(bundle),await entries(source),`Bundled ${name} file list differs; run npm run build`);
  for(const rel of await entries(source))assert.ok((await fs.readFile(path.join(source,rel))).equals(await fs.readFile(path.join(bundle,rel))),`Stale bundled ${name}/${rel}; run npm run build`);
 }
 for(const name of ['.mcp.json','LICENSE','NOTICE'])assert.ok((await fs.readFile(path.join(root,name))).equals(await fs.readFile(path.join(target,name))),`Stale bundle ${name}`);
 for(const name of ['package.json','.claude-plugin/plugin.json'])assert.equal(JSON.parse(await fs.readFile(path.join(target,name),'utf8')).version,version,`Bundle ${name} version differs`);
 const hooks=JSON.parse(await fs.readFile(path.join(root,'hooks/claude.json'),'utf8'));
 const expected={hooks:Object.fromEntries(Object.entries(hooks.hooks).filter(([name])=>name!=='PreCompact'))};
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'hooks/commands.json'),'utf8')),expected,'Stale bundle command hooks');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'hooks/functions.json'),'utf8')),{modules:['./system-one-functions.ts']});
 assert.equal(await fs.readFile(path.join(target,'hooks/system-one-functions.ts'),'utf8'),"export {register} from '../src/function-hook.mjs';\n");
 return {version,verified:true};
}
