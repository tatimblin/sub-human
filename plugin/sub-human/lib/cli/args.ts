/**
 * plugin/sub-human/lib/cli/args.ts: the one flag parser of scripts/sub-human and lib/cli/*.ts. Zero dependencies.
 *
 *   parse(args, spec) -> {flags, rest, error?}
 *       spec: {name: 1}  --name VALUE (the next argument, whatever it is; none: error "--name needs a value")
 *             {name: 0}  --name, a switch (true)
 *             {name: '?'} --name [VALUE]: the next argument when there is one that is not a flag, else true
 *                        (`host --ssh [USER@HOST]`)
 *       A flag not in spec, and every other argument, goes to rest in order; `--` ends the flags (the rest is rest).
 *       error: the first problem, for the caller to print with its usage (flags and rest are as far as they got)
 */

function parse(args, spec) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }
    const k = typeof a === 'string' && a.startsWith('--') ? a.slice(2) : null;
    if (k === null || !Object.hasOwn(spec, k)) { rest.push(a); continue; }
    if (spec[k] === 0) flags[k] = true;
    else if (spec[k] === '?') flags[k] = args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--') ? args[++i] : true;
    else {
      if (args[i + 1] === undefined) return { flags, rest, error: `${a} needs a value` };
      flags[k] = args[++i];
    }
  }
  return { flags, rest };
}

export { parse };
