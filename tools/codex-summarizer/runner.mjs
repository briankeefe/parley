import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { SYSTEM, MODEL, PROVIDER, parseEvents } from './notes.mjs';
import { failure, childFailure } from './errors.mjs';
export const FLAGS = ['-p','--mode','json','--no-tools','--no-lsp','--no-pty','--no-extensions','--no-skills','--no-rules','--no-title','--no-session','--model',`${PROVIDER}/${MODEL}`,'--thinking','low','--max-time','150','--system-prompt',SYSTEM];
export async function summarize(input, signal) {
  const workspace = await mkdtemp('/tmp/summary-');
  try {
    return await new Promise((resolve,reject) => {
      const child = spawn('/bridge/omp',FLAGS,{
        cwd:workspace, env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/runtime',PI_CODING_AGENT_DIR:'/auth',TMPDIR:'/tmp',NO_COLOR:'1'},
        stdio:['pipe','pipe','pipe'], detached:true,
      });
      let out = '', stderr = '', bytes = 0, stderrBytes = 0, failed = false;
      const started = Date.now();
      const kill = () => { try { process.kill(-child.pid,'SIGKILL'); } catch {} };
      const fail = error => { if (!failed) { failed = error; kill(); } };
      const timer = setTimeout(() => fail(failure('timeout')),160_000);
      const abort = () => fail(failure('cancelled'));
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4*1024*1024) fail(failure('output_limit'));
        else out += chunk;
      });
      // Keep a bounded private prefix for classification; never emit its text.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderr.length < 16384) stderr += chunk.slice(0, 16384 - stderr.length);
      });
      child.stdin.on('error',() => {});
      child.on('error',fail);
      child.on('close',(code, childSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort',abort);
        const metadata = {exit:code,signal:childSignal,elapsed_ms:Date.now()-started,stdout_bytes:bytes,stderr_bytes:stderrBytes};
        if (failed) { failed.metadata = metadata; return reject(failed); }
        if (code !== 0) return reject(childFailure(stderr, metadata));
        try { resolve(parseEvents(out,input)); } catch (error) {
          reject(error.category ? Object.assign(error,{metadata}) : failure('invalid_trace',metadata));
        }
      });
      // stdin only; never positional arguments or @file parsing.
      child.stdin.end(input);
    });
  } finally { await rm(workspace,{recursive:true,force:true}); }
}
