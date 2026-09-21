import { forwardRef, type SVGProps } from "react";

/** GitHub's open-issue mark, using Phosphor Circle's regular full-canvas geometry. */
export const GitHubIssueArtwork = forwardRef<
  SVGSVGElement,
  SVGProps<SVGSVGElement> & { size?: number | string }
>(function GitHubIssueArtwork({ size = "1em", ...props }, ref) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the public gateway supplies accessibility semantics.
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z" />
      <circle cx="128" cy="128" r="32" />
    </svg>
  );
});
