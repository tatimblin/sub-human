// sub-human's types contract (plugin.json "types"): the $.state values its hooks module keeps.
// Self-contained: no import or reference (claude plugin validate checks it).

/** This session's seat, as hooks/mod-hello.ts found it. */
export type SubHumanSeat = {
  name: string;
  code: string;
  role: 'member' | 'claude';
  /** NAME.CODE: the session title other Claudes reach it by. */
  addr: string;
};

/** What hooks/mod-hello.ts answered (mod/core/seat.ts parseHello). */
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
      /** False only when hooks/consent.ts said no room review is open and no EnterPlanMode / ExitPlanMode ran
       * since (mod/consent.ts); unset or true: consent runs. */
      reviewMaybeOpen: boolean;
      /** What the person's next prompt carries for Claude (pending-proposal reminders, missing row calls): the
       * tail child's last rows event (mod/deliver.ts); null: nothing. */
      rows: string | null;
      /** The rows text mod/prompt.ts last added to a typed prompt: it rides again only once it changes; null: none. */
      rowsInjected: string | null;
      /** The session id and address mod/prompt.ts last set as the title: titled again after a /clear or a switch. */
      titled: { sid: string; addr: string };
      /** How many times the room's delivery failed this session (mod/deliver.ts): an event not applied, a tail
       * child that exited or did not start, a wake nothing took. Unset: none. */
      deliveryErrors: number;
      /** This session's nonce (mod/deliver.ts, minted once per session id): mod-hello writes it to the lease and
       * mod/prompt.ts passes it with sub_human_origin, so at-room believes only an origin the module handed over. */
      nonce: { sid: string; value: string };
    };
  }
}
