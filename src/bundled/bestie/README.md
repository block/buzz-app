# Bestie

Your personal companion in Buzz. Bestie runs as a hosted agent on Builderlab
and chats with you on the Bestie page, in a private channel only the two of you
belong to.

## Getting started

Open **Bestie** and choose **Set up Bestie**. Setup signs you in to Builderlab,
creates your hosted Bestie, gives it its instructions, creates your private
channel and sends a first message on your behalf so Bestie introduces itself.

### The Bestie tab

The agent you made your Bestie (with **Make my bestie** in Agents) gets a
**Bestie** tab on its agent page while it runs on this device. **Change** picks
another agent and asks before replacing your Bestie. Only agents on this device
can be your Bestie for now, in Change, in **Make my bestie** and in **Make my
Bestie again**: a remote one isn't set up for it yet. **Remove as Bestie** asks,
then saves no Bestie to your account: the agent stays, its check-ins stop, and
its memory section and private channels stay, which its Former Bestie tab can
turn off.

**Remembers you** adds memory rules to the agent's instructions, in a section
marked `<!-- buzz:bestie/memory v1 -->` … `<!-- /buzz:bestie/memory -->`, and
turning it off removes that section. The switch is on while the section is
there, whatever you edit inside it or type next to its markers. Off removes
it with your edits inside it, and keeps text you put before its opening
marker or after its closing one. If you edit, remove or copy one of its
markers, the row says the section was edited instead of showing a switch, so
it never adds a second one. **Restore** puts back the original section in
place of its two markers and what lies between them, when they still show
where it starts and ends; otherwise fix its markers in Instructions. Off
deletes no memory, and the agent's core memory is still in every prompt;
clear memory in the Memory tab.

**Private channels Bestie can read** lists the private channels you share with
Bestie, each with **Remove**. **Add to a channel** (**Choose…**) and **Add to
all my private channels** add it to the private channels you are in, most
recently active first; each channel's members see that you added it. Each
action has a row of its own, so in a narrow panel its button wraps under it.
Public channels need nothing: agents read them already. Adding Bestie to new
channels you create is not set up yet.

**Check-ins → Every hour** needs Remembers you, and turning memory off turns it
off too. On adds the `buzz:bestie/checkin.hourly` Hourly upkeep section to the
instructions and an hourly Attention timer, `watch/bestie-hourly-check-in`,
that wakes Bestie in your DM with it; it also turns on the agent's Attention,
which the Watching tab shows. Off removes the section and the timer and leaves
Attention on, since the agent's other watches may need it. The timer runs while
Buzz is open and the Watching plugin is on: this plugin doesn't call
`controlAttention()`, so turning Watching off still turns Attention off for
every agent. While the timer can't run, the row says it is paused. After a
sleep it runs once, not once for each missed hour. Each
check-in is a feature in `features.ts`, so another kind is one more entry.

**Changing your Bestie.** Only your Bestie checks in: whenever the saved Bestie
is known, on this device or synced from another, any other agent here has its
check-ins removed. Once your account is read to have no Bestie, saved as none
or never saved, every agent here has them removed; while it is being read, or
can't be, nothing is. Its memory section and channels stay. An agent this
device makes Bestie starts with Remembers you on; a choice synced from
elsewhere changes nothing, so memory turned off stays off. A former Bestie
keeps a **Former Bestie** tab while it has a Bestie section, or, if this device
saw it as Bestie, while it is in one of your private channels. The tab has the
same switches, **Remove from all** for its channels, and **Make my Bestie
again**.

---

## Changing Bestie's instructions

Bestie's instructions live in `prompt.ts`. When they differ from the ones a
set-up Bestie has, the Bestie page offers **Update Bestie's instructions**.
**Bestie's instructions** on that page shows the current text.
