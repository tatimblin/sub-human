// sub-human's types contract (plugin.json "types"): the $.state values its hooks module keeps.
// Self-contained: no import or reference (claude plugin validate checks it).

/** This session's seat, as hooks/mod-hello.js found it. */
export type SubHumanSeat = {
  name: string;
  code: string;
  role: 'member' | 'orch';
  /** NAME.CODE: the session title other Claudes reach it by. */
  addr: string;
};

/** What hooks/mod-hello.js answered (mod/core/seat.mjs parseHello). */
export type SubHumanHello = {
  sid: string | null;
  home: string;
  realHome: string;
  userHome: string | null;
  pluginRoot: string | null;
  seat: SubHumanSeat | null;
};

declare module 'claude-code' {
  interface PluginState {
    'sub-human': {
      hello: SubHumanHello;
      /** False only when hooks/consent.js said no room review is open and no EnterPlanMode / ExitPlanMode ran
       * since (mod/consent.mjs); unset or true: consent runs. */
      reviewMaybeOpen: boolean;
    };
  }
}
