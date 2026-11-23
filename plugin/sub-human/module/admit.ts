// The host's Let in / Refuse card (R30): from the session's first `/sub-human invite` (the session the host invites
// from is the one the joiner's card belongs in), the module asks the daemon every few seconds who waits to
// be let into this session's rooms (`asks`), shows each joiner once as a native question card naming them, their
// machine, a name that is not the invite's and the check string both people compare, and posts the answer (`admit`).
// A card dismissed is a Refuse. A line dialled twice is one dim line; one that had let someone in offers their kick.
import type { On } from 'claude-code'
import type { Ask } from '../core/api.js'
import { homeDir } from '../home.js'
import { answer, request } from './bridge.js'
import { COMMAND } from './session.js'

export const POLL_MS = 3000

/** The card for an ask: its question and two labels, Yes first; or, for an alert, only its line. */
export function card(a: Ask): { readonly question: string; readonly options: readonly [string, string] } | { readonly line: string } {
  if (a.kind === 'again') return { line: `sub-human: someone else also used the invite for ${a.expected}; nobody got in with it` }
  if (a.kind === 'leaked') return { question: `Someone else also used the invite ${a.name} joined ${a.code} with. Remove ${a.name}?`, options: [`Remove ${a.name}`, 'Keep'] }
  const who = a.name === a.expected ? a.name : `${a.name} (the invite was for ${a.expected})`
  const already = a.member ? ` ${a.name} is already a member there.` : ''
  return { question: `Let ${who} on ${a.machine || 'another machine'} into ${a.code}?${already} Check ${a.check} matches theirs.`, options: ['Let in', 'Refuse'] }
}

export function admitCards(on: On): void {
  let polling = false
  on('prompt.submit', { command: { name: COMMAND, args: /^\s*invite\b/ } }, async ($, e, next) => {
    if (polling) return next(e)
    polling = true
    const home = homeDir({ SUB_HUMAN_HOME: await $.env.get('SUB_HUMAN_HOME') }, (await $.env.get('HOME')) ?? '')
    const session = await $.session.id()
    let busy = false, said = ''
    // a failure is one line, said again only when it changes, so a poll every few seconds never repeats it
    const fail = (why: string): void => { if (why !== said) $.ui.log(`sub-human: no joiner can be let in: ${why}`); said = why }
    $.clock.every(POLL_MS, () => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          const ask = request({ op: 'asks', session }, home)
          const got = answer('asks', await $.http.fetch(ask.url, ask))
          if (!got.ok) { fail(got.error); return }
          said = ''
          for (const a of got.value.asks) {
            const c = card(a)
            if ('line' in c) { $.ui.log(c.line); continue }
            const chosen = await $.ui.ask(c.question, { options: c.options, header: 'Join' }).catch(() => c.options[1])
            const yes = chosen === c.options[0]
            if (a.kind === 'leaked' && !yes) continue
            const reply = request({ op: 'admit', session, code: a.code, id: a.id, answer: yes ? (a.kind === 'leaked' ? 'kick' : 'let_in') : 'refuse' }, home)
            const r = answer('admit', await $.http.fetch(reply.url, reply))
            if (!r.ok) $.ui.log(`sub-human: ${r.error}`)
          }
        } catch {
          fail('sub-human\'s daemon did not answer') // the next poll asks again
        } finally { busy = false }
      })()
    })
    return next(e)
  })
}
