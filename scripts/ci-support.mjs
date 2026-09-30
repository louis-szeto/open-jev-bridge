/** Pure CI reporting utilities. No platform-specific shell parsing or wall-clock assertions. */
export function durationSetting(value,fallback,name,{min=1000,max=1800000}={}) {
 if(value===undefined)return fallback;
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return n;
}
export function parseTap(text) {
 const read=name=>{const hits=[...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`,'gm'))];return hits.length?Number(hits.at(-1)[1]):0;};
 return {total:read('tests'),passed:read('pass'),failed:read('fail'),cancelled:read('cancelled'),skipped:read('skipped')};
}
export function failureExcerpt(log) {
 const lines=log.split('\n'),out=[];
 for(let i=0;i<lines.length;i++)if(/^\s*not ok\b|^ERROR:|^FAIL:|ERR_ASSERTION|Error:|^Traceback/.test(lines[i])) {
  out.push(...lines.slice(Math.max(0,i-1),Math.min(lines.length,i+30)));i+=29;
 }
 return (out.length?out.join('\n'):log.slice(-16000)).slice(0,24000);
}
