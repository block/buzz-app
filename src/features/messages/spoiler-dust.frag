#version 300 es
precision highp float;

// Stateless spoiler dust: every pixel derives its particles from the cell grid
// and time alone, so there is no particle state on the CPU or GPU.
uniform vec2 u_size;
uniform float u_scale;
uniform float u_time;
uniform float u_seed;
uniform float u_energy;
uniform float u_reveal;
out vec4 color;

const float TAU = 6.2831853;

vec4 hash(vec2 p) {
  vec4 q = vec4(
    dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3)),
    dot(p, vec2(419.2, 371.9)),
    dot(p, vec2(113.5, 271.9))
  );
  return fract(sin(q + u_seed) * 43758.5453);
}

float layer(vec2 p, float cellSize, float radiusBase, float shift) {
  vec2 cell = floor(p / cellSize);
  vec2 center = u_size * 0.5;
  // Reveal clears from the centre outward; particles flare on the front.
  float front = u_reveal * 1.7;
  float alpha = 0.0;
  // A particle strays at most ~1 cell, so the 3x3 neighbourhood covers it.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(x, y);
      vec4 h = hash(c + shift);
      float life = 0.7 + 1.1 * h.z;
      float cycle = u_time / life + h.w;
      float t = fract(cycle);
      // Each respawn picks a new origin and heading so the field never loops.
      vec4 spawn = hash(c + floor(cycle) * 17.0 + shift);
      vec2 origin = (c + 0.5 + (spawn.yz - 0.5) * 0.7) * cellSize;
      float heading = spawn.x * TAU + (t - 0.5) * (spawn.w - 0.5) * 4.0;
      float travel = (t - 0.5) * cellSize * 0.9 * (0.4 + h.y);
      vec2 offset = origin - center;
      float spread = length(offset / max(center, vec2(1.0)));
      vec2 away = offset / max(length(offset), 0.001);
      vec2 position = origin + vec2(cos(heading), sin(heading)) * travel +
        away * u_reveal * cellSize * 0.45;
      float fade = smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.6, 1.0, t));
      float twinkle = 0.65 + 0.35 * sin(u_time * (6.0 + 8.0 * h.x) + h.y * TAU);
      float cleared = smoothstep(front - 0.25, front, spread);
      float flare = 1.0 + 2.5 * u_reveal * exp(-pow((spread - front) * 6.0, 2.0));
      float radius = radiusBase * (0.6 + 0.8 * h.z);
      float d = length(p - position);
      float core = 1.0 - smoothstep(radius - 0.4, radius + 0.4, d);
      float glow = 0.22 * exp(-d * d / (radius * radius * 6.0));
      alpha += fade * twinkle * cleared * flare * (core + glow) *
        (0.5 + 0.5 * spawn.w);
    }
  }
  return alpha;
}

void main() {
  vec2 p = gl_FragCoord.xy / u_scale;
  float alpha = layer(p, 4.0, 0.45, 0.0) + 0.7 * layer(p, 9.0, 0.8, 91.0);
  alpha = min(alpha * (1.0 + 0.4 * u_energy), 1.0);
  color = vec4(alpha);
}
