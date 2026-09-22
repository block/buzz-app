// Static Phosphor assets for widgets that accept SVG strings rather than React.
import clock from "@phosphor-icons/core/assets/regular/clock.svg?raw";
import smiley from "@phosphor-icons/core/assets/regular/smiley.svg?raw";
import paw_print from "@phosphor-icons/core/assets/regular/paw-print.svg?raw";
import orange from "@phosphor-icons/core/assets/regular/orange.svg?raw";
import barbell from "@phosphor-icons/core/assets/regular/barbell.svg?raw";
import car from "@phosphor-icons/core/assets/regular/car.svg?raw";
import lightbulb from "@phosphor-icons/core/assets/regular/lightbulb.svg?raw";
import shapes from "@phosphor-icons/core/assets/regular/shapes.svg?raw";
import flag from "@phosphor-icons/core/assets/regular/flag.svg?raw";
import asterisk from "@phosphor-icons/core/assets/regular/asterisk.svg?raw";
import x_circle from "@phosphor-icons/core/assets/regular/x-circle.svg?raw";

export const pickerIcons = {
  clock: clock,
  smiley: smiley,
  "paw-print": paw_print,
  orange: orange,
  barbell: barbell,
  car: car,
  lightbulb: lightbulb,
  shapes: shapes,
  flag: flag,
  asterisk: asterisk,
  "x-circle": x_circle,
};

// Neutral ink remains visible when an SVG is used as an image in either shell theme.
import cpu from "@phosphor-icons/core/assets/regular/cpu.svg?raw";
export const computeLauncherIcon = `data:image/svg+xml,${encodeURIComponent(cpu.replace('fill="currentColor"', 'fill="gray"'))}`;
