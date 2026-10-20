const definitions = require('./managedPtyTools.contract.json');
function invalid() { throw Object.assign(new Error('Invalid interactive terminal arguments'), {code:'INVALID_REQUEST'}); }
function check(schema, value) {
  switch(schema.type) {
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(schema.properties,key)) || schema.required.some(key=>!Object.hasOwn(value,key))) invalid();
      for (const [key, child] of Object.entries(value)) check(schema.properties[key], child);
      break;
    case 'array': if (!Array.isArray(value) || value.length > schema.maxItems) invalid(); for (const child of value) check(schema.items,child); break;
    case 'integer': if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) invalid(); break;
    case 'boolean': if (typeof value !== 'boolean') invalid(); break;
    case 'string': if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > schema.maxLength || value.includes('\0')) invalid(); break;
    default: invalid();
  }
}
exports.validatePtyArguments = function(name,args,maxChars) {
  const definition = definitions.find(tool=>tool.function.name === name); if(!definition) invalid();
  check(definition.function.parameters,args);
  if (name === 'write_terminal_input' && Buffer.byteLength(args.text,'utf8') > 8192) invalid();
  if (JSON.stringify(args).length > maxChars) throw Object.assign(new Error('Interactive terminal arguments exceed budget'), {code:'REQUEST_TOO_LARGE'});
  return structuredClone(args);
};
