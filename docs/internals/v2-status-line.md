# The room's status line without a warning sign (Claude Code 2.1.330)

The owner saw the room's line drawn as `⚠ sub-human: heron-2988 · alice here · 2 updates`. Neither the `⚠` nor the
`sub-human:` is sub-human's text.

## Where they come from

`$.ui.status(text)` takes only the text (`status: (text: string | undefined) => void`, no options). The session
runs:

```js
status:(T,L)=>{let V=this.requireHost(),z=`plugin-status-${T}`;if(V.removeNotification(z),L!==void 0)
  V.addNotification({key:z,kind:"event",text:oFt(T,L),priority:"low",pinned:!0})}
```

`oFt(plugin, text)` is `` `${name}: ${text}` ``: the `sub-human:`. A pinned notification is drawn by `XCe`, which for
every variant (`jsx`, `segments`, plain `text`) draws `[ZT, " ", …]` in `color: T.color ?? "warning"`, and `ZT` is
`"⚠"`. `status` sets no `color`, so every plugin's status line, in every state, is a yellow `⚠ NAME: text`. No
option or tone changes it.

## The surface used instead: the prompt's hint line

`ui.render` of `PromptHint` (typed: "the dim hint line under the prompt (`? for shortcuts`, `esc to interrupt`, the
pills beside them). One instance.") takes a `tail`: "The terminal keeps the engine's line (its pills stay live) and
draws `tail` dim at its end, cut where the row ends and left out where under four columns of it would show; no other
surface draws it yet." It adds no row, takes no focus, and redraws only on `$.ui.invalidate("ui.render")`, which the
module calls only when the line's text changes.

`module/status.ts` hooks it (`{ component: 'PromptHint', plugin: '*' }`: the line is the engine's, no plugin's). The
first time a terminal draws the hint, the module clears its `$.ui.status` and draws the room's line there from then
on: `? for shortcuts · heron-2988  ● bob  ○ carol`. Where no terminal draws the hint (the desktop app, a remote
surface), `$.ui.status` still carries it, `⚠` and all.

Limits: the tail is cut where the row ends, and dropped on a very narrow terminal. The line is fitted to what is left
of the row (`viewport.columns` less the hint and any tail before it): the code and the one most urgent item stay whole,
and names fold into `+N` first.

## Feature request (not yet filed)

Let a plugin choose how its status line looks: `$.ui.status(text, { glyph?: string | null, color?: 'dim' | … })`, or
a neutral default for `plugin-status-*` notifications. The `⚠` and warning colour say "something is wrong", which a
plugin's ordinary status ("who is here") isn't, and the plugin name before it repeats what the line already says. The
hint line's `tail` works on the terminal only and is cut by the width of that row.
