import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MODEL, validateNotes } from './notes.mjs';
import { summarize } from './runner.mjs';
import { publicFailure } from './errors.mjs';
// SQLite and refresh writes must remain private, including newly created files.
process.umask(0o077);
export const MAX_BODY = 1024*1024;
export function createBridge({key, run=summarize}={}) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('Missing private bridge credential');
  const expected=Buffer.from(`Bearer ${key}`);
  let busy=false;
  const server=http.createServer(async(req,res) => {
    const send=(status,data) => { if (!res.destroyed) { res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data)); } };
    const supplied=Buffer.from(req.headers.authorization || '');
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) { send(401,{error:'Unauthorized'});req.resume();return; }
    if(req.method==='GET' && req.url==='/health') return send(200,{ok:true});
    if(req.method==='GET' && req.url==='/v1/models') return send(200,{object:'list',data:[{id:MODEL,object:'model',owned_by:'parley-codex-subscription'}]});
    if(req.method!=='POST' || req.url!=='/v1/chat/completions') {send(404,{error:'Not found'});req.resume();return;}
    if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||'')) {send(415,{error:'JSON required'});req.resume();return;}
    if(Number(req.headers['content-length'])>MAX_BODY) {send(413,{error:'Payload too large'});req.resume();return;}
    if(busy) {send(429,{error:'Summarizer busy'});req.resume();return;}
    busy=true;
    const abort=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    let started=false;
    try {
      let size=0;const chunks=[];
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>MAX_BODY) {send(413,{error:'Payload too large'});return;}
        chunks.push(chunk);
      }
      let body;
      try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {send(400,{error:'Invalid JSON'});return;}
      if(!body || Object.keys(body).some(k=>!['model','messages'].includes(k)) || body.model!==MODEL ||
        !Array.isArray(body.messages) || body.messages.length!==1 ||
        Object.keys(body.messages[0]||{}).sort().join(',')!=='content,role' || body.messages[0].role!=='user' ||
        typeof body.messages[0].content!=='string' || !body.messages[0].content.trim()) {
        send(400,{error:'Only the configured single-message summary model is allowed'});return;
      }
      started=true;
      const notes=validateNotes(await run(body.messages[0].content,abort.signal));
      send(200,{object:'chat.completion',model:MODEL,choices:[{index:0,message:{role:'assistant',content:JSON.stringify(notes)},finish_reason:'stop'}]});
      console.log(JSON.stringify({event:'summary_completed',provider:'openai-codex',model:MODEL,tools:0}));
    } catch (error) {
      const {status,body}=publicFailure(error);
      send(started?status:400,started?body:{error:'Invalid request'});
      const m=error?.metadata;
      console.log(JSON.stringify({event:'summary_failed',provider:'openai-codex',model:MODEL,category:body.category,status,
        ...(m?{exit:m.exit,signal:m.signal,elapsed_ms:m.elapsed_ms,stdout_bytes:m.stdout_bytes,stderr_bytes:m.stderr_bytes}:{})}));
    } finally {busy=false;}
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.timeout=180_000;server.maxHeadersCount=32;
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const key=readFileSync('/run/secrets/bridge-key','utf8').trim();
  createBridge({key}).listen(8080,'0.0.0.0',()=>console.log('Parley private Codex summarizer listening'));
}
