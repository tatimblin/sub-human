# The room's status line (Claude Code 2.1.330)

The room's line is its own row, drawn by `$.ui.status`:
`⚠ sub-human: heron-2988 ○ bob · plan "finish-webography" needs your review (+2)`. Neither the `⚠` nor the
`sub-human:` is sub-human's text.

## Where the prefix comes from

`$.ui.status(text)` takes only the text (`status: (text: string | undefined) => void`, no options). The session
runs:

```js
status:(T,L)=>{let V=this.requireHost(),z=`plugin-status-${T}`;if(V.removeNotification(z),L!==void 0)
  V.addNotification({key:z,kind:"event",text:oFt(T,L),priority:"low",pinned:!0})}
```

`oFt(plugin, text)` is `` `${name}: ${text}` ``: the `sub-human:`. A pinned notification is drawn by `XCe`, which for
every variant (`jsx`, `segments`, plain `text`) draws `[ZT, " ", …]` in `color: T.color ?? "warning"`, and `ZT` is
`"⚠"`. `status` sets no `color`, so every plugin's status line, in every state, is a yellow `⚠ NAME: text`. No
option or tone changes it. The owner accepts the prefix (2026-11-23).

## Why not the prompt's hint line

`ui.render` of `PromptHint` takes a `tail` that the terminal draws dim at the end of the engine's hint line. Tried
live, the tail shares that line with Claude Code's own hints and pills:
`⏵⏵ auto mode on (shift+tab to cycle) · PR #107 · · room: dingo-3829 ○ bob`, with a doubled `· ·`. It is also one dim
string (validated `tail: ["a string","missing"]`, drawn as one `Text` with `dimColor`, whitespace folded to one space),
so no part of it can stand out. The owner chose the line's own row instead; the module has no PromptHint hook.

The line is built with single spaces, since Claude Code folds runs of spaces on screen, and fitted to 80 columns
(`LINE_COLUMNS`): the code and the one most urgent item stay whole, and names fold into `+N` first.

## Feature request (not yet filed)

Let a plugin choose how its status line looks: `$.ui.status(text, { glyph?: string | null, color?: 'dim' | … })`, or
a neutral default for `plugin-status-*` notifications. The `⚠` and warning colour say "something is wrong", which a
plugin's ordinary status ("who is here") isn't, and the plugin name before it repeats what the line already says.
