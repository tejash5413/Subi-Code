import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMode, asAgentMode, DEFAULT_AGENT_MODE, describeAgentMode, isAgentMode } from '../AgentMode';

void test('isAgentMode accepts only the three values', () => {
  assert.equal(isAgentMode('ask'), true);
  assert.equal(isAgentMode('plan'), true);
  assert.equal(isAgentMode('build'), true);
  assert.equal(isAgentMode('ASK'), false);
  assert.equal(isAgentMode('plan '), false);
  assert.equal(isAgentMode(null), false);
  assert.equal(isAgentMode(undefined), false);
  assert.equal(isAgentMode(0), false);
  assert.equal(isAgentMode({}), false);
});

void test('asAgentMode returns the value or undefined', () => {
  assert.equal(asAgentMode('ask'), 'ask');
  assert.equal(asAgentMode('plan'), 'plan');
  assert.equal(asAgentMode('build'), 'build');
  assert.equal(asAgentMode('PLAN'), undefined);
  assert.equal(asAgentMode(null), undefined);
});

void test('DEFAULT_AGENT_MODE is ask', () => {
  assert.equal<AgentMode>(DEFAULT_AGENT_MODE, 'ask');
});

void test('describeAgentMode returns availability and notes', () => {
  assert.equal(describeAgentMode('ask').available, true);
  assert.equal(describeAgentMode('plan').available, true);
  assert.equal(describeAgentMode('build').available, false);
  assert.match(describeAgentMode('build').note, /safe write|patch/);
});
