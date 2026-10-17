/** Read / write nested config values by dotted path ("engine.maxPowerKw"). */

type Obj = Record<string, unknown>;

export function getPath(root: object, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

export function setPath(root: object, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = root as Obj;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] as Obj;
  cur[keys[keys.length - 1]] = value;
}

/**
 * Copies `source` into `target` keeping every nested object identity, so code
 * holding references to sub-objects (steering, gearbox, diffs) sees the change.
 * Arrays and primitives are replaced.
 */
export function assignDeep(target: object, source: object): void {
  const t = target as Obj;
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = t[key];
    if (isObj(value) && isObj(current)) assignDeep(current, value);
    else t[key] = Array.isArray(value) ? value.map((v) => (Array.isArray(v) ? [...v] : v)) : value;
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
