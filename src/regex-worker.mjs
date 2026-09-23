import {parentPort,workerData} from 'node:worker_threads';
// Only isolated regex evaluation: no user code compilation, eval, filesystem or network.
try {
  const {document,pattern,flags,maxCandidates=20,maxChars=2000}=workerData;
  if (typeof flags!=='string' || /[^imsu]/.test(flags) || new Set(flags).size!==flags.length) throw new Error('Allowed regex flags: i, m, s, u (each once)');
  const re=new RegExp(pattern,`${flags}g`),found=[],seen=new Set(); let partial=false,scanned=0,m;
  while ((m=re.exec(document))!==null) {
    if (++scanned>10000) {partial=true;break;}
    const value=m[0];
    if (value.length===0) { // Always advance a code point, including /u surrogate pairs.
      const n=document.codePointAt(re.lastIndex); re.lastIndex+=n>0xffff?2:1; continue;
    }
    if(value.length>maxChars){partial=true;continue;}
    if(!seen.has(value)) {
      if(found.length>=maxCandidates){partial=true;break;}
      seen.add(value);found.push({value,start:m.index,end:m.index+value.length});
    }
  }
  parentPort.postMessage({candidates:found,partial});
} catch { parentPort.postMessage({error:'invalid_regex',candidates:[],partial:true}); }
