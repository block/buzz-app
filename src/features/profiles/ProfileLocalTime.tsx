import { useEffect, useState, type ReactNode } from "react";
import {
  clockHourCycle,
  useClockPreference,
} from "../../shared/clock-preference";
import { localTimeLabel, profileTimeZone } from "./local-time";

/** Someone's local time from their profile `tz`, refreshed on each minute;
 * renders nothing when they have not shared a usable zone. */
export function ProfileLocalTime({
  timeZone,
  className,
  clockOnly = false,
  city,
  inlineDetails = false,
  visual,
}: {
  timeZone: string | undefined;
  className: string;
  clockOnly?: boolean;
  city?: string | undefined;
  /** Full profile row: clock and relative offset, without a repeated zone. */
  inlineDetails?: boolean;
  visual?: (now: Date, zone: string) => ReactNode;
}) {
  const { localTimeDetails } = useClockPreference();
  const zone = profileTimeZone(timeZone);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!zone) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = new Date();
      setNow(current);
      clearTimeout(timer);
      timer = setTimeout(tick, 60_000 - (current.getTime() % 60_000));
    };
    // A timer can fire late after the machine sleeps; catch up on return.
    const visible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [zone]);
  const label = localTimeLabel(
    zone,
    now,
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
    {
      ...(clockOnly || inlineDetails ? { locale: "en-US" } : {}),
      hourCycle: clockOnly || inlineDetails ? "h12" : clockHourCycle(),
      difference: inlineDetails || (!clockOnly && localTimeDetails),
    },
  );
  if (!label) return null;
  if (inlineDetails) {
    return (
      <>
        {zone && visual?.(now, zone)}
        <span className={className}>{label.replace(" local time", "")}</span>
      </>
    );
  }
  if (clockOnly) {
    return (
      <>
        {zone && visual?.(now, zone)}
        <span className={className}>
          {city ? `${city} · ` : ""}
          {new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hour: "numeric",
            minute: "2-digit",
            hourCycle: "h12",
          }).format(now)}
        </span>
      </>
    );
  }
  return (
    <>
      <p className={className}>{label}</p>
      {localTimeDetails && (
        <p className={className}>{zone?.replaceAll("_", " ")}</p>
      )}
    </>
  );
}
