import fragment from "./spoiler-dust.frag?raw";

type Target = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  seed: number;
  time: number;
  energy: number;
  revealedAt: number | null;
  /** The dissolve finished and the canvas was cleared. */
  cleared: boolean;
  onActive: (active: boolean) => void;
};

type Uniforms = Record<
  "size" | "scale" | "time" | "seed" | "energy" | "reveal",
  WebGLUniformLocation | null
>;

type Renderer = { gl: WebGL2RenderingContext; uniforms: Uniforms | null };

export type SpoilerDustHandle = {
  setRevealed: (revealed: boolean) => void;
  detach: () => void;
};

const FRAME_MS = 1000 / 30;
const REVEAL_MS = 550;
const targets = new Map<HTMLCanvasElement, Target>();
const visible = new Set<Target>();
let renderer: Renderer | null | undefined;
let observer: IntersectionObserver | undefined;
let reduced: MediaQueryList;
let forced: MediaQueryList;
let frame = 0;
let last = 0;

/**
 * Draws animated dust into `canvas` while it is on screen. Every spoiler shares
 * one WebGL2 context, because a channel can hold more spoilers than WebKit
 * allows live contexts. `onActive` reports whether the canvas is painting; when
 * it is false the caller keeps its CSS dust.
 */
export function attachSpoilerDust(
  canvas: HTMLCanvasElement,
  onActive: (active: boolean) => void,
): SpoilerDustHandle | undefined {
  if (renderer === undefined)
    renderer =
      typeof WebGL2RenderingContext === "undefined" ? null : createRenderer();
  const context = canvas.getContext("2d");
  if (!renderer || !context) return undefined;
  const target: Target = {
    canvas,
    context,
    seed: Math.random() * 100,
    time: 0,
    energy: 0,
    revealedAt: null,
    cleared: false,
    onActive,
  };
  targets.set(canvas, target);
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = targets.get(entry.target as HTMLCanvasElement);
        if (!target) continue;
        if (entry.isIntersecting) visible.add(target);
        else visible.delete(target);
      }
      schedule();
    },
    { rootMargin: "64px" },
  );
  observer.observe(canvas);
  onActive(isActive());
  return {
    setRevealed(revealed) {
      target.revealedAt = revealed ? performance.now() : null;
      target.cleared = false;
      schedule();
    },
    detach() {
      observer?.unobserve(canvas);
      targets.delete(canvas);
      visible.delete(target);
    },
  };
}

function createRenderer(): Renderer | null {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const created: Renderer = { gl, uniforms: build(gl) };
  if (!created.uniforms) return null;
  reduced = matchMedia("(prefers-reduced-motion: reduce)");
  forced = matchMedia("(forced-colors: active)");
  const sync = () => {
    const active = isActive();
    for (const target of targets.values()) target.onActive(active);
    schedule();
  };
  reduced.addEventListener("change", sync);
  forced.addEventListener("change", sync);
  document.addEventListener("visibilitychange", schedule);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    sync();
  });
  canvas.addEventListener("webglcontextrestored", () => {
    created.uniforms = build(gl);
    sync();
  });
  return created;
}

function build(gl: WebGL2RenderingContext): Uniforms | null {
  const program = gl.createProgram();
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return false;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
    gl.attachShader(program, shader);
    // Attached shaders live until the program is deleted.
    gl.deleteShader(shader);
    return ok;
  };
  const compiled =
    compile(
      gl.VERTEX_SHADER,
      "#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0.,1.);}",
    ) && compile(gl.FRAGMENT_SHADER, fragment);
  gl.linkProgram(program);
  if (!compiled || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0, 0, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, `u_${name}`);
  return {
    size: uniform("size"),
    scale: uniform("scale"),
    time: uniform("time"),
    seed: uniform("seed"),
    energy: uniform("energy"),
    reveal: uniform("reveal"),
  };
}

function isActive() {
  return Boolean(
    renderer?.uniforms &&
      !renderer.gl.isContextLost() &&
      !reduced.matches &&
      !forced.matches,
  );
}

function revealProgress(target: Target, now: number) {
  return target.revealedAt === null
    ? 0
    : Math.min(1, (now - target.revealedAt) / REVEAL_MS);
}

function schedule() {
  if (frame || document.hidden || !isActive()) return;
  for (const target of visible) {
    if (!target.cleared) {
      frame = requestAnimationFrame(tick);
      return;
    }
  }
}

function tick(now: number) {
  frame = 0;
  const elapsed = now - last;
  if (elapsed >= FRAME_MS) {
    last = now;
    const seconds = Math.min(elapsed, 100) / 1000;
    for (const target of visible) paint(target, now, seconds);
  }
  schedule();
}

function paint(target: Target, now: number, seconds: number) {
  if (!renderer?.uniforms) return;
  const { gl, uniforms } = renderer;
  const { canvas, context } = target;
  if (target.cleared) return;
  const reveal = revealProgress(target, now);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const width = Math.max(1, Math.round(cssWidth * ratio));
  const height = Math.max(1, Math.round(cssHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (reveal >= 1) {
    context.clearRect(0, 0, width, height);
    target.cleared = true;
    return;
  }
  // Hover and keyboard focus stir the dust; it settles back when they leave.
  const stirred = canvas.parentElement?.matches(":hover, :focus-visible");
  target.energy += ((stirred ? 1 : 0) - target.energy) * 0.18;
  target.time += seconds * (1 + 1.8 * target.energy + 2 * reveal);
  // The shared buffer only grows; each spoiler renders into its bottom-left.
  const source = gl.canvas as HTMLCanvasElement;
  if (source.width < width || source.height < height) {
    source.width = Math.max(source.width, width);
    source.height = Math.max(source.height, height);
  }
  gl.viewport(0, 0, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(uniforms.size, cssWidth, cssHeight);
  gl.uniform1f(uniforms.scale, ratio);
  gl.uniform1f(uniforms.time, target.time);
  gl.uniform1f(uniforms.seed, target.seed);
  gl.uniform1f(uniforms.energy, target.energy);
  gl.uniform1f(uniforms.reveal, reveal);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  context.globalCompositeOperation = "copy";
  context.drawImage(
    source,
    0,
    source.height - height,
    width,
    height,
    0,
    0,
    width,
    height,
  );
  // Tint the white dust with the spoiler's text colour so themes and own
  // bubbles keep working without parsing CSS colours.
  context.globalCompositeOperation = "source-in";
  context.fillStyle = getComputedStyle(canvas).color;
  context.fillRect(0, 0, width, height);
}
