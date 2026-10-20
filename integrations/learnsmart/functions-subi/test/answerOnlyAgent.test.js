const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentBody, agentSystemPrompt } = require('../src/services/managedAgentValidator');
const { streamManagedAgent } = require('../src/services/managedAgentService');

const body = extra => ({protocolVersion:1,modelKey:'mdl_test',agentMode:'plan',clientRunId:'repair',
  providerRequestIndex:0,canonicalTurns:[{role:'user',content:'Return the structured plan.'}],toolCapabilityVersion:'agent_mcp_skills_v1',...extra});
const response = chunks => new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n', {status:200});

test('answer-only is an exact optional restrictive boolean in the managed protocol',()=>{
  assert.equal(validateAgentBody(body({answerOnly:true})).answerOnly,true);
  assert.equal(validateAgentBody(body({})).answerOnly,undefined);
  for(const value of ['true',1,null,{}]) assert.throws(()=>validateAgentBody(body({answerOnly:value})),{code:'INVALID_REQUEST'});
});

test('answer-only server instructions do not advertise the normal PLAN tools',()=>{
  const prompt=agentSystemPrompt('plan','agent_mcp_skills_v1',undefined,undefined,true);
  assert.match(prompt,/no tools are available/i);
  assert.doesNotMatch(prompt,/inspect with list_directory|use mcp_list_tools/i);
  assert.match(prompt,/task-plan/);
});

test('answer-only managed repair sends no tool schemas and cannot return executable tool calls',async()=>{
  let payload;
  const run = chunks => streamManagedAgent({upstreamModelId:'test-model',agentMode:'plan',toolCapabilityVersion:'agent_mcp_skills_v1',
    answerOnly:true,openRouterMessages:[{role:'user',content:'Return structured plan only.'}],onEvent:async()=>{},
    keyResolver:async()=>Buffer.from('test-only'),fetchImpl:async(_url,init)=>{payload=JSON.parse(init.body);return response(chunks);}});
  await run([{choices:[{delta:{content:'Plan ready.'},finish_reason:'stop'}]}]);
  assert.equal(payload.tools,undefined);
  assert.equal(payload.tool_choice,undefined);
  await assert.rejects(run([{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'read_file',arguments:'{"path":"a.ts"}'}}]},finish_reason:'tool_calls'}]}]),{code:'AGENT_INVALID_TOOL_CALL'});
});

test('an explicit upstream SSE rate limit before output retains its safe category, without raw text',async()=>{
  await assert.rejects(streamManagedAgent({upstreamModelId:'test-model',openRouterMessages:[{role:'user',content:'hello'}],
    onEvent:async()=>{},keyResolver:async()=>Buffer.from('test-only'),fetchImpl:async()=>response([{error:{code:429,message:'private upstream body'}}])}),e=>{
    assert.equal(e.code,'PROVIDER_RATE_LIMITED');assert.equal(e.httpStatus,429);assert.equal(e.providerAccepted,true);
    assert.ok(!e.message.includes('private upstream body'));return true;
  });
});

test('a partial stream followed by rate limit remains an interrupted stream, not a safe automatic retry',async()=>{
  await assert.rejects(streamManagedAgent({upstreamModelId:'test-model',openRouterMessages:[{role:'user',content:'hello'}],
    onEvent:async()=>{},keyResolver:async()=>Buffer.from('test-only'),fetchImpl:async()=>response([{choices:[{delta:{content:'Partial'}}]},{error:{code:429}}])}),{code:'PROVIDER_UNAVAILABLE'});
});
