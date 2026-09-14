// Opt-in native subscription acceptance probe. Runs only disposable sessions.
// Set REMUX_COMPACT_ACTIVE=1 to compact directly during the foreground Agent wait.
// From extensions/agent:
// remux workload exec --workload research --operation codex-rd:input-acceptance --threads 2 -- node --experimental-strip-types tests/live/conversation-input-acceptance.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeNativeAdapter } from '../../server/src/providers/claude/claude-adapter.ts';
import { NativeFixtureAdapter } from '../../server/src/native-fixture-adapter.ts';
import { NativeAgentCoordinator } from '../../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../../server/src/native-runtime/schema.ts';
const cwd = await mkdtemp('/tmp/remux-active-input-integration-');
let release; let entered = false;
const gatePromise = new Promise(r => release = r);
const gate = createSdkMcpServer({ name: 'gate', version: '1', tools: [tool('wait', 'Wait for host release.', {}, async () => {
  entered = true; await gatePromise; return {content:[{type:'text',text:'GATE_RELEASED'}]};
})] });
function monitor(q) {
  if (process.env.REMUX_INPUT_TRACE !== '1') return q;
  return new Proxy(q, {get(target, key) {
    if (key === Symbol.asyncIterator) return async function* () { for await (const m of target) {
      if (m.type === 'user' || m.type === 'result') console.log(JSON.stringify({native:true,type:m.type,uuid:m.uuid,isReplay:m.isReplay,parent:m.parent_tool_use_id,user_message_uuid:m.user_message_uuid}));
      yield m;
    }};
    if (key === 'backgroundTasks') return async id => {console.log(JSON.stringify({control:'backgroundTasks',id}));return target.backgroundTasks(id);};
    const v = Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
  }});
}
const native = new ClaudeNativeAdapter({ acceptanceTimeoutMs: 45000, createQuery: ({prompt, options}) => monitor(query({ prompt, options: {
  ...options, pathToClaudeCodeExecutable: '/home/ubuntu/.local/bin/claude', persistSession: false,
  settingSources: [], settings: {disableAllHooks:true,autoCompactEnabled:false,precomputeCompactionEnabled:false}, hooks: {},
  mcpServers:{gate}, strictMcpConfig:true,
  permissionMode:'bypassPermissions', allowDangerouslySkipPermissions:true, sandbox:{enabled:false},
  systemPrompt: {type:'preset',preset:'claude_code',append:'Isolated runtime test. Use only the requested single native Agent child and the provided gate tool. Do not read or write files, use skills, or network.'},
} })) });
const base = new NativeFixtureAdapter({provider:'claude-code',manualCompaction:true});
const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys=ON'); createNativeAgentSchema(database);
const journal = new NativeAgentJournal(database);
const coordinator = new NativeAgentCoordinator({journal,providers:[{providerInstanceId:'claude-local',provider:'claude-code',label:'Claude',adapter:{
  probe:async(id)=>{const p=await base.probe(id);return {...p,capabilities:{...p.capabilities,turns:{...p.capabilities.turns,activeInput:'stream-input'},compaction:{...p.capabilities.compaction,activeParent:'background-native-agent'}}};},
  listModels:async()=>[{id:'fable[1m]',name:'Fable',provider:'claude-code',supportedEffort:['low'],isDefault:true}],
  openSession:input=>native.openSession(input),
}}]});
const until = async (fn, timeout=90000) => { const end=Date.now()+timeout; while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout waiting for integration state');};
let conversationId;
const send = async (id,text) => {const r=coordinator.projector.runtimeResource(conversationId);return coordinator.sendMessage({commandId:id,clientMessageId:`client-${id}`,conversationId,providerInstanceId:r.providerInstanceId,model:r.composer.nextTurn.model,effort:r.composer.nextTurn.effort,serviceTier:r.composer.nextTurn.serviceTier,access:r.composer.nextTurn.access,configurationRevision:r.composer.revision,delivery:'auto',content:[{type:'text',text}]});};
const log = stage => console.log(JSON.stringify({stage,turns:journal.turns(conversationId).map(t=>({id:t.turnId,state:t.state})),inputs:database.prepare('SELECT client_message_id,turn_id FROM turn_inputs').all(),deliveries:database.prepare('SELECT command_id,kind,state,recovery_json,acceptance_evidence_json FROM delivery_attempts').all()}));
const deadline=setTimeout(()=>{release();void coordinator.close();},180000);
try {
  await coordinator.initialize();
  ({conversationId}=await coordinator.createConversation({commandId:'create-live-input',providerInstanceId:'claude-local',cwd,model:'fable[1m]',effort:'low',access:'full-access'}));
  const first = await send('first-live','Launch exactly one native Agent, model haiku, run_in_background false. Its task: call mcp__gate__wait once, wait for the result, reply CHILD_DONE, do nothing else. Wait normally for the Agent call. After it returns reply PARENT_DONE and finish. If another user message arrives follow it without stopping the child or launching more.');
  await until(()=>entered); log('child-gated');
  if (process.env.REMUX_COMPACT_ACTIVE !== '1') {
  await send('followup-live','Reply INPUT_ACK now and finish this response. Leave the existing child running. Do not call any tools.');
  await until(()=>database.prepare("SELECT 1 FROM delivery_attempts WHERE command_id='followup-live' AND state IN ('accepted','unknown')").get());
  log('followup-settled');
  assert.equal(journal.additionalTurnMessages(first.turnId).length,1);
  await until(()=>!journal.conversation(conversationId).activeTurnId);
  log('active-input-accepted-parent-idle');
  assert.ok(journal.executionsForConversation(conversationId).some(e=>e.ownership==='native'&&e.state==='running'));
  }
  await coordinator.compactConversation({commandId:'compact-live-input',conversationId});
  await until(()=>journal.latestCompactionOperation(conversationId)?.state==='completed');
  log('compacted-child-pending');
  assert.ok(journal.executionsForConversation(conversationId).some(e=>e.ownership==='native'&&e.state==='running'));
  await send('after-compact-live','Reply SECOND_ACK and finish. Leave the child running. Do not use tools.');
  await until(()=>!journal.conversation(conversationId).activeTurnId && journal.turns(conversationId).length>=2);
  assert.ok(journal.executionsForConversation(conversationId).some(e=>e.ownership==='native'&&e.state==='running'));
  log('compacted-and-conversed-child-pending');
  release();
  await until(()=>journal.executionsForConversation(conversationId).some(e=>e.ownership==='native'&&e.outcome==='completed'));
  log('child-completed');
} catch (e) {if(conversationId)log('failed');console.error(String(e));process.exitCode=1;}
finally {clearTimeout(deadline);release();await coordinator.close();journal.close();}
