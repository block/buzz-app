import { useId, useState, type ReactNode } from "react";
import { solarElevation } from "./solar-position";
import { GlobeIcon } from "../../shared/design-system/icons";
import { ProfileLocalTime } from "../../features/profiles/ProfileLocalTime";
import worldLand from "./world-land.json";
import styles from "./ProfileLocationPreview.module.css";

function mapLocation(location: string) {
  return location
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/^Remote\s*,\s*/i, "")
    .replace(/\s+Metro\b/gi, "")
    .replace(
      /\b(Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland and Labrador|Nova Scotia|Ontario|Prince Edward Island|Quebec|Saskatchewan|Northwest Territories|Nunavut|Yukon),\s*CA\s*$/i,
      "$1, Canada",
    )
    .trim();
}

export function ProfileLocationPreview({
  picture,
  coordinates,
  location,
  timeZone,
  fallback,
}: {
  coordinates?: Readonly<{ latitude: number; longitude: number }> | undefined;
  location: string | undefined;
  timeZone: string | undefined;
  fallback?: ReactNode;
  picture?: string | undefined;
}) {
  if (!location && !timeZone && !fallback) return null;
  return (
    <section className={styles.card} aria-label="Location and time">
      {!location && fallback && <div className={styles.card}>{fallback}</div>}
      {!timeZone && location && (
        <DaylightMap
          coordinates={coordinates}
          picture={picture}
          now={new Date()}
          location={location}
        />
      )}
      {timeZone && (
        <div className={styles.time}>
          <span className={styles.icon}>
            <GlobeIcon size={24} />
          </span>
          <span className={`${styles.label} ${styles.timeLabel} text-body`}>
            {location ? mapLocation(location) : "Local time"}
          </span>
          <ProfileLocalTime
            timeZone={timeZone}
            className={`${styles.value} ${styles.clock} text-body-sm`}
            visual={(now) => (
              <DaylightMap
                coordinates={coordinates}
                picture={picture}
                now={now}
                location={location}
              />
            )}
            inlineDetails
          />
        </div>
      )}
    </section>
  );
}

function DaylightMap({
  picture,
  coordinates,
  now,
  location,
}: {
  picture: string | undefined;
  coordinates: Readonly<{ latitude: number; longitude: number }> | undefined;
  now: Date;
  location: string | undefined;
}) {
  const landId = useId();
  const [failedPicture, setFailedPicture] = useState<string>();
  const showPhoto = Boolean(picture && failedPicture !== picture);
  const resolved = coordinates;
  if (!location) return null;
  const mapUrl = `https://maps.apple.com/?q=${encodeURIComponent(
    mapLocation(location),
  )}`;
  if (!resolved)
    return (
      <a
        className={`${styles.mapFallback} text-body-sm`}
        href={mapUrl}
        target="_blank"
        rel="noreferrer"
      >
        {location}
      </a>
    );
  const daytime =
    solarElevation(now, resolved.latitude, resolved.longitude) >= -0.833;
  const scale = 0.5;
  const centerLatitude = Math.max(-50, Math.min(50, resolved.latitude));
  const project = (longitude: number, latitude: number) => ({
    x: (((longitude - resolved.longitude + 540) % 360) - 180) * scale + 80,
    y: (centerLatitude - latitude) * scale + 48,
  });
  const marker = project(resolved.longitude, resolved.latitude);
  // At the horizon, sin(latitude) * north + cos(latitude) * equator = 0.
  const north = Math.sin((solarElevation(now, 90, 0) * Math.PI) / 180);
  const boundary = Array.from({ length: 161 }, (_, x) => {
    const longitude = resolved.longitude + (x - 80) / scale;
    const equator = Math.sin(
      (solarElevation(now, 0, longitude) * Math.PI) / 180,
    );
    const latitude = (Math.atan(-equator / (north || 1e-12)) * 180) / Math.PI;
    return { x, y: (centerLatitude - latitude) * scale + 48 };
  });
  const first = boundary[0];
  const last = boundary[boundary.length - 1];
  if (!first || !last) return null;
  const curve = `M${first.x},${first.y} ${boundary
    .slice(1)
    .map((point, index) => {
      const previous = boundary[index] ?? point;
      return `Q${previous.x},${previous.y} ${(previous.x + point.x) / 2},${(previous.y + point.y) / 2}`;
    })
    .join(" ")} Q${last.x},${last.y} ${last.x},${last.y}`;
  const edge = north >= 0 ? -180 : 260;
  const daylightPath = `${curve} L160,${edge} L0,${edge} Z`;
  const nightEdge = north >= 0 ? 260 : -180;
  const nightPath = `${curve} L160,${nightEdge} L0,${nightEdge} Z`;
  const land = [-360, 0, 360].map((offset) => (
    <g
      key={offset}
      transform={`translate(${80 + (offset - resolved.longitude) * scale} ${48 + centerLatitude * scale}) scale(${scale})`}
    >
      {worldLand.map((path) => (
        <path key={path} d={path} />
      ))}
    </g>
  ));
  return (
    <div className={styles.worldMap}>
      <svg
        viewBox="0 20 160 60"
        role="img"
        aria-label={`Map highlighting ${location}, ${daytime ? "daytime" : "nighttime"}`}
      >
        <defs>
          <clipPath id={landId}>{land}</clipPath>
        </defs>
        <g className={styles.nightLand}>{land}</g>
        <path
          d={daylightPath}
          className={styles.dayLand}
          clipPath={`url(#${landId})`}
        />
        <path d={nightPath} className={styles.nightShade} />
        <path d={curve} className={styles.daylightBoundary} />
        {!showPhoto && (
          <g className={daytime ? styles.dayMarker : styles.nightMarker}>
            <circle
              cx={marker.x}
              cy={marker.y}
              r="1.8"
              fill="currentColor"
              stroke="var(--surface-panel)"
              strokeWidth="0.8"
            />
          </g>
        )}
      </svg>
      <a
        className={`${styles.mapLink} ${showPhoto ? styles.photoPin : ""}`}
        style={{
          left: `${(marker.x / 160) * 100}%`,
          top: `${((marker.y - 20) / 60) * 100}%`,
        }}
        href={mapUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${location} in Apple Maps`}
      >
        {showPhoto && (
          <>
            <svg
              className={styles.pinShape}
              viewBox="0 0 56 64"
              aria-hidden="true"
            >
              <path d="M28 0 A28 28 0 0 1 40 53.3 Q36 55 30 62.5 Q28 65 26 62.5 Q20 55 16 53.3 A28 28 0 0 1 28 0Z" />
            </svg>
            <img
              src={picture}
              alt=""
              onError={() => setFailedPicture(picture)}
            />
          </>
        )}
        <span className="sr-only">{location}</span>
      </a>
    </div>
  );
}
