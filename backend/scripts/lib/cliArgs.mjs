/**
 * Strict command-line parsing for maintenance scripts.
 *
 * A maintenance tool must never guess what an operator meant. This parser REJECTS: unknown flags, positional
 * arguments, "--flag=value" forms, duplicated flags, missing values, blank values (an empty "--company ''"
 * must not silently widen the scope), and malformed identifiers. It reads only argv: no environment
 * variable and no configuration file can enable a flag.
 */

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * @param {string[]} argv
 * @param {{ booleans?: string[], values?: string[], usage: string }} spec flag names WITHOUT the leading dashes
 * @returns {Record<string, string|true>} camelCased options; absent flags are absent
 */
export function parseStrictArgs(argv, { booleans = [], values = [], usage }) {
  const options = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) throw new CliUsageError(`unexpected argument ${JSON.stringify(arg)}. ${usage}`);
    const name = arg.slice(2);
    const isBoolean = booleans.includes(name);
    if (!isBoolean && !values.includes(name)) throw new CliUsageError(`unknown argument ${arg}. ${usage}`);
    if (seen.has(name)) throw new CliUsageError(`${arg} was given more than once. ${usage}`);
    seen.add(name);
    if (isBoolean) {
      options[camel(name)] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CliUsageError(`${arg} needs a value. ${usage}`);
    if (value.trim() === '') throw new CliUsageError(`${arg} must not be blank. ${usage}`);
    options[camel(name)] = value;
    i += 1;
  }
  return options;
}

export const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** Throws unless value is a 24-hex ObjectId string (or absent, when optional). */
export function requireObjectId(value, flag, { optional = true } = {}) {
  if (value === undefined) {
    if (optional) return undefined;
    throw new CliUsageError(`${flag} is required`);
  }
  if (!OBJECT_ID.test(value)) throw new CliUsageError(`${flag} must be a 24-character hexadecimal id, got ${JSON.stringify(value)}`);
  return value.toLowerCase();
}
