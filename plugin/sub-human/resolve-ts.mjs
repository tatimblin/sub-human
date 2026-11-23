// Plugin code imports its own files as `./x.js` (TypeScript's nodenext convention): `claude plugin validate` refuses a
// `.ts` import path in module code, and the module runtime loads either. Node needs this hook to find `x.ts` for such
// a path. Every node process that loads plugin code starts with `node --import <plugin>/resolve-ts.mjs`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (e) {
      const missing = e instanceof Error && 'code' in e && e.code === 'ERR_MODULE_NOT_FOUND'
      if (!missing || !/^\.\.?\/.*\.js$/.test(specifier)) throw e
      return next(`${specifier.slice(0, -3)}.ts`, context)
    }
  },
})
