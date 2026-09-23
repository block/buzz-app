"""No-login, no-inference protocol spike; writes only a disposable context.

Run: python3 docs/add-codex-harness/spike.py /absolute/path/to/codex-acp
Requires the staged pinned buzz-acp. Never uses the operator's credentials.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
MODEL = {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": "fixture-model", "options": [{"value": "fixture-model", "name": "Fixture"}]}
EFFORT = {"id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
          "currentValue": "low", "options": [{"value": "low", "name": "Low"}]}


def fixture():
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        if request["method"] == "initialize":
            result = {"protocolVersion": 1, "agentInfo": {"name": "fixture", "version": "1"},
                      "agentCapabilities": {}, "authMethods": []}
        elif request["method"] == "session/new":
            result = {"sessionId": "fixture", "configOptions": [MODEL, EFFORT]}
        else:
            raise RuntimeError("Unexpected protocol method")
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


def spawn(command, context):
    return subprocess.Popen(command, cwd=context, start_new_session=True,
        env={"HOME": context, "CODEX_HOME": context, "PATH": "/opt/homebrew/bin:/usr/bin:/bin"},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def stop(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def read_output(child, line=False):
    output = bytearray(getattr(child, "spike_buffer", b""))
    child.spike_buffer = b""
    deadline = time.monotonic() + 20
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            if line and b"\n" in output:
                first, child.spike_buffer = bytes(output).split(b"\n", 1)
                return first
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                return bytes(output)
            output.extend(chunk)
            if len(output) > 1024 * 1024:
                raise RuntimeError("Output exceeded spike bound")
    raise TimeoutError("Protocol spike exceeded 20 seconds")



def rpc(child, id, method, params):
    child.stdin.write((json.dumps({"jsonrpc": "2.0", "id": id,
        "method": method, "params": params}) + "\n").encode())
    child.stdin.flush()
    # The spike accepts bounded interleaved notifications, never tool requests.
    for _ in range(32):
        response = json.loads(read_output(child, line=True))
        if response.get("id") == id:
            assert "error" not in response, "ACP operation rejected"
            return response["result"]
        assert "id" not in response, "Unexpected adapter request"
    raise RuntimeError("Too many notifications")


def session_options(adapter, context):
    # Custom closed-loopback provider allows session/configuration tests without
    # authentication. No prompt is sent; this is not account-entitlement evidence.
    Path(context, "config.toml").write_text(
        'model_provider = "fixture"\n[model_providers.fixture]\n'
        'name = "Local fixture (no inference)"\n'
        'base_url = "http://127.0.0.1:9/v1"\n'
        'wire_api = "responses"\nrequires_openai_auth = false\n')
    child = spawn([adapter], context)
    try:
        rpc(child, 1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        session = rpc(child, 2, "session/new", {"cwd": context, "mcpServers": []})
        model = next(o for o in session["configOptions"] if o.get("category") == "model")
        chosen = next(o["value"] for o in model["options"] if o["value"] != model["currentValue"])
        switched = rpc(child, 3, "session/set_config_option", {
            "sessionId": session["sessionId"], "configId": model["id"], "value": chosen})
        actual = next(o for o in switched["configOptions"] if o.get("category") == "model")
        assert actual["currentValue"] == chosen
        effort = next(o for o in switched["configOptions"] if o.get("category") == "thought_level")
        chosen_effort = effort["options"][0]["value"]
        applied = rpc(child, 4, "session/set_config_option", {
            "sessionId": session["sessionId"], "configId": effort["id"], "value": chosen_effort})
        actual = next(o for o in applied["configOptions"] if o.get("category") == "thought_level")
        assert actual["currentValue"] == chosen_effort
        print("Installed adapter: isolated custom-provider session, model switch and post-switch effort applied")
        rpc(child, 5, "session/close", {"sessionId": session["sessionId"]})
    finally:
        stop(child)


def run(adapter):
    if not Path(adapter).is_absolute():
        raise ValueError("Adapter must be absolute")
    with tempfile.TemporaryDirectory(prefix="codex-spike-", dir=ROOT) as context:
        child = spawn([adapter], context)
        try:
            for i, method, params in [
                (1, "initialize", {"protocolVersion": 1, "clientCapabilities": {},
                                    "clientInfo": {"name": "buzz-spike", "version": "0"}}),
                (2, "session/new", {"cwd": context, "mcpServers": []}),
            ]:
                child.stdin.write((json.dumps({"jsonrpc": "2.0", "id": i,
                    "method": method, "params": params}) + "\n").encode())
                child.stdin.flush()
                response = json.loads(read_output(child, line=True))
                assert response["id"] == i
                if i == 1:
                    result = response["result"]
                    print("Adapter:", result["agentInfo"])
                    print("Auth method IDs:", [m["id"] for m in result["authMethods"]])
                else:
                    assert response["error"]["code"] == -32000
                    print("Isolated session: authentication required (expected)")
        finally:
            stop(child)
        runner = str(ROOT / "src-tauri/resources/agent-runtime/buzz-acp")
        child = spawn([runner, "models", "--json", "--agent-command", sys.executable,
                       "--agent-args", f"{Path(__file__).resolve()},--fixture"], context)
        try:
            catalog = json.loads(read_output(child))
            assert child.wait(timeout=5) == 0
            assert catalog["stable"]["configOptions"] == [MODEL]
            print("Pinned Buzz models: model retained, thought_level filtered (confirmed)")
        finally:
            stop(child)
        child = spawn([runner, "models", "--json", "--agent-command", adapter,
                       "--agent-args", ""], context)
        try:
            read_output(child)
            assert child.wait(timeout=5) != 0
            print("Pinned Buzz + installed adapter: unauthenticated session rejected")
        finally:
            stop(child)
        session_options(adapter, context)


if __name__ == "__main__":
    if sys.argv[1:] == ["--fixture"]:
        fixture()
    else:
        run(sys.argv[1])
