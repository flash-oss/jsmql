export const JSMQL_NS = "__jsmql";

export function bindingSlot(name: string): string {
  return `${JSMQL_NS}.var.${name}`;
}

export function tmpSlot(n: number): string {
  return `${JSMQL_NS}.tmp.${n}`;
}

export const SIZE_SLOT = `${JSMQL_NS}.size`;

export const GROUP_TMP = `${JSMQL_NS}Tmp`;

function sanitizeVarSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function letFieldVar(field: string, depth: number): string {
  return `${JSMQL_NS_VAR}f${depth}_${sanitizeVarSegment(field)}`;
}

export function letBindingVar(name: string, depth: number): string {
  return `${JSMQL_NS_VAR}v${depth}_${sanitizeVarSegment(name)}`;
}

export function letSysVar(name: string, depth: number): string {
  return `${JSMQL_NS_VAR}s${depth}_${sanitizeVarSegment(name)}`;
}

const JSMQL_NS_VAR = "jsmql_";

export function exprVar(base: string): string {
  return `jsmql${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}
