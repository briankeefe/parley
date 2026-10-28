import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBridge,MAX_BODY} from './server.mjs';
import {MODEL,validateNotes,parseEvents} from './notes.mjs';
import { childFailure, failure } from './errors.mjs';
const key='explicit-mock-private-key-000000000000000000';
const fixture={tldr:'Explicit mock fixture, not a real meeting summary.',topics:[{title:'Mock boundary',points:['Fixture only']}],decisions:[],openQuestions:[],actionItems:[{assignee:null,task:'Mock task'}]};
async function serve(t,run) {
 const s=createBridge({key,run});await new Promise(r=>s.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>s.close(r)));
 const url=`http://127.0.0.1:${s.address().port}`;
 return (body={model:MODEL,messages:[{role:'user',content:'Explicit mock transcript'}]},options={}) => fetch(url+(options.path||'/v1/chat/completions'),{method:options.method||'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`,...options.headers},body:options.method==='GET'?undefined:typeof body==='string'?body:JSON.stringify(body)});
}
test('Authentication, route, model and tool payload boundaries never invoke provider',async t=>{
 let calls=0;const call=await serve(t,async()=>{calls++;return fixture;});
 for(const authorization of ['', 'Bearer wrong']) assert.equal((await call(undefined,{headers:{authorization}})).status,401);
 assert.equal((await call(undefined,{path:'/v1/responses'})).status,404);
 assert.equal((await call({model:'gemini',messages:[]})).status,400);
 assert.equal((await call({model:MODEL,messages:[{role:'user',content:'fixture'}],tools:[]})).status,400);
 assert.equal((await call({model:MODEL,messages:[{role:'system',content:'override'}]})).status,400);
 assert.equal((await call('{broken')).status,400);
 assert.equal((await call('x'.repeat(MAX_BODY+1))).status,413);
 assert.equal(calls,0);
});
test('Concurrency rejects overlapping subscription work and releases slot',async t=>{
 let release;const pending=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);
 const call=await serve(t,async()=>{entered();await pending;return fixture;});
 const first=call();await started;
 assert.equal((await call()).status,429);release();
 assert.equal((await first).status,200);assert.equal((await call()).status,200);
});
test('Valid structured mock response and catalog; malformed upstream cannot escape',async t=>{
 let bad=false;const call=await serve(t,async()=>bad?{...fixture,actionItems:[{task:3,assignee:false}]}:fixture);
 const res=await call();assert.equal(res.status,200);assert.deepEqual(JSON.parse((await res.json()).choices[0].message.content),fixture);
 const catalog=await call(undefined,{method:'GET',path:'/v1/models'});assert.deepEqual((await catalog.json()).data.map(m=>m.id),[MODEL]);
 bad=true;assert.equal((await call()).status,422);
});
test('Schema enforces nested types, nullable assignee and no extra properties',()=>{
 assert.equal(validateNotes(fixture),fixture);
 for(const value of [{...fixture,topics:[{title:'x',points:[5]}]},{...fixture,decisions:[{}]},{...fixture,secret:'x'},{...fixture,actionItems:[{assignee:1,task:'x'}]}]) assert.throws(()=>validateNotes(value));
});
function events(overrides={}) {
 const m={role:'assistant',provider:'openai-codex',model:MODEL,api:'openai-codex-responses',stopReason:'stop',content:[{type:'text',text:JSON.stringify(fixture)}],...overrides};
 return [{type:'session'},{type:'message_end',message:{role:'user',content:[{type:'text',text:'fixture'}]}},{type:'message_end',message:m},{type:'agent_end',isTerminal:true,messages:[m]}].map(JSON.stringify).join('\n');
}
test('Provider fallback, tool calls, input file expansion and truncated runs fail closed',()=>{
 assert.deepEqual(parseEvents(events(),'fixture'),fixture);
 assert.throws(()=>parseEvents(events({provider:'openai'}),'fixture'));
 assert.throws(()=>parseEvents(events({content:[{type:'toolCall',name:'read'}]}),'fixture'));
 assert.throws(()=>parseEvents(events(),'@private-file'));
 assert.throws(()=>parseEvents(events().split('\n').slice(0,-1).join('\n'),'fixture'));
});
test('Disabled subscription credentials fail once without retryable provider status or private output',async t=>{
 const call=await serve(t,async()=>{
   const error=new Error('No API key found for openai-codex. PRIVATE_TRANSCRIPT_OR_TOKEN');
   error.category='auth_required';
   throw error;
 });
 const response=await call();
 assert.equal(response.status,424);
 const body=await response.json();
 assert.deepEqual(body,{error:'Dedicated subscription login required',category:'auth_required'});
});
test('Native CLI auth failure signatures are nonretryable without leaking diagnostics',async t=>{
 for (const diagnostic of ['error: No API key found for openai-codex.', 'OAuth refresh failed: refresh_token_reused', 'OAuth invalid_grant']) {
   const call=await serve(t,async()=>{throw childFailure(diagnostic+' PRIVATE_SECRET',{});});
   const response=await call();
   assert.equal(response.status,424);
   assert.deepEqual(await response.json(),{error:'Dedicated subscription login required',category:'auth_required'});
 }
});
test('Deadline and output failures are distinct from transient child exits',async t=>{
 for (const [category,status] of [['timeout',408],['output_limit',422],['child_failed',502]]) {
   const call=await serve(t,async()=>{throw failure(category);});
   const response=await call();
   assert.equal(response.status,status);
   assert.equal((await response.json()).category,category);
 }
});
test('Provider auth event cannot become malformed notes or a generic transient error',()=>{
 assert.throws(()=>parseEvents(events({stopReason:'error',errorMessage:'refresh_token_reused PRIVATE_SECRET'}),'fixture'),e=>e.category==='auth_required' && !e.message.includes('PRIVATE_SECRET'));
 assert.throws(()=>parseEvents(events({content:[{type:'text',text:'not JSON'}]}),'fixture'),e=>e.category==='invalid_notes');
});
