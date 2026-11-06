// @vitest-environment node
// gateway mode in the real host.mjs on Pi durable and SQLite, with pi-ai's own
// OpenAI-compatible client sending to a stand-in gateway in fetch: what each
// model request carries, from discovery through restart. Run with PI_DEPS
// set, as host.live.test.ts says.
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import contract from "../../features/agents/gateway/contract.ts?raw";
import * as vectors from "../../features/agents/gateway/vectors";
import host from "./host.mjs?raw";

const deps = process.env.PI_DEPS;
const driver = String.raw`import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {Harness,defineDoc} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context,withTelemetry} from '@earendil-works/chord/context';
import {serve,composeGateway,routeModels,gatewayModels,requestTelemetry,requestOf,GATEWAY} from './host.mjs';
import {createHash} from 'node:crypto';
import {bindSession,inferenceBundle,discoveryBundle,bindingAdmits} from './contract.ts';
import {readFileSync} from 'node:fs';
// The shared vectors' synthetic header profile, and a synthetic Pi upstream base.
const V=JSON.parse(readFileSync(new URL('./vectors.json',import.meta.url),'utf8')), P=V.VECTOR_PROFILE, H=P.headers, BASE='/upstream/pi';
// This test's literal names below are the profile's.
assert.deepEqual(H,{launcher_client:'x-gw-launcher-client',launcher_session:'x-gw-launcher-session',human_pubkey:'x-gw-ctx-human-pubkey',agent_pubkey:'x-gw-ctx-agent-pubkey',community_id:'x-gw-ctx-community-id',channel_id:'x-gw-ctx-channel-id',message_id:'x-gw-ctx-message-id',thread_id:'x-gw-ctx-thread-id'});
const data=process.argv[2], agent='b'.repeat(64), outside='c'.repeat(64);
const faux=fauxProvider(), models=createModels(); models.setProvider(faux.provider);
const ORIGIN='https://gateway.test', REFUSED='https://refused.test', SILENT='https://silent.test', VARIED='https://varied.test', result={};
/** Whether SILENT's listing hangs; and each origin's listing, where it differs. */
let silentHangs=true;const catalogs=new Map();let refusing=true, refuseNext;
const until=async test=>{const end=Date.now()+5000;while(!test()){if(Date.now()>end)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}};
// The stand-in gateway: its listing, and scripted streams in the protocol each request's path names.
const ep=(name,model_class,api_types,extra={})=>({name,state:{ready:'READY'},capabilities:{function_calling:true,image_input:false},config:{served_entities:[{foundation_model:{model_class,display_name:name,api_types}}]},...extra});
const endpoints=[ep('model-gpt-oss-20b','gpt-oss',['mlflow/v1/chat/completions']),ep('model-claude-x','claude',['anthropic/v1/messages','mlflow/v1/chat/completions']),ep('model-gpt-x','gpt',['openai/v1/responses','mlflow/v1/chat/completions']),ep('model-gemini-x','gemini',['gemini/v1/generateContent']),ep('model-down','llama',['mlflow/v1/chat/completions'],{state:{ready:'NOT_READY'}})];
const chunk=(delta,finish,used=1)=>({id:'c',object:'chat.completion.chunk',created:0,model:'m',choices:[{index:0,delta,finish_reason:finish??null}],...(finish?{usage:{prompt_tokens:used,completion_tokens:1,total_tokens:used+1}}:{})});
const sse=chunks=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const events=list=>new Response(list.map(([type,data])=>'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
/** The host offers Buzz's send as buzz_send; its result is this text. */
const ARGS='{"text":"hi"}', POSTED='posted 7f3a';
/** Anthropic Messages: one text or tool_use block. */
const messages=(block,delta,stop)=>events([['message_start',{message:{id:'msg_1',type:'message',role:'assistant',model:'m',content:[],stop_reason:null,usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{index:0,content_block:block}],['content_block_delta',{index:0,delta}],['content_block_stop',{index:0}],['message_delta',{delta:{stop_reason:stop},usage:{output_tokens:1}}],['message_stop',{}]]);
/** OpenAI Responses: one message or function_call item. */
const responses=(item,delta)=>events([['response.created',{response:{id:'resp_1',status:'in_progress',output:[]}}],['response.output_item.added',{output_index:0,item:{...item,status:'in_progress',...(item.content?{content:[]}:{arguments:''})}}],[item.content?'response.output_text.delta':'response.function_call_arguments.delta',{output_index:0,item_id:item.id,content_index:0,delta}],['response.output_item.done',{output_index:0,item}],['response.completed',{response:{id:'resp_1',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]]);
const say=text=>(init,url='')=>url.includes('/anthropic/')?messages({type:'text',text:''},{type:'text_delta',text},'end_turn')
 :url.includes('/openai/v1/responses')?responses({type:'message',id:'msg_1',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]},text)
 :sse([chunk({role:'assistant',content:text}),chunk({},'stop')]);
const send=(used)=>(init,url='')=>url.includes('/anthropic/')?messages({type:'tool_use',id:'toolu_1',name:'buzz_send',input:{}},{type:'input_json_delta',partial_json:ARGS},'tool_use')
 :url.includes('/openai/v1/responses')?responses({type:'function_call',id:'fc_1',call_id:'call_1',name:'buzz_send',arguments:ARGS,status:'completed'},ARGS)
 :sse([chunk({role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'buzz_send',arguments:ARGS}}]}),chunk({},'tool_calls',used)]);
/** The tool result a continuation sends back, in its protocol's shape. */
const text=c=>typeof c==='string'?c:c.map(p=>p.text).join('');
const toolResult=body=>{
 const chat=body.messages?.find(m=>m.role==='tool');if(chat)return {id:chat.tool_call_id,text:text(chat.content),error:false};
 const block=body.messages?.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_result');if(block)return {id:block.tool_use_id,text:text(block.content),error:Boolean(block.is_error)};
 const output=body.input?.find(i=>i.type==='function_call_output');if(output)return {id:output.call_id,text:text(output.output),error:false};
};
const listings=[], requests=[], replies=[];
// Summaries answer apart from turns, which may run beside them; failing ones until let through.
let summaries=true, offline=0;const summarized=[];
const summary=body=>String(JSON.stringify([body.system,body.instructions,body.messages?.[0],body.input?.[0]])).includes('context summarization assistant');
// A listing from a held origin waits for its release.
const held=new Map();
globalThis.fetch=async(url,init={})=>{
 const headers=Object.fromEntries(new Headers(init.headers));
 if(String(url).endsWith('/serving-endpoints')){listings.push({url:String(url),headers});await held.get(new URL(url).origin)?.promise;
  // A gateway that never answers: only the request's own signal ends it.
  // A guard fails it as unbounded if no signal ends it within 2 s.
  if(new URL(url).origin===SILENT&&silentHangs)await new Promise((_,reject)=>{const guard=setTimeout(()=>reject(new Error('unbounded listing')),2000);init.signal?.addEventListener('abort',()=>{clearTimeout(guard);reject(init.signal.reason);},{once:true});});
  if(refuseNext){const gate=refuseNext;refuseNext=undefined;gate.started?.resolve();await gate.hold;return new Response('',{status:403});}return new URL(url).origin===REFUSED&&refusing?new Response('',{status:403}):Response.json({endpoints:catalogs.get(new URL(url).origin)??endpoints});}
 const body=JSON.parse(init.body);
 requests.push({url:String(url),headers,body});
 if(offline){offline--;throw new TypeError('fetch failed');}
 if(summary(body)){summarized.push({headers,ok:summaries});return summaries?say('Summary.')(init,String(url)):new Response('Internal error',{status:500});}
 return (replies.shift()??say('ok'))(init,String(url));
};
// The host's own Harness, to read its records and to fail a reset's write as a crash would.
const GatewayRuns=defineDoc({kind:'buzz.gateway',version:1,scope:'session',initial:()=>({places:{},resets:{},requests:{}})});
let harness, crashReset=false;const resets=[];
// A test's hold on the host reading a conversation's mode, and on the run
// starts its watch is told of; and what it is told as a held gateway
// model's request starts.
let modeRead, runStart, heldStream;
{const {CommittedWatch}=await import(new URL('./node_modules/@earendil-works/pi-durable/dist/session/observation.js',import.meta.url));
 const start=CommittedWatch.prototype.start;
 CommittedWatch.prototype.start=function(listener){return start.call(this,async(...args)=>{if(runStart&&Array.isArray(args[0])&&args[0].some(e=>e.type==='run_start'))await runStart();return listener(...args);});};}
const open=Harness.open;
Harness.open=async(storage,config,...rest)=>{
 const models=new Proxy(config.models,{get(target,name){const value=Reflect.get(target,name);
  if(name!=='stream'&&name!=='streamSimple')return value;
  return (...a)=>{const stream=value.apply(target,a);if(a[0]?.api==='buzz-held')heldStream?.();return stream;};}});
 const opened=await open.call(Harness,storage,{...config,models},...rest);harness=opened;
 const conversation=opened.conversation.bind(opened);
 opened.conversation=async(...a)=>{
  const found=await conversation(...a);
  if(!found)return found;
  const agentOf=found.agent.bind(found);
  found.agent=async c=>{const value=await agentOf(c);await modeRead?.();return value;};
  const submit=found.submit.bind(found);
  found.submit=async(draft,c)=>{
   if(draft.entry?.kind!=='pi.reset')return submit(draft,c);
   if(crashReset){crashReset=false;throw new Error('crashed before the reset');}
   const handle=await submit(draft,c);resets.push({request:draft.requestId,id:handle.id});return handle;
  };
  return found;
 };
 return opened;
};
const records=async()=>(await harness.snapshot(GatewayRuns,context))?.requests??{};
// The plugin: Buzz tools, protection, and the shared gateway contract answering
// as answerGateway does, with Buzz sessions numbered in the order minted.
let gate=Promise.resolve(), sessions=0;
Object.defineProperty(crypto,'randomUUID',{value:()=>'00000000-0000-4000-8000-'+String(++sessions).padStart(12,'0')});
const IDENTITY={community_id:'22222222-2222-4222-8222-222222222222',human_pubkey:'a'.repeat(64),agent_pubkey:agent};
const CHAN='33333333-3333-4333-8333-333333333333', names=new Map();
/** A signed event's id for a request name, and the name for an id sent. */
const mid=name=>{const id=createHash('sha256').update(name).digest('hex');names.set(id,name);return id;};
const msg=h=>names.get(h['x-gw-ctx-message-id']);
// Admitted at the route's eligibility revision. A refusal at it drops that
// access, as the plugin's invalidateRoute does; an older one's does nothing.
let revision=1;
const identityOf=who=>({...IDENTITY,agent_pubkey:who});
const admitted=(binding,who=agent)=>{const r=bindingAdmits({kind:'eligible',identity:identityOf(who),revision},binding);return r.ok?{ok:true,revision:r.revision}:{ok:false,message:r.message};};
let admit=admitted;
const binds=[], actions=[], denies=[], toolCalls=[];
function start(protectedAgent) {
 const input=new PassThrough(),output=new PassThrough(),pending=new Map();let id=0;
 const answer=(m,value)=>input.write(JSON.stringify({id:m.id,result:value})+'\n');
 createInterface({input:output}).on('line',async line=>{
  const m=JSON.parse(line);
  if(m.method==='gateway'){
   const {op,event,saved,turn}=m.params;
   if(op==='admit')return answer(m,admit(m.params.binding,m.params.agent));
   // Applied only at the agent's current revision; the other agents' are taken as current.
   if(op==='deny'){denies.push(m.params);const applied=m.params.agent!==agent||m.params.revision===revision;if(applied&&m.params.agent===agent)admit=()=>({ok:false,message:'gateway mode is checking access again.'});return answer(m,{ok:true,applied});}
   binds.push(m.params);await gate;
   const bound=bindSession({identity:identityOf(m.params.agent)},saved,event);
   if(!bound.ok)return answer(m,{ok:false,message:bound.message});
   const bundle=inferenceBundle(P,bound.binding,turn);
   if(!bundle.ok)return answer(m,{ok:false,message:bundle.message});
   answer(m,{ok:true,binding:bound.binding,persist:bound.persist,bundle:bundle.value});
  } else if(m.method==='security'){actions.push(m.params.action.kind);answer(m,true);}
  else if(m.method==='tool'){toolCalls.push(m.params);answer(m,{content:[{type:'text',text:POSTED}]});}
  else if(m.method==='hook')answer(m,null);
  else if(m.id!==undefined){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(m.error)):p?.resolve(m.result);}
 });
 const rpc=(method,params)=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});input.write(JSON.stringify({id,method,params})+'\n');});
 const server=serve({data,models,dir:data,protectedAgent,input,output,exit:()=>{}});
 return {rpc,stop:()=>server.stop()};
}
const route={kind:'eligible',revision:1,gatewayOrigin:ORIGIN,identity:IDENTITY,base:BASE,profile:P,discovery:discoveryBundle(P,{identity:IDENTITY}).value};
const tools=[{name:'send',description:'Post',inputSchema:{type:'object',properties:{text:{type:'string'}}},load:'always'}];
const turn=(request,extra={})=>({agent,key:'chan/root',at:100,context:{channel:'chan'},text:'Do it',steer:'Do it',request,provider:GATEWAY,model:'model-gpt-oss-20b',instructions:'Test.',cwd:data,gatewayTurn:{channel_id:CHAN,message_id:mid(request),thread_id:mid('root')},...extra});
const sent=from=>requests.slice(from).map(r=>r.headers);
const runAs=async(pi,who,request,extra)=>{const {submission}=await pi.rpc('deliver',turn(request,{agent:who,...extra}));return pi.rpc('wait',{agent:who,submission,request});};
const run=async(pi,request,extra)=>{const {submission}=await pi.rpc('deliver',turn(request,extra));return pi.rpc('wait',{agent,submission,request});};

// Composition: native headers kept, every name the profile reserves replaced
// whatever its case or underscores, conflicting sessions refused.
assert.deepEqual(composeGateway(P,{'User-Agent':'pi/1','X-GW-CTX-Channel-Id':'stale','X_GW-LAUNCHER_SESSION':'stale','x-gw-custom':'kept',session_id:'s',  'x-client-request-id':'s','x-session-affinity':'s','x-gone':null},{[H.launcher_session]:'u'},'s'),
 {'User-Agent':'pi/1','x-gw-custom':'kept',session_id:'s','x-client-request-id':'s','x-gone':null,[H.launcher_session]:'u','x-session-affinity':'s'});
for(const name of ['x-session-affinity','X-LiteLLM-Session-Id','x-litellm-trace-id','x-claude-code-session-id','agent-session-id','session-id'])
 assert.throws(()=>composeGateway(P,{[name]:'other'},{},'s'),/conflicting/);
assert.throws(()=>composeGateway(P,{},{},undefined),/no session/);
assert.throws(()=>composeGateway(undefined,{},{},'s'),/no header profile/);
const routed=routeModels(models,async()=>({bundle:{},profile:P}),()=>{});
for(const name of ['streamDeferred','fetchDeferred','cancelDeferred','generateImages','classify'])assert.throws(()=>routed[name](),/does not support/);
result.composition=true;
// The shared gateway vectors, through this copy of its composer.
{const bare=h=>{const {'x-session-affinity':a,...rest}=h;assert.equal(a,'s1');return rest;};
 for(const c of V.COMPOSE_VECTORS)assert.deepEqual(bare(composeGateway(P,c.assembled,c.bundle,'s1')),c.composed,c.name);
 for(const b of V.COMPOSE_REFUSED)assert.throws(()=>composeGateway(P,{},b,'s1'),/only set the profile's context headers/);
 // Only the profile's eight names: a name under its prefix, or any other, is refused.
 for(const name of [P.reserved_prefixes[0]+'purpose','x-unknown'])assert.throws(()=>composeGateway(P,{},{[name]:'x'},'s1'),/only set the profile's context headers/,name);
 // Any subset of them passes: discovery's, and a synthetic turn's with no message.
 const all=V.INFERENCE_VECTORS[0].headers;
 const pick=roles=>Object.fromEntries(roles.map(r=>[H[r],all[H[r]]]).filter(([,value])=>value!==undefined));
 for(const subset of [pick(['launcher_client','human_pubkey','agent_pubkey','community_id']),pick(['launcher_client','launcher_session','human_pubkey','agent_pubkey','community_id','channel_id','thread_id']),{},all])assert.deepEqual(bare(composeGateway(P,{},subset,'s1')),subset);
 const stale={'content-type':'application/json',[H.message_id]:'stale',[P.reserved_prefixes[0]+'purpose']:'inference',[H.launcher_session]:'stale'};
 for(const c of V.INFERENCE_VECTORS){const sent=bare(composeGateway(P,stale,c.headers,'s1'));assert.deepEqual(sent,{'content-type':'application/json',...c.headers},c.name);}
 assert.ok(V.COMPOSE_VECTORS.length&&V.COMPOSE_REFUSED.length&&V.INFERENCE_VECTORS.length);}
result.vectors=true;

// The carrier: one request; an input's admission takes its caller's from its first link only.
{const root=requestTelemetry(),a=requestTelemetry('a'),b=requestTelemetry('b');
 assert.deepEqual(root.propagation.inject(a),{buzz:'a'});assert.equal(root.propagation.inject(root),undefined);
 assert.equal(requestOf(root.propagation.extract({buzz:'a'})),'a');assert.equal(requestOf(root.propagation.extract({other:'a'})),undefined);
 const admit=async(parent,links)=>parent.startSpan({name:'pi.durable.submit'},span=>{for(const context of links)span.addLink({context});return requestOf(span);});
 assert.equal(await admit(root,[a,b]),'a');
 assert.equal(await admit(root,[root,b]),undefined);
 assert.equal(await admit(a,[b]),'a');
 assert.equal(await root.startSpan({name:'pi.durable.phase'},span=>{span.addLink({context:b});return requestOf(span);}),undefined);
 assert.equal(await a.startSpan({name:'pi.durable.phase'},span=>span.startSpan({name:'x'},child=>requestOf(child))),'a');}
result.carrier=true;

let pi=start();
// An external agent never reaches the gateway, and keeps Pi's providers.
await pi.rpc('open',{agent:outside,tools:[]});
faux.setResponses([fauxAssistantMessage('local')]);
{const {submission}=await pi.rpc('deliver',{...turn('x1'),agent:outside,provider:'faux',model:'faux-1',gatewayTurn:undefined});
 assert.equal((await pi.rpc('wait',{agent:outside,submission,request:'x1'})).text,'local');}
assert.equal(listings.length+requests.length+binds.length,0);
result.external=true;

// Discovery: the route's headers, the verified protocol per family, others unavailable.
await pi.rpc('open',{agent,tools,route});
assert.equal(listings[0].url,ORIGIN+'/upstream/pi/api/2.0/serving-endpoints');
assert.equal(listings[0].headers.authorization,'Bearer buzz-gateway');
assert.deepEqual(Object.keys(listings[0].headers).filter(k=>Object.values(H).includes(k)).sort(),['x-gw-ctx-agent-pubkey','x-gw-ctx-community-id','x-gw-ctx-human-pubkey','x-gw-launcher-client']);assert.equal(listings[0].headers['x-gw-ctx-community-id'],IDENTITY.community_id);
assert.deepEqual((await pi.rpc('models',{agent,provider:GATEWAY})).map(m=>m.id),['model-gpt-oss-20b','model-claude-x','model-gpt-x']);
assert.deepEqual(await pi.rpc('models',{agent,provider:'faux'}),[]);
const {providers}=await pi.rpc('providers',{agent});
assert.equal(providers[0].id,GATEWAY);assert.ok(providers.find(p=>p.id==='faux').unavailable);
assert.ok(!(await pi.rpc('providers',{})).providers.some(p=>p.id===GATEWAY));
await assert.rejects(pi.rpc('deliver',turn('bad',{key:'chan/bad',provider:'faux',model:'faux-1'})),/unavailable in gateway mode/);assert.equal(binds.length,0);
// A refused listing tells the revision of the route it was opened with, before any is taken.
{const refused='e'.repeat(64),own=harness;
 await assert.rejects(pi.rpc('open',{agent:refused,tools,route:{...route,gatewayOrigin:REFUSED,revision:7}}),/HTTP 403/);
 assert.deepEqual(denies,[{op:'deny',agent:refused,revision:7}]);
 // Refused again once probed ready, it fails without being told again: nothing loops.
 await assert.rejects(pi.rpc('open',{agent:refused,tools,route:{...route,gatewayOrigin:REFUSED,revision:9}}),/HTTP 403/);
 assert.equal(denies.length,1);
 // Listed once, a later refusal is told again.
 refusing=false;await pi.rpc('open',{agent:refused,tools,route:{...route,gatewayOrigin:REFUSED,revision:9}});
 await pi.rpc('close',{agent:refused});refusing=true;
 await assert.rejects(pi.rpc('open',{agent:refused,tools,route:{...route,gatewayOrigin:REFUSED,revision:11}}),/HTTP 403/);
 assert.deepEqual(denies.at(-1),{op:'deny',agent:refused,revision:11});
 denies.length=0;harness=own;}
result.discovery=true;

// Overlapping opens: one that discovered an older route never takes the host from a newer one.
{const racer='d'.repeat(64),older={...route,gatewayOrigin:'https://older.test'},release=Promise.withResolvers(),own=harness;
 held.set(older.gatewayOrigin,release);
 const first=pi.rpc('open',{agent:racer,tools,route:older});
 await until(()=>listings.some(l=>l.url.startsWith(older.gatewayOrigin)));
 await pi.rpc('open',{agent:racer,tools,route});
 release.resolve();
 await assert.rejects(first,/model route changed/);
 await pi.rpc('open',{agent:racer,tools,route});
 assert.deepEqual((await pi.rpc('models',{agent:racer,provider:GATEWAY})).map(m=>m.id),['model-gpt-oss-20b','model-claude-x','model-gpt-x']);
 harness=own;}
result.overlap=true;

// A turn: bound before submission, nothing sent until then; tool call and continuation carry its context.
binds.length=0;let release;gate=new Promise(r=>{release=r;});replies.push(send(),say('done'));
const first=pi.rpc('deliver',turn('e1'));
await until(()=>binds.length===1);await new Promise(r=>setTimeout(r,50));
assert.equal(requests.length,0);release();
const {submission}=await first;
assert.equal((await pi.rpc('wait',{agent,submission,request:'e1'})).status,'done');
assert.equal(binds[0].event,'new_generation');assert.equal(binds[0].saved,undefined);
const [call1,call2]=sent(0);
assert.equal(requests[0].url,ORIGIN+'/upstream/pi/ai-gateway/mlflow/v1/chat/completions');
assert.equal(requests[0].body.store,undefined);assert.ok('max_tokens' in requests[0].body);
assert.ok(call1['user-agent'].startsWith('pi/'));
const affinity=call1['x-session-affinity'];
assert.match(affinity,/^[0-9a-f-]{36}$/);assert.notEqual(affinity,call1['x-gw-launcher-session']);
assert.deepEqual(toolCalls.map(c=>c.name),['send']);assert.deepEqual(toolResult(requests[1].body),{id:'call_1',text:POSTED,error:false});
for(const h of [call1,call2]){assert.equal(msg(h),'e1');assert.equal(h['x-gw-launcher-session'],'00000000-0000-4000-8000-000000000001');assert.equal(h['x-session-affinity'],affinity);}
result.firstTurn=true;

// A second turn resumes the binding; its own message; the same native session.
let from=requests.length;
assert.equal((await run(pi,'e2')).status,'done');
assert.equal(binds[1].event,'resume');assert.equal(binds[1].saved.client_session_id,'00000000-0000-4000-8000-000000000001');
assert.equal(msg(sent(from)[0]),'e2');
assert.equal(sent(from)[0]['x-gw-launcher-session'],'00000000-0000-4000-8000-000000000001');
assert.equal(sent(from)[0]['x-session-affinity'],affinity);
result.secondTurn=true;

// A route that no longer admits the binding stops the run before it sends.
from=requests.length;admit=()=>({ok:false,message:'Sign in again to use the gateway models.'});
const refused=await run(pi,'e3');
assert.equal(refused.status,'unanswered');assert.match(refused.detail,/Sign in again/);
assert.equal(requests.length,from);admit=admitted;
result.invalidated=true;

// A 401 for a request is told with the revision it was admitted at, before its client sees it:
// the run fails visibly, and nothing more is sent under the access it dropped.
from=requests.length;replies.push(()=>new Response('{"error":{"message":"denied"}}',{status:401,headers:{'content-type':'application/json'}}));
{const denied=await run(pi,'d1');
 assert.equal(denied.status,'unanswered');assert.match(denied.detail,/401/);
 assert.deepEqual(denies,[{op:'deny',agent,revision:1}]);
 assert.equal(requests.length,from+1);}
// Ready again at a newer revision, the resumed binding runs, and a 403 tells that revision.
revision=2;admit=admitted;from=requests.length;
assert.equal((await run(pi,'d2')).status,'done');
assert.equal(binds.at(-1).event,'resume');
replies.push(()=>new Response('',{status:403}));
assert.equal((await run(pi,'d3')).status,'unanswered');
assert.deepEqual(denies.at(-1),{op:'deny',agent,revision:2});
// Another failure drops nothing.
admit=admitted;const told=denies.length;
replies.push(()=>new Response('',{status:400}));
assert.equal((await run(pi,'d4')).status,'unanswered');
assert.equal(denies.length,told);
// A listing refused late, at the revision before, drops nothing: a refusal at the current one is still told.
{const hold=Promise.withResolvers(),started=Promise.withResolvers();
 refuseNext={hold:hold.promise,started};
 const old=pi.rpc('models',{agent,provider:GATEWAY});await started.promise;
 await pi.rpc('close',{agent});await pi.rpc('open',{agent,tools,route:{...route,revision:2}});
 hold.resolve();await assert.rejects(old,/HTTP 403/);
 assert.deepEqual(denies.at(-1),{op:'deny',agent,revision:1});
 refuseNext={hold:Promise.resolve()};
 await assert.rejects(pi.rpc('models',{agent,provider:GATEWAY}),/HTTP 403/);
 assert.deepEqual(denies.at(-1),{op:'deny',agent,revision:2});
 admit=admitted;await pi.rpc('models',{agent,provider:GATEWAY});}
result.denied=true;

// A new session rotates the binding. The next turn asks for its reset again, by its request: nothing more is written.
await pi.rpc('session',{agent,key:'chan/root',action:'new'});
assert.equal(resets.length,1);assert.match(resets[0].request,/^reset\//);
from=requests.length;
assert.equal((await run(pi,'e4')).status,'done');
assert.deepEqual(resets,[resets[0],resets[0]]);
assert.ok(!requests[from].body.messages.some(m=>m.role==='assistant'));
assert.equal(binds.at(-1).event,'reset');
assert.equal((await harness.snapshot(GatewayRuns,context)).resets['chan/root'],undefined);
assert.equal(sent(from)[0]['x-gw-launcher-session'],'00000000-0000-4000-8000-000000000002');
result.reset=true;

// A one-off turn is standalone, with no saved binding.
from=requests.length;
{const {submission}=await pi.rpc('once',{...turn('o1'),key:undefined});
 assert.equal((await pi.rpc('wait',{agent,submission})).status,'done');}
assert.equal(binds.at(-1).event,'standalone');assert.equal(binds.at(-1).saved,undefined);
assert.equal(msg(sent(from)[0]),'o1');
result.standalone=true;
// Automation: the context the runner froze for a watch, a timer and a timer's
// conversation wake reaches the gateway as exactly those headers; a null field
// sends no header, never a selected or fabricated message.
{const W='x-gw-ctx-', ids=h=>[h[W+'channel-id'],h[W+'message-id'],h[W+'thread-id']];
 const once=async(request,gatewayTurn)=>{const from=requests.length;
  const {submission}=await pi.rpc('once',{...turn(request),key:undefined,gatewayTurn});
  assert.equal((await pi.rpc('wait',{agent,submission})).status,'done');return sent(from);};
 const watched=mid('watched');
 const w=await once('w1',{channel_id:CHAN,message_id:watched,thread_id:null});
 assert.deepEqual(ids(w[0]),[CHAN,watched,undefined]);
 const t=await once('t1',{channel_id:null,message_id:null,thread_id:null});
 assert.deepEqual(ids(t[0]),[undefined,undefined,undefined]);
 assert.ok(!Object.keys(t[0]).some(k=>/channel-id|message-id|thread-id/.test(k)));
 // The run's identity and its own launcher session are still there: each
 // standalone turn mints one, never another turn's.
 for(const h of [w[0],t[0]]){
  assert.equal(h[W+'agent-pubkey'],agent);assert.equal(h[W+'human-pubkey'],IDENTITY.human_pubkey);
  assert.equal(h[W+'community-id'],IDENTITY.community_id);assert.equal(h['x-gw-launcher-client'],P.launcher_client);
  assert.match(h['x-gw-launcher-session'],/^00000000-0000-4000-8000-\d{12}$/);assert.ok(h['x-session-affinity']);}
 assert.notEqual(w[0]['x-gw-launcher-session'],t[0]['x-gw-launcher-session']);
 assert.equal(binds.at(-1).event,'standalone');
 const from=requests.length;
 await run(pi,'wake-t2',{key:'chan',context:{channel:'chan'},gatewayTurn:{channel_id:CHAN,message_id:null,thread_id:null}});
 const wake=sent(from);assert.deepEqual(ids(wake[0]),[CHAN,undefined,undefined]);
 // A conversation wake runs in its key's own bound session, under the same identity.
 const session=(await harness.snapshot(GatewayRuns,context)).places.chan.client_session_id;
 for(const h of wake){assert.equal(h['x-gw-launcher-session'],session);
  assert.deepEqual([h[W+'agent-pubkey'],h[W+'human-pubkey'],h[W+'community-id']],[agent,IDENTITY.human_pubkey,IDENTITY.community_id]);}
 assert.ok(![w[0],t[0]].some(h=>h['x-gw-launcher-session']===session));}
result.automation=true;

// Compaction in a run, without the native session pi-ai drops for it: the run's context, the native affinity.
assert.equal((await run(pi,'e6a',{text:'word '.repeat(30000)})).status,'done');
from=requests.length;replies.push(send(125000),say('done'));
assert.equal((await run(pi,'e6')).status,'done');
const compaction=requests.slice(from).find(r=>summary(r.body));
assert.ok(compaction,'no compaction request');
assert.equal(compaction.headers.session_id,undefined);
for(const h of sent(from)){assert.equal(msg(h),'e6');assert.equal(h['x-session-affinity'],sent(from)[0]['x-session-affinity']);}
result.compaction=true;
// One the owner asks for is its own request, with the conversation's place and no message, in the key's session as it is.
for(const request of ['e7a','e7b'])assert.equal((await run(pi,request,{text:'word '.repeat(30000)})).status,'done');
from=requests.length;
await pi.rpc('session',{agent,key:'chan/root',action:'compact',gatewayTurn:{channel_id:CHAN,message_id:null,thread_id:mid('root')}});
assert.ok(requests.length>from,'no manual compaction request');
assert.deepEqual(binds.at(-1).turn,{channel_id:CHAN,message_id:null,thread_id:mid('root')});assert.equal(binds.at(-1).event,'resume');assert.equal(binds.at(-1).saved.client_session_id,'00000000-0000-4000-8000-000000000002');
for(const h of sent(from)){assert.equal(h['x-gw-ctx-message-id'],undefined);assert.equal(h['x-gw-ctx-thread-id'],mid('root'));assert.equal(h['x-gw-launcher-session'],'00000000-0000-4000-8000-000000000002');}
assert.ok(Object.keys(await records()).some(r=>r.startsWith('manual/')));
result.manualCompaction=true;

// A run queued behind another has its own context, also in its blocking compaction.
{let release;const held=new Promise(r=>{release=r;});from=requests.length;
 replies.push(async()=>{await held;return say('first')();},send(125000),say('second'));
 const a=await pi.rpc('deliver',turn('q1',{text:'word '.repeat(30000)}));
 await until(()=>requests.length>from);
 const b=await pi.rpc('deliver',turn('q2',{text:'word '.repeat(30000),steer:'word '.repeat(30000)}));
 release();
 assert.equal((await pi.rpc('wait',{agent,submission:a.submission,request:'q1'})).status,'done');
 assert.equal((await pi.rpc('wait',{agent,submission:b.submission,request:'q2'})).status,'done');
 // q1's own background compaction may run beside q2; q2's blocking one is in its run.
 const of=kind=>requests.slice(from).filter(r=>summary(r.body)===kind).map(r=>msg(r.headers));
 assert.deepEqual(of(false),['q1','q2','q2']);assert.deepEqual(of(true).sort(),['q1','q2']);}
result.queued=true;

// No provenance, an unknown request, or another conversation's: refused before anything is sent.
{const Places=defineDoc({kind:'buzz.places',version:1,scope:'session',initial:()=>({})});
 const place=(await harness.snapshot(Places,context))['chan/root'];
 const conversation=await harness.conversation(place.conversation,context);
 const other=Object.entries(await records()).find(([,r])=>r.conversation!==place.conversation)[0];
 for(const [carrier,error] of [[undefined,/no Buzz context/],['ghost',/no Buzz context/],[other,/another conversation's/]]){
  from=requests.length;
  const handle=await conversation.submit({type:'input',content:'Do it',whenBusy:'steer'},carrier?withTelemetry(requestTelemetry(carrier),context):context);
  const settled=await handle.wait(context);
  assert.equal(requests.length,from,'sent without provenance');
  assert.equal(settled.status,'unanswered');assert.match(JSON.stringify(settled),error);
 }}
result.provenance=true;

// A background compaction keeps its run's context through a failed attempt, a restart while its
// retry sleeps, and the next run starting before it: the record outlives its request until then.
assert.equal((await run(pi,'b0',{text:'word '.repeat(30000)})).status,'done');
summaries=false;summarized.length=0;from=requests.length;replies.push(send(90000),say('done'));
assert.equal((await run(pi,'b1')).status,'done');
await until(()=>summarized.length>0);
await pi.stop();
pi=start();await pi.rpc('open',{agent,tools,route});
assert.ok((await records()).b1,'pruned while its compaction lives');
summaries=true;const later=requests.length;
assert.equal((await run(pi,'b2')).status,'done');
await until(()=>summarized.some(s=>s.ok));
for(const {headers} of summarized)assert.equal(msg(headers),'b1');
const turns=requests.slice(later).filter(r=>!summary(r.body));
assert.ok(turns.length>0&&requests.slice(later).findIndex(r=>summary(r.body))>requests.slice(later).indexOf(turns[0]));
for(const r of turns)assert.equal(msg(r.headers),'b2');
result.background=true;

// A crash between a reset's intent and its write: the next turn does it, then binds the reset.
crashReset=true;
await assert.rejects(pi.rpc('session',{agent,key:'chan/root',action:'new'}),/crashed before the reset/);
assert.ok((await harness.snapshot(GatewayRuns,context)).resets['chan/root']);
await pi.stop();
pi=start();await pi.rpc('open',{agent,tools,route});
// Settled requests whose work has ended are forgotten; none was left unsubmitted.
assert.deepEqual(Object.keys(await records()),[]);
{const count=resets.length,sessionBefore=binds.filter(b=>b.saved).at(-1).saved.client_session_id;from=requests.length;
 assert.equal((await run(pi,'r1')).status,'done');
 assert.equal(resets.length,count+1);assert.equal(binds.at(-1).event,'reset');
 assert.notEqual(sent(from)[0]['x-gw-launcher-session'],sessionBefore);
 assert.ok(!requests[from].body.messages.some(m=>m.role==='assistant'));
 assert.equal((await harness.snapshot(GatewayRuns,context)).resets['chan/root'],undefined);}
// A request Pi has already, delivered again after a reset, keeps its binding: the reset waits for the next.
await pi.rpc('session',{agent,key:'chan/root',action:'new'});
{const bound=binds.length,record=(await records()).r1;
 await pi.rpc('deliver',turn('r1'));
 assert.equal(binds.length,bound);assert.deepEqual((await records()).r1,record);
 assert.ok((await harness.snapshot(GatewayRuns,context)).resets['chan/root']);
 assert.equal((await run(pi,'r2')).status,'done');assert.equal(binds.at(-1).event,'reset');
 // Delivered again once the new session has a turn, it leaves that session the key's.
 const current=binds.at(-1);from=requests.length;
 await pi.rpc('deliver',turn('r1'));
 assert.equal((await run(pi,'r3')).status,'done');
 assert.equal(binds.at(-1).event,'resume');
 assert.notEqual(sent(from)[0]['x-gw-launcher-session'],record.client_session_id??'');
 assert.equal(sent(from).at(-1)['x-gw-launcher-session'],(await harness.snapshot(GatewayRuns,context)).places['chan/root'].client_session_id);
 assert.equal((await records()).r3.binding.client_session_id,(await records()).r2.binding.client_session_id);}
result.resetCrash=true;

// Restart mid-run: the next host continues it with the recorded context, binding nothing again.
// Held until the stopping host aborts it.
replies.push(init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason))));
from=requests.length;const bound=binds.length;
await pi.rpc('deliver',turn('e5'));
await until(()=>requests.length>from);
await pi.stop();
pi=start();await pi.rpc('open',{agent,tools,route});
const {submissions}=await pi.rpc('unfinished',{agent});
const left=submissions.find(s=>s.request==='e5');assert.ok(left);
const after=requests.length;
assert.equal((await pi.rpc('wait',{agent,submission:left.submission,request:'e5'})).status,'done');
assert.ok(requests.length>after);
for(const h of sent(after)){assert.equal(msg(h),'e5');assert.equal(h['x-session-affinity'],sent(from)[0]['x-session-affinity']);}
assert.equal(binds.length,bound+1);
result.restart=true;
// Restarted with no route, as an ordinary turn opens it: the gateway run it
// left waits for the gateway's models while discovery is held, as ordinary
// work goes on, then continues through the gateway once they come.
{replies.push(init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason))));
 const from=requests.length;
 await pi.rpc('deliver',turn('e6',{key:'chan/e6'}));
 await until(()=>requests.length>from);
 await pi.stop();
 pi=start();
 assert.deepEqual(await pi.rpc('open',{agent,tools}),{gateway:false,held:true});
 const left=(await pi.rpc('unfinished',{agent})).submissions.find(s=>s.request==='e6');assert.ok(left);
 const discovery=Promise.withResolvers(),listed=listings.length;held.set(ORIGIN,discovery);
 const restoring=pi.rpc('open',{agent,tools,route});
 await until(()=>listings.length>listed);
 let resumed;const started=Promise.withResolvers();heldStream=started.resolve;
 const waiting=pi.rpc('wait',{agent,submission:left.submission,request:'e6'}).then(v=>resumed=v);
 await started.promise;heldStream=undefined;
 faux.setResponses([fauxAssistantMessage('ordinary')]);
 const after=requests.length;
 assert.equal((await run(pi,'e7',{key:'chan/e7',provider:'faux',model:'faux-1',gatewayTurn:undefined})).text,'ordinary');
 assert.equal(resumed,undefined);assert.equal(requests.length,after);
 discovery.resolve();held.delete(ORIGIN);
 assert.deepEqual(await restoring,{gateway:true,held:false});
 await waiting;
 assert.equal(resumed.status,'done');
 assert.ok(requests.length>after);
 for(const h of sent(after))assert.equal(msg(h),'e6');}
// Waiting for the route, it ends as the runtime aborts it, and nothing is
// sent for it once the route comes; closed instead, it stays for the next
// host. Aborted before it waits, it holds nothing after.
const abortable=init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason)));
const leave=async request=>{
 replies.push(abortable);const from=requests.length;
 const placed=await pi.rpc('deliver',turn(request,{key:'chan/'+request}));
 await until(()=>requests.length>from);
 await pi.stop();pi=start();
 assert.deepEqual(await pi.rpc('open',{agent,tools}),{gateway:false,held:true});
 return placed;};
const holding=async(request,submission)=>{
 const started=Promise.withResolvers();heldStream=started.resolve;
 const waiting=pi.rpc('wait',{agent,submission,request});
 await started.promise;heldStream=undefined;
 return {waiting};};
{const {submission,conversation}=await leave('e8');const from=requests.length;
 const {waiting}=await holding('e8',submission);
 await pi.rpc('abort',{agent,conversation});
 assert.equal((await waiting).status,'unanswered');
 assert.deepEqual(await pi.rpc('open',{agent,tools,route}),{gateway:true,held:false});
 faux.setResponses([fauxAssistantMessage('after')]);
 assert.equal((await run(pi,'e8b',{key:'chan/e8b',provider:'faux',model:'faux-1',gatewayTurn:undefined})).text,'after');
 assert.equal(requests.length,from);}
{const {submission}=await leave('e9');const from=requests.length;
 const {waiting}=await holding('e9',submission);
 await pi.rpc('close',{agent});
 await waiting.catch(()=>undefined);
 assert.equal(requests.length,from);
 await pi.stop();pi=start();await pi.rpc('open',{agent,tools,route});
 assert.equal((await pi.rpc('wait',{agent,submission,request:'e9'})).status,'done');
 for(const h of sent(from))assert.equal(msg(h),'e9');}
{const {conversation}=await leave('e10');
 await pi.rpc('abort',{agent,conversation});
 assert.deepEqual(await pi.rpc('open',{agent,tools}),{gateway:false,held:false});}
result.detached=true;
await pi.stop();

// Protected: the review sees every request, and the route's headers are still the request's.
const protectedPi=start(agent);
await protectedPi.rpc('open',{agent,tools,route});
from=requests.length;actions.length=0;
assert.equal((await run(protectedPi,'p1')).status,'done');
assert.ok(actions.includes('context'));
assert.equal(msg(sent(from)[0]),'p1');
result.protected=true;
await protectedPi.stop();
// Each family's verified protocol, through pi-ai's own client.
// pi-ai's Anthropic client sends Messages through the SDK's beta resource, which adds its query.
const PATHS=[['model-claude-x','anthropic/v1/messages?beta=true'],['model-gpt-x','openai/v1/responses'],['model-gpt-oss-20b','mlflow/v1/chat/completions']];
const refusal=()=>new Response('{"error":{"message":"denied"}}',{status:401,headers:{'content-type':'application/json'}});
// Every request method: its path, the call's own context and native affinity, and a refusal told at the revision it was admitted at.
{const catalog=gatewayModels(ORIGIN+BASE,endpoints),told=[];let at=40;
 const routed=routeModels(catalog,async session=>({profile:P,bundle:{'x-gw-launcher-session':'u/'+session},revision:++at}),async r=>{told.push(r);});
 const input={messages:[{role:'user',content:'Hi',timestamp:0}]};
 for(const [id,path] of PATHS){
  const model=catalog.getModel(GATEWAY,id);
  for(const method of ['stream','complete','streamSimple','completeSimple']){
   const from=requests.length,session=id+'/'+method;replies.push(say(method));
   const call=routed[method](model,input,{sessionId:session});
   const reply=method.startsWith('stream')?await call.result():await call;
   assert.equal(reply.stopReason,'stop',reply.errorMessage);assert.deepEqual(reply.content.map(c=>c.text),[method]);
   assert.equal(requests.length,from+1);const [r]=requests.slice(from);
   assert.equal(r.url,ORIGIN+'/upstream/pi/ai-gateway/'+path);assert.equal(r.body.stream,true);
   assert.equal(r.headers['x-gw-launcher-session'],'u/'+session);assert.equal(r.headers['x-session-affinity'],session);
  }
  replies.push(refusal);
  const failed=await routed.completeSimple(model,input,{sessionId:id});
  assert.equal(failed.stopReason,'error');assert.match(failed.errorMessage,/401/);
  assert.deepEqual(told,[at]);told.length=0;
 }
 result.methods=true;}
// A turn in the host on each: a tool call and its continuation carry the run's context and native
// affinity, and a refusal stops the run visibly, told at the binding's revision, sending nothing more.
{let pi=start();admit=admitted;denies.length=0;
 await pi.rpc('open',{agent,tools,route:{...route,revision}});
 for(const [model,path] of PATHS){
  const key='chan/'+model,tooled=toolCalls.length;from=requests.length;replies.push(send(),say('done'));
  assert.equal((await run(pi,'m-'+model,{key,model})).status,'done');
  const pair=requests.slice(from);assert.equal(pair.length,2);
  for(const r of pair){
   assert.equal(r.url,ORIGIN+'/upstream/pi/ai-gateway/'+path);assert.equal(msg(r.headers),'m-'+model);
   assert.match(r.headers['x-session-affinity'],/^[0-9a-f-]{36}$/);assert.equal(r.headers['x-session-affinity'],pair[0].headers['x-session-affinity']);
   assert.match(r.headers['x-gw-launcher-session'],/^00000000-/);assert.equal(r.headers['x-gw-launcher-session'],pair[0].headers['x-gw-launcher-session']);
  }
  // The tool ran through Buzz, and its result went back under the model's own call ID.
  assert.deepEqual(toolCalls.slice(tooled).map(({name,arguments:a,agent:who})=>({name,a,who})),[{name:'send',a:{text:'hi'},who:agent}]);
  assert.deepEqual(toolResult(pair[1].body),{id:path.startsWith('anthropic')?'toolu_1':'call_1',text:POSTED,error:false});
  from=requests.length;replies.push(refusal);
  const denied=await run(pi,'n-'+model,{key,model});
  assert.equal(denied.status,'unanswered');assert.match(denied.detail,/401/);
  assert.deepEqual(denies.at(-1),{op:'deny',agent,revision});assert.equal(requests.length,from+1);
  admit=admitted;
 }
 assert.equal(denies.length,PATHS.length);
 result.protocols=true;

 // Two eligible agents with their own identities and an external one, at once: each gateway request,
 // both in flight together, carries its own agent's identity and Buzz session; the external one never reaches it.
 {const other='f'.repeat(64),both=Promise.withResolvers();let inflight=0;
  await pi.rpc('open',{agent:other,tools,route:{...route,revision,identity:identityOf(other),discovery:discoveryBundle(P,{identity:identityOf(other)}).value}});
  await pi.rpc('open',{agent:outside,tools:[]});
  const held=async(init,url)=>{if(++inflight===2)both.resolve();await both.promise;return say('ok')(init,url);};
  from=requests.length;replies.push(held,held);faux.setResponses([fauxAssistantMessage('local')]);
  const [a,b,x]=await Promise.all([runAs(pi,agent,'c-'+agent,{model:'model-claude-x'}),runAs(pi,other,'c-'+other,{model:'model-gpt-x'}),runAs(pi,outside,'c-x',{provider:'faux',model:'faux-1',gatewayTurn:undefined})]);
  assert.deepEqual([a.status,b.status,x.text],['done','done','local']);
  const sentNow=sent(from);assert.equal(sentNow.length,2);
  for(const h of sentNow){const who=h['x-gw-ctx-agent-pubkey'];assert.equal(msg(h),'c-'+who);}
  assert.deepEqual(sentNow.map(h=>h['x-gw-ctx-agent-pubkey']).sort(),[agent,other].sort());
  assert.notEqual(sentNow[0]['x-gw-launcher-session'],sentNow[1]['x-gw-launcher-session']);
  assert.ok(!requests.some(r=>JSON.stringify(r.headers).includes(outside)));
  result.concurrent=true;}

 // Interrupted mid-request on Responses: the held request is aborted, nothing is denied, and the next turn
 // resumes the same binding and native session.
 {const key='chan/model-gpt-x',told=denies.length;from=requests.length;
  replies.push(init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason))));
  const {submission}=await pi.rpc('deliver',turn('i1',{key,model:'model-gpt-x'}));
  await until(()=>requests.length===from+1);
  await pi.rpc('session',{agent,key,action:'interrupt'});
  const stopped=await pi.rpc('wait',{agent,submission,request:'i1'});
  assert.equal(stopped.status,'unanswered');
  const before=requests[from].headers;from=requests.length;
  assert.equal((await run(pi,'i2',{key,model:'model-gpt-x'})).status,'done');
  assert.equal(binds.at(-1).event,'resume');
  assert.equal(sent(from)[0]['x-gw-launcher-session'],before['x-gw-launcher-session']);
  assert.equal(sent(from)[0]['x-session-affinity'],before['x-session-affinity']);
  assert.equal(denies.length,told);
  result.interrupted=true;}

 // Off the network for one Messages request: Pi durable's retry, after its backoff, sends it again
 // with the same context and native session and completes the run; nothing is denied.
 {const key='chan/model-claude-x',told=denies.length;from=requests.length;
  offline=1;
  assert.equal((await run(pi,'f1',{key,model:'model-claude-x'})).status,'done');
  const [lost,again]=sent(from);assert.equal(sent(from).length,2);
  for(const name of ['x-gw-ctx-message-id','x-gw-launcher-session','x-session-affinity'])assert.equal(again[name],lost[name]);
  assert.equal(msg(again),'f1');assert.equal(denies.length,told);
  result.offline=true;}
 // Timeout: a listing that never answers is bounded by the host's 30 s signal,
 // which only this case shortens; the open fails visibly, nothing is denied,
 // nothing is listed and no other provider is offered in its place.
 {const timeout=AbortSignal.timeout, bounds=[];
  AbortSignal.timeout=ms=>{bounds.push(ms);return timeout.call(AbortSignal,ms===30000?50:ms);};
  const silent='2'.repeat(64), from=listings.length, told=denies.length;
  // AbortSignal.timeout's timer doesn't hold the process open; this does.
  const alive=setInterval(()=>{},1000);
  try{await assert.rejects(pi.rpc('open',{agent:silent,tools,route:{...route,gatewayOrigin:SILENT,revision:5}}),/timeout|aborted/i);}
  finally{AbortSignal.timeout=timeout;clearInterval(alive);}
  assert.deepEqual(bounds,[30000]);
  assert.deepEqual(listings.slice(from).map(l=>l.url),[SILENT+'/upstream/pi/api/2.0/serving-endpoints']);
  assert.deepEqual(denies.slice(told),[]);
  // Nothing is listed for it, from the gateway or any other provider.
  for(const provider of [GATEWAY,'faux'])await assert.rejects(pi.rpc('models',{agent:silent,provider}),/route is not known yet/);
  // The same gateway answering again, a later open lists from it: the failure
  // is not kept as an answer, and the gateway's models are usable.
  silentHangs=false;
  await pi.rpc('open',{agent:silent,tools,route:{...route,gatewayOrigin:SILENT,revision:6}});
  assert.deepEqual(listings.slice(from).map(l=>l.url),Array(2).fill(SILENT+'/upstream/pi/api/2.0/serving-endpoints'));
  assert.deepEqual((await pi.rpc('models',{agent:silent,provider:GATEWAY})).map(m=>m.id),['model-gpt-oss-20b','model-claude-x','model-gpt-x']);
  {const before=requests.length;
   assert.equal((await runAs(pi,silent,'after-timeout',{key:'chan/silent'})).status,'done');
   assert.deepEqual(requests.slice(before).map(r=>new URL(r.url).origin),[SILENT]);}
  await pi.rpc('close',{agent:silent});
  result.timeout=true;}
 // Access varies the catalog: the gateway's listing for the route is the catalog,
 // with nothing added; a model selected before and gone after a re-listing fails
 // its turn without a request and without another model in its place.
 {const varied='1'.repeat(64),key='chan/varied',at={...route,gatewayOrigin:VARIED};
  const exposed=async()=>(await pi.rpc('models',{agent:varied,provider:GATEWAY})).map(m=>m.id);
  const asked=from=>requests.slice(from).map(r=>[new URL(r.url).origin,r.body.model]);
  await pi.rpc('open',{agent:varied,tools,route:{...at,revision:7}});
  assert.deepEqual(await exposed(),['model-gpt-oss-20b','model-claude-x','model-gpt-x']);
  from=requests.length;
  assert.equal((await runAs(pi,varied,'v1',{key,model:'model-gpt-x'})).status,'done');
  assert.deepEqual(asked(from),[[VARIED,'model-gpt-x']]);
  catalogs.set(VARIED,endpoints.filter(e=>e.name==='model-claude-x'));
  await pi.rpc('open',{agent:varied,tools,route:{...at,revision:8}});
  assert.deepEqual(await exposed(),['model-claude-x']);
  assert.deepEqual(await pi.rpc('models',{agent:varied,provider:'faux'}),[]);
  from=requests.length;const told=denies.length;
  await assert.rejects(runAs(pi,varied,'v2',{key,model:'model-gpt-x'}),/Pi has no model model-gpt-x from buzz-gateway/);
  assert.deepEqual(asked(from),[]);assert.equal(denies.length,told);
  assert.equal((await runAs(pi,varied,'v3',{key,model:'model-claude-x'})).status,'done');
  assert.deepEqual(asked(from),[[VARIED,'model-claude-x']]);
  catalogs.delete(VARIED);await pi.rpc('close',{agent:varied});
  result.catalog=true;}
 // Without the gateway: a turn the runner sent without delivery.gateway runs
 // Pi's own provider even on an agent the host has open on the gateway, with
 // no binding, listing or gateway request, and so no Buzz headers. A saved
 // A gateway model fails it visibly, never another model; a missing default stays
 // the agent's own failure. A turn through the gateway after still binds.
 {const who='3'.repeat(64),key='chan/fallback';
  await pi.rpc('open',{agent:who,tools,route:{...route,revision:9}});
  const before={requests:requests.length,listings:listings.length,binds:binds.length,denies:denies.length};
  const unchanged=()=>assert.deepEqual({requests:requests.length,listings:listings.length,binds:binds.length,denies:denies.length},before);
  const ordinary={key,provider:'faux',model:'faux-1',gatewayTurn:undefined};
  const contexts=[];const told=text=>ctx=>{contexts.push(JSON.stringify(ctx));return fauxAssistantMessage(text);};
  faux.setResponses([told('local')]);
  // A wake's notice, the runner's, shows on its own prompt: display only.
  const NOTICE="Ran without the agent gateway: Buzz couldn't reach the gateway.";
  const {submission,conversation}=await pi.rpc('deliver',turn('f1',{agent:who,...ordinary,notice:NOTICE}));
  const done=await pi.rpc('wait',{agent:who,submission,request:'f1'});
  assert.equal(done.status,'done');assert.equal(done.text,'local');
  unchanged();
  const shown=async()=>(await pi.rpc('entries',{agent:who,conversation})).entries.filter(e=>e.notice).map(e=>[e.kind,e.notice,JSON.stringify(e.model).includes('Do it')]);
  assert.deepEqual(await shown(),[['pi.user',NOTICE,true]]);
  assert.equal(contexts.length,1);assert.ok(!contexts[0].includes(NOTICE));
  await assert.rejects(runAs(pi,who,'f2',{...ordinary,provider:GATEWAY,model:'model-gpt-x'}),/available only through the model gateway/);
  await assert.rejects(runAs(pi,who,'f3',{...ordinary,provider:'',model:''}),/has no model/);
  unchanged();
  assert.equal((await runAs(pi,who,'f4',{key})).status,'done');
  const through=requests.slice(before.requests);
  assert.equal(binds.length,before.binds+1);
  assert.deepEqual(through.map(r=>new URL(r.url).origin),[ORIGIN]);
  assert.equal(through[0].headers['x-gw-ctx-agent-pubkey'],who);
  // And back: the next ordinary turn sends nothing to the gateway.
  const after=requests.length;faux.setResponses([told('again')]);
  assert.equal((await runAs(pi,who,'f5',ordinary)).text,'again');
  // Nor in the context its conversation's next turn is given.
  assert.equal(contexts.length,2);assert.ok(contexts[1].includes('local'));assert.ok(!contexts[1].includes(NOTICE));
  assert.equal(requests.length,after);assert.equal(binds.length,before.binds+1);
  const session=through[0].headers['x-gw-launcher-session'];
  // A new session taken without the gateway: its turns, a watch's with its
  // reply destination too, bind nothing; the next through the gateway is the
  // reset's, with a new Buzz session.
  await pi.rpc('session',{agent:who,key,action:'new'});
  faux.setResponses([fauxAssistantMessage('new'),fauxAssistantMessage('woken')]);
  assert.equal((await runAs(pi,who,'f6',ordinary)).text,'new');
  assert.equal((await runAs(pi,who,'f6w',{...ordinary,reply:{channel:'chan',root:'root',topLevel:false}})).text,'woken');
  assert.equal(requests.length,after);assert.equal(binds.length,before.binds+1);
  let from=requests.length;
  assert.equal((await runAs(pi,who,'f7',{key})).status,'done');
  assert.equal(binds.at(-1).event,'reset');
  const renewed=sent(from)[0]['x-gw-launcher-session'];
  assert.ok(renewed&&renewed!==session);
  // Across a restart: Pi's own provider still sends nothing to the gateway,
  // and the gateway resumes the conversation's Buzz session.
  await pi.stop();pi=start();
  await pi.rpc('open',{agent:who,tools,route:{...route,revision:9}});
  // Kept across the restart, on that prompt only.
  assert.deepEqual(await shown(),[['pi.user',NOTICE,true]]);
  from=requests.length;const bound=binds.length;
  faux.setResponses([fauxAssistantMessage('restarted')]);
  assert.equal((await runAs(pi,who,'f8',ordinary)).text,'restarted');
  assert.equal(requests.length,from);assert.equal(binds.length,bound);
  assert.equal((await runAs(pi,who,'f9',{key})).status,'done');
  assert.equal(binds.at(-1).event,'resume');
  assert.deepEqual([...new Set(sent(from).map(h=>h['x-gw-launcher-session']))],[renewed]);
  // A request bound to the gateway, asked again without it after a restart,
  // keeps its mode: Pi's own submission answers it, and its run continues
  // through the gateway with its own Buzz context. Nothing binds or switches.
  replies.push(init=>new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(init.signal.reason))));
  from=requests.length;
  const held=await pi.rpc('deliver',turn('f10',{agent:who,key}));
  await until(()=>requests.length>from);
  await pi.stop();pi=start();
  await pi.rpc('open',{agent:who,tools,route:{...route,revision:9}});
  const again=requests.length;
  const replayed=await pi.rpc('deliver',turn('f10',{agent:who,...ordinary}));
  assert.deepEqual(replayed,held);
  assert.equal((await pi.rpc('wait',{agent:who,submission:held.submission,request:'f10'})).status,'done');
  assert.deepEqual(await pi.rpc('deliver',turn('f10',{agent:who,key,gatewayTurn:undefined})),held);
  assert.ok(requests.length>again);
  for(const h of sent(again)){assert.equal(msg(h),'f10');assert.equal(h['x-gw-launcher-session'],renewed);}
  // And an ordinary request asked again through the gateway stays ordinary.
  const ownBinds=binds.length,ownRequests=requests.length;
  faux.setResponses([fauxAssistantMessage('own')]);
  const own=await pi.rpc('deliver',turn('f11',{agent:who,...ordinary}));
  assert.equal((await pi.rpc('wait',{agent:who,submission:own.submission,request:'f11'})).text,'own');
  assert.deepEqual(await pi.rpc('deliver',turn('f11',{agent:who,key})),own);
  assert.equal(binds.length,ownBinds);assert.equal(requests.length,ownRequests);
  await pi.rpc('close',{agent:who});
  result.fallback=true;}
 // Mode boundary: a turn steers only a run in its own mode. One in the other
 // mode waits for that run to end, then runs in its own: the gateway sees no
 // ordinary input, and Pi's own provider no gateway turn.
 {const who='4'.repeat(64),key='chan/boundary',at={...route,revision:9};
  await pi.rpc('open',{agent:who,tools,route:at});
  const ordinary={key,provider:'faux',model:'faux-1',gatewayTurn:undefined};
  const tick=()=>new Promise(r=>setTimeout(r,50));
  // Ordinary first, the gateway's turn while it works.
  const held=Promise.withResolvers(),started=Promise.withResolvers();const seen=[];
  faux.setResponses([async c=>{seen.push(JSON.stringify(c));started.resolve();await held.promise;return fauxAssistantMessage('ordinary answer');}]);
  let from=requests.length;
  const a=await pi.rpc('deliver',turn('b1',{agent:who,...ordinary,text:'ordinary work',steer:'ordinary work'}));
  await started.promise;
  replies.push(say('gateway answer'));
  let handed=false;
  const b=pi.rpc('deliver',turn('b2',{agent:who,key,text:'gateway work',steer:'gateway work'})).then(v=>{handed=true;return v;});
  await tick();
  assert.equal(handed,false);assert.equal(requests.length,from);
  held.resolve();
  assert.equal((await pi.rpc('wait',{agent:who,submission:a.submission,request:'b1'})).text,'ordinary answer');
  const gateway=await pi.rpc('wait',{agent:who,submission:(await b).submission,request:'b2'});
  assert.equal(gateway.status,'done');
  assert.equal(seen.length,1);assert.ok(!seen[0].includes('gateway work'));
  assert.deepEqual(sent(from).map(msg),['b2']);
  // The gateway's first, an ordinary turn while it works.
  const gate=Promise.withResolvers(),asked=Promise.withResolvers();
  replies.push(async(init,url)=>{asked.resolve();await gate.promise;return say('gateway again')(init,url);});
  from=requests.length;
  const c=await pi.rpc('deliver',turn('b3',{agent:who,key}));
  await asked.promise;
  faux.setResponses([fauxAssistantMessage('ordinary after')]);
  handed=false;
  const d=pi.rpc('deliver',turn('b4',{agent:who,...ordinary,text:'ordinary private work',steer:'ordinary private work'})).then(v=>{handed=true;return v;});
  await tick();
  assert.equal(handed,false);
  gate.resolve();
  assert.equal((await pi.rpc('wait',{agent:who,submission:c.submission,request:'b3'})).status,'done');
  assert.equal((await pi.rpc('wait',{agent:who,submission:(await d).submission,request:'b4'})).text,'ordinary after');
  assert.ok(requests.slice(from).every(r=>!JSON.stringify(r.body).includes('ordinary private work')));
  assert.deepEqual(sent(from).map(msg),['b3']);
  // Its route changes in place: the ordinary run carries on, and the models
  // it lists follow the route.
  const kept=Promise.withResolvers(),working=Promise.withResolvers();
  faux.setResponses([async()=>{working.resolve();await kept.promise;return fauxAssistantMessage('kept');}]);
  const e=await pi.rpc('deliver',turn('b5',{agent:who,...ordinary}));
  await working.promise;
  assert.deepEqual(await pi.rpc('open',{agent:who,tools,route:{kind:'external'}}),{gateway:false,held:false});
  assert.deepEqual((await pi.rpc('models',{agent:who,provider:'faux'})).map(m=>m.id),['faux-1']);
  assert.deepEqual(await pi.rpc('open',{agent:who,tools,route:at}),{gateway:true,held:false});
  // Opened for work on Pi's own providers, it keeps the route it has.
  assert.deepEqual(await pi.rpc('open',{agent:who,tools}),{gateway:true,held:false});
  assert.deepEqual(await pi.rpc('models',{agent:who,provider:'faux'}),[]);
  kept.resolve();
  assert.equal((await pi.rpc('wait',{agent:who,submission:e.submission,request:'b5'})).text,'kept');
  // Bound, and waiting for the other mode's run, when the agent's route
  // leaves the gateway: never sent on the route it no longer has.
  const holding=Promise.withResolvers(),busy=Promise.withResolvers();
  faux.setResponses([async()=>{busy.resolve();await holding.promise;return fauxAssistantMessage('done');}]);
  from=requests.length;
  const g=await pi.rpc('deliver',turn('b8',{agent:who,...ordinary}));
  await busy.promise;
  const late=pi.rpc('deliver',turn('b9',{agent:who,key}));
  await tick();
  await pi.rpc('open',{agent:who,tools,route:{kind:'external'}});
  holding.resolve();
  await assert.rejects(late,/model route changed/);
  assert.equal((await pi.rpc('wait',{agent:who,submission:g.submission,request:'b8'})).text,'done');
  assert.equal(requests.length,from);
  await pi.rpc('open',{agent:who,tools,route:at});
  // Closed while a turn waits for the other mode's run: it fails, and stays
  // unsubmitted for the next open.
  const parked=Promise.withResolvers(),stuck=Promise.withResolvers();
  replies.push(async(init,url)=>{stuck.resolve();await parked.promise;return say('late')(init,url);});
  await pi.rpc('deliver',turn('b6',{agent:who,key}));
  await stuck.promise;
  const waiting=pi.rpc('deliver',turn('b7',{agent:who,...ordinary}));
  await tick();
  const closing=pi.rpc('close',{agent:who});
  await assert.rejects(waiting,/closed/);
  parked.resolve();await closing;
  result.boundary=true;}
 // What Pi holds decides a turn's mode, not the runs it has been seen to
 // start: a gateway run whose start is not yet seen still keeps an ordinary
 // turn out. Closing ends a turn that waits, whenever it comes; a noted turn
 // that fails before Pi has its prompt shows its notice beside that failure.
 {const who='5'.repeat(64),key='chan/held',at={...route,revision:9};
  await pi.rpc('open',{agent:who,tools,route:at});
  const ordinary={key,provider:'faux',model:'faux-1',gatewayTurn:undefined};
  const tick=()=>new Promise(r=>setTimeout(r,50));
  const seen=Promise.withResolvers(),unseen=Promise.withResolvers(),asked=Promise.withResolvers(),answer=Promise.withResolvers();
  runStart=async()=>{runStart=undefined;seen.resolve();await unseen.promise;};
  replies.push(async(init,url)=>{asked.resolve();await answer.promise;return send()(init,url);},say('gateway answer'));
  let from=requests.length;
  const a=await pi.rpc('deliver',turn('h1',{agent:who,key,text:'gateway private work',steer:'gateway private work'}));
  await asked.promise;await seen.promise;
  const contexts=[];faux.setResponses([c=>{contexts.push(JSON.stringify(c));return fauxAssistantMessage('ordinary answer');}]);
  let handed=false;
  const b=pi.rpc('deliver',turn('h2',{agent:who,...ordinary,text:'ordinary work',steer:'ordinary work'})).then(v=>{handed=true;return v;});
  await tick();
  assert.equal(handed,false);
  unseen.resolve();answer.resolve();
  assert.equal((await pi.rpc('wait',{agent:who,submission:a.submission,request:'h1'})).text,'gateway answer');
  assert.equal((await pi.rpc('wait',{agent:who,submission:(await b).submission,request:'h2'})).text,'ordinary answer');
  // The gateway run continued through the gateway after its tool call; Pi's
  // own provider was asked once, for the ordinary turn after it.
  assert.deepEqual(sent(from).map(msg),['h1','h1']);assert.equal(contexts.length,1);
  assert.ok(requests.slice(from).every(r=>!JSON.stringify(r.body).includes('ordinary work')));
  // Closed while the waiting turn reads the conversation's mode.
  const working=Promise.withResolvers(),done=Promise.withResolvers(),reading=Promise.withResolvers(),read=Promise.withResolvers();
  replies.push(async(init,url)=>{working.resolve();await done.promise;return say('late')(init,url);});
  await pi.rpc('deliver',turn('h3',{agent:who,key}));
  await working.promise;
  modeRead=async()=>{modeRead=undefined;reading.resolve();await read.promise;};
  let settled=false;
  const waiting=pi.rpc('deliver',turn('h4',{agent:who,...ordinary})).finally(()=>{settled=true;});
  await reading.promise;
  const closing=pi.rpc('close',{agent:who});
  done.resolve();await closing;
  read.resolve();
  await assert.rejects(waiting,/This agent was closed/);assert.ok(settled);
  // A wake's notice, with the failure that came before Pi had its prompt.
  await pi.rpc('open',{agent:who,tools});
  const NOTICE="Ran without the agent gateway: Buzz couldn't reach the gateway.";
  await assert.rejects(pi.rpc('deliver',turn('h5',{agent:who,key:'chan/unset',provider:'',model:'',gatewayTurn:undefined,notice:NOTICE})),/has no model/);
  const {places}=await pi.rpc('places',{agent:who});
  const {entries}=await pi.rpc('entries',{agent:who,conversation:places.find(p=>p.key==='chan/unset').conversation});
  assert.deepEqual(entries.map(e=>[e.kind,e.notice,/has no model/.test(e.error),'model' in e,typeof e.at]),[['buzz.notice',NOTICE,true,false,'number']]);
  await pi.rpc('close',{agent:who});
  result.held=true;}
 await pi.stop();}
// PI_WIRE_CAPTURE names a file for every model request's headers, as evidence.
if(process.env.PI_WIRE_CAPTURE){const {writeFileSync}=await import('node:fs');writeFileSync(process.env.PI_WIRE_CAPTURE,JSON.stringify(requests.map(r=>({url:r.url.replace(ORIGIN,'<gateway>'),compaction:summary(r.body),stream:r.body.stream,body:Object.keys(r.body).sort(),headers:Object.fromEntries(Object.entries(r.headers).filter(([k])=>!/authorization|api-key/i.test(k)))})),null,1));}
console.log(JSON.stringify(result));
`;

it.skipIf(!deps)(
  "routes gateway mode requests with their run's Buzz context",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-gateway-"));
    try {
      await symlink(
        join(deps ?? "", "node_modules"),
        join(folder, "node_modules"),
      );
      await writeFile(join(folder, "host.mjs"), host);
      await writeFile(join(folder, "driver.mjs"), driver);
      await writeFile(join(folder, "vectors.json"), JSON.stringify(vectors));
      // The shared gateway contract as it is, run by Node with its types stripped.
      await writeFile(join(folder, "contract.ts"), contract);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          join(folder, "driver.mjs"),
          folder,
        ],
        { cwd: folder, timeout: 60000 },
      );
      expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual(
        Object.fromEntries(
          [
            "composition",
            "vectors",
            "carrier",
            "external",
            "discovery",
            "overlap",
            "firstTurn",
            "secondTurn",
            "invalidated",
            "denied",
            "reset",
            "standalone",
            "automation",
            "compaction",
            "manualCompaction",
            "queued",
            "provenance",
            "background",
            "resetCrash",
            "restart",
            "detached",
            "protected",
            "methods",
            "protocols",
            "concurrent",
            "interrupted",
            "offline",
            "timeout",
            "catalog",
            "fallback",
            "boundary",
            "held",
          ].map((key) => [key, true]),
        ),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  90000,
);
