const test=require('node:test'),assert=require('node:assert/strict');
const {buildManagedAgentTools}=require('../src/services/managedAgentTools');
const {validateAgentBody}=require('../src/services/managedAgentValidator');
for(const version of ['agent_pty_skills_v1','agent_pty_v1']) test(version+' keeps PTY calls Build-only and authority-free',()=>{
 const request={protocolVersion:1,modelKey:'mdl_fixture',agentMode:'build',clientRunId:'fixture',providerRequestIndex:0,toolCapabilityVersion:version,
 ...(version==='agent_pty_v1'?{accountingPeriod:'2026-10'}:{}),canonicalTurns:[{role:'user',content:'Start an owned shell'},
 {role:'assistantToolCalls',text:'',toolCalls:[{providerCallId:'call',toolName:'start_terminal_session',args:{executable:'cmd.exe',args:['/d','/q'],cwd:'.',cols:80,rows:24,foreground:false}}]},
 {role:'toolResult',providerCallId:'call',toolName:'start_terminal_session',content:'owned',isError:false}]};
 assert.equal(validateAgentBody(request).toolCapabilityVersion,version);
 for(const mode of ['ask','plan']) {
  assert.equal(buildManagedAgentTools(version,mode).some(t=>t.function.name==='start_terminal_session'),false);
  assert.throws(()=>validateAgentBody({...request,agentMode:mode}),e=>e.code==='INVALID_REQUEST');
 }
 for(const args of [{pid:123},{accountType:'individual'},{approved:true},{cols:1},{args:['bad\0argument']}]) {
  const wrong=structuredClone(request);Object.assign(wrong.canonicalTurns[1].toolCalls[0].args,args);
  assert.throws(()=>validateAgentBody(wrong),e=>e.code==='INVALID_REQUEST');
 }
 const base=version==='agent_pty_v1'?'agent_mcp_v1':'agent_mcp_skills_v1';
 assert.throws(()=>validateAgentBody({...request,toolCapabilityVersion:base}),e=>e.code==='INVALID_REQUEST');
});
