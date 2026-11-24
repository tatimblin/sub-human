// `node --import <this>`: appends every module the process loads to the file named by SH_TEST_TRACE, one URL a line,
// so a test can say what a hook loaded. Test only.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import type { ResolveFnOutput, ResolveHookContext } from 'node:module';

const out = process.env.SH_TEST_TRACE;
if (out !== undefined) {
  registerHooks({
    resolve(specifier: string, context: ResolveHookContext, next: (s: string, c?: Partial<ResolveHookContext>) => ResolveFnOutput): ResolveFnOutput {
      const r = next(specifier, context);
      fs.appendFileSync(out, `${r.url}\n`);
      return r;
    },
  });
}
