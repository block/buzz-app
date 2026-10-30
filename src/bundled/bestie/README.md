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
another agent and asks before replacing your Bestie.

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
Bestie, each with **Remove**. **Add to a channel…** and **Add to all my
private channels** add it to the private channels you are in, most recently
active first; each channel's members see that you added it. Public channels
need nothing: agents read them already. Check-ins and adding Bestie to new
channels you create are not set up yet.

---

## Changing Bestie's instructions

Bestie's instructions live in `prompt.ts`. When they differ from the ones a
set-up Bestie has, the Bestie page offers **Update Bestie's instructions**.
**Bestie's instructions** on that page shows the current text.
