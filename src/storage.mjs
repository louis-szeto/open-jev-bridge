import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {invariant,BridgeError} from './pure.mjs';
export const sessionKey=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,32);
export async function privateDirectory(dir){
 await fs.mkdir(dir,{recursive:true,mode:0o700});const s=await fs.lstat(dir);invariant(s.isDirectory()&&!s.isSymbolicLink(),'Unsafe state directory');await fs.chmod(dir,0o700);
}
export async function readRegular(file,maxBytes,{tail=false}={}){
 const fd=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{const stat=await fd.stat();invariant(stat.isFile(),'Not a regular file');invariant(tail||stat.size<=maxBytes,'File exceeds size limit');const length=Math.min(stat.size,maxBytes),buffer=Buffer.alloc(length),start=tail?Math.max(0,stat.size-length):0;let got=0;while(got<length){const r=await fd.read(buffer,got,length-got,start+got);if(!r.bytesRead)break;got+=r.bytesRead;}return {text:buffer.subarray(0,got).toString('utf8'),truncated:start>0};}finally{await fd.close();}
}
export async function atomicJSON(file,value){
 await privateDirectory(path.dirname(file));
 try{const s=await fs.lstat(file);invariant(!s.isSymbolicLink()&&s.isFile(),'Unsafe output path');}catch(e){if(e.code!=='ENOENT')throw e;}
 const temp=`${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
 try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});const fd=await fs.open(temp,'r');try{await fd.sync();}finally{await fd.close();}await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}
export async function readJSON(file,fallback=null,maxBytes=4e6){try{return JSON.parse((await readRegular(file,maxBytes)).text);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function withLock(file,fn){
 await privateDirectory(path.dirname(file));let fd;
 try{fd=await fs.open(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new BridgeError('busy','State is locked; concurrent operation skipped');throw e;}
 try{await fd.writeFile(String(process.pid));return await fn();}finally{await fd.close();await fs.rm(file,{force:true});}
}
