import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpHarnessAdapter } from '../src/harnesses/acp-generic.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import { Orchestrator } from '../src/orchestrator.js';
import { ProfileStore, TeamStore, launchTeam, safeEnvAllowlist } from '../src/presets.js';
import { assertAllowedPath } from '../src/security.js';

test('presets persist validated fields, enforce roots, and reject dangerous environment names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-'));
  try {
    const check = (cwd: string) => assertAllowedPath(cwd, [dir], true);
    const profiles = new ProfileStore(dir, check);
    const p = profiles.create({ name: 'App', cwd: dir, harnessId: 'test', model: 'm', subagentModel: 's', prelude: 'project rules', envAllowlist: ['FOO'], commonCommands: ['npm test'], defaultBranch: 'main', gitWorkflowNotes: 'no force pushes' });
    assert.throws(() => profiles.update(p.id, { cwd: '/outside' }), /outside allowed roots/);
    assert.throws(() => profiles.update(p.id, { envAllowlist: ['NODE_OPTIONS'] }), /Unsafe/);
    assert.throws(() => safeEnvAllowlist(['LD_PRELOAD']), /Unsafe/);
    assert.equal(new ProfileStore(dir, check).get(p.id)?.gitWorkflowNotes, 'no force pushes');
    assert.equal(profiles.get(p.id)?.cwd, dir);
    const teams = new TeamStore(dir, check);
    const t = teams.create({ name: 'Delivery', cwd: dir, roles: [{ name: 'reviewer', harnessId: 'test', mode: 'auto', effort: 'high', instruction: 'Review only' }] });
    assert.equal(new TeamStore(dir, check).get(t.id)?.roles[0].instruction, 'Review only');
    assert.throws(() => teams.update(t.id, { cwd: '/outside' }), /outside allowed roots/);
    assert.equal(teams.delete(t.id), true);
    assert.equal(profiles.delete(p.id), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model, role settings and inherited prelude survive a gateway restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-agent-'));
  const agent = join(dir, 'agent.cjs');
  writeFileSync(agent, `#!/usr/bin/env node
const readline = require('readline');
let n = 0;
const out = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...x}) + '\\n');
const options = [
  { id:'model', category:'model', currentValue:'base', options:[{value:'base'},{value:'main'},{value:'child'}] },
  { id:'effort', currentValue:'low', options:[{value:'low'},{value:'high'}] },
  { id:'mode', category:'mode', currentValue:'auto', options:[{value:'auto',name:'Auto'},{value:'code',name:'Code'}] }
];
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') out({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
  else if (m.method === 'session/new') out({id:m.id,result:{sessionId:'s'+(++n),configOptions:options}});
  else if (m.method === 'session/load') { n = Math.max(n, 1); out({id:m.id,result:{configOptions:options}}); }
  else if (m.method === 'session/set_config_option') {
    const o=options.find(o=>o.id===m.params.configId); if(o) o.currentValue=m.params.value;
    out({id:m.id,result:{configOptions:options}});
  } else if (m.method === 'session/prompt') {
    out({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.params.prompt[0].text}}}});
    out({id:m.id,result:{stopReason:'end_turn'}});
  } else if(m.id !== undefined) out({id:m.id,result:{}});
});
`, { mode: 0o755 });
  const make = () => { const registry = new HarnessRegistry(join(dir, 'data')); const adapter = new AcpHarnessAdapter({ id:'fake', name:'fake', bin:agent, acpArgs:[] }); registry.register(adapter); return {registry, adapter}; };
  let first = make();
  let second: ReturnType<typeof make> | undefined;
  try {
    const s = await first.registry.createSession('fake', dir, { model:'main', subagentModel:'child', prelude:'Project rules' });
    assert.equal(s.configOptions.find(o => o.id === 'model')?.currentValue, 'main');
    await first.adapter.prompt(s.sessionId, 'original');
    assert.match(s.events.find(e => e.update.sessionUpdate === 'user_message_chunk')?.update.content.text, /Project rules/);
    first.adapter.stop();
    second = make();
    const loaded = await second.adapter.ensureLoaded(s.sessionId, dir);
    assert.equal(loaded.options.subagentModel, 'child');
    assert.equal(loaded.options.prelude, 'Project rules');
    assert.equal(loaded.preludePending, false);
    const orch = new Orchestrator(second.registry, join(dir, 'data'));
    const team = { id:'t', name:'T', roles:[{name:'reviewer', harnessId:'fake', mode:'code', effort:'high', instruction:'Review only'}] };
    const [started] = await launchTeam(orch, team, 'inspect', dir, x => x, 'fake:s1');
    await started.done;
    assert.equal(started.link.applied?.model, 'child');
    assert.equal(started.link.applied?.mode, 'code');
    assert.equal(started.link.applied?.config.effort, 'high');
    assert.match(started.link.output ?? '', /Project rules/);
    assert.match(started.link.output ?? '', /Review only/);
  } finally {
    first.adapter.stop(); second?.adapter.stop();
    rmSync(dir, { recursive:true, force:true });
  }
});

