"""Capture Codex ACP setting responses without login or inference.

Run: python3 docs/add-codex-harness/response-spike.py /absolute/path/to/codex-acp
Uses spike.py's bounded subprocess transport and a disposable custom provider.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("spike", HERE / "spike.py")
spike = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spike)


def run(adapter):
    if not Path(adapter).is_absolute():
        raise ValueError("Adapter must be absolute")
    evidence = []
    with tempfile.TemporaryDirectory(prefix="codex-response-spike-", dir=spike.ROOT) as context:
        Path(context, "config.toml").write_text(
            'model_provider = "fixture"\n[model_providers.fixture]\n'
            'name = "Local fixture (no inference)"\n'
            'base_url = "http://127.0.0.1:9/v1"\n'
            'wire_api = "responses"\nrequires_openai_auth = false\n')
        child = spike.spawn([adapter], context)
        session_id = None

        def exchange(label, method, params):
            request = {"jsonrpc": "2.0", "id": len(evidence) + 1, "method": method, "params": params}
            child.stdin.write((json.dumps(request) + "\n").encode())
            child.stdin.flush()
            notifications = []
            for _ in range(32):
                response = json.loads(spike.read_output(child, line=True))
                if response.get("id") == request["id"]:
                    evidence.append({"test": label, "request": request, "response": response, "notifications": notifications})
                    if "error" in response:
                        print(label, json.dumps(response["error"]))
                    else:
                        options = response["result"].get("configOptions", [])
                        print(label, json.dumps({o["id"]: o.get("currentValue") for o in options}))
                    return response
                if "id" in response:
                    raise RuntimeError("Unexpected adapter request")
                notifications.append(response)
            raise RuntimeError("Too many notifications")

        try:
            init = exchange("initialize", "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
            print("Adapter:", init["result"]["agentInfo"])
            session = exchange("new session", "session/new", {"cwd": context, "mcpServers": []})["result"]
            session_id = session["sessionId"]
            model = next(o for o in session["configOptions"] if o.get("category") == "model")
            chosen = next(o["value"] for o in model["options"] if o["value"] != model["currentValue"])

            def setting(label, config_id, value):
                return exchange(label, "session/set_config_option", {"sessionId": session_id, "configId": config_id, "value": value})

            switched = setting("valid model", model["id"], chosen)["result"]
            effort = next(o for o in switched["configOptions"] if o.get("category") == "thought_level")
            chosen_effort = effort["options"][0]["value"]
            setting("valid effort", effort["id"], chosen_effort)
            setting("invalid effort", effort["id"], "buzz-spike-invalid-effort")
            setting("unknown config ID", "buzz-spike-unknown-option", chosen_effort)
            setting("unknown model", model["id"], "buzz-spike-nonexistent-model")
            # Set a known value again and inspect the entire returned configuration.
            setting("restore known model", model["id"], chosen)
            setting("restore known effort", effort["id"], chosen_effort)
            exchange("close", "session/close", {"sessionId": session_id})
        finally:
            spike.stop(child)
        serialized = json.dumps(evidence, indent=2).replace(context, "<disposable-context>")
        if session_id:
            serialized = serialized.replace(session_id, "<session-id>")
        output = HERE / "response-spike-evidence.json"
        output.write_text(serialized + "\n")
        print("Saved:", output)


if __name__ == "__main__":
    run(sys.argv[1])
