// NOAA solar-coordinate equations; geometric elevation in degrees.
// https://gml.noaa.gov/grad/solcalc/calcdetails.html
const radians = Math.PI / 180;
export function solarElevation(
  date: Date,
  latitude: number,
  longitude: number,
) {
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
  const meanLongitude =
    (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const anomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(anomaly * radians) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * anomaly * radians) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * anomaly * radians) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude =
    meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega * radians);
  const obliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 +
    0.00256 * Math.cos(omega * radians);
  const declination = Math.asin(
    Math.sin(obliquity * radians) * Math.sin(apparentLongitude * radians),
  );
  const y = Math.tan((obliquity * radians) / 2) ** 2;
  const equation =
    (4 / radians) *
    (y * Math.sin(2 * meanLongitude * radians) -
      2 * eccentricity * Math.sin(anomaly * radians) +
      4 *
        eccentricity *
        y *
        Math.sin(anomaly * radians) *
        Math.cos(2 * meanLongitude * radians) -
      0.5 * y * y * Math.sin(4 * meanLongitude * radians) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * anomaly * radians));
  const minutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const hourAngle =
    (((((minutes + equation + 4 * longitude) % 1440) + 1440) % 1440) / 4 -
      180) *
    radians;
  return (
    Math.asin(
      Math.sin(latitude * radians) * Math.sin(declination) +
        Math.cos(latitude * radians) *
          Math.cos(declination) *
          Math.cos(hourAngle),
    ) / radians
  );
}
