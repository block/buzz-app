import { useEffect, useMemo, useRef, useState } from "react";
import {
  hexTerritoryBoundaryEdges,
  layoutCommunityComputeHexTerritories,
  type CommunityComputeHexCell,
} from "./communityComputeHexLayout";
import type { CommunityComputeMapModel } from "./communityComputeMapModel";
import styles from "./Compute.module.css";

/** Stable contiguous territories from PR #7691, with host styling and keyboard disclosure. */
export function CommunityComputeTerritoryMap({
  model,
}: {
  model: CommunityComputeMapModel;
}) {
  const previous = useRef<ReturnType<
    typeof layoutCommunityComputeHexTerritories
  > | null>(null);
  const layout = useMemo(
    () =>
      layoutCommunityComputeHexTerritories(
        model.deployments.map(({ id, cellCount }) => ({ id, cellCount })),
        { previous: previous.current },
      ),
    [model.deployments],
  );
  useEffect(() => {
    previous.current = layout;
  }, [layout]);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const byId = new Map(model.deployments.map((item) => [item.id, item]));
  const detail = byId.get(active ?? selected ?? "");
  const centers = layout.cells.map(point);
  const minX = Math.min(...centers.map((cell) => cell.x)) - 1.4;
  const minY = Math.min(...centers.map((cell) => cell.y)) - 1.4;
  const width = Math.max(...centers.map((cell) => cell.x)) + 1.4 - minX;
  const height = Math.max(...centers.map((cell) => cell.y)) + 1.4 - minY;
  if (!layout.cells.length) return null;
  const toggle = (id: string) => setSelected((old) => (old === id ? null : id));
  return (
    <section className={styles.map} aria-label="Community compute map">
      {/* SVG cannot contain HTML fieldsets; expose its interactive groups. */}
      {/* biome-ignore lint/a11y/useSemanticElements: SVG graphics container with independently focusable territories. */}
      <svg
        viewBox={`${minX} ${minY} ${width} ${height}`}
        role="group"
        aria-label={`${model.deployments.length} compute territories`}
      >
        {layout.territories.map((territory) => {
          const deployment = byId.get(territory.deploymentId);
          if (!deployment) return null;
          const label = `${deployment.modelId} on ${deployment.deviceLabel}, ${capacity(deployment.capacityGb)}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG territories cannot be HTML buttons; keyboard activation mirrors click.
            <g
              key={deployment.id}
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-pressed={selected === deployment.id}
              className={styles.territory}
              onMouseEnter={() => setActive(deployment.id)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(deployment.id)}
              onBlur={() => setActive(null)}
              onClick={() => toggle(deployment.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle(deployment.id);
                } else if (event.key === "Escape") {
                  setActive(null);
                  setSelected(null);
                }
              }}
            >
              <title>{label}</title>
              {territory.cells.map((cell) => (
                <polygon key={cell.id} points={points(cell)} />
              ))}
              <path
                className={styles.boundary}
                strokeWidth={0.1}
                strokeLinecap="round"
                strokeLinejoin="round"
                d={hexTerritoryBoundaryEdges(territory.cells)
                  .map(
                    (edge) =>
                      `M ${edge.start.x} ${edge.start.y} L ${edge.end.x} ${edge.end.y}`,
                  )
                  .join(" ")}
              />
            </g>
          );
        })}
      </svg>
      <div className={styles.detail} aria-live="polite">
        {detail ? (
          <>
            <p className="m-0 text-label">{detail.modelId}</p>
            <p className="m-0 text-body-sm text-secondary">
              {detail.deviceLabel} · {capacity(detail.capacityGb)}
            </p>
          </>
        ) : (
          <p className="m-0 text-body-sm text-secondary">
            Hover, focus or select a territory to see its model and shared
            memory.
          </p>
        )}
      </div>
    </section>
  );
}

function point(cell: Pick<CommunityComputeHexCell, "q" | "r">) {
  return { x: Math.sqrt(3) * (cell.q + cell.r / 2), y: 1.5 * cell.r };
}
function points(cell: CommunityComputeHexCell) {
  const center = point(cell);
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((60 * index - 30) * Math.PI) / 180;
    return `${center.x + 1.025 * Math.cos(angle)},${center.y + 1.025 * Math.sin(angle)}`;
  }).join(" ");
}
function capacity(value: number | null) {
  return value === null
    ? "capacity not reported"
    : `${Math.round(value)} GB shared`;
}
