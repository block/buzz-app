import { useEffect, useState } from "react";
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
}: {
  timeZone: string | undefined;
  className: string;
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
      timer = setTimeout(tick, 60_000 - (current.getTime() % 60_000) || 60_000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [zone]);
  const label = localTimeLabel(
    zone,
    now,
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
    { hourCycle: clockHourCycle(), difference: localTimeDetails },
  );
  if (!label) return null;
  return (
    <>
      <p className={className}>{label}</p>
      {localTimeDetails && (
        <p className={className}>{zone?.replaceAll("_", " ")}</p>
      )}
    </>
  );
}
