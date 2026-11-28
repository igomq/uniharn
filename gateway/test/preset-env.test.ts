import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { launchProfile } from '../src/presets.js';

test('concurrent profiles use separate matching process environments', async () => {
  if (!process.env.UNIHARN_PRESET_TEST_CHILD) {
    const env = { ...process.env, UNIHARN_PRESET_TEST_CHILD: '1', PROFILE_ALPHA_TEST: 'alpha', PROFILE_BETA_TEST: 'beta' };
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    execFileSync(process.execPath, ['--import', 'tsx', '--test', 'test/preset-env.test.ts'], {
      cwd: process.cwd(), env, timeout: 15000,
    });
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'preset-env-'));
  const bin = join(dir, 'agent.cjs');
  writeFileSync(bin, `#!/usr/bin/env node
const readline = require('readline');
let n=0;
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  else if(m.method==='session/new') send({id:m.id,result:{sessionId:'s'+(++n)}});
  else if(m.method==='session/load') send({id:m.id,result:{}});
  else if(m.method==='session/prompt') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({alpha:process.env.PROFILE_ALPHA_TEST ?? null,beta:process.env.PROFILE_BETA_TEST ?? null})}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  } else if(m.id!==undefined) send({id:m.id,result:{}});
});
`, {mode:0o755});
  const registry = new HarnessRegistry(join(dir, 'data'));
  const alpha = new AcpHarnessAdapter({id:'alpha',name:'Alpha',bin,acpArgs:[],custom:true,envAllowlist:['PROFILE_ALPHA_TEST']});
  const beta = new AcpHarnessAdapter({id:'beta',name:'Beta',bin,acpArgs:[],custom:true,envAllowlist:['PROFILE_BETA_TEST']});
  registry.register(alpha); registry.register(beta);
  try {
    const [a,b] = await Promise.all([
      launchProfile(registry, {id:'a',name:'A',cwd:dir,harnessId:'alpha',envAllowlist:['PROFILE_ALPHA_TEST']}, x => x),
      launchProfile(registry, {id:'b',name:'B',cwd:dir,harnessId:'beta',envAllowlist:['PROFILE_BETA_TEST']}, x => x),
    ]);
    await Promise.all([alpha.prompt(a.sessionId,'a'), beta.prompt(b.sessionId,'b')]);
    for (let i=0;i<100 && (!a.events.some(e=>e.update.sessionUpdate==='_turn_end') || !b.events.some(e=>e.update.sessionUpdate==='_turn_end'));i++) await new Promise(r=>setTimeout(r,10));
    const reply = (s: typeof a) => JSON.parse(s.events.find(e=>e.update.sessionUpdate==='agent_message_chunk')!.update.content.text);
    assert.deepEqual(reply(a), {alpha:'alpha',beta:null});
    assert.deepEqual(reply(b), {alpha:null,beta:'beta'});
    await assert.rejects(launchProfile(registry, {id:'bad',name:'Bad',cwd:dir,harnessId:'alpha',envAllowlist:['PROFILE_BETA_TEST']}, x=>x), /does not match/);
    alpha.configure({envAllowlist:['PROFILE_BETA_TEST']});
    await assert.rejects(alpha.ensureLoaded(a.sessionId,dir), /does not match/);
    await assert.rejects(launchProfile(registry, {id:'changed',name:'Changed',cwd:dir,harnessId:'alpha',envAllowlist:['PROFILE_BETA_TEST']}, x=>x), /running custom harness/);
  } finally { alpha.stop(); beta.stop(); rmSync(dir,{recursive:true,force:true}); }
});

