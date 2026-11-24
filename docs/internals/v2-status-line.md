# The room's status line (Claude Code 2.1.330)

The room's line is the tail of the terminal's dim hint under the prompt (`ui.render` on `PromptHint`, its `tail`):
`Room ◐ bob · plan "finish-webography" needs your review (+2)`. The owner chose it over `$.ui.status` (2026-11-23),
which draws every plugin's line as a warning (below). There is one surface: no `$.ui.status`, and nothing where no
terminal draws the hint.

## The tail

Claude Code puts ` · ` between its hint and a tail, so the tail starts with `Room`, not a separator; after another
plugin's tail it is joined with ` · `. The tail is one dim string, whitespace folded to one space, so the line is built
with single spaces. It is fitted to the hint's leftover width: `Room` and the one most urgent item with its `(+N)` stay
whole, and names fold into `+N` first. A change of the line asks for a redraw (`$.ui.invalidate('ui.render')`).

## Why not `$.ui.status`

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

## The first try of the tail

Tried live before, the tail read `⏵⏵ auto mode on (shift+tab to cycle) · PR #107 · · room: dingo-3829 ○ bob`: the
doubled `· ·` was ours, a tail that began with its own separator. The tail now begins with `Room`.

## Feature request (not yet filed)

Let a plugin choose how its status line looks: `$.ui.status(text, { glyph?: string | null, color?: 'dim' | … })`, or
a neutral default for `plugin-status-*` notifications. The `⚠` and warning colour say "something is wrong", which a
plugin's ordinary status ("who is here") isn't, and the plugin name before it repeats what the line already says.
