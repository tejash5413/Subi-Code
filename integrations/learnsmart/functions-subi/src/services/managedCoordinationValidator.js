// Pure validation of negotiated model input. Host task/owner authority stays local.
const contracts = require('./managedCoordinationTools.contract.json');
const SECRET_REQUEST = /(?:password|api[-_ ]?key|private[-_ ]?key|security code|\botp\b|\btoken\b|\bsecret\b|recovery (?:code|phrase)|seed phrase)/i;
function invalid() { throw Object.assign(new Error('Invalid coordination argument.'), { code: 'INVALID_REQUEST' }); }
function validate(value, rule) {
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    if (Object.keys(value).some(key => !Object.hasOwn(rule.properties, key)) || rule.required.some(key => !Object.hasOwn(value, key))) invalid();
    for (const [key, item] of Object.entries(value)) validate(item, rule.properties[key]);
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems || 0) || value.length > rule.maxItems) invalid();
    for (const item of value) validate(item, rule.items);
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || value.includes('\0') || value.length < (rule.minLength || 0) || value.length > (rule.maxLength ?? Infinity)
      || rule.minLength && !value.trim() || rule.enum && !rule.enum.includes(value) || rule.pattern && !(new RegExp(rule.pattern)).test(value)) invalid();
  } else if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) invalid();
  } else if (rule.type === 'boolean') { if (typeof value !== 'boolean') invalid(); }
  else invalid();
}
const relativePath = value => !/^([A-Za-z]:|[\\/])/.test(value) && value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..');
function proposal(value) {
  const nodes = new Map(value.nodes.map(node => [node.nodeId, node])); if (nodes.size !== value.nodes.length) invalid();
  for (const node of value.nodes) {
    if (new Set(node.dependsOn).size !== node.dependsOn.length || new Set(node.acceptanceRefs).size !== node.acceptanceRefs.length
      || node.required && !node.acceptanceRefs.length || node.dependsOn.some(id => id === node.nodeId || !nodes.has(id))) invalid();
    const { files, dirs, symbols } = node.scope;
    if (files.length + dirs.length + symbols.length > 100 || [...files, ...dirs].some(value => !relativePath(value))) invalid();
  }
  const visited = new Set(); const visiting = new Set();
  function visit(id) { if (visiting.has(id)) invalid(); if (visited.has(id)) return;
    visiting.add(id); for (const dependency of nodes.get(id).dependsOn) visit(dependency); visiting.delete(id); visited.add(id); }
  for (const id of nodes.keys()) visit(id);
}
function questions(value) {
  const ids = new Set();
  for (const item of value.questions) {
    if (SECRET_REQUEST.test(item.question) || item.id !== undefined && ids.has(item.id)) invalid(); if (item.id !== undefined) ids.add(item.id);
    const choices = new Set();
    for (const choice of item.options || []) {
      if (SECRET_REQUEST.test(choice.label) || choice.description !== undefined && SECRET_REQUEST.test(choice.description)
        || choice.id !== undefined && choices.has(choice.id)) invalid(); if (choice.id !== undefined) choices.add(choice.id);
    }
  }
}
function validateCoordinationArguments(name, args, maxChars = 100000) {
  const schema = contracts.find(tool => tool.function.name === name)?.function.parameters; if (!schema) invalid();
  validate(args, schema);
  if (name === 'coordination_submit') proposal(args);
  if (name === 'ask_user') questions(args);
  const json = JSON.stringify(args);
  if (json.length > maxChars) throw Object.assign(new Error('Coordination argument exceeds wire budget.'), { code: 'REQUEST_TOO_LARGE' });
  return JSON.parse(json);
}
module.exports = { validateCoordinationArguments };
