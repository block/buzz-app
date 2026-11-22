import type { TablerIcon } from "@tabler/icons-react";
import TablerMessages, {
  __iconNode as messages,
} from "@tabler/icons-react/dist/esm/icons/IconMessages.mjs";
import TablerHash, {
  __iconNode as hash,
} from "@tabler/icons-react/dist/esm/icons/IconHash.mjs";
import TablerUsers, {
  __iconNode as users,
} from "@tabler/icons-react/dist/esm/icons/IconUsers.mjs";
import TablerRocket, {
  __iconNode as rocket,
} from "@tabler/icons-react/dist/esm/icons/IconRocket.mjs";
import TablerBriefcase, {
  __iconNode as briefcase,
} from "@tabler/icons-react/dist/esm/icons/IconBriefcase.mjs";
import TablerCalendar, {
  __iconNode as calendar,
} from "@tabler/icons-react/dist/esm/icons/IconCalendar.mjs";
import TablerBulb, {
  __iconNode as bulb,
} from "@tabler/icons-react/dist/esm/icons/IconBulb.mjs";
import TablerCode, {
  __iconNode as code,
} from "@tabler/icons-react/dist/esm/icons/IconCode.mjs";
import TablerPalette, {
  __iconNode as palette,
} from "@tabler/icons-react/dist/esm/icons/IconPalette.mjs";
import TablerChartBar, {
  __iconNode as chart_bar,
} from "@tabler/icons-react/dist/esm/icons/IconChartBar.mjs";
import TablerTarget, {
  __iconNode as target,
} from "@tabler/icons-react/dist/esm/icons/IconTarget.mjs";
import TablerFlag, {
  __iconNode as flag,
} from "@tabler/icons-react/dist/esm/icons/IconFlag.mjs";
import TablerStar, {
  __iconNode as star,
} from "@tabler/icons-react/dist/esm/icons/IconStar.mjs";
import TablerHeart, {
  __iconNode as heart,
} from "@tabler/icons-react/dist/esm/icons/IconHeart.mjs";
import TablerSparkles, {
  __iconNode as sparkles,
} from "@tabler/icons-react/dist/esm/icons/IconSparkles.mjs";
import TablerBolt, {
  __iconNode as bolt,
} from "@tabler/icons-react/dist/esm/icons/IconBolt.mjs";
import TablerFlame, {
  __iconNode as flame,
} from "@tabler/icons-react/dist/esm/icons/IconFlame.mjs";
import TablerLeaf, {
  __iconNode as leaf,
} from "@tabler/icons-react/dist/esm/icons/IconLeaf.mjs";
import TablerWorld, {
  __iconNode as world,
} from "@tabler/icons-react/dist/esm/icons/IconWorld.mjs";
import TablerHome, {
  __iconNode as home,
} from "@tabler/icons-react/dist/esm/icons/IconHome.mjs";
import TablerBook, {
  __iconNode as book,
} from "@tabler/icons-react/dist/esm/icons/IconBook.mjs";
import TablerMusic, {
  __iconNode as music,
} from "@tabler/icons-react/dist/esm/icons/IconMusic.mjs";
import TablerCamera, {
  __iconNode as camera,
} from "@tabler/icons-react/dist/esm/icons/IconCamera.mjs";
import TablerCoffee, {
  __iconNode as coffee,
} from "@tabler/icons-react/dist/esm/icons/IconCoffee.mjs";
import TablerPuzzle, {
  __iconNode as puzzle,
} from "@tabler/icons-react/dist/esm/icons/IconPuzzle.mjs";
import TablerTool, {
  __iconNode as tool,
} from "@tabler/icons-react/dist/esm/icons/IconTool.mjs";

type IconNode = readonly (readonly [
  string,
  Readonly<Record<string, string>>,
])[];

/** Line icons a picture can be painted from, like an emoji. */
export const avatarIcons: readonly {
  id: string;
  label: string;
  node: IconNode;
  Icon: TablerIcon;
}[] = [
  {
    id: "messages",
    label: "Conversation",
    node: messages,
    Icon: TablerMessages,
  },
  { id: "hash", label: "Hash", node: hash, Icon: TablerHash },
  { id: "users", label: "People", node: users, Icon: TablerUsers },
  { id: "rocket", label: "Rocket", node: rocket, Icon: TablerRocket },
  { id: "briefcase", label: "Work", node: briefcase, Icon: TablerBriefcase },
  { id: "calendar", label: "Calendar", node: calendar, Icon: TablerCalendar },
  { id: "bulb", label: "Idea", node: bulb, Icon: TablerBulb },
  { id: "code", label: "Code", node: code, Icon: TablerCode },
  { id: "palette", label: "Design", node: palette, Icon: TablerPalette },
  { id: "chart-bar", label: "Chart", node: chart_bar, Icon: TablerChartBar },
  { id: "target", label: "Goal", node: target, Icon: TablerTarget },
  { id: "flag", label: "Flag", node: flag, Icon: TablerFlag },
  { id: "star", label: "Star", node: star, Icon: TablerStar },
  { id: "heart", label: "Heart", node: heart, Icon: TablerHeart },
  { id: "sparkles", label: "Sparkles", node: sparkles, Icon: TablerSparkles },
  { id: "bolt", label: "Bolt", node: bolt, Icon: TablerBolt },
  { id: "flame", label: "Flame", node: flame, Icon: TablerFlame },
  { id: "leaf", label: "Leaf", node: leaf, Icon: TablerLeaf },
  { id: "world", label: "World", node: world, Icon: TablerWorld },
  { id: "home", label: "Home", node: home, Icon: TablerHome },
  { id: "book", label: "Book", node: book, Icon: TablerBook },
  { id: "music", label: "Music", node: music, Icon: TablerMusic },
  { id: "camera", label: "Camera", node: camera, Icon: TablerCamera },
  { id: "coffee", label: "Coffee", node: coffee, Icon: TablerCoffee },
  { id: "puzzle", label: "Puzzle", node: puzzle, Icon: TablerPuzzle },
  { id: "tool", label: "Tool", node: tool, Icon: TablerTool },
];

/** An icon travels through the editor's glyph as `icon:<id>`; it is painted
 * into the uploaded image, so the saved picture is an ordinary image. */
export const avatarIconGlyph = (id: string) => `icon:${id}`;

export function avatarIcon(glyph: string) {
  if (!glyph.startsWith("icon:")) return undefined;
  const id = glyph.slice(5);
  return avatarIcons.find((icon) => icon.id === id);
}

/** The icon's outline on Tabler's 24-unit grid, for a canvas to stroke. */
export function avatarIconPaths(node: IconNode) {
  return node.flatMap(([tag, attributes]) =>
    tag === "path" && attributes.d ? [new Path2D(attributes.d)] : [],
  );
}
