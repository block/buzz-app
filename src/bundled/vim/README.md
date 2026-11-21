# Vim keys

Move around Buzz and act on what you select with Vim-style keys. Keys never
fire while you type in a field or a terminal.

## Getting started

1. Turn on **Vim keys** in **Settings → Plugins**.
2. Press `j` and `k` to move between messages, list items and menu items.
   Each conversation keeps a cursor on one message, which starts on the
   newest one you can see. With nothing focused, `j`, `k`, `go` and Tab start
   from it.
3. Press `go` to open the selected item's actions. Each action shows its key;
   press it to run the action.
4. Press Space to see the leader keys, such as `Space /` to search where you
   are and `Space Space` to switch conversation.
5. Press `i` to type a message and Escape to stop typing.

---

## Keys

| Keys | Action |
| --- | --- |
| `j` / `k` | Next / previous message, sidebar conversation or item; scroll when nothing else moves |
| `h` / `l` | Left / right in lists; `l` on a message opens its thread |
| `gg` / `G` | Top / bottom |
| `Ctrl-d` / `Ctrl-u` | Half a page down / up, keeping the selected message near the middle |
| `go` | Actions for the selected message, person or conversation |
| `Tab` / `Shift-Tab` | Next / previous part of the selected message: its author, links, files and reactions |
| `]b` / `[b` | Next / previous conversation |
| `]u` / `[u` | Next / previous unread conversation |
| `H` / `L` | Back / forward |
| `\` | Show the open conversation in the sidebar |
| `i` | Type a message |
| `Escape` (`Ctrl-[` on Mac) | Leave the field or control; from a part of a message, back to the message |
| `Ctrl-h` / `Ctrl-l` | Pane to the left / right |
| `Ctrl-j` / `Ctrl-k` | Message box / messages |
| `Space /` | Search where you are: the sidebar's conversations, or this conversation |
| `Space Space` | Switch conversation |
| `Space s /` | Search Buzz |
| `Space s c` | Search this conversation |
| `Space s k` | Keyboard shortcuts |
| `Space t z` | Start or end Focus (needs the Focus plugin) |
| `Space ,` | Settings |
| `Space h` | Home |

On Windows and Linux, `Alt` replaces `Ctrl` for the pane keys, since Buzz uses
`Ctrl` with `h`, `j`, `k` and `l`, and `Ctrl-d` / `Ctrl-u` stay as they are.

The first key of each sequence (`g`, `]`, `[`, Space) and every single key is
listed in **Settings → Shortcuts**, where you can change it. After a short
pause in a sequence, a menu shows the keys that can follow; Escape cancels.
While Vim keys is on, every menu shows a key beside each item. `j`, `k`, `h`
and `l` keep moving in menus.

Space on a focused button starts the leader instead of pressing it; press
Enter to press the button. Checkboxes, switches and options keep Space. When
another shortcut uses the same key, such as Escape for marking a conversation
read, Settings → Shortcuts marks it "Also used by"; change one to choose.

The cursor stays marked while focus is elsewhere, such as the message box,
the sidebar or a menu. Clicking a message moves the cursor to it. Scrolling
keeps the cursor on a message you can see; if the selected message scrolls
away, the selection moves with it. The plugin marks the cursor's message box
with `data-message-cursor`, which Buzz paints like a selected message.

In a message with parts, Tab and Shift-Tab stay within it, wrapping back to
the message; press Escape, `j` or `k` to move on. In a message without parts,
Tab moves as usual.

Buzz's own message keys still act on the selected message: `e` edits, `r`
reacts, `t` replies in thread, `u` marks unread and Delete deletes your own
message.
