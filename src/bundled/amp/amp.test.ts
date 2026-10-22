import { describe, expect, it, vi } from "vitest";
import { ampArgs, runTurn, type ToolServer } from "./amp";
import { call, fakeAmp, init, line, result } from "./amp-testing";

const server = {
  url: "http://127.0.0.1:1/mcp",
  headers: [{ name: "Authorization", value: "Bearer token" }],
};
const ok: ToolServer = async ({ id }) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: "sent" }] },
});

describe("ampArgs", () => {
  it("starts a kept, titled thread with the Buzz tools", () => {
    const args = ampArgs({ keep: true, title: "Ada · #general" }, server);
    expect(args).toEqual(
      expect.arrayContaining([
        "--execute",
        "--stream-json",
        "--dangerously-allow-all",
        "--no-archive-after-execute",
        "--title",
        "Ada · #general",
      ]),
    );
    expect(args[0]).toBe("--execute");
    const config = args[args.indexOf("--mcp-config") + 1] ?? "";
    expect(JSON.parse(config)).toEqual({
      buzz: {
        url: server.url,
        headers: { Authorization: "Bearer token" },
      },
    });
  });

  it("continues a saved thread in a mode, without new-thread options", () => {
    const args = ampArgs(
      { thread: "T-1", keep: true, title: "x", mode: "high" },
      server,
    );
    expect(args.slice(0, 3)).toEqual(["threads", "continue", "T-1"]);
    expect(args).toEqual(expect.arrayContaining(["--mode", "high"]));
    expect(args).not.toContain("--title");
    expect(args).not.toContain("--no-archive-after-execute");
  });

  it("lets Amp archive a one-off thread", () => {
    expect(ampArgs({}, server)).not.toContain("--no-archive-after-execute");
  });
});

describe("runTurn", () => {
  it("returns the thread and what Amp wrote when it answered nowhere", async () => {
    const fake = fakeAmp(async () => ({
      stdout: [init("T-1"), result("T-1", " pong ")],
    }));
    const outcome = await runTurn(fake.host, {
      cwd: "~/.buzz",
      prompt: "ping",
      tools: ok,
    });
    expect(outcome).toEqual({ ok: true, thread: "T-1", text: "pong" });
    expect(fake.started[0]).toMatchObject({
      cwd: "~/.buzz",
      prompt: "ping",
      env: { BUZZ_MANAGED_AGENT: "1" },
    });
    expect(fake.servers[0]?.closed).toBe(true);
  });

  it("posts nothing more once a Buzz tool answered", async () => {
    const step = vi.fn();
    const fake = fakeAmp(async ({ mcp }) => {
      // A notification gets no answer.
      expect(
        await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ).toBeUndefined();
      await call(mcp, "send");
      return { stdout: [init("T-1"), result("T-1", "Sent it.")] };
    });
    const outcome = await runTurn(fake.host, {
      cwd: "~/.buzz",
      prompt: "ping",
      tools: ok,
      step,
    });
    expect(outcome).toEqual({ ok: true, thread: "T-1" });
    expect(step).toHaveBeenCalledWith("send");
  });

  it("still posts the text when a send failed", async () => {
    const fake = fakeAmp(async ({ mcp }) => {
      await call(mcp, "send");
      return { stdout: [init("T-1"), result("T-1", "answer")] };
    });
    const outcome = await runTurn(fake.host, {
      cwd: "~/.buzz",
      prompt: "ping",
      tools: async ({ id }) => ({
        jsonrpc: "2.0",
        id,
        result: { content: [], isError: true },
      }),
    });
    expect(outcome.text).toBe("answer");
  });

  it("shows Amp's tool calls as steps, without its MCP plumbing", async () => {
    const step = vi.fn();
    const fake = fakeAmp(async () => ({
      stdout: [
        init("T-1"),
        line({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "tool_search", input: {} },
              {
                type: "tool_use",
                name: "edit_file",
                input: { path: "/a/b.ts" },
              },
              { type: "tool_use", name: "shell_command", input: { cmd: "ls" } },
            ],
          },
        }),
        result("T-1", ""),
      ],
    }));
    await runTurn(fake.host, {
      cwd: "~",
      prompt: "x",
      tools: ok,
      step,
    });
    expect(step.mock.calls).toEqual([
      ["edit_file", "b.ts"],
      ["shell_command", "ls"],
    ]);
  });

  it("refuses the Buzz tools' first connection while a thread is still loading", async () => {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const replies: unknown[] = [];
    const fake = fakeAmp(async ({ mcp }) => {
      replies.push(await mcp(initialize));
      return { stdout: [init("T-1"), result("T-1", "")] };
    });
    await runTurn(fake.host, {
      cwd: "~",
      prompt: "x",
      thread: "T-1",
      tools: ok,
    });
    await runTurn(fake.host, { cwd: "~", prompt: "x", tools: ok });
    expect(replies[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(replies[1]).toMatchObject({ id: 1, result: expect.anything() });
  });

  it("fails with Amp's error, and says when the thread never opened", async () => {
    const fake = fakeAmp(async () => ({
      stderr: "Error: This thread is archived and cannot be continued.\n",
    }));
    expect(
      await runTurn(fake.host, {
        cwd: "~",
        prompt: "x",
        thread: "T-1",
        tools: ok,
      }),
    ).toEqual({
      ok: false,
      thread: "T-1",
      error: "This thread is archived and cannot be continued.",
      unopened: true,
    });
  });

  it("fails with an error result", async () => {
    const fake = fakeAmp(async () => ({
      stdout: [init("T-1"), result("T-1", "Out of credits", true)],
    }));
    expect(
      await runTurn(fake.host, { cwd: "~", prompt: "x", tools: ok }),
    ).toEqual({ ok: false, thread: "T-1", error: "Out of credits" });
  });

  it("says how to get Amp when it cannot start", async () => {
    const fake = fakeAmp(async () => ({}));
    fake.host = {
      ...fake.host,
      spawn: async () => {
        throw new Error("No such file or directory");
      },
    };
    const outcome = await runTurn(fake.host, {
      cwd: "~",
      prompt: "x",
      tools: ok,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("amp login");
    expect(fake.servers[0]?.closed).toBe(true);
  });

  it("stops the process when stopped, and reports nothing", async () => {
    const controller = new AbortController();
    const fake = fakeAmp(async ({ killed }) => {
      await killed;
      return {};
    });
    const outcome = runTurn(fake.host, {
      cwd: "~",
      prompt: "x",
      thread: "T-1",
      tools: ok,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fake.started).toHaveLength(1));
    controller.abort();
    expect(await outcome).toEqual({ ok: true, stopped: true, thread: "T-1" });
    expect(fake.started[0]?.killed).toBe(true);
  });
});
