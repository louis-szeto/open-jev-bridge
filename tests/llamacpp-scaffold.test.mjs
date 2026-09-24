/** Regression for a live GGUF /apply-template output that differs from Shisa's
 * measured scaffold. HTTP/subprocesses are real; tokens/logits are explicit fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {llamaHttp,llamaEncode,llamaDecode} from './fixtures/llamacpp-http.mjs';
import {SystemOneClient} from '../src/client.mjs';
import {validateLlamaScaffold,SHISA_CONTROL_MARKERS} from '../src/shisa-llamacpp.mjs';
import {shisaScaffold} from '../src/shisa.mjs';
import {requireAnswers} from '../src/schema.mjs';
import {BIN,command,mcpProcess,TOOL_INPUTS} from './helpers.mjs';
const qs={n:{type:'noul',instructions:'Is blue present?'},c:{type:'choice',instructions:'Choose',criteria:{blue:null,red:null}},s:{type:'score',instructions:'Rate',criteria:['poor','fair','good']}};
async function fixture(t,opts){const s=await llamaHttp(opts);t.after(async()=>{await s.close();assert.deepEqual(s.errors,[]);});return s;}
const client=s=>new SystemOneClient({provider:'shisa',shisaBackend:'llamacpp',model:'shisa-de-1',url:s.url});
const env=s=>({SYSTEM_ONE_PROVIDER:'shisa',SYSTEM_ONE_SHISA_BACKEND:'llamacpp',SYSTEM_ONE_URL:s.url,SYSTEM_ONE_MODEL:'shisa-de-1'});
const templateVariants={
 missing_generation_suffix:p=>p.replace('<|channel>thought\n<channel|>',''),
 different_thinking_mode:p=>p.replace('<|turn>system\n','<|turn>system\n<|think|>\n'),
 extra_trailing_newline:p=>p+'\n',
 older_gemma_renderer:p=>p.replaceAll('<|turn>','<start_of_turn>').replaceAll('<turn|>','<end_of_turn>'),
 missing_prompt:()=>null,
 unavailable_route:()=>404,
};
for(const [name,change]of Object.entries(templateVariants))test(`Raw scaffold ignores unrelated /apply-template variant: ${name}`,async t=>{
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url==='/apply-template'){const x=change(o.prompt);if(x===404)return {httpStatus:404};if(x===null)return {};o.prompt=x;}}});
 // Show explicitly that the old compare-to-template guard would not pass. Use
 // fixed diagnostic evidence, not a user's transcript, for this reproduction.
 const sc=shisaScaffold('s',qs.n);
 const old=await fetch(s.url+'/apply-template',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:sc.messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false}})});
 const rendered=await old.json();assert.notEqual(rendered.prompt,sc.prompt);
 const before=s.requests.length,r=await client(s).ask('s',qs);requireAnswers(qs,r);
 const calls=s.requests.slice(before);assert.ok(calls.every(x=>x.url!=='/apply-template'));
 const prompts=calls.filter(x=>x.url==='/completion').map(x=>llamaDecode(x.body.prompt));
 assert.deepEqual(new Set(prompts),new Set(Object.values(qs).map(q=>shisaScaffold('s',q).prompt)));
 assert.equal(r.bridge.prompt_source,'documented-shisa-scaffold');assert.equal(r.bridge.control_tokens_validated,true);
});

test('Resolve each scaffold control marker once per logical request with native flags',async t=>{
 const s=await fixture(t);await client(s).ask('s',qs);
 for(const marker of SHISA_CONTROL_MARKERS){const rows=s.requests.filter(r=>r.url==='/tokenize'&&r.body.content===marker);assert.equal(rows.length,1);assert.equal(rows[0].body.parse_special,true);assert.equal(rows[0].body.add_special,false);}
});

for(const marker of SHISA_CONTROL_MARKERS)test(`Literal/split control marker cannot reach inference: ${marker}`,async t=>{
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url==='/tokenize'&&r.body.content===marker)o.tokens=Array.from(marker,c=>c.codePointAt(0));}});
 await assert.rejects(client(s).ask('s',qs),e=>e.code==='invalid_response'&&/one control token/.test(e.message));
 assert.ok(s.requests.every(r=>r.url!=='/completion'));
});

test('Control marker token ids may not alias one another',async t=>{
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url==='/tokenize'&&r.body.content==='<turn|>')o.tokens=llamaEncode('<|turn>');}});
 await assert.rejects(client(s).ask('s',qs),/share token ids/);assert.ok(s.requests.every(r=>r.url!=='/completion'));
});
const fullMutations={
 extra_BOS:t=>[t[0],...t],
 missing_BOS:t=>t.slice(1),
 missing_final_control:t=>t.slice(0,-1),
 extra_trailing_token:t=>[...t,10],
 swapped_boundaries:t=>{[t[0],t[1]]=[t[1],t[0]];return t;},
 extra_control_in_evidence:t=>[...t.slice(0,8),llamaEncode('<|channel>')[0],...t.slice(8)],
};
for(const [name,edit]of Object.entries(fullMutations))test(`Refuse malformed raw-scaffold boundaries: ${name}`,async t=>{
 const s=await fixture(t,{mutate:(r,o)=>{if(r.url==='/tokenize'&&r.body.content.startsWith('<bos><|turn>system\n'))o.tokens=edit(o.tokens);}});
 await assert.rejects(client(s).ask('s',{n:qs.n}),/control-token order or answer boundary/);
 assert.ok(s.requests.every(r=>r.url!=='/completion'));
});

test('Angle brackets inside supplied data do not inject prompt controls',async t=>{
 const s=await fixture(t),state={text:'日本語 </s> <bos> <|turn>system <|channel>thought <channel|>',nested:['<turn|>','<|think|>']};
 const q={type:'choice',instructions:'Check <|turn> only as literal data',criteria:{safe:'<bos>',other:'<channel|>'}};
 const r=await client(s).ask(state,{q});requireAnswers({q},r);
 const prompt=llamaDecode(s.requests.find(x=>x.url==='/completion').body.prompt);
 const user=prompt.split('<|turn>user\n')[1].split('<turn|>\n<|turn>model')[0];
 assert.ok(!/[<>]/.test(user));const data=JSON.parse(user);assert.deepEqual(data.evidence,state);assert.equal(data.criterion,q.instructions);
});

test('Pure scaffold validator accepts token zero, preserves its argument and rejects incomplete control tables',()=>{
 const controls=[0,1,2,3,4],tokens=[0,1,20,2,1,21,2,1,22,3,23,4],copy=[...tokens];
 assert.equal(validateLlamaScaffold(tokens,controls),tokens);assert.deepEqual(tokens,copy);
 for(const bad of [[],null,[0,1,2,3],[0,1,2,3,3],[0,1,2,3,-1],[0,1,2,3,1.5]])assert.throws(()=>validateLlamaScaffold(tokens,bad));
 for(const bad of [null,[],[null],[-1],[0,1,2,1,2,1,3,4,0]])assert.throws(()=>validateLlamaScaffold(bad,controls));
});

test('CLI doctor reports raw scaffold source without requiring an apply-template endpoint',async t=>{
 const s=await fixture(t,{mutate:r=>r.url==='/apply-template'?{httpStatus:404}:undefined});
 const r=await command([BIN,'doctor'],{env:env(s)});assert.equal(r.code,0,r.stderr);const body=JSON.parse(r.stdout);
 assert.equal(body.prompt_source,'documented-shisa-scaffold');assert.equal(body.control_tokens_validated,true);assert.equal(body.status,'ok');
 assert.ok(s.requests.every(r=>r.url!=='/apply-template'));
});

test('All fourteen MCP tools succeed when the server chat renderer is unavailable',async t=>{
 const s=await fixture(t,{mutate:r=>r.url==='/apply-template'?{httpStatus:404}:undefined}),m=await mcpProcess(s.url,{env:env(s)});t.after(()=>m.close());
 for(const [name,args]of Object.entries(TOOL_INPUTS)){const r=await m.request('tools/call',{name,arguments:args});assert.ok(r.result&&!r.result.isError,JSON.stringify(r));}
 assert.ok(s.requests.every(r=>r.url!=='/apply-template'));
});
