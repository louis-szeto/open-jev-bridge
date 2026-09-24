import {readFileSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {PROVIDERS} from './providers.mjs';
import {serviceEndpoints} from './endpoints.mjs';
import {invariant, isRecord} from './pure.mjs';

export const DEFAULTS = Object.freeze({
  url:'http://127.0.0.1:8009', model:'kev-latest', provider:'generic', allowRemote:false,
  timeoutMs:20000, maxRequestBytes:1000000, maxResponseBytes:2000000,
  maxConcurrent:2, maxQueue:32, retries:0, breakerFailures:5, breakerCooldownMs:5000,
  aliases:false, belayThreshold:.7, shadow:false, maxTranscriptBytes:16000000,
  maxStateTokens:6000, maxRequestTokens:7600, preserveRecentMessages:6,
  keepThreshold:.5, truncateHeadChars:300, minReductionRatio:.25,
  maxBlocks:3, blockCooldownMs:60000, checkpointTtlMs:3600000,
  maxCheckpointBytes:4000000, compactAtPercent:60,
  autoVerify:true, autoReview:true, autoScreen:true, autoCompaction:true,
  maxEventBytes:32768, maxEvidenceBytes:1000000, maxEvidenceEvents:512,
  evidenceTtlMs:86400000, screenMaxChars:3000,
  shisaBackend:'vllm', shisaTopLogprobs:20, shisaMaxPromptTokens:32768,
  shisaNoulTemperature:1, shisaChoiceTemperature:1, shisaScoreTemperature:1
});
export const endpoint = serviceEndpoints;
export function paths(env = process.env) {
  const home=env.HOME || homedir();
  return {home, config:env.OPEN_JEV_BRIDGE_CONFIG || join(env.XDG_CONFIG_HOME || join(home,'.config'),'open-jev-bridge','config.json'),
    data:env.OPEN_JEV_BRIDGE_DATA || join(env.XDG_STATE_HOME || join(home,'.local','state'),'open-jev-bridge')};
}
export function resolveConfig(overrides = {}, env = process.env, {readFile=true} = {}) {
  let file={}; const p=paths(env);
  if (readFile) { try { file=JSON.parse(readFileSync(p.config,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; } }
  invariant(isRecord(file) && isRecord(overrides), 'Configuration must be an object');
  for(const k of [...Object.keys(file),...Object.keys(overrides)]) invariant(Object.hasOwn(DEFAULTS,k) || ['apiKey','apiKeyFile','dataDir'].includes(k), `Unknown configuration key: ${k}`);
  const fromEnv={};
  const variables={SYSTEM_ONE_SHISA_BACKEND:'shisaBackend',SYSTEM_ONE_SHISA_TOP_LOGPROBS:'shisaTopLogprobs',SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS:'shisaMaxPromptTokens',SYSTEM_ONE_SHISA_NOUL_TEMPERATURE:'shisaNoulTemperature',SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE:'shisaChoiceTemperature',SYSTEM_ONE_SHISA_SCORE_TEMPERATURE:'shisaScoreTemperature',SYSTEM_ONE_AUTO_VERIFY:'autoVerify',SYSTEM_ONE_AUTO_REVIEW:'autoReview',SYSTEM_ONE_AUTO_SCREEN:'autoScreen',SYSTEM_ONE_AUTO_COMPACTION:'autoCompaction',SYSTEM_ONE_COMPACT_AT_PERCENT:'compactAtPercent',SYSTEM_ONE_PROVIDER:'provider',SYSTEM_ONE_API_KEY_FILE:'apiKeyFile',SYSTEM_ONE_URL:'url',SYSTEM_ONE_MODEL:'model',SYSTEM_ONE_API_KEY:'apiKey',SYSTEM_ONE_TIMEOUT_MS:'timeoutMs',SYSTEM_ONE_ALLOW_REMOTE:'allowRemote',SYSTEM_ONE_JEV_ALIASES:'aliases',SYSTEM_ONE_BELAY_SHADOW:'shadow'};
  for(const [k,target] of Object.entries(variables)) if(env[k] !== undefined && env[k] !== '') {
    const value=env[k];
    if(typeof DEFAULTS[target] === 'boolean') { invariant(['true','false','1','0'].includes(value),`Invalid boolean ${k}`); fromEnv[target]=value==='true'||value==='1'; }
    else if(typeof DEFAULTS[target] === 'number') fromEnv[target]=Number(value);
    else fromEnv[target]=value;
  }
  const c={...DEFAULTS,...file,...fromEnv,...overrides,dataDir:overrides.dataDir ?? file.dataDir ?? p.data};
  if(c.shisaBackend==='llama.cpp')c.shisaBackend='llamacpp';
  invariant(['vllm','llamacpp'].includes(c.shisaBackend),'shisaBackend must be vllm or llamacpp');
  endpoint(c.url,c.allowRemote,c.provider);
  invariant(PROVIDERS.includes(c.provider),'Invalid provider; use generic, jev, kev, laya, decider or shisa');
  if(c.apiKeyFile!==undefined){invariant(typeof c.apiKeyFile==='string'&&isAbsolute(c.apiKeyFile),'apiKeyFile must be an absolute path');if(!c.apiKey)c.apiKey=readSecret(c.apiKeyFile);}
  invariant(typeof c.model==='string' && c.model.length>0 && c.model.length<=200,'Invalid model');
  for(const key of ['allowRemote','aliases','shadow','autoVerify','autoReview','autoScreen','autoCompaction']) invariant(typeof c[key]==='boolean',`Invalid ${key}`);
  for(const key of ['keepThreshold','minReductionRatio','belayThreshold']) invariant(Number.isFinite(c[key])&&c[key]>=0&&c[key]<=1,`Invalid ${key}`);
  for(const key of Object.keys(DEFAULTS).filter(k=>typeof DEFAULTS[k]==='number' && !['keepThreshold','minReductionRatio','belayThreshold','shisaNoulTemperature','shisaChoiceTemperature','shisaScoreTemperature'].includes(k))) {
    invariant(Number.isSafeInteger(c[key]) && c[key]>=0,`Invalid integer ${key}`);
  }
  for(const k of ['shisaNoulTemperature','shisaChoiceTemperature','shisaScoreTemperature']) invariant(Number.isFinite(c[k])&&c[k]>=.01&&c[k]<=100,`Invalid ${k}`);
  invariant(c.shisaTopLogprobs>=1&&c.shisaTopLogprobs<=100,'shisaTopLogprobs must be 1..100');
  invariant(c.shisaMaxPromptTokens>=64&&c.shisaMaxPromptTokens<=262144,'Invalid shisaMaxPromptTokens');
  invariant(c.timeoutMs>=1&&c.timeoutMs<=300000,'timeoutMs must be 1..300000');
  invariant(c.maxConcurrent>=1&&c.maxConcurrent<=16&&c.maxQueue<=256,'Concurrency limits invalid');
  invariant(c.retries<=2&&c.breakerFailures>=1&&c.breakerCooldownMs>=1,'Retry/breaker limits invalid');
  invariant(c.maxRequestBytes>=128&&c.maxRequestBytes<=16000000&&c.maxResponseBytes>=128&&c.maxResponseBytes<=16000000,'HTTP size limits invalid');
  invariant(c.maxTranscriptBytes>=1024&&c.maxTranscriptBytes<=64000000,'Transcript limit invalid');
  invariant(c.maxStateTokens>=256&&c.maxRequestTokens>=c.maxStateTokens+256&&c.maxRequestTokens<=64000,'Compaction budgets invalid');
  invariant(c.compactAtPercent>=10&&c.compactAtPercent<=95,'compactAtPercent must be 10..95');
  invariant(c.maxEventBytes>=1024&&c.maxEventBytes<=262144&&c.maxEvidenceBytes>=4096&&c.maxEvidenceBytes<=4000000,'Evidence byte limits invalid');
  invariant(c.maxEvidenceEvents>=4&&c.maxEvidenceEvents<=4096&&c.evidenceTtlMs>=1000&&c.screenMaxChars>=128&&c.screenMaxChars<=10000,'Automation limits invalid');
  invariant(typeof c.dataDir==='string'&&c.dataDir.length>0,'Invalid dataDir');
  if(c.apiKey!==undefined) invariant(typeof c.apiKey==='string'&&c.apiKey.length<=16384&&!/[\r\n]/.test(c.apiKey),'Invalid API key');
  return c;
}

/** Bounded, no-symlink secret-file read; used when the host does not forward environment secrets. */
export function readSecret(filename){
 let fd;
 try{
  fd=openSync(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  const stat=fstatSync(fd);invariant(stat.isFile()&&stat.size>0&&stat.size<=16384,'API key file must be a nonempty regular file of at most 16384 bytes');
  if(process.platform!=='win32')invariant((stat.mode&0o077)===0,'API key file must not be group/world accessible; use chmod 600');
  const buffer=Buffer.alloc(16385);const count=readSync(fd,buffer,0,buffer.length,0);
  invariant(count>0&&count<=16384,'Invalid API key file length');
  const secret=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count)).trim();
  invariant(secret.length>0&&!/[\r\n]/.test(secret),'API key file must contain a single nonempty line');return secret;
 }finally{if(fd!==undefined)closeSync(fd);}
}
