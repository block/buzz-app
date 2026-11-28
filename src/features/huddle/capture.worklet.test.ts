import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import source from "./capture.worklet.js?raw";

type Levels = Record<string, number>;

function capture(channels: number[][]) {
  const levels: Levels[] = [];
  const frames: number[][] = [];
  runInNewContext(source, {
    AudioWorkletProcessor: class {
      port = {
        postMessage: (message: Float32Array | Levels) => {
          if (ArrayBuffer.isView(message)) frames.push(Array.from(message));
          else levels.push(message);
        },
      };
    },
    registerProcessor: (
      _name: string,
      Capture: new (options: {
        processorOptions: { measureChannels: boolean };
      }) => { process(inputs: Float32Array[][]): void },
    ) => {
      const worklet = new Capture({
        processorOptions: { measureChannels: true },
      });
      for (const input of channels) {
        const block = input.map((value) => new Float32Array(128).fill(value));
        for (let i = 0; i < 94; i++) worklet.process([block]);
      }
    },
  });
  return { levels, frames };
}

it("reports cancellation in an average while continuing to send channel one", () => {
  const { levels, frames } = capture([
    [0.5, -0.5],
    [0, 0],
  ]);
  expect(levels).toEqual([
    {
      channels: 2,
      "channel 1 dBFS": -6,
      "channel 2 dBFS": -6,
      "average dBFS": -120,
      "difference dBFS": -6,
    },
  ]);
  expect(frames[0]).toEqual(Array(960).fill(0.5));
});

it("measures the decoded mono channel without reporting a stereo average", () => {
  const { levels } = capture([[0.5]]);
  expect(levels).toEqual([{ channels: 1, "channel 1 dBFS": -6 }]);
});
