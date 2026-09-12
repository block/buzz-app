import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { createBestieRealtime } from "../../dev/bestie-realtime.mjs";

// Only inference/ACP is modeled. Actual host validation, process lifetime, browser
// capture queues, AudioWorklet, React controls and permission forwarding run here.
const agentSource = `
import { createInterface } from 'node:readline';
const send = event => console.log(JSON.stringify({jsonrpc:'2.0',...event}));
const update = value => send({method:'_buzz/unstable/realtime/update',params:{sessionId:'session',streamId:'stream',update:value}});
let ready=false, spoke=false, permission;
process.on('message', command => {
 if(command.type==='ask') {
  permission=command.id;
  send({id:command.id,method:'session/request_permission',params:{sessionId:'session',toolCall:{toolCallId:command.id,title:command.title,rawInput:{command:'buzz channels list'}},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});
 } else if(command.type==='cancel') {
  update({type:'speech_started'});
  send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:permission,status:'failed'}}});
 } else if(command.type==='exit') process.exit(0);
});
for await(const line of createInterface({input:process.stdin})) {
 const event=JSON.parse(line);
 if(event.method==='initialize') send({id:event.id,result:{agentCapabilities:{_meta:{buzz:{realtimeAudio:1}}}}});
 else if(event.method==='session/new') send({id:event.id,result:{sessionId:'session'}});
 else if(event.method==='session/prompt') {ready=true;update({type:'ready'});}
 else if(event.method==='_buzz/unstable/realtime/append') {
  send({id:event.id,result:{}});
  process.send({type:'capture',bytes:Buffer.from(event.params.data,'base64').length});
  if(ready&&!spoke) {
   spoke=true;
   const pcm=Buffer.alloc(4800);
   for(let i=0;i<2400;i++)pcm.writeInt16LE(Math.round(Math.sin(i*Math.PI/60)*200),i*2);
   update({type:'audio',responseId:'reply',itemId:'reply-audio',startSample:0,data:pcm.toString('base64')});
   send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture voice reply.'}}}});
   update({type:'response_done',responseId:'reply',status:'completed'});
  }
 } else if(event.method==='_buzz/unstable/realtime/playback') {
  process.send({type:'playback',samples:event.params.playback.playedSamples});
  send({id:event.id,result:{}});
 } else if(!event.method) {
  process.send({type:'approval',id:event.id,option:event.result.outcome.optionId});
  send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'tool_call_update',toolCallId:event.id,status:'completed'}}});
 } else if(event.id!==undefined) send({id:event.id,result:{}});
}
`;

async function fixture(page) {
  const directory = await mkdtemp(join(tmpdir(), "bestie-browser-"));
  const script = join(directory, "agent.mjs");
  await writeFile(script, agentSource);
  const ownerKey = generateSecretKey();
  const children = [],
    events = [],
    errors = [];
  const host = createBestieRealtime({
    endpoint: "ws://127.0.0.1:1/v1/realtime",
    ownerKey,
    stateDirectory: directory,
    stopTimeoutMs: 30,
    spawnAgent(_command, _args, options) {
      const index = children.length;
      const child = spawn(process.execPath, [script], {
        ...options,
        stdio: ["pipe", "pipe", "ignore", "ipc"],
      });
      child.on("message", (event) => events.push({ ...event, child: index }));
      children.push(child);
      return child;
    },
  });
  const viewer = getPublicKey(ownerKey);
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "bestie-browser-host",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const parts = new URL(req.url, "http://localhost").pathname.split(
              "/",
            );
            if (
              parts[1] !== "api" ||
              parts[2] !== "relay" ||
              parts[4] !== "bestie"
            )
              return next();
            const relay = decodeURIComponent(parts[3]);
            if (
              !["https://alpha.example", "https://beta.example"].includes(relay)
            ) {
              res.writeHead(403).end();
              return;
            }
            void host.handle(req, res, { relay, viewer });
          });
        },
      },
    ],
    define: {
      "import.meta.env.VITE_BESTIE_REALTIME": JSON.stringify("1"),
      "import.meta.env.VITE_BESTIE_TEST_VIEWER": JSON.stringify(viewer),
    },
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  // A synthetic MediaStream replaces only the physical microphone, never the
  // production AudioWorklet or media transport. Tests cannot record user audio.
  await page.addInitScript(() => {
    window.bestieMicrophones = [];
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
      value: async () => {
        const context = new AudioContext({ sampleRate: 24000 });
        await context.resume();
        const destination = context.createMediaStreamDestination();
        const source = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.001;
        source.connect(gain).connect(destination);
        source.start();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          source.stop();
          void context.close();
        };
        window.bestieMicrophones.push(track);
        return destination.stream;
      },
    });
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/bestie.html`;
  try {
    await page.goto(url);
  } catch (error) {
    await host.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    children,
    events,
    errors,
    control(value) {
      children.at(-1).send(value);
    },
    microphones: () =>
      page.evaluate(
        () =>
          window.bestieMicrophones.filter(
            (track) => track.readyState === "live",
          ).length,
      ),
    async close() {
      await page.goto("about:blank");
      await host.close();
      await server.close();
      ownerKey.fill(0);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function start(page, f) {
  await button(page, "Start Bestie voice conversation").click();
  await expect(page.getByRole("status")).toContainText("Listening");
  await expect.poll(f.microphones).toBe(1);
  await expect
    .poll(() =>
      f.events.some(
        (event) =>
          event.type === "capture" &&
          event.bytes > 0 &&
          event.child === f.children.length - 1,
      ),
    )
    .toBe(true);
}

test("actual Bestie call keeps duplex media and thinking through panel relocation, then stops on hide", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page
      .getByRole("combobox", { name: "Bestie thinking level" })
      .selectOption("high");
    await start(page, f);
    await expect(
      page.getByRole("log", { name: "Bestie transcript" }),
    ).toContainText("Fixture voice reply.");
    await expect
      .poll(() =>
        f.events.some(
          (event) => event.type === "playback" && event.samples > 0,
        ),
      )
      .toBe(true);
    await button(page, "Mute Bestie microphone").click();
    await expect(button(page, "Unmute Bestie microphone")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await button(page, "Relocate Bestie").click();
    await expect(button(page, "End Bestie conversation")).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Bestie thinking level" }),
    ).toHaveValue("high");
    expect(f.children.length).toBe(1);
    await expect.poll(f.microphones).toBe(1);
    await button(page, "Hide Bestie").click();
    await expect.poll(f.microphones).toBe(0);
    await expect
      .poll(
        () =>
          f.children[0].exitCode !== null || f.children[0].signalCode !== null,
      )
      .toBe(true);
    await button(page, "Show Bestie").click();
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("community changes revoke the old call and clear transcripts after both active and ended calls", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page
      .getByRole("combobox", { name: "Bestie tool approval mode" })
      .selectOption("ask");
    await start(page, f);
    await expect(page.getByRole("log")).toContainText("Fixture voice reply.");
    f.control({ type: "ask", id: "old", title: "Old community tool" });
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toBeVisible();
    await button(page, "Select Beta").click();
    await expect(page.getByRole("log")).not.toContainText(
      "Fixture voice reply.",
    );
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toHaveCount(0);
    await expect.poll(f.microphones).toBe(0);
    await expect
      .poll(
        () =>
          f.children[0].exitCode !== null || f.children[0].signalCode !== null,
      )
      .toBe(true);
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    await start(page, f);
    expect(f.children.length).toBe(2);
    await expect(page.getByRole("log")).toContainText("Fixture voice reply.");
    await button(page, "End Bestie conversation").click();
    await expect(button(page, "Start Bestie voice conversation")).toBeEnabled();
    await button(page, "Select Alpha").click();
    await expect(page.getByRole("log")).not.toContainText(
      "Fixture voice reply.",
    );
    expect(f.events.filter((event) => event.type === "approval")).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("approval controls forward exact choices and disappear when speech revokes a request", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page
      .getByRole("combobox", { name: "Bestie tool approval mode" })
      .selectOption("ask");
    await start(page, f);
    f.control({ type: "ask", id: "denied", title: "Read fixture channels" });
    const approval = page.getByRole("region", { name: "Bestie tool approval" });
    await expect(approval).toContainText("Read fixture channels");
    await approval.getByRole("button", { name: "Deny", exact: true }).click();
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([{ id: "denied", option: "no" }]);
    await expect(approval).toHaveCount(0);
    f.control({ type: "ask", id: "revoked", title: "Revoked tool" });
    await expect(approval).toContainText("Revoked tool");
    f.control({ type: "cancel" });
    await expect(approval).toHaveCount(0);
    f.control({ type: "ask", id: "allowed", title: "New tool" });
    await expect(approval).toContainText("New tool");
    await approval
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([
        { id: "denied", option: "no" },
        { id: "allowed", option: "yes" },
      ]);
    await expect(approval).toHaveCount(0);
    await button(page, "End Bestie conversation").click();
    await expect.poll(f.microphones).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("automatic approval is the default and reaches the exact ACP tool request without a dialog", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await expect(
      page.getByRole("combobox", { name: "Bestie tool approval mode" }),
    ).toHaveValue("auto");
    await start(page, f);
    f.control({
      type: "ask",
      id: "automatic",
      title: "Automatic fixture tool",
    });
    await expect
      .poll(() =>
        f.events
          .filter((event) => event.type === "approval")
          .map(({ id, option }) => ({ id, option })),
      )
      .toEqual([{ id: "automatic", option: "yes" }]);
    await expect(
      page.getByRole("region", { name: "Bestie tool approval" }),
    ).toHaveCount(0);
    await button(page, "End Bestie conversation").click();
    await expect.poll(f.microphones).toBe(0);
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
