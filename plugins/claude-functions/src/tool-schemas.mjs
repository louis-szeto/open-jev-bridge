import {S} from './schema.mjs';
const evidenceItem=S.obj({id:S.str(128),text:S.str(200000,0)},['text']);
export const evidenceSchema={anyOf:[S.str(200000,0),evidenceItem,S.arr(evidenceItem,1,16)]};
const candidate=S.obj({id:S.str(128),text:S.str(20000)},['text']);
const thresholds={auto_accept:S.num(),review_at:S.num(),composite_floor:S.num()};
const review={request:S.str(),diff:S.str(),tests:S.str(50000,0),context:{type:'object'},...thresholds};
export const TOOL_DEFINITIONS=[
 ['verify','Verify claims against supplied evidence; probability-based advisory verdicts, not proof.',S.obj({claims:S.arr(S.str(2000),1,64),evidence:evidenceSchema,auto_accept:S.num()},['claims','evidence'])],
 ['screen','Screen supplied external text for prompt injection, relevance and substance. Never executes or fetches the text.',S.obj({text:S.str(100000),purpose:S.str(2000),block_at:S.num(),review_at:S.num()},['text'])],
 ['find','Find which supplied candidates answer a query without embeddings; return ranked candidates and an existence judgment.',S.obj({query:S.str(2000),candidates:S.arr(candidate,1,250),top_k:S.int(1,250)},['query','candidates'])],
 ['classify','Classify supplied items against a shared class catalog; ambiguous results require review.',S.obj({items:S.arr(candidate,1,64),classes:S.arr(S.obj({id:S.str(128),description:S.str(2000,0)}),1,250),purpose:S.str(2000),auto_accept:S.num(),minimum_margin:S.num()},['items','classes'])],
 ['decide','Compare 2–6 candidates with explicit requirements and escape hatches. Advisory only; does not act on the decision.',S.obj({decision:S.str(2000),evidence:evidenceSchema,priorities:S.arr(S.str(2000),0,16),candidates:S.arr(S.obj({id:S.str(128),description:S.str(4000)}),2,6),requirements:S.arr(S.str(2000),0,3),escape_hatches:S.bool,auto_accept:S.num()},['decision','evidence','candidates'])],
 ['rerank','Independently score relevance of each supplied candidate, then sort; candidate order breaks ties.',S.obj({query:S.str(2000),candidates:S.arr(candidate,1,250),top_k:S.int(1,250)},['query','candidates'])],
 ['compare','Compare two passages overall and by aspect. Agreement is not evidence that either passage is true.',S.obj({passage_a:S.str(20000),passage_b:S.str(20000),aspects:S.arr(S.str(1000),0,10),auto_accept:S.num()},['passage_a','passage_b'])],
 ['extract','Find bounded regex candidates in a worker, then select a verbatim source substring. Never generates extracted values.',S.obj({document:S.str(200000),fields:S.arr(S.obj({id:S.str(128),pattern:S.str(1000),description:S.str(2000),flags:S.str(6,0)},['id','pattern','description']),1,32),auto_accept:S.num(),minimum_margin:S.num()},['document','fields'])],
 ['review','Score a proposed diff for correctness, spec match, test gap, blast radius and safety. Does not execute tests or apply patches.',S.obj(review,['request','diff'])],
 ['gate','Review a diff and verify completion claims together in one bounded System One request. Does not execute tests.',S.obj({...review,claims:S.arr(S.str(2000),1,16),evidence:evidenceSchema},['request','diff','claims','evidence'])],
 ['system_one','Validated raw System One request; state is arbitrary JSON. This is not an OpenAI chat-completions endpoint.',S.obj({state:{},questions:{type:'object',minProperties:1,maxProperties:512},model:S.str(200)},['state','questions'])],
 ['compact','Verbatim tool-pair compaction of supplied canonical messages; returns a new transcript and never modifies host files.',S.obj({messages:S.arr({type:'object'},1,10000),goal:S.str(4000),options:S.obj({keepThreshold:S.num(),preserveRecentMessages:S.int(0,1000),maxStateTokens:S.int(256,64000),maxRequestTokens:S.int(512,64000),truncateHeadChars:S.int(0,10000),minReductionRatio:S.num(),concurrency:S.int(1,16)},[])},['messages'])],
 ['belay','Judge whether a supplied transcript makes unsupported completion claims. Returns an advisory Stop-hook decision; runs no commands.',S.obj({messages:S.arr({type:'object'},1,10000),final_message:S.str(10000,0)},['messages'])],
 ['status','Check the configured System One /v1/models endpoint and report bridge capabilities; exposes no API credentials.',S.obj({},[])],
].map(([suffix,description,inputSchema])=>({name:suffix==='system_one'?'system_one_query':`system_one_${suffix}`,suffix,description,inputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));
