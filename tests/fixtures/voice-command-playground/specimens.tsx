import { useDialKit } from "dialkit";
import { agentAvatars } from "../../../src/features/agents/avatar-packs";
import type { Entry, TunerProps } from "./playground";
import { Scene, type SceneTuning } from "./Scene";

function useSpotlightDials(): NonNullable<SceneTuning["spotlight"]> {
  const d = useDialKit(
    "Spotlight",
    {
      darknessPercent: [5, 0, 40, 1],
      padding: [8, 0, 40, 1],
      radius: [18, 0, 48, 1],
      edgeSoftness: [11, 0, 24, 1],
    },
    { id: "playground:buzz:voice-spotlight" },
  );
  return {
    opacity: d.darknessPercent / 100,
    padding: d.padding,
    radius: d.radius,
    softness: d.edgeSoftness,
  };
}
function useCompanionDials(): NonNullable<SceneTuning["companion"]> {
  const options = agentAvatars
    .slice(0, 24)
    .map((avatar) => ({ value: avatar.id, label: avatar.label }));
  const d = useDialKit(
    "Bestie companion",
    {
      artwork: { type: "select", options, default: "buzzies-1" },
      animated: true,
      size: [64, 32, 144, 2],
      pointerOffset: [24, -40, 100, 1],
      followMs: [210, 0, 300, 10],
      aura: {
        blur: [14, 0, 60, 1],
        saturation: [5.9, 0, 8, 0.1],
        brightness: [0.95, 0.2, 2, 0.05],
        contrast: [1.3, 0.2, 2, 0.05],
        hue: [0, -180, 180, 5],
        opacity: [0.91, 0, 1, 0.01],
        spread: [2.4, 1, 4, 0.05],
        audioReaction: [0.7, 0, 2, 0.05],
      },
    },
    { id: "playground:buzz:voice-companion" },
  );
  return {
    avatar: agentAvatars.find((avatar) => avatar.id === d.artwork)?.url,
    animated: d.animated,
    size: d.size,
    offset: d.pointerOffset,
    followMs: d.followMs,
    auraBlur: d.aura.blur,
    auraOpacity: d.aura.opacity,
    auraScale: d.aura.spread,
    auraSaturation: d.aura.saturation,
    auraBrightness: d.aura.brightness,
    auraContrast: d.aura.contrast,
    auraHue: d.aura.hue,
    reactivity: d.aura.audioReaction,
  };
}
function useRecorderDials(): NonNullable<SceneTuning["recorder"]> {
  const d = useDialKit(
    "Recording strip",
    {
      width: [384, 200, 720, 8],
      bottom: [72, 8, 160, 4],
      amplitude: [0.6, 0, 1, 0.01],
    },
    { id: "playground:buzz:voice-recorder" },
  );
  return { width: d.width, bottom: d.bottom, amplitude: d.amplitude };
}
function useReviewDials(): NonNullable<SceneTuning["review"]> {
  const d = useDialKit(
    "Review & send",
    {
      size: {
        type: "select",
        options: ["compact", "default", "wide"],
        default: "default",
      },
      name: { type: "text", default: "Bestie" },
      failSend: false,
    },
    { id: "playground:buzz:voice-review" },
  );
  return {
    size: d.size as "compact" | "default" | "wide",
    name: d.name,
    failSend: d.failSend,
  };
}
function SpotlightTuner({ children }: TunerProps) {
  const spotlight = useSpotlightDials();
  return children((variant) => (
    <Scene kind="spotlight" variant={variant} tuning={{ spotlight }} />
  ));
}
function CompanionTuner({ children }: TunerProps) {
  const companion = useCompanionDials();
  return children((variant) => (
    <Scene kind="companion" variant={variant} tuning={{ companion }} />
  ));
}
function RecorderTuner({ children }: TunerProps) {
  const recorder = useRecorderDials();
  return children((variant) => (
    <Scene kind="recorder" variant={variant} tuning={{ recorder }} />
  ));
}
function ReviewTuner({ children }: TunerProps) {
  const review = useReviewDials();
  return children((variant) => (
    <Scene kind="review" variant={variant} tuning={{ review }} />
  ));
}
function ExperienceTuner({ children }: TunerProps) {
  const spotlight = useSpotlightDials();
  const companion = useCompanionDials();
  const recorder = useRecorderDials();
  const review = useReviewDials();
  const gesture = useDialKit(
    "Demo gesture",
    { holdMs: [250, 0, 800, 10] },
    { id: "playground:buzz:voice-gesture" },
  );
  const tuning = {
    spotlight,
    companion,
    recorder,
    review,
    holdMs: gesture.holdMs,
  };
  return children(
    (variant) => <Scene kind="experience" variant={variant} tuning={tuning} />,
    <Scene kind="experience" variant="default" tuning={tuning} flow />,
  );
}
const visuals = "src/features/voice-command/VoiceCommandVisuals.tsx";
export const entries: Entry[] = [
  {
    id: "spotlight",
    title: "Spotlight",
    kind: "component",
    purpose:
      "A barely-there scrim that lets the pointed-at object stay at full brightness.",
    mechanics: [
      "VoiceSpotlight draws one SVG mask: the window is dimmed, and a rounded opening removes the scrim around the target. The mask never captures pointer events.",
      "Move across the message text, conversation rows and controls. Padding, corner radius and edge softness affect the actual shared visual.",
      "The app uses 5% black, 8px opening padding, 18px corners and 11px edge softness. These dials change the playground only.",
    ],
    sources: [
      `${visuals} · VoiceSpotlight`,
      "src/features/voice-command/use-point-and-speak.ts · live target geometry",
    ],
    variants: [
      { id: "message", label: "Message target" },
      { id: "control", label: "Header control" },
      { id: "none", label: "No target" },
    ],
    Tuner: SpotlightTuner,
  },
  {
    id: "companion",
    title: "Animated companion",
    kind: "component",
    purpose:
      "Your animated Bestie follows beneath the pointer, surrounded by a soft copy of its own artwork.",
    mechanics: [
      "VoiceCompanion reuses PackedAgentAvatar, including alpha video, poster fallback and reduced-motion behavior. No identity label or background tile is added.",
      "Move the pointer to feel the spring follow and clamping. The aura uses a blurred still preview so only the foreground avatar needs video playback; its scale responds to the simulated audio level.",
      "The aura uses the profile backdrop’s blur and saturation approach, with the same tuned defaults as the app. Adjust saturation, brightness, contrast and hue alongside its size and audio response. The foreground artwork keeps its original colors.",
    ],
    sources: [
      `${visuals} · VoiceCompanion`,
      "src/features/agents/PackedAgentAvatar.tsx",
    ],
    variants: [
      { id: "idle", label: "Armed" },
      { id: "listening", label: "Listening" },
      { id: "loud", label: "Stronger audio" },
    ],
    Tuner: CompanionTuner,
  },
  {
    id: "recorder",
    title: "Recording strip",
    kind: "component",
    purpose: "The composer’s real recording control, in its floating capsule.",
    mechanics: [
      "VoiceRecordingBar hosts the existing VoiceNoteRecorder: discard, waveform, elapsed time and pending status remain owned by the composer recorder.",
      "Recording levels and elapsed time advance locally. The microphone is never opened. Discard affects only this specimen; Replay fixture restores it.",
      "Width and bottom offset tune the actual frame. Amplitude changes the simulated samples fed to the real waveform.",
    ],
    sources: [
      `${visuals} · VoiceRecordingBar`,
      "src/bundled/voice-notes/VoiceNoteRecorder.tsx",
    ],
    variants: [
      { id: "requesting", label: "Waiting for microphone" },
      { id: "recording", label: "Recording" },
      { id: "processing", label: "Preparing note" },
    ],
    Tuner: RecorderTuner,
  },
  {
    id: "review",
    title: "Review & send",
    kind: "component",
    purpose:
      "A clear last step to play the note, discard it, or send it with its pointing context.",
    mechanics: [
      "Open a fixture to use the real shared Dialog and VoiceNoteCard. The dialog opens over the workspace so its focus and dismissal behave like the app.",
      "Playback uses a generated local test tone and images are labelled simulated screenshots. Remove an image to exclude it. Sending is simulated; no media is uploaded and no Bestie is contacted.",
      "Choose dialog width and recipient label. Fail send keeps the review open with an error; turn it off to retry successfully.",
    ],
    sources: [
      `${visuals} · VoiceCommandReview`,
      "src/bundled/voice-notes/VoiceNoteCard.tsx",
      "src/shared/design-system/ui/Dialog.tsx",
    ],
    variants: [
      { id: "ready", label: "Ready to send" },
      { id: "error", label: "Upload error" },
      { id: "sending", label: "Sending" },
    ],
    Tuner: ReviewTuner,
  },
  {
    id: "experience",
    title: "Voice & point flow",
    kind: "experience",
    purpose:
      "Try the complete interaction, from a pointed-at object to a reviewed note.",
    mechanics: [
      "Use Start demo, point at several objects, then Finish & review. Or hold Command + Option while the pointer is over the specimen, and release either key.",
      "The scrim, companion, recorder and screenshot review are the same presentation owners used in the app. The microphone, screenshot capture, timing data and delivery are simulated here.",
      "All four component panels share their stable DialKit IDs with the component views. Reset fixtures restarts the demo without clearing your tuned values. DialKit’s own versions and copy controls manage parameter snapshots.",
    ],
    sources: [
      visuals,
      "src/features/voice-command/BestieVoiceCommand.tsx",
      "tests/fixtures/voice-command-playground/Scene.tsx · simulated host",
    ],
    parts: ["spotlight", "companion", "recorder", "review"],
    variants: [
      { id: "recording", label: "Recording composition" },
      { id: "idle", label: "Armed composition" },
    ],
    Tuner: ExperienceTuner,
  },
];
