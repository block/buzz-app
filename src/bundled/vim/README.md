# Vim keys

Move around Buzz and act on what you select with Vim-style keys, and edit
messages with Vim's normal, insert and visual modes. Apart from Escape, keys
never fire while you type in a field or a terminal.

## Getting started

1. Turn on **Vim keys** in **Settings → Plugins**.
2. There is one cursor: wherever focus is. In a conversation it starts on the
   newest message. Press `j` and `k` to move it, or click a message. The view
   follows it.
3. Press `go` to open the selected item's actions. Each action shows its key;
   press it to run the action.
4. Press Space to see the leader keys, such as `Space /` to search where you
   are and `Space Space` to switch conversation.
5. Press `Space i` to type a message. Escape stops typing and puts the message
   box in normal mode, with a block cursor, where Vim's keys edit it; a second
   Escape leaves it.

---

## Moving

The same keys move the focus everywhere: messages, the sidebar, menus,
Settings and other dialogs. The focus ring shows what is selected, and the
view follows it.

| Keys | Action |
| --- | --- |
| `j` / `k` | Down / up: the next message, row, menu item or control |
| `h` / `l` | Left / right: in lists and tabs, or to the next control on the same line |
| `gg` / `G` | The first / last item; the oldest loaded / newest message |
| `Ctrl-d` / `Ctrl-u` | Half a page down / up, centred |
| `Ctrl-h` / `Ctrl-l` | Pane to the left / right, also in Settings and other dialogs |
| `Ctrl-j` / `Ctrl-k` | Message box / messages |
| `H` / `L` | Back / forward |

Panes are the windows you move between, and `hjkl` moves within one. In the
main window they are the sidebar, the conversation and the side panel. In
Settings they are the section list, the section and a plugin's details, and
any dialog with a list or details beside its content works the same way.
`Ctrl-h` and `Ctrl-l` return to where you were in a pane. You never need Tab.

Where a list, menu or tab bar has arrow keys of its own, `j` and `k` are those
arrows. Elsewhere, such as the sidebar and Settings, `j` and `k` go to the
next line in the same column, as in Vim, so they go down a column of cards or
past a heading's buttons; `h` and `l` move along the line. They pass over
choice menus and radio buttons without opening or changing them; `h` and `l`
change a radio button, as the arrow keys do. When the next control is more
than a line out of view, `j` and `k` scroll a line instead, so text between
controls stays readable.

`j` and `k` stop on text fields too. A field they stop on is selected, with a
focus ring and no caret: keys still move, and nothing types. Press `i` or
Enter to edit it, and Escape to select it again; a second Escape does what
Escape does there, such as closing Settings.

## Messages

| Keys | Action |
| --- | --- |
| `Enter` | Enter the selected message's thread, at its newest message, if it has one |
| `l` | Reply in a thread |
| `go` | The selected message's actions |
| `Tab` / `Shift-Tab` | Switch between the message and its author, links, files and reactions |
| `Space i` | Type a message |
| `Escape` (`Ctrl-[` on Mac) | Back to the selected message; on the message, mark the conversation read, or close an inline thread |

The cursor is always where focus is, so only one message is ever marked, and
only in the window you are using. While you type after `Space i`, or use the
sidebar, a menu or a dialog, no message is marked; Escape brings the cursor
back to the message you left. Each conversation and each thread remembers its
own message. Opening a conversation or a thread, with Enter or a click on its
replies, puts the cursor on its newest message, not the message box; Reply
(`t`), `Space i` or a click in the message box types. In a thread's message box, Escape returns to
the thread's message and keeps the thread open. Scrolling with a mouse or
trackpad moves the view but not the cursor; the next move brings the view
back. If the selected message is deleted, the next one is selected.

Tab and Shift-Tab never move into a part's card or menu: use `go` for a part's
actions and Escape to return to the message. In a message's `go` menu, `t`
replies, as on the message itself; closing the reaction picker returns to the
message.

Buzz's own message keys still act on the selected message: `e` edits, `r`
reacts, `t` replies in thread, `u` marks unread and Delete deletes your own
message.

## The message box

The message box has Vim's modes, and shows the one it is in beside Send.
Focusing it, with `Space i`, Reply, a click or any other way, starts in insert
mode, where every key does what it does without Vim keys: Enter sends, and
mentions, emoji and formatting work as usual. Tab types a tab, unless a
suggestion or a list item takes it. Escape is normal mode, with a
block cursor on a character, where no key types; Escape there leaves the
message box for the selected message.

| Keys | Action |
| --- | --- |
| `h` `l` `j` `k` | Left, right, down, up |
| `w` / `b` / `e` | Next word, previous word, end of word; `W` `B` `E` for words with punctuation |
| `0` / `^` / `$` | Start, first character, end of the line |
| `gg` / `G` | First / last line, or line `N` with a count |
| `i` / `a` | Insert before / after the cursor |
| `I` / `A` | Insert at the start / end of the line |
| `o` / `O` | Insert on a new line below / above |
| `d` / `c` / `y` and a motion or text object | Delete / change / copy to where the motion goes: `dw`, `c$`, `yiw` |
| `dd` / `cc` / `yy` | Delete / change / copy lines |
| `x` `X` `D` `C` `s` `S` `Y` | `dl` `dh` `d$` `c$` `cl` `cc` `yy` |
| `p` / `P` | Put what was deleted or copied after / before the cursor |
| `J` | Join the line below to this one |
| `u` / `Ctrl-r` | Undo / redo |
| `v` / `V` | Select characters / lines |

Text objects follow `d`, `c` or `y`, or select in visual mode: `iw` is the
word under the cursor and `aw` adds the space after it; `iW` and `aW` take
punctuation too. `i"` and `a"` are inside and around quotes, also with `'`
and `` ` ``. `i(` and `a(` are inside and around brackets, also with `[`,
`{` and `<`; `ib` and `iB` are `i(` and `i{`.

When the message is taller than the box, the view follows the cursor and
keeps three lines around it, as Vim's `scrolloff`.

A count repeats a motion or edit, before the operator or after it: `5l`,
`3dw`, `d2w`, `3dd`. `u` undoes one command, and an insert from `i`, `o` or
`c` until Escape is one command. In a selection, motions extend it, a text
object selects itself, `d` or `x` deletes it, `c` changes it, `y` copies it
and Escape returns to normal mode. When whole lines are selected, `J` and `K`
move them down and up and keep them selected. Arrow keys, Backspace and
Delete work as `hjkl`, `h` and `x`, and Space starts the leader keys.

Deleted and copied text goes to one register of plain text, separate from
the clipboard. Putting it, or moving lines past a mention or formatting with
`J` and `K`, puts plain text back. A mention or other chip moves and deletes as
a whole.

## Conversations and the sidebar

| Keys | Action |
| --- | --- |
| `]b` / `[b` | Next / previous conversation |
| `]u` / `[u` | Next / previous unread conversation |
| `\` | Show the open conversation in the sidebar |
| `go` | Actions for the focused conversation |

In the sidebar, `j` and `k` reach Activity, section headings and
conversations. Enter opens a conversation or collapses a section, and Escape
returns to the selected message.

## Menus and choices

Every menu shows a key beside each item; press it to run the item. `j`, `k`,
`h`, `l` and `g` are never an item's key: `j` and `k` move, `h` and `l` close
or open a submenu, and `gg` / `G` reach the first and last item. Escape closes
the menu.

A choice, such as "When" in Remind me, is a stop like any other control. Press
Enter to open its list, `j`, `k`, `gg` and `G` to move through it, and Enter
to pick. Escape closes the list without changing the choice, and `j` and `k`
carry on through the rest of the dialog.

## Leader keys

| Keys | Action |
| --- | --- |
| `Space /` | Search where you are: the sidebar's conversations, or this conversation |
| `Space Space` | Switch conversation |
| `Space ,` | Settings |
| `Space h` | Home |
| `Space i` | Type a message |
| `Space n n` / `c` / `d` / `w` | New chat, channel, DM or workspace, from Buzz's New menu |

After a short pause in a sequence, a menu shows the keys that can follow;
Escape cancels. Space on a focused button starts the leader instead of
pressing it; press Enter to press the button. Checkboxes, switches and options
keep Space.

## Changing keys

On Windows and Linux, `Alt` replaces `Ctrl` for the pane keys, since Buzz uses
`Ctrl` with `h`, `j`, `k` and `l`, and `Ctrl-d` / `Ctrl-u` stay as they are.

The first key of each sequence (`g`, `]`, `[`, Space) and every single key is
listed in **Settings → Shortcuts**, where you can change it. When another
shortcut uses the same key, Settings → Shortcuts marks it "Also used by";
change one to choose. Tab and Escape on a message are not listed there.

Escape in a field always returns to the selected message first, after the
field's own use of Escape, such as closing a suggestion list. An open tooltip
takes the first Escape.

The message holding the cursor has focus, so it shows Buzz's usual focus
ring.
