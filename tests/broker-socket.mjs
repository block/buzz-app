// Test-only upstream I/O for the real broker/subscriber. No external network.
export function brokerSocket(publish = () => "") {
  const publications = [];
  const factory = () => {
    const socket = {
      readyState: 1,
      send(text) {
        const [kind, value] = JSON.parse(text);
        if (kind === "AUTH") queueMicrotask(() => emit(["OK", value.id, true]));
        if (kind === "REQ") queueMicrotask(() => emit(["EOSE", value]));
        if (kind === "EVENT") {
          publications.push(value);
          void Promise.resolve(publish(value)).then((message) =>
            emit(["OK", value.id, true, message]),
          );
        }
      },
      close() {
        this.readyState = 3;
        this.onclose?.();
      },
    };
    const emit = (frame) => {
      if (socket.readyState === 1)
        socket.onmessage?.({ data: JSON.stringify(frame) });
    };
    queueMicrotask(() => emit(["AUTH", "fixture"]));
    return socket;
  };
  return { factory, publications };
}

export async function openBrokerSocket(transport) {
  let ready;
  const connected = new Promise((resolve) => {
    ready = resolve;
  });
  const traffic = transport.subscribe({
    receive() {},
    established() {},
    denied() {},
    state(state) {
      if (state.status === "connected") ready();
    },
  });
  await connected;
  return traffic;
}
