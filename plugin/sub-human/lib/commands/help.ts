/**
 * plugin/sub-human/lib/commands/help.ts: `/sub-human help [anything]`, the full list of commands. Read only, and it runs
 * without the hooks module (a refusal points to it). Words after help are ignored: `/sub-human help join` is the list.
 */
import { say } from './answer.ts';
import type { OpenVerb } from './types.ts';

export const HELP: string = [
  'commands:',
  '  /sub-human                    in a room: who is here; else join the open room, or open one, as your git name',
  '  /sub-human NAME [ROOM]        join (or open) a room as NAME; ROOM (like vole-8126) only when more than one is open',
  '  /sub-human ROOM               join that room on this machine as your git name (also: /sub-human join ROOM)',
  '  /sub-human invite             a line for someone on another machine to join this room (over ssh to this machine)',
  '      --ssh USER@HOST [--via JUMP]   the address they reach this machine at (default: SUB_HUMAN_SSH_ADDR, else you@this-host)',
  '      --web | --public | --url URL   over the web: Tailscale Serve (your tailnet), Tailscale Funnel (public), or your own HTTPS front',
  '      --stop                         stop serving this room over the web',
  '      --cancel [ID]                  cancel an invite nobody used yet (ID: only when several are open; it lists them)',
  '  /sub-human join HOST ROOM SECRET [--as NAME] [--via JUMP] [--home PATH]   the line from an invite',
  '  /sub-human join URL SECRET [--as NAME]                    the same over the web',
  '  /sub-human join PIN           the PIN the host told you, once their machine asks; then the host lets you in',
  '  /sub-human join HOST ROOM [--as NAME] [--via JUMP] [--home PATH]   a room on a machine you can already ssh to: no invite',
  '  /sub-human admit [ID]         (host) who is waiting to join, and the ID that lets one in (the card does the same)',
  '  /sub-human kick NAME          (host) end the connection NAME joined over',
  '  /sub-human leave              leave the room (the session stays open)',
  '  /sub-human doctor             what is wrong on this machine, and how to fix it (read only)',
  '  /sub-human help               this list',
  '  @room TEXT    post your exact words to the room       @claude TEXT    the same, and wake the room\'s Claude',
].join('\n');

export const help: OpenVerb = () => say(HELP);
