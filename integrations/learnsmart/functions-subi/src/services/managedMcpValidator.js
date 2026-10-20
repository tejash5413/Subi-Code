// Fixed MCP envelope only. Endpoint, secret material and live server schemas stay in the host.
const definitions = require('./managedMcpTools.contract.json');
function invalid() { throw Object.assign(new Error('Invalid MCP arguments'), { code: 'INVALID_REQUEST' }); }
function check(schema, value, depth = 0) {
  if (depth > 10) invalid();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) invalid();
    for (const [key, child] of Object.entries(value)) check(schema.properties[key], child, depth + 1);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) invalid();
    for (const child of value) check(schema.items, child, depth + 1);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) invalid();
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > schema.maxLength) invalid();
  } else invalid();
}
function safeJson(value, depth = 0) {
  if (depth > 10) invalid();
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid();
      safeJson(child, depth + 1);
    }
  }
}
exports.validateMcpArguments = function (name, args) {
  const definition = definitions.find(tool => tool.function.name === name);
  if (!definition) invalid();
  check(definition.function.parameters, args);
  if (name === 'mcp_read_tool' || name === 'mcp_write_tool') {
    if (!/^mcp__[a-z0-9_]{1,59}$/.test(args.toolId)) invalid();
    let value; try { value = JSON.parse(args.argumentsJson); } catch { invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    safeJson(value);
  }
  return structuredClone(args);
};
