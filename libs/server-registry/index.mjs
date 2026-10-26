import { readFileSync } from 'node:fs';

export const instanceSchema = JSON.parse(readFileSync(new URL('./instance.schema.json', import.meta.url), 'utf8'));

// Small evaluator for the keywords used by this schema, not a general JSON Schema engine.
function check(value, schema, path = '$') {
  if (schema.$ref) return check(value, instanceSchema.$defs[schema.$ref.split('/').at(-1)], path);
  const fail = () => { throw new Error(`Invalid registry field: ${path}`); };
  if ('const' in schema && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
      type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
      type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) fail();
  }
  if (typeof value === 'string' && ((schema.pattern && !new RegExp(schema.pattern).test(value)) ||
    value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) fail();
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) ||
    (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum))) fail();
  if (Array.isArray(value)) {
    if (value.length > (schema.maxItems ?? Infinity) || (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length)) fail();
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) fail();
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) { if (schema.additionalProperties === false) fail(); }
      else check(value[key], schema.properties[key], `${path}.${key}`);
    }
  }
}

export function validateRegistry(instances) {
  if (!Array.isArray(instances)) throw new Error('Registry must be an array');
  const ids = new Set(), names = new Set(), ports = new Set();
  for (const instance of instances) {
    check(instance, instanceSchema);
    const networks = instance.container.allowedNetworks;
    if (networks && (networks.length === 0 || networks.some(name =>
      ['bridge', 'host', 'none', 'default', 'control', 'proxy', 'monitoring', 'atlas-control', 'atlas-proxy', 'atlas-monitoring'].includes(name)))) {
      throw new Error('Invalid registry network approval');
    }
    if (instance.container.requiredLabels['io.atlasdominion.instance'] !== instance.id) throw new Error('Instance label mismatch');
    if (ids.has(instance.id) || names.has(instance.container.name)) throw new Error('Duplicate instance or container ownership');
    ids.add(instance.id); names.add(instance.container.name);
    for (const port of instance.container.publishedPorts) {
      const key = `${port.protocol}:${port.hostPort}`;
      if (ports.has(key)) throw new Error('Conflicting published port');
      ports.add(key);
    }
  }
  return structuredClone(instances);
}

export function resolveInstance(instances, id) {
  const registry = validateRegistry(instances);
  const instance = registry.find(entry => entry.id === id);
  if (!instance) throw new Error('Unknown instance');
  return instance;
}
