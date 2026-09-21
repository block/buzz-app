import { forwardRef, type SVGProps } from "react";

/** Custom outline recreation of the Microsoft OneDrive cloud mark. */
export const OneDriveLogoArtwork = forwardRef<
  SVGSVGElement,
  SVGProps<SVGSVGElement> & { size?: number | string }
>(function OneDriveLogoArtwork({ size = "1em", ...props }, ref) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the public gateway supplies accessibility semantics.
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g transform="translate(128 128) scale(1.08) translate(-128 -128)">
        <path
          d="M76 200C47.3 200 24 177.2 24 149c0-27.5 22.2-49.9 50-50.9C85.5 79.5 106.3 67 130 67c30.7 0 56.5 20.8 63.6 48.8 23.5.2 42.4 18.9 42.4 42 0 22.5-19.9 42.1-40.6 42.1L76 200Z"
          stroke="currentColor"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m36 181 108-45 84 47"
          stroke="currentColor"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m72 99 72 37 50-20"
          stroke="currentColor"
          strokeWidth="16"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
});
