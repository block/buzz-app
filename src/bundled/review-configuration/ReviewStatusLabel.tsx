export function ReviewStatusLabel({ label }: { label: string }) {
  const tone = [
    "Approved",
    "Looks good · not approved",
    "Completed · outcome unspecified",
    "Admitted",
  ].includes(label)
    ? "text-success"
    : ["Changes requested", "Rejected"].includes(label)
      ? "text-danger"
      : ["Needs review", "Waiting on author", "Awaiting triage"].includes(label)
        ? "text-warning"
        : "text-accent";
  return <strong className={tone}>{label}</strong>;
}

export function ReviewDate({
  value,
  missing,
}: {
  value: number | undefined;
  missing: string;
}) {
  if (!value) return <>{missing}</>;
  const date = new Date(value * 1000);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
    </time>
  );
}
