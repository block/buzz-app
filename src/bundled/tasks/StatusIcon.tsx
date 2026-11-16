import {
  CheckCircleIcon,
  CircleHalfIcon,
  CircleIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import type { TaskStatus } from "./model";

/** Each status has its own glyph; none borrows a warning or error meaning. */
export function StatusIcon({ status }: { status: TaskStatus }) {
  const props = { size: 16, "aria-hidden": true } as const;
  switch (status) {
    case "todo":
      return <CircleIcon {...props} />;
    case "in_progress":
      return <CircleHalfIcon {...props} />;
    case "done":
      return <CheckCircleIcon {...props} />;
    case "cancelled":
      return <XCircleIcon {...props} />;
  }
}
