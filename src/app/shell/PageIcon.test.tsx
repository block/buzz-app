// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BrowserIcon } from "../../shared/design-system/icons/index";
import { PageIcon, glyphMask, paintsCurrentColor } from "./PageIcon";

afterEach(() => {
  cleanup();
});

const owl = "data:image/svg+xml,%3Csvg%20id%3D%22owl%22%3E%3C%2Fsvg%3E";
const fox = "data:image/png;base64,iVBORfox";

it("renders a declared image as a decorative, non-draggable img", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  expect(image).toHaveAttribute("alt", "");
  expect(image).toHaveAttribute("aria-hidden", "true");
  // A native image drag that starts on the icon swallows the row's click.
  expect(image).toHaveAttribute("draggable", "false");
});

it("swaps in the component icon when the image fails to load", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  expect(container.querySelector("img")).toBeNull();
  const fallback = container.querySelector("svg");
  expect(fallback).toBeInstanceOf(SVGSVGElement);
  expect(fallback).toHaveAttribute("aria-hidden", "true");
});

it("stays on the fallback when rerendered with the source that failed", () => {
  const { container, rerender } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  rerender(<PageIcon icon={BrowserIcon} image={owl} size={17} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeInstanceOf(SVGSVGElement);
});

it("tries a new source once after an earlier source failed", () => {
  const { container, rerender } = render(
    <PageIcon icon={BrowserIcon} image={owl} size={17} />,
  );
  const image = container.querySelector("img");
  expect(image).toBeInstanceOf(HTMLImageElement);
  expect(image).toHaveAttribute("src", owl);
  fireEvent.error(image as Element);
  rerender(<PageIcon icon={BrowserIcon} image={fox} size={17} />);
  const retried = container.querySelector("img");
  expect(retried).toBeInstanceOf(HTMLImageElement);
  expect(retried).toHaveAttribute("src", fox);
  expect(container.querySelector("svg")).toBeNull();
});

it("renders the component icon at the given size when no image is declared", () => {
  const { container } = render(<PageIcon icon={BrowserIcon} size={17} />);
  const icon = container.querySelector("svg");
  expect(icon).toBeInstanceOf(SVGSVGElement);
  // The icon gateway renders numeric sizes in rem: 17 / 16.
  expect(icon).toHaveAttribute("width", "1.0625rem");
  expect(icon).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelector("img")).toBeNull();
});

const bag = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><path d="M1 1"/></svg>')}`;
const bag64 = `data:image/svg+xml;charset=utf-8;base64,${btoa('<svg fill="currentcolor"/>')}`;

it("tells SVGs that paint with currentColor from other images", () => {
  expect(paintsCurrentColor(bag)).toBe(true);
  expect(paintsCurrentColor(bag64)).toBe(true);
  expect(paintsCurrentColor(owl)).toBe(false);
  expect(paintsCurrentColor(fox)).toBe(false);
  const styled =
    '<svg><style>path{stroke: currentColor}</style><path d="M1 1"/></svg>';
  expect(
    paintsCurrentColor(`data:image/svg+xml,${encodeURIComponent(styled)}`),
  ).toBe(true);
  const named =
    '<svg><title>currentColor example</title><!-- fill="currentColor" --><path fill="red"/><path fill="blue"/></svg>';
  expect(
    paintsCurrentColor(`data:image/svg+xml,${encodeURIComponent(named)}`),
  ).toBe(false);
  expect(paintsCurrentColor("data:image/svg+xml,%E0%A4%A")).toBe(false);
  expect(paintsCurrentColor("data:image/svg+xml;base64,@@@")).toBe(false);
});

it("draws a currentColor SVG as a mask in the text colour", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={bag} size={16} />,
  );
  const mask = container.firstElementChild as HTMLElement;
  expect(mask.tagName).toBe("SPAN");
  expect(mask).toHaveClass("bg-current");
  expect(mask).toHaveAttribute("aria-hidden", "true");
  expect(mask.getAttribute("style")).toContain(`url("${bag}")`);
  expect(mask.style.width).toBe("1rem");
  const probe = mask.querySelector("img");
  expect(probe).toHaveAttribute("src", bag);
  expect(probe).not.toBeVisible();
});

it("swaps in the component icon when a masked SVG fails to load", () => {
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={bag64} size={16} />,
  );
  fireEvent.error(container.querySelector("img") as Element);
  expect(container.querySelector("span")).toBeNull();
  expect(container.querySelector("svg")).toBeInstanceOf(SVGSVGElement);
});

const svgImage = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;
const decoded = (image: string | undefined) =>
  decodeURIComponent(image?.split(",")[1] ?? "");

it("masks one-colour SVGs at the host stroke and leaves other images alone", () => {
  const grey = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7a7a7a" stroke-width="2"><path d="M3 5h9" stroke-width="1.5"/><path d="M3 9h9" style="stroke-width: 1"/></svg>',
  );
  const masked = decoded(glyphMask(grey, 2.5));
  expect(masked.match(/stroke-width/g)).toEqual(["stroke-width"]);
  expect(masked).toContain(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7a7a7a" stroke-width="2.5">',
  );
  // A 16-unit icon gets the same rendered weight as a 24-unit one.
  const small = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" stroke="#333" fill="none"><path d="M1 1h9"/></svg>',
  );
  expect(decoded(glyphMask(small, 2.5))).toContain(
    'stroke-width="1.6666666666666667"',
  );
  const sized = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" stroke="#333" fill="none"><path d="M1 1h9"/></svg>',
  );
  expect(decoded(glyphMask(sized, 2.5))).toContain(
    'stroke-width="1.6666666666666667"',
  );
  for (const width of ["100%", "1em"]) {
    const relative = svgImage(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" stroke="#333" fill="none"><path d="M1 1h9"/></svg>`,
    );
    expect(decoded(glyphMask(relative, 2.5))).toContain('stroke-width="2.5"');
  }
  const sheet = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>path{stroke:currentColor;stroke-width:1}</style><path d="M1 1h9"/></svg>',
  );
  expect(decoded(glyphMask(sheet, 2.5))).not.toContain("stroke-width:1");
  // A mask keeps alpha, so an opacity duotone keeps its lighter tone.
  const duotone = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" fill="#333"><path opacity="0.4" d="M1 1h9"/><path d="M1 5h9"/></svg>',
  );
  expect(decoded(glyphMask(duotone, 2.5))).toContain('opacity="0.4"');
  const accented = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" stroke="#333"><title>café</title><path d="M1 1h9"/></svg>')))}`;
  expect(decoded(glyphMask(accented, 2.5))).toContain("café");
  // Without a stroke width only currentColor SVGs are masked, unchanged.
  expect(glyphMask(grey)).toBeUndefined();
  expect(glyphMask(bag)).toBe(bag);
  // Unpainted shapes fill black: still one colour.
  expect(glyphMask(owl, 2.5)).toContain("data:image/svg+xml");
  expect(glyphMask(bag, 2.5)).toContain("stroke-width%3D%222.5%22");

  const twoColours = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="red"/><path fill="blue"/></svg>',
  );
  const gradient = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg"><linearGradient id="g"/><path fill="url(#g)"/></svg>',
  );
  const styled = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" stroke="#000"><style>.b{fill:red}</style><path class="b"/></svg>',
  );
  for (const image of [twoColours, gradient, styled, fox, svgImage("<svg")])
    expect(glyphMask(image, 2.5)).toBeUndefined();
});

it("draws a one-colour plugin SVG as a mask with the host stroke", () => {
  const grey = svgImage(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7a7a7a" stroke-width="2"><path d="M3 5h9"/></svg>',
  );
  const { container } = render(
    <PageIcon icon={BrowserIcon} image={grey} size={20} strokeWidth={2.5} />,
  );
  const mask = container.firstElementChild as HTMLElement;
  expect(mask).toHaveClass("bg-current");
  expect(mask.getAttribute("style")).toContain("stroke-width%3D%222.5%22");
  // The hidden probe still watches the declared source for load failures.
  expect(mask.querySelector("img")).toHaveAttribute("src", grey);
});
