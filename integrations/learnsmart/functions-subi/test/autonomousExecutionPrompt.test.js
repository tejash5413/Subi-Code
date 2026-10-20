const test=require('node:test'),assert=require('node:assert/strict');
const validator=require('../src/services/managedAgentValidator');
const {autonomousExecutionGuidance}=require('../src/services/autonomousExecutionGuidance');
for(const version of ['agent_v2','agent_v3','agent_skills_v1','agent_jobs_v1','agent_mcp_v1','agent_jobs_coordination_v1']){
  test(`${version}: managed normal Build requests teach automatic settings without granting approval`,()=>{
    const prompt=validator.agentSystemPrompt('build',version);
    assert.match(prompt,/Do not ask the user to choose tool names, shell, cwd or timeout/i);
    assert.match(prompt,/120000/);assert.match(prompt,/600000/);assert.match(prompt,/before the first launch/i);
    assert.match(prompt,/Ask Approval/);assert.match(prompt,/Session.*Full Access/);
    assert.match(prompt,/never.*change.*permission.*profile/i);
  });
}
test('managed readonly modes and frozen old capability prompts preserve their boundaries',()=>{
  for(const mode of ['ask','plan'])assert.doesNotMatch(validator.agentSystemPrompt(mode,'agent_v3'),/AUTONOMOUS EXECUTION/);
  for(const version of ['file_v2','terminal_v1','verify_v1'])assert.doesNotMatch(validator.agentSystemPrompt('build',version),/AUTONOMOUS EXECUTION/);
});
test('restricted managed execution guidance never expands the admitted tool set',()=>{
  assert.doesNotMatch(autonomousExecutionGuidance('build',['read_file','apply_patch']),/120000|600000|run_command|terminal_status/);
  assert.doesNotMatch(autonomousExecutionGuidance('build',['run_command']),/background|terminal_status/);
  assert.doesNotMatch(autonomousExecutionGuidance('build',['run_shell_command']),/Use run_command|background execution/);
});
