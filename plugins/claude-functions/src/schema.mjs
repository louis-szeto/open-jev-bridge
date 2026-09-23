import {invariant, isRecord, own, probability, jsonSafe} from './pure.mjs';

// Small validator for exactly the JSON Schema subset emitted by this repository.
// Unsupported keywords are rejected by the build checker, never silently relied upon.
export function validate(schema, value, path = '$') {
  if (schema.anyOf) {
    for (const branch of schema.anyOf) { try { validate(branch, value, path); return value; } catch {} }
    invariant(false, `${path}: does not match any allowed shape`);
  }
  if (own(schema, 'const')) invariant(value === schema.const, `${path}: invalid constant`);
  if (schema.enum) invariant(schema.enum.includes(value), `${path}: invalid enum value`);
  const t = schema.type;
  if (t === 'object') {
    invariant(isRecord(value), `${path}: expected object`);
    const keys = Object.keys(value);
    invariant(keys.length >= (schema.minProperties ?? 0) && keys.length <= (schema.maxProperties ?? Infinity), `${path}: object size limit`);
    for (const k of schema.required ?? []) invariant(own(value,k), `${path}.${k}: required`);
    for (const k of keys) {
      if (own(schema.properties ?? {}, k)) validate(schema.properties[k], value[k], `${path}.${k}`);
      else if (schema.additionalProperties === false) invariant(false, `${path}: unknown key ${k}`);
      else if (isRecord(schema.additionalProperties)) validate(schema.additionalProperties, value[k], `${path}.${k}`);
    }
  } else if (t === 'array') {
    invariant(Array.isArray(value), `${path}: expected array`);
    invariant(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity), `${path}: array size limit`);
    value.forEach((x,i)=>validate(schema.items ?? {}, x, `${path}[${i}]`));
  } else if (t === 'string') {
    invariant(typeof value === 'string', `${path}: expected string`);
    invariant(value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity), `${path}: string length limit`);
  } else if (t === 'number' || t === 'integer') {
    invariant(typeof value === 'number' && Number.isFinite(value) && (t !== 'integer' || Number.isInteger(value)), `${path}: expected ${t}`);
    invariant(value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), `${path}: number out of range`);
  } else if (t === 'boolean') invariant(typeof value === 'boolean', `${path}: expected boolean`);
  else if (t === 'null') invariant(value === null, `${path}: expected null`);
  return value;
}
export const S = {
  str: (max = 50000, min = 1) => ({type:'string',minLength:min,maxLength:max}),
  num: (min=0,max=1) => ({type:'number',minimum:min,maximum:max}),
  int: (min=0,max=10000) => ({type:'integer',minimum:min,maximum:max}),
  obj: (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false}),
  arr: (items,min=1,max=250) => ({type:'array',items,minItems:min,maxItems:max}),
  bool: {type:'boolean'},
};
export function validateQuestions(questions, maxQuestions = 512) {
  invariant(isRecord(questions), 'questions must be an object');
  const entries = Object.entries(questions);
  invariant(entries.length > 0 && entries.length <= maxQuestions, 'question count out of range');
  for (const [id,q] of entries) {
    invariant(id.length > 0 && id.length <= 256, 'question id length out of range');
    invariant(isRecord(q) && ['noul','choice','score'].includes(q.type) && own(q,'instructions'), `Invalid question ${id}`);
    invariant(Object.keys(q).every(k=>['type','instructions','criteria'].includes(k)), `Unknown question field in ${id}`);
    jsonSafe(q.instructions);
    if (q.type === 'choice') invariant(isRecord(q.criteria) && Object.keys(q.criteria).length >= 1 && Object.keys(q.criteria).length <= 255, 'Choice requires 1..255 options');
    if (q.type === 'score') invariant(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 255, 'Score requires 2..255 ordered levels');
    if (q.type === 'noul' && q.criteria != null) invariant(isRecord(q.criteria) && Object.keys(q.criteria).every(k=>['true','false'].includes(k)), 'Noul criteria keys must be true/false');
    if (own(q,'criteria')) jsonSafe(q.criteria);
  }
  return questions;
}
export function validateRequest(request, maxQuestions = 512) {
  jsonSafe(request);
  invariant(isRecord(request) && own(request,'state'), 'state is required');
  invariant(typeof request.model === 'string' && request.model.length > 0 && request.model.length <= 200, 'model must be nonempty');
  invariant(Object.keys(request).every(k=>['state','model','questions'].includes(k)), 'Unknown System One request field');
  validateQuestions(request.questions, maxQuestions); return request;
}
// A symbol cannot be forged by a JSON response or appear in JSON/MCP output.
export const RESPONSE_RULES=Symbol('system-one-response-rules');
const bad = reason => ({ok:false, reason, value:null});
export function parseAnswer(q, answer, {rounded=true,decimals=2,requireConfidence=false} = {}) {
  if (!isRecord(answer) || answer.type !== q.type) return bad('missing or mismatched answer type');
  if (q.type === 'noul') return probability(answer.noul) ? {ok:true, value:answer} : bad('invalid noul probability');
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_,i)=>String(i));
  const p = answer.probabilities;
  if (!isRecord(p) || Object.keys(p).length !== keys.length || keys.some(k=>!own(p,k) || !probability(p[k]))) return bad('probability keys/values do not match criteria');
  // Legacy Kev rounds each probability to two decimals; current Kev/Laya use four. A strict sum=1
  // check incorrectly rejects legal large Choice distributions, even all-zero
  // rounded distributions with >200 options. Require interval feasibility.
  const eps = rounded ? 0.5*10**(-decimals)+1e-12 : 1e-9;
  const lower = keys.reduce((n,k)=>n+Math.max(0,p[k]-eps),0);
  const upper = keys.reduce((n,k)=>n+Math.min(1,p[k]+eps),0);
  if (lower > 1+1e-9 || upper < 1-1e-9) return bad('infeasible probability mass');
  if ((requireConfidence && answer.confidence == null) || (answer.confidence != null && !probability(answer.confidence))) return bad('invalid confidence');
  if (q.type === 'choice') {
    if (typeof answer.choice !== 'string' || !own(p, answer.choice)) return bad('choice not in criteria');
    if (p[answer.choice] < Math.max(...Object.values(p))-1e-9) return bad('choice is not a maximum');
  } else {
    if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length-1) return bad('score outside scale');
    if (!isRecord(answer.legend) || Object.keys(answer.legend).length !== keys.length || keys.some(k=>!own(answer.legend,k) || !validLegend(answer.legend[k],q.criteria[Number(k)]))) return bad('invalid score legend');
    // Compute achievable mean interval while imposing total probability mass=1.
    const bounds = (descending) => {
      const xs = keys.map((k,i)=>({i, lo:Math.max(0,p[k]-eps), hi:Math.min(1,p[k]+eps)}));
      let mass=1-xs.reduce((s,x)=>s+x.lo,0), mean=xs.reduce((s,x)=>s+x.i*x.lo,0);
      if (descending) xs.reverse();
      for (const x of xs) { const d=Math.max(0,Math.min(mass,x.hi-x.lo)); mean+=x.i*d; mass-=d; }
      return mean;
    };
    if (answer.score < bounds(false)-eps-1e-9 || answer.score > bounds(true)+eps+1e-9) return bad('score contradicts distribution');
  }
  return {ok:true, value:{...answer,confidence:answer.confidence ?? null}};
}
export function requireAnswers(questions, envelope) {
  invariant(isRecord(envelope) && isRecord(envelope.answers), 'Missing System One answers envelope', 'invalid_response');
  const values = {};
  for (const [id,q] of Object.entries(questions)) {
    const parsed = parseAnswer(q, envelope.answers[id], envelope[RESPONSE_RULES]);
    invariant(parsed.ok, `Invalid answer ${id}: ${parsed.reason}`, 'invalid_response');
    Object.defineProperty(values,id,{value:parsed.value,enumerable:true,writable:true,configurable:true});
  }
  return values;
}

// Jev/Kev render rubric legends as strings. Laya preserves structured criteria.
// Accept a non-string only when it is the supplied criterion, not invented metadata.
function validLegend(value,criterion){
 if(typeof value==='string')return true;
 const canonical=v=>Array.isArray(v)?v.map(canonical):isRecord(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 try{jsonSafe(value);return JSON.stringify(canonical(value))===JSON.stringify(canonical(criterion));}catch{return false;}
}
